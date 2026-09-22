import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Workflow } from '../../core/src/messages.js';
import {
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  WORKFLOW_DIR_NAME,
  WORKFLOW_MAX_WORKFLOWS,
} from './constants.js';
import { parseWorkflow, sanitizeWorkflow, serializeWorkflow, slugify } from './workflowFile.js';

/**
 * Saved workflows: ~/.pixel-agents/workflows/<id>.md, one plain markdown file
 * each. The FILE is the record — an agent reads it with its own tools, and a
 * person may edit it anywhere; the office polls the folder and picks those
 * edits up like any other change.
 */

function workflowDir(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, WORKFLOW_DIR_NAME);
}

export class WorkflowStore {
  private workflows: Workflow[] = [];
  private loaded = false;
  /** name:mtime:size of every file, so a poll only re-reads after a change. */
  private signature = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onChange: (workflows: Workflow[]) => void,
    private readonly dir: string = workflowDir(),
  ) {}

  list(): Workflow[] {
    this.ensureLoaded();
    return structuredClone(this.workflows);
  }

  get(id: unknown): Workflow | undefined {
    this.ensureLoaded();
    const found = this.workflows.find((w) => w.id === id);
    return found ? structuredClone(found) : undefined;
  }

  /** Create (empty id) or replace. Returns the saved workflow, or an error. */
  save(raw: unknown): { ok: true; workflow: Workflow } | { ok: false; error: string } {
    this.ensureLoaded();
    const input = sanitizeWorkflow(raw);
    if (!input) return { ok: false, error: 'A workflow needs a title and at least one step.' };
    let id = input.id;
    if (!id || !this.workflows.some((w) => w.id === id)) {
      if (this.workflows.length >= WORKFLOW_MAX_WORKFLOWS) {
        return {
          ok: false,
          error: `The office keeps at most ${WORKFLOW_MAX_WORKFLOWS} workflows.`,
        };
      }
      const base = slugify(input.title);
      id = base;
      for (let n = 2; this.workflows.some((w) => w.id === id); n++) id = `${base}-${n}`;
    }
    const filePath = path.join(this.dir, `${id}.md`);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, serializeWorkflow(input), 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch (err) {
      console.error('[Pixel Agents] Failed to write workflow:', err);
      return { ok: false, error: 'Could not save the workflow file.' };
    }
    this.readFromDisk();
    this.onChange(this.list());
    const saved = this.get(id);
    return saved
      ? { ok: true, workflow: saved }
      : { ok: false, error: 'Could not read the workflow back.' };
  }

  remove(id: unknown): boolean {
    this.ensureLoaded();
    const found = this.workflows.find((w) => w.id === id);
    if (!found?.path) return false;
    try {
      fs.unlinkSync(found.path);
    } catch {
      return false;
    }
    this.readFromDisk();
    this.onChange(this.list());
    return true;
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.readFromDisk();
    this.pollTimer = setInterval(() => {
      if (this.readFromDisk()) this.onChange(this.list());
    }, LAYOUT_FILE_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  /** Re-read the folder. True when anything in it changed. */
  private readFromDisk(): boolean {
    let names: string[];
    try {
      names = fs
        .readdirSync(this.dir)
        .filter((n) => /^[a-z0-9-]{1,64}\.md$/.test(n))
        .sort()
        .slice(0, WORKFLOW_MAX_WORKFLOWS);
    } catch {
      names = [];
    }
    const stats = names.map((name) => {
      try {
        const st = fs.statSync(path.join(this.dir, name));
        return `${name}:${st.mtimeMs}:${st.size}`;
      } catch {
        return `${name}:gone`;
      }
    });
    const signature = stats.join('|');
    if (signature === this.signature) return false;
    this.signature = signature;
    const workflows: Workflow[] = [];
    for (const name of names) {
      const filePath = path.join(this.dir, name);
      try {
        const workflow = parseWorkflow(name.slice(0, -3), fs.readFileSync(filePath, 'utf-8'));
        workflows.push({ ...workflow, path: filePath });
      } catch {
        /* unreadable file: skipped until it changes */
      }
    }
    this.workflows = workflows;
    return true;
  }
}
