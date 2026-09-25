import { useEffect, useState } from 'react';

import { agentColor, agentStatus, STATUS_CHIP } from '../agentStatus.js';
import type { SubagentCharacter } from '../hooks/useExtensionMessages.js';
import { getActivityText } from '../office/activityText.js';
import type { OfficeState } from '../office/engine/officeState.js';
import type { ToolActivity } from '../office/types.js';

interface OfficeRosterProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentCharacters: SubagentCharacter[];
  labelOf: (id: number) => string;
  onOpen: (id: number) => void;
}

/** "In the office": everyone here, what they're doing, click to open their chat. */
export function OfficeRoster({
  officeState,
  agents,
  agentTools,
  subagentCharacters,
  labelOf,
  onOpen,
}: OfficeRosterProps) {
  const [, setTick] = useState(0);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => (n + 1) % 1_000_000), 400);
    return () => clearInterval(t);
  }, []);

  const rows = agents.flatMap((id) => [
    { id, sub: false, parent: null as number | null, label: '' },
    ...subagentCharacters
      .filter((s) => s.parentAgentId === id)
      .map((s) => ({ id: s.id, sub: true, parent: id, label: s.label })),
  ]);
  const working = agents.filter((id) => officeState.characters.get(id)?.isActive).length;

  return (
    <section
      className="absolute top-12 left-12 z-20 w-280 max-h-[48%] flex flex-col pixel-panel overflow-hidden"
      aria-label="In the office"
      data-testid="office-roster"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between gap-8 px-14 pt-12 pb-10 bg-transparent border-0 cursor-pointer text-left"
        aria-expanded={open}
      >
        <span className="font-display text-lg font-medium text-text">In the office</span>
        <span className="text-2xs text-text-muted">
          {agents.length} agents · {working} working
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-6 pb-8 overflow-y-auto">
          {rows.length === 0 && (
            <p className="m-0 px-8 pb-6 text-2xs text-text-muted">
              Nobody here yet. + Agent starts one.
            </p>
          )}
          {rows.map(({ id, sub, parent, label }) => {
            const ch = officeState.characters.get(id);
            if (!ch) return null;
            const st = agentStatus(officeState, id, agentTools);
            const name = sub ? label || 'Sub-agent' : labelOf(id);
            const activity = sub
              ? (ch.currentTool ?? 'Subtask')
              : getActivityText(
                  id,
                  agentTools,
                  ch.isActive,
                  ch.bubbleType,
                  !!ch.waitingAwaitingInput,
                );
            return (
              <button
                key={id}
                type="button"
                onClick={() => onOpen(parent ?? id)}
                className={`grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-10 py-6 pr-8 rounded-ui border border-transparent bg-transparent cursor-pointer text-left hover:bg-btn-bg ${
                  sub ? 'pl-24' : 'pl-8'
                } ${officeState.selectedAgentId === id ? 'bg-btn-bg border-border' : ''}`}
                data-testid="roster-row"
              >
                <span
                  className="w-28 h-28 rounded-ui grid place-items-center text-sm font-semibold text-white"
                  style={{ background: agentColor(officeState, id) }}
                  aria-hidden="true"
                >
                  {name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex flex-col">
                  <span className="text-sm font-semibold text-text truncate">{name}</span>
                  <span className="text-2xs text-text-muted font-mono truncate">{activity}</span>
                </span>
                <span
                  className={`text-2xs font-semibold px-8 py-2 rounded-full whitespace-nowrap ${STATUS_CHIP[st.cls]}`}
                >
                  {st.text}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
