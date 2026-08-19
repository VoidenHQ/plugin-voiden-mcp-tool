/**
 * Multi-cell row primitives for the toolparams / toolverifies tables.
 *
 * Unlike voiden-advanced-auth's OAuth2Row.tsx (one key/value pair per row,
 * used for a fixed config form), each row here IS one param/verify entry —
 * several fields side by side in a single row. Built fresh rather than reused
 * since the shapes don't match, but keeps the same visual language (border-b
 * divider, hover highlight, text-sm font-mono) plugin tables already use.
 */
import React, { useEffect, useRef, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { useToolCapabilityProvider } from "@/core/tools/toolCapabilityRegistry";

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
 *  — used for toolverifies' optional cross-file `filePath`. The OS dialog
 *  always returns an absolute path, but that's not what gets stored: it's
 *  saved relative to the project root that actually OWNS the file this
 *  block itself lives in (falling back to absolute only when there's no
 *  project root to be relative to, or the picked file lives outside it) so
 *  the reference survives being cloned to a different machine — a cloud VM,
 *  a teammate's laptop — where the original absolute path is meaningless.
 *  Whatever's stored here resolves back to absolute wherever it's actually
 *  read: toolCapabilityElectron.ts in-app, resolvePath() in the headless
 *  CI/cloud path (toolCapability.ts) — both resolve against the SAME
 *  project root (the block's own file's), so this has to match. Absolute
 *  paths saved before this fix still work unchanged — resolution is a
 *  no-op on them.
 *
 *  `directories.getActive()` (the sidebar's currently-selected project) is
 *  deliberately NOT the primary source for that root: nothing requires the
 *  file this block lives in to belong to whatever project happens to be
 *  active, and it may not even be a "known" open directory at all (e.g.
 *  opened standalone via File > Open, not as part of an opened project
 *  folder) — using it produced a silent, wrong project root, and thus a
 *  "starts with .." relative path that always fell back to absolute.
 *  `ownFilePath` (this block's own containing file, passed down from the
 *  node view) is walked upward looking for the nearest `.voiden` marker —
 *  the actual owning project, independent of sidebar selection — and only
 *  falls back to getActive() when that's unavailable (e.g. an unsaved,
 *  never-written-to-disk document with no path yet). */
export function FilePickerCell({
  value, onChange, disabled, grow, width, placeholder, ownFilePath,
}: { value: string; onChange: (v: string) => void; disabled?: boolean; grow?: boolean; width?: number; placeholder?: string; ownFilePath?: string }) {
  const displayName = value ? value.split(/[\\/]/).pop() : "";

  const pick = async () => {
    if (disabled) return;
    const paths: string[] =
      (await (window as any).electron?.dialog?.openFile?.({
        properties: ["openFile"],
        filters: [{ name: "Voiden files", extensions: ["void"] }],
      })) ?? [];
    if (paths.length === 0) return;
    const absolute = paths[0];
    const projectRoot: string | null =
      (ownFilePath ? await (window as any).electron?.path?.findProjectRoot?.(ownFilePath) : null) ??
      (await (window as any).electron?.directories?.getActive?.());
    if (!projectRoot) {
      onChange(absolute);
      return;
    }
    const relative: string | undefined = await (window as any).electron?.path?.toRelative?.(projectRoot, absolute);
    // A relative path starting with ".." means the file is outside the
    // project root — still technically resolvable, but not "portable" in
    // any meaningful sense (it depends on directory structure above the
    // project on this specific machine), so keep the absolute path instead
    // of storing something misleadingly relative-looking.
    onChange(relative && !relative.startsWith("..") ? relative : absolute);
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

// ─── Section picking — shared between toolverifies rows and the tool
// node's own request-binding field (Pending #3), both need "pick a real
// section of a file, not a typed guess". ────────────────────────────────

// The dropdown's "nothing chosen yet" placeholder needs its own sentinel
// value distinct from "" — "" is a legitimate, real choice (it's what gets
// saved for a file's unlabeled first section, matching what
// @voiden/executors' parseVoidFileSections() — the real headless engine —
// treats that section's label as). A plain empty-string placeholder would
// be indistinguishable from that real choice in an HTML <select>, so a
// not-yet-picked field starts on this sentinel rather than "".
export const UNSET_SECTION = "__unset__";

/** Human-readable label for a section value in the dropdown — "" (the real,
 *  headless-compatible value for an unlabeled first section) reads as a
 *  blank option otherwise. */
export function displaySectionLabel(label: string): string {
  return label === "" ? "(unlabeled — first section)" : label;
}

/** Section labels of the LIVE editor's own doc — same-file case, no I/O
 *  needed. Matches toolCapabilityElectron.ts's splitIntoSections() labeling
 *  convention exactly — first section is "" unless a leading
 *  request-separator sets a custom label, same as the real headless engine. */
export function getSameFileSections(editor: any): { index: number; label: string }[] {
  const doc = editor?.state?.doc;
  const sections: { index: number; label: string }[] = [{ index: 0, label: "" }];
  if (!doc) return sections;
  doc.forEach((node: any) => {
    if (node.type?.name === "request-separator") {
      sections.push({ index: sections.length, label: node.attrs?.label || `Request ${sections.length + 1}` });
    }
  });
  return sections;
}

/** A dropdown of a file's REAL sections instead of a free-typed label — the
 *  same-file case reads the live editor doc directly (sync, no I/O); a
 *  cross-file pick (via FilePickerCell) fetches the target file's sections
 *  through the registered tool-capability provider. Either way, a picked
 *  value is guaranteed to actually exist, unlike a typed guess. */
export function SectionLabelCell({
  value, onChange, editor, filePath, disabled, grow = true,
}: { value: string; onChange: (v: string) => void; editor: any; filePath: string; disabled?: boolean; grow?: boolean }) {
  const provider = useToolCapabilityProvider();
  const [remoteSections, setRemoteSections] = useState<{ index: number; label: string }[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!filePath) {
      setRemoteSections(null);
      return;
    }
    if (!provider) return;
    setLoading(true);
    provider
      .getFileSections(filePath, editor?.storage?.source)
      .then((sections) => { if (!cancelled) setRemoteSections(sections); })
      .catch(() => { if (!cancelled) setRemoteSections([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filePath, provider, editor]);

  const sections = filePath ? (remoteSections ?? []) : getSameFileSections(editor);
  const known = new Set(sections.map((s) => s.label));
  const placeholder = filePath && loading ? "Loading sections…" : "Select a section…";

  const options = [
    { value: UNSET_SECTION, label: placeholder },
    // Keeps an already-saved value selectable even if it's not (yet, or no
    // longer) among the discovered sections — e.g. sections haven't loaded
    // yet, or the file changed since this row was set up. Never silently
    // blanks out a saved value.
    ...(value !== UNSET_SECTION && !known.has(value) ? [{ value, label: `${value} (not found)` }] : []),
    ...sections.map((s) => ({ value: s.label, label: displaySectionLabel(s.label) })),
  ];

  return (
    <SelectCell
      grow={grow}
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled || (!!filePath && loading)}
    />
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
