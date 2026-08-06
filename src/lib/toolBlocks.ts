/**
 * Shared tool-block resolution logic.
 *
 * Works against both the TipTap editorJson.content shape (plugin.ts, in the
 * running app) and the headless Block[] shape (runner.ts, CLI/voiden-runner)
 * — both use { type, attrs?, content }, same pattern voiden-mcp-client's
 * lib/mcpBlocks.ts already established.
 */

export type ToolParamType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
export type ToolParamSource = 'agent' | 'environment'
export type ToolVerifyRole = 'happy-path' | 'error-contract' | 'auth-check'
/** Per-verify-entry, not tool-wide. `sandbox` is a declarative label only —
 *  Voiden runs it exactly like `live`, no redirection. See toolRegistry.ts's
 *  matching type for the full reasoning. */
export type ToolVerifyMode = 'live' | 'sandbox' | 'none'
export type ToolOnFailure = 'withdraw' | 'advertise-degraded'

export interface ToolParamDef {
  name: string
  binds: string
  type: ToolParamType
  required: boolean
  description?: string
  source: ToolParamSource
}

export interface ToolVerifyEntry {
  filePath?: string
  sectionLabel: string
  role: ToolVerifyRole
  cadence?: string
  /** Defaults to 'live' when omitted. */
  mode?: ToolVerifyMode
}

export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolBlockConfig {
  uid?: string
  name: string
  title?: string
  description: string
  annotations: ToolAnnotations
  requestUid?: string
  params: ToolParamDef[]
  verifies: ToolVerifyEntry[]
  onFailure: ToolOnFailure
  /** Manual serve override, independent of verification state. Defaults to
   *  true when the attr is absent (every tool block written before this
   *  field existed). */
  enabled: boolean
}

export function resolveToolBlock(rootContent: any[] | undefined): ToolBlockConfig | null {
  const toolNode = rootContent?.find((n: any) => n.type === 'tool')
  if (!toolNode) return null

  const children = Array.isArray(toolNode.content) ? toolNode.content : []
  const paramsNode = children.find((n: any) => n.type === 'toolparams')
  const verifiesNode = children.find((n: any) => n.type === 'toolverifies')

  const params: ToolParamDef[] = Array.isArray(paramsNode?.attrs?.rows) ? paramsNode.attrs.rows : []
  const verifies: ToolVerifyEntry[] = Array.isArray(verifiesNode?.attrs?.rows) ? verifiesNode.attrs.rows : []

  return {
    uid: toolNode.attrs?.uid,
    name: toolNode.attrs?.name || '',
    title: toolNode.attrs?.title || undefined,
    description: toolNode.attrs?.description || '',
    annotations: toolNode.attrs?.annotations || {},
    requestUid: toolNode.attrs?.requestUid || undefined,
    params,
    verifies,
    onFailure: verifiesNode?.attrs?.onFailure || 'withdraw',
    enabled: toolNode.attrs?.enabled !== false,
  }
}

/** Best-effort: find the sibling request-container block's uid in the same
 *  section, so a freshly-inserted /tool auto-links to the request it decorates
 *  instead of requiring a manual pick. Not load-bearing for execution — a
 *  tool's verification/call runs by (filePath, sectionLabel), not by this uid;
 *  it's informational/for validation only (e.g. confirming a request exists). */
const KNOWN_REQUEST_CONTAINER_TYPES = ['request', 'gqlquery', 'mcp-connection', 'socket-request']

export function findSiblingRequestUid(sectionBlocks: any[] | undefined): string | undefined {
  for (const type of KNOWN_REQUEST_CONTAINER_TYPES) {
    const node = sectionBlocks?.find((n: any) => n.type === type)
    if (node?.attrs?.uid) return node.attrs.uid
  }
  return undefined
}
