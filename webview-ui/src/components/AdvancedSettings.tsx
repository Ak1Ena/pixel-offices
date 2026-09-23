import { useEffect, useState } from 'react';

import { useTunables } from '../hooks/useTunables.js';
import type { TunableDef, TunableKey } from '../tunables.js';
import { clampTunable, TUNABLE_GROUPS, TUNABLE_KEYS, TUNABLES } from '../tunables.js';
import { resetAllTunables, resetTunable, setTunable } from '../tunableStore.js';
import { Button } from './ui/Button.js';

/** Stored value → what the field shows (fractions as percentages). */
function toShown(def: TunableDef, value: number): string {
  const v = def.percent ? value * 100 : value;
  return String(Math.round(v * 100) / 100);
}

function TunableRow({ id, value }: { id: TunableKey; value: number }) {
  const def: TunableDef = TUNABLES[id];
  const [draft, setDraft] = useState(() => toShown(def, value));
  // Follow outside changes (Reset, Reset all) while not mid-typing a different number.
  useEffect(() => setDraft(toShown(def, value)), [def, value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(n)) {
      setDraft(toShown(def, value));
      return;
    }
    const kept = clampTunable(def, def.percent ? n / 100 : n);
    setTunable(id, kept);
    setDraft(toShown(def, kept));
  };
  const scale = def.percent ? 100 : 1;
  const changed = value !== def.default;
  return (
    <div className="flex flex-col gap-2 py-4" data-testid={`tunable-${id}`}>
      <div className="flex items-center gap-6">
        <label htmlFor={`tunable-${id}`} className="flex-1 min-w-0 text-sm">
          {def.label}
        </label>
        <input
          id={`tunable-${id}`}
          type="number"
          inputMode="decimal"
          min={def.min * scale}
          max={def.max * scale}
          step={def.step * scale}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
          }}
          className="w-96 shrink-0 px-4 py-1 bg-bg-dark border-2 border-border text-sm text-text text-right"
        />
        <span className="w-56 shrink-0 text-2xs text-text-muted">{def.unit}</span>
        <Button
          size="sm"
          variant={changed ? 'default' : 'disabled'}
          disabled={!changed}
          onClick={() => resetTunable(id)}
          className="shrink-0"
          aria-label={`Reset ${def.label}`}
          title={`Reset to ${toShown(def, def.default)}${def.unit === '%' ? '%' : ` ${def.unit}`}`}
        >
          Reset
        </Button>
      </div>
      <span className="text-read-sm font-reading text-text-muted">{def.description}</span>
    </div>
  );
}

/**
 * Settings → Advanced: every user-facing tunable (tunables.ts), grouped, with a
 * per-item and an all-items reset. Collapsed by default so Settings stays short.
 */
export function AdvancedSettings() {
  const values = useTunables();
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<(typeof TUNABLE_GROUPS)[number]['id']>(TUNABLE_GROUPS[0].id);
  const changedCount = TUNABLE_KEYS.filter((k) => values[k] !== TUNABLES[k].default).length;
  return (
    <div className="px-10 py-6 border-t border-border" data-testid="settings-advanced">
      <button
        className="flex items-center justify-between w-full p-0 bg-transparent border-0 cursor-pointer text-base text-text"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>
          {open ? '▾' : '▸'} Advanced
          {changedCount > 0 && (
            <span className="ml-8 text-2xs text-text-muted">{changedCount} changed</span>
          )}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-6 mt-6 w-full max-w-560">
          <div className="flex flex-wrap gap-4" role="tablist">
            {TUNABLE_GROUPS.map((g) => (
              <Button
                key={g.id}
                size="sm"
                role="tab"
                aria-selected={group === g.id}
                variant={group === g.id ? 'active' : 'default'}
                onClick={() => setGroup(g.id)}
              >
                {g.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-col">
            {TUNABLE_KEYS.filter((k) => TUNABLES[k].group === group).map((k) => (
              <TunableRow key={k} id={k} value={values[k]} />
            ))}
          </div>
          <Button
            size="sm"
            variant={changedCount > 0 ? 'default' : 'disabled'}
            disabled={changedCount === 0}
            className="self-start"
            onClick={resetAllTunables}
          >
            Reset all
          </Button>
        </div>
      )}
    </div>
  );
}
