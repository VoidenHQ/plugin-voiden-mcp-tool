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
import { Plug } from 'lucide-react';
import { findSiblingRequestUid } from './lib/toolBlocks';
import { createElectronToolCapability } from './lib/toolCapabilityElectron';
import McpScreen from './components/McpScreen';
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
              // Same section-bounding approach voiden-mcp-client's
              // McpOperationNode.tsx uses (getSectionSiblings).
              const cursorPos = editor.state.selection.$from.pos;
              const doc = editor.state.doc;
              const topLevel: Array<{ type: string; node: any; pos: number }> = [];
              doc.forEach((node: any, p: number) => topLevel.push({ type: node.type.name, node, pos: p }));

              let ourIdx = -1;
              for (let i = 0; i < topLevel.length; i++) {
                const { pos: p, node } = topLevel[i];
                if (cursorPos >= p && cursorPos < p + node.nodeSize) { ourIdx = i; break; }
              }

              let sectionBlocks: any[] = [];
              if (ourIdx !== -1) {
                let start = ourIdx;
                while (start > 0 && topLevel[start - 1].type !== 'request-separator') start--;
                let end = ourIdx;
                while (end < topLevel.length - 1 && topLevel[end + 1].type !== 'request-separator') end++;
                sectionBlocks = topLevel.slice(start, end + 1).map((t) => t.node.toJSON());
              }
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
                      { type: 'toolverifies', attrs: { rows: [], onFailure: 'withdraw' } },
                    ],
                  },
                  { type: 'paragraph' },
                ])
                .run();
            },
          },
        ],
      });

      // Renderer-native discover/validate/verify/plan-served — powers the
      // app's MCP tab (List/Verify/Serve preview). Separate from runner.ts's
      // headless registration (CLI-only) — see toolCapabilityElectron.ts's
      // own header comment for why this isn't shared.
      const capability = createElectronToolCapability({
        getVoidFiles: () => context.project.getVoidFiles(),
        readFile: (path: string) => context.files.read(path),
        findNode: (doc: any, nodeName: string) => (context as any).helpers?.requestUtils?.findNode?.(doc, nodeName),
      });
      (context as any).registerToolCapabilityProvider?.(capability);

      // Top-bar entry point for the MCP tab (List/Verify/Serve preview) —
      // this plugin owns /tool, so it owns the UI that shows what /tool
      // discovers/verifies/serves, not core.
      //
      // Registering the panel component only happens once here, in onload()
      // — NOT inside the button's onClick. A tab pointing at this
      // customTabKey can already exist from a previous session (restored on
      // launch, before the user ever clicks anything) — if the component
      // were only registered reactively on click, that restored tab would
      // render with no component found at all ("Panel component not
      // available"). registerPanel appends to usePluginStore's panels.main
      // array; it's cleared and rebuilt fresh on every plugin reload
      // alongside every other registry, so this can't accumulate duplicates
      // across reloads.
      context.registerPanel('main', {
        id: 'voiden-mcp-tool-mcp-tab',
        title: 'MCP',
        component: McpScreen,
      });

      context.registerTopBarItem({
        id: 'voiden-mcp-tool-open-mcp-tab',
        icon: Plug,
        tooltip: 'MCP',
        position: 'right',
        onClick: () => {
          // Only need to add/activate a tab here — the component is already
          // registered above. context.addTab dedupes/activates by the tab's
          // own `id` (see tab:add's findCustomTabInPanel), so this is safe
          // to call on every click, and re-registers the same component
          // redundantly but harmlessly.
          void context.addTab('main', {
            id: 'voiden-mcp-tool-mcp-tab',
            title: 'MCP',
            icon: null,
            props: {},
            component: McpScreen,
          });
        },
      });
    },

    metadata: manifest,
  };
}
