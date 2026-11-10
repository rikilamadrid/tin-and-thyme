// Inputs that keep a local draft and commit on blur / Enter, so the mock
// isn't updated on every keystroke.

import { useEffect, useState } from "react";

interface Props {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
  list?: string;
  multiline?: boolean;
  type?: string;
  maxLength?: number;
}

export function CommitInput({ value, onCommit, multiline, ...rest }: Props) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  if (multiline)
    return <textarea {...rest} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />;
  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

/** Editable list of short strings (domains), shown as removable chips. */
export function ChipList({
  items,
  onChange,
  placeholder,
  validate,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  validate?: (v: string) => string | null;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const v = draft.trim().toLowerCase();
    if (!v) return;
    const err = validate?.(v) ?? (items.includes(v) ? "Already in the list" : null);
    if (err) return setError(err);
    onChange([...items, v]);
    setDraft("");
    setError(null);
  };
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {items.length === 0 && <span className="text-[13px] text-muted">None</span>}
        {items.map((d) => (
          <span key={d} className="chip font-term text-[15px]">
            {d}
            <button className="ml-1 text-[12px] leading-none" aria-label={`Remove ${d}`} onClick={() => onChange(items.filter((x) => x !== d))}>
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className="field"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => (setDraft(e.target.value), setError(null))}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
        />
        <button className="btn" onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      {error && <div className="mt-1 text-[12px] text-[#ff7a9c]">{error}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className="btn flex items-center gap-2 px-2 text-[14px]" role="switch" aria-checked={checked} aria-pressed={checked} onClick={() => onChange(!checked)}>
      <span className="inline-block h-3 w-3 border-2 border-line" style={{ background: checked ? "#00e436" : "#fff" }} />
      {label}
    </button>
  );
}

export const isDomain = (v: string) =>
  /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?$/.test(v) || /^host\.docker\.internal(:\d+)?$/.test(v) || /^localhost(:\d+)?$/.test(v)
    ? null
    : "Enter a domain like registry.npmjs.org or *.example.com";
