/**
 * Shared tool-block resolution logic.
 *
 * Works against both the TipTap editorJson.content shape (plugin.ts, in the
 * running app) and the headless Block[] shape (runner.ts, CLI/voiden-runner)
 * — both use { type, attrs?, content }, same pattern voiden-mcp-client's
 * lib/mcpBlocks.ts already established.
 */

export type ToolParamType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
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
  /** Every param is agent-supplied at call time — there's no separate
   *  "environment"-sourced kind. A {{token}} that should resolve from the
   *  environment instead just doesn't get a param row at all; it resolves
   *  the same way any other {{ENV_VAR}} in a Voiden request already does,
   *  with no tool-specific declaration needed.
   *
   *  testValue is unrelated to that — it's what verification substitutes
   *  for this param since there's no live agent call happening then. Opted
   *  into per param, not required: a param with no testValue just can't be
   *  exercised by live verification (the request will fail on the
   *  unresolved {{token}}, same as any other missing substitution) —
   *  correct, honest behavior, not a bug to work around. */
  testValue?: string
}

export interface ToolVerifyEntry {
  filePath?: string
  sectionLabel: string
  role: ToolVerifyRole
  cadence?: string
  /** Defaults to 'live' when omitted. */
  mode?: ToolVerifyMode
  /** Per-entry, not tool-wide — what happens to the whole tool if THIS
   *  request fails. When entries disagree, the most conservative one wins:
   *  if any failed entry says 'withdraw', the tool is withdrawn; only if
   *  every failed entry says 'advertise-degraded' is it served degraded.
   *  Defaults to 'withdraw' when omitted (including on rows saved before
   *  this existed, back when onFailure was a single tool-wide setting). */
  onFailure?: ToolOnFailure
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
  /** Manual serve override, independent of verification state. Defaults to
   *  true when the attr is absent (every tool block written before this
   *  field existed). */
  enabled: boolean
  /** Cross-file/cross-section request binding — when `requestSectionLabel`
   *  is set (including ""), this tool wraps THAT section's request instead
   *  of the one physically sitting in the same section as the /tool block
   *  itself. `requestFilePath` empty/absent means "this tool's own file",
   *  same convention `toolverifies` rows already use. Absent
   *  `requestSectionLabel` (not even "") means "not bound — use the sibling
   *  request in this /tool block's own section", the original/default
   *  behavior every tool block had before this existed. */
  requestFilePath?: string
  requestSectionLabel?: string
}

export function resolveToolBlock(rootContent: any[] | undefined): ToolBlockConfig | null {
  const toolNode = rootContent?.find((n: any) => n.type === 'tool')
  if (!toolNode) return null

  const children = Array.isArray(toolNode.content) ? toolNode.content : []
  const paramsNode = children.find((n: any) => n.type === 'toolparams')
  const verifiesNode = children.find((n: any) => n.type === 'toolverifies')

  const params: ToolParamDef[] = Array.isArray(paramsNode?.attrs?.rows) ? paramsNode.attrs.rows : []
  const rawVerifies: ToolVerifyEntry[] = Array.isArray(verifiesNode?.attrs?.rows) ? verifiesNode.attrs.rows : []
  // Migration: onFailure used to be one tool-wide setting (verifiesNode's
  // own `onFailure` attr) rather than per-entry. A row saved before this
  // changed has no `onFailure` of its own — fall back to whatever the old
  // tool-wide value was (still 'withdraw' if that was never set either),
  // so an existing author's choice isn't silently reset on next load.
  const legacyOnFailure: ToolOnFailure = verifiesNode?.attrs?.onFailure || 'withdraw'
  const verifies: ToolVerifyEntry[] = rawVerifies.map((v) => ({ ...v, onFailure: v.onFailure || legacyOnFailure }))

  // `requestSectionLabel` uses `!= null` (not `||`) so a real, valid ""
  // (the unlabeled-first-section value) reads as "bound to that section",
  // not as "unset" — same distinction toolverifies rows' sectionLabel
  // already has to make.
  const requestSectionLabel = toolNode.attrs?.requestSectionLabel
  const isRequestBound = requestSectionLabel !== null && requestSectionLabel !== undefined

  return {
    uid: toolNode.attrs?.uid,
    name: toolNode.attrs?.name || '',
    title: toolNode.attrs?.title || undefined,
    description: toolNode.attrs?.description || '',
    annotations: toolNode.attrs?.annotations || {},
    requestUid: toolNode.attrs?.requestUid || undefined,
    params,
    verifies,
    enabled: toolNode.attrs?.enabled !== false,
    requestFilePath: toolNode.attrs?.requestFilePath || undefined,
    requestSectionLabel: isRequestBound ? requestSectionLabel : undefined,
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

/** Live-editor-doc section lookup: given a doc position (e.g. a /tool
 *  node's own `getPos()`), returns every top-level block in the same
 *  request-separator-bounded section, as plain JSON — same "section" a
 *  fresh /tool insertion already resolves its sibling request from
 *  (plugin.ts's insertion command), now shared instead of duplicated, and
 *  also what auto-populate (ToolNode.tsx) reads for the *unbound* case
 *  (bound/cross-file reads through the tool-capability provider's
 *  getSectionBlocks() instead, since that can be a different, possibly
 *  unopened file). `doc` is a TipTap/ProseMirror doc node (has `.forEach`),
 *  not a plain array. */
export function getSectionBlocksAtPos(doc: any, pos: number): any[] {
  const topLevel: Array<{ type: string; node: any; pos: number }> = []
  doc.forEach((node: any, p: number) => topLevel.push({ type: node.type.name, node, pos: p }))

  let ourIdx = -1
  for (let i = 0; i < topLevel.length; i++) {
    const { pos: p, node } = topLevel[i]
    if (pos >= p && pos < p + node.nodeSize) { ourIdx = i; break }
  }
  if (ourIdx === -1) return []

  let start = ourIdx
  while (start > 0 && topLevel[start - 1].type !== 'request-separator') start--
  let end = ourIdx
  while (end < topLevel.length - 1 && topLevel[end + 1].type !== 'request-separator') end++

  return topLevel.slice(start, end + 1).map((t) => t.node.toJSON())
}

/** Live-editor-doc section lookup by label, instead of by cursor position —
 *  for auto-populate's "bound to a different section of THIS SAME file"
 *  case, where there's no cross-file I/O needed (unlike the
 *  requestFilePath-set case, which goes through the tool-capability
 *  provider's getSectionBlocks() instead since that file may not be open in
 *  any editor tab). Same single-section-file leniency as everywhere else:
 *  a file with no request-separators has nothing to disambiguate, so any
 *  label (or none) means "the one section present". */
export function getSectionBlocksByLabel(doc: any, sectionLabel: string): any[] | null {
  const sections: { label: string; blocks: any[] }[] = [{ label: '', blocks: [] }]
  doc.forEach((node: any) => {
    if (node.type?.name === 'request-separator') {
      sections.push({ label: node.attrs?.label || `Request ${sections.length + 1}`, blocks: [] })
    } else {
      sections[sections.length - 1].blocks.push(node.toJSON())
    }
  })
  const match = sections.length === 1 ? sections[0] : sections.find((s) => s.label === sectionLabel)
  return match ? match.blocks : null
}
