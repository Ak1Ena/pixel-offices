import type { AgentRuntime } from './agentRuntime.js';

/**
 * Client messages for clearing agents' context, the per-agent settings
 * beside it (self-clear policy, document edit mode) and document edits. Both surfaces route through here. Every one is privileged: a
 * clear types into a terminal, and the settings decide what agents may do.
 *
 * Returns true when `msg` was one of these messages.
 */
export function handleContextClearMessage(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  runtime: AgentRuntime | undefined,
  privileged: boolean,
): boolean {
  const type = msg.type;
  if (
    type !== 'clearAgentContext' &&
    type !== 'answerClearRequest' &&
    type !== 'setAgentPrefs' &&
    type !== 'setDocEditDefault' &&
    type !== 'undoDocEdit'
  ) {
    return false;
  }
  if (!runtime || !privileged) return true;
  const clear = runtime.contextClear;
  switch (type) {
    case 'clearAgentContext': {
      const error = clear.clear(msg.id, msg.mode ?? 'clear');
      if (error && typeof msg.id === 'number') runtime.chatSender.notice(msg.id, error);
      break;
    }
    case 'answerClearRequest':
      clear.answer(msg.id, msg.allow);
      break;
    case 'setAgentPrefs':
      clear.setPrefs(msg.id, msg.clearPolicy, msg.docEditMode);
      break;
    case 'setDocEditDefault':
      runtime.docs.setDefaultMode(msg.mode);
      break;
    case 'undoDocEdit': {
      const result = runtime.docs.undo(msg.editId);
      if (!result.ok) send({ type: 'teamNotice', message: result.error, error: true });
      break;
    }
  }
  return true;
}
