import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BoardPin } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  deleteStoredUpload,
  isStoredUpload,
  removePinAndCopy,
  resolvePinFile,
  saveUploadedFile,
  uploadDir,
} from '../src/boardFiles.js';
import { createHttpServer } from '../src/httpServer.js';

let dir: string;
const pin = (id: string, value: string, kind: BoardPin['kind'] = 'file'): BoardPin => ({
  id,
  kind,
  title: id,
  value,
  scope: [],
  createdAt: 'now',
});

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-files-')));
  fs.writeFileSync(path.join(dir, 'plan.pdf'), '%PDF-1.4 test');
  fs.writeFileSync(path.join(dir, 'page.html'), '<script>1</script>');
  fs.writeFileSync(path.join(dir, 'secret.key'), 'k');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('resolvePinFile', () => {
  it('serves a pinned document with its type', () => {
    const r = resolvePinFile([pin('a', path.join(dir, 'plan.pdf'))], 'a');
    expect(r).toMatchObject({ ok: true, contentType: 'application/pdf' });
  });

  it('refuses anything that is not a pinned file of a viewable type', () => {
    const pins = [
      pin('html', path.join(dir, 'page.html')),
      pin('key', path.join(dir, 'secret.key')),
      pin('rel', 'docs/plan.pdf'),
      pin('gone', path.join(dir, 'missing.pdf')),
      pin('note', path.join(dir, 'plan.pdf'), 'note'),
    ];
    expect(resolvePinFile(pins, 'html')).toMatchObject({ ok: false, status: 415 });
    expect(resolvePinFile(pins, 'key')).toMatchObject({ ok: false, status: 415 });
    expect(resolvePinFile(pins, 'rel')).toMatchObject({ ok: false, status: 400 });
    expect(resolvePinFile(pins, 'gone')).toMatchObject({ ok: false, status: 404 });
    expect(resolvePinFile(pins, 'note')).toMatchObject({ ok: false, status: 404 });
    expect(resolvePinFile(pins, 'unknown')).toMatchObject({ ok: false, status: 404 });
  });

  it('does not follow a viewable-looking link to another type', () => {
    fs.symlinkSync(path.join(dir, 'secret.key'), path.join(dir, 'fake.pdf'));
    expect(resolvePinFile([pin('l', path.join(dir, 'fake.pdf'))], 'l')).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe('board file routes', () => {
  it('need the token, serve pinned files, and pin uploads', async () => {
    const pins: BoardPin[] = [pin('a', path.join(dir, 'plan.pdf'))];
    const prevHome = process.env.HOME;
    process.env.HOME = dir;
    const { app, port } = await createHttpServer({
      embedded: true,
      token: 'secret',
      store: new AgentStateStore(),
      getBoardPins: () => pins,
      saveBoardPin: (p) => {
        pins.push(p);
        return true;
      },
    });
    const base = `http://127.0.0.1:${port}/api/board/files`;
    const auth = { Authorization: 'Bearer secret' };
    try {
      expect((await fetch(`${base}/a`)).status).toBe(401);
      const ok = await fetch(`${base}/a`, { headers: auth });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('application/pdf');
      expect(await ok.text()).toBe('%PDF-1.4 test');

      const up = await fetch(`${base}?name=${encodeURIComponent('../../notes.txt')}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/octet-stream' },
        body: 'hello',
      });
      expect(up.status).toBe(200);
      const created = ((await up.json()) as { pin: BoardPin }).pin;
      expect(path.dirname(created.value)).toBe(path.join(os.homedir(), '.pixel-agents', 'files'));
      expect(fs.readFileSync(created.value, 'utf-8')).toBe('hello');

      const bad = await fetch(`${base}?name=run.exe`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/octet-stream' },
        body: 'x',
      });
      expect(bad.status).toBe(415);
    } finally {
      await app.close();
      process.env.HOME = prevHome;
    }
  });
});

describe('stored uploads: no duplicates, and only the office’s own copies are ever deleted', () => {
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    process.env.HOME = dir;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
  });

  function board(initial: BoardPin[]) {
    let pins = [...initial];
    return {
      getPins: () => pins,
      removePin: (id: unknown) => {
        const before = pins.length;
        pins = pins.filter((p) => p.id !== id);
        return pins.length < before;
      },
    };
  }

  it('the same file uploaded twice is stored once; a different file with that name is kept apart', () => {
    const a = saveUploadedFile('report.docx', Buffer.from('v1'), 'pin_a');
    const again = saveUploadedFile('report.docx', Buffer.from('v1'), 'pin_b');
    const changed = saveUploadedFile('report.docx', Buffer.from('v2'), 'pin_c');
    expect(again).toBe(a);
    expect(changed).not.toBe(a);
    expect(fs.readdirSync(uploadDir()).sort()).toEqual(['pin_a-report.docx', 'pin_c-report.docx']);
  });

  it('deletes a stored copy with its pin, once nothing else uses it', () => {
    const stored = saveUploadedFile('deck.pptx', Buffer.from('x'), 'pin_d')!;
    const b = board([pin('one', stored), pin('two', stored)]);
    expect(removePinAndCopy(b, 'one', true)).toEqual({ removed: true, deleted: false });
    expect(fs.existsSync(stored)).toBe(true);
    expect(removePinAndCopy(b, 'two', true)).toEqual({ removed: true, deleted: true });
    expect(fs.existsSync(stored)).toBe(false);
  });

  it('never deletes the user’s own file, a file linked in from elsewhere, or anything without deleteFile', () => {
    const own = path.join(dir, 'plan.pdf');
    expect(removePinAndCopy(board([pin('p', own)]), 'p', true)).toEqual({
      removed: true,
      deleted: false,
    });
    expect(fs.existsSync(own)).toBe(true);

    fs.mkdirSync(uploadDir(), { recursive: true });
    const planted = path.join(uploadDir(), 'pin_x-plan.pdf');
    fs.symlinkSync(own, planted);
    expect(isStoredUpload(planted)).toBe(false);
    expect(deleteStoredUpload(planted)).toBe(false);
    expect(fs.existsSync(own)).toBe(true);

    const stored = saveUploadedFile('notes.txt', Buffer.from('n'), 'pin_n')!;
    expect(removePinAndCopy(board([pin('n', stored)]), 'n', false)).toEqual({
      removed: true,
      deleted: false,
    });
    expect(fs.existsSync(stored)).toBe(true);
    expect(isStoredUpload('~/.pixel-agents/files/pin_n-notes.txt')).toBe(true);
  });
});
