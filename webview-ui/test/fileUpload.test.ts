import { describe, expect, it } from 'vitest';

import { pastedFiles, splitUploadMentions, uploadDisplayName } from '../src/fileUpload.js';

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
    const data = {
      files: [
        new File(['x'], 'image.png', { type: 'image/png' }),
        new File(['y'], 'notes.txt', { type: 'text/plain' }),
      ],
    } as unknown as DataTransfer;
    const names = pastedFiles(data, Date.UTC(2026, 8, 22, 13, 5, 7)).map((f) => f.name);
    expect(names).toEqual(['pasted-2026-09-22T13-05-07.png', 'notes.txt']);
    expect(pastedFiles(null)).toEqual([]);
  });
});
