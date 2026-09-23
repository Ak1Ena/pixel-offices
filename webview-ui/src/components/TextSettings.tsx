import { useTextPrefs } from '../hooks/useTextPrefs.js';
import { READING_FONTS, TEXT_SIZES, UI_FONTS } from '../textPrefs.js';
import { Button } from './ui/Button.js';

interface Choice<T extends string> {
  id: T;
  label: string;
}

function Segmented<T extends string>({
  label,
  choices,
  value,
  onPick,
  testId,
}: {
  label: string;
  choices: ReadonlyArray<Choice<T>>;
  value: T;
  onPick: (id: T) => void;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <span className="text-xs text-text-muted">{label}</span>
      <span className="flex" role="radiogroup" aria-label={label}>
        {choices.map((c) => (
          <Button
            key={c.id}
            size="sm"
            role="radio"
            aria-checked={value === c.id}
            variant={value === c.id ? 'active' : 'default'}
            className="flex-1 px-4"
            onClick={() => onPick(c.id)}
          >
            {c.label}
          </Button>
        ))}
      </span>
    </div>
  );
}

/**
 * The viewer's text settings (textPrefs.ts). Settings shows all three; the
 * Messenger's reading menu shows the two that shape messages (`compact`), bound
 * to the same store, so the two places always agree.
 */
export function TextSettings({ compact = false }: { compact?: boolean }) {
  const [prefs, setPrefs] = useTextPrefs();
  return (
    <div className="flex flex-col gap-8">
      <Segmented
        label="Text size"
        choices={TEXT_SIZES.map((s) => ({ id: s.id, label: compact ? s.short : s.label }))}
        value={prefs.size}
        onPick={(size) => setPrefs({ size })}
        testId="text-size"
      />
      <Segmented
        label="Message font"
        choices={READING_FONTS}
        value={prefs.readingFont}
        onPick={(readingFont) => setPrefs({ readingFont })}
        testId="text-reading-font"
      />
      {!compact && (
        <Segmented
          label="Interface font"
          choices={UI_FONTS}
          value={prefs.uiFont}
          onPick={(uiFont) => setPrefs({ uiFont })}
          testId="text-ui-font"
        />
      )}
      {!compact && (
        <p className="m-0 text-read-sm font-reading text-text-muted">
          Messages and replies read in this font.
        </p>
      )}
    </div>
  );
}
