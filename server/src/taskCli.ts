import * as fs from 'fs';
import * as http from 'http';

import {
  BOARD_CLI_REQUEST_TIMEOUT_MS,
  TASK_NO_SUCH_CARD_ERROR,
  TASKS_API_PATH,
} from './constants.js';
import { readLiveServers } from './launcher.js';
import type { ServerConfig } from './serverConfig.js';

/**
 * `pixel-office task …` — how an AGENT answers the task desk. The office types
 * a short prompt into the agent's terminal; the card's text and the agent's
 * reply travel through here instead, so nothing long is ever typed key by key.
 *
 * Unlike the whiteboard there is no offline mode: a card is handed out by one
 * live office process, and only that process can take the reply.
 */

export class TaskCliError extends Error {}

export type TaskCommand =
  | { cmd: 'help' }
  | { cmd: 'show'; ref: string }
  | { cmd: 'brief'; ref: string; file?: string }
  | { cmd: 'step'; ref: string; step: number }
  | {
      cmd: 'done';
      ref: string;
      summary: string;
      branch?: string;
      diffStat?: string;
      tests?: string;
    };

export const TASK_USAGE = `Usage: pixel-office task show <number>
       pixel-office task brief <number> --file brief.json   (or pipe the JSON on stdin)
       pixel-office task step <number> <subtask number>
       pixel-office task done <number> --summary "what you did" [--branch B] [--diff "3 files, +40 -2"] [--tests "result"]

brief.json: {"understanding": "...", "subtasks": ["...", "..."], "files": ["..."],
             "questions": ["..."], "risk": "low|medium|high", "size": "..."}
Only answer a card the office handed to you.`;

const REF_RE = /^#?\d{1,9}$/;

export function parseTaskArgs(argv: string[]): TaskCommand {
  const [cmd, rawRef, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return { cmd: 'help' };
  if (cmd !== 'show' && cmd !== 'brief' && cmd !== 'step' && cmd !== 'done') {
    throw new TaskCliError(`Unknown command "${cmd}".\n\n${TASK_USAGE}`);
  }
  if (!rawRef || !REF_RE.test(rawRef)) throw new TaskCliError(`"${cmd}" needs the card's number.`);
  const ref = rawRef.replace('#', '');

  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const value = rest[i + 1];
      if (value === undefined) throw new TaskCliError(`${rest[i]} needs a value.`);
      flags.set(rest[i], value);
      i++;
    } else positional.push(rest[i]);
  }

  if (cmd === 'show') return { cmd, ref };
  if (cmd === 'brief') return { cmd, ref, file: flags.get('--file') };
  if (cmd === 'step') {
    const step = Number(positional[0]);
    if (!Number.isInteger(step) || step < 1)
      throw new TaskCliError('"step" needs the subtask number.');
    return { cmd, ref, step };
  }
  const summary = flags.get('--summary')?.trim();
  if (!summary) throw new TaskCliError('"done" needs --summary "what you did".');
  return {
    cmd,
    ref,
    summary,
    branch: flags.get('--branch'),
    diffStat: flags.get('--diff'),
    tests: flags.get('--tests'),
  };
}

interface TaskResponse {
  status: number;
  body: unknown;
}

function taskRequest(
  server: Pick<ServerConfig, 'port' | 'token'>,
  method: 'GET' | 'POST',
  suffix: string,
  payload?: unknown,
): Promise<TaskResponse> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path: TASKS_API_PATH + suffix,
        headers: {
          Authorization: `Bearer ${server.token}`,
          ...(data !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            : {}),
        },
        timeout: BOARD_CLI_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            reject(new Error('not a task route')); // an older office answers with its SPA page
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

/**
 * Ask each live office until one takes the request. An office that doesn't
 * know the card (404), didn't hand it out (409) or has no such route is
 * skipped; the most telling refusal is kept for when nobody takes it.
 */
async function viaServers(
  servers: ServerConfig[],
  method: 'GET' | 'POST',
  suffix: string,
  payload?: unknown,
): Promise<TaskResponse | null> {
  let refusal: TaskResponse | null = null;
  for (const server of servers) {
    try {
      const res = await taskRequest(server, method, suffix, payload);
      if (res.status === 401 || res.status === 403) continue;
      if (res.status === 404 && errorOf(res.body) !== TASK_NO_SUCH_CARD_ERROR) continue;
      if (res.status === 404 || res.status === 409) {
        if (!refusal || res.status === 409) refusal = res;
        continue;
      }
      return res;
    } catch {
      /* unreachable: try the next one */
    }
  }
  return refusal;
}

export interface TaskCliDeps {
  servers?: ServerConfig[];
  readStdin?: () => Promise<string>;
  readFile?: (file: string) => string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new TaskCliError('"brief" needs --file brief.json, or the JSON piped on stdin.'));
      return;
    }
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (text += chunk));
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}

/** Run a task command. Returns the process exit code. */
export async function runTaskCommand(argv: string[], deps: TaskCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((t: string) => console.log(t));
  const err = deps.err ?? ((t: string) => console.error(t));
  try {
    const command = parseTaskArgs(argv);
    if (command.cmd === 'help') {
      out(TASK_USAGE);
      return 0;
    }

    let method: 'GET' | 'POST' = 'POST';
    let suffix = `/${command.ref}`;
    let payload: unknown;
    if (command.cmd === 'show') {
      method = 'GET';
    } else if (command.cmd === 'brief') {
      const text = command.file
        ? (deps.readFile ?? ((f: string) => fs.readFileSync(f, 'utf-8')))(command.file)
        : await (deps.readStdin ?? readAllStdin)();
      try {
        payload = JSON.parse(text);
      } catch {
        throw new TaskCliError('The brief is not valid JSON.');
      }
      suffix += '/brief';
    } else if (command.cmd === 'step') {
      payload = { step: command.step };
      suffix += '/step';
    } else {
      const { summary, branch, diffStat, tests } = command;
      payload = { summary, branch, diffStat, tests };
      suffix += '/done';
    }

    const res = await viaServers(deps.servers ?? readLiveServers(), method, suffix, payload);
    if (!res)
      throw new TaskCliError('No Pixel Office is running, so there is no task desk to answer.');
    if (res.status >= 400) throw new TaskCliError(errorOf(res.body));

    const body = res.body as { text?: string; task?: { num: number; state: string } };
    if (command.cmd === 'show') out(body.text ?? '');
    else if (command.cmd === 'brief')
      out(`Brief handed in for card #${body.task?.num}. Stop here; a human will check it.`);
    else if (command.cmd === 'step')
      out(`Subtask ${command.step} of card #${body.task?.num} marked done.`);
    else out(`Card #${body.task?.num} reported as finished. A human will check it.`);
    return 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
