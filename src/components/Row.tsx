/**
 * Multi-cell row primitives for the toolparams / toolverifies tables.
 *
 * Unlike voiden-advanced-auth's OAuth2Row.tsx (one key/value pair per row,
 * used for a fixed config form), each row here IS one param/verify entry —
 * several fields side by side in a single row. Built fresh rather than reused
 * since the shapes don't match, but keeps the same visual language (border-b
 * divider, hover highlight, text-sm font-mono) plugin tables already use.
 */
import React, { useRef } from "react";
import { FolderOpen, X } from "lucide-react";

const rowClass = "flex hover:bg-muted/50 transition-colors border-b border-border";
const headerRowClass = "flex border-b border-border bg-panel text-xs text-comment uppercase tracking-wide font-medium";
const cellBase = "p-1 px-2 h-7 flex items-center text-sm font-mono border-r border-border shrink-0";

/** Splits a string into plain-text and {{variable}} segments for highlighting. */
function parseVariableSegments(text: string): { text: string; isVar: boolean }[] {
  const segments: { text: string; isVar: boolean }[] = [];
  const regex = /(\{\{[^}]*\}\})/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index), isVar: false });
    segments.push({ text: match[1], isVar: true });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), isVar: false });
  return segments;
}

function HighlightedInput({
  value, onChange, placeholder, disabled,
}: { value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const segments = parseVariableSegments(value);
  const hasVars = segments.some((s) => s.isVar);

  if (!hasVars) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={`w-full bg-transparent text-sm font-mono text-text outline-none placeholder:text-comment/40${disabled ? " opacity-50 cursor-not-allowed" : ""}`}
        spellCheck={false}
      />
    );
  }

  return (
    <div className="relative w-full h-full flex items-center overflow-hidden">
      <div className="absolute inset-0 flex items-center pointer-events-none whitespace-nowrap text-sm font-mono" aria-hidden="true">
        {segments.map((seg, i) =>
          seg.isVar ? (
            <span key={i} className="bg-emerald-400/20 text-emerald-300 rounded-sm px-0.5">{seg.text}</span>
          ) : (
            <span key={i} className="text-transparent">{seg.text}</span>
          ),
        )}
      </div>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={`relative w-full bg-transparent text-sm font-mono outline-none placeholder:text-comment/40 caret-text${disabled ? " opacity-50 cursor-not-allowed" : ""}`}
        spellCheck={false}
        style={{ color: "transparent" }}
      />
      <div className="absolute inset-0 flex items-center pointer-events-none whitespace-nowrap text-sm font-mono" aria-hidden="true">
        {segments.map((seg, i) =>
          seg.isVar ? <span key={i} className="text-transparent">{seg.text}</span> : <span key={i} className="text-text">{seg.text}</span>,
        )}
      </div>
    </div>
  );
}

export function HeaderRow({ labels }: { labels: { label: string; width?: number; grow?: boolean }[] }) {
  return (
    <div className={headerRowClass}>
      {labels.map((l, i) => (
        <div key={i} className={cellBase} style={l.grow ? { flex: 1, minWidth: 0 } : { width: l.width ?? 100 }}>
          {l.label}
        </div>
      ))}
      <div className={cellBase} style={{ width: 32 }} />
    </div>
  );
}

export function TextCell({
  value, onChange, placeholder, disabled, width, grow, highlighted,
}: { value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean; width?: number; grow?: boolean; highlighted?: boolean }) {
  return (
    <div className={`${cellBase} text-text`} style={grow ? { flex: 1, minWidth: 0 } : { width: width ?? 100 }}>
      {highlighted ? (
        <HighlightedInput value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={`w-full bg-transparent text-sm font-mono text-text outline-none placeholder:text-comment/40${disabled ? " opacity-50 cursor-not-allowed" : ""}`}
          spellCheck={false}
        />
      )}
    </div>
  );
}

/** A file field backed by the native OS file picker instead of a typed path
 *  — used for toolverifies' optional cross-file `filePath`. Stores whatever
 *  absolute path the dialog returns, same as every other file path this
 *  system already reads directly (tool.filePath itself is absolute, from
 *  getVoidFiles()) — no relative-path resolution exists for this field
 *  anywhere downstream, so this intentionally doesn't introduce one. */
export function FilePickerCell({
  value, onChange, disabled, grow, width, placeholder,
}: { value: string; onChange: (v: string) => void; disabled?: boolean; grow?: boolean; width?: number; placeholder?: string }) {
  const displayName = value ? value.split(/[\\/]/).pop() : "";

  const pick = async () => {
    if (disabled) return;
    const paths: string[] =
      (await (window as any).electron?.dialog?.openFile?.({
        properties: ["openFile"],
        filters: [{ name: "Voiden files", extensions: ["void"] }],
      })) ?? [];
    if (paths.length > 0) onChange(paths[0]);
  };

  return (
    <div
      className={`${cellBase} text-text gap-1`}
      style={grow ? { flex: 1, minWidth: 0 } : { width: width ?? 100 }}
      title={value || undefined}
    >
      <button
        type="button"
        onClick={() => void pick()}
        disabled={disabled}
        className="flex items-center gap-1 min-w-0 flex-1 text-left disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <FolderOpen size={12} className="shrink-0 text-comment" />
        <span className={`truncate text-sm font-mono ${value ? "text-text" : "text-comment/40"}`}>
          {displayName || placeholder || "defaults to this file"}
        </span>
      </button>
      {value && !disabled && (
        <button
          type="button"
          onClick={() => onChange("")}
          title="Clear — use this tool's own file"
          className="shrink-0 text-comment hover:text-status-error"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

export function SelectCell({
  value, onChange, options, disabled, width, grow,
}: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; disabled?: boolean; width?: number; grow?: boolean }) {
  return (
    <div className={`${cellBase} text-text`} style={grow ? { flex: 1, minWidth: 0 } : { width: width ?? 100 }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`w-full bg-transparent text-sm font-mono outline-none cursor-pointer${disabled ? " opacity-50 cursor-not-allowed" : ""}`}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

export function CheckboxCell({
  checked, onChange, disabled, width,
}: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; width?: number }) {
  return (
    <div className={cellBase} style={{ width: width ?? 80, justifyContent: "center" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="rounded border-stone-700/50"
      />
    </div>
  );
}

export function RowShell({ children, onRemove, disabled }: { children: React.ReactNode; onRemove: () => void; disabled?: boolean }) {
  return (
    <div className={rowClass}>
      {children}
      <button
        onClick={onRemove}
        disabled={disabled}
        title="Remove row"
        className="p-1 px-2 h-7 flex items-center justify-center text-comment hover:text-status-error transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        style={{ width: 32, cursor: disabled ? "not-allowed" : "pointer" }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function AddRowButton({ onClick, disabled, label }: { onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full py-1.5 text-xs text-comment hover:text-text hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      style={{ cursor: disabled ? "not-allowed" : "pointer" }}
    >
      + {label}
    </button>
  );
}
