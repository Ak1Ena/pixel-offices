import type { Workflow, WorkflowStep, WorkflowStepKind } from '../../core/src/messages.js';
import {
  WORKFLOW_MAX_STEPS,
  WORKFLOW_REF_MAX_CHARS,
  WORKFLOW_STEP_MAX_CHARS,
  WORKFLOW_TITLE_MAX_CHARS,
} from './constants.js';

/**
 * The workflow file format — plain markdown an agent reads with its own tools
 * and a person can edit anywhere:
 *
 *   ---
 *   title: Release check
 *   ---
 *   1. [do] Run the full test suite
 *      ref: ~/code/app/CHANGELOG.md
 *   2. [show] Show me the changelog
 *      show: ~/code/app/CHANGELOG.md --lines 1-40
 *   3. [gate] Wait for my go-ahead
 *
 * Parsing is lenient (a step without a [kind] is a "do"; other indented lines
 * continue the step's text) so a hand-edited file still loads.
 */

const KINDS: ReadonlySet<string> = new Set(['do', 'show', 'gate']);
const STEP_RE = /^\s*\d+[.)]\s+(?:\[(\w+)\]\s*)?(.*)$/;

function clean(text: string, max: number): string {
  return text
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim()
    .slice(0, max);
}

/** A file-name-safe id from a title: "Release check" → "release-check". */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'workflow';
}

export function parseWorkflow(id: string, text: string): Workflow {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  let i = 0;
  if (lines[0]?.trim() === '---') {
    for (i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
      const m = /^title:\s*(.*)$/.exec(lines[i]);
      if (m) title = m[1].replace(/^["']|["']$/g, '');
    }
    i++;
  }
  const steps: WorkflowStep[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!title) {
      const heading = /^#\s+(.*)$/.exec(line);
      if (heading) {
        title = heading[1];
        continue;
      }
    }
    const m = STEP_RE.exec(line);
    if (m && /^\s{0,3}\d/.test(line)) {
      if (steps.length >= WORKFLOW_MAX_STEPS) break;
      const kind = (
        m[1] && KINDS.has(m[1].toLowerCase()) ? m[1].toLowerCase() : 'do'
      ) as WorkflowStepKind;
      steps.push({ kind, text: clean(m[2], WORKFLOW_STEP_MAX_CHARS) });
      continue;
    }
    const step = steps[steps.length - 1];
    if (!step || !line.trim()) continue;
    const ref = /^\s+ref:\s*(.+)$/.exec(line);
    const show = /^\s+show:\s*(.+)$/.exec(line);
    if (ref) step.refs = [...(step.refs ?? []), clean(ref[1], WORKFLOW_REF_MAX_CHARS)];
    else if (show) step.show = clean(show[1], WORKFLOW_REF_MAX_CHARS);
    else if (/^\s+\S/.test(line)) {
      step.text = clean(`${step.text} ${line.trim()}`, WORKFLOW_STEP_MAX_CHARS);
    }
  }
  return {
    id,
    title: clean(title, WORKFLOW_TITLE_MAX_CHARS) || id,
    steps: steps.filter((s) => s.text),
  };
}

export function serializeWorkflow(workflow: Pick<Workflow, 'title' | 'steps'>): string {
  const out = ['---', `title: ${workflow.title}`, '---', ''];
  workflow.steps.forEach((step, n) => {
    out.push(`${n + 1}. [${step.kind}] ${step.text}`);
    for (const ref of step.refs ?? []) out.push(`   ref: ${ref}`);
    if (step.show) out.push(`   show: ${step.show}`);
  });
  out.push('');
  return out.join('\n');
}

/** A client-sent workflow, bounded and cleaned; null when it has no title or steps. */
export function sanitizeWorkflow(raw: unknown): Pick<Workflow, 'id' | 'title' | 'steps'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  const title = typeof w.title === 'string' ? clean(w.title, WORKFLOW_TITLE_MAX_CHARS) : '';
  if (!title || !Array.isArray(w.steps)) return null;
  const steps: WorkflowStep[] = [];
  for (const s of w.steps.slice(0, WORKFLOW_MAX_STEPS)) {
    if (!s || typeof s !== 'object') continue;
    const step = s as Record<string, unknown>;
    const text =
      typeof step.text === 'string'
        ? clean(step.text.replace(/\n/g, ' '), WORKFLOW_STEP_MAX_CHARS)
        : '';
    if (!text) continue;
    const kind = (
      typeof step.kind === 'string' && KINDS.has(step.kind) ? step.kind : 'do'
    ) as WorkflowStepKind;
    const refs = Array.isArray(step.refs)
      ? step.refs
          .filter((r): r is string => typeof r === 'string')
          .map((r) => clean(r.replace(/\n/g, ' '), WORKFLOW_REF_MAX_CHARS))
          .filter(Boolean)
          .slice(0, 8)
      : [];
    const show =
      typeof step.show === 'string'
        ? clean(step.show.replace(/\n/g, ' '), WORKFLOW_REF_MAX_CHARS)
        : '';
    steps.push({ kind, text, ...(refs.length ? { refs } : {}), ...(show ? { show } : {}) });
  }
  if (steps.length === 0) return null;
  const id = typeof w.id === 'string' && /^[a-z0-9-]{1,64}$/.test(w.id) ? w.id : '';
  return { id, title: title.replace(/\n/g, ' '), steps };
}
