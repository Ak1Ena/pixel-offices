import { useCallback, useEffect, useRef, useState } from 'react';

import type { FolderListing } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

interface FolderPickerProps {
  /** The chosen folder (what + Agent starts in). */
  value: string;
  onChange: (path: string) => void;
  recentFolders: string[];
}

const fieldClass =
  'flex-1 min-w-0 px-8 py-4 bg-bg-dark text-text text-sm border-2 border-border rounded-none outline-none focus:border-accent';

/** Last path segment for the recent-folder chips. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Folder browser for the + Agent dialog: walks this machine's folders through
 * the server (`listFolder` → `folderListing`, privileged, point-to-point).
 * Recent folders stay as one-click picks; the text field is the fallback for
 * typing a path directly (Enter / Go browses to it).
 */
export function FolderPicker({ value, onChange, recentFolders }: FolderPickerProps) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(false);
  // Start where the current choice is; if that folder is gone, fall back to home once.
  const fellBackRef = useRef(false);

  const browse = useCallback((path?: string) => {
    setLoading(true);
    transport.send({ type: 'listFolder', path: path || undefined });
  }, []);

  useEffect(() => {
    return transport.onMessage((msg) => {
      if (msg.type !== 'folderListing') return;
      setLoading(false);
      if (msg.error && !fellBackRef.current && msg.entries.length === 0 && !msg.parent) {
        fellBackRef.current = true;
        browse();
        return;
      }
      fellBackRef.current = true;
      setListing(msg);
    });
  }, [browse]);

  // Initial listing on mount (the modal mounts this when it opens).
  // (The parent prefills `value` in its own effect, after ours — so fall back to the newest recent.)
  const initialRef = useRef(value || recentFolders[0] || '');
  useEffect(() => {
    browse(initialRef.current.trim() || undefined);
  }, [browse]);

  const current = listing?.path ?? '';
  const isChosen = current !== '' && !listing?.error && value.trim() === current;

  return (
    <div className="flex flex-col gap-4" data-testid="folder-picker">
      {recentFolders.length > 0 && (
        <div className="flex flex-wrap gap-4">
          {recentFolders.slice(0, 5).map((f) => (
            <Button
              key={f}
              type="button"
              size="sm"
              variant={value.trim() === f ? 'active' : 'default'}
              title={f}
              onClick={() => {
                onChange(f);
                browse(f);
              }}
            >
              {baseName(f)}
            </Button>
          ))}
        </div>
      )}

      <div className="flex gap-4">
        <Button
          type="button"
          size="sm"
          variant={listing?.parent ? 'default' : 'disabled'}
          disabled={!listing?.parent}
          onClick={() => browse(listing?.parent)}
          data-testid="folder-up"
        >
          Up
        </Button>
        <Button type="button" size="sm" onClick={() => browse()} data-testid="folder-home">
          Home
        </Button>
        <span
          className="flex-1 min-w-0 self-center text-2xs text-text-muted truncate"
          title={current}
          data-testid="folder-current"
        >
          {loading ? 'Loading…' : current}
        </span>
      </div>

      <div
        className="max-h-160 overflow-y-auto bg-bg-dark border-2 border-border flex flex-col"
        data-testid="folder-list"
      >
        {listing?.error ? (
          <span className="px-8 py-4 text-sm text-danger">{listing.error}</span>
        ) : listing && listing.entries.length === 0 ? (
          <span className="px-8 py-4 text-sm text-text-muted">No sub-folders</span>
        ) : (
          listing?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="flex items-center gap-6 px-8 py-2 text-left text-sm bg-transparent border-0 rounded-none cursor-pointer hover:bg-btn-hover"
              onClick={() => browse(entry.path)}
              onDoubleClick={() => onChange(entry.path)}
              title={entry.path}
            >
              <span className="text-text-muted">{'>'}</span>
              <span className="flex-1 min-w-0 truncate">{entry.name}</span>
              {entry.isProject && (
                <span className="text-2xs text-status-success" data-testid="folder-project">
                  project
                </span>
              )}
            </button>
          ))
        )}
      </div>

      <Button
        type="button"
        size="sm"
        variant={isChosen ? 'active' : current && !listing?.error ? 'accent' : 'disabled'}
        disabled={!current || !!listing?.error}
        onClick={() => onChange(current)}
        data-testid="folder-use"
      >
        {isChosen ? 'Using this folder' : 'Use this folder'}
      </Button>

      <div className="flex gap-4">
        <input
          className={fieldClass}
          value={value}
          placeholder="~/code/my-project"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              browse(value.trim() || undefined);
            }
          }}
          data-testid="agent-cwd"
        />
        <Button type="button" size="sm" onClick={() => browse(value.trim() || undefined)}>
          Go
        </Button>
      </div>
    </div>
  );
}
