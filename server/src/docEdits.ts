import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { DocEdit, DocEditPreview, DocModel } from '../../core/src/docModel.js';
import type { DocEditMode, DocEditNotice } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { getDocEditDefault, setDocEditDefault } from './configPersistence.js';
import {
  BOARD_FILE_MAX_BYTES,
  DOC_EDIT_CHANGE_MAX_CHARS,
  DOC_EDIT_TEXT_MAX_BYTES,
  DOC_EDITS_KEPT,
  DOC_EDITS_MAX_PER_CALL,
  LAYOUT_FILE_DIR,
  PROPOSAL_BACKUP_DIR,
} from './constants.js';
import { sessionMatches } from './contextClear.js';
import { guessAgent } from './focusRequests.js';
import { applyDocEdits, docKindOf, readDocModel } from './officeDocs.js';
import type { Proposals } from './proposals.js';

/**
 * Writing to office documents — Word, PowerPoint, Excel, and plain text.
 *
 * Two callers:
 *  - the human, from the document viewer (their own edit: written at once);
 *  - an agent, with `pixel-office doc edit` — what happens then is the
 *    human's call per agent (`docEditMode`, else the office default): `ask`
 *    turns the edits into a suggestion in Review changes, `auto` writes them
 *    at once, `off` refuses.
 *
 * Every write is the same: the file is read, checked against the version the
 * editor saw (sha256, when given), copied to ~/.pixel-agents/backups/, and
 * replaced atomically. Undo puts the copy back — only while the file still
 * holds exactly what was written. Edits name places (paragraph, slide shape,
 * cell); the rest of the file is left as it was (officeDocs.ts).
 */

export type DocEditResult =
  | { ok: true; notice: DocEditNotice; previews: DocEditPreview[]; sha: string }
  | { ok: false; status: 400 | 404 | 409 | 413 | 415; error: string };

/** What `pixel-office doc edit` gets back. */
export type AgentDocEditResult =
  | { ok: true; status: 'applied'; summary: string }
  | { ok: true; status: 'review'; proposalId: string }
  | { ok: false; status: 'refused' | 'invalid'; error: string };

interface EditRecord {
  notice: DocEditNotice;
  backupPath?: string;
  appliedHash: string;
}

export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** "¶3: Churn in the … → Enterprise churn …" */
export function changeLine(p: DocEditPreview): string {
  const clip = (t: string) => {
    const one = t.replace(/\s+/g, ' ').trim();
    return one.length > DOC_EDIT_CHANGE_MAX_CHARS
      ? `${one.slice(0, DOC_EDIT_CHANGE_MAX_CHARS - 1)}…`
      : one || '(empty)';
  };
  return `${p.where}: ${clip(p.before)} → ${clip(p.after)}`;
}

/** Only text a browser would never run is edited as text. */
const TEXT_EDITABLE = new Set([
  '.txt',
  '.md',
  '.csv',
  '.log',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
]);

export function isTextEditable(filePath: string): boolean {
  return TEXT_EDITABLE.has(path.extname(filePath).toLowerCase());
}

export class DocEdits {
  private readonly records: EditRecord[] = [];

  constructor(
    private readonly store: AgentStateStore,
    private readonly proposals: () => Proposals,
    private readonly backupDir: string = path.join(
      os.homedir(),
      LAYOUT_FILE_DIR,
      PROPOSAL_BACKUP_DIR,
    ),
    private readonly readDefault: () => DocEditMode = getDocEditDefault,
    private readonly writeDefault: (mode: DocEditMode) => void = setDocEditDefault,
  ) {}

  get defaultMode(): DocEditMode {
    return this.readDefault();
  }

  setDefaultMode(mode: unknown): void {
    if (mode !== 'ask' && mode !== 'auto' && mode !== 'off') return;
    this.writeDefault(mode);
    this.store.broadcast({ type: 'docEditDefault', mode });
  }

  snapshot(): { type: 'docEdits'; edits: DocEditNotice[] } {
    return { type: 'docEdits', edits: this.records.map((r) => ({ ...r.notice })) };
  }

  /** A document's numbered places, with the hash edits must be made against. */
  async model(
    filePath: string,
  ): Promise<{ ok: true; sha: string; model: DocModel } | { ok: false; error: string }> {
    const kind = docKindOf(filePath);
    if (!kind) return { ok: false, error: 'Only Word, PowerPoint and Excel files have places.' };
    try {
      const buf = fs.readFileSync(filePath);
      return { ok: true, sha: sha256(buf), model: await readDocModel(buf, kind) };
    } catch (err) {
      return { ok: false, error: `Can't read ${path.basename(filePath)}: ${message(err)}` };
    }
  }

  /**
   * Write `edits` to `filePath` now. `expectSha` (the version the editor saw)
   * refuses a file that changed in the meantime; absent, the edits are checked
   * against the file as it is.
   */
  async write(
    filePath: string,
    edits: DocEdit[],
    who: { label: string; agentId?: number },
    expectSha?: string,
  ): Promise<DocEditResult> {
    const kind = docKindOf(filePath);
    if (!kind) return { ok: false, status: 415, error: 'Not a Word, PowerPoint or Excel file.' };
    if (edits.length === 0) return { ok: false, status: 400, error: 'No edits.' };
    if (edits.length > DOC_EDITS_MAX_PER_CALL)
      return { ok: false, status: 400, error: `At most ${DOC_EDITS_MAX_PER_CALL} edits at once.` };
    let current: Buffer;
    try {
      current = fs.readFileSync(filePath);
    } catch {
      return { ok: false, status: 404, error: 'File not found on this computer.' };
    }
    if (current.length > BOARD_FILE_MAX_BYTES)
      return { ok: false, status: 413, error: 'File is too large to edit here.' };
    if (expectSha && sha256(current) !== expectSha) {
      return {
        ok: false,
        status: 409,
        error: `${path.basename(filePath)} changed since you opened it. Reload it and edit again.`,
      };
    }
    const result = await applyDocEdits(current, kind, edits);
    if (!result.ok) return { ok: false, status: 400, error: result.error };
    return this.commit(
      filePath,
      current,
      result.buffer,
      who,
      result.previews.map(changeLine),
      result.previews,
    );
  }

  /** The human saves a text file from the viewer (whole content). */
  writeText(
    filePath: string,
    text: unknown,
    who: { label: string },
    expectSha?: string,
  ): Promise<DocEditResult> {
    if (!isTextEditable(filePath))
      return Promise.resolve({
        ok: false,
        status: 415,
        error: 'This file cannot be edited as text here.',
      });
    if (typeof text !== 'string' || Buffer.byteLength(text) > DOC_EDIT_TEXT_MAX_BYTES)
      return Promise.resolve({ ok: false, status: 413, error: 'Text too large.' });
    let current: Buffer;
    try {
      current = fs.readFileSync(filePath);
    } catch {
      return Promise.resolve({ ok: false, status: 404, error: 'File not found on this computer.' });
    }
    if (expectSha && sha256(current) !== expectSha) {
      return Promise.resolve({
        ok: false,
        status: 409,
        error: `${path.basename(filePath)} changed since you opened it. Reload it and edit again.`,
      });
    }
    // Keep the file's line endings.
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    const next = Buffer.from(text.replace(/\r\n/g, '\n').replace(/\n/g, eol), 'utf-8');
    return Promise.resolve(this.commit(filePath, current, next, who, ['Text edited.'], []));
  }

  /** An agent's `pixel-office doc edit`. */
  async fromAgent(raw: unknown): Promise<AgentDocEditResult> {
    if (!raw || typeof raw !== 'object')
      return { ok: false, status: 'invalid', error: 'Expected a JSON object.' };
    const input = raw as Record<string, unknown>;
    if (typeof input.path !== 'string' || !path.isAbsolute(input.path))
      return { ok: false, status: 'invalid', error: 'path must be absolute.' };
    if (!Array.isArray(input.edits))
      return { ok: false, status: 'invalid', error: 'edits must be a list.' };
    const filePath = path.normalize(input.path);
    const agentId = this.agentFor(input);
    const agent = agentId !== undefined ? this.store.get(agentId) : undefined;
    const mode = agent?.docEditMode ?? this.defaultMode;
    if (mode === 'off') {
      return {
        ok: false,
        status: 'refused',
        error:
          'The human has not allowed document edits from this agent. Suggest the change in chat instead.',
      };
    }
    const edits = input.edits as DocEdit[];
    const why = typeof input.why === 'string' ? input.why : undefined;
    if (mode === 'auto') {
      const label =
        agent?.displayName ??
        agent?.agentName ??
        (agentId !== undefined ? `Agent #${agentId}` : 'An agent');
      const result = await this.write(filePath, edits, { label, agentId });
      if (!result.ok) return { ok: false, status: 'invalid', error: result.error };
      return {
        ok: true,
        status: 'applied',
        summary: [`Applied to @${filePath}:`, ...result.notice.changes.map((c) => `  ✓ ${c}`)].join(
          '\n',
        ),
      };
    }
    const opened = await this.proposals().openDoc({ path: filePath, edits, why, agentId });
    if (!opened.ok) return { ok: false, status: 'invalid', error: opened.error };
    return { ok: true, status: 'review', proposalId: opened.proposal.proposalId };
  }

  undo(editId: unknown): { ok: true } | { ok: false; error: string } {
    const record = this.records.find((r) => r.notice.editId === editId);
    if (!record || record.notice.undone || !record.backupPath)
      return { ok: false, error: 'Nothing to undo.' };
    let current: Buffer;
    try {
      current = fs.readFileSync(record.notice.path);
    } catch {
      return { ok: false, error: 'The file is gone.' };
    }
    if (sha256(current) !== record.appliedHash) {
      return {
        ok: false,
        error:
          'The file changed after this edit, so it was left alone. The old copy is in ~/.pixel-agents/backups/.',
      };
    }
    try {
      atomicWrite(record.notice.path, fs.readFileSync(record.backupPath));
    } catch (err) {
      return { ok: false, error: `Couldn't restore: ${message(err)}` };
    }
    record.notice.undone = true;
    record.notice.canUndo = false;
    this.publish();
    return { ok: true };
  }

  private commit(
    filePath: string,
    current: Buffer,
    next: Buffer,
    who: { label: string; agentId?: number },
    changes: string[],
    previews: DocEditPreview[],
  ): DocEditResult {
    const editId = `e${crypto.randomBytes(4).toString('hex')}`;
    let backupPath: string | undefined;
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      backupPath = path.join(this.backupDir, `${Date.now()}-${editId}-${path.basename(filePath)}`);
      fs.writeFileSync(backupPath, current, { mode: 0o600 });
      atomicWrite(filePath, next);
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: `Couldn't write ${path.basename(filePath)}: ${message(err)}. Nothing was changed.`,
      };
    }
    const notice: DocEditNotice = {
      editId,
      path: filePath,
      who: who.label,
      ...(who.agentId !== undefined ? { agentId: who.agentId } : {}),
      at: new Date().toISOString(),
      changes,
      canUndo: true,
      undone: false,
    };
    const appliedHash = sha256(next);
    this.records.push({ notice, backupPath, appliedHash });
    // Only the newest edit of a file can be undone: an older one's "after" is gone.
    for (const r of this.records) {
      if (r !== this.records[this.records.length - 1] && r.notice.path === filePath)
        r.notice.canUndo = false;
    }
    while (this.records.length > DOC_EDITS_KEPT) this.records.shift();
    this.publish();
    return { ok: true, notice: { ...notice }, previews, sha: appliedHash };
  }

  private agentFor(input: Record<string, unknown>): number | undefined {
    if (typeof input.session === 'string' && input.session) {
      for (const [id, agent] of this.store) if (sessionMatches(agent, input.session)) return id;
    }
    return guessAgent(this.store.values(), {
      agent: typeof input.agent === 'string' ? input.agent : undefined,
      cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    });
  }

  private publish(): void {
    this.store.broadcast(this.snapshot());
  }
}

/** Replace a file's content keeping its mode: tmp file beside it, then rename. */
export function atomicWrite(filePath: string, data: Buffer): void {
  const mode = fs.statSync(filePath).mode;
  const tmp = `${filePath}.pixel-agents.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, filePath);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
