import type { ChatEntry } from '../../../../../core/src/messages.js';

/**
 * agy's transcript (`transcriptPath` in every hook payload:
 * ~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript_full.jsonl)
 * as office chat. One JSON step per line:
 *
 * - `USER_INPUT` (source `USER_EXPLICIT`): the prompt, wrapped in
 *   `<USER_REQUEST>` with harness metadata after it — only the request shows.
 * - `PLANNER_RESPONSE`: the model's text (`content`) and/or `tool_calls`,
 *   each shown as a tool row.
 * - `GENERIC`: a tool's result; it marks the rows of the step before done.
 * - Everything else (system messages, thinking) is not chat.
 */

interface AgyStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: unknown;
  tool_calls?: Array<{ name?: unknown; args?: unknown }>;
}

const REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;

export function agyPromptText(content: string): string {
  const request = REQUEST_RE.exec(content);
  return (request ? request[1] : content).trim();
}

export function createAgyChatReader(
  formatToolStatus: (toolName: string, input?: unknown) => string,
): (line: string) => { entries: ChatEntry[]; doneToolIds: string[] } {
  let open: string[] = [];
  return (line) => {
    const out = { entries: [] as ChatEntry[], doneToolIds: [] as string[] };
    let step: AgyStep;
    try {
      step = JSON.parse(line) as AgyStep;
    } catch {
      return out;
    }
    if (typeof step.step_index !== 'number') return out;
    const id = `agy-${step.step_index}`;
    const timestamp = typeof step.created_at === 'string' ? step.created_at : undefined;
    const text = typeof step.content === 'string' ? step.content : '';

    if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT') {
      const prompt = agyPromptText(text);
      if (prompt) out.entries.push({ entryId: id, role: 'user', text: prompt, timestamp });
      return out;
    }
    if (step.type === 'PLANNER_RESPONSE') {
      out.doneToolIds.push(...open);
      open = [];
      if (text.trim()) out.entries.push({ entryId: id, role: 'assistant', text, timestamp });
      (Array.isArray(step.tool_calls) ? step.tool_calls : []).forEach((call, i) => {
        const name = typeof call?.name === 'string' ? call.name : 'tool';
        const toolId = `${id}-t${i}`;
        out.entries.push({
          entryId: toolId,
          role: 'tool',
          text: formatToolStatus(name, call?.args),
          timestamp,
        });
        open.push(toolId);
      });
      return out;
    }
    if (step.type === 'GENERIC' && step.status === 'DONE') {
      out.doneToolIds.push(...open);
      open = [];
    }
    return out;
  };
}
