import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { resolveChatImage, saveChatFile } from '../src/boardFiles.js';
import { createHttpServer } from '../src/httpServer.js';

let dir: string;
let prevHome: string | undefined;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-chatfiles-')));
  prevHome = process.env.HOME;
  process.env.HOME = dir;
});
afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

const filesDir = () => path.join(os.homedir(), '.pixel-agents', 'files');

describe('saveChatFile', () => {
  it('stores any type under ~/.pixel-agents/files with a safe, unique, space-free name', () => {
    const a = saveChatFile('../../my run.sh', Buffer.from('echo hi'));
    const b = saveChatFile('../../my run.sh', Buffer.from('echo bye'));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(path.dirname(a!)).toBe(filesDir());
    expect(path.basename(a!)).toMatch(/^chat_[0-9a-f]{32}-my_run\.sh$/);
    expect(fs.readFileSync(a!, 'utf-8')).toBe('echo hi');
    expect(fs.statSync(a!).mode & 0o777).toBe(0o600);
  });

  it('refuses empty files and names with nothing left', () => {
    expect(saveChatFile('notes.txt', Buffer.alloc(0))).toBeNull();
    expect(saveChatFile('', Buffer.from('x'))).toBeNull();
  });
});

describe('resolveChatImage', () => {
  it('serves only images stored directly in the uploads folder', () => {
    const img = saveChatFile('shot.png', Buffer.from('png'))!;
    const txt = saveChatFile('notes.txt', Buffer.from('t'))!;
    expect(resolveChatImage(path.basename(img))).toMatchObject({
      ok: true,
      contentType: 'image/png',
    });
    expect(resolveChatImage(path.basename(txt))).toMatchObject({ ok: false, status: 415 });
    expect(resolveChatImage('../shot.png')).toMatchObject({ ok: false, status: 404 });
    expect(resolveChatImage('missing.png')).toMatchObject({ ok: false, status: 404 });
  });

  it('does not follow an image-looking link out of the folder', () => {
    fs.mkdirSync(filesDir(), { recursive: true });
    fs.writeFileSync(path.join(dir, 'secret.png'), 'outside');
    fs.symlinkSync(path.join(dir, 'secret.png'), path.join(filesDir(), 'link.png'));
    expect(resolveChatImage('link.png')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('chat file route', () => {
  it('needs the token, stores the upload, and returns its path without pinning', async () => {
    const pins: unknown[] = [];
    const { app, port } = await createHttpServer({
      embedded: true,
      token: 'secret',
      store: new AgentStateStore(),
      getBoardPins: () => [],
      saveBoardPin: (p) => {
        pins.push(p);
        return true;
      },
    });
    const base = `http://127.0.0.1:${port}/api/files`;
    const post = (name: string, headers: Record<string, string>) =>
      fetch(`${base}?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body: 'data',
      });
    try {
      expect((await post('a.bin', {})).status).toBe(401);
      const ok = await post('..\\evil/report.bin', { Authorization: 'Bearer secret' });
      expect(ok.status).toBe(200);
      const { path: stored } = (await ok.json()) as { path: string };
      expect(path.dirname(stored)).toBe(filesDir());
      expect(stored.endsWith('-report.bin')).toBe(true);
      expect(fs.readFileSync(stored, 'utf-8')).toBe('data');
      expect(pins).toHaveLength(0);

      const img = await post('pic.png', { Authorization: 'Bearer secret' });
      const imgPath = ((await img.json()) as { path: string }).path;
      const url = `${base}/${encodeURIComponent(path.basename(imgPath))}`;
      expect((await fetch(url)).status).toBe(401);
      const got = await fetch(url, { headers: { Authorization: 'Bearer secret' } });
      expect(got.status).toBe(200);
      expect(got.headers.get('content-type')).toBe('image/png');
      expect(got.headers.get('x-content-type-options')).toBe('nosniff');
      const txt = `${base}/${encodeURIComponent(path.basename(stored))}`;
      expect((await fetch(txt, { headers: { Authorization: 'Bearer secret' } })).status).toBe(415);
    } finally {
      await app.close();
    }
  });
});
