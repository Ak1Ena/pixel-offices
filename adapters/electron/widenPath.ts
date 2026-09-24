/**
 * A Dock/Finder-launched macOS app gets a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) -- anything installed via Homebrew,
 * nvm, mise or asdf is invisible on it, which silently breaks
 * `OfficeSessions`, the launcher, `gitRoot.ts` and slash-command probing
 * (all of which shell out to `claude`, `node` or `git`).
 *
 * The pure pieces (`findOnPath`, `mergePath`) are electron-free and
 * unit-tested directly. `readLoginShellPath` is the one impure bit
 * (spawns a real shell) and is injected into `ensureUsablePath` so tests
 * never spawn a process.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const LOGIN_SHELL_PATH_TIMEOUT_MS = 3_000;

/** True if `bin` resolves to an executable file somewhere on `pathEnv`. */
export function findOnPath(bin: string, pathEnv: string): boolean {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      /* not here, keep looking */
    }
  }
  return false;
}

/** Login-shell PATH entries first (so the user's own nvm/Homebrew/mise/asdf
 *  shims win over anything already present), then whatever was already
 *  there that isn't a duplicate -- the minimal system PATH stays as a
 *  fallback rather than being discarded. */
export function mergePath(currentPath: string, shellPath: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...shellPath.split(path.delimiter), ...currentPath.split(path.delimiter)]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  return merged.join(path.delimiter);
}

/**
 * Asks the user's login shell for its PATH -- this is how it picks up
 * Homebrew/nvm/mise/asdf shims a GUI launch never sees. Never throws:
 * returns undefined on any failure (missing $SHELL, a shell that hangs
 * past the timeout, a non-zero exit, empty output) so a broken shell
 * config can never stop the app from starting.
 */
export function readLoginShellPath(): string | undefined {
  const shell = process.env['SHELL'] || '/bin/zsh';
  try {
    const out = execFileSync(shell, ['-ilc', 'echo $PATH'], {
      timeout: LOGIN_SHELL_PATH_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // An interactive login shell can print rc-file noise (MOTDs, banners)
    // to stdout ahead of our actual `echo` output; the PATH is whatever
    // came out last.
    const lines = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const last = lines[lines.length - 1];
    return last && last.includes('/') ? last : undefined;
  } catch {
    return undefined;
  }
}

export interface EnsureUsablePathOptions {
  /** Binary names to probe for, e.g. ['claude', 'node', 'git']. */
  required: readonly string[];
  env: NodeJS.ProcessEnv;
  getLoginShellPath: () => string | undefined;
  log: (message: string) => void;
}

/**
 * If every required binary already resolves on `env.PATH`, this is a
 * no-op. Otherwise it merges in the login shell's PATH and logs once.
 * Never throws and never stops the caller from proceeding -- a failure to
 * read the login shell's PATH just leaves `env.PATH` as it was.
 */
export function ensureUsablePath(opts: EnsureUsablePathOptions): void {
  const currentPath = opts.env['PATH'] ?? '';
  const missing = opts.required.filter((bin) => !findOnPath(bin, currentPath));
  if (missing.length === 0) return;

  const shellPath = opts.getLoginShellPath();
  if (!shellPath) return; // tolerate: leave PATH as-is, caller still starts

  opts.env['PATH'] = mergePath(currentPath, shellPath);
  opts.log(
    `[Pixel Office] PATH widened using the login shell (was missing: ${missing.join(', ')})`,
  );
}
