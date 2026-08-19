/**
 * Voiden Tool — headless runner.
 *
 * Registers block schemas (so headless normalizeBlocks() doesn't choke on a
 * hand-edited or older file missing attrs) and a tool-extraction function
 * with voiden-runner's toolRegistry — the same registration-at-onload()
 * pattern requestContainerRegistry uses for REST/GraphQL/MCP, just for a
 * different registry since /tool isn't itself a request container.
 *
 * No context.onBuildRequest here — /tool never builds/sends a request.
 */

import type { RunnerFactory, RunnerContext, Block } from '@voiden/sdk/runner'
import { resolveToolBlock } from './lib/toolBlocks'
import { createToolCapability, type RunnerPrimitives } from './lib/toolCapability'

/** Shape voiden-runner's toolRegistry.ToolExtraction expects — kept as a
 *  plain object literal here rather than importing the type, since this
 *  plugin has no dependency on @voiden/runner's internals, only on the
 *  registerToolProvider host capability exposed via context. */
export function extractTools(blocks: Block[]): any[] {
  const cfg = resolveToolBlock(blocks as any[])
  if (!cfg || !cfg.name) return []

  return [{
    name: cfg.name,
    title: cfg.title,
    description: cfg.description,
    annotations: cfg.annotations,
    toolBlockUid: cfg.uid || '',
    requestUid: cfg.requestUid,
    params: cfg.params,
    verifies: cfg.verifies,
    enabled: cfg.enabled,
    requestFilePath: cfg.requestFilePath,
    requestSectionLabel: cfg.requestSectionLabel,
  }]
}

const createToolRunner: RunnerFactory = (context: RunnerContext) => {
  return {
    onload() {
      context.registerBlockSchema({
        name: 'tool',
        attrs: {
          uid: {},
          name: { default: '' },
          title: { default: '' },
          description: { default: '' },
          annotations: { default: {} },
          requestUid: { default: '' },
          enabled: { default: true },
          requestFilePath: { default: '' },
          requestSectionLabel: { default: null },
        },
      })
      context.registerBlockSchema({
        name: 'toolparams',
        attrs: { uid: {}, rows: { default: [] } },
      })
      context.registerBlockSchema({
        name: 'toolverifies',
        // No tool-wide `onFailure` here anymore — moved to a per-row attr on
        // each verify entry (inside `rows`), not a schema-level attr of its
        // own. A file saved before this migrates on next read/resave, see
        // toolBlocks.ts's resolveToolBlock().
        attrs: { uid: {}, rows: { default: [] } },
      })

      // Cast to any: registerToolProvider is a host capability not yet in the
      // published @voiden/sdk RunnerContext type — same treatment
      // registerRequestContainer already gets in every other protocol plugin.
      ;(context as any).registerToolProvider?.(extractTools)

      // Discover/validate/verify/serve logic for the /tool block used to
      // live in voiden-runner core — relocated here (toolCapability.ts)
      // since it's this plugin's own block semantics, not core's. The three
      // core-internal primitives it needs (voiden-runner can't be imported
      // by a plugin bundle) come from context.runnerPrimitives, set up by
      // voiden-runner's createHeadlessPluginContext().
      const runnerPrimitives = (context as any).runnerPrimitives as RunnerPrimitives | undefined
      if (runnerPrimitives) {
        const capability = createToolCapability(runnerPrimitives, extractTools)
        ;(context as any).registerMcpToolCapabilityProvider?.(capability)
      }
    },
  }
}

export default createToolRunner
