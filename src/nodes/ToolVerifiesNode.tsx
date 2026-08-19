/**
 * Tool Verifies Node
 *
 * The verification policy: which other requests (by section label, and
 * optionally a different file) prove this tool works, each labeled
 * happy-path/error-contract/auth-check, with a per-entry mode (live/sandbox/
 * none) and a per-entry onFailure — what happens to the WHOLE tool if THIS
 * request fails. Per-entry, not a single tool-wide setting, because
 * different requests can reasonably warrant different consequences (e.g. an
 * auth-check failing might mean "withdraw", a soft error-contract check
 * failing might only mean "flag degraded"). When entries disagree, the most
 * conservative failed one wins — see decideServing() in toolCapability.ts /
 * toolCapabilityElectron.ts.
 *
 * `sandbox` is a label, not a redirection — Voiden runs it exactly like
 * `live`. It only means "the request this row points at already targets a
 * sandbox endpoint, by the author's own choice." Voiden doesn't define
 * what's sandbox vs production, it only calls whatever URL the request has.
 */

import React from "react";
import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { AddRowButton, FilePickerCell, HeaderRow, RowShell, SectionLabelCell, SelectCell, UNSET_SECTION } from "../components/Row";
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
  { value: "withdraw", label: "withdraw" },
  { value: "advertise-degraded", label: "degrade" },
];

// The only 4 values the scheduler actually recognizes (case-insensitive) —
// see CADENCE_MINUTES in toolCapability.ts. Anything else, including a typo
// or a value that looks plausible (the field used to be free text), silently
// falls back to the 60-minute default with no warning anywhere — a fixed
// list here is what prevents that instead of just describing it in a
// placeholder.
const CADENCE_OPTIONS: { value: string; label: string }[] = [
  { value: "hourly", label: "hourly" },
  { value: "daily", label: "daily" },
  { value: "weekly", label: "weekly" },
  { value: "monthly", label: "monthly" },
];

/** Appends the row's current value as an extra, clearly-marked option when
 *  it doesn't match one of the four recognized ones — e.g. a legacy value
 *  saved before this was a fixed list. Without this the <select> would just
 *  silently show nothing selected while still reporting (and running) a
 *  value the scheduler doesn't recognize. */
function cadenceOptionsFor(value: string | undefined): { value: string; label: string }[] {
  if (!value || CADENCE_OPTIONS.some((o) => o.value === value)) return CADENCE_OPTIONS;
  return [...CADENCE_OPTIONS, { value, label: `${value} (unrecognized — runs hourly)` }];
}

// UNSET_SECTION/SectionLabelCell/displaySectionLabel/getSameFileSections
// now live in ../components/Row.tsx — shared with the tool node's own
// request-binding field (Pending #3), which needs the identical "pick a
// real section, not a typed guess" behavior.

const emptyRow = (): ToolVerifyEntry => ({ filePath: "", sectionLabel: UNSET_SECTION, role: "happy-path", cadence: "hourly", mode: "live", onFailure: "withdraw" });

export const createToolVerifiesNode = (NodeViewWrapper: any) => {
  const ToolVerifiesComponent = (props: any) => {
    const isImported = !!props.node.attrs.importedFrom;
    const isEditable = props.editor.isEditable && !isImported;
    const rows: ToolVerifyEntry[] = Array.isArray(props.node.attrs.rows) ? props.node.attrs.rows : [];

    const updateRows = (next: ToolVerifyEntry[]) => props.updateAttributes({ rows: next });
    const updateRow = (i: number, patch: Partial<ToolVerifyEntry>) =>
      updateRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    const removeRow = (i: number) => updateRows(rows.filter((_, idx) => idx !== i));
    const addRow = () => updateRows([...rows, emptyRow()]);

    return (
      <NodeViewWrapper>
        <div className="my-1">
          <div className="bg-panel border-b border-t border-border px-3 py-1.5">
            <span className="text-xs text-comment font-medium uppercase tracking-wide">Verification</span>
          </div>

          {rows.length > 0 && (
            <HeaderRow
              labels={[
                { label: "Section label", grow: true },
                { label: "File (optional)", grow: true },
                { label: "Role", width: 110 },
                { label: "Cadence", width: 90 },
                { label: "Mode", width: 80 },
                { label: "On failure", width: 90 },
              ]}
            />
          )}
          {rows.map((row, i) => (
            <RowShell key={i} onRemove={() => removeRow(i)} disabled={!isEditable}>
              <SectionLabelCell value={row.sectionLabel} onChange={(v) => updateRow(i, { sectionLabel: v })} editor={props.editor} filePath={row.filePath || ""} disabled={!isEditable} />
              <FilePickerCell grow value={row.filePath || ""} onChange={(v) => updateRow(i, { filePath: v })} placeholder="defaults to this file" disabled={!isEditable} ownFilePath={props.editor?.storage?.source} />
              <SelectCell width={110} value={row.role} onChange={(v) => updateRow(i, { role: v as ToolVerifyRole })} options={ROLE_OPTIONS} disabled={!isEditable} />
              <SelectCell width={90} value={row.cadence || "hourly"} onChange={(v) => updateRow(i, { cadence: v })} options={cadenceOptionsFor(row.cadence)} disabled={!isEditable} />
              <SelectCell width={80} value={row.mode || "live"} onChange={(v) => updateRow(i, { mode: v as ToolVerifyMode })} options={MODE_OPTIONS} disabled={!isEditable} />
              <SelectCell width={90} value={row.onFailure || "withdraw"} onChange={(v) => updateRow(i, { onFailure: v as ToolOnFailure })} options={ON_FAILURE_OPTIONS} disabled={!isEditable} />
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
