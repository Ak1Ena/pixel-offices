import * as fs from 'fs';
import * as http from 'http';

import { resolveFilePath } from './boardCli.js';
import {
  BOARD_CLI_REQUEST_TIMEOUT_MS,
  FOCUS_API_PATH,
  FOCUS_FIND_MAX_BYTES,
  FOCUS_POLL_MS,
  FOCUS_WAIT_MS,
} from './constants.js';
import { readLiveServers } from './launcher.js';
import type { ServerConfig } from './serverConfig.js';

/**
 * `pixel-office show <path> …` — an agent points the user at part of a file.
 * The office shows a notice and a bubble over the agent, and opens the file in
 * its viewer at the lines / page / cell given. Only the path is sent; the
 * office reads the file itself when the user opens it.
 */

export class ShowCliError extends Error {}

export interface ShowCommand {
  help?: boolean;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  page?: number;
  cell?: string;
  find?: string;
  why?: string;
  agent?: string;
  wait: boolean;
}

export const SHOW_USAGE = `Usage: pixel-office show <path> [--lines 40-58] [--page 3] [--cell "Q3!B4"]
                         [--find "phrase"] [--why "why the user should look"]
                         [--agent NAME] [--wait]

Points the user at part of a file: the office opens it in its document viewer
at those lines (text, code, markdown, logs, CSV), page (PDF) or cell (Excel).
Only the path is sent, never the file.
--wait   keep running until the user answers, then print "ok" or their reply.`;

function needValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined) throw new ShowCliError(`${flag} needs a value.\n\n${SHOW_USAGE}`);
  return value;
}

function positive(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ShowCliError(`${flag} needs a number from 1 up.`);
  return n;
}

export function parseShowArgs(argv: string[]): ShowCommand {
  const cmd: ShowCommand = { path: '', wait: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        return { ...cmd, help: true };
      case '--lines': {
        const m = /^(\d+)(?:\s*[-:]\s*(\d+))?$/.exec(needValue(argv, i, arg).trim());
        if (!m) throw new ShowCliError('--lines takes a line or a range, e.g. 40 or 40-58.');
        cmd.lineStart = positive(m[1], arg);
        cmd.lineEnd = m[2] ? positive(m[2], arg) : cmd.lineStart;
        if (cmd.lineEnd < cmd.lineStart)
          [cmd.lineStart, cmd.lineEnd] = [cmd.lineEnd, cmd.lineStart];
        i++;
        break;
      }
      case '--page':
        cmd.page = positive(needValue(argv, i, arg), arg);
        i++;
        break;
      case '--cell':
        cmd.cell = needValue(argv, i, arg);
        i++;
        break;
      case '--find':
        cmd.find = needValue(argv, i, arg);
        i++;
        break;
      case '--why':
        cmd.why = needValue(argv, i, arg);
        i++;
        break;
      case '--agent':
        cmd.agent = needValue(argv, i, arg);
        i++;
        break;
      case '--wait':
        cmd.wait = true;
        break;
      default:
        if (arg.startsWith('-')) throw new ShowCliError(`Unknown option ${arg}.\n\n${SHOW_USAGE}`);
        if (cmd.path) throw new ShowCliError(`Only one file at a time.\n\n${SHOW_USAGE}`);
        cmd.path = arg;
    }
  }
  if (!cmd.path) throw new ShowCliError(SHOW_USAGE);
  return cmd;
}

/** The 1-based line of the first line containing `phrase` (case-insensitive), if any. */
export function findLine(text: string, phrase: string): number | undefined {
  const wanted = phrase.toLowerCase();
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((l) => l.toLowerCase().includes(wanted));
  return index === -1 ? undefined : index + 1;
}

interface Res {
  status: number;
  body: unknown;
}

function request(
  server: ServerConfig,
  method: 'GET' | 'POST',
  suffix: string,
  payload: unknown,
  timeout: number,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path: FOCUS_API_PATH + suffix,
        headers: {
          Authorization: `Bearer ${server.token}`,
          ...(data !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            : {}),
        },
        timeout,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            reject(new Error('not a focus route')); // an older office answers with its SPA page
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

function errorOf(body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'string' ? error : 'request failed';
}

export interface ShowCliDeps {
  servers?: ServerConfig[];
  cwd?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: () => number;
}

/** Run `pixel-office show`. Returns the process exit code. */
export async function runShowCommand(argv: string[], deps: ShowCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((t: string) => console.log(t));
  const err = deps.err ?? ((t: string) => console.error(t));
  const now = deps.now ?? Date.now;
  try {
    const cmd = parseShowArgs(argv);
    if (cmd.help) {
      out(SHOW_USAGE);
      return 0;
    }
    const cwd = deps.cwd ?? process.cwd();
    const filePath = resolveFilePath(cmd.path, cwd);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new ShowCliError(`No such file: ${filePath}`);
    }
    if (!stat.isFile()) throw new ShowCliError(`Not a file: ${filePath}`);

    if (cmd.find !== undefined && cmd.lineStart === undefined) {
      if (stat.size > FOCUS_FIND_MAX_BYTES)
        throw new ShowCliError('--find: the file is too big to search.');
      const line = findLine(fs.readFileSync(filePath, 'utf-8'), cmd.find);
      if (line === undefined)
        throw new ShowCliError(`--find: "${cmd.find}" is not in ${filePath}.`);
      cmd.lineStart = line;
      cmd.lineEnd = line;
    }

    const payload = {
      path: filePath,
      lineStart: cmd.lineStart,
      lineEnd: cmd.lineEnd,
      page: cmd.page,
      cell: cmd.cell,
      why: cmd.why,
      agent: cmd.agent,
      cwd,
    };
    let opened: { server: ServerConfig; requestId: string } | null = null;
    let refusal = '';
    for (const server of deps.servers ?? readLiveServers()) {
      try {
        const res = await request(server, 'POST', '', payload, BOARD_CLI_REQUEST_TIMEOUT_MS);
        if (res.status === 401 || res.status === 403 || res.status === 404) continue;
        if (res.status >= 400) {
          refusal = errorOf(res.body);
          continue;
        }
        const requestId = (res.body as { request?: { requestId?: unknown } }).request?.requestId;
        if (typeof requestId === 'string') {
          opened = { server, requestId };
          break;
        }
      } catch {
        /* unreachable: try the next office */
      }
    }
    if (!opened)
      throw new ShowCliError(
        refusal || 'No Pixel Office is running, so nobody can be shown the file.',
      );

    if (!cmd.wait) {
      out(
        'The office is showing the user that file. Carry on, or run again with --wait to wait for them.',
      );
      return 0;
    }
    const deadline = now() + FOCUS_WAIT_MS;
    while (now() < deadline) {
      let poll: { state?: string; reply?: string };
      try {
        const res = await request(
          opened.server,
          'GET',
          `/${opened.requestId}`,
          undefined,
          FOCUS_POLL_MS + BOARD_CLI_REQUEST_TIMEOUT_MS,
        );
        poll = res.body as typeof poll;
      } catch {
        throw new ShowCliError('Lost the office while waiting for the user.');
      }
      if (poll.state === 'seen') {
        out(poll.reply ? `The user replied: ${poll.reply}` : 'ok');
        return 0;
      }
      if (poll.state === 'gone') {
        out('The request was closed before the user answered.');
        return 0;
      }
    }
    out('No answer from the user yet. Carry on without it.');
    return 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
