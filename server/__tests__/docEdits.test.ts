import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DocEditMode } from '../../core/src/messages.js';
import type { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { runDocCommand } from '../src/docCli.js';
import { DocEdits, sha256 } from '../src/docEdits.js';
import { createHttpServer } from '../src/httpServer.js';
import { readDocModel } from '../src/officeDocs.js';
import { Proposals } from '../src/proposals.js';
import type { ServerConfig } from '../src/serverConfig.js';
import type { AgentState } from '../src/types.js';
import { makeDocx, makeXlsx } from './helpers/officeFixtures.js';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-docedits-')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function setup(opts: { mode?: DocEditMode; agentMode?: DocEditMode } = {}) {
  const store = new AgentStateStore();
  const broadcasts: Array<Record<string, unknown>> = [];
  store.on('broadcast', (m: Record<string, unknown>) => broadcasts.push(m));
  const delivered: Array<[number, string]> = [];
  const backups = path.join(dir, 'backups');
  const proposals = new Proposals(store, (id, text) => void delivered.push([id, text]), backups);
  let officeDefault: DocEditMode = opts.mode ?? 'ask';
  const docs = new DocEdits(
    store,
    () => proposals,
    backups,
    () => officeDefault,
    (m) => {
      officeDefault = m;
    },
  );
  store.set(1, {
    id: 1,
    sessionId: 'sess-1',
    displayName: 'Scout',
    jsonlFile: '/p/sess-1.jsonl',
    activeToolIds: new Set(),
    ...(opts.agentMode ? { docEditMode: opts.agentMode } : {}),
  } as unknown as AgentState);
  const file = path.join(dir, 'report.docx');
  fs.writeFileSync(file, await makeDocx());
  const paragraph = async (n: number) => {
    const model = await readDocModel(fs.readFileSync(file), 'docx');
    return model.kind === 'docx' ? model.paragraphs[n - 1]?.text : undefined;
  };
  return { store, docs, proposals, broadcasts, delivered, file, backups, paragraph };
}

describe('the human edits a document in the viewer', () => {
  it('writes the edit, keeps a backup, and Undo restores the exact bytes', async () => {
    const t = await setup();
    const before = fs.readFileSync(t.file);
    const model = await t.docs.model(t.file);
    if (!model.ok) throw new Error(model.error);
    expect(model.sha).toBe(sha256(before));

    const result = await t.docs.write(
      t.file,
      [{ kind: 'para', n: 1, text: 'Q3 report' }],
      { label: 'You' },
      model.sha,
    );
    if (!result.ok) throw new Error(result.error);
    expect(await t.paragraph(1)).toBe('Q3 report');
    expect(result.notice).toMatchObject({ who: 'You', canUndo: true, undone: false });
    expect(result.notice.changes[0]).toBe('¶1: Quarterly report → Q3 report');
    expect(fs.readdirSync(t.backups)).toHaveLength(1);
    expect(t.broadcasts.at(-1)?.type).toBe('docEdits');

    expect(t.docs.undo(result.notice.editId)).toEqual({ ok: true });
    expect(fs.readFileSync(t.file).equals(before)).toBe(true);
    expect(t.docs.snapshot().edits[0]).toMatchObject({ undone: true, canUndo: false });
    expect(t.docs.undo(result.notice.editId).ok).toBe(false);
  });

  it('refuses a save made against an older version of the file', async () => {
    const t = await setup();
    const result = await t.docs.write(
      t.file,
      [{ kind: 'para', n: 1, text: 'x' }],
      { label: 'You' },
      'stale',
    );
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(await t.paragraph(1)).toBe('Quarterly report');
  });

  it('does not undo over a later change', async () => {
    const t = await setup();
    const first = await t.docs.write(t.file, [{ kind: 'para', n: 1, text: 'one' }], {
      label: 'You',
    });
    if (!first.ok) throw new Error(first.error);
    fs.appendFileSync(t.file, 'x'); // someone else touched it
    expect(t.docs.undo(first.notice.editId)).toMatchObject({ ok: false });
  });

  it('only the newest edit of a file can be undone', async () => {
    const t = await setup();
    const a = await t.docs.write(t.file, [{ kind: 'para', n: 1, text: 'one' }], { label: 'You' });
    const b = await t.docs.write(t.file, [{ kind: 'para', n: 1, text: 'two' }], { label: 'You' });
    if (!a.ok || !b.ok) throw new Error('write failed');
    const edits = t.docs.snapshot().edits;
    expect(edits.map((e) => e.canUndo)).toEqual([false, true]);
  });

  it('saves a text file keeping its line endings', async () => {
    const t = await setup();
    const notes = path.join(dir, 'notes.md');
    fs.writeFileSync(notes, 'a\r\nb\r\n');
    const result = await t.docs.writeText(
      notes,
      'a\nb\nc\n',
      { label: 'You' },
      sha256('a\r\nb\r\n'),
    );
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(notes, 'utf-8')).toBe('a\r\nb\r\nc\r\n');
    expect((await t.docs.writeText(path.join(dir, 'app.ts'), 'x', { label: 'You' })).ok).toBe(
      false,
    );
  });
});

describe('an agent edits a document', () => {
  it('ask (the default): the edits wait in Review changes, and Apply writes only the accepted ones', async () => {
    const t = await setup();
    const result = await t.docs.fromAgent({
      session: 'sess-1',
      path: t.file,
      edits: [
        { kind: 'para', n: 1, text: 'Q3 report' },
        { kind: 'para', n: 5, text: 'Only point' },
      ],
      why: 'tighten',
    });
    if (!result.ok || result.status !== 'review') throw new Error(JSON.stringify(result));
    expect(await t.paragraph(1)).toBe('Quarterly report'); // nothing written yet
    const proposal = t.proposals.snapshot().proposals[0];
    expect(proposal).toMatchObject({ agentId: 1, why: 'tighten', state: 'open' });
    expect(proposal.hunks.map((h) => [h.where, h.lines.map((l) => `${l.kind}:${l.text}`)])).toEqual(
      [
        ['¶1', ['del:Quarterly report', 'add:Q3 report']],
        ['¶5', ['del:First point', 'add:Only point']],
      ],
    );

    t.proposals.decide(proposal.proposalId, 'd1', 'accepted');
    t.proposals.decide(proposal.proposalId, 'd2', 'rejected', 'keep it');
    const applied = await t.proposals.applyAny(proposal.proposalId);
    if (!applied.ok) throw new Error(applied.error);
    expect(await t.paragraph(1)).toBe('Q3 report');
    expect(await t.paragraph(5)).toBe('First point');
    expect(t.delivered[0][1]).toContain('✓ ¶1: "Q3 report"');
    expect(t.delivered[0][1]).toContain('✗ ¶5: "Only point" — "keep it"');

    expect(t.proposals.undo(proposal.proposalId)).toEqual({ ok: true });
    expect(await t.paragraph(1)).toBe('Quarterly report');
  });

  it('a suggestion made against an older file is shown again, not applied', async () => {
    const t = await setup();
    const result = await t.docs.fromAgent({
      session: 'sess-1',
      path: t.file,
      edits: [{ kind: 'para', n: 1, text: 'Q3 report' }],
    });
    if (!result.ok || result.status !== 'review') throw new Error('expected review');
    await t.docs.write(t.file, [{ kind: 'para', n: 2, text: 'Intro!' }], { label: 'You' });
    t.proposals.decide(result.proposalId, 'd1', 'accepted');
    const applied = await t.proposals.applyAny(result.proposalId);
    expect(applied.ok).toBe(false);
    expect(await t.paragraph(1)).toBe('Quarterly report');
    expect(t.proposals.snapshot().proposals[0].hunks[0].decision).toBe('pending');
  });

  it('auto-accept writes at once and tells the office', async () => {
    const t = await setup({ agentMode: 'auto' });
    const result = await t.docs.fromAgent({
      session: 'sess-1',
      path: t.file,
      edits: [{ kind: 'para', n: 1, text: 'Q3 report' }],
    });
    expect(result).toMatchObject({ ok: true, status: 'applied' });
    expect(await t.paragraph(1)).toBe('Q3 report');
    expect(t.docs.snapshot().edits[0]).toMatchObject({ who: 'Scout', agentId: 1 });
  });

  it('read only refuses, and the office default applies to agents without their own setting', async () => {
    expect(
      await (
        await setup({ mode: 'off' })
      ).docs.fromAgent({
        session: 'sess-1',
        path: '/x/a.docx',
        edits: [],
      }),
    ).toMatchObject({ ok: false, status: 'refused' });
    const t = await setup({ mode: 'off', agentMode: 'auto' });
    expect(
      await t.docs.fromAgent({
        session: 'sess-1',
        path: t.file,
        edits: [{ kind: 'para', n: 1, text: 'x' }],
      }),
    ).toMatchObject({ status: 'applied' });
  });

  it('bad edits are refused whole, and nothing is written', async () => {
    const t = await setup({ agentMode: 'auto' });
    const result = await t.docs.fromAgent({
      session: 'sess-1',
      path: t.file,
      edits: [
        { kind: 'para', n: 1, text: 'ok' },
        { kind: 'para', n: 99, text: 'no' },
      ],
    });
    expect(result).toMatchObject({ ok: false, status: 'invalid' });
    expect((result as { error: string }).error).toMatch(/Edit 2: there is no paragraph 99/);
    expect(await t.paragraph(1)).toBe('Quarterly report');
  });

  it('the office default can be changed and is broadcast', async () => {
    const t = await setup();
    t.docs.setDefaultMode('auto');
    t.docs.setDefaultMode('sometimes');
    expect(t.docs.defaultMode).toBe('auto');
    expect(t.broadcasts.filter((m) => m.type === 'docEditDefault')).toEqual([
      { type: 'docEditDefault', mode: 'auto' },
    ]);
  });
});

describe('over HTTP', () => {
  async function office(t: Awaited<ReturnType<typeof setup>>) {
    const pins = [
      {
        id: 'pin_doc',
        kind: 'file' as const,
        title: 'report',
        value: t.file,
        scope: [],
        createdAt: '',
      },
      {
        id: 'pin_xls',
        kind: 'file' as const,
        title: 'budget',
        value: path.join(dir, 'b.xlsx'),
        scope: [],
        createdAt: '',
      },
    ];
    fs.writeFileSync(path.join(dir, 'b.xlsx'), await makeXlsx());
    const { app, port } = await createHttpServer({
      embedded: true,
      token: 'secret',
      store: t.store,
      runtime: { docs: t.docs } as unknown as AgentRuntime,
      getBoardPins: () => pins,
    });
    const server = { port, token: 'secret', pid: process.pid } as ServerConfig;
    const url = `http://127.0.0.1:${port}`;
    return { app, server, url };
  }

  it('the viewer reads a model and saves an edit against its hash', async () => {
    const t = await setup();
    const o = await office(t);
    const auth = { Authorization: 'Bearer secret' };
    expect((await fetch(`${o.url}/api/board/files/pin_doc/model`)).status).toBe(401);
    const loaded = (await (
      await fetch(`${o.url}/api/board/files/pin_doc/model`, { headers: auth })
    ).json()) as {
      sha: string;
      model: { kind: string };
    };
    expect(loaded.model.kind).toBe('docx');
    const save = (sha: string) =>
      fetch(`${o.url}/api/board/files/pin_doc/edits`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha, edits: [{ kind: 'para', n: 1, text: 'Saved' }] }),
      });
    const ok = await save(loaded.sha);
    expect(ok.status).toBe(200);
    expect(await t.paragraph(1)).toBe('Saved');
    expect((await save(loaded.sha)).status).toBe(409);

    const sheet = (await (
      await fetch(`${o.url}/api/board/files/pin_xls/model`, { headers: auth })
    ).json()) as {
      model: { kind: string };
    };
    expect(sheet.model.kind).toBe('xlsx');
    await o.app.close();
  });

  it('pixel-office doc edit goes through the office and follows the agent’s mode', async () => {
    const t = await setup({ agentMode: 'auto' });
    const o = await office(t);
    const lines: string[] = [];
    const code = await runDocCommand(['edit', t.file, '--para', '1', '--text', 'From the CLI'], {
      servers: () => [o.server],
      session: 'sess-1',
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('✓ ¶1: Quarterly report → From the CLI');
    expect(await t.paragraph(1)).toBe('From the CLI');

    t.store.get(1)!.docEditMode = 'off';
    const refused: string[] = [];
    expect(
      await runDocCommand(['edit', t.file, '--para', '1', '--text', 'no'], {
        servers: () => [o.server],
        session: 'sess-1',
        out: (l) => refused.push(l),
        err: (l) => refused.push(l),
      }),
    ).toBe(1);
    expect(refused.join('\n')).toMatch(/not allowed document edits/);

    const withOrigin = await fetch(`${o.url}/api/docs/edits`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        Origin: 'http://evil.test',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(withOrigin.status).toBe(403);
    await o.app.close();
  });

  it('says so when no office is running', async () => {
    const t = await setup();
    const errors: string[] = [];
    expect(
      await runDocCommand(['edit', t.file, '--para', '1', '--text', 'x'], {
        servers: () => [],
        err: (l) => errors.push(l),
      }),
    ).toBe(1);
    expect(errors[0]).toMatch(/No Pixel Office is running/);
  });
});
