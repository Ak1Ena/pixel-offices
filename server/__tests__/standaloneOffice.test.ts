import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolated temp HOME so this never touches the real ~/.pixel-agents/.
let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

// Real asset loading needs PNG fixtures under dist/; mock the loaders the
// same way assetReload.test.ts does so `attachOrStartOffice`'s "own" branch
// (which composes a real office, assets included) stays fast and hermetic.
vi.mock('../src/assetLoader.js', () => ({
  loadFurnitureAssets: vi.fn(() => Promise.resolve({ catalog: [], sprites: new Map() })),
  loadCharacterSprites: vi.fn(() => Promise.resolve({ characters: [] })),
  loadExternalCharacterSprites: vi.fn(() => Promise.resolve({ characters: [] })),
  loadPetSprites: vi.fn(() => Promise.resolve({ pets: [], manifests: [] })),
  loadExternalPetSprites: vi.fn(() => Promise.resolve({ pets: [], manifests: [] })),
  loadFloorTiles: vi.fn(() => Promise.resolve({ sprites: [] })),
  loadWallTiles: vi.fn(() => Promise.resolve({ sets: [] })),
  loadCarpetTiles: vi.fn(() => Promise.resolve({ sets: [] })),
  loadDefaultLayout: vi.fn(() => ({ version: 1 })),
  mergeLoadedAssets: vi.fn((a) => a),
  mergeCharacterSprites: vi.fn((a) => a),
  mergePetSprites: vi.fn((a) => a),
}));

// Must import AFTER the mocks above.
const { PixelAgentsServer } = await import('../src/server.js');
const { attachOrStartOffice } = await import('../src/standaloneOffice.js');

function baseOpts() {
  const distRoot = path.join(tmpBase, 'dist');
  return {
    host: '127.0.0.1',
    distRoot,
    packageRoot: tmpBase,
    staticDir: path.join(distRoot, 'webview'),
    projectDir: tmpBase, // a folder with no ~/.claude/projects/<hash> match: scanning no-ops
  };
}

describe('attachOrStartOffice', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-standalone-office-test-'));
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
    fs.mkdirSync(path.join(tmpBase, 'dist', 'webview'), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('attaches to an already-running standalone server instead of building its own runtime', async () => {
    const existing = new PixelAgentsServer();
    const existingConfig = await existing.start({ embedded: false });

    // The callback must never even be INVOKED on the attach path -- that's
    // what would show a folder picker the process never ends up using.
    const resolveOptions = vi.fn(baseOpts);
    const result = await attachOrStartOffice(resolveOptions);

    expect(result.mode).toBe('attach');
    if (result.mode !== 'attach') throw new Error('expected attach mode');
    expect(result.config.port).toBe(existingConfig.port);
    expect(result.config.token).toBe(existingConfig.token);
    expect(resolveOptions).not.toHaveBeenCalled();
    // Discriminated union: no runtime/store/server fields exist on this branch.
    expect('runtime' in result).toBe(false);
    expect('store' in result).toBe(false);
    expect('server' in result).toBe(false);
    // No FileStateAdapter was ever constructed, so it never wrote its file.
    expect(fs.existsSync(path.join(tmpBase, '.pixel-agents', 'standalone-state.json'))).toBe(false);

    existing.stop();
  });

  it('starts its own office when the registry is empty', async () => {
    const result = await attachOrStartOffice(() => baseOpts());

    expect(result.mode).toBe('own');
    if (result.mode !== 'own') throw new Error('expected own mode');
    expect(result.config.port).toBeGreaterThan(0);
    expect(result.runtime).toBeDefined();
    expect(result.store).toBeDefined();

    result.disposeOfficeSessions();
    result.runtime.dispose();
    result.server.stop();
  });

  it('starts its own office when the only registry entries are dead', async () => {
    const registryDir = path.join(tmpBase, '.pixel-agents', 'servers');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, '999999-9999.json'),
      JSON.stringify({
        port: 9999,
        pid: 999999,
        token: 'stale',
        startedAt: 0,
        servesSpa: true,
        protocol: 1,
      }),
    );

    const result = await attachOrStartOffice(() => baseOpts());

    expect(result.mode).toBe('own');
    if (result.mode !== 'own') throw new Error('expected own mode');

    result.disposeOfficeSessions();
    result.runtime.dispose();
    result.server.stop();
  });

  it('reports cancelled (and starts nothing) when the registry is empty and options resolve to undefined', async () => {
    const result = await attachOrStartOffice(() => undefined);
    expect(result).toEqual({ mode: 'cancelled' });
  });

  // Regression pin for the "MaxListenersExceededWarning on an own-mode
  // start" investigation: a single connected client legitimately brings an
  // own-mode office's 'agentRemoved' subscriber count to 11 (measured), but
  // it must never COMPOUND -- each compose gets a fresh AgentStateStore
  // (fresh emitter), and every subscriber's own dispose() must fully
  // unsubscribe. Five compose/dispose cycles (what "Change folder…" does
  // repeatedly in one process) must see the identical count each time, and
  // exactly 0 after each dispose.
  it('returns the "agentRemoved" listener count to the same baseline across repeated compose/dispose cycles', async () => {
    const afterComposeCounts: number[] = [];

    for (let i = 0; i < 5; i++) {
      const result = await attachOrStartOffice(() => baseOpts());
      if (result.mode !== 'own') throw new Error('expected own mode');

      afterComposeCounts.push(result.store.listenerCount('agentRemoved'));

      result.disposeOfficeSessions();
      result.runtime.dispose();
      result.server.stop();

      expect(result.store.listenerCount('agentRemoved')).toBe(0);
    }

    expect(afterComposeCounts).toHaveLength(5);
    expect(new Set(afterComposeCounts).size).toBe(1); // identical every cycle -- no growth
  });
});
