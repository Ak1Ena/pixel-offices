import type { ModelOption } from '../../../core/src/messages.js';

interface ModelSelectProps {
  /** The provider's picker options as last read (`modelOptions`); empty = none read yet. */
  options: ModelOption[];
  /** A picker label, '' = the CLI's own default. */
  value: string;
  onChange: (label: string) => void;
  className: string;
}

/**
 * The model a new agent starts on, from its CLI's own model picker (read off
 * an office-run agent's screen), never a list kept in the office. The office
 * picks it in the new agent's picker (this session only) before its first message.
 */
export function ModelSelect({ options, value, onChange, className }: ModelSelectProps) {
  return (
    <div className="flex flex-col gap-2">
      <select
        className={className}
        value={value}
        aria-label="Model"
        onChange={(e) => onChange(e.target.value)}
        data-testid="start-model"
      >
        <option value="">The CLI's default model</option>
        {options.map((o) => (
          <option key={o.number} value={o.label} title={o.detail}>
            {o.label}
            {o.detail ? ` — ${o.detail}` : ''}
          </option>
        ))}
      </select>
      {options.length === 0 && (
        <span className="text-2xs text-text-muted">
          More models show up here once an agent the office runs has read its model list (its chat
          card ⋯ → Agent settings → Show models).
        </span>
      )}
    </div>
  );
}
