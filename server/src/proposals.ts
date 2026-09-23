import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { DocEdit, DocEditPreview } from '../../core/src/docModel.js';
import type { DocPlaceRef, Proposal, ProposalHunk } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { backupName } from './backups.js';
import {
  LAYOUT_FILE_DIR,
  PROPOSAL_BACKUP_DIR,
  PROPOSAL_MAX_BYTES,
  PROPOSAL_MAX_OPEN,
  PROPOSAL_REASON_MAX_CHARS,
  SUGGESTIONS_FILE_NAME,
} from './constants.js';
import { guessAgent } from './focusRequests.js';
import type { Hunk } from './lineDiff.js';
import { applyHunks, diffLines, joinText, splitText, toHunks } from './lineDiff.js';
import { applyDocEdits, docKindOf } from './officeDocs.js';

/**
 * "Review changes": an agent suggests a new version of a file instead of
 * writing it (`pixel-office propose FILE --from NEWFILE`). The office diffs
 * the two into hunks; the user accepts or rejects each; Apply writes only the
 * accepted ones — after checking the file didn't change in the meantime, and
 * keeping a copy for Undo. The agent only ever sent two paths.
 */

/** Binary formats (Word, Excel, PDF, images) can't be merged line by line. */
const NOT_TEXT = new Set([
  '.docx',
  '.xlsx',
  '.pptx',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.zip',
]);

interface Entry {
  proposal: Proposal;
  hunks: Hunk[];
  proposedPath: string;
  baseHash: string;
  backupPath?: string;
  appliedHash?: string;
  /** A document suggestion (Word, PowerPoint, Excel): one edit per hunk, by position. */
  doc?: { edits: DocEdit[] };
}

export type ProposalResult =
  { state: 'applied' | 'discarded'; summary: string } | { state: 'pending' } | { state: 'gone' };

function sha(text: string | Buffer): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readBytes(filePath: string): Buffer | null {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function readText(filePath: string): string | null {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > PROPOSAL_MAX_BYTES) return null;
    const buf = fs.readFileSync(filePath);
    if (buf.includes(0)) return null; // binary
    return buf.toString('utf-8');
  } catch {
    return null;
  }
}

/** "Install steps (line 12)" — how a hunk is named to the agent. */
function hunkTitle(h: ProposalHunk): string {
  if (h.where) {
    const after = h.lines.find((l) => l.kind === 'add')?.text ?? '';
    const text = after.replace(/\s+/g, ' ').trim().slice(0, 50);
    return text ? `${h.where}: "${text}"` : `${h.where}: cleared`;
  }
  const changed = h.lines.find((l) => l.kind !== 'context');
  const text = (changed?.text ?? '').trim().slice(0, 50) || 'blank line';
  return `line ${h.oldStart}: "${text}"`;
}

/** ~/.pixel-agents/suggestions.json: open suggestions kept across restarts. */
export function suggestionsFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, SUGGESTIONS_FILE_NAME);
}

export class Proposals {
  private entries: Entry[] = [];
  private readonly waiters = new Map<string, Set<(r: ProposalResult) => void>>();
  private readonly results = new Map<string, ProposalResult>();

  constructor(
    private readonly store: AgentStateStore,
    /** Types the outcome to the agent when no `--wait` is there to take it. */
    private readonly deliver: (agentId: number, text: string) => void = () => {},
    private readonly backupDir: string = path.join(
      os.homedir(),
      LAYOUT_FILE_DIR,
      PROPOSAL_BACKUP_DIR,
    ),
    /** Where open suggestions are kept across restarts; absent = memory only. */
    private readonly persistPath?: string,
    /** A file was written (Apply / Undo): Files notes it, backups get pruned. */
    private readonly onWrite: (filePath: string) => void = () => {},
  ) {
    store.on('agentRemoved', this.onAgentRemoved);
    this.load();
  }

  /** Open suggestions saved by an earlier run (their agent ids may be stale: dropped). */
  private load(): void {
    if (!this.persistPath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8')) as { entries?: unknown };
      if (!Array.isArray(raw.entries)) return;
      for (const e of raw.entries as Entry[]) {
        if (!e?.proposal?.proposalId || e.proposal.state !== 'open' || !Array.isArray(e.hunks))
          continue;
        delete e.proposal.agentId; // agent ids mean nothing across runs
        this.entries.push(e);
      }
    } catch {
      /* none saved yet, or unreadable: start empty */
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    const open = this.entries.filter((e) => e.proposal.state === 'open');
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: open }), { mode: 0o600 });
      fs.renameSync(tmp, this.persistPath);
    } catch (err) {
      console.error('[Pixel Agents] Failed to save suggestions:', err);
    }
  }

  snapshot(): { type: 'proposals'; proposals: Proposal[] } {
    return { type: 'proposals', proposals: this.entries.map((e) => structuredClone(e.proposal)) };
  }

  open(raw: unknown): { ok: true; proposal: Proposal } | { ok: false; error: string } {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Expected a JSON object.' };
    const input = raw as Record<string, unknown>;
    if (typeof input.path !== 'string' || !path.isAbsolute(input.path))
      return { ok: false, error: 'path must be absolute.' };
    if (typeof input.from !== 'string' || !path.isAbsolute(input.from))
      return { ok: false, error: 'from must be absolute.' };
    const filePath = path.normalize(input.path);
    const proposedPath = path.normalize(input.from);
    if (NOT_TEXT.has(path.extname(filePath).toLowerCase())) {
      return {
        ok: false,
        error:
          'Only text files can be reviewed line by line. For Word, PowerPoint and Excel use `pixel-office doc edit`.',
      };
    }
    const exists = fs.existsSync(filePath);
    const original = exists ? readText(filePath) : '';
    if (original === null)
      return { ok: false, error: `Can't read ${filePath} as text (or it is over 1 MB).` };
    const proposed = readText(proposedPath);
    if (proposed === null)
      return { ok: false, error: `Can't read ${proposedPath} as text (or it is over 1 MB).` };
    const a = splitText(original);
    const b = splitText(proposed);
    const hunks = toHunks(diffLines(a.lines, b.lines));
    if (hunks.length === 0)
      return {
        ok: false,
        error: 'The suggested version is the same as the file. Nothing to review.',
      };

    const agentId = guessAgent(this.store.values(), {
      agent: typeof input.agent === 'string' ? input.agent : undefined,
      cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    });
    // One open suggestion per file: a newer one replaces it.
    for (const old of this.entries.filter(
      (e) => e.proposal.path === filePath && e.proposal.state === 'open',
    )) {
      this.finish(old, 'discarded', 'A newer suggestion for the same file replaced this one.');
    }
    const why =
      typeof input.why === 'string'
        ? input.why
            .replace(/[\x00-\x1f\x7f]/g, ' ')
            .trim()
            .slice(0, 280)
        : '';
    const proposal: Proposal = {
      proposalId: `p${crypto.randomBytes(4).toString('hex')}`,
      path: filePath,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(why ? { why } : {}),
      state: 'open',
      createdAt: new Date().toISOString(),
      hunks: hunks.map((h) => ({
        hunkId: h.hunkId,
        oldStart: h.oldStart,
        newStart: h.newStart,
        lines: h.lines,
        decision: 'pending',
      })),
    };
    this.entries.push({ proposal, hunks, proposedPath, baseHash: sha(original) });
    this.prune();
    this.broadcast();
    return { ok: true, proposal: structuredClone(proposal) };
  }

  /**
   * An agent's edits to a Word, PowerPoint or Excel file, waiting for review:
   * one hunk per edit showing what is there and what would replace it. The
   * edits are checked against the file now, so a suggestion that can't apply
   * is refused up front.
   */
  async openDoc(input: {
    path: string;
    edits: DocEdit[];
    why?: string;
    agentId?: number;
  }): Promise<{ ok: true; proposal: Proposal } | { ok: false; error: string }> {
    const filePath = path.normalize(input.path);
    const kind = docKindOf(filePath);
    if (!kind) return { ok: false, error: 'Not a Word, PowerPoint or Excel file.' };
    const current = readBytes(filePath);
    if (!current) return { ok: false, error: `Can't read ${filePath}.` };
    const checked = await applyDocEdits(current, kind, input.edits);
    if (!checked.ok) return { ok: false, error: checked.error };
    for (const old of this.entries.filter(
      (e) => e.proposal.path === filePath && e.proposal.state === 'open',
    )) {
      this.finish(old, 'discarded', 'A newer suggestion for the same file replaced this one.');
    }
    const why = (input.why ?? '')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .trim()
      .slice(0, 280);
    const proposal: Proposal = {
      proposalId: `p${crypto.randomBytes(4).toString('hex')}`,
      path: filePath,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(why ? { why } : {}),
      state: 'open',
      createdAt: new Date().toISOString(),
      hunks: docHunks(checked.previews),
    };
    this.entries.push({
      proposal,
      hunks: [],
      proposedPath: '',
      baseHash: sha(current),
      doc: { edits: input.edits },
    });
    this.prune();
    this.broadcast();
    return { ok: true, proposal: structuredClone(proposal) };
  }

  /** Apply — text or document suggestion. */
  async applyAny(
    proposalId: unknown,
  ): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
    const entry = this.find(proposalId);
    if (!entry?.doc) return this.apply(proposalId);
    if (entry.proposal.state !== 'open')
      return { ok: false, error: 'That suggestion is no longer open.' };
    const filePath = entry.proposal.path;
    const kind = docKindOf(filePath)!;
    const accepted = entry.proposal.hunks
      .map((h, i) => (h.decision === 'accepted' ? i : -1))
      .filter((i) => i >= 0);
    if (accepted.length === 0)
      return { ok: false, error: 'Accept at least one change, or discard the suggestion.' };
    const current = readBytes(filePath);
    if (!current) return { ok: false, error: `Can't read ${filePath} any more.` };
    if (sha(current) !== entry.baseHash) {
      // Show the edits again against the file as it is now, decisions reset.
      const again = await applyDocEdits(current, kind, entry.doc.edits);
      entry.baseHash = sha(current);
      if (!again.ok) {
        entry.proposal.note = `${path.basename(filePath)} changed since the suggestion and the edits no longer fit: ${again.error}`;
        this.broadcast();
        return { ok: false, error: entry.proposal.note };
      }
      entry.proposal.hunks = docHunks(again.previews);
      entry.proposal.note = `${path.basename(filePath)} changed since the suggestion. The changes are shown again against the file as it is now; review them again.`;
      this.broadcast();
      return { ok: false, error: entry.proposal.note };
    }
    const result = await applyDocEdits(
      current,
      kind,
      accepted.map((i) => entry.doc!.edits[i]),
    );
    if (!result.ok) return { ok: false, error: result.error };
    let backupPath: string;
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      backupPath = path.join(this.backupDir, backupName(filePath, entry.proposal.proposalId));
      fs.writeFileSync(backupPath, current, { mode: 0o600 });
      const mode = fs.statSync(filePath).mode;
      const tmp = `${filePath}.pixel-agents.tmp`;
      fs.writeFileSync(tmp, result.buffer, { mode });
      fs.renameSync(tmp, filePath);
    } catch (err) {
      return {
        ok: false,
        error: `Couldn't write ${filePath}: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`,
      };
    }
    entry.backupPath = backupPath;
    entry.appliedHash = sha(result.buffer);
    this.onWrite(filePath);
    const summary = this.summary(entry, 'applied');
    this.finish(
      entry,
      'applied',
      `Applied ${accepted.length} of ${entry.proposal.hunks.length} changes.`,
      summary,
    );
    return { ok: true, summary };
  }

  decide(proposalId: unknown, hunkId: unknown, decision: unknown, reason?: unknown): boolean {
    const entry = this.find(proposalId);
    if (!entry || entry.proposal.state !== 'open') return false;
    if (decision !== 'pending' && decision !== 'accepted' && decision !== 'rejected') return false;
    const targets =
      hunkId === '*'
        ? entry.proposal.hunks
        : entry.proposal.hunks.filter((h) => h.hunkId === hunkId);
    if (targets.length === 0) return false;
    const text =
      typeof reason === 'string'
        ? reason
            .replace(/[\x00-\x1f\x7f]/g, ' ')
            .trim()
            .slice(0, PROPOSAL_REASON_MAX_CHARS)
        : '';
    for (const h of targets) {
      h.decision = decision;
      if (decision === 'rejected' && text) h.reason = text;
      else if (decision !== 'rejected') delete h.reason;
    }
    delete entry.proposal.note;
    this.broadcast();
    return true;
  }

  /**
   * Write the accepted hunks. Refused when the file changed since the
   * suggestion: the hunks are then worked out again against the file as it is
   * now (decisions reset), so nothing stale is ever written.
   */
  apply(proposalId: unknown): { ok: true; summary: string } | { ok: false; error: string } {
    const entry = this.find(proposalId);
    if (!entry || entry.proposal.state !== 'open')
      return { ok: false, error: 'That suggestion is no longer open.' };
    const accepted = new Set(
      entry.proposal.hunks.filter((h) => h.decision === 'accepted').map((h) => h.hunkId),
    );
    if (accepted.size === 0)
      return { ok: false, error: 'Accept at least one change, or discard the suggestion.' };
    const filePath = entry.proposal.path;
    const current = fs.existsSync(filePath) ? readText(filePath) : '';
    if (current === null) return { ok: false, error: `Can't read ${filePath} any more.` };
    if (sha(current) !== entry.baseHash) {
      const proposed = readText(entry.proposedPath);
      if (proposed === null) {
        return {
          ok: false,
          error: 'The file changed since the suggestion, and the suggested version is gone.',
        };
      }
      entry.hunks = toHunks(diffLines(splitText(current).lines, splitText(proposed).lines));
      entry.baseHash = sha(current);
      entry.proposal.hunks = entry.hunks.map((h) => ({
        hunkId: h.hunkId,
        oldStart: h.oldStart,
        newStart: h.newStart,
        lines: h.lines,
        decision: 'pending',
      }));
      entry.proposal.note = `${path.basename(filePath)} changed since the suggestion. The changes are shown again against the file as it is now; review them again.`;
      this.broadcast();
      return { ok: false, error: entry.proposal.note };
    }
    const parts = splitText(current);
    const merged = joinText(
      applyHunks(parts.lines, entry.hunks, accepted),
      parts.eol,
      parts.finalEol || parts.lines.length === 0,
    );
    let backupPath: string | undefined;
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      if (fs.existsSync(filePath)) {
        backupPath = path.join(this.backupDir, backupName(filePath, entry.proposal.proposalId));
        fs.copyFileSync(filePath, backupPath);
      }
      const mode = fs.existsSync(filePath) ? fs.statSync(filePath).mode : undefined;
      const tmp = `${filePath}.pixel-agents.tmp`;
      fs.writeFileSync(tmp, merged, { encoding: 'utf-8', ...(mode !== undefined ? { mode } : {}) });
      fs.renameSync(tmp, filePath);
    } catch (err) {
      return {
        ok: false,
        error: `Couldn't write ${filePath}: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`,
      };
    }
    entry.backupPath = backupPath;
    entry.appliedHash = sha(merged);
    this.onWrite(filePath);
    const summary = this.summary(entry, 'applied');
    this.finish(
      entry,
      'applied',
      `Applied ${accepted.size} of ${entry.proposal.hunks.length} changes.`,
      summary,
    );
    return { ok: true, summary };
  }

  discard(proposalId: unknown): boolean {
    const entry = this.find(proposalId);
    if (!entry || entry.proposal.state !== 'open') return false;
    this.finish(
      entry,
      'discarded',
      'Discarded; nothing was written.',
      this.summary(entry, 'discarded'),
    );
    return true;
  }

  /** Put the file back as it was before Apply — only while nobody has changed it since. */
  undo(proposalId: unknown): { ok: true } | { ok: false; error: string } {
    const entry = this.find(proposalId);
    if (!entry || entry.proposal.state !== 'applied' || !entry.backupPath)
      return { ok: false, error: 'Nothing to undo.' };
    const current = entry.doc ? readBytes(entry.proposal.path) : readText(entry.proposal.path);
    if (current === null || sha(current) !== entry.appliedHash) {
      return {
        ok: false,
        error:
          'The file changed after Apply, so it was left alone. The old copy is in ~/.pixel-agents/backups/.',
      };
    }
    try {
      fs.copyFileSync(entry.backupPath, entry.proposal.path);
    } catch (err) {
      return {
        ok: false,
        error: `Couldn't restore: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    this.onWrite(entry.proposal.path);
    entry.proposal.state = 'open';
    entry.proposal.canUndo = false;
    entry.proposal.note = 'Undone: the file is back as it was. The suggestion is open again.';
    this.results.delete(entry.proposal.proposalId);
    this.broadcast();
    return { ok: true };
  }

  wait(proposalId: string, ms: number): Promise<ProposalResult> {
    const done = this.results.get(proposalId);
    if (done) return Promise.resolve(done);
    const entry = this.find(proposalId);
    if (!entry) return Promise.resolve({ state: 'gone' });
    return new Promise((resolve) => {
      const set = this.waiters.get(proposalId) ?? new Set();
      this.waiters.set(proposalId, set);
      const timer = setTimeout(() => {
        set.delete(waiter);
        resolve({ state: 'pending' });
      }, ms);
      timer.unref?.();
      const waiter = (r: ProposalResult) => {
        clearTimeout(timer);
        resolve(r);
      };
      set.add(waiter);
    });
  }

  dispose(): void {
    this.store.off('agentRemoved', this.onAgentRemoved);
    for (const set of this.waiters.values()) for (const w of set) w({ state: 'gone' });
    this.waiters.clear();
  }

  private readonly onAgentRemoved = (agentId: number): void => {
    let changed = false;
    for (const e of this.entries) {
      if (e.proposal.agentId === agentId && e.proposal.state === 'open') {
        delete e.proposal.agentId;
        changed = true;
      }
    }
    if (changed) this.broadcast();
  };

  /** What the agent is told: what landed, what didn't and why, what's undecided. */
  private summary(entry: Entry, state: 'applied' | 'discarded'): string {
    const hunks = entry.proposal.hunks;
    if (state === 'discarded')
      return `The user discarded your suggested changes to @${entry.proposal.path}. Nothing was written.`;
    const lines = [`Applied to @${entry.proposal.path}:`];
    for (const h of hunks) {
      if (h.decision === 'accepted') lines.push(`  ✓ ${hunkTitle(h)}`);
      else if (h.decision === 'rejected')
        lines.push(`  ✗ ${hunkTitle(h)}${h.reason ? ` — "${h.reason}"` : ''}`);
      else lines.push(`  … ${hunkTitle(h)} — not decided, not applied`);
    }
    return lines.join('\n');
  }

  private finish(
    entry: Entry,
    state: 'applied' | 'discarded',
    note: string,
    summary?: string,
  ): void {
    entry.proposal.state = state;
    entry.proposal.note = note;
    entry.proposal.canUndo = state === 'applied' && !!entry.backupPath;
    const result: ProposalResult = { state, summary: summary ?? note };
    this.results.set(entry.proposal.proposalId, result);
    const set = this.waiters.get(entry.proposal.proposalId);
    this.waiters.delete(entry.proposal.proposalId);
    if (set && set.size > 0) for (const w of set) w(result);
    else if (summary && entry.proposal.agentId !== undefined)
      this.deliver(entry.proposal.agentId, summary);
    this.broadcast();
  }

  private find(proposalId: unknown): Entry | undefined {
    return this.entries.find((e) => e.proposal.proposalId === proposalId);
  }

  private prune(): void {
    while (this.entries.length > PROPOSAL_MAX_OPEN) {
      const i = this.entries.findIndex((e) => e.proposal.state !== 'open');
      this.entries.splice(i === -1 ? 0 : i, 1);
    }
  }

  private broadcast(): void {
    this.save();
    this.store.broadcast(this.snapshot());
  }
}

/** Where an edit lands, for the viewer to show the suggestion in place. */
function placeOf(edit: DocEdit): DocPlaceRef {
  switch (edit.kind) {
    case 'para':
      return { para: edit.n };
    case 'insertAfter':
      return { insertAfter: edit.n };
    case 'shape':
      return { slide: edit.slide, shape: edit.shape };
    case 'cell':
      return { cell: edit.ref, ...(edit.sheet ? { sheet: edit.sheet } : {}) };
  }
}

/** One review hunk per document edit: what is there now, what would replace it. */
function docHunks(previews: DocEditPreview[]): ProposalHunk[] {
  return previews.map((p, i) => ({
    hunkId: `d${i + 1}`,
    oldStart: 0,
    newStart: 0,
    where: p.where,
    place: placeOf(p.edit),
    lines: [
      ...(p.before ? [{ kind: 'del' as const, text: p.before }] : []),
      ...(p.after ? [{ kind: 'add' as const, text: p.after }] : []),
    ],
    decision: 'pending' as const,
  }));
}
