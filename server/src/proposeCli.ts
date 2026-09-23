import * as fs from 'fs';
import * as http from 'http';

import { resolveFilePath } from './boardCli.js';
import {
  BOARD_CLI_REQUEST_TIMEOUT_MS,
  PROPOSAL_POLL_MS,
  PROPOSAL_WAIT_MS,
  PROPOSALS_API_PATH,
} from './constants.js';
import { readLiveServers } from './launcher.js';
import type { ServerConfig } from './serverConfig.js';

/**
 * `pixel-office propose FILE --from NEWFILE` — suggest a change instead of
 * writing it. Write your version of FILE somewhere else (NEWFILE); the user
 * reviews the difference in the office and accepts what they want. Only the
 * two paths are sent.
 */

export class ProposeCliError extends Error {}

export interface ProposeCommand {
  help?: boolean;
  path: string;
  from: string;
  why?: string;
  agent?: string;
  wait: boolean;
}

export const PROPOSE_USAGE = `Usage: pixel-office propose <file> --from <your version> [--why "what and why"]
                            [--agent NAME] [--wait]

Suggests changes to <file> without writing it: write your full new version to
another file (--from), and the user reviews the difference in the office,
accepting or rejecting each change. Only the accepted ones are written.
--wait   keep running until the user decides, then print what was applied.`;

export function parseProposeArgs(argv: string[]): ProposeCommand {
  const cmd: ProposeCommand = { path: '', from: '', wait: false };
  const need = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined) throw new ProposeCliError(`${flag} needs a value.\n\n${PROPOSE_USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { ...cmd, help: true };
    if (arg === '--from') cmd.from = need(i++, arg);
    else if (arg === '--why') cmd.why = need(i++, arg);
    else if (arg === '--agent') cmd.agent = need(i++, arg);
    else if (arg === '--wait') cmd.wait = true;
    else if (arg.startsWith('-'))
      throw new ProposeCliError(`Unknown option ${arg}.\n\n${PROPOSE_USAGE}`);
    else if (cmd.path) throw new ProposeCliError(`One file at a time.\n\n${PROPOSE_USAGE}`);
    else cmd.path = arg;
  }
  if (!cmd.path || !cmd.from) throw new ProposeCliError(PROPOSE_USAGE);
  return cmd;
}

/** One call to the office's proposals route (also used by `doc edit --wait`). */
export function request(
  server: ServerConfig,
  method: 'GET' | 'POST',
  suffix: string,
  payload: unknown,
  timeout: number,
) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path: PROPOSALS_API_PATH + suffix,
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
            reject(new Error('not a proposals route'));
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

export interface ProposeCliDeps {
  servers?: ServerConfig[];
  cwd?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export async function runProposeCommand(
  argv: string[],
  deps: ProposeCliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((t: string) => console.log(t));
  const err = deps.err ?? ((t: string) => console.error(t));
  try {
    const cmd = parseProposeArgs(argv);
    if (cmd.help) {
      out(PROPOSE_USAGE);
      return 0;
    }
    const cwd = deps.cwd ?? process.cwd();
    const filePath = resolveFilePath(cmd.path, cwd);
    const fromPath = resolveFilePath(cmd.from, cwd);
    if (!fs.existsSync(fromPath)) throw new ProposeCliError(`No such file: ${fromPath}`);
    const payload = { path: filePath, from: fromPath, why: cmd.why, agent: cmd.agent, cwd };
    let opened: { server: ServerConfig; id: string; count: number } | null = null;
    let refusal = '';
    for (const server of deps.servers ?? readLiveServers()) {
      try {
        const res = await request(server, 'POST', '', payload, BOARD_CLI_REQUEST_TIMEOUT_MS);
        if (res.status === 401 || res.status === 403 || res.status === 404) continue;
        const body = res.body as {
          error?: string;
          proposal?: { proposalId: string; hunks: unknown[] };
        };
        if (res.status >= 400 || !body.proposal) {
          refusal = body.error ?? 'request failed';
          continue;
        }
        opened = { server, id: body.proposal.proposalId, count: body.proposal.hunks.length };
        break;
      } catch {
        /* unreachable: next office */
      }
    }
    if (!opened)
      throw new ProposeCliError(
        refusal ||
          'No Pixel Office is running, so nobody can review the change. Nothing was written.',
      );
    if (!cmd.wait) {
      out(
        `Suggested ${opened.count} change${opened.count === 1 ? '' : 's'} to ${filePath}. Nothing is written until the user accepts them; you'll get a message saying what landed.`,
      );
      return 0;
    }
    const deadline = Date.now() + PROPOSAL_WAIT_MS;
    while (Date.now() < deadline) {
      let result: { state?: string; summary?: string };
      try {
        result = (
          await request(
            opened.server,
            'GET',
            `/${opened.id}`,
            undefined,
            PROPOSAL_POLL_MS + BOARD_CLI_REQUEST_TIMEOUT_MS,
          )
        ).body as typeof result;
      } catch {
        throw new ProposeCliError('Lost the office while waiting for the review.');
      }
      if (result.state === 'applied' || result.state === 'discarded') {
        out(result.summary ?? result.state);
        return 0;
      }
      if (result.state === 'gone') {
        out('The suggestion was closed before the user decided. Nothing was written.');
        return 0;
      }
    }
    out('The user has not decided yet. Carry on; you will get a message when they do.');
    return 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
