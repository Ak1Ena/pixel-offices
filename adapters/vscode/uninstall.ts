/**
 * `vscode:uninstall` hook (see package.json scripts) — VS Code executes this
 * with plain Node after the extension has been fully uninstalled. The `vscode`
 * module does not exist here; only Node APIs are available.
 *
 * Removes the Pixel Agents hook entries from ~/.claude/settings.json (and
 * ~/.codex/hooks.json, ~/.gemini/settings.json) so an uninstalled extension
 * leaves no hooks running behind the user's back. The
 * copied hook script under ~/.pixel-agents/hooks/ is left in place: the
 * standalone CLI shares it and re-adds its own entries on next run.
 */
import { resetHooksConfig } from '../../server/src/configPersistence.js';
import { uninstallHooks as uninstallClaudeHooks } from '../../server/src/providers/hook/claude/claudeHookInstaller.js';
import { uninstallHooks as uninstallCodexHooks } from '../../server/src/providers/hook/codex/codexHookInstaller.js';
import { uninstallHooks as uninstallGeminiHooks } from '../../server/src/providers/hook/gemini/geminiHookInstaller.js';

// There is no UI to surface errors to after uninstall — log and exit cleanly
// (an unhandledRejection here would just be noise in VS Code's uninstall flow).
// Each provider independently: one unreadable file must not strand the others.
// A provider whose file has none of our entries writes nothing.
Promise.allSettled(
  [uninstallClaudeHooks, uninstallCodexHooks, uninstallGeminiHooks].map((uninstall) =>
    uninstall().catch((err: unknown) => {
      console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
    }),
  ),
).finally(() => {
  resetHooksConfig();
});
