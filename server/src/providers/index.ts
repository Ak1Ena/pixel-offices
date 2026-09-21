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

import type { HookProvider } from '../../../core/src/provider.js';
import { claudeProvider } from './hook/claude/claude.js';
import { copyHookScript as copyClaudeHookScript } from './hook/claude/claudeHookInstaller.js';
import { codexProvider, isCodexPresent } from './hook/codex/codex.js';
import { copyHookScript as copyCodexHookScript } from './hook/codex/codexHookInstaller.js';
import { geminiProvider, isGeminiPresent } from './hook/gemini/gemini.js';
import { copyHookScript as copyGeminiHookScript } from './hook/gemini/geminiHookInstaller.js';
import { genericProvider } from './hook/generic/generic.js';

export { claudeProvider, codexProvider, geminiProvider, genericProvider };
/** Claude's hook script copy (kept for existing callers; see copyProviderHookScript). */
export { copyClaudeHookScript as copyHookScript };

/** Every bundled provider that installs hooks into a CLI's settings, in
 *  registration order. `hooksConsentResponse` / `setHooksEnabled` resolve
 *  their provider id against it (hookProviderById). */
export const hookProviders: readonly HookProvider[] = [
  claudeProvider,
  codexProvider,
  geminiProvider,
];

/** Providers whose events the runtime routes but which install nothing
 *  (the Generic HTTP provider). Never part of the consent loop. */
const routeOnlyProviders: readonly HookProvider[] = [genericProvider];

/** Whether a provider's CLI looks present on this machine. Claude is always
 *  considered present (it is the primary provider and the office's home). */
const presence: Record<string, () => boolean> = {
  [codexProvider.id]: isCodexPresent,
  [geminiProvider.id]: isGeminiPresent,
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
  ...routeOnlyProviders,
];

const scriptCopiers: Record<string, (packageRoot: string) => boolean> = {
  [claudeProvider.id]: copyClaudeHookScript,
  [codexProvider.id]: copyCodexHookScript,
  [geminiProvider.id]: copyGeminiHookScript,
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

/** Tool names every provider animates as "reading" — sent to the webview once
 *  (providerCapabilities), since tool names are provider-specific. */
export function allReadingTools(): string[] {
  const names = new Set<string>();
  for (const p of [...hookProviders, ...routeOnlyProviders]) {
    for (const t of p.readingTools) names.add(t);
  }
  return [...names];
}
