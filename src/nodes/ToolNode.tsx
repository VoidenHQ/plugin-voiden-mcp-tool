/**
 * Tool Node (Container)
 *
 * Non-atom container for toolparams + toolverifies child nodes, plus the
 * agent-facing identity fields (name/title/description/annotations) and the
 * request binding (Pending #3 — defaults to the sibling request in this
 * section; optionally pick a different section/file instead) rendered
 * directly in its own header — simple scalars, not worth extra block types.
 */

import React, { useState } from "react";
import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewContent, ReactNodeViewRenderer } from "@tiptap/react";
import { Wand2 } from "lucide-react";
import { FilePickerCell, SectionLabelCell, UNSET_SECTION } from "../components/Row";
import { getSectionBlocksAtPos, getSectionBlocksByLabel } from "../lib/toolBlocks";
import { useToolCapabilityProvider } from "@/core/tools/toolCapabilityRegistry";
import type { ToolParamDef } from "../lib/toolBlocks";

const fieldLabelClass = "text-xs text-comment font-medium uppercase tracking-wide shrink-0";
const inputClass =
  "flex-1 px-2 py-1 bg-editor border border-border rounded text-sm text-text font-mono focus:outline-none focus:border-accent disabled:opacity-50";
const rowClass = "bg-panel border-b border-border px-3 py-1.5 flex items-center gap-2";

const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;

function extractPlaceholders(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(PLACEHOLDER_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[1].trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      found.push(token);
    }
  }
  return found;
}

// Header/query/path param tables a `{{token}}` might live in — each is a
// real TipTap table (Key/Value/optional Description columns), same schema
// voiden-rest-api's own getTable() reads (getRequestFromJson.ts). Read
// directly here instead of importing that helper, since it's core-app code
// this plugin has no dependency on.
const PARAM_TABLE_TYPES: { type: string; label: string }[] = [
  { type: "headers-table", label: "Header" },
  { type: "query-table", label: "Query parameter" },
  { type: "path-table", label: "Path parameter" },
];

function cellText(cellNode: any): string {
  return (cellNode?.content?.[0]?.content?.[0]?.text || "").trim();
}

/** Maps every `{{token}}` found in a header/query/path table's Value column
 *  to a description for the new tool-param row: the row's own Description
 *  column text when the request already has one written, otherwise a
 *  generated "Header: X-Api-Key"-style fallback — either way, no longer the
 *  blank string auto-populate used to leave for these three table kinds. */
function collectTableParamDescriptions(blocks: any[]): Map<string, string> {
  const descriptions = new Map<string, string>();
  for (const { type, label } of PARAM_TABLE_TYPES) {
    const tableRoot = blocks.find((b) => b.type === type);
    const table = tableRoot?.content?.find((n: any) => n.type === "table");
    for (const row of table?.content ?? []) {
      if (row.type !== "tableRow") continue;
      const cells = (row.content ?? []).filter((c: any) => c.type === "tableCell");
      const key = cellText(cells[0]);
      const value = cellText(cells[1]);
      const ownDescription = cellText(cells[2]);
      if (!value) continue;
      for (const token of extractPlaceholders(value)) {
        descriptions.set(token, ownDescription || `${label}: ${key}`);
      }
    }
  }
  return descriptions;
}

const newParamRow = (token: string, description: string): ToolParamDef => ({
  name: token,
  binds: token,
  type: "string",
  required: true,
  description,
  source: "agent",
});

export const createToolNode = (NodeViewWrapper: any, RequestBlockHeader: any) => {
  const ToolComponent = (props: any) => {
    const isImported = !!props.node.attrs.importedFrom;
    const isEditable = props.editor.isEditable && !isImported;
    const { name, title, description, annotations = {}, requestFilePath, requestSectionLabel } = props.node.attrs;
    const [autoPopulateError, setAutoPopulateError] = useState<string | null>(null);
    const provider = useToolCapabilityProvider();

    const setAttr = (key: string, value: any) => props.updateAttributes({ [key]: value });
    const setAnnotation = (key: string, value: boolean) =>
      props.updateAttributes({ annotations: { ...annotations, [key]: value } });

    // requestSectionLabel: null/undefined = "not bound, use the sibling
    // request in this section" (default/original behavior). Once a section
    // is picked, it's a real string (including "" for an unlabeled first
    // section) — see toolBlocks.ts's ToolBlockConfig for the full contract.
    const isBound = requestSectionLabel !== null && requestSectionLabel !== undefined;
    const sectionValue = isBound ? requestSectionLabel : UNSET_SECTION;

    const setBoundSection = (v: string) => {
      if (v === UNSET_SECTION) {
        props.updateAttributes({ requestFilePath: "", requestSectionLabel: null });
      } else {
        props.updateAttributes({ requestSectionLabel: v });
      }
    };

    // Finds the child `toolparams` node and merges new rows into it via a
    // direct ProseMirror transaction — updateAttributes() only targets this
    // (the `tool`) node itself, not its children, so a parent-triggered
    // child update needs the transaction API directly. `tool`'s own content
    // is fixed as "(toolparams toolverifies)?" (see addAttributes below),
    // so toolparams — when present — is always the first child.
    const mergeIntoToolParams = (newTokens: string[], descriptions: Map<string, string>) => {
      const { editor, node, getPos } = props;
      const toolPos = typeof getPos === "function" ? getPos() : undefined;
      if (toolPos == null) return;

      let childPos = -1;
      let childNode: any = null;
      node.forEach((child: any, offset: number) => {
        if (childNode) return;
        if (child.type.name === "toolparams") {
          childNode = child;
          childPos = toolPos + 1 + offset;
        }
      });
      if (!childNode || childPos < 0) return;

      const existingRows: ToolParamDef[] = Array.isArray(childNode.attrs.rows) ? childNode.attrs.rows : [];
      const existingBinds = new Set(existingRows.map((r) => r.binds));
      const toAdd = newTokens.filter((t) => !existingBinds.has(t));
      if (toAdd.length === 0) return;

      const nextRows = [...existingRows, ...toAdd.map((t) => newParamRow(t, descriptions.get(t) || ""))];
      editor.view.dispatch(editor.view.state.tr.setNodeMarkup(childPos, undefined, { ...childNode.attrs, rows: nextRows }));
    };

    const handleAutoPopulate = async () => {
      setAutoPopulateError(null);
      try {
        let blocks: any[] | null = null;
        if (isBound && requestFilePath) {
          // Cross-file — that file may not be open in any editor tab, so
          // this goes through the tool-capability provider (reads from
          // disk) instead of a live editor doc.
          blocks = provider ? await provider.getSectionBlocks(requestFilePath, requestSectionLabel, props.editor?.storage?.source) : null;
        } else if (isBound) {
          // Bound to a different section of THIS SAME file — no I/O
          // needed, read straight from the live editor doc by label.
          blocks = getSectionBlocksByLabel(props.editor.state.doc, requestSectionLabel);
        } else {
          const toolPos = typeof props.getPos === "function" ? props.getPos() : undefined;
          if (toolPos != null) blocks = getSectionBlocksAtPos(props.editor.state.doc, toolPos);
        }

        if (!blocks) {
          setAutoPopulateError("Could not read the bound request — check the file/section picked above.");
          return;
        }

        const tokens = extractPlaceholders(JSON.stringify(blocks));
        if (tokens.length === 0) {
          setAutoPopulateError("No {{placeholders}} found in that request — nothing to add.");
          return;
        }
        mergeIntoToolParams(tokens, collectTableParamDescriptions(blocks));
      } catch (err: any) {
        setAutoPopulateError(err?.message ?? "Auto-populate failed.");
      }
    };

    return (
      <NodeViewWrapper>
        <div className="my-2 overflow-hidden border border-border rounded">
          <RequestBlockHeader
            title="TOOL"
            withBorder={false}
            editor={props.editor}
            importedDocumentId={props.node.attrs.importedFrom}
            blockType="tool"
          />

          <div className={rowClass}>
            <span className={fieldLabelClass} style={{ width: 90 }}>Name</span>
            <input
              type="text"
              value={name || ""}
              onChange={(e) => setAttr("name", e.target.value)}
              disabled={!isEditable}
              placeholder="e.g. create_customer"
              className={inputClass}
              style={{ flex: 1 }}
            />
            <span className={fieldLabelClass} style={{ width: 60 }}>Title</span>
            <input
              type="text"
              value={title || ""}
              onChange={(e) => setAttr("title", e.target.value)}
              disabled={!isEditable}
              placeholder="Human-readable label (optional)"
              className={inputClass}
              style={{ flex: 1 }}
            />
          </div>

          <div className={rowClass} style={{ alignItems: "flex-start" }}>
            <span className={fieldLabelClass} style={{ width: 90, paddingTop: 4 }}>Description</span>
            <textarea
              value={description || ""}
              onChange={(e) => setAttr("description", e.target.value)}
              disabled={!isEditable}
              placeholder="What this does and when an agent should call it — this is what the agent reads to decide."
              rows={2}
              className={inputClass + " resize-y"}
            />
          </div>

          <div className={rowClass}>
            <span className={fieldLabelClass} style={{ width: 90 }}>Request</span>
            {isBound ? (
              <>
                <FilePickerCell grow value={requestFilePath || ""} onChange={(v) => setAttr("requestFilePath", v)} placeholder="this file" disabled={!isEditable} ownFilePath={props.editor?.storage?.source} />
                <SectionLabelCell value={sectionValue} onChange={setBoundSection} editor={props.editor} filePath={requestFilePath || ""} disabled={!isEditable} grow />
              </>
            ) : (
              <>
                <span className="flex-1 text-sm text-comment italic px-2 py-1">the request in this section</span>
                {isEditable && (
                  <button
                    type="button"
                    onClick={() => setBoundSection("")}
                    className="text-xs text-comment hover:text-text underline decoration-dotted shrink-0"
                  >
                    bind a different request…
                  </button>
                )}
              </>
            )}
          </div>

          <div className={rowClass + " flex-wrap"}>
            <span className={fieldLabelClass} style={{ width: 90 }}>Annotations</span>
            {[
              { key: "readOnlyHint", label: "Read-only" },
              { key: "destructiveHint", label: "Destructive" },
              { key: "idempotentHint", label: "Idempotent" },
              { key: "openWorldHint", label: "Open-world" },
            ].map((a) => (
              <label key={a.key} className="flex items-center gap-1.5 text-xs text-text cursor-pointer select-none mr-3">
                <input
                  type="checkbox"
                  checked={!!annotations[a.key]}
                  onChange={(e) => setAnnotation(a.key, e.target.checked)}
                  disabled={!isEditable}
                  className="rounded border-stone-700/50"
                />
                {a.label}
              </label>
            ))}
            {isEditable && (
              <button
                type="button"
                onClick={() => void handleAutoPopulate()}
                title="Scan the bound request for {{placeholders}} and add a parameter row for each one not already declared"
                className="ml-auto flex items-center gap-1 text-xs text-comment hover:text-text px-1.5 py-0.5 rounded hover:bg-muted/50"
              >
                <Wand2 size={12} /> Auto-populate params
              </button>
            )}
          </div>
          {autoPopulateError && (
            <div className="bg-editor px-3 py-1 text-xs text-status-error">{autoPopulateError}</div>
          )}

          <NodeViewContent />
        </div>
      </NodeViewWrapper>
    );
  };

  return Node.create({
    name: "tool",
    group: "block",
    content: "(toolparams toolverifies)?",
    atom: false,
    isolating: true,
    selectable: true,
    draggable: false,

    addAttributes() {
      return {
        importedFrom: { default: undefined },
        name: { default: "" },
        title: { default: "" },
        description: { default: "" },
        annotations: { default: {} },
        requestUid: { default: "" },
        // Manual override, independent of verification state — flips to
        // false via the MCP tab's Serve preview "Remove" action. Read fresh
        // every time by decideServing(), never cached; see toolCapability.ts
        // / toolCapabilityElectron.ts.
        enabled: { default: true },
        // Cross-file/cross-section request binding (Pending #3) — see
        // toolBlocks.ts's ToolBlockConfig for the full contract.
        // requestSectionLabel: null (not even "") means "not bound".
        requestFilePath: { default: "" },
        requestSectionLabel: { default: null },
      };
    },

    parseHTML() {
      return [{ tag: "tool" }];
    },

    renderHTML({ HTMLAttributes }) {
      return ["tool", mergeAttributes(HTMLAttributes), 0];
    },

    addNodeView() {
      return ReactNodeViewRenderer(ToolComponent);
    },

    addKeyboardShortcuts() {
      return {
        Backspace: ({ editor }) => {
          const { selection } = editor.state;
          const node = selection.$from.node();
          if (node?.type.name === "tool") return true;
          return false;
        },
        Delete: ({ editor }) => {
          const { selection } = editor.state;
          const node = selection.$from.node();
          if (node?.type.name === "tool") return true;
          return false;
        },
      };
    },
  });
};

export const ToolNode = createToolNode(
  ({ children }: any) => <div>{children}</div>,
  () => <div>Header not available</div>,
);
