import { describe, expect, it } from 'vitest';

import { pastedFileName, splitUploadMentions, uploadDisplayName } from '../src/chatFiles.js';
import { asFilePath, splitFilePaths } from '../src/fileLinks.js';

const dir = '/Users/me/.pixel-agents/files';

describe('files sent from the chat', () => {
  it('splits uploaded images and other files out of the message', () => {
    const r = splitUploadMentions(
      `@${dir}/chat_ab12-shot.png @${dir}/chat_cd34-report.docx\nplease check these`,
    );
    expect(r.images).toEqual(['chat_ab12-shot.png']);
    expect(r.files).toEqual(['chat_cd34-report.docx']);
    expect(r.text).toBe('please check these');
  });

  it('leaves other @paths alone', () => {
    const text = '@/Users/me/code/app/README.md and @~/docs/test.docx';
    expect(splitUploadMentions(text)).toEqual({ images: [], files: [], text });
  });

  it('shows the name the user picked', () => {
    expect(uploadDisplayName('chat_ab12cd-report_v2.docx')).toBe('report_v2.docx');
  });

  it('gives pasted screenshots their own names and keeps real file names', () => {
    const now = Date.UTC(2026, 8, 22, 13, 5, 7);
    expect(pastedFileName('image.png', 'image/png', now, 0)).toBe('pasted-2026-09-22T13-05-07.png');
    expect(pastedFileName('', 'image/jpeg', now, 1)).toBe('pasted-2026-09-22T13-05-07-1.jpg');
    expect(pastedFileName('notes.txt', 'text/plain', now, 0)).toBe('notes.txt');
  });
});

describe('file paths in chat text', () => {
  it('links absolute and home paths, with or without @', () => {
    expect(splitFilePaths('I made a copy called @~/docs/test.docx, see /tmp/a b.')).toEqual([
      { kind: 'text', text: 'I made a copy called ' },
      { kind: 'file', text: '@~/docs/test.docx', path: '~/docs/test.docx' },
      { kind: 'text', text: ', see /tmp/a b.' },
    ]);
    expect(splitFilePaths('(/Users/me/plan.pdf)')).toEqual([
      { kind: 'text', text: '(' },
      { kind: 'file', text: '/Users/me/plan.pdf', path: '/Users/me/plan.pdf' },
      { kind: 'text', text: ')' },
    ]);
  });

  it('leaves relative paths, urls and plain words alone', () => {
    for (const text of ['see src/app.ts', 'https://example.com/a.html', 'and/or', '1/2.5']) {
      expect(splitFilePaths(text)).toEqual([{ kind: 'text', text }]);
    }
  });

  it('reads a code span that is exactly a path', () => {
    expect(asFilePath('~/docs/test.docx')).toBe('~/docs/test.docx');
    expect(asFilePath('npm run build')).toBeNull();
  });
});
