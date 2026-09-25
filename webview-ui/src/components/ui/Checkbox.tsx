interface CheckboxProps {
  checked: boolean;
  onChange: () => void;
  label: string;
  className?: string;
}

export function Checkbox({ checked, onChange, label, className = '' }: CheckboxProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`flex items-center justify-between w-full py-6 px-10 bg-transparent border-none rounded-ui cursor-pointer text-left hover:bg-btn-bg ${className}`}
    >
      <span>{label}</span>
      <span
        aria-hidden="true"
        className={`relative w-34 h-20 rounded-full shrink-0 transition-colors ${checked ? 'bg-accent' : 'bg-bg-thumb'}`}
      >
        <span
          className={`absolute top-2 w-16 h-16 rounded-full bg-text transition-all ${checked ? 'left-16' : 'left-2'}`}
        />
      </span>
    </button>
  );
}
