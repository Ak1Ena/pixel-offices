import { describe, expect, it } from 'vitest';

import { looksLikeQuestion } from '../src/officeSessions.js';

describe('questions on an office-run agent screen', () => {
  it('spots a numbered choice, with or without a cursor mark', () => {
    expect(
      looksLikeQuestion([
        'Do you trust the files in this folder?',
        '❯ 1. Yes, proceed',
        '  2. No, exit',
      ]),
    ).toBe(true);
    expect(looksLikeQuestion(['Allow Bash?', ' 1) Yes', ' 2) No'])).toBe(true);
  });

  it('sees through the box Claude draws around its dialogs', () => {
    expect(
      looksLikeQuestion([
        '╭──────────────────────────────────────────────╮',
        '│ Do you trust the files in this folder?       │',
        '│                                              │',
        '│ ❯ 1. Yes, proceed                            │',
        '│   2. No, exit                                │',
        '│                                              │',
        '│ Enter to confirm · Esc to exit               │',
        '╰──────────────────────────────────────────────╯',
      ]),
    ).toBe(true);
    expect(
      looksLikeQuestion([
        '│ Bash command │',
        '│ Do you want to proceed? │',
        '│ ❯ 1. Yes │',
        '│ Esc to cancel │',
      ]),
    ).toBe(true);
  });

  it('ignores ordinary output', () => {
    expect(looksLikeQuestion(['Welcome to Claude Code', '> '])).toBe(false);
    expect(looksLikeQuestion(['Steps:', '1. read the file'])).toBe(false);
    expect(looksLikeQuestion([])).toBe(false);
  });
});
