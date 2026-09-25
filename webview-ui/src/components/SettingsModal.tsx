import { useRef, useState } from 'react';

import type { DocEditMode } from '../../../core/src/messages.js';
import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { AdvancedSettings } from './AdvancedSettings.js';
import { TextSettings } from './TextSettings.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';
import { MenuItem } from './ui/MenuItem.js';
import { Modal } from './ui/Modal.js';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  /** 3D office view (the default; off = the pixel view). Per viewer, in localStorage. */
  is3DView?: boolean;
  onToggle3DView?: () => void;
  alwaysShowOverlay: boolean;
  onToggleAlwaysShowOverlay: () => void;
  /** Whether headless agents (adopted, no terminal to focus) render translucent. */
  ghostHeadlessAgents: boolean;
  onToggleGhostHeadlessAgents: () => void;
  externalAssetDirectories: string[];
  watchAllSessions: boolean;
  onToggleWatchAllSessions: () => void;
  /** ACTUAL install state (the hooksStatus message), not the hooksEnabled
   *  preference. The preference defaults to true while first-run consent is
   *  still pending, so binding the checkbox to it renders "on" over an empty
   *  ~/.claude/settings.json. */
  hooksInstalled: boolean;
  onToggleHooksEnabled: () => void;
  /** Whether the areas overlay is rendered outside of the Areas edit tool. */
  showAreas: boolean;
  onToggleShowAreas: () => void;
  /** Hide the Show Areas checkbox entirely when areas are unavailable. */
  showAreasAvailable: boolean;
  /** Browser-native layout export (standalone only; VS Code uses the host save dialog). */
  onExportLayout: () => void;
  /** Browser-native layout import from a chosen file (standalone only). */
  onImportLayout: (file: File) => void;
  /** Switch to the bundled City Office layout (an undoable edit). */
  onUseCityOffice: () => void;
  /** Switch back to the office the app ships with (an undoable edit). */
  onUseOriginalOffice: () => void;
  /** Replay the welcome tour (it shows by itself only once). */
  onShowIntro: () => void;
  /** What agents' document edits do unless an agent has its own setting; absent = not offered. */
  docEditDefault?: DocEditMode;
  onDocEditDefault?: (mode: DocEditMode) => void;
}

export function SettingsModal({
  isOpen,
  onClose,
  isDebugMode,
  onToggleDebugMode,
  is3DView,
  onToggle3DView,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
  ghostHeadlessAgents,
  onToggleGhostHeadlessAgents,
  externalAssetDirectories,
  watchAllSessions,
  onToggleWatchAllSessions,
  hooksInstalled,
  onToggleHooksEnabled,
  showAreas,
  onToggleShowAreas,
  showAreasAvailable,
  onExportLayout,
  onImportLayout,
  onUseCityOffice,
  onUseOriginalOffice,
  onShowIntro,
  docEditDefault,
  onDocEditDefault,
}: SettingsModalProps) {
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assetDirDraft, setAssetDirDraft] = useState('');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Settings"
      className="max-h-[90vh] overflow-y-auto"
    >
      {/* Open Sessions Folder opens an OS file manager — impossible in the browser. */}
      {!isBrowserRuntime && (
        <MenuItem
          onClick={() => {
            transport.send({ type: 'openSessionsFolder' });
            onClose();
          }}
        >
          Open Sessions Folder
        </MenuItem>
      )}
      <MenuItem
        onClick={() => {
          if (isBrowserRuntime) {
            onExportLayout();
          } else {
            transport.send({ type: 'exportLayout' });
          }
          onClose();
        }}
      >
        Export Layout
      </MenuItem>
      <MenuItem
        onClick={() => {
          if (isBrowserRuntime) {
            // Open the native file picker; the import is applied in onChange below.
            fileInputRef.current?.click();
          } else {
            transport.send({ type: 'importLayout' });
            onClose();
          }
        }}
      >
        Import Layout
      </MenuItem>
      <MenuItem
        onClick={() => {
          onUseCityOffice();
          onClose();
        }}
      >
        Use City Office Layout
      </MenuItem>
      <MenuItem
        onClick={() => {
          onUseOriginalOffice();
          onClose();
        }}
      >
        Use Original Office Layout
      </MenuItem>
      <MenuItem
        onClick={() => {
          onShowIntro();
          onClose();
        }}
      >
        Show Welcome Tour
      </MenuItem>
      {isBrowserRuntime && (
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset the value so re-selecting the same file fires change again.
            e.target.value = '';
            if (file) {
              onImportLayout(file);
              onClose();
            }
          }}
        />
      )}
      {/* Browser has no native directory picker, so accept a typed absolute path. */}
      {isBrowserRuntime ? (
        <div className="flex items-center gap-4 py-4 px-10">
          <input
            type="text"
            value={assetDirDraft}
            placeholder="Absolute asset directory path"
            onChange={(e) => setAssetDirDraft(e.target.value)}
            className="flex-1 min-w-0 text-xs py-2 px-4 bg-bg border border-border rounded-ui text-text"
          />
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              const path = assetDirDraft.trim();
              if (!path) return;
              transport.send({ type: 'addExternalAssetDirectory', path });
              setAssetDirDraft('');
            }}
            className="shrink-0"
          >
            Add
          </Button>
        </div>
      ) : (
        <MenuItem
          onClick={() => {
            transport.send({ type: 'addExternalAssetDirectory' });
            onClose();
          }}
        >
          Add Asset Directory
        </MenuItem>
      )}
      {externalAssetDirectories.map((dir) => (
        <div key={dir} className="flex items-center justify-between py-4 px-10 gap-8">
          <span
            className="text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap"
            title={dir}
          >
            {dir.split(/[/\\]/).pop() ?? dir}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => transport.send({ type: 'removeExternalAssetDirectory', path: dir })}
            className="shrink-0"
          >
            x
          </Button>
        </div>
      ))}
      <Checkbox
        label="Sound Notifications"
        checked={soundLocal}
        onChange={() => {
          const newVal = !isSoundEnabled();
          setSoundEnabled(newVal);
          setSoundLocal(newVal);
          transport.send({ type: 'setSoundEnabled', enabled: newVal });
        }}
      />
      <Checkbox
        label="Watch All Sessions"
        checked={watchAllSessions}
        onChange={onToggleWatchAllSessions}
      />
      <Checkbox
        label="Instant Detection (Hooks)"
        checked={hooksInstalled}
        onChange={onToggleHooksEnabled}
      />
      <Checkbox
        label="Always Show Labels"
        checked={alwaysShowOverlay}
        onChange={onToggleAlwaysShowOverlay}
      />
      {/* Headless agents are the office's only terminal-less citizens in VS Code.
          Standalone has no terminals at all, so nothing there would ever ghost. */}
      {!isBrowserRuntime && (
        <Checkbox
          label="Display Headless as Ghosts"
          checked={ghostHeadlessAgents}
          onChange={onToggleGhostHeadlessAgents}
        />
      )}
      {showAreasAvailable && (
        <Checkbox label="Show Areas" checked={showAreas} onChange={onToggleShowAreas} />
      )}
      {onToggle3DView && (
        <Checkbox label="3D Office" checked={!!is3DView} onChange={onToggle3DView} />
      )}
      <Checkbox label="Debug View" checked={isDebugMode} onChange={onToggleDebugMode} />
      {docEditDefault && onDocEditDefault && (
        <div
          className="mt-4 pt-8 pb-6 px-10 border-t border-border flex flex-col gap-6"
          data-testid="settings-doc-edits"
        >
          <div className="text-base">Agents editing documents</div>
          <label className="flex items-center gap-8 text-sm" htmlFor="settings-doc-edit-default">
            Default for new agents
            <select
              id="settings-doc-edit-default"
              value={docEditDefault}
              onChange={(e) => onDocEditDefault(e.target.value as DocEditMode)}
              className="bg-bg-dark text-text border border-border rounded-ui px-4"
            >
              <option value="ask">Ask before applying</option>
              <option value="auto">Auto-accept</option>
              <option value="off">Read only</option>
            </select>
          </label>
          <span className="text-2xs text-text-muted">
            Word, PowerPoint and Excel edits from `pixel-office doc edit`. Change it per agent in
            its chat card (⚙).
          </span>
        </div>
      )}
      <div className="mt-4 pt-8 pb-6 px-10 border-t border-border" data-testid="settings-text">
        <div className="text-base mb-6">Text</div>
        <TextSettings />
      </div>
      <AdvancedSettings />
    </Modal>
  );
}
