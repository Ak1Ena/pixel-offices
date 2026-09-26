import type { AgentRuntime } from './agentRuntime.js';
import { suggestForCard } from './cardRouting.js';
import { isLayaModelSetting } from './configPersistence.js';
import { ModelCatalog } from './modelOptions.js';

/**
 * Client messages for the decision model: the office's own Laya
 * (layaManager.ts — turn on, which downloads it the first time, turn off,
 * pick the language, uninstall) and asking it about a card being written
 * (cardRouting.ts). Both surfaces route through here. Privileged: turning it
 * on downloads and runs software on this machine.
 *
 * Returns true when `msg` was one of these messages.
 */
export function handleLayaMessage(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  runtime: AgentRuntime | undefined,
  privileged: boolean,
): boolean {
  const type = msg.type;
  if (
    type !== 'setLayaEnabled' &&
    type !== 'setLayaModel' &&
    type !== 'uninstallLaya' &&
    type !== 'suggestDeskCard' &&
    type !== 'setAutopilot'
  ) {
    return false;
  }
  if (!runtime || !privileged) return true;
  switch (type) {
    case 'setLayaEnabled':
      if (typeof msg.enabled === 'boolean') runtime.laya.setEnabled(msg.enabled);
      break;
    case 'setLayaModel':
      if (isLayaModelSetting(msg.model)) runtime.laya.setModel(msg.model);
      break;
    case 'uninstallLaya':
      void runtime.laya.uninstall();
      break;
    case 'suggestDeskCard':
      void suggestDeskCard(msg, send, runtime);
      break;
    case 'setAutopilot': {
      const { type: _type, ...change } = msg;
      runtime.desk.autopilot?.configure(change);
      void runtime.desk.tick();
      break;
    }
  }
  return true;
}

async function suggestDeskCard(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  runtime: AgentRuntime,
): Promise<void> {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
  const reply = (fields: Record<string, unknown>) =>
    send({ type: 'deskCardSuggestion', requestId, ...fields });
  const title = typeof msg.title === 'string' ? msg.title.trim() : '';
  if (!title) {
    reply({ error: 'Write a title first.' });
    return;
  }
  const decider = runtime.decisions;
  if (!decider) {
    reply({ error: 'Turn on the decision model in Settings → Decision model (Laya) first.' });
    return;
  }
  const pick = await suggestForCard(
    decider,
    {
      title,
      body: typeof msg.body === 'string' ? msg.body : '',
      ...(typeof msg.kind === 'string' ? { kind: msg.kind } : {}),
    },
    {
      teams: runtime.teams.list(),
      workflows: runtime.workflows.list(),
      models: new ModelCatalog().get('claude'),
    },
  );
  if (!pick) {
    reply({ error: 'The decision model could not answer. Is it running?' });
    return;
  }
  // null ("no team", …) goes out as '' — the protocol has no nulls.
  reply({
    ...(pick.teamId !== undefined ? { teamId: pick.teamId ?? '' } : {}),
    ...(pick.workflowId !== undefined ? { workflowId: pick.workflowId ?? '' } : {}),
    ...(pick.model !== undefined ? { model: pick.model ?? '' } : {}),
    confidence: pick.confidence,
  });
}
