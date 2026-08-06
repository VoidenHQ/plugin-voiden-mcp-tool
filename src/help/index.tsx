export const ToolHelp = () => (
  <div className="space-y-4">
    <section>
      <h3 className="font-semibold mb-2 text-text">Tool</h3>
      <p className="text-sm text-comment mb-3">
        Marks the request in this section as a named, described capability an AI agent can call
        directly — instead of only the generic list/run/write tools every project gets by default.
        Write the request normally first, then attach this block to declare it agent-callable.
      </p>
    </section>

    <section>
      <h4 className="font-semibold mb-2 text-text">How to Use</h4>
      <ol className="list-decimal list-inside space-y-1 text-sm text-comment">
        <li>Insert with <code className="bg-accent/10 px-1 rounded text-text">/tool</code> in the same section as an existing request</li>
        <li>Give it a stable <strong>name</strong> — this is what the agent calls it by; renaming later breaks anyone whose agent already relies on it</li>
        <li><strong>Description</strong> is the most important field — it's what the agent reads to decide whether to call this. Reuse text you've already written near the request rather than writing it fresh</li>
        <li>Add a row per input in <strong>Parameters</strong> — mark each <code className="bg-accent/10 px-1 rounded text-text">source</code> as <code className="bg-accent/10 px-1 rounded text-text">agent</code> (the AI fills it in) or leave it <code className="bg-accent/10 px-1 rounded text-text">environment</code> (comes from your saved settings, the agent never sees it — the default, so a secret can't leak just because someone forgot to flag it)</li>
        <li>Add at least one row under <strong>Verification</strong> pointing at another request that proves this one works — a tool with no verification requests still shows to agents, just marked "unverified"</li>
      </ol>
    </section>

    <section>
      <h4 className="font-semibold mb-2 text-text">Binding a parameter</h4>
      <p className="text-sm text-comment mb-1">
        <code className="bg-accent/10 px-1 rounded text-text">binds</code> is the literal <code className="bg-accent/10 px-1 rounded text-text">{'{{placeholder}}'}</code> name
        already used somewhere in the request this tool decorates — in the URL, a header, a query param, or the body. A parameter
        row {'{name: "email", binds: "customer_email", source: "agent"}'} means the request already
        contains <code className="bg-accent/10 px-1 rounded text-text">{'{{customer_email}}'}</code> somewhere, and the agent's
        <code className="bg-accent/10 px-1 rounded text-text">email</code> argument becomes that placeholder's value at call time.
      </p>
      <p className="text-xs text-comment italic">
        v1 limitation: only placeholder substitution is supported — there's no JSONPath-into-body addressing. A body
        like <code className="bg-accent/10 px-1 rounded text-text">{'{"email": "{{customer_email}}"}'}</code> already covers per-field binding fine.
      </p>
    </section>

    <section>
      <h4 className="font-semibold mb-2 text-text">Checking it from the CLI</h4>
      <p className="text-sm text-comment">
        <code className="bg-accent/10 px-1 rounded text-text">voiden-runner tool list</code> discovers every <code className="bg-accent/10 px-1 rounded text-text">/tool</code> block
        in a project; <code className="bg-accent/10 px-1 rounded text-text">voiden-runner tool verify</code> actually runs each
        one's verification requests and reports <strong>verified</strong> / <strong>unverified</strong> / <strong>failing</strong>.
        Neither writes to your files unless you pass <code className="bg-accent/10 px-1 rounded text-text">--write</code>.
      </p>
    </section>

    <section>
      <h4 className="font-semibold mb-2 text-text">Role, Mode, and On Failure</h4>
      <p className="text-sm text-comment mb-1">
        <code className="bg-accent/10 px-1 rounded text-text">@voiden/mcp-server</code> verifies every tool at startup, before an agent
        connects, and only registers the ones that should be served:
      </p>
      <ul className="list-disc list-inside space-y-1 text-sm text-comment mb-2">
        <li><strong>Role</strong> (per row) — <code className="bg-accent/10 px-1 rounded text-text">happy path</code> / <code className="bg-accent/10 px-1 rounded text-text">error contract</code> just categorize the proof, but <code className="bg-accent/10 px-1 rounded text-text">auth check</code> rows run first and gate the rest — if one fails, the others are skipped and the tool is marked failing for an auth reason, not a broken-contract one.</li>
        <li><strong>Mode</strong> (per row, defaults to <code className="bg-accent/10 px-1 rounded text-text">live</code>) — set a specific row to <code className="bg-accent/10 px-1 rounded text-text">none</code> to skip running just that one automatically (e.g. a row that would otherwise re-trigger a destructive action). Other rows on the same tool still run normally. <code className="bg-accent/10 px-1 rounded text-text">sandbox</code> is a label only — Voiden runs it exactly like <code className="bg-accent/10 px-1 rounded text-text">live</code>, no redirection happens. It means "the request this row points at already targets a sandbox endpoint" — true only if you actually wrote a sandbox URL into that request. Voiden doesn't define what's sandbox vs production, it only calls whatever URL is there.</li>
        <li><strong>On failure</strong> (once per tool) — <strong>withdraw</strong> (default): a <em>failing</em> tool isn't registered at all, the agent never sees it exists until it passes again. <strong>advertise-degraded</strong>: still registered, but its description is prefixed with a "⚠ DEGRADED" note, so the agent is warned before calling it.</li>
      </ul>
      <p className="text-xs text-comment italic">
        <code className="bg-accent/10 px-1 rounded text-text">voiden-mcp-server &lt;project&gt; --check</code> prints exactly what would be served/withdrawn/degraded/excluded without starting a live session — useful for confirming this before connecting an agent.
      </p>
    </section>

    <section>
      <h4 className="font-semibold mb-2 text-text">Load-time checks (excluded, not just failing)</h4>
      <p className="text-sm text-comment">
        Before verification even runs, a few structural problems get a tool <strong>excluded</strong> from the served set entirely —
        different from "failing," which means the tool's proof ran and didn't pass. Checked: a parameter's <code className="bg-accent/10 px-1 rounded text-text">binds</code> pointing
        at a placeholder missing from the request; a placeholder in the request that no parameter declares; a verification row pointing at a
        section that doesn't exist; two tools sharing the same <code className="bg-accent/10 px-1 rounded text-text">name</code>; and a
        tool annotated <code className="bg-accent/10 px-1 rounded text-text">readOnlyHint</code> whose request actually mutates (POST/PUT/PATCH/DELETE).
        Reported by both <code className="bg-accent/10 px-1 rounded text-text">voiden-runner tool verify</code> and <code className="bg-accent/10 px-1 rounded text-text">--check</code>.
      </p>
    </section>
  </div>
);
