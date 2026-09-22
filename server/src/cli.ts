#!/usr/bin/env node

/**
 * Standalone CLI entry point: `npx pixel-agents`
 *
 * Starts the Fastify server in standalone mode with SPA serving and WebSocket.
 * Loads all assets (PNGs -> SpriteData) on startup and caches in memory.
 * Each connecting WebSocket client receives the full state on webviewReady.
 */

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import { AgentRuntime } from './agentRuntime.js';
import { runAgentsCommand } from './agentsCli.js';
import { AgentStateStore } from './agentStateStore.js';
import {
  buildAssetCache,
  loadAllCharacters,
  loadAllFurniture,
  loadAllPets,
} from './assetReload.js';
import { runBoardCommand } from './boardCli.js';
import type { AssetCache, ReloadAssetsSideEffect } from './clientMessageHandler.js';
import {
  getHooksConsent,
  getHooksEnabled,
  grantHooksConsent,
  readConfig,
} from './configPersistence.js';
import { MAX_PORT, MIN_PORT } from './constants.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { runLauncher } from './launcher.js';
import { OfficeSessions } from './officeSessions.js';
import { runProposeCommand } from './proposeCli.js';
import {
  activeHookProviders,
  antigravityProvider,
  claudeProvider,
  copyProviderHookScript,
  hookProviderById,
  secondaryHookProviders,
} from './providers/index.js';
import { PixelAgentsServer } from './server.js';
import { runShowCommand } from './showCli.js';
import { runTaskCommand } from './taskCli.js';
import { runWorkflowCommand } from './workflowCli.js';

// ── Argument parsing ──────────────────────────────────────────

export interface CliArgs {
  /** Unset -> ephemeral (OS-assigned) port, so multiple standalone instances
   *  can run at once without a collision. --port picks a fixed one. */
  port?: number;
  host: string;
  /** Open the office in the default browser once it is up (interactive runs only). */
  open: boolean;
}

/** Thrown by parseArgs on an invalid --port. Kept separate from process.exit so
 *  the parsing logic stays a pure, unit-testable function -- main() is the only
 *  place that turns a bad argument into an exit code. */
export class CliArgsError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { host: '127.0.0.1', open: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') {
      const raw = argv[i + 1];
      if (raw === undefined) {
        throw new CliArgsError(
          `Missing value for ${argv[i]}: expected an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
        throw new CliArgsError(
          `Invalid --port "${raw}": must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      args.port = parsed;
      i++;
    } else if (argv[i] === '--no-open') {
      args.open = false;
    } else if (argv[i] === '--lan') {
      args.host = '0.0.0.0';
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--help') {
      console.log(`Usage: pixel-office [options]                 Start the office
       pixel-office <program> [args...]    Run a program through the office launcher,
                                           e.g. pixel-office claude --model opus
                                           (Claude sessions show up in the office and
                                           can be sent messages; other programs run as usual)
       pixel-office task <show|brief|step|done> …  Answer a task desk card (for agents)
       pixel-office agents [--json]         List every agent in the office (any CLI)
       pixel-office board <list|add|rm> …  Read and post to the shared whiteboard
                                           (pixel-office board --help for details)

Options:
  --port, -p <number>   Port to listen on (default: OS-assigned ephemeral port)
  --host <string>       Host to bind to (default: 127.0.0.1)
  --lan                 Listen on your local network too, so a phone on the same Wi-Fi can open it
  --no-open             Don't open the office in your browser
  --help                Show this help message`);
      process.exit(0);
    }
  }
  return args;
}

// ── Hooks consent ─────────────────────────────────────────────
// First-run consent is asked IN THE APP, not here: the server sends a
// hooksConsentRequest to privileged (tokened) connections during the
// webviewReady handshake (clientMessageHandler.ts), and the browser renders
// the dialog — the same UX the VS Code webview shows. The CLI itself never
// prompts; a headless run just starts without hooks until consent is granted
// through the UI. The one exception that needs no dialog is the silent-grant
// migration below (our hooks already installed by a pre-consent version).

/**
 * Copy the provider's bundled hook script into ~/.pixel-agents/hooks/,
 * reporting failure.
 *
 * Callers run this BEFORE installing the settings entries and abort when it
 * returns false: an entry whose command points at a missing script makes the
 * CLI spawn a dead `node` process for every event, which is strictly worse
 * than no hooks at all.
 */
function copyHookScriptOrReport(
  provider: HookProvider,
  packageRoot: string,
  context = '',
): boolean {
  if (copyProviderHookScript(provider, packageRoot)) return true;
  const label = provider.id === claudeProvider.id ? 'Hooks' : `${provider.displayName} hooks`;
  console.error(`[Pixel Agents] ${label} NOT installed${context}: hook script missing.`);
  return false;
}

/**
 * Install one provider's hooks on startup if its persisted preference says so
 * — gated on the one-time consent to modify that CLI's settings file. Runs for
 * every provider whose CLI is present (activeHookProviders); a user without
 * Codex or Gemini never sees a line about them.
 */
async function installHooksAtStartup(
  provider: HookProvider,
  packageRoot: string,
  port: number,
  token: string,
): Promise<void> {
  const isClaude = provider.id === claudeProvider.id;
  const label = isClaude ? 'Hooks' : `${provider.displayName} hooks`;
  if (!getHooksEnabled(provider.id)) {
    // Without this line, a persisted hooks-off makes startup skip the entire
    // consent/install flow with zero output — indistinguishable from a bug.
    console.log(
      isClaude
        ? '[Pixel Agents] Hooks disabled — enable "Instant Detection (Hooks)" in the UI settings to install them.'
        : `[Pixel Agents] ${label} disabled.`,
    );
    return;
  }
  let consent = getHooksConsent(provider.id) === 'granted';
  if (!consent && (await provider.areHooksInstalled().catch(() => false))) {
    // Our hooks are already installed and already firing — a pre-consent
    // version put them there. Grant and continue with NO prompt: the install
    // below only ever REDUCES scope (for Claude it drops UserPromptSubmit and
    // TaskCreated, the two events that forwarded prompt text and were consumed
    // by nothing). Asking would buy this user no protection they do not
    // already have. A fresh install still is asked, in full — in the browser
    // UI, when a tokened client connects (clientMessageHandler's webviewReady).
    grantHooksConsent(provider.id);
    consent = true;
  }
  if (!consent) {
    console.log(
      isClaude
        ? '[Pixel Agents] Hooks not installed: modifying ~/.claude/settings.json needs one-time approval — open the URL below to review and approve it.'
        : `[Pixel Agents] ${label} not installed: they need one-time approval — open the URL below to review and approve them.`,
    );
    return;
  }
  if (!copyHookScriptOrReport(provider, packageRoot)) return;
  try {
    await provider.installHooks(`http://127.0.0.1:${port}`, token);
    console.log(`[Pixel Agents] ${label} installed`);
  } catch (err) {
    console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The office link, boxed so it stands out from the startup logs. */
function printOfficeBanner(url: string): void {
  const lines = ['Pixel Office is ready. Open this link:', url, 'Stop with Ctrl+C.'];
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  const bold = process.stdout.isTTY ? (s: string) => `\x1b[1m${s}\x1b[0m` : (s: string) => s;
  console.log(`  ┌${'─'.repeat(width)}┐`);
  for (const line of lines) {
    const text = line === url ? bold(line) : line;
    console.log(`  │ ${text}${' '.repeat(width - line.length - 1)}│`);
  }
  console.log(`  └${'─'.repeat(width)}┘\n`);
}

/** Open `url` in the default browser; failure is harmless (the link is printed). */
function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no browser available: the printed link is enough */
  }
}

/** This machine's IPv4 addresses on the local network (what a phone on the same Wi-Fi can reach). */
function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  // `pixel-office <program> …` runs the program (Claude today) in a pty the
  // office can type into. Anything that isn't a flag is a program name.
  const first = process.argv[2];
  // `pixel-office board …`: agents read and post to the shared whiteboard.
  if (first === 'board') {
    process.exit(await runBoardCommand(process.argv.slice(3)));
  }
  // `pixel-office agents`: agents list who is in the office (any CLI).
  if (first === 'agents') {
    process.exit(await runAgentsCommand(process.argv.slice(3)));
  }
  // `pixel-office task …`: agents answer the task desk.
  if (first === 'task') {
    process.exit(await runTaskCommand(process.argv.slice(3)));
  }
  // `pixel-office show …`: agents point the user at part of a file.
  if (first === 'show') {
    process.exit(await runShowCommand(process.argv.slice(3)));
  }
  // `pixel-office propose …`: agents suggest changes for the user to review.
  if (first === 'propose') {
    process.exit(await runProposeCommand(process.argv.slice(3)));
  }
  // `pixel-office workflow …`: agents report workflow steps and wait at gates.
  if (first === 'workflow') {
    process.exit(await runWorkflowCommand(process.argv.slice(3)));
  }
  if (first !== undefined && !first.startsWith('-')) {
    await runLauncher(first, process.argv.slice(3));
    return;
  }

  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // dist/ contains both the CLI bundle and the assets/ + webview/ directories
  const distRoot = __dirname;
  const packageRoot = path.dirname(distRoot);
  const staticDir = path.join(distRoot, 'webview');

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  // External asset directories are merged at startup too, so directories added
  // in a previous session survive a restart. buildAssetCache is the shared
  // loader used by both the standalone server and the VS Code adapter.
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
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);

  // ── Create server ──
  const server = new PixelAgentsServer();
  let disposeOfficeSessions = (): void => {};

  try {
    // Create runtime first (before server.start, so we can pass it in)
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
          await provider.installHooks(
            `http://127.0.0.1:${currentConfig.port}`,
            currentConfig.token,
          );
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
      removeAgent: (id) => runtime.removeAgent(id),
      refreshSendable: () => runtime.chatSender.refreshSendable(),
      inputReady: (id) => runtime.chatSender.retry(id),
    });
    runtime.chatSender.addWriter(officeSessions.writer);
    // Agents the office started were started to be given work.
    runtime.deskDefaultPickup = (agentId) => officeSessions.owns(agentId);
    runtime.agentStarter = officeSessions;
    disposeOfficeSessions = () => officeSessions.dispose();

    const config = await server.start({
      store,
      runtime,
      embedded: false,
      host: args.host,
      port: args.port,
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

    // Install hooks on startup, per provider, if the persisted setting says so
    // — each gated on its own one-time consent to modify that CLI's settings.
    for (const provider of activeHookProviders()) {
      await installHooksAtStartup(provider, packageRoot, config.port, config.token);
    }

    // Start scanning for external sessions (Claude running in user's terminal)
    const cwd = process.cwd();
    const dirs = claudeProvider.getSessionDirs?.(cwd);
    if (dirs && dirs[0]) {
      const projectDir = dirs[0];
      console.log(`[Pixel Agents] Scanning project dir: ${projectDir}`);
      runtime.startProjectScan(projectDir);
      runtime.startExternalScanning(projectDir);
      runtime.startStaleCheck();
    }

    // The URL the operator opens has to be REACHABLE (a wildcard bind address
    // is a bind target, not an address you can browse to — `--host 0.0.0.0`
    // used to print a dead `http://0.0.0.0:PORT`) and has to carry the token,
    // which is what makes the session it loads privileged enough to approve a
    // hook install (see standaloneTokenValid in httpServer.ts). Under `--host
    // 0.0.0.0` the office stays readable from the LAN at this machine's own
    // address; only the consent-bearing toggle needs the token.
    const displayHost =
      args.host === '0.0.0.0' || args.host === '::' || args.host === '' ? '127.0.0.1' : args.host;
    const officeUrl = `http://${displayHost}:${config.port}/?token=${config.token}`;
    // Tests and the e2e fixture read this exact line; keep its wording.
    console.log(`\n  Pixel Agents server running at ${officeUrl}\n`);
    printOfficeBanner(officeUrl);
    // Only in an interactive terminal: scripts, tests and CI never get a browser.
    if (args.open && process.stdout.isTTY && !process.env['CI']) openInBrowser(officeUrl);
    if (displayHost !== args.host) {
      const lan = lanAddresses();
      if (lan.length > 0) {
        console.log('  On your phone (same Wi-Fi):');
        for (const address of lan) {
          console.log(`    http://${address}:${config.port}/?token=${config.token}`);
        }
        console.log(
          '\n  Keep these links private: the token lets whoever holds it send messages into your\n' +
            '  Claude sessions and change hook settings. Traffic on the network is not encrypted.\n',
        );
      }
    }

    // ── Graceful shutdown ──
    function shutdown(): void {
      console.log('\nShutting down...');
      disposeOfficeSessions();
      runtime.dispose();
      server.stop();
      process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Only auto-run when this file is executed directly (`node dist/cli.js`), not
// when it's imported for its exports (e.g. `parseArgs` in tests) -- importing
// it unconditionally used to start a real server and install real Claude
// hooks as a side effect of module load.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
