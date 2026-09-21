/**
 * Merge-safe install/uninstall of Pixel Agents hook entries into a CLI's JSON
 * settings file, shared by every provider that has one (Claude's
 * ~/.claude/settings.json, Codex's ~/.codex/hooks.json, Gemini's
 * ~/.gemini/settings.json). All three use the same shape —
 * `{"hooks": {"<Event>": [{"matcher": "", "hooks": [{"type": "command", "command": …}]}]}}`
 * — so the safety rules are written ONCE here and each provider only states
 * its path, events, script name and entry shape:
 *
 * - never rewrite a file we could not parse, or a shape we did not author
 *   (non-object `hooks`, non-array `hooks.<Event>`, junk entries pass through);
 * - one-time `.pixel-agents.backup` before our first modification (exclusive
 *   create; no backup ⇒ no write), skipped only when the replaced content is
 *   entirely our own install's output;
 * - atomic tmp + rename, mode preserved (0600 on create), re-read verify
 *   immediately before the rename with retry;
 * - every write failure THROWS;
 * - hook identity = our script's path suffix, anchored at BOTH ends of the
 *   command's first token, case-insensitive.
 *
 * The long rationale for each rule lives next to the code that enforces it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import {
  SETTINGS_BACKUP_SUFFIX,
  SETTINGS_FRESH_FILE_MODE,
  SETTINGS_MUTATE_ATTEMPTS,
  SETTINGS_MUTATE_RETRY_DELAY_MS,
  SETTINGS_TMP_SUFFIX,
} from './constants.js';

/** One hook command inside an entry. `name` is Gemini's optional label. */
export interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
  name?: string;
}

/** A single entry in a `hooks.<Event>` array. */
export interface HookEntry {
  matcher: string;
  hooks: HookCommand[];
}

/** Partial shape of the settings file (only the hooks field is relevant). */
interface HookSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

/** What a provider tells the shared installer. */
export interface HookSettingsSpec {
  /** Absolute path of the settings file. A function: HOME is read lazily. */
  settingsPath(): string;
  /** How messages name the file, e.g. `~/.claude/settings.json`. */
  displayPath: string;
  /** Label for the backup log line, e.g. `Claude settings`. */
  backupLabel: string;
  /** Lower-case path suffixes that identify OUR script (leading `/` required),
   *  e.g. `/.pixel-agents/hooks/claude-hook.js`. */
  scriptSuffixes: readonly string[];
  /** Events we install. Our commands under any OTHER event are swept on install. */
  events: readonly string[];
  /** The entry we write for one event (no argument = the reference shape). */
  makeHookEntry(event?: string): HookEntry;
}

export interface HookSettingsInstaller {
  areHooksInstalled(): boolean;
  /** Idempotent install. Rejects (before any write) on an unparseable file,
   *  a shape we did not author, or a concurrent writer that never settles. */
  installHooks(): Promise<void>;
  /** Removes every command of ours. Rejects (before any write) like install. */
  uninstallHooks(): Promise<void>;
  /** The one message each refusal carries (exported for callers/tests). */
  readonly messages: {
    unparseable: string;
    concurrentWrite: string;
    hooksNotObject: string;
    nonArrayEvent(event: string): string;
    unusableBackup(backupPath: string): string;
  };
}

/** The one write failure the mutate loop retries. A dedicated class rather than
 *  a message-string comparison: retrying an EACCES or ENOSPC just delays the
 *  same failure, so the loop must be able to tell "the file changed under us"
 *  apart from every other error with certainty, not by text. */
class ConcurrentWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentWriteError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort unlink: a leftover tmp file we cannot remove must not mask the
 *  real error we are already reporting. */
function removeIfPresent(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* ignore */
  }
}

/** Whether the path resolves (through symlinks) to a regular file. */
function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    // ENOENT here means a dangling symlink: the name exists (COPYFILE_EXCL said
    // EEXIST) but resolves to nothing.
    return false;
  }
}

/** Characters that end a path token in a shell command line. A path we own is
 *  either the whole token or ends at one of these; anything else after it
 *  (`.backup`, `.disabled`, more path segments) means the command names a
 *  DIFFERENT file that merely starts with our path. */
const PATH_TERMINATORS = new Set([' ', '\t', '"', "'", ';', '&', '|', '>', '<', ')']);

/** Read one shell token: a quoted string, or characters up to the first
 *  terminator. Returns null when the token is empty or unterminated. */
function readToken(raw: string): string | null {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    return end > 1 ? raw.slice(1, end) : null;
  }
  let end = 0;
  while (end < raw.length && !PATH_TERMINATORS.has(raw[end])) end++;
  return end > 0 ? raw.slice(0, end) : null;
}

/**
 * The ABSOLUTE path of the script a command runs, normalized to forward
 * slashes, or null when the command doesn't look like one of ours.
 *
 * `node "<path>"` and a bare `<path>` are the two shapes we write (and the two
 * a user plausibly hand-edits). A Windows drive prefix (`C:/…`) counts as
 * absolute; a relative path does not (see isOurHookCommand's contract).
 */
function firstCommandToken(command: string): string | null {
  const trimmed = command.trim();
  // `node <script>` / `node "<script>"` — take the argument. The interpreter
  // itself may be a path (quoted, and on Windows containing spaces).
  const nodeInvocation = /^"?(?:[^"]*[/\\])?node(?:\.exe)?"?\s+(.+)$/.exec(trimmed);
  const raw = nodeInvocation ? nodeInvocation[1] : trimmed;
  const token = readToken(raw.trim());
  if (token === null) return null;
  const normalized = token.replace(/\\/g, '/');
  const absolute = normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
  return absolute ? normalized : null;
}

/**
 * Check if a single hook command is ours, given the script path suffixes we own.
 *
 * Neither half of the path is identity on its own: `claude-hook.js` is a
 * generic name another tool could plausibly use, and substring tests claim
 * unrelated commands. Empirically, plain `includes` classified all of these as
 * ours — and uninstall then DELETED them:
 *   node /opt/.pixel-agents/hooks/claude-hook.js.backup   (a different file)
 *   true # /opt/.pixel-agents/hooks/claude-hook.js        (a comment)
 *   wrapper --note=".pixel-agents/hooks/claude-hook.js" x (an argument)
 *   node /opt/evil.pixel-agents/hooks/claude-hook.js      (no token boundary)
 *   node /opt/my-pixel-agents-hook.js.bak                 (legacy, no boundary)
 * So identity is anchored at BOTH ends: our path suffix must start at a path
 * separator and must END the command's script token.
 *
 * Deliberate scope choices:
 * - Casing is NOT significant: the token is normalized to lower case before the
 *   suffix compare. macOS and Windows have case-insensitive volumes, where a
 *   differently-cased path is the SAME INODE as our script and genuinely firing;
 *   reading it as foreign left an orphan uninstall could no longer see. The
 *   accepted residual is a Linux-only false positive (a genuinely different,
 *   differently-cased file we then remove) — nothing we write creates that path.
 * - The FIRST token only. A command is `node <script>` or `<script>`; our path
 *   appearing later is an argument or a comment, not the thing being run.
 * - ABSOLUTE paths only. We always write one; a relative path resolves against
 *   whatever directory the CLI runs in and is almost certainly not ours.
 * - Suffix, not the resolved homedir: an entry written under a previous or
 *   moved HOME is still ours to clean up.
 * - A symlink ALIAS pointing at our script is not recognized (we compare text,
 *   never resolve): the worst case is one duplicate execution, versus deleting
 *   a stranger's hook if we resolved paths from a config file.
 */
export function isOurHookCommand(command: string, suffixes: readonly string[]): boolean {
  const token = firstCommandToken(command);
  if (token === null) return false;
  // Every suffix is lower-case, so folding the token is the whole normalization.
  const normalized = token.toLowerCase();
  return suffixes.some((suffix) => normalized.endsWith(suffix));
}

/** "This entry held only our hooks and is now empty — drop it."
 *
 *  A unique symbol, never `null`: `null` is a value a user's settings file can
 *  legitimately contain inside a hooks array, and using it as the sentinel made
 *  us DELETE it. A symbol cannot appear in parsed JSON. */
const DROP_ENTRY = Symbol('drop-entry');

/** Build the installer for one provider's settings file. */
export function createHookSettingsInstaller(spec: HookSettingsSpec): HookSettingsInstaller {
  const messages = {
    /** The file exists but cannot be parsed. The operation appends its own
     *  outcome suffix. */
    unparseable: `Couldn't parse ${spec.displayPath}`,
    /** The file keeps changing under us across all retry attempts. */
    concurrentWrite: `${spec.displayPath} is being modified by another process`,
    /** `hooks` itself is not an object (an array or a scalar): writing our
     *  events onto it would either lose them silently (string keys on an array
     *  do not survive JSON.stringify) or crash with a raw TypeError. */
    hooksNotObject: `hooks in ${spec.displayPath} is not an object — fix or remove it`,
    /** A `hooks.<Event>` field holds something other than an array. The value
     *  is malformed but it is the USER's — replacing it with `[]` silently
     *  destroys hand-written config. Refuse instead. */
    nonArrayEvent: (event: string) =>
      `hooks.${event} in ${spec.displayPath} is not an array — fix or remove it`,
    /** The backup path is occupied by something that is not a recoverable copy. */
    unusableBackup: (backupPath: string) =>
      `${backupPath} exists but is not a regular file, so no backup of ${path.basename(spec.settingsPath())} could be made — move or remove it`,
  };

  const isOurHook = (hook: HookCommand): boolean =>
    // Tolerates junk elements (null, scalars) — none of them can be ours, and
    // they must not crash the scan.
    hook !== null &&
    typeof hook === 'object' &&
    typeof hook.command === 'string' &&
    isOurHookCommand(hook.command, spec.scriptSuffixes);

  /** Whether any command in the entry is ours (used by areHooksInstalled). */
  const entryHasOurHook = (entry: HookEntry): boolean =>
    entry !== null &&
    typeof entry === 'object' &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => isOurHook(h));

  /** Raw file content, or null when the file does not exist. Throws on read errors. */
  function readRaw(): string | null {
    const settingsPath = spec.settingsPath();
    if (!fs.existsSync(settingsPath)) return null;
    return fs.readFileSync(settingsPath, 'utf-8');
  }

  /** Parse raw content. A missing file (null) is an empty config; content that
   *  cannot be parsed THROWS. It must never be treated as empty: these files
   *  hold the user's permission rules and settings, and a later write based on
   *  `{}` would erase them all. */
  function parse(raw: string | null): HookSettings {
    if (raw === null) return {};
    try {
      return JSON.parse(raw) as HookSettings;
    } catch (e) {
      throw new Error(messages.unparseable, { cause: e });
    }
  }

  /** Whether the parsed settings hold nothing a backup could preserve: every
   *  top-level key is `hooks`, and everything in it is exactly the shape our
   *  installer writes, running our script. This is what the file looks like
   *  when OUR install created it — and a backup taken then would enshrine our
   *  own output as "the user's original".
   *
   *  "Exactly the shape our installer writes" is checked against the WRITER —
   *  spec.makeHookEntry() is the reference the fields are compared to — so a
   *  field added to what we write can't silently revive the backup-of-our-own
   *  -file bug. Only `command` (the script path moves between homes and
   *  versions — identity is isOurHook) and `timeout` may differ. */
  function settingsHoldOnlyOurHooks(settings: HookSettings): boolean {
    if (Object.keys(settings).some((key) => key !== 'hooks')) return false;
    if (!('hooks' in settings)) return true;
    const hooks = settings.hooks;
    if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
    const reference = spec.makeHookEntry();
    const referenceFields = new Map<string, unknown>(Object.entries(reference));
    const referenceHookFields = new Map<string, unknown>(Object.entries(reference.hooks[0]));
    // isDeepStrictEqual, not stringify-compare: key order is not part of a value.
    const matchesWriter = (fields: Map<string, unknown>, key: string, value: unknown): boolean =>
      fields.has(key) && isDeepStrictEqual(value, fields.get(key));

    for (const entries of Object.values(hooks)) {
      // An empty event array is not ours: install always fills the key it adds,
      // and uninstall deletes a key its own removal emptied.
      if (!Array.isArray(entries) || entries.length === 0) return false;
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
        for (const [key, value] of Object.entries(entry)) {
          if (key === 'hooks') continue; // compared hook-by-hook below
          if (!matchesWriter(referenceFields, key, value)) return false;
        }
        if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) return false;
        for (const hook of entry.hooks) {
          if (!isOurHook(hook)) return false;
          for (const [key, value] of Object.entries(hook)) {
            if (key === 'command' || key === 'timeout') continue; // vary across installs
            if (!matchesWriter(referenceHookFields, key, value)) return false;
          }
        }
      }
    }
    return true;
  }

  /** One-time safety net: before our first-ever modification, copy the file
   *  aside. Never overwritten after that. COPYFILE_EXCL makes "create only if
   *  absent" one syscall. ANY failure THROWS: "no backup" must mean "no write".
   *  EEXIST counts as already-backed-up ONLY when a regular file (through
   *  symlinks) sits there — a directory or dangling symlink is not a copy. */
  function backupOnce(settingsPath: string): void {
    if (!fs.existsSync(settingsPath)) return;
    const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
    try {
      fs.copyFileSync(settingsPath, backupPath, fs.constants.COPYFILE_EXCL);
      console.log(`[Pixel Agents] Backed up ${spec.backupLabel} to ${backupPath}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (!isRegularFile(backupPath)) {
        throw new Error(messages.unusableBackup(backupPath), { cause: e });
      }
    }
  }

  /**
   * Atomic tmp + rename. `expectedRaw` is the exact content the mutation was
   * based on (null = no file). The final re-read verify sits immediately before
   * the rename, AFTER mkdir/backup/tmp-write, so the lost-update window is one
   * read plus one rename. Every failure throws after a best-effort tmp cleanup.
   */
  function write(settings: HookSettings, expectedRaw: string | null): void {
    const settingsPath = spec.settingsPath();
    const dir = path.dirname(settingsPath);
    const tmpPath = settingsPath + SETTINGS_TMP_SUFFIX;

    // A tmp file left by a crashed earlier run must not be committed.
    removeIfPresent(tmpPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // The decision is about what we are REPLACING, so it re-parses expectedRaw
    // (the parsed object has already been mutated into what we are about to
    // write). A file present now but absent at read time keeps the backup call;
    // the verify below aborts that write anyway.
    if (expectedRaw === null || !settingsHoldOnlyOurHooks(parse(expectedRaw))) {
      backupOnce(settingsPath);
    }

    // Preserve the user's mode (chmod, not the writeFileSync `mode` option,
    // which umask masks).
    const mode = fs.existsSync(settingsPath)
      ? fs.statSync(settingsPath).mode & 0o777
      : SETTINGS_FRESH_FILE_MODE;

    try {
      // Created restrictively, then chmod'd to the exact target: the tmp holds
      // the user's full settings and must never sit world-readable.
      fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), {
        encoding: 'utf-8',
        mode: SETTINGS_FRESH_FILE_MODE,
      });
      fs.chmodSync(tmpPath, mode);
      if (readRaw() !== expectedRaw) {
        throw new ConcurrentWriteError(messages.concurrentWrite);
      }
      fs.renameSync(tmpPath, settingsPath);
    } catch (e) {
      removeIfPresent(tmpPath);
      throw e;
    }
  }

  /**
   * Guarded read-modify-write. `mutate` edits the parsed settings in place and
   * returns whether anything changed; returns whether a write happened. A torn
   * read and a file changing between read and write both retry up to
   * SETTINGS_MUTATE_ATTEMPTS times, then throw. Every OTHER write error
   * propagates on the first attempt.
   */
  async function mutate(fn: (settings: HookSettings) => boolean): Promise<boolean> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < SETTINGS_MUTATE_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(SETTINGS_MUTATE_RETRY_DELAY_MS);
      let raw: string | null;
      let settings: HookSettings;
      try {
        raw = readRaw();
        settings = parse(raw);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        continue;
      }
      if (!fn(settings)) return false;
      try {
        write(settings, raw);
        return true;
      } catch (e) {
        if (!(e instanceof ConcurrentWriteError)) throw e;
        lastError = e;
      }
    }
    throw lastError ?? new Error(messages.unparseable);
  }

  /** Remove our commands from an entry, preserving third-party hooks that share
   *  it. Returns the slimmed entry, or DROP_ENTRY when OUR removal emptied it.
   *  Junk elements are passed through untouched rather than dereferenced. */
  function withoutOurHooks(entry: HookEntry): HookEntry | typeof DROP_ENTRY {
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return entry;
    const kept = entry.hooks.filter((h) => !isOurHook(h));
    if (kept.length === entry.hooks.length) return entry;
    if (kept.length === 0) return DROP_ENTRY;
    return { ...entry, hooks: kept };
  }

  /** Strip our commands from one event's entry array. Returns the new array, or
   *  null when nothing of ours was in it (so the caller leaves the key alone). */
  function withoutOurEntries(entries: HookEntry[]): HookEntry[] | null {
    const filtered = entries.map(withoutOurHooks).filter((e): e is HookEntry => e !== DROP_ENTRY);
    // Length alone misses a slimmed shared entry — compare content.
    return JSON.stringify(filtered) === JSON.stringify(entries) ? null : filtered;
  }

  /**
   * Whether ANY Pixel Agents hook command is present, under ANY event key.
   * "Any", not "all": a hook fires whether or not its siblings are there, and an
   * all-or-nothing answer made a partial install read as "nothing installed".
   * An unparseable file reads as "not installed" — install then refuses to
   * touch it rather than rewrite it.
   */
  function areHooksInstalled(): boolean {
    let settings: HookSettings;
    try {
      settings = parse(readRaw());
    } catch {
      return false;
    }
    const hooks = settings.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
    return Object.values(hooks).some(
      (entries) => Array.isArray(entries) && entries.some(entryHasOurHook),
    );
  }

  function installEntries(): Promise<boolean> {
    return mutate((settings) => {
      if (settings.hooks === undefined || settings.hooks === null) {
        settings.hooks = {};
      } else if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
        throw new Error(messages.hooksNotObject);
      }
      const hooks = settings.hooks;
      let changed = false;

      // Migration sweep FIRST: strip our commands from every event we no longer
      // install. A non-array under an unlisted event is the user's alone —
      // passing it through untouched IS the whole obligation.
      const listed = new Set<string>(spec.events);
      for (const event of Object.keys(hooks)) {
        if (listed.has(event)) continue;
        const entries = hooks[event];
        if (!Array.isArray(entries)) continue;
        const filtered = withoutOurEntries(entries);
        if (filtered === null) continue;
        changed = true;
        // Only remove the key when OUR removal emptied it.
        if (filtered.length === 0) {
          delete hooks[event];
        } else {
          hooks[event] = filtered;
        }
      }

      for (const event of spec.events) {
        const existing = hooks[event];
        if (existing === undefined) {
          hooks[event] = [];
        } else if (!Array.isArray(existing)) {
          // Malformed but the USER's: refuse rather than replace.
          throw new Error(messages.nonArrayEvent(event));
        }
        const entries = hooks[event];
        // Remove any existing Pixel Agents commands (in case the script path changed)
        const filtered = (withoutOurEntries(entries) ?? entries).concat(spec.makeHookEntry(event));
        if (JSON.stringify(filtered) !== JSON.stringify(entries)) {
          hooks[event] = filtered;
          changed = true;
        }
      }
      return changed;
    });
  }

  async function installHooks(): Promise<void> {
    let wrote: boolean;
    try {
      wrote = await installEntries();
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)} — hooks not installed.`, {
        cause: e,
      });
    }
    if (wrote) {
      console.log(`[Pixel Agents] Hooks installed in ${spec.displayPath}`);
    }
  }

  async function uninstallHooks(): Promise<void> {
    let wrote: boolean;
    try {
      wrote = await mutate((settings) => {
        if (
          !settings.hooks ||
          typeof settings.hooks !== 'object' ||
          Array.isArray(settings.hooks)
        ) {
          return false;
        }
        const hooks = settings.hooks;
        let changed = false;
        for (const event of Object.keys(hooks)) {
          const entries = hooks[event];
          if (!Array.isArray(entries)) continue;
          const filtered = withoutOurEntries(entries);
          if (filtered === null) continue;
          changed = true;
          // Remove the key only when OUR removal emptied it.
          if (filtered.length === 0) {
            delete hooks[event];
          } else {
            hooks[event] = filtered;
          }
        }
        if (changed && Object.keys(hooks).length === 0) {
          delete settings.hooks;
        }
        return changed;
      });
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)} — hook entries left in place.`,
        { cause: e },
      );
    }
    if (wrote) {
      console.log(`[Pixel Agents] Hooks removed from ${spec.displayPath}`);
    }
  }

  return { areHooksInstalled, installHooks, uninstallHooks, messages };
}

/** Copy a shipped hook script from `<packageRoot>/dist/hooks/<scriptName>` to
 *  `destPath`. Returns true if copied, false if the source was missing or the
 *  copy failed, so callers can report the failure instead of logging a false
 *  success (issue #333: a path regression silently installed nothing). */
export function copyHookScriptFile(
  packageRoot: string,
  scriptName: string,
  destPath: string,
): boolean {
  const src = path.join(packageRoot, 'dist', 'hooks', scriptName);
  const dstDir = path.dirname(destPath);
  try {
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] Hook script not found at ${src}`);
      return false;
    }
    fs.copyFileSync(src, destPath);
    fs.chmodSync(destPath, 0o700);
    console.log(`[Pixel Agents] Hook script installed at ${destPath}`);
    return true;
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy hook script: ${e}`);
    return false;
  }
}
