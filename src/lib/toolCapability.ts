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
import { join, isAbsolute } from 'node:path'
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
  enabled: boolean
  /** See toolBlocks.ts's ToolBlockConfig — absent means "not bound, use the
   *  sibling request in this tool's own section" (the original behavior). */
  requestFilePath?: string
  requestSectionLabel?: string
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
  check: 'unbound-param' | 'unresolved-placeholder' | 'missing-section' | 'duplicate-name' | 'readonly-mutating' | 'dangling-request-reference'
  message: string
}

/** A cross-file requestFilePath / verify-entry filePath resolves relative to
 *  the PROJECT ROOT — not process.cwd() (unreliable; depends on wherever the
 *  CLI happens to be invoked from) and not the referencing file's own
 *  directory (would make an already-non-obvious cross-file reference even
 *  harder to reason about). Absolute paths pass through unchanged, so this
 *  stays backward compatible with every file already authored — the file
 *  picker (Row.tsx's FilePickerCell) has only ever saved whatever absolute
 *  path the OS dialog returns, which is exactly why a project moved to a
 *  different machine (a teammate's laptop, a CI runner, a cloud deploy)
 *  currently breaks every cross-file /tool reference outright: an absolute
 *  path baked in on the machine that authored it can't exist anywhere else.
 *  A relative path (hand-edited today; from a future picker fix tomorrow)
 *  survives that move correctly. `projectRoot` is technically optional on
 *  VerifyToolsOptions (matching the shared type) even though every real
 *  caller always passes it — a relative path with no projectRoot available
 *  is returned unresolved rather than thrown on, the same as today's
 *  (unresolved) behavior, not a new failure mode. */
function resolvePath(filePath: string, projectRoot: string | undefined): string {
  if (isAbsolute(filePath) || !projectRoot) return filePath
  return join(projectRoot, filePath)
}

/** Where THIS tool's own request actually lives — the sibling in its own
 *  section by default, or wherever requestFilePath/requestSectionLabel
 *  points once bound (Pending #3 — cross-file/cross-section request
 *  binding). Distinct from `tool.filePath`/`tool.sectionLabel`, which
 *  always mean "where the /tool block itself is written" (still correct
 *  for write-back — upsertToolStatus always edits that file, never the
 *  bound request's file). */
function resolveRequestLocation(tool: ToolDef, projectRoot: string): { filePath: string; sectionLabel?: string } {
  if (tool.requestSectionLabel !== undefined) {
    const raw = tool.requestFilePath || tool.filePath
    return { filePath: resolvePath(raw, projectRoot), sectionLabel: tool.requestSectionLabel }
  }
  return { filePath: tool.filePath, sectionLabel: tool.sectionLabel }
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

/** One verify entry's last-known result, cached across scheduler ticks
 *  (owned/persisted by the caller — @voiden/mcp's scheduler) so each entry
 *  is only actually re-run when its own declared `cadence` says it's due,
 *  not on one shared interval for the whole server. */
export interface VerifyEntryCacheRecord {
  passed: boolean
  runResult?: any
  verifiedAt: number
}
export type VerifyEntryCache = Map<string, VerifyEntryCacheRecord>

interface VerifyToolsOptions {
  cadence?: string
  env?: Record<string, string>
  runtimeVars?: Record<string, any>
  activePlugins: string[]
  entryCache?: VerifyEntryCache
  now?: number
  /** Resolves a relative entry.filePath/tool.filePath against this — see
   *  resolvePath()'s own doc comment. Omitting it (nothing currently does)
   *  would leave a relative path resolving against process.cwd() instead,
   *  which happens to work by coincidence when the CLI is invoked from the
   *  project root and nowhere else — always pass this. */
  projectRoot?: string
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

  // `null` return = the request genuinely couldn't be resolved (its file
  // doesn't exist, or reading it failed some other way) — distinct from a
  // real, empty/no-match section (""), which is a normal, valid state. The
  // caller uses this to skip checks 1/2 entirely rather than run them
  // against phantom empty text, leaving the dangling-request-reference
  // check (3b, below) as the one place that actually reports this — one
  // clear message per broken tool, not a confusing pile of unrelated
  // "unbound-param" errors caused by the same missing file.
  const getSectionText = async (tool: ToolDef): Promise<string | null> => {
    const { filePath, sectionLabel } = resolveRequestLocation(tool, projectRoot)
    const cacheKey = `${filePath}::${sectionLabel ?? ''}`
    if (sectionTextCache.has(cacheKey)) return sectionTextCache.get(cacheKey)!

    let text: string | null
    try {
      const content = readFileSync(filePath, 'utf-8')
      const sections = await parseVoidFileSections(content)
      // Same single-section leniency the missing-section/dangling-request-
      // reference checks below already apply (via singleSectionFiles) —
      // parseVoidFileSections() leaves a file's unlabeled first section's
      // `label` as `undefined` (not `""`), so a tool storing
      // requestSectionLabel: "" (the normal case for an unbound, single-
      // request file) would otherwise never strictly-equal-match it here,
      // silently resolving to an empty section — and from there, a false
      // "doesn't appear anywhere in the request" on every param, no matter
      // how correct the request actually is.
      const section = sections.length === 1 ? sections[0] : sections.find((s) => s.label === sectionLabel)
      text = section ? JSON.stringify(section.blocks) : null
    } catch {
      // readFileSync throws (ENOENT — requestFilePath points at a file that
      // doesn't exist, or isn't readable) — a real, expected authoring
      // mistake (a moved/renamed/deleted file), not a crash-worthy one.
      text = null
    }
    sectionTextCache.set(cacheKey, text)
    return text
  }

  const flag = (tool: ToolDef, check: ToolValidationIssue['check'], message: string) => {
    issues.push({ tool, check, message })
    excluded.add(tool)
  }

  for (const tool of tools) {
    const sectionText = await getSectionText(tool)

    // 1. An agent param binds to a {{token}} missing from its own request.
    // Skipped entirely when the request itself couldn't be resolved (null)
    // — 3b below reports that case on its own, once, clearly.
    for (const param of tool.params) {
      if (!param.binds) continue
      if (sectionText !== null && !sectionText.includes(`{{${param.binds}}}`)) {
        flag(tool, 'unbound-param', `Tool "${tool.name}" param "${param.name}" binds to "{{${param.binds}}}", which doesn't appear anywhere in the request it decorates.`)
      }
    }

    // 2. The reverse: a {{token}} in the request that no param declares.
    // Same null-skip as #1 — nothing meaningful to extract placeholders
    // from when the request itself couldn't be resolved.
    if (sectionText !== null) {
      const declaredBinds = new Set(tool.params.map((p) => p.binds).filter(Boolean))
      for (const token of extractPlaceholders(sectionText)) {
        if (!declaredBinds.has(token)) {
          flag(tool, 'unresolved-placeholder', `Tool "${tool.name}" request uses "{{${token}}}", which isn't declared as any parameter's "binds" — it can only resolve if it happens to be a real environment variable outside Voiden's knowledge.`)
        }
      }
    }

    // 3. A verifies entry pointing at a section that doesn't exist.
    for (const entry of tool.verifies) {
      const targetPath = resolvePath(entry.filePath || tool.filePath, projectRoot)
      const key = `${targetPath}::${entry.sectionLabel}`
      if (!singleSectionFiles.has(targetPath) && !sectionIndex.has(key)) {
        flag(tool, 'missing-section', `Tool "${tool.name}" verifies entry points at section "${entry.sectionLabel}"${entry.filePath ? ` in ${entry.filePath}` : ''}, which doesn't exist.`)
      }
    }

    // 3b. The tool's own request binding (Pending #3), if set, pointing at a
    // section that doesn't exist — same check as #3, but for the request
    // this tool actually runs, not a verification request.
    if (tool.requestSectionLabel !== undefined) {
      const { filePath: targetPath, sectionLabel } = resolveRequestLocation(tool, projectRoot)
      const key = `${targetPath}::${sectionLabel}`
      if (!singleSectionFiles.has(targetPath) && !sectionIndex.has(key)) {
        flag(tool, 'dangling-request-reference', `Tool "${tool.name}" is bound to section "${sectionLabel}"${tool.requestFilePath ? ` in ${tool.requestFilePath}` : ''}, which doesn't exist.`)
      }
    }

    // 5. Read-only annotation on a request that actually mutates. (4 below, after the loop.)
    // Same dangling-reference risk as #1/#2 (a moved/renamed/deleted
    // requestFilePath) — guarded the same way; 3b above already reports
    // that case on its own, this one just has nothing left to check here.
    if (tool.annotations?.readOnlyHint) {
      const { filePath: reqFilePath, sectionLabel: reqSectionLabel } = resolveRequestLocation(tool, projectRoot)
      try {
        const content = readFileSync(reqFilePath, 'utf-8')
        const section = (await parseVoidFileSections(content)).find((s) => s.label === reqSectionLabel)
        if (section) {
          const { method } = primitives.getRequestPreview(section.blocks)
          if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
            flag(tool, 'readonly-mutating', `Tool "${tool.name}" is annotated readOnlyHint but its request uses ${method.toUpperCase()}.`)
          }
        }
      } catch {
        // Unreadable/missing file — nothing to check; 3b already flags this tool.
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

const CADENCE_MINUTES: Record<string, number> = {
  hourly: 60,
  daily: 60 * 24,
  weekly: 60 * 24 * 7,
  monthly: 60 * 24 * 30,
}
/** An entry with no cadence (or an unrecognized one — not yet an enum in
 *  the block schema, see Pending #1's own note) falls back to this — the
 *  same default the old shared-interval scheduler used, so "no cadence
 *  declared" behaves the same as it always has. */
const DEFAULT_CADENCE_MINUTES = 60

function cadenceMinutes(cadence: string | undefined): number {
  if (!cadence) return DEFAULT_CADENCE_MINUTES
  return CADENCE_MINUTES[cadence.trim().toLowerCase()] ?? DEFAULT_CADENCE_MINUTES
}

/** Every param is agent-supplied at call time (see ToolParamDef), so there's
 *  no agent present to fill one in during verification — this substitutes
 *  each param's own `testValue` instead, the same way an actual agent call
 *  would substitute its args, keyed by `binds` so it lands in the request
 *  the same way. A param with no testValue contributes nothing here; its
 *  {{token}} stays unresolved, and the request correctly fails on it —
 *  honest signal that this param needs a testValue to be verifiable, not a
 *  gap to paper over. */
function testValueEnv(params: ToolParamDef[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const p of params) {
    if (p.testValue !== undefined && p.testValue !== '') env[p.binds] = p.testValue
  }
  return env
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
    const now = opts.now ?? Date.now()
    const cache = opts.entryCache

    const runEntry = async (entry: ToolVerifyEntry) => {
      const filePath = resolvePath(entry.filePath || tool.filePath, opts.projectRoot)
      const run = await primitives.runVoidFile(filePath, {
        sectionLabel: entry.sectionLabel,
        // testValueEnv wins over opts.env for a param's own binds key —
        // it's the tool author's explicit stand-in for this exact param,
        // taking precedence over whatever the same name might otherwise
        // resolve to as a generic project env var.
        env: { ...opts.env, ...testValueEnv(tool.params) },
        runtimeVars,
        activePlugins: opts.activePlugins,
      })
      return run.results[0]?.result
    }

    // Per-entry cadence: each verify row is only actually re-run when its
    // OWN declared cadence says it's due (falling back to `cache.get(key)`
    // otherwise) — not one shared interval for every entry on the tool,
    // let alone the whole server. `entryIndex` (not the entry object
    // itself) is what makes the key stable across the fresh `ToolDef[]`
    // every planServedTools() call re-discovers.
    const resolveEntry = async (entry: ToolVerifyEntry, entryIndex: number): Promise<{ passed: boolean; runResult: any }> => {
      const key = `${tool.toolBlockUid}::${entryIndex}`
      if (cache) {
        const cached = cache.get(key)
        if (cached && now - cached.verifiedAt < cadenceMinutes(entry.cadence) * 60_000) {
          return { passed: cached.passed, runResult: cached.runResult }
        }
      }
      const runResult = await runEntry(entry)
      const passed = runResult ? isAssertionPassed(runResult) : false
      if (cache) cache.set(key, { passed, runResult, verifiedAt: now })
      // Logged only for an entry actually just run (cache hits above return
      // early, before this point) — one line per real verification, not one
      // per cache-hit no-op, so a live server's log genuinely reflects "this
      // network call just happened" rather than spamming every tick for
      // entries that were never due.
      console.error(
        `  ${passed ? '✓' : '✗'}  verify "${tool.name}" [${entry.role}${entry.cadence ? `, cadence: ${entry.cadence}` : ''}] — ${passed ? 'passed' : `failed${runResult?.error ? `: ${runResult.error}` : ''}`}`
      )
      return { passed, runResult }
    }

    let authFailed = false
    let note: string | undefined

    for (const entry of authChecks) {
      const { passed, runResult } = await resolveEntry(entry, tool.verifies.indexOf(entry))
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
      const { passed, runResult } = await resolveEntry(entry, tool.verifies.indexOf(entry))
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

/** onFailure is per-entry (each verify row decides its own consequence),
 *  not tool-wide — so when the tool is 'failing', the applicable policy
 *  comes from whichever entries actually failed, not a single setting.
 *  When failed entries disagree, the most conservative one wins: any
 *  'withdraw' among them withdraws the whole tool; only if EVERY failed
 *  entry says 'advertise-degraded' is it served degraded. */
function combinedOnFailure(status: ToolStatus): ToolOnFailure {
  const failedEntries = status.results.filter((r) => !r.passed).map((r) => r.entry.onFailure || 'withdraw')
  return failedEntries.some((f) => f === 'withdraw') ? 'withdraw' : 'advertise-degraded'
}

function decideServing(statuses: ToolStatus[]): ServeDecision[] {
  return statuses.map((status) => {
    const { tool, state } = status
    // Manual override wins regardless of verification state — the user
    // explicitly said "don't serve this," which isn't something a passing
    // verification result should be able to override.
    if (tool.enabled === false) {
      return { tool, status, served: false, disabledManually: true }
    }
    if (state === 'failing') {
      if (combinedOnFailure(status) === 'withdraw') {
        return { tool, status, served: false }
      }
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
  opts?: { entryCache?: VerifyEntryCache; now?: number },
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
  const statuses = await verifyTools(primitives, validTools, { env: resolvedEnv, activePlugins, entryCache: opts?.entryCache, now: opts?.now, projectRoot })
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
 *  {} rather than guessing which one an unbound {{ENV_VAR}} in a request
 *  should resolve from. */
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

// Every declared param is agent-facing — becomes part of the tool's callable
// inputSchema. A {{token}} that should resolve from the environment instead
// just doesn't get a param row at all (see ToolParamDef's own doc comment).
function buildInputSchema(tool: ToolDef): Record<string, ZodTypeAny> {
  return Object.fromEntries(tool.params.map((p) => [p.name, zodForParam(p)]))
}

function buildToolHandler(
  primitives: RunnerPrimitives,
  tool: ToolDef,
  baseEnv: Record<string, string>,
  runtimeVars: Record<string, any>,
  activePlugins: string[],
  projectRoot: string,
) {
  return async (agentArgs: Record<string, any>) => {
    const env: Record<string, string> = { ...baseEnv }
    for (const p of tool.params) {
      if (agentArgs[p.name] !== undefined) {
        env[p.binds] = typeof agentArgs[p.name] === 'string' ? agentArgs[p.name] : JSON.stringify(agentArgs[p.name])
      }
    }
    const { filePath, sectionLabel } = resolveRequestLocation(tool, projectRoot)
    const run = await primitives.runVoidFile(filePath, { sectionLabel, env, runtimeVars, activePlugins })
    return { content: [{ type: 'text' as const, text: JSON.stringify(run.results[0]?.result, null, 2) }] }
  }
}

/** Plain-JSON version of a param's schema for search_tools' listing — not a
 *  real Zod object (that's only meaningful to server.registerTool's own
 *  inputSchema, which call_tool's single, fixed inputSchema doesn't use per
 *  served tool), just enough for an agent to know what to pass. */
function describeParams(tool: ToolDef): Array<{ name: string; type: string; required: boolean; description?: string }> {
  return tool.params.map((p) => ({ name: p.name, type: p.type, required: p.required, description: p.description }))
}

function registerStaticTools(
  primitives: RunnerPrimitives,
  server: McpServer,
  decisions: ServeDecision[],
  env: Record<string, string>,
  runtimeVars: Record<string, any>,
  activePlugins: string[],
  commitSha: string | undefined,
  projectRoot: string,
): void {
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
      buildToolHandler(primitives, tool, env, runtimeVars, activePlugins, projectRoot),
    )
  }
}

/** `--mode dynamic` — exactly 2 tools instead of one per served /tool block,
 *  so a project with hundreds+ of published endpoints doesn't blow up the
 *  agent's context window with hundreds+ of individually-registered tool
 *  schemas. search_tools lists what's actually being served (each served
 *  tool's own name/description/params/verification state — the same
 *  information static mode would've put directly on the MCP tool listing,
 *  just returned as data instead); call_tool dispatches to one of them by
 *  name, reusing the exact same buildToolHandler() static mode itself
 *  calls — one execution path underneath both modes, just a different
 *  surface on top. */
function registerDynamicTools(
  primitives: RunnerPrimitives,
  server: McpServer,
  decisions: ServeDecision[],
  env: Record<string, string>,
  runtimeVars: Record<string, any>,
  activePlugins: string[],
  commitSha: string | undefined,
  projectRoot: string,
): void {
  const served = new Map<string, { tool: ToolDef; status: ToolStatus; descriptionNote?: string }>()
  for (const d of decisions) {
    if (!d.served || !d.status) continue
    served.set(d.tool.name, { tool: d.tool, status: d.status, descriptionNote: d.descriptionNote })
  }

  server.registerTool(
    'search_tools',
    {
      title: 'Search Tools',
      description: 'List every tool this server currently publishes — name, description, parameters, and verification state. Call this first; call_tool needs an exact name from here.',
      inputSchema: {
        query: z.string().optional().describe('Optional case-insensitive substring to filter by name/title/description. Omit to list everything.'),
      },
    },
    async ({ query }: { query?: string }) => {
      const q = query?.trim().toLowerCase()
      const results = [...served.values()]
        .filter(({ tool }) => !q || [tool.name, tool.title, tool.description].some((s) => s?.toLowerCase().includes(q)))
        .map(({ tool, status, descriptionNote }) => ({
          name: tool.name,
          title: tool.title,
          description: (descriptionNote ?? '') + tool.description,
          params: describeParams(tool),
          annotations: tool.annotations,
          verification: { state: status.state, ...(commitSha ? { commit: commitSha } : {}) },
        }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] }
    },
  )

  server.registerTool(
    'call_tool',
    {
      title: 'Call Tool',
      description: 'Call one of the tools listed by search_tools, by its exact name.',
      inputSchema: {
        name: z.string().describe('A tool name from search_tools\' results.'),
        arguments: z.record(z.any()).optional().describe('Arguments matching that tool\'s own params (see search_tools).'),
      },
    },
    async ({ name, arguments: args }: { name: string; arguments?: Record<string, any> }) => {
      const found = served.get(name)
      if (!found) {
        return {
          content: [{ type: 'text' as const, text: `No tool named "${name}" is currently served. Call search_tools to see what's available.` }],
          isError: true,
        }
      }
      const handler = buildToolHandler(primitives, found.tool, env, runtimeVars, activePlugins, projectRoot)
      return handler(args ?? {})
    },
  )
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
  mode: 'static' | 'dynamic' = 'static',
): void {
  // Computed once for the whole server process, not per-call — the project's
  // env files don't change mid-session. Project vars come first so an
  // explicit override on the server process's own env (e.g. set via
  // .mcp.json's "env" block) still wins on a collision.
  const env: Record<string, string> = { ...loadProjectEnvironmentVars(projectRoot), ...baseEnv }

  if (mode === 'dynamic') {
    registerDynamicTools(primitives, server, decisions, env, runtimeVars, activePlugins, commitSha, projectRoot)
  } else {
    registerStaticTools(primitives, server, decisions, env, runtimeVars, activePlugins, commitSha, projectRoot)
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
    planServedTools: (projectRoot: string, env: Record<string, string>, activePlugins: string[], opts?: { entryCache?: VerifyEntryCache; now?: number }) =>
      planServedTools(primitives, extractFn, projectRoot, env, activePlugins, opts),
    registerServedTools: (
      server: McpServer,
      decisions: ServeDecision[],
      baseEnv: Record<string, string>,
      runtimeVars: Record<string, any>,
      activePlugins: string[],
      commitSha: string | undefined,
      projectRoot: string,
      mode?: 'static' | 'dynamic',
    ) => registerServedTools(primitives, server, decisions, baseEnv, runtimeVars, activePlugins, commitSha, projectRoot, mode),
    upsertToolStatus,
    getCommitSha,
  }
}
