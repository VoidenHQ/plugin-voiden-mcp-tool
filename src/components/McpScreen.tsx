import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { useToolCapabilityProvider } from "@/core/tools/toolCapabilityRegistry";

type ViewTab = "list" | "verify" | "serve";

const TABS: { id: ViewTab; label: string }[] = [
  { id: "list", label: "List" },
  { id: "verify", label: "Verify" },
  { id: "serve", label: "Serve preview" },
];

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-comment">{children}</div>;
}

function ToolRow({ tool, right }: { tool: any; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-border-subtle">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text">{tool.name}</span>
          {tool.title && <span className="text-xs text-comment">— {tool.title}</span>}
        </div>
        <div className="text-xs text-comment mt-0.5">{tool.description}</div>
        <div className="text-[11px] text-comment mt-1">
          params: {tool.params?.length ?? 0} · verifies: {tool.verifies?.length ?? 0} · on-failure: {tool.onFailure}
        </div>
      </div>
      {right}
    </div>
  );
}

const STATE_ICON: Record<string, React.ReactNode> = {
  verified: <CheckCircle2 size={14} className="text-green-500" />,
  unverified: <ShieldCheck size={14} className="text-comment" />,
  failing: <XCircle size={14} className="text-red-500" />,
};

function StatusResultRow({ status }: { status: any }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-border-subtle">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between gap-4 px-4 py-3 text-left hover:bg-active/50"
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {STATE_ICON[status.state]}
          <span className="text-sm font-medium text-text truncate">{status.tool.name}</span>
          <span className="text-xs text-comment">{status.state}</span>
        </div>
        {status.note && <span className="text-xs text-comment truncate max-w-[40%]">{status.note}</span>}
      </button>
      {expanded && (
        <div className="px-4 pb-3 pl-9 space-y-1">
          {status.results.length === 0 && <div className="text-xs text-comment italic">No verification rows ran.</div>}
          {status.results.map((r: any, i: number) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              {r.passed ? <CheckCircle2 size={12} className="text-green-500" /> : <XCircle size={12} className="text-red-500" />}
              <span className="text-text">{r.entry.role}: {r.entry.sectionLabel}</span>
              {!r.passed && <span className="text-comment">({r.reason}{r.error ? ` — ${r.error}` : ""})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ServeDecisionRow({ decision, provider, onChanged }: { decision: any; provider: any; onChanged: () => void }) {
  const [toggling, setToggling] = useState(false);
  const label = decision.disabledManually
    ? "REMOVED"
    : decision.excluded
    ? "EXCLUDED"
    : decision.served
    ? (decision.descriptionNote ? `SERVED (${decision.status?.state})` : "SERVED")
    : "WITHDRAWN";
  const color = decision.disabledManually || decision.excluded || !decision.served ? "text-red-500" : decision.descriptionNote ? "text-yellow-500" : "text-green-500";
  const isEnabled = decision.tool.enabled !== false;

  const toggle = async () => {
    if (toggling || decision.excluded) return; // structural exclusions aren't a serve toggle
    setToggling(true);
    try {
      await provider.setToolEnabled(decision.tool, !isEnabled);
      onChanged();
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-border-subtle">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${color}`}>{label}</span>
          <span className="text-sm text-text">{decision.tool.name}</span>
        </div>
        {decision.excludedReasons?.map((r: string, i: number) => (
          <div key={i} className="text-xs text-comment mt-1 pl-1">{r}</div>
        ))}
        {decision.status?.note && <div className="text-xs text-comment mt-1 pl-1">{decision.status.note}</div>}
      </div>
      {!decision.excluded && (
        <button
          onClick={() => void toggle()}
          disabled={toggling}
          className="shrink-0 px-2 py-1 text-xs rounded border border-border text-comment hover:text-text hover:bg-active/50 disabled:opacity-50"
        >
          {toggling ? "…" : isEnabled ? "Remove" : "Add back"}
        </button>
      )}
    </div>
  );
}

export default function McpScreen() {
  const [activeTab, setActiveTab] = useState<ViewTab>("list");
  const [tools, setTools] = useState<any[] | null>(null);
  const [verifyResult, setVerifyResult] = useState<{ issues: any[]; statuses: any[] } | null>(null);
  const [servedDecisions, setServedDecisions] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const provider = useToolCapabilityProvider();

  const loadList = async () => {
    if (!provider) return;
    setLoading(true);
    setError(null);
    try {
      setTools(await provider.discoverTools());
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  const runVerify = async () => {
    if (!provider) return;
    setLoading(true);
    setError(null);
    try {
      const discovered = await provider.discoverTools();
      const { validTools, issues } = await provider.validateTools(discovered);
      const statuses = await provider.verifyTools(validTools);
      setVerifyResult({ issues, statuses });
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadServed = async () => {
    if (!provider) return;
    setLoading(true);
    setError(null);
    try {
      setServedDecisions(await provider.planServedTools());
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Also re-fires when `provider` transitions from undefined → registered
    // (e.g. the tab was already open on a fresh app launch, before
    // voiden-mcp-tool's plugin.ts finished loading) — without this, a tab
    // opened too early would stay stuck showing "not registered" forever.
    if (activeTab === "list" && tools === null) void loadList();
    if (activeTab === "serve" && servedDecisions === null) void loadServed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, provider]);

  return (
    <div className="h-full w-full bg-editor text-text flex flex-col">
      <div className="px-4 py-3 border-b border-border">
        <div className="text-sm font-semibold text-text">MCP</div>
        <div className="text-xs text-comment mt-0.5">
          Discover, verify, and preview what's served to an AI agent from your /tool blocks in this project.
        </div>
      </div>

      <div className="flex items-center gap-1 px-4 pt-2 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-3 py-1.5 text-xs rounded-t-md ${activeTab === t.id ? "bg-editor text-text border border-border border-b-editor -mb-px" : "text-comment hover:text-text"}`}
          >
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        {activeTab === "list" && (
          <button onClick={() => void loadList()} disabled={loading} className="mb-1 flex items-center gap-1 px-2 py-1 text-xs text-comment hover:text-text disabled:opacity-50">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
          </button>
        )}
        {activeTab === "verify" && (
          <button onClick={() => void runVerify()} disabled={loading} className="mb-1 flex items-center gap-1 px-2 py-1 text-xs text-comment hover:text-text disabled:opacity-50">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} Run verification
          </button>
        )}
        {activeTab === "serve" && (
          <button onClick={() => void loadServed()} disabled={loading} className="mb-1 flex items-center gap-1 px-2 py-1 text-xs text-comment hover:text-text disabled:opacity-50">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {!provider && (
          <EmptyState>
            No /tool-block capability provider is registered — is the voiden-mcp-tool plugin enabled?
          </EmptyState>
        )}
        {provider && error && <EmptyState>{error}</EmptyState>}

        {provider && !error && activeTab === "list" && (
          tools === null ? (
            <EmptyState>{loading ? "Loading…" : "—"}</EmptyState>
          ) : tools.length === 0 ? (
            <EmptyState>No /tool blocks found in this project.</EmptyState>
          ) : (
            tools.map((t) => <ToolRow key={`${t.filePath}:${t.toolBlockUid}`} tool={t} />)
          )
        )}

        {provider && !error && activeTab === "verify" && (
          verifyResult === null ? (
            <EmptyState>{loading ? "Verifying…" : "Click \"Run verification\" to check every /tool block for real. This runs its verification requests silently — no response tabs open."}</EmptyState>
          ) : (
            <>
              {verifyResult.issues.length > 0 && (
                <div className="px-4 py-2 text-xs text-comment border-b border-border-subtle">
                  {verifyResult.issues.length} tool(s) excluded due to structural issues (shown in Serve preview).
                </div>
              )}
              {verifyResult.statuses.length === 0 ? (
                <EmptyState>No valid /tool blocks to verify.</EmptyState>
              ) : (
                verifyResult.statuses.map((s) => <StatusResultRow key={`${s.tool.filePath}:${s.tool.toolBlockUid}`} status={s} />)
              )}
            </>
          )
        )}

        {provider && !error && activeTab === "serve" && (
          servedDecisions === null ? (
            <EmptyState>{loading ? "Loading…" : "—"}</EmptyState>
          ) : servedDecisions.length === 0 ? (
            <EmptyState>No /tool blocks found in this project.</EmptyState>
          ) : (
            <>
              <div className="px-4 py-2 text-xs text-comment border-b border-border-subtle">
                This is what's served to a connected agent right now — plus the 4 standard tools (list_void_files, list_requests, run_request, write_result), always included.
              </div>
              {servedDecisions.map((d) => (
                <ServeDecisionRow
                  key={`${d.tool.filePath}:${d.tool.toolBlockUid}`}
                  decision={d}
                  provider={provider}
                  onChanged={() => void loadServed()}
                />
              ))}
            </>
          )
        )}
      </div>
    </div>
  );
}
