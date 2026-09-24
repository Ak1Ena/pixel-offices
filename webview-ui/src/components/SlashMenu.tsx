import { useEffect, useState } from 'react';

import { SLASH_MENU_MAX_ITEMS } from '../constants.js';
import { matchCommands, slashQuery } from '../slashMenu.js';

export interface SlashCommandList {
  commands: string[];
  loading: boolean;
  error?: string;
}

/**
 * The CLI-style `/` menu for a chat box. Returns the menu to render (above
 * the box) and a key handler to run first in the box's onKeyDown: while the
 * menu is open, ↑/↓ move, Tab/Enter complete the command, Esc closes.
 */
export function useSlashMenu({
  draft,
  setDraft,
  list,
  onNeedList,
}: {
  draft: string;
  setDraft: (text: string) => void;
  list: SlashCommandList | undefined;
  /** Ask for the list (called once the user starts a `/` command and none is loaded). */
  onNeedList?: () => void;
}): { menu: React.ReactNode; onKeyDown: (e: React.KeyboardEvent) => boolean } {
  const query = slashQuery(draft);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const items =
    query === null || !list ? [] : matchCommands(list.commands, query, SLASH_MENU_MAX_ITEMS);
  const open = query !== null && dismissed !== draft && !!onNeedList;

  useEffect(() => {
    if (query !== null && !list && onNeedList) onNeedList();
  }, [query !== null, list]); // eslint-disable-line react-hooks/exhaustive-deps -- ask once per `/` start
  useEffect(() => setIndex(0), [query]);

  const pick = (name: string) => setDraft(`/${name} `);

  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(draft);
      return true;
    }
    if (items.length === 0) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setIndex((i) => (i + step + items.length) % items.length);
      return true;
    }
    const exact = items[index] === query;
    // Enter on a command already typed in full sends it; otherwise it completes.
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !exact)) {
      e.preventDefault();
      pick(items[Math.min(index, items.length - 1)]);
      return true;
    }
    return false;
  };

  const menu = open ? (
    <div
      className="absolute bottom-full left-0 right-0 mb-4 max-h-240 overflow-y-auto pixel-panel p-4 flex flex-col z-20"
      role="listbox"
      aria-label="Commands"
      data-testid="slash-menu"
    >
      {list?.loading && items.length === 0 && (
        <span className="text-2xs text-text-muted p-4">Asking the agent for its commands…</span>
      )}
      {list?.error && <span className="text-2xs text-danger p-4">{list.error}</span>}
      {!list?.loading && !list?.error && items.length === 0 && (
        <span className="text-2xs text-text-muted p-4">No command matches.</span>
      )}
      {items.map((name, i) => (
        <button
          key={name}
          role="option"
          aria-selected={i === index}
          className={`text-left px-6 py-2 border-0 cursor-pointer font-mono text-code-sm ${
            i === index ? 'bg-active-bg text-text' : 'bg-transparent text-text-muted'
          }`}
          onMouseDown={(e) => {
            // Keep focus in the box.
            e.preventDefault();
            pick(name);
          }}
          onMouseEnter={() => setIndex(i)}
        >
          /{name}
        </button>
      ))}
    </div>
  ) : null;

  return { menu, onKeyDown };
}
