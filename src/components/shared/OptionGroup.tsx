interface Option<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

interface OptionGroupProps<T extends string> {
  label: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
}

/** Compact choices shared by Settings and session setup. */
export default function OptionGroup<T extends string>({ label, value, options, onChange }: OptionGroupProps<T>) {
  return (
    <div className="option-group" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`option-card option-card--compact ${option.value === value ? "selected" : ""}`}
          aria-pressed={option.value === value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
