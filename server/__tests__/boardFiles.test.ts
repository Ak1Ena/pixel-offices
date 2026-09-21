import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BoardPin } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { resolvePinFile } from '../src/boardFiles.js';
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

      const bad = await fetch(`${base}?name=run.sh`, {
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
