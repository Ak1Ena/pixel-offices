import type { AgentRuntime } from './agentRuntime.js';
import { parseWorkflow } from './workflowFile.js';

/**
 * Workflow client messages, shared by both surfaces' dispatch (like the task
 * desk's). Every one needs a privileged connection: they start turns agents
 * spend tokens on, or change files in ~/.pixel-agents/workflows/.
 *
 * Returns true when `msg` was a workflow message.
 */
export function handleWorkflowMessage(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  runtime: AgentRuntime | undefined,
  privileged: boolean,
): boolean {
  const type = msg.type;
  if (
    type !== 'saveWorkflow' &&
    type !== 'deleteWorkflow' &&
    type !== 'attachWorkflow' &&
    type !== 'answerGate' &&
    type !== 'stopWorkflowRun' &&
    type !== 'importWorkflow'
  ) {
    return false;
  }
  const refuse = (error: string) => send({ type: 'workflowNotice', error });
  if (!runtime) {
    refuse('Workflows are not available here.');
    return true;
  }
  if (!privileged) {
    refuse('Open the office from your private link to use workflows.');
    return true;
  }
  switch (type) {
    case 'saveWorkflow': {
      const result = runtime.workflows.save(msg.workflow);
      if (!result.ok) refuse(result.error);
      break;
    }
    case 'deleteWorkflow':
      if (!runtime.workflows.remove(msg.workflowId)) refuse('No such workflow.');
      break;
    case 'attachWorkflow': {
      const result = runtime.attachWorkflow(msg.id, msg.workflowId);
      if (!result.ok) refuse(result.error);
      break;
    }
    case 'answerGate':
      if (!runtime.runs.answerGate(msg.runId, msg.step, msg.decision)) {
        refuse('That gate is no longer waiting.');
      }
      break;
    case 'stopWorkflowRun':
      runtime.runs.stop(msg.runId);
      break;
    case 'importWorkflow': {
      if (typeof msg.markdown !== 'string' || msg.markdown.length > 200_000) {
        refuse('That is not a workflow file.');
        break;
      }
      const parsed = parseWorkflow('', msg.markdown);
      const result = runtime.workflows.save({ ...parsed, id: '' });
      if (!result.ok) refuse(result.error);
      break;
    }
  }
  return true;
}
