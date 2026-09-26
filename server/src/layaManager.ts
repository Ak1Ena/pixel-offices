import { type ChildProcess, execFile, spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import {
  getLayaEnabled,
  getLayaModel,
  type LayaModelSetting,
  setLayaEnabled,
  setLayaModel,
} from './configPersistence.js';
import {
  LAYA_DEFAULT_MODEL,
  LAYA_DETAIL_MAX_CHARS,
  LAYA_DIR_NAME,
  LAYA_LINUX_TORCH_INDEX,
  LAYA_MODEL_PRELOAD,
  LAYA_OUTPUT_TAIL_CHARS,
  LAYA_PIP_SPEC,
  LAYA_PROBE_TIMEOUT_MS,
  LAYA_PROGRESS_THROTTLE_MS,
  LAYA_PYTHON_CANDIDATES,
  LAYA_PYTHON_PROBE_TIMEOUT_MS,
  LAYA_RM_RETRIES,
  LAYA_START_POLL_MS,
  LAYA_START_TIMEOUT_MS,
  LAYA_STOP_WAIT_MS,
  LAYA_WATCHDOG_MS,
  LAYOUT_FILE_DIR,
} from './constants.js';
import { type Decider, SystemOneClient } from './decisions.js';

/**
 * Laya run by the office itself, so nobody has to open a terminal: Settings
 * → Decision model downloads it into its own Python venv under
 * `~/.pixel-agents/laya/` (weights too, via HF_HOME), runs `laya-serve` on
 * 127.0.0.1 with a random port and bearer key, and Uninstall deletes that
 * folder. Nothing outside it is touched: no global pip, no ~/.cache.
 *
 * Off unless the user turns it on (config.json `laya.enabled`). A hand-set
 * endpoint (`decisions` / PIXEL_AGENTS_DECISIONS_URL) always wins; the
 * runtime asks this manager only when there is none.
 *
 * Several offices (VS Code + standalone) share one laya-serve through
 * `serve.json`: the first starts it, the others reuse it while it answers,
 * and the watchdog restarts it when its owner went away.
 */

export type LayaState =
  'absent' | 'installing' | 'stopped' | 'starting' | 'running' | 'uninstalling' | 'error';

export interface LayaStatusMessage {
  type: 'layaStatus';
  state: LayaState;
  /** The user's choice (config.json), independent of whether it is running yet. */
  enabled: boolean;
  /** Which language checkpoint(s) it runs. */
  model: LayaModelSetting;
  /** Latest progress line (pip, weight download). */
  detail?: string;
  error?: string;
  /** A hand-configured endpoint in use instead of the office's own Laya. */
  external?: string;
}

interface ServeRecord {
  pid: number;
  port: number;
  apiKey: string;
  /** LAYA_MODELS it preloaded: another office reuses it only for the same choice. */
  models: string;
}

export interface LayaManagerOptions {
  broadcast: (msg: LayaStatusMessage) => void;
  /** A hand-set endpoint, if any (shown in Settings; the office's Laya then stays unused). */
  externalUrl?: () => string | undefined;
  /** Test seams. */
  rootDir?: string;
  readEnabled?: () => boolean;
  writeEnabled?: (enabled: boolean) => void;
  readModel?: () => LayaModelSetting | undefined;
  writeModel?: (model: LayaModelSetting) => void;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** laya-serve's `/health` answers. */
async function answers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(LAYA_PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Stop a process and everything it started. On Windows a venv's python.exe is
 * a redirector that runs the real interpreter as its CHILD, so killing the pid
 * alone leaves Laya running — and holding files Uninstall must delete.
 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

async function waitGone(pids: number[]): Promise<void> {
  const end = Date.now() + LAYA_STOP_WAIT_MS;
  while (pids.some(isAlive) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, LAYA_START_POLL_MS / 4));
  }
}

function lastLine(text: string): string | undefined {
  const lines = text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines[lines.length - 1];
  return line ? line.slice(0, LAYA_DETAIL_MAX_CHARS) : undefined;
}

export class LayaManager {
  private state: LayaState;
  private detail: string | undefined;
  private error: string | undefined;
  private enabled: boolean;
  private model: LayaModelSetting;
  /** The pip / venv process during an install. */
  private installChild: ChildProcess | null = null;
  /** laya-serve, when this office started it. */
  private serveChild: ChildProcess | null = null;
  private endpoint: ServeRecord | null = null;
  private client: SystemOneClient | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private starting: Promise<void> | null = null;
  private disposed = false;
  private readonly root: string;
  private readonly readEnabled: () => boolean;
  private readonly writeEnabled: (enabled: boolean) => void;

  constructor(private readonly opts: LayaManagerOptions) {
    this.root = opts.rootDir ?? path.join(os.homedir(), LAYOUT_FILE_DIR, LAYA_DIR_NAME);
    this.readEnabled = opts.readEnabled ?? getLayaEnabled;
    this.writeEnabled = opts.writeEnabled ?? setLayaEnabled;
    this.enabled = this.readEnabled();
    this.model = (opts.readModel ?? getLayaModel)() ?? LAYA_DEFAULT_MODEL;
    this.state = this.isInstalled() ? 'stopped' : 'absent';
    if (this.enabled) void this.turnOn();
  }

  // ── Paths ──

  private get venvDir(): string {
    return path.join(this.root, 'venv');
  }
  private get venvBin(): string {
    return path.join(this.venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
  }
  private get venvPython(): string {
    return path.join(this.venvBin, process.platform === 'win32' ? 'python.exe' : 'python');
  }
  private get serveBin(): string {
    return path.join(this.venvBin, process.platform === 'win32' ? 'laya-serve.exe' : 'laya-serve');
  }
  /** Written only after pip finished: a half-done install reads as absent. */
  private get marker(): string {
    return path.join(this.root, 'installed');
  }
  private get serveFile(): string {
    return path.join(this.root, 'serve.json');
  }
  private get lockFile(): string {
    return path.join(this.root, 'install.lock');
  }

  isInstalled(): boolean {
    return fs.existsSync(this.marker) && fs.existsSync(this.serveBin);
  }

  // ── What the runtime and the UI read ──

  /** A client for the running laya-serve, else null (every rule then works alone). */
  decider(): Decider | null {
    return this.state === 'running' ? this.client : null;
  }

  snapshot(): LayaStatusMessage {
    const external = this.opts.externalUrl?.();
    return {
      type: 'layaStatus',
      state: this.state,
      enabled: this.enabled,
      model: this.model,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(external ? { external } : {}),
    };
  }

  private set(state: LayaState, detail?: string, error?: string): void {
    this.state = state;
    this.detail = detail;
    this.error = error;
    this.publish();
  }

  private lastPublish = 0;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;

  private publish(): void {
    if (this.disposed) return;
    this.lastPublish = Date.now();
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    this.opts.broadcast(this.snapshot());
  }

  /** Progress lines arrive by the hundred; send at most two a second. */
  private progress(text: string): void {
    const line = lastLine(text);
    if (!line) return;
    this.detail = line;
    if (Date.now() - this.lastPublish >= LAYA_PROGRESS_THROTTLE_MS) this.publish();
    else this.publishTimer ??= setTimeout(() => this.publish(), LAYA_PROGRESS_THROTTLE_MS);
  }

  // ── User actions (privileged client messages) ──

  /** On = install if needed, then run. Off = stop running (the download stays). */
  setEnabled(enabled: boolean): void {
    if (this.state === 'uninstalling') return;
    this.enabled = enabled;
    this.writeEnabled(enabled);
    if (enabled) void this.turnOn();
    // Mid-download: let pip finish (it stops cleanly only by uninstalling); turnOn then sees "off".
    else if (this.state === 'installing') this.publish();
    else this.turnOff();
  }

  /** Pick the language checkpoint(s). Running: restart laya-serve with them (new weights download on first use). */
  setModel(model: LayaModelSetting): void {
    if (model === this.model) return;
    this.model = model;
    (this.opts.writeModel ?? setLayaModel)(model);
    if (this.state === 'running' || this.state === 'starting' || this.state === 'error') {
      this.turnOff(true);
      this.state = 'stopped';
      if (this.enabled) void this.start();
      else this.publish();
    } else {
      this.publish();
    }
  }

  /** Stop and delete everything under ~/.pixel-agents/laya, and remember "off". */
  async uninstall(): Promise<void> {
    if (this.state === 'uninstalling') return;
    this.enabled = false;
    this.writeEnabled(false);
    const pids: number[] = [];
    if (this.installChild?.pid) pids.push(this.installChild.pid);
    killTree(this.installChild?.pid);
    this.installChild = null;
    if (this.serveChild?.pid) pids.push(this.serveChild.pid);
    // Another office's laya-serve runs from the folder being deleted: stop it too.
    const shared = this.readServeRecord();
    if (shared && isAlive(shared.pid)) {
      pids.push(shared.pid);
      killTree(shared.pid);
    }
    this.turnOff(true);
    this.set('uninstalling', 'Removing Laya and its downloaded models…');
    try {
      // Windows: files stay locked until the processes are gone, and briefly after.
      await waitGone(pids);
      await fs.promises.rm(this.root, {
        recursive: true,
        force: true,
        maxRetries: LAYA_RM_RETRIES,
        retryDelay: LAYA_START_POLL_MS / 2,
      });
      this.set('absent');
    } catch (err) {
      this.set('error', undefined, `Could not remove ${this.root}: ${String(err)}`);
    }
  }

  // ── Install ──

  private async turnOn(): Promise<void> {
    if (this.disposed) return;
    if (this.state === 'installing' || this.state === 'starting' || this.state === 'running') {
      return;
    }
    if (!this.isInstalled()) {
      const ok = await this.install();
      if (!ok || !this.enabled || this.disposed) return;
    }
    await this.start();
  }

  private run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
    return new Promise((resolve) => {
      const log = fs.createWriteStream(path.join(this.root, 'install.log'), { flags: 'a' });
      log.write(`\n$ ${cmd} ${args.join(' ')}\n`);
      let tail = '';
      const child = spawn(cmd, args, {
        env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.installChild = child;
      const onData = (buf: Buffer): void => {
        const text = buf.toString();
        log.write(text);
        tail = (tail + text).slice(-LAYA_OUTPUT_TAIL_CHARS);
        this.progress(text);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => {
        log.end();
        this.installChild = null;
        resolve(`${cmd}: ${err.message}`);
      });
      child.on('close', (code, signal) => {
        log.end();
        if (this.installChild === child) this.installChild = null;
        if (code === 0) resolve(null);
        else resolve(signal ? `stopped (${signal})` : (lastLine(tail) ?? `exit code ${code}`));
      });
    });
  }

  /** The first Python at 3.10+ on PATH, else null. */
  private async findPython(): Promise<string[] | null> {
    const candidates: string[][] = LAYA_PYTHON_CANDIDATES.map((c) => [c]);
    if (process.platform === 'win32') candidates.unshift(['py', '-3']);
    for (const [cmd, ...pre] of candidates) {
      const ok = await new Promise<boolean>((resolve) => {
        execFile(
          cmd,
          [...pre, '-c', 'import sys; print(sys.version_info >= (3, 10))'],
          { timeout: LAYA_PYTHON_PROBE_TIMEOUT_MS, windowsHide: true },
          (err, stdout) => resolve(!err && stdout.trim() === 'True'),
        );
      });
      if (ok) return [cmd, ...pre];
    }
    return null;
  }

  private async install(): Promise<boolean> {
    fs.mkdirSync(this.root, { recursive: true });
    try {
      const holder = Number(fs.readFileSync(this.lockFile, 'utf-8'));
      if (holder && holder !== process.pid && isAlive(holder)) {
        this.set('error', undefined, 'Laya is being installed from another Pixel Agents window.');
        return false;
      }
    } catch {
      /* no lock */
    }
    fs.writeFileSync(this.lockFile, String(process.pid));
    try {
      this.set('installing', 'Looking for Python 3.10 or newer…');
      const python = await this.findPython();
      if (!python) {
        this.set(
          'error',
          undefined,
          'Laya needs Python 3.10 or newer. Install it from python.org (or your package manager) and try again.',
        );
        return false;
      }
      this.set('installing', 'Creating a private Python environment…');
      const [cmd, ...pre] = python;
      let failed = await this.run(cmd, [...pre, '-m', 'venv', '--clear', this.venvDir]);
      if (!failed) {
        this.set('installing', 'Downloading Laya (PyTorch is large; this can take a while)…');
        const extra =
          process.platform === 'linux' ? ['--extra-index-url', LAYA_LINUX_TORCH_INDEX] : [];
        failed = await this.run(this.venvPython, [
          '-m',
          'pip',
          'install',
          '--upgrade',
          ...extra,
          LAYA_PIP_SPEC,
        ]);
      }
      if (this.state === 'uninstalling' || this.disposed) return false;
      if (failed) {
        this.set('error', undefined, `Install failed: ${failed}. See ${this.root}/install.log`);
        return false;
      }
      fs.writeFileSync(this.marker, new Date().toISOString());
      this.set('stopped');
      return true;
    } finally {
      fs.rmSync(this.lockFile, { force: true });
    }
  }

  // ── Run ──

  private readServeRecord(): ServeRecord | null {
    try {
      const r = JSON.parse(fs.readFileSync(this.serveFile, 'utf-8')) as Partial<ServeRecord>;
      if (
        typeof r.pid === 'number' &&
        typeof r.port === 'number' &&
        typeof r.apiKey === 'string' &&
        typeof r.models === 'string'
      ) {
        return { pid: r.pid, port: r.port, apiKey: r.apiKey, models: r.models };
      }
    } catch {
      /* none */
    }
    return null;
  }

  private use(record: ServeRecord): void {
    this.endpoint = record;
    this.client = new SystemOneClient({
      url: `http://127.0.0.1:${record.port}`,
      apiKey: record.apiKey,
      // Auto sends no model: laya-serve's router then picks by the reply's language.
      ...(this.model === 'auto' ? {} : { model: this.model }),
    });
    this.set('running');
    this.watchdog ??= setInterval(() => void this.check(), LAYA_WATCHDOG_MS);
  }

  private start(): Promise<void> {
    this.starting ??= this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    // Another office's laya-serve, still answering: share it.
    const models = LAYA_MODEL_PRELOAD[this.model];
    const shared = this.readServeRecord();
    if (shared && shared.models === models && isAlive(shared.pid) && (await answers(shared.port))) {
      console.log(`[Pixel Agents] Laya: using the running laya-serve on port ${shared.port}`);
      this.use(shared);
      return;
    }
    this.set('starting', 'Starting Laya (the first start downloads its model)…');
    const record: ServeRecord = {
      pid: 0,
      port: await freePort(),
      apiKey: crypto.randomBytes(24).toString('hex'),
      models,
    };
    const log = fs.createWriteStream(path.join(this.root, 'serve.log'), { flags: 'a' });
    // The module, not the laya-serve script: one launcher less between us and the server.
    const child = spawn(this.venvPython, ['-m', 'laya.serve'], {
      env: {
        ...process.env,
        LAYA_HOST: '127.0.0.1',
        LAYA_PORT: String(record.port),
        LAYA_API_KEY: record.apiKey,
        LAYA_MODELS: models,
        LAYA_PRELOAD: '1',
        HF_HOME: path.join(this.root, 'hf'),
        PYTHONUNBUFFERED: '1',
        LAYA_LOG_LEVEL: 'warning',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.serveChild = child;
    let tail = '';
    let exited = false;
    const onData = (buf: Buffer): void => {
      const text = buf.toString();
      log.write(text);
      tail = (tail + text).slice(-LAYA_OUTPUT_TAIL_CHARS);
      if (this.state === 'starting') this.progress(text);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      tail += `\n${err.message}`;
    });
    child.on('exit', () => {
      exited = true;
      log.end();
      if (this.serveChild !== child) return;
      this.serveChild = null;
      if (this.readServeRecord()?.pid === record.pid) fs.rmSync(this.serveFile, { force: true });
      if (this.state === 'running') {
        this.client = null;
        this.set('error', undefined, `Laya stopped: ${lastLine(tail) ?? 'no output'}`);
      }
    });
    record.pid = child.pid ?? 0;

    const deadline = Date.now() + LAYA_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited || this.disposed || this.serveChild !== child) {
        if (this.state === 'starting') {
          this.set('error', undefined, `Laya did not start: ${lastLine(tail) ?? 'no output'}`);
        }
        return;
      }
      if (await answers(record.port)) {
        fs.writeFileSync(this.serveFile, JSON.stringify(record), { mode: 0o600 });
        console.log(`[Pixel Agents] Laya: laya-serve running on 127.0.0.1:${record.port}`);
        this.use(record);
        return;
      }
      await new Promise((r) => setTimeout(r, LAYA_START_POLL_MS));
    }
    killTree(child.pid);
    this.set('error', undefined, 'Laya took too long to start. See serve.log in ' + this.root);
  }

  /** Watchdog: restart when the laya-serve in use stopped answering (its owner may have exited). */
  private async check(): Promise<void> {
    if (!this.enabled || this.disposed || this.starting) return;
    if (this.state === 'running' && this.endpoint && (await answers(this.endpoint.port))) return;
    if (this.state !== 'running' && this.state !== 'error') return;
    this.client = null;
    this.endpoint = null;
    this.state = 'stopped';
    await this.start();
  }

  private turnOff(quiet = false): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.client = null;
    this.endpoint = null;
    const child = this.serveChild;
    this.serveChild = null;
    if (child) {
      if (this.readServeRecord()?.pid === child.pid) fs.rmSync(this.serveFile, { force: true });
      killTree(child.pid);
    }
    if (!quiet) this.set(this.isInstalled() ? 'stopped' : 'absent');
  }

  dispose(): void {
    killTree(this.installChild?.pid);
    this.turnOff(true);
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.disposed = true;
  }
}
