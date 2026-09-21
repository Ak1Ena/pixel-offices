import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BoardPin } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { parseBoardArgs, runBoardCommand } from '../src/boardCli.js';
import { BoardStore, pinFromInput } from '../src/boardStore.js';
import { BOARD_CLI_COMMAND } from '../src/constants.js';
import { createHttpServer } from '../src/httpServer.js';
import type { ServerConfig } from '../src/serverConfig.js';

let dir: string;
let boardFile: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-boardcli-')));
  boardFile = path.join(dir, 'board.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (t: string) => lines.push(t),
    err: (t: string) => errors.push(t),
  };
}

/** A real HTTP server backed by a BoardStore on the temp board file. */
async function startOffice(agents: Record<string, number> = {}) {
  const board = new BoardStore(() => {}, boardFile);
  const { app, port } = await createHttpServer({
    embedded: true,
    token: 'secret',
    store: new AgentStateStore(),
    getBoardPins: () => board.getPins(),
    saveBoardPin: (pin) => board.savePin(pin),
    removeBoardPin: (id) => board.removePin(id),
    resolveBoardAgent: (name) => agents[name],
  });
  const server: ServerConfig = {
    port,
    pid: process.pid,
    token: 'secret',
    startedAt: Date.now(),
    servesSpa: false,
    protocol: 1,
  } as ServerConfig;
  return {
    board,
    server,
    base: `http://127.0.0.1:${port}/api/board/pins`,
    close: async () => {
      board.dispose();
      await app.close();
    },
  };
}

describe('pinFromInput', () => {
  it('mints id and createdAt, defaults the title, prefixes the author', () => {
    const r = pinFromInput({ kind: 'note', value: 'ship it\nmore', author: 'Codex' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pin.id).toMatch(/^pin_[0-9a-f]{32}$/);
    expect(r.pin.title).toBe('Codex: ship it');
    expect(r.pin.scope).toEqual([]);
    expect(Date.parse(r.pin.createdAt)).not.toBeNaN();
  });

  it('ignores a caller-supplied id', () => {
    const r = pinFromInput({ id: 'mine', kind: 'link', value: 'https://x.dev' });
    expect(r.ok && r.pin.id).not.toBe('mine');
    expect(r.ok && r.pin.title).toBe('https://x.dev');
  });

  it('resolves scope names and rejects unknown ones', () => {
    const resolve = (name: string) => (name === 'Pat' ? 7 : undefined);
    const ok = pinFromInput({ kind: 'note', value: 'x', scope: ['Pat', 3] }, resolve);
    expect(ok.ok && ok.pin.scope).toEqual([7, 3]);
    const bad = pinFromInput({ kind: 'note', value: 'x', scope: ['Nobody'] }, resolve);
    expect(bad).toMatchObject({ ok: false });
  });

  it('rejects bad kinds and values', () => {
    expect(pinFromInput({ kind: 'script', value: 'x' }).ok).toBe(false);
    expect(pinFromInput({ kind: 'note' }).ok).toBe(false);
    expect(pinFromInput({ kind: 'note', value: 'x'.repeat(9000) }).ok).toBe(false);
    expect(pinFromInput(null).ok).toBe(false);
  });
});

describe('board pin routes', () => {
  it('need the token, refuse browsers, and list/add/remove pins', async () => {
    const office = await startOffice({ Pat: 4 });
    const auth = { Authorization: 'Bearer secret' };
    try {
      expect((await fetch(office.base)).status).toBe(401);
      expect(
        (await fetch(office.base, { headers: { ...auth, Origin: 'http://evil.test' } })).status,
      ).toBe(403);

      const post = await fetch(office.base, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'note', value: 'use cents', title: 'Money', scope: ['Pat'] }),
      });
      expect(post.status).toBe(200);
      const pin = ((await post.json()) as { pin: BoardPin }).pin;
      expect(pin).toMatchObject({ kind: 'note', title: 'Money', scope: [4] });

      const bad = await fetch(office.base, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'nope', value: 'x' }),
      });
      expect(bad.status).toBe(400);

      const list = (await (await fetch(office.base, { headers: auth })).json()) as {
        pins: BoardPin[];
      };
      expect(list.pins.map((p) => p.id)).toEqual([pin.id]);

      const del = await fetch(`${office.base}/${pin.id}`, { method: 'DELETE', headers: auth });
      expect(del.status).toBe(200);
      const again = await fetch(`${office.base}/${pin.id}`, { method: 'DELETE', headers: auth });
      expect(again.status).toBe(404);
      expect(office.board.getPins()).toEqual([]);
    } finally {
      await office.close();
    }
  });
});

describe('parseBoardArgs', () => {
  it('parses add flags and resolves --file to an absolute path', () => {
    expect(parseBoardArgs(['add', '--file', 'docs/plan.pdf', '--for', 'Pat'], '/work')).toEqual({
      cmd: 'add',
      input: {
        kind: 'file',
        value: path.resolve('/work', 'docs/plan.pdf'),
        title: undefined,
        author: undefined,
        for: ['Pat'],
      },
    });
    expect(parseBoardArgs(['add', '--snippet', '--title', 'T'])).toMatchObject({
      cmd: 'add',
      input: { kind: 'snippet', value: undefined, title: 'T' },
    });
    expect(parseBoardArgs(['rm', 'pin_1'])).toEqual({ cmd: 'rm', id: 'pin_1' });
    expect(parseBoardArgs(['list', '--json'])).toEqual({ cmd: 'list', json: true });
  });

  it('rejects incomplete or conflicting input', () => {
    expect(() => parseBoardArgs(['add'])).toThrow();
    expect(() => parseBoardArgs(['add', '--note'])).toThrow();
    expect(() => parseBoardArgs(['add', '--note', 'a', '--link', 'b'])).toThrow();
    expect(() => parseBoardArgs(['add', '--note', 'a', '--bogus'])).toThrow();
    expect(() => parseBoardArgs(['rm'])).toThrow();
    expect(() => parseBoardArgs(['frobnicate'])).toThrow();
  });
});

describe('runBoardCommand', () => {
  it('goes through a live office when one answers', async () => {
    const office = await startOffice({ Pat: 4 });
    try {
      const io = capture();
      const code = await runBoardCommand(['add', '--note', 'hello', '--for', 'Pat'], {
        servers: [office.server],
        boardFile,
        ...io,
      });
      expect(code).toBe(0);
      expect(office.board.getPins()).toMatchObject([{ value: 'hello', scope: [4] }]);

      const list = capture();
      expect(await runBoardCommand(['list', '--json'], { servers: [office.server], ...list })).toBe(
        0,
      );
      const listed = JSON.parse(list.lines[0]) as BoardPin[];
      expect(listed).toHaveLength(1);

      const rm = capture();
      expect(await runBoardCommand(['rm', listed[0].id], { servers: [office.server], ...rm })).toBe(
        0,
      );
      expect(office.board.getPins()).toEqual([]);

      const unknown = capture();
      expect(
        await runBoardCommand(['add', '--note', 'x', '--for', 'Nobody'], {
          servers: [office.server],
          ...unknown,
        }),
      ).toBe(1);
      expect(unknown.errors[0]).toContain('Nobody');
    } finally {
      await office.close();
    }
  });

  it('writes board.json directly when no office is running', async () => {
    const io = capture();
    const code = await runBoardCommand(['add', '--snippet', '--title', 'Query'], {
      servers: [],
      boardFile,
      readStdin: async () => 'SELECT 1;',
      ...io,
    });
    expect(code).toBe(0);
    const saved = JSON.parse(fs.readFileSync(boardFile, 'utf-8')) as { pins: BoardPin[] };
    expect(saved.pins).toMatchObject([{ kind: 'snippet', title: 'Query', value: 'SELECT 1;' }]);

    const index = fs.readFileSync(path.join(dir, 'board.md'), 'utf-8');
    expect(index).toContain(`${BOARD_CLI_COMMAND} add --note`);
    expect(index).toContain(`- id: ${saved.pins[0].id}`);

    const rm = capture();
    expect(await runBoardCommand(['rm', saved.pins[0].id], { servers: [], boardFile, ...rm })).toBe(
      0,
    );
    const missing = capture();
    expect(await runBoardCommand(['rm', 'pin_gone'], { servers: [], boardFile, ...missing })).toBe(
      1,
    );

    // --for needs live agents to resolve names.
    const scoped = capture();
    expect(
      await runBoardCommand(['add', '--note', 'x', '--for', 'Pat'], {
        servers: [],
        boardFile,
        ...scoped,
      }),
    ).toBe(1);
  });

  it('skips a server that does not have the route', async () => {
    const { app, port } = await createHttpServer({
      embedded: true,
      token: 'secret',
      store: new AgentStateStore(),
    });
    try {
      const io = capture();
      const server = { port, pid: process.pid, token: 'secret' } as ServerConfig;
      expect(
        await runBoardCommand(['add', '--note', 'fallback'], {
          servers: [server],
          boardFile,
          ...io,
        }),
      ).toBe(0);
      const saved = JSON.parse(fs.readFileSync(boardFile, 'utf-8')) as { pins: BoardPin[] };
      expect(saved.pins).toMatchObject([{ value: 'fallback' }]);
    } finally {
      await app.close();
    }
  });
});

describe('pin detail', () => {
  it('keeps a trimmed detail and drops an empty one', () => {
    const r = pinFromInput({ kind: 'link', value: 'https://x.dev', detail: '  API docs  ' });
    expect(r.ok && r.pin.detail).toBe('API docs');
    const empty = pinFromInput({ kind: 'link', value: 'https://x.dev', detail: '   ' });
    expect(empty.ok && 'detail' in empty.pin).toBe(false);
  });

  it('parses board detail <id> "text"', () => {
    expect(parseBoardArgs(['detail', 'pin_1', 'why it matters'])).toEqual({
      cmd: 'detail',
      id: 'pin_1',
      detail: 'why it matters',
    });
    expect(() => parseBoardArgs(['detail', 'pin_1'])).toThrow();
  });

  it('sets and clears a detail over HTTP', async () => {
    const office = await startOffice();
    try {
      const auth = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
      const added = await fetch(office.base, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ kind: 'note', value: 'ship friday' }),
      }).then((r) => r.json() as Promise<{ pin: BoardPin }>);
      const url = `${office.base}/${added.pin.id}`;
      const set = await fetch(url, {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ detail: 'QA signs off thursday' }),
      });
      expect(set.status).toBe(200);
      expect(office.board.getPins()[0].detail).toBe('QA signs off thursday');
      await fetch(url, { method: 'PATCH', headers: auth, body: JSON.stringify({ detail: '' }) });
      expect(office.board.getPins()[0].detail).toBeUndefined();
      const missing = await fetch(`${office.base}/pin_nope`, {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ detail: 'x' }),
      });
      expect(missing.status).toBe(404);
    } finally {
      await office.close();
    }
  });
});
