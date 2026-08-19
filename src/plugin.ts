/**
 * Voiden Tool Plugin
 *
 * Marks an existing request as a named, described, agent-callable tool.
 * Unlike voiden-mcp-client, this plugin never builds/sends a request itself —
 * it only annotates one that already exists in the same section — so there's
 * no context.onBuildRequest hook here at all.
 */

import type { CorePluginContext } from '@voiden/sdk/ui';
type PluginContext = CorePluginContext;
import { findSiblingRequestUid, getSectionBlocksAtPos } from './lib/toolBlocks';
import { createElectronToolCapability } from './lib/toolCapabilityElectron';
import manifest from '../manifest.json';

export default function createToolPlugin(context: PluginContext) {
  return {
    onload: async () => {
      const { NodeViewWrapper, RequestBlockHeader } = context.ui.components;

      const { createToolNode, createToolParamsNode, createToolVerifiesNode } = await import('./nodes');

      const ToolNode = createToolNode(NodeViewWrapper, RequestBlockHeader);
      const ToolParamsNode = createToolParamsNode(NodeViewWrapper);
      const ToolVerifiesNode = createToolVerifiesNode(NodeViewWrapper);

      context.registerVoidenExtension(ToolNode);
      context.registerVoidenExtension(ToolParamsNode);
      context.registerVoidenExtension(ToolVerifiesNode);

      context.registerLinkableNodeTypes(['tool', 'toolparams', 'toolverifies']);

      const DOCS_URL = "https://docs.voiden.md/docs/core-features-section/voiden-blocks/tool";
      (context as any).registerBlockOutlineMeta({
        tool: { label: "Tool", icon: "Wrench", docsUrl: DOCS_URL },
        'toolparams': { label: "Parameters", icon: "ListTree", docsUrl: DOCS_URL },
        'toolverifies': { label: "Verification", icon: "ShieldCheck", docsUrl: DOCS_URL },
      });

      (context as any).registerBlockHelp?.({
        tool: (await import('./help')).ToolHelp,
      });

      context.addVoidenSlashGroup({
        name: 'tool',
        title: 'Tool',
        commands: [
          {
            name: 'tool',
            label: 'Tool Declaration',
            aliases: ['tool'],
            compareKeys: ['tool'],
            singleton: true,
            slash: '/tool',
            description: 'Mark the request in this section as an agent-callable tool',
            action: (editor: any) => {
              if (!editor) return;

              // Best-effort sibling lookup: scan the current section (bounded by
              // request-separator nodes) for a known request-container block so
              // the inserted tool auto-links to requestUid instead of requiring
              // a manual pick. Not load-bearing — verification runs by
              // (filePath, sectionLabel), not this uid; see lib/toolBlocks.ts.
              const cursorPos = editor.state.selection.$from.pos;
              const sectionBlocks = getSectionBlocksAtPos(editor.state.doc, cursorPos);
              const requestUid = findSiblingRequestUid(sectionBlocks) || '';

              editor
                .chain()
                .focus()
                .insertContent([
                  {
                    type: 'tool',
                    attrs: { requestUid },
                    content: [
                      { type: 'toolparams', attrs: { rows: [] } },
                      { type: 'toolverifies', attrs: { rows: [] } },
                    ],
                  },
                  { type: 'paragraph' },
                ])
                .run();
            },
          },
        ],
      });

      // Renderer-native discover/validate/verify/plan-served — no longer
      // powers an in-app "MCP tab" (removed; that preview duplicated what
      // `@voiden/server --check` already reports from the CLI, the actual
      // source of truth now that publishing/serving lives in its own
      // package). Still registered because ToolNode.tsx's request-binding
      // picker and "Auto-populate params" button depend on this provider's
      // getFileSections()/getSectionBlocks() (see components/Row.tsx's
      // SectionLabelCell). Separate from runner.ts's headless registration
      // (CLI-only) — see toolCapabilityElectron.ts's own header comment for
      // why this isn't shared.
      const capability = createElectronToolCapability({
        getVoidFiles: () => context.project.getVoidFiles(),
        readFile: (path: string) => context.files.read(path),
        findNode: (doc: any, nodeName: string) => (context as any).helpers?.requestUtils?.findNode?.(doc, nodeName),
      });
      (context as any).registerToolCapabilityProvider?.(capability);
    },

    metadata: manifest,
  };
}
