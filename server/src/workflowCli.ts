import * as http from 'http';

import type { WorkflowRun } from '../../core/src/messages.js';
import {
  BOARD_CLI_REQUEST_TIMEOUT_MS,
  WORKFLOW_GATE_POLL_MS,
  WORKFLOWS_API_PATH,
} from './constants.js';
import { readLiveServers } from './launcher.js';
import type { ServerConfig } from './serverConfig.js';

/**
 * `pixel-office workflow …` — how an agent works through a workflow it was
 * given: mark steps done, and wait at a gate for the user's go-ahead.
 */

export class WorkflowCliError extends Error {}

export type WorkflowCommand =
  | { cmd: 'help' }
  | { cmd: 'show'; runId: string }
  | { cmd: 'step'; runId: string; step: number }
  | { cmd: 'gate'; runId: string; step: number };

export const WORKFLOW_USAGE = `Usage: pixel-office workflow show <run>
       pixel-office workflow step <run> <step number>   (you finished that step)
       pixel-office workflow gate <run> <step number>   (wait for the user's go-ahead)

The run id (like w1a2b3c) is in the message that gave you the workflow.`;

export function parseWorkflowArgs(argv: string[]): WorkflowCommand {
  const [cmd, runId, stepRaw] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return { cmd: 'help' };
  if (cmd !== 'show' && cmd !== 'step' && cmd !== 'gate') {
    throw new WorkflowCliError(`Unknown command "${cmd}".\n\n${WORKFLOW_USAGE}`);
  }
  if (!runId || !/^w[a-f0-9]{6}$/.test(runId)) {
    throw new WorkflowCliError(`"${cmd}" needs the run id, like w1a2b3c.\n\n${WORKFLOW_USAGE}`);
  }
  if (cmd === 'show') return { cmd, runId };
  const step = Number(stepRaw);
  if (!Number.isInteger(step) || step < 1)
    throw new WorkflowCliError(`"${cmd}" needs the step number.`);
  return { cmd, runId, step };
}

interface Res {
  status: number;
  body: unknown;
}

function request(
  server: ServerConfig,
  method: 'GET' | 'POST',
  suffix: string,
  timeout: number,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path: WORKFLOWS_API_PATH + suffix,
        headers: { Authorization: `Bearer ${server.token}` },
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
            reject(new Error('not a workflow route'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function errorOf(body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'string' ? error : 'request failed';
}

/** The office that knows this run (404 from the others). */
async function findRun(
  servers: ServerConfig[],
  runId: string,
): Promise<{ server: ServerConfig; run: WorkflowRun } | null> {
  for (const server of servers) {
    try {
      const res = await request(server, 'GET', `/runs/${runId}`, BOARD_CLI_REQUEST_TIMEOUT_MS);
      if (res.status === 200) return { server, run: (res.body as { run: WorkflowRun }).run };
    } catch {
      /* unreachable or an older office */
    }
  }
  return null;
}

export function describeRun(run: WorkflowRun): string {
  const lines = [`${run.title} (run ${run.runId}, ${run.state})`];
  run.steps.forEach((s, i) => {
    const mark =
      s.state === 'done' ? 'x' : s.state === 'skipped' ? '-' : s.state === 'waiting' ? '?' : ' ';
    lines.push(`[${mark}] ${i + 1}. [${s.kind}] ${s.text}`);
    for (const ref of s.refs ?? []) lines.push(`      ref: ${ref}`);
  });
  return lines.join('\n');
}

export interface WorkflowCliDeps {
  servers?: ServerConfig[];
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export async function runWorkflowCommand(
  argv: string[],
  deps: WorkflowCliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((t: string) => console.log(t));
  const err = deps.err ?? ((t: string) => console.error(t));
  try {
    const command = parseWorkflowArgs(argv);
    if (command.cmd === 'help') {
      out(WORKFLOW_USAGE);
      return 0;
    }
    const found = await findRun(deps.servers ?? readLiveServers(), command.runId);
    if (!found) throw new WorkflowCliError(`No running Pixel Office knows run ${command.runId}.`);
    const { server } = found;
    if (command.cmd === 'show') {
      out(describeRun(found.run));
      return 0;
    }
    if (command.cmd === 'step') {
      const res = await request(
        server,
        'POST',
        `/runs/${command.runId}/step/${command.step}`,
        BOARD_CLI_REQUEST_TIMEOUT_MS,
      );
      if (res.status >= 400) throw new WorkflowCliError(errorOf(res.body));
      const run = (res.body as { run: WorkflowRun }).run;
      out(
        run.state === 'done'
          ? `Step ${command.step} done. That was the last step: the workflow is finished.`
          : `Step ${command.step} marked done.`,
      );
      return 0;
    }
    const opened = await request(
      server,
      'POST',
      `/runs/${command.runId}/gate/${command.step}`,
      BOARD_CLI_REQUEST_TIMEOUT_MS,
    );
    if (opened.status >= 400) throw new WorkflowCliError(errorOf(opened.body));
    for (;;) {
      let decision: string;
      try {
        const res = await request(
          server,
          'GET',
          `/runs/${command.runId}/gate/${command.step}`,
          WORKFLOW_GATE_POLL_MS + BOARD_CLI_REQUEST_TIMEOUT_MS,
        );
        decision = String((res.body as { decision?: unknown }).decision);
      } catch {
        throw new WorkflowCliError(
          'Lost the office while waiting at the gate. Ask the user how to go on.',
        );
      }
      if (decision === 'continue') {
        out(`The user said go ahead. Step ${command.step} is done; carry on with the next step.`);
        return 0;
      }
      if (decision === 'stop' || decision === 'gone') {
        out(
          'The user stopped this workflow. Do not continue it; say what state you left things in.',
        );
        return 0;
      }
    }
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
