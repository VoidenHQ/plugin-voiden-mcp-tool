/**
 * Tool Verifies Node
 *
 * The verification policy: which other requests (by section label, and
 * optionally a different file) prove this tool works, each labeled
 * happy-path/error-contract/auth-check, with a per-entry mode (live/sandbox/
 * none — matches voiden-mcp-blocks-spec.md §1.9's illustrative shape, where
 * only some entries specify a mode). `onFailure` is the one remaining scalar
 * policy attr that applies to the whole tool, not per-entry.
 *
 * `sandbox` is a label, not a redirection — Voiden runs it exactly like
 * `live`. It only means "the request this row points at already targets a
 * sandbox endpoint, by the author's own choice." Voiden doesn't define
 * what's sandbox vs production, it only calls whatever URL the request has.
 */

import React, { useEffect, useState } from "react";
import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { AddRowButton, FilePickerCell, HeaderRow, RowShell, SelectCell, TextCell } from "../components/Row";
import { useToolCapabilityProvider } from "@/core/tools/toolCapabilityRegistry";
import type { ToolOnFailure, ToolVerifyEntry, ToolVerifyRole, ToolVerifyMode } from "../lib/toolBlocks";

const ROLE_OPTIONS: { value: ToolVerifyRole; label: string }[] = [
  { value: "happy-path", label: "happy path" },
  { value: "error-contract", label: "error contract" },
  { value: "auth-check", label: "auth check" },
];

const MODE_OPTIONS: { value: ToolVerifyMode; label: string }[] = [
  { value: "live", label: "live" },
  { value: "sandbox", label: "sandbox" },
  { value: "none", label: "none" },
];

const ON_FAILURE_OPTIONS: { value: ToolOnFailure; label: string }[] = [
  { value: "withdraw", label: "withdraw from agent" },
  { value: "advertise-degraded", label: "keep, flagged degraded" },
];

// The dropdown's "nothing chosen yet" placeholder needs its own sentinel
// value distinct from "" — "" is now a legitimate, real choice (it's what
// gets saved for a file's unlabeled first section, matching what
// @voiden/executors' parseVoidFileSections() — the real headless engine —
// treats that section's label as; see splitIntoSections()'s own doc comment
// in toolCapabilityElectron.ts). A plain empty-string placeholder would be
// indistinguishable from that real choice in an HTML <select>, so a new row
// starts on this sentinel rather than "" — it fails validation (correctly,
// same as an empty string always did before) until the user actually picks
// a section.
const UNSET_SECTION = "__unset__";

const emptyRow = (): ToolVerifyEntry => ({ filePath: "", sectionLabel: UNSET_SECTION, role: "happy-path", cadence: "", mode: "live" });

/** Human-readable label for a section value in the dropdown — "" (the real,
 *  headless-compatible value for an unlabeled first section) reads as a
 *  blank option otherwise. */
function displaySectionLabel(label: string): string {
  return label === "" ? "(unlabeled — first section)" : label;
}

/** Section labels of the LIVE editor's own doc — same-file case, no I/O
 *  needed. Matches toolCapabilityElectron.ts's splitIntoSections() labeling
 *  convention exactly — first section is "" unless a leading
 *  request-separator sets a custom label, same as the real headless engine. */
function getSameFileSections(editor: any): { index: number; label: string }[] {
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
function SectionLabelCell({
  value, onChange, editor, filePath, disabled,
}: { value: string; onChange: (v: string) => void; editor: any; filePath: string; disabled?: boolean }) {
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
      .getFileSections(filePath)
      .then((sections) => { if (!cancelled) setRemoteSections(sections); })
      .catch(() => { if (!cancelled) setRemoteSections([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filePath, provider]);

  const sections = filePath ? (remoteSections ?? []) : getSameFileSections(editor);
  const known = new Set(sections.map((s) => s.label));
  const placeholder = filePath && loading ? "Loading sections…" : "Select a section…";

  const options = [
    { value: UNSET_SECTION, label: placeholder },
    // Keeps an already-saved value selectable even if it's not (yet, or no
    // longer) among the discovered sections — e.g. sections haven't loaded
    // yet, or the file changed since this row was set up. Never silently
    // blanks out a saved value. (A stale literal like the old "Request 1"
    // default falls here too — it won't match any real section anymore.)
    ...(value !== UNSET_SECTION && !known.has(value) ? [{ value, label: `${value} (not found)` }] : []),
    ...sections.map((s) => ({ value: s.label, label: displaySectionLabel(s.label) })),
  ];

  return (
    <SelectCell
      grow
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled || (!!filePath && loading)}
    />
  );
}

export const createToolVerifiesNode = (NodeViewWrapper: any) => {
  const ToolVerifiesComponent = (props: any) => {
    const isImported = !!props.node.attrs.importedFrom;
    const isEditable = props.editor.isEditable && !isImported;
    const rows: ToolVerifyEntry[] = Array.isArray(props.node.attrs.rows) ? props.node.attrs.rows : [];
    const onFailure: ToolOnFailure = props.node.attrs.onFailure || "withdraw";

    const updateRows = (next: ToolVerifyEntry[]) => props.updateAttributes({ rows: next });
    const updateRow = (i: number, patch: Partial<ToolVerifyEntry>) =>
      updateRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    const removeRow = (i: number) => updateRows(rows.filter((_, idx) => idx !== i));
    const addRow = () => updateRows([...rows, emptyRow()]);

    return (
      <NodeViewWrapper>
        <div className="my-1">
          <div className="bg-panel border-b border-t border-border px-3 py-1.5 flex items-center gap-3 flex-wrap">
            <span className="text-xs text-comment font-medium uppercase tracking-wide">Verification</span>
            <label className="flex items-center gap-1.5 text-xs text-text ml-auto">
              On failure
              <select
                value={onFailure}
                onChange={(e) => props.updateAttributes({ onFailure: e.target.value })}
                disabled={!isEditable}
                className="bg-editor border border-border rounded px-1.5 py-0.5 text-xs font-mono text-text disabled:opacity-50"
              >
                {ON_FAILURE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          {rows.length > 0 && (
            <HeaderRow
              labels={[
                { label: "Section label", grow: true },
                { label: "File (optional)", grow: true },
                { label: "Role", width: 110 },
                { label: "Cadence", width: 90 },
                { label: "Mode", width: 80 },
              ]}
            />
          )}
          {rows.map((row, i) => (
            <RowShell key={i} onRemove={() => removeRow(i)} disabled={!isEditable}>
              <SectionLabelCell value={row.sectionLabel} onChange={(v) => updateRow(i, { sectionLabel: v })} editor={props.editor} filePath={row.filePath || ""} disabled={!isEditable} />
              <FilePickerCell grow value={row.filePath || ""} onChange={(v) => updateRow(i, { filePath: v })} placeholder="defaults to this file" disabled={!isEditable} />
              <SelectCell width={110} value={row.role} onChange={(v) => updateRow(i, { role: v as ToolVerifyRole })} options={ROLE_OPTIONS} disabled={!isEditable} />
              <TextCell width={90} value={row.cadence || ""} onChange={(v) => updateRow(i, { cadence: v })} placeholder="e.g. nightly" disabled={!isEditable} />
              <SelectCell width={80} value={row.mode || "live"} onChange={(v) => updateRow(i, { mode: v as ToolVerifyMode })} options={MODE_OPTIONS} disabled={!isEditable} />
            </RowShell>
          ))}
          {isEditable && <AddRowButton onClick={addRow} label="Add verification request" />}
          {rows.length === 0 && (
            <div className="bg-editor px-3 py-2 text-xs text-comment italic">
              No verification requests attached — this tool will show to agents as "unverified" rather than being hidden.
            </div>
          )}
        </div>
      </NodeViewWrapper>
    );
  };

  return Node.create({
    name: "toolverifies",
    group: "",
    atom: true,
    selectable: true,
    draggable: false,

    addAttributes() {
      return {
        rows: { default: [] },
        onFailure: { default: "withdraw" },
        importedFrom: { default: undefined },
      };
    },

    parseHTML() {
      return [{ tag: "toolverifies" }];
    },

    renderHTML({ HTMLAttributes }) {
      return ["toolverifies", mergeAttributes(HTMLAttributes, { class: "toolverifies-block" })];
    },

    addNodeView() {
      return ReactNodeViewRenderer(ToolVerifiesComponent);
    },
  });
};

export const ToolVerifiesNode = createToolVerifiesNode(({ children }: any) => <div>{children}</div>);
