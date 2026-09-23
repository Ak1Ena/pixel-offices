import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  looksLikeQuestion,
  parseScreenQuestion,
  resolveProjectFolder,
} from '../src/officeSessions.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

describe('questions on an office-run agent screen', () => {
  it('spots a numbered choice, with or without a cursor mark', () => {
    expect(
      looksLikeQuestion([
        'Do you trust the files in this folder?',
        '❯ 1. Yes, proceed',
        '  2. No, exit',
      ]),
    ).toBe(true);
    expect(looksLikeQuestion(['Allow Bash?', '❯ 1) Yes', ' 2) No'])).toBe(true);
    expect(looksLikeQuestion(['Allow Bash?', ' 1) Yes', ' 2) No', ' Esc to cancel'])).toBe(true);
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

  it('does not take a numbered list in the agent reply for a question', () => {
    const reply = [
      '⏺ There are three changes, all by author "Claude", in chapter 1:',
      '',
      '  1. Added text in the paragraph: now ends with a new sentence.',
      '  2. Deleted text in section 1.1: a word is removed.',
      '  3. Added text in the same spot: replaces the deleted word.',
      '',
      '  When you open the file in Word, the Review tab shows the changes.',
      '',
      '╭──────────────────────────────────────────────╮',
      '│ >                                            │',
      '╰──────────────────────────────────────────────╯',
      '  ? for shortcuts',
    ];
    expect(looksLikeQuestion(reply)).toBe(false);
    expect(parseScreenQuestion(reply)).toBeNull();
  });
});

describe('reading the question off the screen', () => {
  const trust = [
    '╭──────────────────────────────────────────────╮',
    '│ Do you trust the files in this folder?       │',
    '│                                              │',
    '│ /Users/me/code/billing-api                   │',
    '│                                              │',
    '│ ❯ 1. Yes, proceed                            │',
    '│   2. No, exit                                │',
    '│                                              │',
    '│ Enter to confirm · Esc to exit               │',
    '╰──────────────────────────────────────────────╯',
  ];

  it('reads the prompt and options inside the box', () => {
    const q = parseScreenQuestion(trust);
    expect(q?.prompt).toEqual([
      'Do you trust the files in this folder?',
      '/Users/me/code/billing-api',
    ]);
    expect(q?.options).toEqual([
      { number: 1, label: 'Yes, proceed' },
      { number: 2, label: 'No, exit' },
    ]);
    expect(q?.selected).toBe(0);
  });

  it('knows where the cursor is', () => {
    const q = parseScreenQuestion(['Allow?', '  1. Yes', '❯ 2. No']);
    expect(q?.selected).toBe(1);
  });

  it('joins a wrapped option label and stops at the hint line', () => {
    const q = parseScreenQuestion([
      '│ Do you want to proceed? │',
      '│ ❯ 1. Yes │',
      "│   2. Yes, and don't ask again for npm run build commands in │",
      '│      /Users/me/code/app │',
      '│   3. No, and tell Claude what to do differently (esc) │',
      '│ Esc to cancel │',
    ]);
    expect(q?.options.map((o) => o.label)).toEqual([
      'Yes',
      "Yes, and don't ask again for npm run build commands in /Users/me/code/app",
      'No, and tell Claude what to do differently (esc)',
    ]);
  });

  it('takes the options at the bottom, not a numbered list earlier on screen', () => {
    const q = parseScreenQuestion([
      'Plan:',
      '1. read the file',
      '2. fix the bug',
      '────────────────',
      'Run this command?',
      '❯ 1. Yes',
      '  2. No',
    ]);
    expect(q?.prompt).toEqual(['Run this command?']);
    expect(q?.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  it('names each question by its text, so a changed question gets a new key', () => {
    const a = parseScreenQuestion(trust);
    const b = parseScreenQuestion(trust.map((l) => l.replace('billing-api', 'other-api')));
    expect(a?.key).toBe(parseScreenQuestion([...trust])?.key);
    expect(a?.key).not.toBe(b?.key);
  });

  it('reads the unnumbered folder-trust menu of current Claude', () => {
    const q = parseScreenQuestion([
      '─'.repeat(100),
      ' Accessing workspace:',
      '',
      ' /Users/me/code/billing-api',
      '',
      " Claude Code'll be able to read, edit, and execute files here.",
      '',
      ' Security guide',
      '',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      '',
      ' Enter to confirm · Esc to cancel',
    ]);
    expect(q?.prompt[0]).toBe('Accessing workspace:');
    expect(q?.options).toEqual([
      { number: 1, label: 'No, exit' },
      { number: 2, label: 'Yes, I trust this folder' },
    ]);
    expect(q?.selected).toBe(0);
  });

  it('does not take a lone cursor line for a menu', () => {
    expect(parseScreenQuestion([' ❯ just one line', '', ' Enter to confirm'])).toBeNull();
    expect(parseScreenQuestion(['> ', '? for shortcuts'])).toBeNull();
  });

  it('returns null when nothing is being asked', () => {
    expect(parseScreenQuestion(['Welcome to Claude Code', '> '])).toBeNull();
  });
});

describe('the folder an office-run agent starts in', () => {
  it('drops the trailing slash of ~/ so the transcript folder matches Claude', () => {
    const home = fs.realpathSync(os.homedir());
    expect(resolveProjectFolder('~/')).toBe(home);
    expect(resolveProjectFolder('~')).toBe(home);
    expect(resolveProjectFolder(`${home}/`)).toBe(home);
  });

  it('resolves symlinks, as the pty process.cwd() does', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-folder-'));
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link);
    try {
      expect(resolveProjectFolder(link)).toBe(fs.realpathSync(dir));
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('refuses relative paths, missing folders and files', () => {
    expect(resolveProjectFolder('code/app')).toBeNull();
    expect(resolveProjectFolder('/no/such/folder/anywhere')).toBeNull();
    expect(resolveProjectFolder(fs.realpathSync(__filename))).toBeNull();
  });

  it('finds the same Claude project folder with or without a trailing slash', () => {
    const home = os.homedir();
    expect(claudeProvider.getSessionDirs?.(`${home}/`)).toEqual(
      claudeProvider.getSessionDirs?.(home),
    );
  });
});
