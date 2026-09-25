/**
 * Standalone office composition: assets, store, runtime, and the full
 * `PixelAgentsServer.start()` wiring (hooks toggle, asset reload, launcher
 * poll, office-run agents, task desk, board). Shared by every standalone
 * HOST -- the CLI (`cli.ts`) and the Electron shell (`adapters/electron/`)
 * both call `startStandaloneOffice` and layer their own host-specific concerns
 * (arg parsing, browser/window chrome, hook auto-install prompts) on top.
 *
 * Moved out of cli.ts verbatim: no behavior change from what the CLI did
 * before this module existed.
 */

import type { HookProvider } from '../../core/src/provider.js';
import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import {
  buildAssetCache,
  loadAllCharacters,
  loadAllFurniture,
  loadAllPets,
} from './assetReload.js';
import type { AssetCache, ReloadAssetsSideEffect } from './clientMessageHandler.js';
import { getHooksEnabled, grantHooksConsent, readConfig } from './configPersistence.js';
import { readEndedSessions } from './endedSessions.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { OfficeSessions } from './officeSessions.js';
import {
  antigravityProvider,
  claudeProvider,
  copyProviderHookScript,
  hookProviderById,
  secondaryHookProviders,
} from './providers/index.js';
import { PixelAgentsServer, readAndPruneRegistry } from './server.js';
import type { ServerConfig } from './serverConfig.js';

/**
 * Copy the provider's bundled hook script into ~/.pixel-agents/hooks/,
 * reporting failure.
 *
 * Callers run this BEFORE installing the settings entries and abort when it
 * returns false: an entry whose command points at a missing script makes the
 * host spawn a dead `node` process for every event, which is strictly worse
 * than no hooks at all.
 */
export function copyHookScriptOrReport(
  provider: HookProvider,
  packageRoot: string,
  context = '',
): boolean {
  if (copyProviderHookScript(provider, packageRoot)) return true;
  const label = provider.id === claudeProvider.id ? 'Hooks' : `${provider.displayName} hooks`;
  console.error(`[Pixel Agents] ${label} NOT installed${context}: hook script missing.`);
  return false;
}

export interface StandaloneOfficeOptions {
  host: string;
  /** Unset -> ephemeral (OS-assigned) port. */
  port?: number;
  /** dist/ root containing assets/ and webview/ (asset loading base). */
  distRoot: string;
  /** Package root (one level above distRoot) -- where hook scripts get copied from. */
  packageRoot: string;
  /** SPA directory served by the standalone Fastify instance. */
  staticDir: string;
  /** Directory used to resolve the Claude project dir to scan for external
   *  sessions (getSessionDirs). CLI passes process.cwd(); Electron does too
   *  for now, though that is not a meaningful "project" for a Dock-launched
   *  GUI app -- see the Electron main.ts caller. */
  projectDir: string;
}

export interface StandaloneOffice {
  store: AgentStateStore;
  runtime: AgentRuntime;
  server: PixelAgentsServer;
  config: ServerConfig;
  /** Dispose the office-run-agent (+ Agent) session manager: kills owned ptys. */
  disposeOfficeSessions: () => void;
  /** Transcripts of agents this office started (they end when it stops). */
  ownedTranscripts: () => string[];
}

/** Compose and start the standalone office: same assets/store/runtime/server
 *  wiring regardless of which host (CLI or Electron) is running it. */
export async function startStandaloneOffice(
  opts: StandaloneOfficeOptions,
): Promise<StandaloneOffice> {
  const { host, port, distRoot, packageRoot, staticDir, projectDir } = opts;

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  console.log('[Pixel Agents] Loading assets...');
  const assetCache: AssetCache = await buildAssetCache(
    distRoot,
    readConfig().externalAssetDirectories,
  );
  const charCount = assetCache.characters?.characters.length ?? 0;
  const petCount = assetCache.pets?.pets.length ?? 0;
  const furnitureCount = assetCache.furniture?.catalog.length ?? 0;
  console.log(
    `[Pixel Agents] Assets loaded: ${charCount} characters, ${petCount} pets, ${furnitureCount} furniture items`,
  );

  // ── Store + adapter (shared settings + standalone-scoped agents/seats) ──
  // NOTE: a single connected client already brings this store's
  // 'agentRemoved' subscriber count to 11 (5 subscribers eager in this
  // composition + 5 created lazily on first use + 1 per connected browser
  // window/tab), past Node's default MaxListenersExceededWarning threshold
  // of 10 -- measured, not a leak (every subscriber is removed on its own
  // dispose(); see standaloneOffice.test.ts's compose/dispose regression
  // test). Left uncapped deliberately: whether the warning noise is worth
  // raising the limit is a product call, not made here.
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);

  // ── Create server ──
  const server = new PixelAgentsServer();

  // Claude is the primary provider; Codex, Gemini and Generic HTTP events
  // are routed too (POST /api/hooks/<id>) and become hooks-only agents.
  const runtime = new AgentRuntime(store, claudeProvider, secondaryHookProviders);

  // Wire hook events: HTTP POST -> runtime -> hookEventHandler -> agents
  server.onHookEvent((providerId, event) => {
    runtime.handleHookEvent(providerId, event);
  });

  // onSetHooksEnabled side effect: install/uninstall the named provider's
  // hooks when the user toggles in the UI (or answers the consent ask).
  // Captures config from the outer scope after server.start().
  let currentConfig: { port: number; token: string } | null = null;
  const onSetHooksEnabled = async (providerId: string, enabled: boolean): Promise<void> => {
    if (!currentConfig) return;
    const provider = hookProviderById(providerId);
    if (!provider) return; // unknown id: nothing to install into
    if (enabled) {
      // An explicit toggle in the UI IS the consent to modify the
      // provider's settings file. Each provider copies only its OWN hook
      // script; another provider's install is neither blocked by it nor
      // copies it.
      grantHooksConsent(provider.id);
      if (!copyHookScriptOrReport(provider, packageRoot, ' (user toggle)')) {
        return;
      }
      try {
        await provider.installHooks(`http://127.0.0.1:${currentConfig.port}`, currentConfig.token);
      } catch (err) {
        console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      console.log('[Pixel Agents] Hooks installed (user toggle)');
    } else {
      try {
        await provider.uninstallHooks();
        console.log('[Pixel Agents] Hooks uninstalled (user toggle)');
      } catch (err) {
        console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // onReloadAssets side effect: re-run the shared loaders (bundled + external
  // dirs) after an external-asset-directory change, then re-broadcast the
  // updated sprites to the requesting client. Mutates the assetCache object in
  // place so already-open sockets (which captured the same reference) and
  // future webviewReady handshakes both observe the new assets. Only
  // characters/pets/furniture can come from external dirs, so only those three
  // are reloaded and re-sent (mirrors the VS Code reload path).
  const onReloadAssets: ReloadAssetsSideEffect = async (send): Promise<void> => {
    const externalDirs = readConfig().externalAssetDirectories;
    const [characters, pets, furniture] = await Promise.all([
      loadAllCharacters(distRoot, externalDirs),
      loadAllPets(distRoot, externalDirs),
      loadAllFurniture(distRoot, externalDirs),
    ]);
    assetCache.characters = characters;
    assetCache.pets = pets;
    assetCache.furniture = furniture;
    if (characters) {
      send({ type: 'characterSpritesLoaded', characters: characters.characters });
    }
    if (pets) {
      send({
        type: 'petSpritesLoaded',
        pets: pets.pets,
        petNames: pets.manifests.map((m) => m.name),
      });
    }
    if (furniture) {
      send({
        type: 'furnitureAssetsLoaded',
        catalog: furniture.catalog,
        sprites: Object.fromEntries(furniture.sprites),
      });
    }
    console.log('[Pixel Agents] Assets reloaded (external directory change)');
  };

  // Agents the office runs itself (+ Agent in the browser).
  const officeSessions = new OfficeSessions(store, {
    adoptLaunchedSession: (sessionId, cwd) => runtime.adoptLaunchedSession(sessionId, cwd),
    followPid: (pid, key, cwd) => runtime.followLaunchedPid(pid, key, cwd),
    adoptLaunchedHooksSession: (key, cwd, providerId) =>
      runtime.adoptLaunchedHooksSession(key, cwd, providerId),
    forgetPid: (pid) => runtime.forgetLaunchedPid(pid),
    renameAgent: (id, name) => runtime.renameAgent(id, name),
    setAgentLook: (id, look) => runtime.setAgentLook(id, look),
    removeAgent: (id) => runtime.removeAgent(id),
    refreshSendable: () => runtime.chatSender.refreshSendable(),
    inputReady: (id) => runtime.chatSender.retry(id),
  });
  runtime.chatSender.addWriter(officeSessions.writer);
  // Agents the office started were started to be given work.
  runtime.deskDefaultPickup = (agentId) => officeSessions.owns(agentId);
  runtime.agentStarter = officeSessions;
  const disposeOfficeSessions = (): void => officeSessions.dispose();
  const ownedTranscripts = (): string[] => officeSessions.ownedTranscripts();

  const config = await server.start({
    store,
    runtime,
    embedded: false,
    host,
    port,
    staticDir,
    assetCache,
    onSetHooksEnabled,
    onReloadAssets,
    launchers: runtime.launchers,
    onLauncherPoll: (sessionId, cwd, pid) => {
      if (!pid) return runtime.adoptLaunchedSession(sessionId, cwd);
      // `pixel-office agy`: shown at once, linked to agy's conversation by pid.
      runtime.followLaunchedPid(pid, sessionId, cwd);
      runtime.adoptLaunchedHooksSession(sessionId, cwd, antigravityProvider.id);
    },
    onLauncherEnd: (sessionId) => runtime.endLaunched(sessionId),
    officeSessions,
    taskDesk: () => runtime.desk,
    getBoardPins: () => runtime.board.getPins(),
    saveBoardPin: (pin) => runtime.board.savePin(pin),
    removeBoardPin: (pinId) => runtime.board.removePin(pinId),
    resolveBoardAgent: (name) => {
      const wanted = name.toLowerCase();
      for (const agent of store.values()) {
        if (
          agent.displayName?.toLowerCase() === wanted ||
          agent.agentName?.toLowerCase() === wanted
        ) {
          return agent.id;
        }
      }
      return undefined;
    },
  });
  currentConfig = { port: config.port, token: config.token };

  // Sync runtime refs with persisted settings BEFORE first scan tick. The
  // runtime's single hooksEnabled ref follows the Claude provider until the
  // scanners grow per-provider awareness alongside the Settings UI.
  runtime.hooksEnabled.current = getHooksEnabled(claudeProvider.id);
  runtime.watchAllSessions.current = adapter.getSetting('pixel-agents.watchAllSessions', false);

  // Agents the previous office ran ended with it: keep them from coming back as ghosts.
  runtime.dismissEndedSessions(readEndedSessions());

  // Start scanning for external sessions (Claude running in user's terminal)
  const dirs = claudeProvider.getSessionDirs?.(projectDir);
  if (dirs && dirs[0]) {
    const resolvedProjectDir = dirs[0];
    console.log(`[Pixel Agents] Scanning project dir: ${resolvedProjectDir}`);
    runtime.startProjectScan(resolvedProjectDir);
    runtime.startExternalScanning(resolvedProjectDir);
    runtime.startStaleCheck();
  }

  return { store, runtime, server, config, disposeOfficeSessions, ownedTranscripts };
}

/** No runtime/store/server was built for this result: a compatible standalone
 *  server was already running and this process attached to its config
 *  instead of composing a second, invisible one (see `attachOrStartOffice`). */
export interface OfficeAttachResult {
  mode: 'attach';
  config: ServerConfig;
}

/** `resolveOptions` returned nothing usable (e.g. a folder picker the own
 *  path needs was cancelled) and no live server was found to attach to
 *  either: nothing was built or started. */
export interface OfficeCancelledResult {
  mode: 'cancelled';
}

export type OfficeStartResult =
  OfficeAttachResult | ({ mode: 'own' } & StandaloneOffice) | OfficeCancelledResult;

/**
 * Same composition as `startStandaloneOffice`, but checks the multi-server
 * registry FIRST: if a standalone server (one that serves the SPA) is
 * already running, this process attaches to its `{port, token}` and builds
 * NOTHING of its own -- no `AgentRuntime`, no `AgentStateStore`, no
 * `FileStateAdapter`, no scanners. `PixelAgentsServer.start()` makes this
 * same reuse decision internally, but only after its caller has already
 * built a whole runtime to hand it; this function moves the decision in
 * front of that composition so a caller (the Electron shell) never ends up
 * running a second, dead-weight runtime alongside the server it actually
 * reused.
 *
 * `resolveOptions` is a CALLBACK, not a value, and is invoked only when no
 * live server was found: resolving the options (the project folder, in
 * practice) can involve showing a folder picker, and a caller must not pay
 * for that -- or prompt the user at all -- on the path that ends up
 * attaching instead. Returning `undefined` (a cancelled picker, typically)
 * yields `{ mode: 'cancelled' }` rather than starting a runtime on a guess.
 */
export async function attachOrStartOffice(
  resolveOptions: () =>
    StandaloneOfficeOptions | undefined | Promise<StandaloneOfficeOptions | undefined>,
): Promise<OfficeStartResult> {
  // startStandaloneOffice always starts its server with `embedded: false`,
  // i.e. servesSpa === true -- the same capability a standalone caller reuses.
  const candidate = readAndPruneRegistry().find((entry) => entry.servesSpa === true);
  if (candidate) {
    console.log(
      `[Pixel Agents] Attached to running standalone server on port ${candidate.port} (PID ${candidate.pid}) -- no local runtime`,
    );
    return { mode: 'attach', config: candidate };
  }
  const opts = await resolveOptions();
  if (!opts) {
    console.log(
      '[Pixel Agents] No live standalone server found and folder selection was cancelled -- not starting',
    );
    return { mode: 'cancelled' };
  }
  const office = await startStandaloneOffice(opts);
  console.log(
    `[Pixel Agents] Started own office on port ${office.config.port}, watching ${opts.projectDir}`,
  );
  return { mode: 'own', ...office };
}
