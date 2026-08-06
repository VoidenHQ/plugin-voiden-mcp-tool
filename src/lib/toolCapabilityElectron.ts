/**
 * The /tool block's discover/validate/verify/plan-served implementation —
 * renderer-native port for the Voiden app's own MCP tab (List/Verify/Serve
 * preview), alongside the headless one in toolCapability.ts (used only by
 * voiden-runner's CLI). Deliberately a SEPARATE implementation, not a
 * shared one — the app's real (renderer) plugin system and @voiden/runner's
 * headless one are two disconnected runtimes with no shared module
 * instance (see apps/ui/src/core/tools/toolCapabilityRegistry.ts and
 * @voiden/runner's mcpToolCapability.ts for the two registries this mirrors
 * on either side).
 *
 * Runs real verification requests through the exact same pipeline the
 * editor's "Run" button uses — requestOrchestrator.executeRequest() over a
 * headless-but-real TipTap Editor — rather than reimplementing request
 * building. This technique (schema construction, headless Editor, silent
 * response handling via a sentinel response-store tab id) is not invented
 * here: it's lifted directly from plugins/voiden-stitch/src/lib/stitchEngine.ts,
 * which already does exactly this for batch-running whole files. "Silent"
 * means no response tab visibly opens — setCurrentRequestTabId(SENTINEL)
 * before executeRequest() redirects wherever the response would be stored
 * to a tab id nothing in the visible UI ever renders.
 *
 * No `activePlugins`/reentrancy handling needed here (unlike the headless
 * port) — there's no loadEnabledPlugins()-style global reload in the
 * renderer; whatever's currently loaded is simply what's loaded.
 */

import YAML from 'yaml'
import { resolveToolBlock, type ToolAnnotations, type ToolOnFailure, type ToolParamDef, type ToolVerifyEntry } from './toolBlocks'

const SILENT_TAB_ID = '__mcp_verify__'

// ─── Local types — mirrors @voiden/runner's mcpToolCapability.ts shapes so
// the UI can render either without caring which produced it. ──────────────

export type ToolState = 'verified' | 'unverified' | 'failing'

export interface ToolExtraction {
  name: string
  title?: string
  description: string
  annotations?: ToolAnnotations
  toolBlockUid: string
  requestUid?: string
  params: ToolParamDef[]
  verifies: ToolVerifyEntry[]
  onFailure: ToolOnFailure
  enabled: boolean
}

export interface ToolDef extends ToolExtraction {
  filePath: string
  sectionLabel?: string
  sectionIndex: number
}

interface ToolVerifyResult {
  entry: ToolVerifyEntry
  passed: boolean
  reason?: 'auth-failure' | 'contract-failure'
  error?: string
}

interface ToolStatus {
  tool: ToolDef
  state: ToolState
  results: ToolVerifyResult[]
  note?: string
}

interface ToolValidationIssue {
  tool: ToolDef
  check: 'unbound-param' | 'unresolved-placeholder' | 'missing-section' | 'duplicate-name' | 'readonly-mutating'
  message: string
}

interface ServeDecision {
  tool: ToolDef
  served: boolean
  excluded?: boolean
  excludedReasons?: string[]
  status?: ToolStatus
  descriptionNote?: string
  /** Withdrawn because the user manually disabled it (tool.enabled === false),
   *  not because verification failed — distinct reason, shown separately. */
  disabledManually?: boolean
}

// ─── Primitives — everything this needs from the app's real plugin
// context, kept minimal and self-contained (mirrors RunnerPrimitives on
// the headless side). ────────────────────────────────────────────────────

export interface ElectronToolPrimitives {
  /** context.project.getVoidFiles() — { source: string; content?: string }[] */
  getVoidFiles: () => Promise<{ source: string; content?: string }[]>
  /** context.files.read(path) */
  readFile: (path: string) => Promise<string>
  /** context.helpers.requestUtils.findNode */
  findNode: (doc: { type: 'doc'; content: any[] }, nodeName: string) => any
}

interface Section {
  index: number
  label: string
  blocks: any[]
}

/** Splits a parsed doc's top-level content into request-separator-delimited
 *  sections, matching requestOrchestrator.ts's own getJSON() override and
 *  stitchEngine.ts's own section-counting exactly — same convention, so a
 *  sectionIndex computed here lands on the same section when later passed
 *  to requestOrchestrator.executeRequest({ sectionIndex }). The first
 *  section's label is '' when it has no leading separator — deliberately
 *  NOT "Request 1" here, even though that's what getFirstSectionLabel shows
 *  in the editor UI. This label is what gets saved into a tool's/verify
 *  row's sectionLabel and compared against @voiden/executors'
 *  parseVoidFileSections() (used by the real, headless MCP server) — which
 *  also leaves an unlabeled first section's label unset. Defaulting to
 *  "Request 1" here would make the app's preview agree with itself but
 *  disagree with what the real server actually serves. "Request 1" is a
 *  display-only convenience — apply it at render time, not here. */
function splitIntoSections(doc: any): Section[] {
  const content: any[] = doc?.content ?? []
  const sections: Section[] = [{ index: 0, label: '', blocks: [] }]
  for (const node of content) {
    if (node.type === 'request-separator') {
      sections.push({ index: sections.length, label: node.attrs?.label || `Request ${sections.length + 1}`, blocks: [] })
    } else {
      sections[sections.length - 1].blocks.push(node)
    }
  }
  return sections
}

async function getSchemaAndExtensions() {
  const [{ getSchema }, { voidenExtensions }, pluginsMod] = await Promise.all([
    import(/* @vite-ignore */ '@tiptap/core'),
    import(/* @vite-ignore */ '@/core/editors/voiden/extensions'),
    import(/* @vite-ignore */ '@/plugins'),
  ])
  const pluginExtensions = pluginsMod.useEditorEnhancementStore?.getState?.()?.voidenExtensions || []
  const allExtensions = [...voidenExtensions, ...pluginExtensions]
  return { schema: getSchema(allExtensions), allExtensions }
}

async function parseFile(primitives: ElectronToolPrimitives, filePath: string, schema: any) {
  const { parseMarkdown } = await import(/* @vite-ignore */ '@/core/editors/voiden/markdownConverter')
  const content = await primitives.readFile(filePath)
  return parseMarkdown(content ?? '', schema)
}

/** Real, discovered section labels for a file — powers the verify row's
 *  section-label dropdown (ToolVerifiesNode.tsx) so it's picked from what
 *  actually exists instead of typed/guessed. Same splitIntoSections()
 *  convention used everywhere else in this file, so a label picked here is
 *  guaranteed to validate. */
async function getFileSections(primitives: ElectronToolPrimitives, filePath: string): Promise<{ index: number; label: string }[]> {
  const { schema } = await getSchemaAndExtensions()
  const doc = await parseFile(primitives, filePath, schema)
  return splitIntoSections(doc).map((s) => ({ index: s.index, label: s.label }))
}

// ─── Discovery ───────────────────────────────────────────────────────────

async function discoverTools(primitives: ElectronToolPrimitives): Promise<ToolDef[]> {
  const { schema } = await getSchemaAndExtensions()
  const files = await primitives.getVoidFiles()
  const tools: ToolDef[] = []

  for (const file of files) {
    let doc: any
    try {
      doc = await parseFile(primitives, file.source, schema)
    } catch {
      continue
    }
    const sections = splitIntoSections(doc)
    for (const section of sections) {
      const cfg = resolveToolBlock(section.blocks)
      if (!cfg || !cfg.name) continue
      tools.push({
        name: cfg.name,
        title: cfg.title,
        description: cfg.description,
        annotations: cfg.annotations,
        toolBlockUid: cfg.uid || '',
        requestUid: cfg.requestUid,
        params: cfg.params,
        verifies: cfg.verifies,
        onFailure: cfg.onFailure,
        enabled: cfg.enabled,
        filePath: file.source,
        sectionLabel: section.label,
        sectionIndex: section.index,
      })
    }
  }

  return tools
}

// ─── §1.6-equivalent structural validation ──────────────────────────────

const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g

function extractPlaceholders(text: string): Set<string> {
  const found = new Set<string>()
  const re = new RegExp(PLACEHOLDER_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) found.add(m[1].trim())
  return found
}

async function validateTools(
  primitives: ElectronToolPrimitives,
  tools: ToolDef[],
): Promise<{ validTools: ToolDef[]; issues: ToolValidationIssue[] }> {
  const issues: ToolValidationIssue[] = []
  const excluded = new Set<ToolDef>()
  const { schema } = await getSchemaAndExtensions()

  // Cache parsed docs + section index per file so multiple tools in the
  // same file (or a verify entry pointing cross-file) don't reparse.
  const docCache = new Map<string, any>()
  const sectionsCache = new Map<string, Section[]>()
  const getSections = async (filePath: string): Promise<Section[]> => {
    if (sectionsCache.has(filePath)) return sectionsCache.get(filePath)!
    let doc = docCache.get(filePath)
    if (!doc) {
      try {
        doc = await parseFile(primitives, filePath, schema)
      } catch {
        doc = { type: 'doc', content: [] }
      }
      docCache.set(filePath, doc)
    }
    const sections = splitIntoSections(doc)
    sectionsCache.set(filePath, sections)
    return sections
  }

  const flag = (tool: ToolDef, check: ToolValidationIssue['check'], message: string) => {
    issues.push({ tool, check, message })
    excluded.add(tool)
  }

  for (const tool of tools) {
    const sections = await getSections(tool.filePath)
    const ownSection = sections[tool.sectionIndex]
    const sectionText = JSON.stringify(ownSection?.blocks ?? [])

    // 1. An agent param binds to a {{token}} missing from its own request.
    for (const param of tool.params) {
      if (!param.binds) continue
      if (!sectionText.includes(`{{${param.binds}}}`)) {
        flag(tool, 'unbound-param', `Tool "${tool.name}" param "${param.name}" binds to "{{${param.binds}}}", which doesn't appear anywhere in the request it decorates.`)
      }
    }

    // 2. The reverse: a {{token}} in the request that no param declares.
    const declaredBinds = new Set(tool.params.map((p) => p.binds).filter(Boolean))
    for (const token of extractPlaceholders(sectionText)) {
      if (!declaredBinds.has(token)) {
        flag(tool, 'unresolved-placeholder', `Tool "${tool.name}" request uses "{{${token}}}", which isn't declared as any parameter's "binds" — it can only resolve if it happens to be a real environment variable outside Voiden's knowledge.`)
      }
    }

    // 3. A verifies entry pointing at a section that doesn't exist. A file
    // with no request-separators has no real "sections" to disambiguate —
    // it's just one request, so any label (or none) targeting it is valid.
    // Same leniency runVoidFile() applies at execution time.
    for (const entry of tool.verifies) {
      const targetSections = entry.filePath ? await getSections(entry.filePath) : sections
      const found = targetSections.length === 1 || targetSections.some((s) => s.label === entry.sectionLabel)
      if (!found) {
        flag(tool, 'missing-section', `Tool "${tool.name}" verifies entry points at section "${entry.sectionLabel}"${entry.filePath ? ` in ${entry.filePath}` : ''}, which doesn't exist.`)
      }
    }

    // 5. Read-only annotation on a request that actually mutates. (4 below, after the loop.)
    if (tool.annotations?.readOnlyHint && ownSection) {
      const doc = { type: 'doc' as const, content: ownSection.blocks }
      const endpointNode = primitives.findNode(doc, 'api') || primitives.findNode(doc, 'request')
      const method = endpointNode?.content?.find((n: any) => n.type === 'method')?.content?.[0]?.text
      if (method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method).toUpperCase())) {
        flag(tool, 'readonly-mutating', `Tool "${tool.name}" is annotated readOnlyHint but its request uses ${String(method).toUpperCase()}.`)
      }
    }
  }

  // 4. Duplicate names, project-wide.
  const byName = new Map<string, ToolDef[]>()
  for (const tool of tools) {
    if (!tool.name) continue
    const list = byName.get(tool.name) ?? []
    list.push(tool)
    byName.set(tool.name, list)
  }
  for (const [name, group] of byName) {
    if (group.length > 1) {
      for (const tool of group) {
        flag(tool, 'duplicate-name', `Tool name "${name}" is used by ${group.length} tools — names must be unique across the served set.`)
      }
    }
  }

  return { validTools: tools.filter((t) => !excluded.has(t)), issues }
}

// ─── Verification — real requests, via the same pipeline "Run" uses ───────

/** response.metadata?.assertionResults's shape, per simple-assertions'
 *  postProcessAssertionsHook — the renderer's equivalent of the headless
 *  side's `result.reportEntries.filter(e => e.type === 'assertion')`. */
function isPassed(response: any): boolean {
  const assertionData = response?.metadata?.assertionResults
  const total = assertionData?.totalAssertions ?? (Array.isArray(assertionData?.results) ? assertionData.results.length : 0)
  if (total > 0) {
    return (assertionData?.failedAssertions ?? 0) === 0
  }
  // No assertions attached to this verify entry — fall back to
  // transport-level success, same fallback reasoning toolCapability.ts's
  // isAssertionPassed() uses, just reading the renderer's own response shape.
  const httpStatus: number | null = response?.status ?? response?.statusCode ?? response?.httpStatus ?? null
  return !response?.error && !(httpStatus !== null && httpStatus >= 400)
}

async function runSectionSilently(filePath: string, sectionIndex: number, env: Record<string, string> | undefined): Promise<any> {
  const [{ Editor }, { requestOrchestrator }, { useResponseStore }, { schema, allExtensions }] = await Promise.all([
    import(/* @vite-ignore */ '@tiptap/core'),
    import(/* @vite-ignore */ '@/core/request-engine/requestOrchestrator'),
    import(/* @vite-ignore */ '@/core/request-engine/stores/responseStore'),
    getSchemaAndExtensions(),
  ])
  const { parseMarkdown } = await import(/* @vite-ignore */ '@/core/editors/voiden/markdownConverter')
  const content = await (window as any).electron?.files?.read?.(filePath)
  if (content == null) throw new Error(`Could not read file: ${filePath}`)
  const doc = parseMarkdown(content, schema)
  const editor = new Editor({ extensions: allExtensions, content: doc })
  try {
    // Redirect wherever the response would be stored to a sentinel tab id —
    // nothing in the visible UI ever renders a tab for it, so this runs the
    // request for real (and any pipeline hooks, e.g. simple-assertions) but
    // never opens a response tab. Exactly voiden-stitch's own technique.
    useResponseStore.getState().setCurrentRequestTabId(SILENT_TAB_ID)
    return await requestOrchestrator.executeRequest(editor, env, undefined, { sectionIndex, filePath })
  } finally {
    editor.destroy()
  }
}

async function verifyTools(
  primitives: ElectronToolPrimitives,
  tools: ToolDef[],
  opts: { cadence?: string } = {},
): Promise<ToolStatus[]> {
  const { schema } = await getSchemaAndExtensions()
  const sectionsCache = new Map<string, Section[]>()
  const getSections = async (filePath: string): Promise<Section[]> => {
    if (sectionsCache.has(filePath)) return sectionsCache.get(filePath)!
    let doc: any
    try {
      doc = await parseFile(primitives, filePath, schema)
    } catch {
      doc = { type: 'doc', content: [] }
    }
    const sections = splitIntoSections(doc)
    sectionsCache.set(filePath, sections)
    return sections
  }

  const statuses: ToolStatus[] = []

  for (const tool of tools) {
    if (tool.verifies.length === 0) {
      statuses.push({ tool, state: 'unverified', results: [], note: 'No verification requests attached.' })
      continue
    }

    const cadenceFiltered = opts.cadence ? tool.verifies.filter((e) => e.cadence === opts.cadence) : tool.verifies
    if (cadenceFiltered.length === 0) {
      statuses.push({ tool, state: 'unverified', results: [], note: `No verification requests matched cadence "${opts.cadence}".` })
      continue
    }

    const runnable = cadenceFiltered.filter((e) => e.mode !== 'none')
    if (runnable.length === 0) {
      statuses.push({ tool, state: 'unverified', results: [], note: 'Every matching verification request has mode "none" — none were automatically run.' })
      continue
    }

    const authChecks = runnable.filter((e) => e.role === 'auth-check')
    const others = runnable.filter((e) => e.role !== 'auth-check')
    const results: ToolVerifyResult[] = []

    const runEntry = async (entry: ToolVerifyEntry): Promise<{ passed: boolean; error?: string }> => {
      const filePath = entry.filePath || tool.filePath
      const sections = await getSections(filePath)
      // A single-section file has nothing to disambiguate — any label (or
      // none) targeting it means "the one request present".
      const target = sections.length === 1 ? sections[0] : sections.find((s) => s.label === entry.sectionLabel)
      if (!target) return { passed: false, error: `Section "${entry.sectionLabel}" not found` }
      try {
        const response = await runSectionSilently(filePath, target.index, undefined)
        return { passed: isPassed(response) }
      } catch (err: any) {
        return { passed: false, error: err?.message ?? String(err) }
      }
    }

    let authFailed = false
    let note: string | undefined

    for (const entry of authChecks) {
      const { passed, error } = await runEntry(entry)
      results.push({ entry, passed, reason: passed ? undefined : 'auth-failure', error })
      if (!passed) {
        authFailed = true
        note = `Auth check "${entry.sectionLabel}" failed — dependent verification requests were skipped.`
      }
    }

    if (authFailed) {
      statuses.push({ tool, state: 'failing', results, note })
      continue
    }

    let anyContractFailed = false
    for (const entry of others) {
      const { passed, error } = await runEntry(entry)
      if (!passed) anyContractFailed = true
      results.push({ entry, passed, reason: passed ? undefined : 'contract-failure', error })
    }

    statuses.push({
      tool,
      state: anyContractFailed ? 'failing' : others.length > 0 ? 'verified' : 'unverified',
      results,
    })
  }

  return statuses
}

// ─── Serve-preview decisions (read-only — this app never itself serves an
// MCP connection; .mcp.json points Claude/Codex at the real server) ───────

function decideServing(statuses: ToolStatus[]): ServeDecision[] {
  return statuses.map((status) => {
    const { tool, state } = status
    // Manual override wins regardless of verification state.
    if (tool.enabled === false) {
      return { tool, status, served: false, disabledManually: true }
    }
    if (state === 'failing' && tool.onFailure === 'withdraw') {
      return { tool, status, served: false }
    }
    if (state === 'failing' && tool.onFailure === 'advertise-degraded') {
      return {
        tool, status, served: true,
        descriptionNote: `⚠ DEGRADED — recent verification failed (${status.note ?? 'see Verify for details'}). `,
      }
    }
    if (state === 'unverified') {
      return { tool, status, served: true, descriptionNote: `[unverified — ${status.note ?? 'no automated verification passed yet'}] ` }
    }
    return { tool, status, served: true } // verified
  })
}

function decideExcluded(issues: ToolValidationIssue[]): ServeDecision[] {
  const byTool = new Map<ToolDef, string[]>()
  for (const issue of issues) {
    const list = byTool.get(issue.tool) ?? []
    list.push(`[${issue.check}] ${issue.message}`)
    byTool.set(issue.tool, list)
  }
  return [...byTool.entries()].map(([tool, excludedReasons]) => ({ tool, served: false, excluded: true, excludedReasons }))
}

async function planServedTools(primitives: ElectronToolPrimitives): Promise<ServeDecision[]> {
  const tools = await discoverTools(primitives)
  const { validTools, issues } = await validateTools(primitives, tools)
  const statuses = await verifyTools(primitives, validTools)
  return [...decideExcluded(issues), ...decideServing(statuses)]
}

// ─── Manual serve override — the Serve preview tab's Add/Remove action ─────
// Own copy of toolCapability.ts's fence-scan-and-YAML-rewrite technique —
// not shared, since this needs window.electron.files.read/write instead of
// Node's fs (same separation as everything else in this file).

const FENCE_RE = /^```void\n([\s\S]*?)^```/gm

interface FenceMatch {
  start: number
  end: number
  type?: string
  uid?: string
  body: string
  headerEnd: number
}

function scanFences(content: string): FenceMatch[] {
  const matches: FenceMatch[] = []
  const re = new RegExp(FENCE_RE.source, FENCE_RE.flags)
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const start = m.index
    const end = start + m[0].length
    const body = m[1]
    const lines = body.trim().split('\n')
    let type: string | undefined
    let uid: string | undefined
    let headerEnd = -1
    if (lines[0]?.trim() === '---') {
      headerEnd = lines.indexOf('---', 1)
      if (headerEnd !== -1) {
        try {
          const parsed = YAML.parse(lines.slice(1, headerEnd).join('\n'))
          type = parsed?.type
          uid = parsed?.attrs?.uid
        } catch {
          // Malformed fence — treat as opaque, matching toolCapability.ts's tolerance.
        }
      }
    }
    matches.push({ start, end, type, uid, body, headerEnd })
  }
  return matches
}

/** Rewrites the `tool` fence matching `toolBlockUid` with `enabled` set,
 *  preserving everything else exactly as authored. Persisted (unlike
 *  verification state) because it's a deliberate user decision, not a
 *  computed result — decideServing() in both capability implementations
 *  reads it fresh every time, same as onFailure/name/any other tool attr. */
async function setToolEnabled(tool: ToolDef, enabled: boolean): Promise<void> {
  const content = await (window as any).electron?.files?.read?.(tool.filePath)
  if (content == null) throw new Error(`Could not read file: ${tool.filePath}`)

  const fences = scanFences(content)
  const toolFence = fences.find((f) => f.type === 'tool' && f.uid === tool.toolBlockUid)
  if (!toolFence) {
    throw new Error(`No tool block with uid "${tool.toolBlockUid}" found in ${tool.filePath}`)
  }

  const lines = toolFence.body.trim().split('\n')
  const parsed = YAML.parse(lines.slice(1, toolFence.headerEnd).join('\n'))
  parsed.attrs = { ...(parsed.attrs ?? {}), enabled }

  const yamlText = YAML.stringify(parsed)
  const newFenceText = '```void\n---\n' + yamlText + '---\n```'
  const newContent = content.slice(0, toolFence.start) + newFenceText + content.slice(toolFence.end)

  await (window as any).electron?.files?.write?.(tool.filePath, newContent)
}

// ─── Factory — assembled by plugin.ts, registered via
// context.registerToolCapabilityProvider() ─────────────────────────────────

export function createElectronToolCapability(primitives: ElectronToolPrimitives) {
  return {
    discoverTools: () => discoverTools(primitives),
    validateTools: (tools: ToolDef[]) => validateTools(primitives, tools),
    verifyTools: (tools: ToolDef[], opts?: { cadence?: string }) => verifyTools(primitives, tools, opts),
    planServedTools: () => planServedTools(primitives),
    setToolEnabled: (tool: ToolDef, enabled: boolean) => setToolEnabled(tool, enabled),
    getFileSections: (filePath: string) => getFileSections(primitives, filePath),
  }
}
