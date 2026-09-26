import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LayaModelSetting } from '../src/configPersistence.js';
import { LayaManager, type LayaStatusMessage } from '../src/layaManager.js';

/** A stand-in laya-serve: answers HTTP on LAYA_PORT and echoes what it was started with. */
const FAKE_SERVE = `#!/usr/bin/env node
const http = require('http');
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/health') return res.end('{"status":"ok"}');
    if (req.url !== '/v1/systemone') { res.statusCode = 404; return res.end(); }
    if (req.headers.authorization !== 'Bearer ' + process.env.LAYA_API_KEY) { res.statusCode = 401; return res.end(); }
    const parsed = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers: { q: { choice: parsed.model || process.env.LAYA_MODELS, confidence: 1 } } }));
  });
}).listen(Number(process.env.LAYA_PORT), process.env.LAYA_HOST);
`;

const isWindows = process.platform === 'win32';

describe('LayaManager', () => {
  let root: string;
  let sent: LayaStatusMessage[];
  let enabled: boolean;
  let model: LayaModelSetting | undefined;
  let manager: LayaManager | undefined;

  const make = () =>
    (manager = new LayaManager({
      rootDir: root,
      broadcast: (msg) => sent.push(msg),
      readEnabled: () => enabled,
      writeEnabled: (e) => (enabled = e),
      readModel: () => model,
      writeModel: (m) => (model = m),
    }));

  /** What a finished install leaves behind, with the fake server as laya-serve. */
  const fakeInstall = () => {
    const bin = path.join(root, 'venv', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'laya-serve'), FAKE_SERVE, { mode: 0o755 });
    // Started as `python -m laya.serve`; the fake ignores its arguments.
    fs.writeFileSync(path.join(bin, 'python'), FAKE_SERVE, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'installed'), 'now');
  };

  const waitFor = async (pred: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-'));
    sent = [];
    enabled = false;
    model = undefined;
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('starts absent and off, with Auto as the default language, and asks no model', () => {
    const m = make();
    expect(m.snapshot()).toMatchObject({ state: 'absent', enabled: false, model: 'auto' });
    expect(m.decider()).toBeNull();
  });

  it('reads an existing install as stopped', () => {
    fakeInstall();
    expect(make().snapshot().state).toBe('stopped');
  });

  it('persists the language choice and broadcasts it', () => {
    const m = make();
    m.setModel('multilingual');
    expect(model).toBe('multilingual');
    expect(sent.at(-1)).toMatchObject({ type: 'layaStatus', model: 'multilingual' });
  });

  it('uninstall deletes the folder and remembers off', async () => {
    fakeInstall();
    enabled = true;
    const m = make();
    await m.uninstall();
    expect(fs.existsSync(root)).toBe(false);
    expect(enabled).toBe(false);
    expect(m.snapshot()).toMatchObject({ state: 'absent', enabled: false });
  });

  it.skipIf(isWindows)(
    'runs laya-serve on 127.0.0.1 with a key, asks the chosen model, and stops on off',
    async () => {
      fakeInstall();
      model = 'multilingual';
      const m = make();
      m.setEnabled(true);
      await waitFor(() => m.snapshot().state === 'running');
      const record = JSON.parse(fs.readFileSync(path.join(root, 'serve.json'), 'utf-8'));
      expect(record.models).toBe('multilingual');

      const answers = await m
        .decider()!
        .ask({ s: 'x' }, { q: { type: 'noul', instructions: 'q' } });
      expect(answers?.q.choice).toBe('multilingual');

      m.setEnabled(false);
      expect(m.snapshot().state).toBe('stopped');
      expect(m.decider()).toBeNull();
      expect(fs.existsSync(path.join(root, 'serve.json'))).toBe(false);
    },
  );

  it.skipIf(isWindows)('Auto sends no model, so laya-serve routes by language', async () => {
    fakeInstall();
    const m = make();
    m.setEnabled(true);
    await waitFor(() => m.snapshot().state === 'running');
    const answers = await m.decider()!.ask({ s: 'x' }, { q: { type: 'noul', instructions: 'q' } });
    expect(answers?.q.choice).toBe('english,multilingual');
  });

  it.skipIf(isWindows)('uninstall stops a running laya-serve before deleting', async () => {
    fakeInstall();
    const m = make();
    m.setEnabled(true);
    await waitFor(() => m.snapshot().state === 'running');
    const { pid } = JSON.parse(fs.readFileSync(path.join(root, 'serve.json'), 'utf-8'));
    await m.uninstall();
    expect(fs.existsSync(root)).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.skipIf(isWindows)('a second office reuses the running laya-serve', async () => {
    fakeInstall();
    const first = make();
    first.setEnabled(true);
    await waitFor(() => first.snapshot().state === 'running');
    const port = JSON.parse(fs.readFileSync(path.join(root, 'serve.json'), 'utf-8')).port;

    enabled = true;
    const second = new LayaManager({
      rootDir: root,
      broadcast: () => {},
      readEnabled: () => enabled,
      writeEnabled: () => {},
      readModel: () => model,
      writeModel: () => {},
    });
    try {
      await waitFor(() => second.snapshot().state === 'running');
      expect(JSON.parse(fs.readFileSync(path.join(root, 'serve.json'), 'utf-8')).port).toBe(port);
    } finally {
      second.dispose();
    }
  });
});
