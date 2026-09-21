import { spawn as spawnChild } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {
  LAUNCHER_API_PREFIX,
  LAUNCHER_DISCOVERY_INTERVAL_MS,
  LAUNCHER_POLL_TIMEOUT_MS,
  LAUNCHER_RETRY_MS,
  SERVER_JSON_DIR,
  SERVERS_DIR,
} from './constants.js';
import type { ServerConfig } from './serverConfig.js';
import { isServerConfig } from './serverConfig.js';
import { typePrompt } from './terminalTyping.js';

/**
 * `pixel-office <program> [args…]` — run a program (Claude today) so the
 * office can type into it.
 *
 * Claude runs in a pty this process owns; the user's terminal is passed
 * through untouched (raw keys in, screen out, resizes). Meanwhile the launcher
 * long-polls every running Pixel Agents server for office chat messages
 * addressed to its session and types them in. Without node-pty (an optional
 * dependency with native code) or a TTY, Claude runs plainly and the session
 * stays read-only in the office.
 */

/** The slice of node-pty the launcher uses. */
interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number }) => void): void;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string | undefined>;
    },
  ): Pty;
}

export interface LaunchPlan {
  /** The program to run, as the user typed it. */
  program: string;
  /** Arguments to pass to it. */
  args: string[];
  /** The session the office can address, or null when it can't be known up front. */
  sessionId: string | null;
  /** False for print mode: nothing to type into. */
  interactive: boolean;
}

function flagValue(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) {
        const next = args[i + 1];
        return next !== undefined && !next.startsWith('-') ? next : '';
      }
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    }
  }
  return undefined;
}

/** Whether `program` is Claude Code (`claude`, `/usr/local/bin/claude`, `claude.cmd`). */
export function isClaudeProgram(program: string): boolean {
  const base = path
    .basename(program)
    .toLowerCase()
    .replace(/\.(cmd|exe|bat|ps1)$/, '');
  return base === 'claude';
}

/**
 * Decide how to run `program` and which session id the office will know it
 * by. Only Claude sessions are addressable (the office follows their
 * transcripts); any other program runs as-is with no session id.
 *
 * For Claude: a fresh session gets an id minted here and passed as
 * `--session-id`; an explicit `--session-id` or `--resume <id>` is used as
 * given. `--continue` and a bare `--resume` (the picker) pick a session only
 * Claude knows, so those runs are not addressable.
 */
export function planLaunch(
  program: string,
  args: string[],
  newId: () => string = randomUUID,
): LaunchPlan {
  const plan = (a: string[], sessionId: string | null, interactive = true): LaunchPlan => ({
    program,
    args: a,
    sessionId,
    interactive,
  });
  if (!isClaudeProgram(program)) return plan(args, null);
  if (flagValue(args, '-p', '--print') !== undefined) return plan(args, null, false);
  const explicit = flagValue(args, '--session-id');
  if (explicit) return plan(args, explicit);
  const resumed = flagValue(args, '-r', '--resume');
  if (resumed !== undefined) return plan(args, resumed || null);
  if (flagValue(args, '-c', '--continue') !== undefined) return plan(args, null);
  const sessionId = newId();
  return plan(['--session-id', sessionId, ...args], sessionId);
}

/** Live servers from the multi-server registry (same records the hook script fans out to). */
export function readLiveServers(
  registryDir = path.join(os.homedir(), SERVER_JSON_DIR, SERVERS_DIR),
): ServerConfig[] {
  let files: string[];
  try {
    files = fs.readdirSync(registryDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const live: ServerConfig[] = [];
  for (const file of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(registryDir, file), 'utf-8')) as unknown;
      if (!isServerConfig(entry)) continue;
      process.kill(entry.pid, 0); // throws when the process is gone
      live.push(entry);
    } catch {
      /* stale or unreadable entry: the server prunes it */
    }
  }
  return live;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadPty(): PtyModule | null {
  try {
    const pty = require('node-pty') as PtyModule;
    // node-pty's prebuilt spawn-helper ships without its execute bit on some
    // installs, which fails every spawn with "posix_spawnp failed".
    if (process.platform !== 'win32') {
      const root = path.dirname(require.resolve('node-pty/package.json'));
      const helper = path.join(
        root,
        'prebuilds',
        `${process.platform}-${process.arch}`,
        'spawn-helper',
      );
      try {
        fs.accessSync(helper, fs.constants.X_OK);
      } catch {
        if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
      }
    }
    return pty;
  } catch {
    return null;
  }
}

/** One long-poll: resolves with texts, or throws with `status` for HTTP errors. */
function pollOnce(server: ServerConfig, sessionId: string, cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: 'GET',
        path: `${LAUNCHER_API_PREFIX}/${encodeURIComponent(sessionId)}/input?cwd=${encodeURIComponent(cwd)}`,
        headers: { Authorization: `Bearer ${server.token}` },
        timeout: LAUNCHER_POLL_TIMEOUT_MS + 10_000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
            return;
          }
          try {
            const texts = (JSON.parse(body) as { texts?: unknown }).texts;
            resolve(Array.isArray(texts) ? texts.filter((t) => typeof t === 'string') : []);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function sayGoodbye(server: ServerConfig, sessionId: string): void {
  const req = http.request({
    host: '127.0.0.1',
    port: server.port,
    method: 'DELETE',
    path: `${LAUNCHER_API_PREFIX}/${encodeURIComponent(sessionId)}`,
    headers: { Authorization: `Bearer ${server.token}` },
    timeout: 1_000,
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end();
}

/** Run the program plainly, with the terminal handed straight through. */
function runPlain(program: string, args: string[]): Promise<never> {
  return new Promise(() => {
    // On Windows the shell resolves .cmd/.exe shims (claude.cmd, codex.cmd).
    const child = spawnChild(program, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', (err) => {
      console.error(`[Pixel Agents] Could not start ${program}: ${err.message}`);
      process.exit(127);
    });
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  });
}

export async function runLauncher(program: string, argv: string[]): Promise<never> {
  const plan = planLaunch(program, argv);
  if (!isClaudeProgram(program)) {
    console.error(
      `[Pixel Agents] The office follows Claude sessions only for now, so ${program} runs normally and won't appear in it.`,
    );
    return runPlain(plan.program, plan.args);
  }
  const pty = plan.interactive && process.stdin.isTTY && process.stdout.isTTY ? loadPty() : null;

  if (!pty || !plan.sessionId) {
    if (plan.interactive && !plan.sessionId) {
      console.error(
        '[Pixel Agents] --continue / bare --resume pick a session only Claude knows, so the office can show it but not send to it.',
      );
    } else if (plan.interactive && !pty) {
      console.error(
        '[Pixel Agents] node-pty is not available, so the office can show this session but not send to it.',
      );
    }
    return runPlain(plan.program, plan.args);
  }

  const sessionId = plan.sessionId;
  const cwd = process.cwd();
  const isWindows = process.platform === 'win32';
  const term = pty.spawn(
    isWindows ? (process.env.ComSpec ?? 'cmd.exe') : plan.program,
    isWindows ? ['/c', plan.program, ...plan.args] : plan.args,
    {
      name: process.env.TERM ?? 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd,
      env: process.env,
    },
  );

  // ── Pass the user's terminal through ──
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (data: Buffer) => term.write(data.toString('utf8')));
  term.onData((data) => process.stdout.write(data));
  process.stdout.on('resize', () => {
    term.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  });

  // ── Office input: poll every live server ──
  let exiting = false;
  const polling = new Map<string, ServerConfig>();
  let typing = Promise.resolve();

  const typeIn = (text: string): void => {
    // Serialize: one message is fully typed and submitted before the next starts.
    typing = typing.then(() =>
      typePrompt(
        (data) => term.write(data),
        text,
        () => exiting,
      ),
    );
  };

  const pollLoop = async (server: ServerConfig, key: string): Promise<void> => {
    while (!exiting) {
      try {
        for (const text of await pollOnce(server, sessionId, cwd)) typeIn(text);
      } catch (err) {
        const status = (err as { status?: number }).status;
        // 401/403: wrong token; 404: a server without the launcher route.
        if (status === 401 || status === 403 || status === 404) break;
        const stillLive = readLiveServers().some((s) => `${s.pid}-${s.port}` === key);
        if (!stillLive) break;
        await sleep(LAUNCHER_RETRY_MS);
      }
    }
    polling.delete(key);
  };

  const discover = (): void => {
    for (const server of readLiveServers()) {
      const key = `${server.pid}-${server.port}`;
      if (polling.has(key)) continue;
      polling.set(key, server);
      void pollLoop(server, key);
    }
  };
  discover();
  const discovery = setInterval(discover, LAUNCHER_DISCOVERY_INTERVAL_MS);

  return new Promise<never>(() => {
    term.onExit(({ exitCode }) => {
      exiting = true;
      clearInterval(discovery);
      for (const server of polling.values()) sayGoodbye(server, sessionId);
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* stdin already closed */
      }
      // Let the goodbyes leave before the process does.
      setTimeout(() => process.exit(exitCode), 150);
    });
  });
}
