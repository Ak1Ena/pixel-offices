import type { WorkflowRun, WorkflowStep } from '../../core/src/messages.js';

/** Pure helpers for workflows in the office (DOM-free, Node-testable). */

/** The run an agent is working through right now, if any. */
export function activeRun(runs: WorkflowRun[], agentId: number): WorkflowRun | undefined {
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].agentId === agentId && runs[i].state === 'running') return runs[i];
  }
  return undefined;
}

/** Steps finished (done or skipped) out of all, and the gate waiting on the user. */
export function runProgress(run: WorkflowRun): {
  done: number;
  total: number;
  waiting: number | null;
} {
  const done = run.steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  const index = run.steps.findIndex((s) => s.state === 'waiting');
  return { done, total: run.steps.length, waiting: index === -1 ? null : index + 1 };
}

/** Gates waiting on the user across all runs, oldest run first. */
export function openGates(runs: WorkflowRun[]): Array<{ run: WorkflowRun; step: number }> {
  const gates: Array<{ run: WorkflowRun; step: number }> = [];
  for (const run of runs) {
    if (run.state !== 'running') continue;
    run.steps.forEach((s, i) => {
      if (s.state === 'waiting') gates.push({ run, step: i + 1 });
    });
  }
  return gates;
}

/** Move step `from` by `delta` (−1 up, +1 down); unchanged when it would leave the list. */
export function moveStep(steps: WorkflowStep[], from: number, delta: number): WorkflowStep[] {
  const to = from + delta;
  if (from < 0 || from >= steps.length || to < 0 || to >= steps.length) return steps;
  const next = [...steps];
  const [step] = next.splice(from, 1);
  next.splice(to, 0, step);
  return next;
}

/** The markdown the office will write — shown beside the editor as a preview. */
export function previewMarkdown(title: string, steps: WorkflowStep[]): string {
  const out = ['---', `title: ${title || 'Untitled'}`, '---', ''];
  steps.forEach((s, i) => {
    out.push(`${i + 1}. [${s.kind}] ${s.text}`);
    for (const ref of s.refs ?? []) if (ref.trim()) out.push(`   ref: ${ref}`);
    if (s.show?.trim()) out.push(`   show: ${s.show}`);
  });
  return out.join('\n');
}
