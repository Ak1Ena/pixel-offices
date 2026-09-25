import { useEffect, useState } from 'react';

import type { WorkflowRun } from '../../../core/src/messages.js';
import { CHARACTER_SITTING_OFFSET_PX, WORKFLOW_BADGE_VERTICAL_OFFSET } from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { overlayProjection } from '../office/projection.js';
import { CharacterState } from '../office/types.js';
import { activeRun, runProgress } from '../workflows.js';

interface WorkflowBadgesProps {
  officeState: OfficeState;
  agents: number[];
  runs: WorkflowRun[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

/** Progress pips under each character working through a workflow: ▮▮▯ 2/3. */
export function WorkflowBadges({
  officeState,
  agents,
  runs,
  containerRef,
  zoom,
  panRef,
}: WorkflowBadgesProps) {
  const [, setTick] = useState(0);
  const working = agents.filter((id) => activeRun(runs, id));
  useEffect(() => {
    if (working.length === 0) return;
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [working.length]);

  const el = containerRef.current;
  if (!el || working.length === 0) return null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );
  return (
    <>
      {working.map((id) => {
        const ch = officeState.characters.get(id);
        const run = activeRun(runs, id);
        if (!ch || !run) return null;
        const p = runProgress(run);
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const at = project.toScreen(ch.x, ch.y, WORKFLOW_BADGE_VERTICAL_OFFSET - sittingOffset);
        return (
          <div
            key={id}
            className={`absolute z-35 -translate-x-1/2 flex items-center gap-2 px-3 py-1 bg-bg border ${
              p.waiting ? 'border-status-permission' : 'border-accent'
            } pointer-events-none`}
            style={{
              left: at.x,
              top: at.y,
            }}
            title={run.title}
            data-testid="workflow-badge"
          >
            {run.steps.map((s, i) => (
              <span
                key={i}
                className={`w-6 h-8 border ${
                  s.state === 'done' || s.state === 'skipped'
                    ? 'bg-status-success border-status-success'
                    : s.state === 'waiting'
                      ? 'bg-status-permission border-status-permission'
                      : 'bg-bg-thumb border-border'
                }`}
              />
            ))}
            <span className="ml-3 text-2xs text-text">
              {p.done}/{p.total}
            </span>
          </div>
        );
      })}
    </>
  );
}
