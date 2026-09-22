import * as http from 'http';

import { AGENTS_API_PATH, BOARD_CLI_REQUEST_TIMEOUT_MS } from './constants.js';
import { readLiveServers } from './launcher.js';
import type { RosterEntry } from './officeRoster.js';
import { describeRoster } from './officeRoster.js';
import type { ServerConfig } from './serverConfig.js';

/**
 * `pixel-office agents [--json]` — who is in the office, for AGENTS: every
 * agent whatever runs it (Claude, agy, Codex, Gemini…), with status, what it
 * is doing and its folder. Claude's own agent list knows Claude sessions only.
 * With several offices running, each is listed.
 */

export const AGENTS_USAGE = `Usage: pixel-office agents [--json]
Lists every agent in the running office(s) by name: CLI, status, what it is doing,
folder, and which one is you. Address one in a reply as @Name.`;

/** The caller's own session, when its CLI says (so the office can mark "you"). */
export function callerSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CLAUDE_CODE_SESSION_ID || env.ANTIGRAVITY_CONVERSATION_ID || undefined;
}

function fetchRoster(
  server: Pick<ServerConfig, 'port' | 'token'>,
  session?: string,
): Promise<RosterEntry[]> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: 'GET',
        path: AGENTS_API_PATH + (session ? `?session=${encodeURIComponent(session)}` : ''),
        headers: { Authorization: `Bearer ${server.token}` },
        timeout: BOARD_CLI_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          try {
            const body = JSON.parse(text) as { agents?: RosterEntry[] };
            if (res.statusCode !== 200 || !Array.isArray(body.agents)) throw new Error('bad');
            resolve(body.agents);
          } catch {
            reject(new Error('not an agents route')); // an older office
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

export async function runAgentsCommand(
  argv: string[],
  deps: { servers?: () => ServerConfig[]; out?: (s: string) => void } = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(s + '\n'));
  if (argv.includes('--help') || argv.includes('-h')) {
    out(AGENTS_USAGE);
    return 0;
  }
  const servers = (deps.servers ?? readLiveServers)();
  const results: Array<{ port: number; agents: RosterEntry[] }> = [];
  for (const server of servers) {
    try {
      results.push({ port: server.port, agents: await fetchRoster(server, callerSession()) });
    } catch {
      /* an office without the route, or gone */
    }
  }
  if (results.length === 0) {
    out('No Pixel Office is running (or it is too old to list agents).');
    return 1;
  }
  if (argv.includes('--json')) {
    out(JSON.stringify(results.length === 1 ? results[0].agents : results, null, 2));
    return 0;
  }
  out(
    results
      .map(
        (r) => (results.length > 1 ? `Office on port ${r.port}:\n` : '') + describeRoster(r.agents),
      )
      .join('\n\n'),
  );
  return 0;
}
