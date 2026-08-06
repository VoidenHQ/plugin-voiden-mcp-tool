/**
 * Tool Params Node
 *
 * One row per agent-callable parameter. Stored as attrs.rows (not a nested
 * TipTap table) — the same format runtime-variables blocks already moved to,
 * since a plain 2-column table can't hold typed/dropdown fields per row.
 */

import React from "react";
import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { AddRowButton, CheckboxCell, HeaderRow, RowShell, SelectCell, TextCell } from "../components/Row";
import type { ToolParamDef, ToolParamType } from "../lib/toolBlocks";

const TYPE_OPTIONS: { value: ToolParamType; label: string }[] = [
  { value: "string", label: "string" },
  { value: "number", label: "number" },
  { value: "integer", label: "integer" },
  { value: "boolean", label: "boolean" },
  { value: "object", label: "object" },
  { value: "array", label: "array" },
];

const SOURCE_OPTIONS = [
  { value: "environment", label: "environment" },
  { value: "agent", label: "agent" },
];

const emptyRow = (): ToolParamDef => ({ name: "", binds: "", type: "string", required: false, description: "", source: "environment" });

export const createToolParamsNode = (NodeViewWrapper: any) => {
  const ToolParamsComponent = (props: any) => {
    const isImported = !!props.node.attrs.importedFrom;
    const isEditable = props.editor.isEditable && !isImported;
    const rows: ToolParamDef[] = Array.isArray(props.node.attrs.rows) ? props.node.attrs.rows : [];

    const updateRows = (next: ToolParamDef[]) => props.updateAttributes({ rows: next });
    const updateRow = (i: number, patch: Partial<ToolParamDef>) =>
      updateRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    const removeRow = (i: number) => updateRows(rows.filter((_, idx) => idx !== i));
    const addRow = () => updateRows([...rows, emptyRow()]);

    return (
      <NodeViewWrapper>
        <div className="my-1">
          <div className="bg-panel border-b border-t border-border px-3 py-1 text-xs text-comment font-medium uppercase tracking-wide">
            Parameters
          </div>
          {rows.length > 0 && (
            <HeaderRow
              labels={[
                { label: "Name", width: 110 },
                { label: "Binds", grow: true },
                { label: "Type", width: 90 },
                { label: "Req.", width: 48 },
                { label: "Description", grow: true },
                { label: "Source", width: 100 },
              ]}
            />
          )}
          {rows.map((row, i) => (
            <RowShell key={i} onRemove={() => removeRow(i)} disabled={!isEditable}>
              <TextCell width={110} value={row.name} onChange={(v) => updateRow(i, { name: v })} placeholder="email" disabled={!isEditable} />
              <TextCell grow highlighted value={row.binds} onChange={(v) => updateRow(i, { binds: v })} placeholder="{{customer_email}}" disabled={!isEditable} />
              <SelectCell width={90} value={row.type} onChange={(v) => updateRow(i, { type: v as ToolParamType })} options={TYPE_OPTIONS} disabled={!isEditable} />
              <CheckboxCell width={48} checked={row.required} onChange={(v) => updateRow(i, { required: v })} disabled={!isEditable} />
              <TextCell grow value={row.description || ""} onChange={(v) => updateRow(i, { description: v })} placeholder="What the agent should pass here" disabled={!isEditable} />
              <SelectCell width={100} value={row.source} onChange={(v) => updateRow(i, { source: v as any })} options={SOURCE_OPTIONS} disabled={!isEditable} />
            </RowShell>
          ))}
          {isEditable && <AddRowButton onClick={addRow} label="Add parameter" />}
        </div>
      </NodeViewWrapper>
    );
  };

  return Node.create({
    name: "toolparams",
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
      return [{ tag: "toolparams" }];
    },

    renderHTML({ HTMLAttributes }) {
      return ["toolparams", mergeAttributes(HTMLAttributes, { class: "toolparams-block" })];
    },

    addNodeView() {
      return ReactNodeViewRenderer(ToolParamsComponent);
    },
  });
};

export const ToolParamsNode = createToolParamsNode(({ children }: any) => <div>{children}</div>);
