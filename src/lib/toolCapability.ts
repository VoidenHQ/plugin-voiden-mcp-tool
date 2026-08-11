/**
 * The /tool block's own capability implementation — discover, structurally
 * validate (voiden-mcp-blocks-spec.md §1.6), verify (§1.4), and decide what
 * to serve over MCP. This used to live in voiden-runner core
 * (toolVerification.ts + the dynamic half of mcpServing.ts +
 * toolStatusBlock.ts) — relocated here because it's all interpretation of
 * THIS plugin's own block semantics (binds/role/cadence/mode/onFailure/
 * readOnlyHint), which core has no business hardcoding. See
 * @voiden/runner's mcpToolCapability.ts for the registry this registers
 * into and the stable protocol types (ToolState/ServeDecision/etc.) core
 * still owns.
 *
 * Doesn't import from @voiden/runner at all — a plugin bundle can't (it's
 * the host loading the plugin, not an externalized dependency, and the
 * standalone-installed copy has no node_modules to resolve it from). The
 * three core-internal primitives this needs (collectVoidFiles, runVoidFile,
 * getRequestPreview) are handed in by runner.ts, sourced from
 * context.runnerPrimitives at onload() time. `activePlugins` is required
 * everywhere below (never re-derived via a self-reload loadEnabledPlugins()
 * fallback) — every real caller already threads it through explicitly, and
 * a plugin-hosted reentrant reload of every plugin's own registrations
 * mid-execution is a hazard worth just not having.
 */

import { readFileSync, writeFileSync } from 'fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import type { ZodTypeAny } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolParamDef, ToolVerifyEntry, ToolAnnotations, ToolOnFailure } from './toolBlocks'

// @voiden/executors is ESM-only (its package.json exports map has no
// "require" condition) — a top-level `import` here would compile fine in
// TS but fail at runtime once esbuild bundles this file into a CJS runner
// (`require()` can't load a pure-ESM module; Node throws
// ERR_PACKAGE_PATH_NOT_EXPORTED / ERR_REQUIRE_ESM). Dynamic `import()`
// works from CJS at runtime, so lazily load it instead — the same fix
// simple-assertions' runner.ts already applies to its own ESM-only import,
// for the same reason. Node caches the module after the first call.
let parseVoidFileSectionsFn: ((content: string) => { label?: string; blocks: any[] }[]) | undefined
async function parseVoidFileSections(content: string) {
  if (!parseVoidFileSectionsFn) {
    ;({ parseVoidFileSections: parseVoidFileSectionsFn } = await import('@voiden/executors'))
  }
  return parseVoidFileSectionsFn!(content)
}

// ─── Local types (duck-typed, not imported from @voiden/runner) ────────────

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
}

interface ToolVerifyResult {
  entry: ToolVerifyEntry
  passed: boolean
  reason?: 'auth-failure' | 'contract-failure'
  runResult?: any
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

interface VerifyToolsOptions {
  cadence?: string
  env?: Record<string, string>
  runtimeVars?: Record<string, any>
  activePlugins: string[]
}

interface ToolStatusRecord {
  state: ToolState
  lastCheckedAt: string
  note?: string
}

// ─── Primitives handed in from context.runnerPrimitives ────────────────────

export interface RunnerPrimitives {
  collectVoidFiles: (inputPath: string) => Promise<string[]>
  runVoidFile: (filePath: string, options?: { env?: Record<string, string>; runtimeVars?: Record<string, any>; activePlugins?: string[]; sectionLabel?: string }) => Promise<{ results: { label?: string; result: any }[] }>
  getRequestPreview: (blocks: any[]) => { url: string; method: string; headers: Record<string, string>; body?: string }
}

/** The plugin's own block→tool-declaration extraction — same function
 *  registered with core's registerToolProvider(), called directly here
 *  since this plugin already owns it (no need to go through core's registry
 *  just to call back into itself). */
export type ExtractToolsFn = (blocks: any[]) => ToolExtraction[]

// ─── Discovery ───────────────────────────────────────────────────────────

async function discoverTools(
  primitives: RunnerPrimitives,
  extractFn: ExtractToolsFn,
  projectRoot: string,
  opts: { activePlugins: string[] },
): Promise<ToolDef[]> {
  const files = await primitives.collectVoidFiles(projectRoot)
  const tools: ToolDef[] = []

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8')
    const sections = await parseVoidFileSections(content)
    for (const section of sections) {
      const extracted = extractFn(section.blocks)
      for (const t of extracted) {
        tools.push({ ...t, filePath, sectionLabel: section.label })
      }
    }
  }

  return tools
}

// ─── §1.6 load-time structural validation ─────────────────────────────────

const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g

function extractPlaceholders(text: string): Set<string> {
  const found = new Set<string>()
  const re = new RegExp(PLACEHOLDER_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) found.add(m[1].trim())
  return found
}

async function validateTools(
  primitives: RunnerPrimitives,
  projectRoot: string,
  tools: ToolDef[],
): Promise<{ validTools: ToolDef[]; issues: ToolValidationIssue[] }> {
  const issues: ToolValidationIssue[] = []
  const excluded = new Set<ToolDef>()
  const sectionTextCache = new Map<string, string>()
  const sectionIndex = new Set<string>() // "filePath::sectionLabel"
  // Files with no request-separators have no real "sections" to disambiguate
  // — a verify row targeting one always means "the one request present",
  // regardless of what sectionLabel it happens to have stored (including a
  // stale/mismatched one) — same leniency runVoidFile() itself applies.
  const singleSectionFiles = new Set<string>()

  const files = await primitives.collectVoidFiles(projectRoot)
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8')
    const sections = await parseVoidFileSections(content)
    if (sections.length === 1) singleSectionFiles.add(filePath)
    for (const section of sections) {
      sectionIndex.add(`${filePath}::${section.label ?? ''}`)
    }
  }

  const getSectionText = async (tool: ToolDef): Promise<string> => {
    const cacheKey = `${tool.filePath}::${tool.sectionLabel ?? ''}`
    let text = sectionTextCache.get(cacheKey)
    if (text === undefined) {
      const content = readFileSync(tool.filePath, 'utf-8')
      const section = (await parseVoidFileSections(content)).find((s) => s.label === tool.sectionLabel)
      text = JSON.stringify(section?.blocks ?? [])
      sectionTextCache.set(cacheKey, text)
    }
    return text
  }

  const flag = (tool: ToolDef, check: ToolValidationIssue['check'], message: string) => {
    issues.push({ tool, check, message })
    excluded.add(tool)
  }

  for (const tool of tools) {
    const sectionText = await getSectionText(tool)

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

    // 3. A verifies entry pointing at a section that doesn't exist.
    for (const entry of tool.verifies) {
      const targetPath = entry.filePath || tool.filePath
      const key = `${targetPath}::${entry.sectionLabel}`
      if (!singleSectionFiles.has(targetPath) && !sectionIndex.has(key)) {
        flag(tool, 'missing-section', `Tool "${tool.name}" verifies entry points at section "${entry.sectionLabel}"${entry.filePath ? ` in ${entry.filePath}` : ''}, which doesn't exist.`)
      }
    }

    // 5. Read-only annotation on a request that actually mutates. (4 below, after the loop.)
    if (tool.annotations?.readOnlyHint) {
      const content = readFileSync(tool.filePath, 'utf-8')
      const section = (await parseVoidFileSections(content)).find((s) => s.label === tool.sectionLabel)
      if (section) {
        const { method } = primitives.getRequestPreview(section.blocks)
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
          flag(tool, 'readonly-mutating', `Tool "${tool.name}" is annotated readOnlyHint but its request uses ${method.toUpperCase()}.`)
        }
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

// ─── Verification ──────────────────────────────────────────────────────────

function isAssertionPassed(result: any): boolean {
  const assertionEntries = (result.reportEntries ?? []).filter((e: any) => e.type === 'assertion')
  if (assertionEntries.length > 0) {
    return assertionEntries.every((e: any) => e.passed === true)
  }
  return result.success === true
}

async function verifyTools(
  primitives: RunnerPrimitives,
  tools: ToolDef[],
  opts: VerifyToolsOptions,
): Promise<ToolStatus[]> {
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
    const runtimeVars = opts.runtimeVars ?? {}
    const results: ToolVerifyResult[] = []

    const runEntry = async (entry: ToolVerifyEntry) => {
      const filePath = entry.filePath || tool.filePath
      const run = await primitives.runVoidFile(filePath, {
        sectionLabel: entry.sectionLabel,
        env: opts.env,
        runtimeVars,
        activePlugins: opts.activePlugins,
      })
      return run.results[0]?.result
    }

    let authFailed = false
    let note: string | undefined

    for (const entry of authChecks) {
      const runResult = await runEntry(entry)
      const passed = runResult ? isAssertionPassed(runResult) : false
      results.push({ entry, passed, reason: passed ? undefined : 'auth-failure', runResult })
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
      const runResult = await runEntry(entry)
      const passed = runResult ? isAssertionPassed(runResult) : false
      if (!passed) anyContractFailed = true
      results.push({ entry, passed, reason: passed ? undefined : 'contract-failure', runResult })
    }

    statuses.push({
      tool,
      state: anyContractFailed ? 'failing' : others.length > 0 ? 'verified' : 'unverified',
      results,
    })
  }

  return statuses
}

// ─── Serving decisions ──────────────────────────────────────────────────────

function decideServing(statuses: ToolStatus[]): ServeDecision[] {
  return statuses.map((status) => {
    const { tool, state } = status
    // Manual override wins regardless of verification state — the user
    // explicitly said "don't serve this," which isn't something a passing
    // verification result should be able to override.
    if (tool.enabled === false) {
      return { tool, status, served: false, disabledManually: true }
    }
    if (state === 'failing' && tool.onFailure === 'withdraw') {
      return { tool, status, served: false }
    }
    if (state === 'failing' && tool.onFailure === 'advertise-degraded') {
      return {
        tool, status, served: true,
        descriptionNote: `⚠ DEGRADED — recent verification failed (${status.note ?? 'see voiden-runner tool verify for details'}). `,
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

async function planServedTools(
  primitives: RunnerPrimitives,
  extractFn: ExtractToolsFn,
  projectRoot: string,
  env: Record<string, string>,
  activePlugins: string[],
): Promise<ServeDecision[]> {
  const tools = await discoverTools(primitives, extractFn, projectRoot, { activePlugins })
  const { validTools, issues } = await validateTools(primitives, projectRoot, tools)
  // Same env-resolution rule registerServedTools() already applies for an
  // actually-served tool's real calls (project vars first, so the explicit/
  // process env passed in — e.g. .mcp.json's "env" block — still wins on a
  // collision) — applied here too, so verification sees exactly what a real
  // call would. Without this, a tool's own request or its verify-target
  // requests can fail verification purely because the headless server
  // process wasn't separately handed a variable that already lives in the
  // project's own .voiden/env-public.yaml / env-private.yaml, even though
  // calling the tool afterward would have resolved it fine — the app's own
  // Preview Serve panel never had this gap, since it verifies through the
  // editor's live active-environment pipeline instead of a bare process env.
  const resolvedEnv: Record<string, string> = { ...loadProjectEnvironmentVars(projectRoot), ...env }
  const statuses = await verifyTools(primitives, validTools, { env: resolvedEnv, activePlugins })
  return [...decideExcluded(issues), ...decideServing(statuses)]
}

// ─── Project environment files (env-private.yaml / env-public.yaml) ────────

/** Loads .voiden/env-public.yaml + env-private.yaml (private overrides
 *  public — same merge order apps/electron's own env.ts uses) and returns
 *  the variables of the project's environment, when there's exactly one.
 *  This is a deliberately simplified headless port — no profiles, no
 *  hierarchical/child environments, no "active environment" selection (the
 *  app resolves that from a per-project UI selection persisted in its own
 *  state; there's no interactive session to select one from here). A
 *  project with zero or more than one environment is ambiguous — returns
 *  {} rather than guessing which one a `source: environment` param should
 *  resolve from. */
function loadProjectEnvironmentVars(projectRoot: string): Record<string, string> {
  const readTree = (relPath: string): Record<string, { variables?: Record<string, string> }> => {
    try {
      const content = readFileSync(join(projectRoot, relPath), 'utf-8')
      return (YAML.parse(content) as any) || {}
    } catch {
      return {}
    }
  }
  const publicTree = readTree('.voiden/env-public.yaml')
  const privateTree = readTree('.voiden/env-private.yaml')
  const envNames = new Set([...Object.keys(publicTree), ...Object.keys(privateTree)])
  if (envNames.size !== 1) return {}
  const [envName] = envNames
  return {
    ...(publicTree[envName]?.variables ?? {}),
    ...(privateTree[envName]?.variables ?? {}),
  }
}

// ─── MCP tool registration ──────────────────────────────────────────────────

function zodForParam(p: ToolParamDef): ZodTypeAny {
  const base: ZodTypeAny = {
    string: z.string(),
    number: z.number(),
    integer: z.number().int(),
    boolean: z.boolean(),
    object: z.record(z.any()),
    array: z.array(z.any()),
  }[p.type]
  const described = p.description ? base.describe(p.description) : base
  return p.required ? described : described.optional()
}

// Only agent-sourced params become part of the tool's callable inputSchema —
// environment-sourced ones never appear here, so the agent can't see or
// supply them even if it wanted to. They resolve from the server process's
// own env at call time instead (see buildToolHandler).
function buildInputSchema(tool: ToolDef): Record<string, ZodTypeAny> {
  const agentParams = tool.params.filter((p) => p.source === 'agent')
  return Object.fromEntries(agentParams.map((p) => [p.name, zodForParam(p)]))
}

function buildToolHandler(
  primitives: RunnerPrimitives,
  tool: ToolDef,
  baseEnv: Record<string, string>,
  runtimeVars: Record<string, any>,
  activePlugins: string[],
) {
  return async (agentArgs: Record<string, any>) => {
    const env: Record<string, string> = { ...baseEnv }
    for (const p of tool.params) {
      if (p.source === 'agent' && agentArgs[p.name] !== undefined) {
        env[p.binds] = typeof agentArgs[p.name] === 'string' ? agentArgs[p.name] : JSON.stringify(agentArgs[p.name])
      }
      // source === 'environment': deliberately left untouched — resolves from
      // baseEnv, which by this point already has the project's env-file
      // variables merged in (see registerServedTools) alongside the server
      // process's own env, exactly like every other {{...}} placeholder in
      // the request that isn't tool-param-bound. Never sourced from agentArgs.
    }
    const run = await primitives.runVoidFile(tool.filePath, { sectionLabel: tool.sectionLabel, env, runtimeVars, activePlugins })
    return { content: [{ type: 'text' as const, text: JSON.stringify(run.results[0]?.result, null, 2) }] }
  }
}

function registerServedTools(
  primitives: RunnerPrimitives,
  server: McpServer,
  decisions: ServeDecision[],
  baseEnv: Record<string, string>,
  runtimeVars: Record<string, any>,
  activePlugins: string[],
  commitSha: string | undefined,
  projectRoot: string,
): void {
  // Computed once for the whole server process, not per-call — the project's
  // env files don't change mid-session. Project vars come first so an
  // explicit override on the server process's own env (e.g. set via
  // .mcp.json's "env" block) still wins on a collision.
  const env: Record<string, string> = { ...loadProjectEnvironmentVars(projectRoot), ...baseEnv }

  for (const d of decisions) {
    if (!d.served || !d.status) continue
    const { tool, status } = d
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: (d.descriptionNote ?? '') + tool.description,
        inputSchema: buildInputSchema(tool),
        annotations: tool.annotations,
        // voiden-mcp-blocks-spec.md §1.7 — structured, silent verification
        // state. Nothing reads namespaced _meta today; this is transparency
        // for tooling, not something clients act on now.
        _meta: {
          'md.voiden/verification': {
            state: status.state,
            last_verified: new Date().toISOString(),
            ...(commitSha ? { commit: commitSha } : {}),
          },
        },
      },
      buildToolHandler(primitives, tool, env, runtimeVars, activePlugins),
    )
  }
}

/** Best-effort — never throws. Not every project is a git repo, and git may
 *  not even be installed on the host machine. */
function getCommitSha(projectRoot: string): string | undefined {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined
  } catch {
    return undefined
  }
}

// ─── Status write-back (`tool verify --write`) ──────────────────────────────

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
          // Malformed fence — treat as opaque, matching resultBlock.ts's tolerance.
        }
      }
    }
    matches.push({ start, end, type, uid, body, headerEnd })
  }
  return matches
}

/** Rewrites the `tool` fence matching `toolBlockUid` with a `verificationStatus`
 *  attr added, preserving everything else exactly as authored. Throws if no
 *  matching block exists. Never read back as truth — verifyTools() always
 *  recomputes fresh; this exists purely for a human browsing the file. */
function upsertToolStatus(filePath: string, toolBlockUid: string, status: { state: ToolState; note?: string }): void {
  const content = readFileSync(filePath, 'utf-8')
  const fences = scanFences(content)

  const toolFence = fences.find((f) => f.type === 'tool' && f.uid === toolBlockUid)
  if (!toolFence) {
    throw new Error(`No tool block with uid "${toolBlockUid}" found in ${filePath}`)
  }

  const lines = toolFence.body.trim().split('\n')
  const parsed = YAML.parse(lines.slice(1, toolFence.headerEnd).join('\n'))

  const record: ToolStatusRecord = {
    state: status.state,
    lastCheckedAt: new Date().toISOString(),
    ...(status.note ? { note: status.note } : {}),
  }
  parsed.attrs = { ...(parsed.attrs ?? {}), verificationStatus: record }

  const yamlText = YAML.stringify(parsed)
  const newFenceText = '```void\n---\n' + yamlText + '---\n```'

  const newContent = content.slice(0, toolFence.start) + newFenceText + content.slice(toolFence.end)
  writeFileSync(filePath, newContent, 'utf-8')
}

// ─── Factory — assembled by runner.ts, registered via
// context.registerMcpToolCapabilityProvider() ───────────────────────────────

export function createToolCapability(primitives: RunnerPrimitives, extractFn: ExtractToolsFn) {
  return {
    discoverTools: (projectRoot: string, opts: { activePlugins: string[] }) =>
      discoverTools(primitives, extractFn, projectRoot, opts),
    validateTools: (projectRoot: string, tools: ToolDef[]) =>
      validateTools(primitives, projectRoot, tools),
    verifyTools: (tools: ToolDef[], opts: VerifyToolsOptions) =>
      verifyTools(primitives, tools, opts),
    planServedTools: (projectRoot: string, env: Record<string, string>, activePlugins: string[]) =>
      planServedTools(primitives, extractFn, projectRoot, env, activePlugins),
    registerServedTools: (
      server: McpServer,
      decisions: ServeDecision[],
      baseEnv: Record<string, string>,
      runtimeVars: Record<string, any>,
      activePlugins: string[],
      commitSha: string | undefined,
      projectRoot: string,
    ) => registerServedTools(primitives, server, decisions, baseEnv, runtimeVars, activePlugins, commitSha, projectRoot),
    upsertToolStatus,
    getCommitSha,
  }
}
