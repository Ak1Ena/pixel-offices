import { describe, expect, it } from 'vitest';

import { addressedParts } from '../src/addressedParts.js';

const people = [
  { key: 'scout', aliases: ['scout'] },
  { key: 'asker', aliases: ['asker'] },
  { key: 'bob', aliases: ['Backend Bob', 'bob'] },
];
const parts = (text: string) => Object.fromEntries(addressedParts(text, people));

describe('which part of a reply is for whom', () => {
  it('gives each agent only the paragraph that opens with its name', () => {
    const reply = [
      '@asker — got your 10 questions. Stand by.',
      "I've paused step 2. @scout is still searching the codebase.",
      'How do you want to continue?',
      '@scout: look in client/mac-bgc-individual-client too.',
    ].join('\n\n');
    expect(parts(reply)).toEqual({
      asker: '@asker — got your 10 questions. Stand by.',
      scout: '@scout: look in client/mac-bgc-individual-client too.',
    });
  });

  it('ignores passing mentions', () => {
    expect(parts('The build is green; @scout is still searching.')).toEqual({});
    expect(parts('I will wait until @asker replies with the answers.')).toEqual({});
  });

  it('takes a short greeting, several names, markup and spaced names', () => {
    expect(Object.keys(parts('Thanks, @scout and @asker: split it.'))).toEqual(['scout', 'asker']);
    expect(Object.keys(parts('**@asker** please check'))).toEqual(['asker']);
    expect(Object.keys(parts('- @Backend Bob, add the route'))).toEqual(['bob']);
  });

  it('keeps a list or code that follows the addressed paragraph', () => {
    const reply = [
      '@scout check these:',
      'Look at the upload flow first.',
      '@asker ask about months',
      '- which months?\n- which bank?',
      '```\nnpm test\n\nnpm run e2e\n```',
      'Meanwhile, what do you think?',
    ].join('\n\n');
    expect(parts(reply)).toEqual({
      scout: '@scout check these:\n\nLook at the upload flow first.',
      asker:
        '@asker ask about months\n\n- which months?\n- which bank?\n\n```\nnpm test\n\nnpm run e2e\n```',
    });
  });
});
