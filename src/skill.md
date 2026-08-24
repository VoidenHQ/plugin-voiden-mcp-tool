## Extension: Voiden Tool

Provides `tool`, `toolparams`, and `toolverifies` block types for marking a request you've already built as a named, described, agent-callable MCP tool — instead of an AI agent only ever seeing the 4 generic tools every project gets by default (`list_void_files`, `list_requests`, `run_request`, `write_result`). Insert with `/tool` in the same section as the request it decorates.

`@voiden/mcp-server` verifies every `/tool` block at startup, before an agent connects, and only registers the ones that pass — see "Verification and serving" below. Presence of a `tool` block is the *only* thing that exposes a request to an agent; nothing else in a project is visible to one.

> **Singleton per section:** `tool` is allowed at most once per section — a section declares at most one agent-callable tool.

### tool — Tool Container

`tool` is a **container** block that wraps `toolparams` and `toolverifies` children. It lives in the **same section** as the request it decorates — reference, don't nest: the request stays an ordinary, runnable-by-a-human request; `tool` only annotates it.

```yaml
---
type: tool
attrs:
  uid: "uid"
  name: create_customer
  title: "Create Customer"
  description: "Creates a new customer record. Requires a unique email."
  annotations:
    readOnlyHint: false
    destructiveHint: false
    idempotentHint: false
    openWorldHint: true
  requestUid: "uid-of-the-sibling-request-block"
content:
  - type: toolparams
    attrs: { uid: "uid", rows: [] }
  - type: toolverifies
    attrs: { uid: "uid", onFailure: withdraw, rows: [] }
---
```

| Attr | Notes |
|---|---|
| `name` | Agent-facing tool identifier. Stable — renaming breaks any agent already relying on it. Must be unique across every tool served in a project (see "Load-time validation"). |
| `title` | Optional human-readable display name. Not read by the agent. |
| `description` | The single highest-leverage field — what the agent reads to decide whether to call this. Reuse prose you've already written near the request rather than writing it fresh. |
| `annotations` | `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` — maps directly onto MCP's own tool `annotations` shape, byte-for-byte. Advisory only, not enforced by any client. |
| `requestUid` | Best-effort link to the sibling request block's `uid`, auto-filled at insert time. Informational only — running/verifying the tool happens by `(filePath, sectionLabel)`, not this uid. |

### toolparams — Input Schema

Child of `tool`. One row per agent-callable input, stored as `attrs.rows` (not a nested table — the same format `runtime-variables` blocks already use, since a plain 2-column table can't hold typed/dropdown fields per row).

```yaml
- type: toolparams
  attrs:
    uid: "uid"
    rows:
      - name: email
        binds: customer_email
        type: string
        required: true
        description: "Email address for the new customer. Must be unique."
        source: agent
      - name: api_key
        binds: stripe_key
        type: string
        required: true
        source: environment
```

| Field | Notes |
|---|---|
| `name` | What the agent calls this argument. |
| `binds` | The literal `{{placeholder}}` name already present somewhere in the decorated request (URL, header, query param, body). At call time, the resolved value substitutes into that placeholder — the same substitution mechanism every `.void` request already uses, nothing new. |
| `type` | `string` \| `number` \| `integer` \| `boolean` \| `object` \| `array` — becomes the actual JSON-schema type in the tool's callable input schema. |
| `required` | Boolean. |
| `description` | Explains this specific input to the agent. |
| `source` | `agent` (the AI supplies it, becomes part of the callable input schema) or `environment` (resolves server-side from the MCP server process's own environment — e.g. set in `.mcp.json`'s `env` block — and is **never** exposed to or fillable by the agent). **Defaults to `environment` when omitted** — fail closed, so a credential can't leak just because someone forgot to flag a param. |

### toolverifies — Verification Policy

Child of `tool`. Which other requests prove this tool currently works, plus what happens if they don't.

```yaml
- type: toolverifies
  attrs:
    uid: "uid"
    onFailure: withdraw   # withdraw | advertise-degraded
    rows:
      - sectionLabel: "Create customer — happy path"
        role: happy-path
        cadence: commit
      - sectionLabel: "Create customer — invalid email"
        role: error-contract
        cadence: nightly
      - sectionLabel: "Auth check"
        role: auth-check
        cadence: commit
        mode: live
```

**Per-row fields:**

| Field | Notes |
|---|---|
| `sectionLabel` | Which section to actually run as proof. |
| `filePath` | Optional — proof request lives in a different `.void` file. Omit to default to the same file the `tool` block is in. |
| `role` | `happy-path` (the tool's own normal case) \| `error-contract` (bad-input handling) \| `auth-check`. `auth-check` rows run **first** and gate the rest — if one fails, dependent `happy-path`/`error-contract` rows are skipped entirely and the tool is tagged an auth failure, not a broken contract (a rotated token shouldn't be treated the same as an actually-broken API). |
| `cadence` | Free-text tag (e.g. `nightly`). Purely a filter — `voiden-runner tool verify --cadence nightly` runs only matching rows. Nothing self-schedules; you or your CI decide when a cadence actually runs. |
| `mode` | `live` (default — runs for real), `sandbox`, or `none` (skip running just this row automatically, e.g. a row that would otherwise re-trigger something destructive). Per-row, not per-tool — sibling rows on the same tool still run normally. **`sandbox` is a label, not a redirection** — Voiden runs it exactly like `live` (same code path, no special-casing). It means "the request this row points at already targets a sandbox endpoint," and that's true only if you actually wrote a sandbox URL into that request — Voiden doesn't define or verify what's sandbox vs production, it only calls whatever URL is there. Same relationship `cadence` already has to voiden-runner: a tag it reports/filters by, never interprets. |

**Tool-level field:**

| Field | Notes |
|---|---|
| `onFailure` | `withdraw` (default) — a `failing` tool isn't registered at all, the agent never learns it exists until it passes again. `advertise-degraded` — still registered, but its description is prefixed with a "⚠ DEGRADED" note naming the failure, so the agent is warned before calling it. |

### Verification states

Three states, not a boolean — computed by `verifyTools()`, always fresh, never trusted from a stale write:

- **verified** — every matching `happy-path`/`error-contract` row ran and passed.
- **unverified** — no rows attached, no rows matched the current cadence filter, every matching row is `mode: none`, or the tool's own `role: auth-check` proof was skipped for some other reason. Still served, description prefixed with an explicit "[unverified — ...]" clause.
- **failing** — at least one row ran and failed. Governed by `onFailure` (see above).

### Load-time validation (excluded, not just failing)

Before verification even runs, `voiden-runner tool verify` / `@voiden/mcp-server --check` structurally validate every discovered tool and **exclude** (not just warn about) any with a broken contract — different from "failing," which means the proof ran and didn't pass:

- an `agent`-sourced param's `binds` value has no matching `{{token}}` anywhere in the request it decorates;
- a `{{token}}` in the request that no param declares (it can only resolve if it happens to be a real environment variable outside Voiden's knowledge);
- a `verifies` row pointing at a section that doesn't exist;
- two tools sharing the same `name` (both are excluded, not just the second one found);
- a `readOnlyHint: true` tool whose request actually uses `POST`/`PUT`/`PATCH`/`DELETE`.

Excluded tools are reported distinctly from `failing` ones in both the CLI and `--check`'s output.

### Complete example

```markdown
---
version: __VOIDEN_APP_VERSION__
generatedBy: Voiden app
note: This file is auto-generated by the Voiden app
generatedAt: 2025-01-15T10:30:00.000Z
---

# Create Customer

```void
---
type: request
attrs:
  uid: "req1cust0-e5f6-7890-abcd-ef1234567890"
content:
  - type: method
    attrs: { uid: "uid", method: POST, visible: true }
    content: POST
  - type: url
    attrs: { uid: "uid" }
    content: "{{BASE_URL}}/customers"
---
```

```void
---
type: json_body
attrs:
  uid: "uid"
  body: |
    { "email": "{{customer_email}}" }
---
```

```void
---
type: tool
attrs:
  uid: "too1cust0-e5f6-7890-abcd-ef1234567890"
  name: create_customer
  title: "Create Customer"
  description: "Creates a new customer record. Requires a unique email."
  annotations: { destructiveHint: true }
  requestUid: "req1cust0-e5f6-7890-abcd-ef1234567890"
content:
  - type: toolparams
    attrs:
      uid: "uid"
      rows:
        - name: email
          binds: customer_email
          type: string
          required: true
          description: "Email address for the new customer."
          source: agent
  - type: toolverifies
    attrs:
      uid: "uid"
      onFailure: withdraw
      rows:
        - sectionLabel: "Create Customer"
          role: happy-path
          cadence: commit
---
```
```

### Checking it from the CLI

- `voiden-runner tool list [paths...]` — discovers every `/tool` block, no execution.
- `voiden-runner tool verify [paths...] [--cadence <tag>] [--json] [--write]` — runs verification, reports excluded/verified/unverified/failing. `--write` (opt-in only) upserts a timestamped status back into each `tool` block for humans browsing the file; a plain run never touches the file, and the status is never read back as truth on the next run.
- `voiden-mcp-server <project> --check` / `voiden-runner mcp serve <project> --check` — the same discover → validate → verify → decide pipeline both servers use at real startup, without connecting a live session. Prints served / withdrawn / degraded / excluded and exits non-zero if anything needs attention. Both share one registration path (`@voiden/runner`'s `mcpServing.ts`), so a tool's serve decision is identical regardless of which one is actually running.

### Two ways to serve

- **`@voiden/mcp-server`** — stdio only, published to npm, auto-registered with Claude Code/Codex by the Voiden app's Settings toggle or `voiden-runner mcp install`. What most people use.
- **`voiden-runner mcp serve [path] [--http] [--port <n>] [--host <addr>]`** — the same tool set (4 fixed tools plus declared `/tool` capabilities), built into `voiden-runner` itself, for CLI-only users with no Voiden app installed. Defaults to stdio; `--http` serves streamable-HTTP instead, bound to `127.0.0.1` only unless `--host` explicitly opts into wider exposure (prints a warning when it does).

### Notes

- Verification is automatic only — an agent has no way to trigger it itself. It runs once, at server startup, and decides the tool list before the agent ever connects; it does not re-run per call.
- Every served tool carries `_meta['md.voiden/verification'] = {state, last_verified, commit}` — a silent, structured channel alongside the human-readable description note. Nothing currently reads namespaced `_meta`; this is transparency for tooling, not something an agent acts on today.
- `binds` only supports literal placeholder substitution — no JSONPath-into-body addressing. A body like `{"email": "{{customer_email}}"}` already covers per-field binding fine.
