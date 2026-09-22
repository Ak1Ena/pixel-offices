import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

import type { TeamPreset, Workflow } from '../../core/src/messages.js';
import {
  AI_DRAFT_COMMAND,
  AI_DRAFT_MAX_OUTPUT_BYTES,
  AI_DRAFT_MODEL,
  AI_DRAFT_TIMEOUT_MS,
  TEAM_TEXT_MAX_CHARS,
} from './constants.js';
import { sanitizeTeam } from './teamFile.js';
import { sanitizeWorkflow } from './workflowFile.js';

/**
 * AI drafts of teams and workflows. Runs `claude -p` (non-interactive, JSON
 * output) with edit and shell tools refused, in the project folder only when
 * the user allowed it to read the project (else in the temp folder). The
 * draft goes back to the requesting client to review; nothing is saved here.
 */

export type RunClaude = (prompt: string, cwd: string) => Promise<string>;

/** Spawn the drafter and return its final text. */
export const runClaude: RunClaude = (prompt, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      AI_DRAFT_COMMAND,
      [
        '-p',
        prompt,
        '--output-format',
        'json',
        '--model',
        AI_DRAFT_MODEL,
        '--disallowedTools',
        'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch',
      ],
      { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The draft took too long.'));
    }, AI_DRAFT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (out.length < AI_DRAFT_MAX_OUTPUT_BYTES) out += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < 4_000) err += chunk.toString('utf-8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ${AI_DRAFT_COMMAND}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(err.trim().split('\n').pop() || `${AI_DRAFT_COMMAND} exited with ${code}.`),
        );
        return;
      }
      try {
        const parsed = JSON.parse(out) as { result?: unknown; is_error?: boolean };
        if (parsed.is_error) reject(new Error(String(parsed.result ?? 'The drafter failed.')));
        else resolve(typeof parsed.result === 'string' ? parsed.result : out);
      } catch {
        resolve(out);
      }
    });
  });

/** The first JSON object in a reply (bare, or inside a ```json fence). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The drafter did not answer with JSON.');
  return JSON.parse(body.slice(start, end + 1));
}

function workDir(folder: unknown, readProject: unknown): string {
  if (readProject === true && typeof folder === 'string' && folder.trim()) {
    const dir = folder.trim().replace(/^~(?=$|\/)/, os.homedir());
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* fall through to the temp folder */
    }
  }
  return os.tmpdir();
}

const clip = (v: unknown) => (typeof v === 'string' ? v.slice(0, TEAM_TEXT_MAX_CHARS) : '');

const WORKFLOW_SHAPE =
  '{"title": string, "steps": [{"kind": "do" | "show" | "gate", "text": string, "refs"?: [file paths], "show"?: "path --lines A-B"}]}';

export function teamPrompt(input: Record<string, unknown>): string {
  const lines = [
    'You design a team of AI coding agents for the Pixel Office. Each member is a Claude Code session started in the same project folder.',
    'Reply with ONLY one JSON object, no prose, shaped like:',
    `{"team": {"title": string, "description": one sentence, "goalTemplate": what the lead is told, containing "{goal}", "relay": true when members should message each other, "members": [{"name": short lowercase handle without spaces, "role": two or three words, "lead": true for exactly one member, "instructions": 2-4 sentences on what this member does and who it hands work to by @name, "command": "claude --model claude-opus-5" for the lead and "claude --model claude-sonnet-5" (or claude-haiku-4-5 for simple checking roles), "workflowId"?: id of a workflow below}]}, "workflows": [at most one workflow the lead follows, with an "id" like "draft-1", shaped ${WORKFLOW_SHAPE}], "note": one line on what you made}`,
    'Use 2 to 5 members. A "gate" step is where the user must approve before going on; put one before anything irreversible (publishing, merging, deleting, deploying).',
  ];
  if (input.readProject === true)
    lines.push('You may read the project (Read, Glob, Grep) to fit the roles to the code.');
  if (input.previous) {
    lines.push(
      '',
      'Here is the current draft:',
      JSON.stringify(input.previous),
      '',
      `Change it as follows: ${clip(input.change)}`,
    );
  } else {
    lines.push('', `The user wants: ${clip(input.description)}`);
  }
  return lines.join('\n');
}

export function workflowPrompt(input: Record<string, unknown>): string {
  const lines = [
    'You write a workflow: an ordered list of steps an AI coding agent follows.',
    'Reply with ONLY one JSON object, no prose, shaped like:',
    `{"workflow": ${WORKFLOW_SHAPE}, "unsure": [numbers of steps you guessed rather than knew], "note": one line}`,
    'Kinds: "do" = the agent does it; "show" = the agent shows the user a file and waits (give "show" as a path with optional --lines); "gate" = stop until the user approves. Put a gate before anything irreversible. Keep steps short and concrete; 3 to 10 steps.',
  ];
  if (input.readProject === true)
    lines.push(
      'You may read the project (Read, Glob, Grep) to use its real commands and file paths.',
    );
  if (input.previous) {
    lines.push(
      '',
      'Here is the current draft:',
      JSON.stringify(input.previous),
      '',
      `Change it as follows: ${clip(input.change)}`,
    );
  } else {
    lines.push('', `The workflow is for: ${clip(input.description)}`);
  }
  return lines.join('\n');
}

export async function draftTeam(
  input: Record<string, unknown>,
  run: RunClaude = runClaude,
): Promise<{ team: TeamPreset; workflows: Workflow[]; note?: string }> {
  const answer = extractJson(
    await run(teamPrompt(input), workDir(input.folder, input.readProject)),
  ) as Record<string, unknown>;
  const team = sanitizeTeam({ ...(answer.team as object), id: '' });
  if (!team) throw new Error('The drafter did not produce a usable team.');
  const workflows: Workflow[] = [];
  for (const raw of Array.isArray(answer.workflows) ? answer.workflows.slice(0, 3) : []) {
    const w = sanitizeWorkflow({ ...(raw as object), id: '' });
    const id = typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : '';
    if (w && /^[a-z0-9-]{1,64}$/.test(id)) workflows.push({ ...w, id });
  }
  // A member may only point at a workflow the draft brought along.
  for (const m of team.members) {
    if (m.workflowId && !workflows.some((w) => w.id === m.workflowId)) delete m.workflowId;
  }
  return {
    team,
    workflows,
    ...(typeof answer.note === 'string' ? { note: answer.note.slice(0, 300) } : {}),
  };
}

export async function draftWorkflow(
  input: Record<string, unknown>,
  run: RunClaude = runClaude,
): Promise<{ workflow: Workflow; unsure: number[]; note?: string }> {
  const answer = extractJson(
    await run(workflowPrompt(input), workDir(input.folder, input.readProject)),
  ) as Record<string, unknown>;
  const workflow = sanitizeWorkflow({ ...(answer.workflow as object), id: '' });
  if (!workflow) throw new Error('The drafter did not produce a usable workflow.');
  const unsure = Array.isArray(answer.unsure)
    ? answer.unsure.filter(
        (n): n is number => Number.isInteger(n) && n >= 1 && n <= workflow.steps.length,
      )
    : [];
  return {
    workflow: { ...workflow, id: '' },
    unsure,
    ...(typeof answer.note === 'string' ? { note: answer.note.slice(0, 300) } : {}),
  };
}
