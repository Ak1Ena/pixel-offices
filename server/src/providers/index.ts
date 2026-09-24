/**
 * Provider registry: re-exports all bundled providers.
 *
 * Adding a new CLI provider:
 *   1. Create `server/src/providers/hook/<cli>/<cli>.ts` implementing HookProvider
 *      (plus its installer, consent copy and hook script under hooks/).
 *   2. Register it below (and its hook script in esbuild.js + package.json files).
 *
 * The adapter (VS Code extension, standalone CLI, etc.) imports from here rather
 * than reaching into each provider directory directly.
 */

import type { HookProvider, ProviderLaunch } from '../../../core/src/provider.js';
import { antigravityProvider, isAntigravityPresent } from './hook/antigravity/antigravity.js';
import { copyHookScript as copyAntigravityHookScript } from './hook/antigravity/antigravityHookInstaller.js';
import { claudeProvider } from './hook/claude/claude.js';
import { copyHookScript as copyClaudeHookScript } from './hook/claude/claudeHookInstaller.js';
import { codexProvider, isCodexPresent } from './hook/codex/codex.js';
import { copyHookScript as copyCodexHookScript } from './hook/codex/codexHookInstaller.js';
import { geminiProvider, isGeminiPresent } from './hook/gemini/gemini.js';
import { copyHookScript as copyGeminiHookScript } from './hook/gemini/geminiHookInstaller.js';
import { genericProvider } from './hook/generic/generic.js';

export { antigravityProvider, claudeProvider, codexProvider, geminiProvider, genericProvider };
/** Claude's hook script copy (kept for existing callers; see copyProviderHookScript). */
export { copyClaudeHookScript as copyHookScript };

/** Every bundled provider that installs hooks into a CLI's settings, in
 *  registration order. `hooksConsentResponse` / `setHooksEnabled` resolve
 *  their provider id against it (hookProviderById). */
export const hookProviders: readonly HookProvider[] = [
  claudeProvider,
  codexProvider,
  geminiProvider,
  antigravityProvider,
];

/** Providers whose events the runtime routes but which install nothing
 *  (the Generic HTTP provider). Never part of the consent loop. */
const routeOnlyProviders: readonly HookProvider[] = [genericProvider];

/** Whether a provider's CLI looks present on this machine. Claude is always
 *  considered present (it is the primary provider and the office's home). */
const presence: Record<string, () => boolean> = {
  [codexProvider.id]: isCodexPresent,
  [geminiProvider.id]: isGeminiPresent,
  [antigravityProvider.id]: isAntigravityPresent,
};

/**
 * The providers to ASK about and install at startup: every hook provider
 * whose CLI config dir exists (~/.codex, ~/.gemini). Evaluated per call, so a
 * CLI installed while the office runs is picked up on the next handshake, and
 * a user without Codex or Gemini is never asked about them.
 */
export function activeHookProviders(): HookProvider[] {
  return hookProviders.filter((p) => presence[p.id]?.() ?? true);
}

/** Resolve a wire-supplied provider id, or undefined for an unknown one —
 *  the caller writes nothing on undefined (fail-closed, like a junk choice). */
export function hookProviderById(id: unknown): HookProvider | undefined {
  return typeof id === 'string' ? hookProviders.find((p) => p.id === id) : undefined;
}

/** Every provider whose hook events the runtime accepts, besides the primary
 *  one passed to AgentRuntime (Claude): events POSTed to
 *  /api/hooks/<id> for any other id are dropped. */
export const secondaryHookProviders: readonly HookProvider[] = [
  codexProvider,
  geminiProvider,
  antigravityProvider,
  ...routeOnlyProviders,
];

const scriptCopiers: Record<string, (packageRoot: string) => boolean> = {
  [claudeProvider.id]: copyClaudeHookScript,
  [codexProvider.id]: copyCodexHookScript,
  [geminiProvider.id]: copyGeminiHookScript,
  [antigravityProvider.id]: copyAntigravityHookScript,
};

/**
 * Copy the provider's bundled hook script into ~/.pixel-agents/hooks/ BEFORE
 * its settings entries are written. Returns false when the copy failed —
 * callers must then abort the install: an entry pointing at a missing script
 * makes the CLI spawn a dead `node` per event. A provider without a script
 * (generic) returns true.
 */
export function copyProviderHookScript(provider: HookProvider, packageRoot: string): boolean {
  const copy = scriptCopiers[provider.id];
  return copy ? copy(packageRoot) : true;
}

/** A provider that can start and address a CLI session (see ProviderLaunch). */
export type LaunchableProvider = HookProvider & { launch: ProviderLaunch };

/** Every provider in `providers` that can launch a CLI, in registration order. */
export function launchableProviders(
  providers: readonly HookProvider[] = hookProviders,
): LaunchableProvider[] {
  return providers.filter((p): p is LaunchableProvider => p.launch !== undefined);
}

/** The first provider among `providers` whose `launch.claims(program, args)`
 *  is true — the CLI a `pixel-office <program>` (or +Agent start) command
 *  runs, or undefined when none of them track it. A new CLI is a provider
 *  entry here, never an if-branch: this loop is the only caller of `claims`. */
export function launcherFor(
  providers: readonly HookProvider[],
  program: string,
  args: string[],
): LaunchableProvider | undefined {
  return launchableProviders(providers).find((p) => p.launch.claims(program, args));
}

/** Tool names every provider animates as "reading" — sent to the webview once
 *  (providerCapabilities), since tool names are provider-specific. */
export function allReadingTools(): string[] {
  const names = new Set<string>();
  for (const p of [...hookProviders, ...routeOnlyProviders]) {
    for (const t of p.readingTools) names.add(t);
  }
  return [...names];
}
