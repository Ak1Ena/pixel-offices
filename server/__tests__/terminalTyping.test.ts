import { describe, expect, it } from 'vitest';

import { PROMPT_TYPING_CHUNK_CHARS } from '../src/constants.js';
import { promptKeystrokes, typePrompt } from '../src/terminalTyping.js';

describe('typing office messages into a terminal', () => {
  it('never sends a bracketed paste, so Claude reads it as typed', async () => {
    const written: string[] = [];
    await typePrompt((d) => written.push(d), 'run the tests please');
    const all = written.join('');
    expect(all).not.toContain('\x1b[200~');
    expect(all).toBe('run the tests please\r');
    expect(written.slice(0, -1).every((c) => c.length <= PROMPT_TYPING_CHUNK_CHARS)).toBe(true);
  });

  it("turns newlines into Claude Code's backslash-Enter continuation", () => {
    expect(promptKeystrokes('line one\r\nline two\nthree').join('')).toBe(
      'line one\\\rline two\\\rthree',
    );
  });

  it('drops control characters and never splits a surrogate pair', () => {
    expect(promptKeystrokes('a\u001b[201~b').join('')).toBe('a[201~b');
    const emoji = '😀'.repeat(PROMPT_TYPING_CHUNK_CHARS + 1);
    expect(promptKeystrokes(emoji).every((c) => !/[\ud800-\udbff]$/.test(c))).toBe(true);
  });

  it('sends nothing for an empty message, and stops when cancelled', async () => {
    const written: string[] = [];
    await typePrompt((d) => written.push(d), '   ');
    expect(written).toEqual([]);
    await typePrompt(
      (d) => written.push(d),
      'x'.repeat(40),
      () => written.length >= 2,
    );
    expect(written).toHaveLength(2);
  });
});
