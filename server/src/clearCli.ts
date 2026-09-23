import * as http from 'http';

import { callerSession } from './agentsCli.js';
import { BOARD_CLI_REQUEST_TIMEOUT_MS, CLEAR_API_PATH } from './constants.js';
import { readLiveServers } from './launcher.js';
import type { ServerConfig } from './serverConfig.js';

/**
 * `pixel-office clear [--reason TEXT]` — an agent asks the office to clear its
 * own context. The office types `/clear` into the agent's terminal once the
 * current turn has ended; nothing is typed after it, so the agent starts
 * blank. Whether that happens is the human's setting for this agent: ask
 * (default — the request waits for them), allow, or never.
 */

export const CLEAR_USAGE = `Usage: pixel-office clear [--reason "why"]
Asks the office to clear your context (/clear) after this turn ends. Nothing is
carried over: write down anything you need first (a file, the whiteboard).
The human may have to allow it.`;

interface ClearReply {
  statusCode: number;
  status?: string;
  error?: string;
}

function postClear(
  server: Pick<ServerConfig, 'port' | 'token'>,
  body: { session: string; reason?: string },
): Promise<ClearReply> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: 'POST',
        path: CLEAR_API_PATH,
        headers: {
          Authorization: `Bearer ${server.token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: BOARD_CLI_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(text) as { status?: string; error?: string };
            resolve({ statusCode: res.statusCode ?? 0, ...parsed });
          } catch {
            resolve({ statusCode: res.statusCode ?? 0 }); // an older office
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

export function parseClearArgs(argv: string[]): { reason?: string } | { help: true } {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const at = argv.indexOf('--reason');
  const reason = at >= 0 ? argv[at + 1] : undefined;
  return reason && !reason.startsWith('--') ? { reason } : {};
}

export async function runClearCommand(
  argv: string[],
  deps: {
    servers?: () => ServerConfig[];
    session?: string;
    out?: (s: string) => void;
  } = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const args = parseClearArgs(argv);
  if ('help' in args) {
    out(CLEAR_USAGE);
    return 0;
  }
  const session = deps.session ?? callerSession();
  if (!session) {
    out('Cannot tell which session you are (CLAUDE_CODE_SESSION_ID is not set).');
    return 1;
  }
  const servers = (deps.servers ?? readLiveServers)();
  for (const server of servers) {
    let reply: ClearReply;
    try {
      reply = await postClear(server, { session, ...args });
    } catch {
      continue; // gone
    }
    if (reply.statusCode === 404) continue; // not this office's session (or an older office)
    if (reply.status === 'scheduled') {
      out('Your context will be cleared when this turn ends. Nothing is carried over.');
      return 0;
    }
    if (reply.status === 'asked') {
      out(
        'Asked the human. If they allow it, your context is cleared after this turn ends. Nothing is carried over.',
      );
      return 0;
    }
    out(reply.error ?? 'The office refused to clear your context.');
    return 1;
  }
  out('No Pixel Office running here knows this session, so nothing was cleared.');
  return 1;
}
