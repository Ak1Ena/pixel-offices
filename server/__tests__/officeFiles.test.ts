import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BoardPin } from '../../core/src/messages.js';
import type { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { backupName, clearBackups, listBackups, pruneBackups } from '../src/backups.js';
import { saveUploadedFile } from '../src/boardFiles.js';
import { handleOfficeFileMessage } from '../src/officeFileMessages.js';
import { OfficeFiles } from '../src/officeFiles.js';
import { Proposals } from '../src/proposals.js';
import { makeDocx } from './helpers/officeFixtures.js';

let dir: string;
let prevHome: string | undefined;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-officefiles-')));
  prevHome = process.env.HOME;
  process.env.HOME = dir;
});
afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  let pins: BoardPin[] = [];
  let changes = 0;
  const files = new OfficeFiles(
    () => changes++,
    () => pins,
    path.join(dir, '.pixel-agents', 'files.json'),
  );
  const board = {
    getPins: () => pins,
    savePin: (pin: BoardPin) => {
      pins = [...pins, pin];
      return true;
    },
    removePin: (id: unknown) => {
      const before = pins.length;
      pins = pins.filter((p) => p.id !== id);
      return pins.length < before;
    },
  };
  const sent: Array<Record<string, unknown>> = [];
  let published = 0;
  const runtime = {
    files,
    board,
    publishFiles: () => published++,
  } as unknown as AgentRuntime;
  const send = (m: Record<string, unknown>) => void sent.push(m);
  const doc = path.join(dir, 'report.docx');
  fs.writeFileSync(doc, 'x');
  return {
    files,
    board,
    runtime,
    sent,
    send,
    doc,
    pins: () => pins,
    changes: () => changes,
    published: () => published,
  };
}

describe('Files: the documents the office opened', () => {
  it('opening a file lists it (newest first) and never pins it', () => {
    const t = setup();
    const other = path.join(dir, 'deck.pptx');
    fs.writeFileSync(other, 'yy');
    const a = t.files.open(t.doc);
    const b = t.files.open(other);
    if (!a.ok || !b.ok) throw new Error('open failed');
    expect(t.files.list().map((f) => f.name)).toEqual(['deck.pptx', 'report.docx']);
    const again = t.files.open(t.doc);
    expect(again).toMatchObject({ ok: true, fileId: a.fileId }); // same id, back on top
    expect(t.files.list()[0]).toMatchObject({
      name: 'report.docx',
      source: 'disk',
      size: 1,
      pinned: false,
    });
    expect(t.pins()).toEqual([]);
    expect(t.files.pathOf(a.fileId)).toBe(t.doc);
  });

  it('refuses what the viewer cannot open, missing files and relative paths', () => {
    const t = setup();
    fs.writeFileSync(path.join(dir, 'run.sh.exe'), 'x');
    expect(t.files.open(path.join(dir, 'run.sh.exe'))).toMatchObject({ ok: false });
    expect(t.files.open(path.join(dir, 'nope.docx'))).toMatchObject({ ok: false });
    expect(t.files.open('report.docx')).toMatchObject({ ok: false });
    expect(t.files.open('~/report.docx')).toMatchObject({ ok: true }); // ~ is this HOME
  });

  it('keeps the list across restarts, drops junk, and marks files that went missing', () => {
    const t = setup();
    const opened = t.files.open(t.doc);
    if (!opened.ok) throw new Error('open failed');
    t.files.markEdited(t.doc);
    const reg = path.join(dir, '.pixel-agents', 'files.json');
    const saved = JSON.parse(fs.readFileSync(reg, 'utf-8'));
    saved.files.push({ fileId: 'bad', path: 'relative' }, { fileId: 'f000000000000', path: '/x' });
    fs.writeFileSync(reg, JSON.stringify(saved));
    const again = new OfficeFiles(
      () => {},
      () => [],
      reg,
    );
    expect(again.list().map((f) => f.fileId)).toEqual([opened.fileId]);
    expect(again.list()[0].editedAt).toBeDefined();
    fs.unlinkSync(t.doc);
    expect(again.list()[0].missing).toBe(true);
  });

  it('pinned follows the whiteboard, and uploads are marked as copies', () => {
    const t = setup();
    const up = saveUploadedFile('budget.xlsx', Buffer.from('b'), 'pin_up1')!;
    const opened = t.files.open(up);
    if (!opened.ok) throw new Error('open failed');
    expect(t.files.list()[0]).toMatchObject({ source: 'upload', name: 'budget.xlsx' });
    t.board.savePin({ id: 'p1', kind: 'file', title: 'b', value: up, scope: [], createdAt: '' });
    expect(t.files.list()[0].pinned).toBe(true);
  });
});

describe('Files messages', () => {
  it('open replies with the id to view; pin / unpin go through the whiteboard', () => {
    const t = setup();
    handleOfficeFileMessage({ type: 'openOfficeFile', path: t.doc }, t.send, t.runtime, true);
    const reply = t.sent[0] as { type: string; fileId: string; path: string };
    expect(reply).toMatchObject({ type: 'fileOpened', path: t.doc });
    handleOfficeFileMessage(
      { type: 'pinOfficeFile', fileId: reply.fileId, pinned: true },
      t.send,
      t.runtime,
      true,
    );
    handleOfficeFileMessage(
      { type: 'pinOfficeFile', fileId: reply.fileId, pinned: true },
      t.send,
      t.runtime,
      true,
    );
    expect(t.pins()).toHaveLength(1);
    expect(t.pins()[0]).toMatchObject({ kind: 'file', value: t.doc, title: 'report.docx' });
    handleOfficeFileMessage(
      { type: 'pinOfficeFile', fileId: reply.fileId, pinned: false },
      t.send,
      t.runtime,
      true,
    );
    expect(t.pins()).toEqual([]);
  });

  it('delete only removes the office’s own copy — never a file of the user’s', () => {
    const t = setup();
    const own = t.files.open(t.doc);
    const up = saveUploadedFile('a.docx', Buffer.from('a'), 'pin_up2')!;
    const copy = t.files.open(up);
    if (!own.ok || !copy.ok) throw new Error('open failed');
    t.board.savePin({ id: 'p1', kind: 'file', title: 'a', value: up, scope: [], createdAt: '' });

    handleOfficeFileMessage(
      { type: 'deleteOfficeUpload', fileId: own.fileId },
      t.send,
      t.runtime,
      true,
    );
    expect(fs.existsSync(t.doc)).toBe(true);
    expect(t.sent.at(-1)).toMatchObject({ type: 'teamNotice', error: true });

    handleOfficeFileMessage(
      { type: 'deleteOfficeUpload', fileId: copy.fileId },
      t.send,
      t.runtime,
      true,
    );
    expect(fs.existsSync(up)).toBe(false);
    expect(t.pins()).toEqual([]);
    expect(t.files.pathOf(copy.fileId)).toBeUndefined();
  });

  it('need a privileged connection', () => {
    const t = setup();
    expect(
      handleOfficeFileMessage({ type: 'openOfficeFile', path: t.doc }, t.send, t.runtime, false),
    ).toBe(true);
    expect(t.sent[0]).toMatchObject({
      type: 'fileOpened',
      error: expect.stringMatching(/private link/),
    });
    expect(t.files.list()).toEqual([]);
    expect(handleOfficeFileMessage({ type: 'renameAgent' }, t.send, t.runtime, true)).toBe(false);
  });
});

describe('backups', () => {
  const put = (backups: string, name: string, bytes = 1) => {
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, name), 'x'.repeat(bytes));
  };

  it('are grouped by file; two files with one name in different folders stay apart', () => {
    const backups = path.join(dir, 'b');
    put(backups, backupName('/w/a/report.docx', 'e1', 1_000_000_000_000), 3);
    put(backups, backupName('/w/a/report.docx', 'e2', 1_000_000_100_000), 4);
    put(backups, backupName('/w/b/report.docx', 'e3', 1_000_000_050_000));
    put(backups, '1000000000000-p1-old-style.md'); // before path hashes
    put(backups, 'not-a-backup.txt');
    const groups = listBackups(backups);
    expect(groups.map((g) => [g.name, g.versions])).toEqual([
      ['report.docx', 2],
      ['report.docx', 1],
      ['old-style.md', 1],
    ]);
    expect(groups[0].bytes).toBe(7);
  });

  it('are pruned to the newest few per file, and none older than the limit', () => {
    const backups = path.join(dir, 'b');
    const now = 2_000_000_000_000;
    for (let i = 0; i < 7; i++) put(backups, backupName('/w/a.docx', `e${i}`, now - i * 1000));
    put(backups, backupName('/w/old.docx', 'e9', now - 8 * 24 * 3600 * 1000));
    const deleted = pruneBackups(backups, now, 5, 7 * 24 * 3600 * 1000);
    expect(deleted).toHaveLength(3);
    expect(listBackups(backups).map((g) => [g.name, g.versions])).toEqual([['a.docx', 5]]);
  });

  it('can be cleared per file or all at once', () => {
    const backups = path.join(dir, 'b');
    put(backups, backupName('/w/a.docx', 'e1'));
    put(backups, backupName('/w/b.docx', 'e2'));
    const [first] = listBackups(backups);
    expect(clearBackups(first.key, backups)).toBe(1);
    expect(listBackups(backups)).toHaveLength(1);
    expect(clearBackups(undefined, backups)).toBe(1);
    expect(listBackups(backups)).toEqual([]);
  });
});

describe('suggestions survive a restart', () => {
  it('open document suggestions are saved and read back (without their agent id)', async () => {
    const store = new AgentStateStore();
    const persist = path.join(dir, 'suggestions.json');
    const file = path.join(dir, 'report.docx');
    fs.writeFileSync(file, await makeDocx());
    const first = new Proposals(store, () => {}, path.join(dir, 'b'), persist);
    const opened = await first.openDoc({
      path: file,
      edits: [{ kind: 'para', n: 1, text: 'New title' }],
      agentId: 4,
    });
    if (!opened.ok) throw new Error(opened.error);

    const written: string[] = [];
    const second = new Proposals(
      store,
      () => {},
      path.join(dir, 'b'),
      persist,
      (p) => void written.push(p),
    );
    const [restored] = second.snapshot().proposals;
    expect(restored).toMatchObject({ proposalId: opened.proposal.proposalId, state: 'open' });
    expect(restored.agentId).toBeUndefined();
    second.decide(restored.proposalId, 'd1', 'accepted');
    const applied = await second.applyAny(restored.proposalId);
    expect(applied.ok).toBe(true);
    expect(written).toEqual([file]);
    // Nothing open any more: the saved list is empty.
    expect(JSON.parse(fs.readFileSync(persist, 'utf-8')).entries).toEqual([]);
  });
});

describe('Files over HTTP', () => {
  it('the viewer fetches by file id; an upload from Open file is listed but not pinned', async () => {
    const { createHttpServer } = await import('../src/httpServer.js');
    const t = setup();
    const opened = t.files.open(t.doc);
    if (!opened.ok) throw new Error('open failed');
    const { app, port } = await createHttpServer({
      embedded: true,
      token: 'secret',
      store: new AgentStateStore(),
      runtime: { files: t.files } as unknown as AgentRuntime,
      getBoardPins: t.board.getPins,
      saveBoardPin: t.board.savePin,
    });
    const url = `http://127.0.0.1:${port}`;
    const auth = { Authorization: 'Bearer secret' };
    expect((await fetch(`${url}/api/docs/files/${opened.fileId}`)).status).toBe(401);
    const got = await fetch(`${url}/api/docs/files/${opened.fileId}`, { headers: auth });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('x');
    expect((await fetch(`${url}/api/docs/files/f000000000000`, { headers: auth })).status).toBe(
      404,
    );

    const up = await fetch(`${url}/api/board/files?name=notes.md&pin=0`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/octet-stream' },
      body: 'hello',
    });
    const body = (await up.json()) as { fileId?: string; path?: string; pin?: unknown };
    expect(body.pin).toBeUndefined();
    expect(body.fileId).toMatch(/^f[a-f0-9]{12}$/);
    expect(t.pins()).toEqual([]);
    expect(t.files.list()[0]).toMatchObject({ source: 'upload', name: 'notes.md' });
    await app.close();
  });
});
