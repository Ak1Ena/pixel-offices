import type { AgentStateStore } from './agentStateStore.js';
import { TEXT_IDLE_CONTINUING_DELAY_MS } from './constants.js';
import { confidentChoice, type Decider, tailOf } from './decisions.js';
import { startWaitingTimer } from './timerManager.js';

/**
 * Hooks-off turn ends for text-only replies. The rule is a silence timer
 * (TEXT_IDLE_DELAY_MS): a clear final answer idles late, and "Let me look…"
 * followed by a long think idles early (false chime). With a decision model
 * the reply is read once while that timer runs: "finished" idles now,
 * "continuing" waits TEXT_IDLE_CONTINUING_DELAY_MS instead. Any new transcript
 * data cancels the timer as before, and the answer is then ignored.
 */

let decider: () => Decider | null = () => null;

export function setTextIdleDecider(source: () => Decider | null): void {
  decider = source;
}

export function judgeTextReply(
  agentId: number,
  text: string,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const model = decider();
  const timer = waitingTimers.get(agentId);
  if (!model || !timer || !text.trim()) return;
  void model
    .ask(
      { reply: tailOf(text) },
      {
        reply: {
          type: 'choice',
          instructions:
            "Is this coding agent's message its final reply for now, or does it announce work it is about to do?",
          criteria: {
            finished: 'answers the question, reports what was done, or asks the user something',
            continuing: 'says what it will do next, like "Let me check the tests first"',
          },
        },
      },
      { agentId, topic: 'Am I finished?' },
    )
    .then((answers) => {
      // New data cancelled or replaced the timer, or it already fired: the answer is stale.
      if (waitingTimers.get(agentId) !== timer) return;
      const verdict = confidentChoice(answers?.reply, 'textIdle');
      if (verdict === 'finished') startWaitingTimer(agentId, 0, agents, waitingTimers);
      else if (verdict === 'continuing') {
        startWaitingTimer(agentId, TEXT_IDLE_CONTINUING_DELAY_MS, agents, waitingTimers);
      }
    });
}
