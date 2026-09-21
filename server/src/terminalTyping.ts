import {
  PROMPT_SUBMIT_DELAY_MS,
  PROMPT_TYPING_CHUNK_CHARS,
  PROMPT_TYPING_CHUNK_DELAY_MS,
} from './constants.js';

/**
 * Typing an office chat message into Claude's prompt.
 *
 * It must arrive as TYPED input, never as a paste. Claude Code marks bracketed
 * pastes (and large bursts it detects as pastes) as pasted content, and the
 * model then treats the message as text someone pasted rather than a request
 * from the user — it answers "this is only pasted text" instead of acting. So
 * the text goes in as small keystroke chunks, and each newline as `\` + Enter,
 * Claude Code's line continuation, instead of a paste that keeps newlines.
 */

/** Control characters other than tab and newline: a message may not send keys of its own. */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** The keystroke chunks that type `text` (without the final Enter). */
export function promptKeystrokes(text: string): string[] {
  const body = text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS_RE, '')
    .trim()
    .split('\n')
    .join('\\\r');
  // Split on code points so no chunk ends inside a surrogate pair.
  const chars = Array.from(body);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += PROMPT_TYPING_CHUNK_CHARS) {
    chunks.push(chars.slice(i, i + PROMPT_TYPING_CHUNK_CHARS).join(''));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Type `text` through `write`, a few characters at a time, then press Enter.
 * `isCancelled` stops mid-message (the terminal went away).
 */
export async function typePrompt(
  write: (data: string) => void,
  text: string,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  const chunks = promptKeystrokes(text);
  if (chunks.length === 0) return;
  for (const chunk of chunks) {
    if (isCancelled()) return;
    write(chunk);
    await sleep(PROMPT_TYPING_CHUNK_DELAY_MS);
  }
  await sleep(PROMPT_SUBMIT_DELAY_MS);
  if (!isCancelled()) write('\r');
}
