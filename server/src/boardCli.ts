import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import type { BoardPin, BoardPinKind } from '../../core/src/messages.js';
import { BoardStore, pinFromInput } from './boardStore.js';
import {
  BOARD_CLI_REQUEST_TIMEOUT_MS,
  BOARD_NO_SUCH_PIN_ERROR,
  BOARD_PINS_API_PATH,
} from './constants.js';
import { readLiveServers } from './launcher.js';
import type { ServerConfig } from './serverConfig.js';

/**
 * `pixel-office board …` — the whiteboard for AGENTS. Any harness that can run
 * a shell command (Claude, Codex, Gemini, …) can list, add and remove pins.
 *
 * Talks to a live office server through `/api/board/pins` (so the office
 * broadcasts at once and `--for NAME` resolves against live agents). With no
 * server running it edits ~/.pixel-agents/board.json directly through
 * BoardStore — every office polls that file, so the pin still shows up later.
 */

export class BoardCliError extends Error {}

export interface BoardAddInput {
  kind: BoardPinKind;
  /** Undefined only for a snippet that is read from stdin. */
  value?: string;
  title?: string;
  detail?: string;
  author?: string;
  for: string[];
}

export type BoardCommand =
  | { cmd: 'help' }
  | { cmd: 'list'; json: boolean }
  | { cmd: 'add'; input: BoardAddInput }
  | { cmd: 'rm'; id: string }
  | { cmd: 'detail'; id: string; detail: string };

export const BOARD_USAGE = `Usage: pixel-office board list [--json]
       pixel-office board add --note "text"   [--title T] [--detail D] [--for NAME] [--author NAME]
       pixel-office board add --link URL      [--title T] [--detail D] [--for NAME] [--author NAME]
       pixel-office board add --file PATH     [--title T] [--detail D] [--for NAME] [--author NAME]
       pixel-office board add --snippet "code" (or pipe the snippet on stdin)
       pixel-office board detail <id> "text"   (set a pin's detail; "" clears it)
       pixel-office board rm <id>

The whiteboard is shared by every agent in the office; ~/.pixel-agents/board.md
lists it as plain text. --detail adds notes (what it is, why it matters).
--for (repeatable) limits a pin to named agents.`;

const KIND_FLAGS: Record<string, BoardPinKind> = {
  '--note': 'note',
  '--link': 'link',
  '--file': 'file',
  '--snippet': 'snippet',
};

/** An absolute path for `--file`, expanding a leading `~`. */
export function resolveFilePath(raw: string, cwd = process.cwd()): string {
  const expanded =
    raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
      ? path.join(os.homedir(), raw.slice(1))
      : raw;
  return path.resolve(cwd, expanded);
}

/** Pure argument parsing (argv after `board`). Throws BoardCliError on bad input. */
export function parseBoardArgs(argv: string[], cwd = process.cwd()): BoardCommand {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
    return { cmd: 'help' };
  }
  if (sub === 'list' || sub === 'ls') {
    return { cmd: 'list', json: rest.includes('--json') };
  }
  if (sub === 'rm' || sub === 'remove') {
    const id = rest[0];
    if (!id) throw new BoardCliError('Missing pin id: pixel-office board rm <id>');
    return { cmd: 'rm', id };
  }
  if (sub === 'detail') {
    const [id, detail] = rest;
    if (!id || detail === undefined) {
      throw new BoardCliError('Usage: pixel-office board detail <id> "text"');
    }
    return { cmd: 'detail', id, detail };
  }
  if (sub !== 'add') throw new BoardCliError(`Unknown board command "${sub}".\n\n${BOARD_USAGE}`);

  let kind: BoardPinKind | undefined;
  let value: string | undefined;
  let title: string | undefined;
  let detail: string | undefined;
  let author: string | undefined;
  const forNames: string[] = [];
  const takeValue = (i: number, flag: string): string => {
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new BoardCliError(`Missing value for ${flag}.`);
    }
    return next;
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg in KIND_FLAGS) {
      if (kind) throw new BoardCliError('Give one of --note, --link, --file or --snippet.');
      kind = KIND_FLAGS[arg];
      const next = rest[i + 1];
      if (kind === 'snippet' && (next === undefined || next.startsWith('--'))) continue; // stdin
      value = takeValue(i, arg);
      i++;
    } else if (arg === '--title') {
      title = takeValue(i, arg);
      i++;
    } else if (arg === '--detail') {
      detail = takeValue(i, arg);
      i++;
    } else if (arg === '--for') {
      forNames.push(takeValue(i, arg));
      i++;
    } else if (arg === '--author') {
      author = takeValue(i, arg);
      i++;
    } else {
      throw new BoardCliError(`Unknown option "${arg}".\n\n${BOARD_USAGE}`);
    }
  }
  if (!kind) throw new BoardCliError('Give one of --note, --link, --file or --snippet.');
  if (kind === 'file' && value !== undefined) value = resolveFilePath(value, cwd);
  return { cmd: 'add', input: { kind, value, title, detail, author, for: forNames } };
}

// ── Server transport ──────────────────────────────────────────

interface BoardResponse {
  status: number;
  body: unknown;
}

/** One request to a server's board route. Rejects when the server can't be reached. */
function boardRequest(
  server: Pick<ServerConfig, 'port' | 'token'>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  suffix = '',
  payload?: unknown,
): Promise<BoardResponse> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path: BOARD_PINS_API_PATH + suffix,
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
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            // Not our route (an older office answers with its SPA page).
            reject(new Error('not a board route'));
            return;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

/**
 * Try each live server until one serves the board route. Returns null when
 * none does (no office running, or only offices without the route).
 */
async function viaServer(
  servers: ServerConfig[],
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  suffix?: string,
  payload?: unknown,
): Promise<BoardResponse | null> {
  // The standalone office has the routes; a VS Code window's server doesn't.
  const ordered = [...servers].sort((a, b) => Number(b.servesSpa) - Number(a.servesSpa));
  for (const server of ordered) {
    try {
      const res = await boardRequest(server, method, suffix, payload);
      // Fastify's own not-found: a server without the route.
      const unknownRoute = res.status === 404 && errorOf(res.body) !== BOARD_NO_SUCH_PIN_ERROR;
      if (unknownRoute || res.status === 401 || res.status === 403) continue;
      return res;
    } catch {
      /* unreachable: try the next one */
    }
  }
  return null;
}

function errorOf(body: unknown): string {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return 'request failed';
}

// ── Output ───────────────────────────────────────────────────

export function formatPins(pins: BoardPin[]): string {
  if (pins.length === 0) return 'The whiteboard is empty.';
  const lines: string[] = [];
  for (const pin of pins) {
    const who = pin.scope.length === 0 ? 'everyone' : `agents ${pin.scope.join(', ')}`;
    lines.push(`${pin.id}  [${pin.kind}]  ${pin.title}  (for: ${who})`);
    const firstLine = pin.value.split('\n')[0] ?? '';
    if (firstLine && firstLine !== pin.title) {
      lines.push(`    ${firstLine.length > 100 ? firstLine.slice(0, 99) + '…' : firstLine}`);
    }
    if (pin.detail) {
      for (const line of pin.detail.split('\n')) lines.push(`    │ ${line}`);
    }
  }
  return lines.join('\n');
}

// ── Run ───────────────────────────────────────────────────────

export interface BoardCliDeps {
  /** Live office servers (default: the registry). */
  servers?: ServerConfig[];
  /** board.json used when no server answers (default: ~/.pixel-agents/board.json). */
  boardFile?: string;
  /** Reads a snippet from stdin. */
  readStdin?: () => Promise<string>;
  out?: (text: string) => void;
  err?: (text: string) => void;
  cwd?: string;
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new BoardCliError('--snippet needs a value or text piped on stdin.'));
      return;
    }
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (text += chunk));
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}

/** Run a board command. Returns the process exit code. */
export async function runBoardCommand(argv: string[], deps: BoardCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((t: string) => console.log(t));
  const err = deps.err ?? ((t: string) => console.error(t));
  let command: BoardCommand;
  try {
    command = parseBoardArgs(argv, deps.cwd);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
  if (command.cmd === 'help') {
    out(BOARD_USAGE);
    return 0;
  }
  const servers = deps.servers ?? readLiveServers();
  const withStore = <T>(fn: (store: BoardStore) => T): T => {
    const store = new BoardStore(() => {}, deps.boardFile);
    try {
      return fn(store);
    } finally {
      store.dispose();
    }
  };

  try {
    if (command.cmd === 'list') {
      const res = await viaServer(servers, 'GET');
      const pins =
        res && res.status === 200
          ? ((res.body as { pins?: BoardPin[] }).pins ?? [])
          : withStore((s) => s.getPins());
      out(command.json ? JSON.stringify(pins, null, 2) : formatPins(pins));
      return 0;
    }

    if (command.cmd === 'rm') {
      const res = await viaServer(servers, 'DELETE', `/${encodeURIComponent(command.id)}`);
      const removed = res ? res.status === 200 : withStore((s) => s.removePin(command.id));
      if (!removed) {
        err(`No pin with id "${command.id}".`);
        return 1;
      }
      out(`Removed ${command.id}.`);
      return 0;
    }

    if (command.cmd === 'detail') {
      const res = await viaServer(servers, 'PATCH', `/${encodeURIComponent(command.id)}`, {
        detail: command.detail,
      });
      let ok: boolean;
      if (res) {
        ok = res.status === 200;
        if (!ok && res.status !== 404) {
          err(`Could not set the detail: ${errorOf(res.body)}`);
          return 1;
        }
      } else {
        ok = withStore((s) => {
          const pin = s.getPins().find((p) => p.id === command.id);
          return pin ? s.savePin({ ...pin, detail: command.detail }) : false;
        });
      }
      if (!ok) {
        err(`No pin with id "${command.id}".`);
        return 1;
      }
      out(`Detail ${command.detail.trim() ? 'set' : 'cleared'} on ${command.id}.`);
      return 0;
    }

    const { input } = command;
    const value = input.value ?? (await (deps.readStdin ?? readAllStdin)());
    const payload = {
      kind: input.kind,
      value,
      title: input.title,
      detail: input.detail,
      author: input.author,
      scope: input.for.length > 0 ? input.for : undefined,
    };
    const res = await viaServer(servers, 'POST', '', payload);
    let pin: BoardPin;
    if (res) {
      if (res.status !== 200) {
        err(`Could not add the pin: ${errorOf(res.body)}`);
        return 1;
      }
      pin = (res.body as { pin: BoardPin }).pin;
    } else {
      if (input.for.length > 0) {
        err('--for needs a running office (agent names are resolved by it). Start: pixel-office');
        return 1;
      }
      const result = pinFromInput(payload);
      if (!result.ok) {
        err(`Could not add the pin: ${result.error}`);
        return 1;
      }
      if (!withStore((s) => s.savePin(result.pin))) {
        err('Could not add the pin: the whiteboard is full.');
        return 1;
      }
      pin = result.pin;
    }
    out(`Pinned ${pin.id}: ${pin.title}`);
    return 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
