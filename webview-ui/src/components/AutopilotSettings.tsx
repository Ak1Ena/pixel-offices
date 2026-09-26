import { useEffect, useState } from 'react';

import type { AutopilotState, LayaStatus } from '../../../core/src/messages.js';
import { decisionModelReady } from '../hooks/useLayaStatus.js';
import { transport } from '../transport/index.js';
import { Checkbox } from './ui/Checkbox.js';

const field = 'bg-bg-dark text-text border border-border rounded-ui px-4 w-64';

/**
 * Settings → Autopilot (server: deskAutopilot.ts). The desk then routes,
 * staffs and starts cards by itself; questions, risky plans and results
 * stay with the human.
 */
export function AutopilotSettings({
  state,
  laya,
}: {
  state: AutopilotState;
  laya: LayaStatus | null | undefined;
}) {
  const [command, setCommand] = useState(state.command);
  useEffect(() => setCommand(state.command), [state.command]);
  const send = (change: Record<string, unknown>) =>
    transport.send({ type: 'setAutopilot', ...change });
  const layaOn = decisionModelReady(laya ?? null);

  return (
    <div
      className="mt-4 pt-8 pb-6 px-10 border-t border-border flex flex-col gap-6"
      data-testid="settings-autopilot"
    >
      <div className="text-base">Autopilot</div>
      <Checkbox
        label="Let the desk run cards by itself"
        checked={state.enabled}
        onChange={() => send({ enabled: !state.enabled })}
      />
      <Checkbox
        label="Small questions: the agent chooses (Laya decides which are small)"
        checked={state.agentAnswers}
        onChange={() => send({ agentAnswers: !state.agentAnswers })}
      />
      <Checkbox
        label="Routine go-ahead steps pass by themselves (Laya decides)"
        checked={state.passGates}
        onChange={() => send({ passGates: !state.passGates })}
      />
      <span className="text-2xs text-text-muted">
        New cards get a team, workflow and model
        {layaOn
          ? ' chosen by Laya'
          : ' (turn on Laya above to have them chosen; otherwise one agent)'}
        . A plan that is not high risk is built at once; questions only you can answer and risky
        plans wait for you. Agents work on a branch of their own and run the tests; a result with
        failing or missing tests goes back to the agent (twice at most) before it reaches you.
        {state.canStartAgents
          ? ' A card nobody in its folder can take gets an agent started for it, and agents autopilot started are closed when idle.'
          : ' This window cannot start agents (standalone office only), so cards wait for agents you start.'}{' '}
        Permission prompts and accepting results stay with you. Every agent spends tokens.
      </span>
      {state.canStartAgents && (
        <>
          <label className="flex items-center gap-8 text-sm">
            At most
            <input
              type="number"
              min={1}
              className={field}
              value={state.maxAgents}
              onChange={(e) => send({ maxAgents: Number(e.target.value) })}
              aria-label="Most agents autopilot runs"
            />
            agents of its own ({state.running} running)
          </label>
          <label className="flex items-center gap-8 text-sm">
            Close its agents after
            <input
              type="number"
              min={1}
              className={field}
              value={state.idleMinutes}
              onChange={(e) => send({ idleMinutes: Number(e.target.value) })}
              aria-label="Idle minutes before closing"
            />
            idle minutes
          </label>
          <label className="flex items-center gap-8 text-sm">
            Start with
            <input
              className={`${field} w-auto flex-1`}
              value={command}
              spellCheck={false}
              onChange={(e) => setCommand(e.target.value)}
              onBlur={() => command.trim() && send({ command })}
              aria-label="Command autopilot starts agents with"
            />
          </label>
        </>
      )}
    </div>
  );
}
