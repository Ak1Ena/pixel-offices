/**
 * Antigravity CLI hook script (bundled to dist/hooks/antigravity-hook.js,
 * copied to ~/.pixel-agents/hooks/). agy runs it as
 * `node antigravity-hook.js <Event>` with a payload that has no event name,
 * no session id and often no working directory, so this fills them in:
 *
 * - `hook_event_name` from argv, `session_id` from `conversationId`.
 * - agy has no SessionStart: every model call (`PreInvocation`) also posts a
 *   synthesized `SessionStart` first, so the office can adopt the
 *   conversation (repeats are no-ops once it is known).
 * - On a conversation's FIRST event only: `cli_pids`, this process's
 *   ancestors, nearest first. A run the office started (+ Agent, or
 *   `pixel-office agy`) is known by its terminal's pid, which is one of them:
 *   agy itself on macOS/Linux, or the `cmd.exe` in between on Windows (agy
 *   runs hooks through `cmd /c`, the launcher starts programs through it).
 *   Walking the whole process table is not free (a PowerShell call on
 *   Windows), and hooks block agy's loop, so later events skip it.
 * - cwd: the first workspace path, else (first event, macOS/Linux) agy's own
 *   working directory, else the tool call's `Cwd`. Windows cannot read
 *   another process's cwd; for a run the office started, the office fills it.
 *
 * It always prints `{}` first — agy requires a JSON reply from every hook.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runHookScript } from '../../hookScript.js';
import { ANTIGRAVITY_HOOK_REPLY } from '../constants.js';

/** How far up the process tree to report. */
const MAX_ANCESTORS = 8;
/** PowerShell's cold start is slow; agy gives the whole hook ANTIGRAVITY_HOOK_TIMEOUT_S. */
const LOOKUP_TIMEOUT_MS = process.platform === 'win32' ? 4000 : 2500;

/** pid → parent pid for every process, or null when the table can't be read. */
function processTable(): Map<number, number> | null {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
            ],
            { encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS, windowsHide: true },
          )
        : execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
            encoding: 'utf8',
            timeout: LOOKUP_TIMEOUT_MS,
          });
    const table = new Map<number, number>();
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid > 0 && ppid >= 0) table.set(pid, ppid);
    }
    return table;
  } catch {
    return null;
  }
}

/** This process's ancestors, nearest first (at least the direct parent). */
function ancestors(): number[] {
  const chain = [process.ppid];
  const table = processTable();
  if (!table) return chain;
  let pid = process.ppid;
  while (chain.length < MAX_ANCESTORS) {
    const parent = table.get(pid);
    if (!parent || parent <= 1 || chain.includes(parent)) break;
    chain.push(parent);
    pid = parent;
  }
  return chain;
}

/** The working directory of the process running us (macOS/Linux only). */
function parentCwd(): string | undefined {
  const pid = process.ppid;
  try {
    if (process.platform === 'linux') return fs.readlinkSync(`/proc/${pid}/cwd`);
    if (process.platform === 'darwin') {
      const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        encoding: 'utf8',
        timeout: LOOKUP_TIMEOUT_MS,
      });
      const line = out.split('\n').find((l) => l.startsWith('n'));
      return line ? line.slice(1) : undefined;
    }
  } catch {
    /* best effort */
  }
  return undefined;
}

/** True the first time this conversation is seen on this machine (a marker in the temp dir). */
function firstSighting(sessionId: string): boolean {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(sessionId)) return false;
  try {
    fs.writeFileSync(path.join(os.tmpdir(), `pixel-agents-agy-${sessionId}`), '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function cwdOf(data: Record<string, unknown>, first: boolean): string | undefined {
  const paths = data.workspacePaths;
  if (Array.isArray(paths) && typeof paths[0] === 'string' && paths[0]) return paths[0];
  if (first) {
    const cwd = parentCwd();
    if (cwd) return cwd;
  }
  const args = (data.toolCall as { args?: { Cwd?: unknown } } | undefined)?.args;
  return typeof args?.Cwd === 'string' ? args.Cwd : undefined;
}

runHookScript({
  providerId: 'antigravity',
  stdoutReply: ANTIGRAVITY_HOOK_REPLY,
  expand(data) {
    const event = process.argv[2];
    const sessionId = data.conversationId;
    if (!event || typeof sessionId !== 'string' || !sessionId) return [];
    const first = firstSighting(sessionId);
    const cwd = cwdOf(data, first);
    const base = {
      ...data,
      session_id: sessionId,
      ...(cwd ? { cwd } : {}),
      ...(first ? { cli_pids: ancestors() } : {}),
    };
    const current = { ...base, hook_event_name: event };
    return event === 'PreInvocation'
      ? [{ ...base, hook_event_name: 'SessionStart' }, current]
      : [current];
  },
});
