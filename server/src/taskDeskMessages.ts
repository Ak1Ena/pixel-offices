import type { DeskHumanAction, DeskSubtask } from '../../core/src/messages.js';
import { TASK_NO_SUCH_CARD_ERROR } from './constants.js';
import type { DeskReply, TaskDesk } from './taskDesk.js';

/**
 * The task desk's client messages. Both surfaces route through here (the
 * standalone handler and the VS Code panel each have their own dispatch), so
 * the privilege rule is written once: every desk message changes what agents
 * will spend tokens on, so every one needs a privileged connection.
 *
 * Returns true when `msg` was a task desk message.
 */
export function handleTaskDeskMessage(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  desk: TaskDesk | undefined,
  privileged: boolean,
): boolean {
  const type = msg.type;
  if (
    type !== 'saveDeskTask' &&
    type !== 'removeDeskTask' &&
    type !== 'deskTaskAction' &&
    type !== 'setDeskTaskAllow' &&
    type !== 'editDeskSteps' &&
    type !== 'answerDeskGate' &&
    type !== 'setAgentPickup'
  ) {
    return false;
  }
  const taskId = typeof msg.taskId === 'string' ? msg.taskId : undefined;
  const refuse = (error: string) =>
    send({ type: 'taskDeskNotice', error, ...(taskId ? { taskId } : {}) });
  const report = (reply: DeskReply<unknown>) => {
    if (!reply.ok) refuse(reply.error);
  };

  if (!desk) {
    refuse('The task desk is not available here.');
    return true;
  }
  if (!privileged) {
    refuse('Open the office from your private link to use the task desk.');
    return true;
  }

  switch (type) {
    case 'saveDeskTask':
      void desk
        .saveTask({
          taskId: msg.taskId,
          kind: msg.kind,
          title: msg.title,
          body: msg.body,
          priority: msg.priority,
          folder: msg.folder,
          draft: msg.draft,
          teamId: msg.teamId,
          workflowId: msg.workflowId,
          model: msg.model,
          attachments: msg.attachments,
        })
        .then(report);
      break;
    case 'removeDeskTask':
      if (!desk.removeTask(msg.taskId)) refuse(TASK_NO_SUCH_CARD_ERROR);
      break;
    case 'deskTaskAction':
      report(
        desk.humanCall(msg.taskId, {
          action: msg.action as DeskHumanAction,
          note: typeof msg.note === 'string' ? msg.note : undefined,
          answers: Array.isArray(msg.answers) ? (msg.answers as string[]) : undefined,
          subtasks: Array.isArray(msg.subtasks) ? (msg.subtasks as DeskSubtask[]) : undefined,
        }),
      );
      break;
    case 'editDeskSteps':
      report(desk.editSteps(msg.taskId, msg.steps));
      break;
    case 'answerDeskGate':
      report(desk.answerGate(msg.taskId, msg.step, msg.decision, msg.note));
      break;
    case 'setDeskTaskAllow':
      report(desk.setAllow(msg.taskId, msg.allow));
      break;
    case 'setAgentPickup':
      desk.setPickup(msg.id, msg.enabled);
      break;
  }
  return true;
}
