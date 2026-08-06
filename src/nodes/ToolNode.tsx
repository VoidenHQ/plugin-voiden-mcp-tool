/**
 * Tool Node (Container)
 *
 * Non-atom container for toolparams + toolverifies child nodes, plus the
 * agent-facing identity fields (name/title/description/annotations) rendered
 * directly in its own header — these are simple scalars, not worth a fourth
 * child block type.
 */

import React from "react";
import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewContent, ReactNodeViewRenderer } from "@tiptap/react";

const fieldLabelClass = "text-xs text-comment font-medium uppercase tracking-wide shrink-0";
const inputClass =
  "flex-1 px-2 py-1 bg-editor border border-border rounded text-sm text-text font-mono focus:outline-none focus:border-accent disabled:opacity-50";
const rowClass = "bg-panel border-b border-border px-3 py-1.5 flex items-center gap-2";

export const createToolNode = (NodeViewWrapper: any, RequestBlockHeader: any) => {
  const ToolComponent = (props: any) => {
    const isImported = !!props.node.attrs.importedFrom;
    const isEditable = props.editor.isEditable && !isImported;
    const { name, title, description, annotations = {} } = props.node.attrs;

    const setAttr = (key: string, value: any) => props.updateAttributes({ [key]: value });
    const setAnnotation = (key: string, value: boolean) =>
      props.updateAttributes({ annotations: { ...annotations, [key]: value } });

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
            />
          </div>

          <div className={rowClass}>
            <span className={fieldLabelClass} style={{ width: 90 }}>Title</span>
            <input
              type="text"
              value={title || ""}
              onChange={(e) => setAttr("title", e.target.value)}
              disabled={!isEditable}
              placeholder="e.g. Create Customer"
              className={inputClass}
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
            <span className="text-[10px] text-comment italic ml-auto">documentation hints, not enforced</span>
          </div>

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
