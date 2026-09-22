/**
 * The body every provider's hook script shares (claude-hook.js, codex-hook.js,
 * gemini-hook.js): read one event from stdin, POST it to every live Pixel
 * Agents server at `/api/hooks/<providerId>`, and — for a provider whose CLI
 * takes a permission decision from the hook's stdout — hold the prompt open
 * until an office answers. Bundled into each script by esbuild.js; never
 * imported by the server.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {
  HOOK_API_PREFIX,
  PERMISSION_POLL_MS,
  PERMISSION_POLL_SEGMENT,
  PERMISSION_WAIT_MS,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  SERVERS_DIR,
} from '../../constants.js';
import type { ServerConfig, ServerTarget } from '../../serverConfig.js';
import { isServerConfig, isServerTarget } from '../../serverConfig.js';

const SERVER_JSON = path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);
const SERVERS_REGISTRY_DIR = path.join(os.homedir(), SERVER_JSON_DIR, SERVERS_DIR);

/** What differs between providers' hook scripts. */
export interface HookScriptOptions {
  /** Route segment: events POST to `/api/hooks/<providerId>`. */
  providerId: string;
  /** Hook event whose prompt the CLI lets this script answer on stdout with
   *  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":…}}`
   *  (Claude Code and Codex share the shape). Undefined = fire-and-forget only. */
  permissionEvent?: 'PermissionRequest';
  /** Written to stdout before anything else, for a CLI that requires a reply
   *  from every hook (Antigravity reads `{}` as "no opinion"). */
  stdoutReply?: string;
  /** Turns the CLI's payload into the events to POST, in order, each carrying
   *  `hook_event_name` and `session_id` (for a CLI whose payload lacks them). */
  expand?: (data: Record<string, unknown>) => Array<Record<string, unknown>>;
}

/**
 * CI / e2e diagnostic: when PIXEL_AGENTS_DEBUG_LOG is set, record the hook
 * script's outcome at every exit point. The hook delivery chain (spawn
 * claude-hook.js -> read the registry -> POST to every live server) is
 * otherwise 100% silent: every failure path resolves quietly, so a dropped
 * hook is invisible in CI. Logging here lets a failing run show exactly
 * where delivery dies (bad-stdin, no-server-json, per-server POST
 * error/timeout/status). Zero cost when the env var is unset.
 */
// Env var is the primary source, but it doesn't reliably reach this spawned
// process across platforms (macOS VS Code terminal profiles with
// inheritEnv:false, etc.). After reading the registry we fall back to a
// live server's `debugLog` field, which the server populated from the same
// env var.
let debugLogPath = process.env['PIXEL_AGENTS_DEBUG_LOG'];
function hookDebug(line: string): void {
  if (!debugLogPath) return;
  try {
    fs.appendFileSync(debugLogPath, `${new Date().toISOString()} HOOKSCRIPT ${line}\n`);
  } catch {
    /* never let diagnostics break the hook */
  }
}

/** True if a process with this PID is alive. Best-effort: a false positive on
 *  PID reuse just costs one extra, harmless, failed POST -- never a crash. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerate every live registry entry under ~/.pixel-agents/servers/, so the
 * event can fan out to each running server (VS Code embedded + a standalone
 * `npx pixel-agents`, or several of either, all at once). Entries whose owning
 * PID is no longer alive are skipped (the owning server prunes its own stale
 * file on next start; this script only needs to not POST to it). Returns an
 * empty array when the directory is absent/empty/unreadable -- the caller
 * falls back to the legacy single-target server.json (forward-compat with a
 * server that predates the registry).
 */
function readRegistry(): ServerConfig[] {
  let files: string[];
  try {
    files = fs.readdirSync(SERVERS_REGISTRY_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const live: ServerConfig[] = [];
  for (const file of files) {
    const filePath = path.join(SERVERS_REGISTRY_DIR, file);
    try {
      const entry = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (!isServerConfig(entry)) {
        hookDebug(`registry-skip reason=malformed file=${file} err=invalid-server-config`);
        continue;
      }
      if (isProcessAlive(entry.pid)) {
        live.push(entry);
      } else {
        hookDebug(`registry-skip reason=dead-pid file=${file} pid=${entry.pid}`);
      }
    } catch (e) {
      hookDebug(
        `registry-skip reason=malformed file=${file} err=${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return live;
}

/**
 * POST one hook event to one server. Best-effort: every failure path (bad
 * connection, timeout, non-2xx status) resolves quietly -- a dropped delivery
 * to one server must never affect delivery to any other server, nor the
 * script's exit code.
 */
function postToServer(
  providerId: string,
  server: ServerTarget,
  body: string,
  eventName: string,
  sid: string,
): Promise<string | null> {
  hookDebug(`POST event=${eventName} sid=${sid} port=${server.port}`);
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: `${HOOK_API_PREFIX}/${providerId}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`,
          },
          timeout: 2000,
        },
        (res) => {
          hookDebug(
            `POST-done event=${eventName} sid=${sid} status=${res.statusCode} port=${server.port}`,
          );
          let text = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            if (text.length < 4096) text += chunk;
          });
          res.on('end', () => resolve(res.statusCode === 200 ? text : null));
          res.on('error', () => resolve(null));
        },
      );
      req.on('error', (err) => {
        hookDebug(
          `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err.message}`,
        );
        resolve(null);
      });
      req.on('timeout', () => {
        hookDebug(`POST-timeout event=${eventName} sid=${sid} port=${server.port}`);
        req.destroy();
        resolve(null);
      });
      req.end(body);
    } catch (err) {
      hookDebug(
        `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err instanceof Error ? err.message : String(err)}`,
      );
      resolve(null);
    }
  });
}

type Decision = 'allow' | 'deny' | 'terminal' | 'pending';

/** One long-poll for the office's decision on a held permission prompt. */
function pollDecision(
  providerId: string,
  server: ServerTarget,
  requestId: string,
): Promise<Decision> {
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: `${HOOK_API_PREFIX}/${providerId}/${PERMISSION_POLL_SEGMENT}/${requestId}`,
          method: 'GET',
          headers: { Authorization: `Bearer ${server.token}` },
          timeout: PERMISSION_POLL_MS + 5_000,
        },
        (res) => {
          let text = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => {
            try {
              const decision = (JSON.parse(text) as { decision?: unknown }).decision;
              resolve(
                decision === 'allow' || decision === 'deny' || decision === 'pending'
                  ? decision
                  : 'terminal',
              );
            } catch {
              resolve('terminal');
            }
          });
          res.on('error', () => resolve('terminal'));
        },
      );
      req.on('error', () => resolve('terminal'));
      req.on('timeout', () => {
        req.destroy();
        resolve('terminal');
      });
      req.end();
    } catch {
      resolve('terminal');
    }
  });
}

/**
 * Hold a permission prompt until an office answers it. Every server that said
 * it will wait is polled; the first allow/deny wins. When every one of them
 * lets go (`terminal`: someone chose "answer in terminal", or the server went
 * away) or the wait runs out, returns null and the CLI shows its own dialog.
 */
async function awaitDecision(
  providerId: string,
  waiting: ServerTarget[],
  requestId: string,
): Promise<'allow' | 'deny' | null> {
  const deadline = Date.now() + PERMISSION_WAIT_MS;
  let live = waiting;
  while (live.length > 0 && Date.now() < deadline) {
    const results = await new Promise<Array<{ server: ServerTarget; decision: Decision }>>(
      (resolve) => {
        const out: Array<{ server: ServerTarget; decision: Decision }> = [];
        let left = live.length;
        for (const server of live) {
          void pollDecision(providerId, server, requestId).then((decision) => {
            out.push({ server, decision });
            // An answer settles it at once; otherwise wait for every poll.
            if (decision === 'allow' || decision === 'deny' || --left === 0) resolve(out);
          });
        }
      },
    );
    const answered = results.find((r) => r.decision === 'allow' || r.decision === 'deny');
    if (answered) return answered.decision as 'allow' | 'deny';
    live = results.filter((r) => r.decision === 'pending').map((r) => r.server);
  }
  return null;
}

async function main(options: HookScriptOptions): Promise<void> {
  const { providerId } = options;
  if (options.stdoutReply !== undefined) process.stdout.write(options.stdoutReply);
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    hookDebug('exit reason=bad-stdin');
    process.exit(0);
  }

  const events = options.expand ? options.expand(data) : [data];
  if (events.length === 0) process.exit(0);
  data = events[events.length - 1];
  const eventName = (data.hook_event_name as string | undefined) ?? '?';
  const sid = (data.session_id as string | undefined)?.slice(0, 8) ?? '?';

  // Multi-server fan-out (D4): deliver to every live server in the registry.
  // Falls back to the single legacy server.json when the registry has no live
  // entries -- e.g. a server on disk that predates the registry (A1/A2).
  let servers: ServerTarget[] = readRegistry();
  if (servers.length === 0) {
    try {
      const legacy = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf-8')) as unknown;
      if (!isServerTarget(legacy)) {
        throw new Error('invalid legacy server config');
      }
      servers = [legacy];
    } catch (e) {
      hookDebug(
        `exit reason=no-server-json event=${eventName} sid=${sid} path=${SERVER_JSON} err=${e instanceof Error ? e.message : String(e)}`,
      );
      process.exit(0);
    }
  }

  // Adopt the first live server's debug-log path if the env var didn't reach
  // us (diagnostic-only; harmless if more than one server has it set).
  if (!debugLogPath) {
    const withDebugLog = servers.find((s) => s.debugLog);
    if (withDebugLog?.debugLog) debugLogPath = withDebugLog.debugLog;
  }

  // A permission prompt: the CLI (Claude Code, Codex) waits for this hook
  // before showing its dialog, and takes an allow/deny from our stdout. Tag it
  // so a server with the office open can hold it for an answer.
  const holdsPrompt =
    options.permissionEvent !== undefined && eventName === options.permissionEvent;
  const requestId = holdsPrompt ? crypto.randomUUID() : '';
  if (holdsPrompt) data.pixel_request_id = requestId;

  // Extra events first, in order (e.g. a synthesized SessionStart), then this one.
  for (const extra of events.slice(0, -1)) {
    const extraBody = JSON.stringify(extra);
    await Promise.all(
      servers.map((server) =>
        postToServer(providerId, server, extraBody, String(extra.hook_event_name ?? '?'), sid),
      ),
    );
  }
  const body = JSON.stringify(data);
  const replies = await Promise.all(
    servers.map((server) => postToServer(providerId, server, body, eventName, sid)),
  );
  if (!holdsPrompt) return;

  const waiting = servers.filter((_, i) => {
    try {
      return (JSON.parse(replies[i] ?? '') as { await?: unknown }).await === true;
    } catch {
      return false;
    }
  });
  if (waiting.length === 0) return;
  hookDebug(`PERMISSION-wait sid=${sid} servers=${waiting.length}`);
  const decision = await awaitDecision(providerId, waiting, requestId);
  hookDebug(`PERMISSION-done sid=${sid} decision=${decision ?? 'terminal'}`);
  if (!decision) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision:
          decision === 'allow'
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: 'Denied from Pixel Office.' },
      },
    }),
  );
}

/**
 * Run a hook script to completion: read the event from stdin, deliver it to
 * every live office server, and — for the provider's permission event — hold
 * the prompt until an office answers. Always exits 0: a hook must never break
 * the CLI that runs it.
 */
export function runHookScript(options: HookScriptOptions): void {
  main(options)
    .catch(() => {})
    .finally(() => process.exit(0));
}
