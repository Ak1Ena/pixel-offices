import { useState } from 'react';

import type { LayaModel, LayaStatus } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

const STATE_TEXT: Record<LayaStatus['state'], string> = {
  absent: 'Not downloaded',
  installing: 'Downloading…',
  stopped: 'Downloaded, off',
  starting: 'Starting…',
  running: 'On',
  uninstalling: 'Removing…',
  error: 'Problem',
};

const MODEL_TEXT: Record<LayaModel, string> = {
  auto: 'Auto — English + multilingual, picked per reply',
  english: 'English only (smallest)',
  multilingual: 'Multilingual (100+ languages)',
};

/**
 * Settings → Decision model: the office's own Laya (server/src/layaManager.ts).
 * Off until the user turns it on; turning it on downloads it once into
 * ~/.pixel-agents/laya, Uninstall deletes that folder. Status from useLayaStatus.
 */
export function LayaSettings({ status }: { status: LayaStatus }) {
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const { state, enabled, model } = status;
  const busy = state === 'installing' || state === 'starting' || state === 'uninstalling';
  const downloaded = state !== 'absent' && state !== 'installing' && state !== 'uninstalling';

  return (
    <div
      className="mt-4 pt-8 pb-6 px-10 border-t border-border flex flex-col gap-6"
      data-testid="settings-laya"
    >
      <div className="text-base">Decision model (Laya)</div>
      <span className="text-2xs text-text-muted">
        A small open model (Apache 2.0) that runs on this computer and helps the office read agent
        replies: whether a card is finished, blocked or asking you something, and who an @mention is
        for. Nothing leaves this machine. Turning it on downloads Python packages (PyTorch, about
        1–2 GB) and the model into ~/.pixel-agents/laya. Needs Python 3.10+.
      </span>
      {status.external && (
        <span className="text-2xs text-text-muted">
          Using your own endpoint instead: {status.external}
        </span>
      )}
      <div className="flex items-center gap-8 text-sm">
        <span>
          Status:{' '}
          <span className={state === 'error' ? 'text-status-error' : ''}>{STATE_TEXT[state]}</span>
        </span>
      </div>
      {status.detail && busy && (
        <span className="text-2xs text-text-muted break-all">{status.detail}</span>
      )}
      {status.error && <span className="text-2xs text-status-error">{status.error}</span>}
      <label className="flex items-center gap-8 text-sm" htmlFor="settings-laya-model">
        Language
        <select
          id="settings-laya-model"
          value={model}
          disabled={state === 'uninstalling'}
          onChange={(e) =>
            transport.send({ type: 'setLayaModel', model: e.target.value as LayaModel })
          }
          className="bg-bg-dark text-text border border-border rounded-ui px-4"
        >
          {(Object.keys(MODEL_TEXT) as LayaModel[]).map((m) => (
            <option key={m} value={m}>
              {MODEL_TEXT[m]}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-6">
        {!enabled ? (
          <Button
            size="sm"
            variant={state === 'uninstalling' ? 'disabled' : 'accent'}
            disabled={state === 'uninstalling'}
            onClick={() => transport.send({ type: 'setLayaEnabled', enabled: true })}
          >
            {downloaded ? 'Turn on' : 'Download and turn on'}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => transport.send({ type: 'setLayaEnabled', enabled: false })}
          >
            {state === 'installing' ? 'Turn off after download' : 'Turn off'}
          </Button>
        )}
        {state === 'error' && enabled && (
          <Button
            size="sm"
            onClick={() => transport.send({ type: 'setLayaEnabled', enabled: true })}
          >
            Try again
          </Button>
        )}
        {state !== 'absent' && state !== 'uninstalling' && !confirmUninstall && (
          <Button size="sm" variant="ghost" onClick={() => setConfirmUninstall(true)}>
            Uninstall…
          </Button>
        )}
      </div>
      {confirmUninstall && (
        <div className="flex flex-wrap items-center gap-6 text-sm">
          <span>Delete Laya and its downloaded models?</span>
          <Button
            size="sm"
            onClick={() => {
              setConfirmUninstall(false);
              transport.send({ type: 'uninstallLaya' });
            }}
          >
            Uninstall
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmUninstall(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
