import { useState } from 'react';

import type { DeskColumnDef, DeskTaskState } from '../../../core/src/messages.js';
import { STATE_LABEL } from '../taskDesk.js';
import { Button } from './ui/Button.js';

const PHASES: DeskTaskState[] = ['inbox', 'looking', 'brief', 'ready', 'working', 'result', 'done'];

const field = 'bg-bg-dark text-text border border-border rounded-ui px-6 py-2 text-sm';

/**
 * Edit the board's columns (server: deskFlow.ts). A column splits one card
 * state; its description is what Laya reads to move cards into it after an
 * agent's turn. Moves between states stay with the desk's own rules.
 */
export function DeskFlowEditor({
  columns,
  onSave,
  onClose,
}: {
  columns: DeskColumnDef[];
  onSave: (columns: DeskColumnDef[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<DeskColumnDef[]>(columns);
  const change = (i: number, patch: Partial<DeskColumnDef>) =>
    setDraft((d) => d.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const move = (i: number, by: -1 | 1) =>
    setDraft((d) => {
      const j = i + by;
      if (j < 0 || j >= d.length) return d;
      const next = [...d];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-bg/80 p-16 overflow-y-auto"
      onKeyDown={(e) => e.stopPropagation()}
      data-testid="desk-flow-editor"
    >
      <div className="pixel-panel w-full max-w-720 flex flex-col gap-10 p-14">
        <div className="flex items-center justify-between">
          <span className="font-display text-lg">Board columns</span>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            ×
          </Button>
        </div>
        <span className="text-2xs text-text-muted">
          Split a card state into your own columns, e.g. Working → Coding, Testing, Blocked on API.
          A card changing state lands in that state's first column. Inside a state you drag cards
          between columns — and Laya moves them after each agent turn into columns where &quot;Laya
          may move cards here&quot; is on, going by the description. Write the description as what a
          card in that column looks like.
        </span>
        {draft.length === 0 && (
          <span className="text-sm text-text-muted">No columns yet: one column per state.</span>
        )}
        {draft.map((c, i) => (
          <div
            key={`${c.id}-${i}`}
            className="flex flex-col gap-6 p-10 border border-border rounded-ui"
          >
            <div className="flex items-center gap-6 flex-wrap">
              <input
                className={`${field} flex-1 min-w-120`}
                value={c.name}
                placeholder="Column name"
                aria-label="Column name"
                onChange={(e) => change(i, { name: e.target.value })}
              />
              <select
                className={field}
                value={c.phase}
                aria-label="State it splits"
                onChange={(e) => change(i, { phase: e.target.value as DeskTaskState })}
              >
                {PHASES.map((p) => (
                  <option key={p} value={p}>
                    in {STATE_LABEL[p]}
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={() => move(i, -1)} aria-label="Move up">
                ↑
              </Button>
              <Button size="sm" onClick={() => move(i, 1)} aria-label="Move down">
                ↓
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraft((d) => d.filter((_, n) => n !== i))}
              >
                Remove
              </Button>
            </div>
            <textarea
              className={`${field} resize-y`}
              rows={2}
              value={c.description}
              placeholder="What a card here looks like, e.g. “the agent is running or fixing tests”"
              aria-label="Column description"
              onChange={(e) => change(i, { description: e.target.value })}
            />
            <label className="flex items-center gap-6 text-sm">
              <input
                type="checkbox"
                checked={c.laya}
                onChange={(e) => change(i, { laya: e.target.checked })}
              />
              Laya may move cards here
            </label>
          </div>
        ))}
        <div className="flex gap-6 justify-between flex-wrap">
          <Button
            size="sm"
            onClick={() =>
              setDraft((d) => [
                ...d,
                { id: '', name: '', description: '', phase: 'working', laya: true },
              ])
            }
            data-testid="desk-flow-add"
          >
            + Column
          </Button>
          <div className="flex gap-6">
            <Button size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="accent"
              onClick={() => {
                onSave(draft.filter((c) => c.name.trim()));
                onClose();
              }}
              data-testid="desk-flow-save"
            >
              Save columns
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
