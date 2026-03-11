/**
 * TheCouncil — Painel de Status dos Agentes/Bridges + Dispatch
 *
 * Estado desta fase:
 * - Status real dos agentes via daemon.list_agents
 * - Botão "Delegate" por agente (gated por status === "available")
 * - Inline prompt → daemon.delegate RPC
 * - Resultados de delegação do store
 */

import { useCallback, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  useMissionControlStore,
  type AgentBridgeStatus,
  type DelegationResult,
} from "@/stores/mission-control-store";
import { useDaemonAPI } from "@/hooks/use-daemon-api";
import {
  RefreshCw,
  CheckCircle,
  XCircle,
  HelpCircle,
  Zap,
  Send,
  X,
  Loader2,
} from "lucide-react";

const AGENT_ICONS: Record<string, string> = {
  gemini: "💎",
  antigravity: "🪐",
  claude: "🔮",
  jules: "🌐",
  glm: "🧠",
};

const AGENT_LABELS: Record<string, string> = {
  gemini: "Gemini CLI",
  antigravity: "Antigravity",
  claude: "Claude (AGY)",
  jules: "Jules",
  glm: "GLM / Z.AI",
};

function StatusIcon({ status }: { status: AgentBridgeStatus }) {
  if (status === "available") {
    return <CheckCircle className="w-4 h-4 text-[var(--color-emerald)]" />;
  }
  if (status === "unavailable") {
    return <XCircle className="w-4 h-4 text-[var(--color-ruby)]" />;
  }
  return <HelpCircle className="w-4 h-4 text-[var(--color-silver-muted)]" />;
}

function StatusBadge({ status }: { status: AgentBridgeStatus }) {
  if (status === "available") return <Badge variant="emerald">Available</Badge>;
  if (status === "unavailable") return <Badge variant="ruby">Unavailable</Badge>;
  return <Badge variant="secondary">Unknown</Badge>;
}

function DelegationResultBadge({ result }: { result: DelegationResult }) {
  if (result.status === "pending") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="w-3 h-3 animate-spin" />
        Delegating…
      </Badge>
    );
  }
  if (result.status === "success") {
    return <Badge variant="emerald">✓ Done</Badge>;
  }
  return (
    <Badge variant="ruby" title={result.error}>
      ✗ Error
    </Badge>
  );
}

interface InlineDelegateFormProps {
  agentName: string;
  onClose: () => void;
}

function InlineDelegateForm({ agentName, onClose }: InlineDelegateFormProps) {
  const [prompt, setPrompt] = useState("");
  const { delegateTask, isLoading } = useDaemonAPI();
  const lastDelegation = useMissionControlStore((s) => s.lastDelegation);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim()) return;
    await delegateTask(agentName, prompt.trim());
    setPrompt("");
  }, [agentName, prompt, delegateTask]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "Escape") onClose();
    },
    [handleSubmit, onClose]
  );

  const showResult =
    lastDelegation &&
    lastDelegation.agent === agentName &&
    lastDelegation.status !== "pending";

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="overflow-hidden"
    >
      <div className="mt-2 p-2 rounded-md bg-[var(--color-surface-tertiary)] border border-[var(--color-border)] space-y-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Delegate to ${AGENT_LABELS[agentName] ?? agentName}...`}
            className="flex-1 bg-transparent border-none outline-none text-sm text-[var(--color-foreground)] placeholder:text-[var(--color-silver-muted)]"
            autoFocus
            disabled={isLoading}
          />
          <button
            onClick={handleSubmit}
            disabled={!prompt.trim() || isLoading}
            className="p-1.5 rounded-md bg-[var(--color-emerald)]/20 text-[var(--color-emerald)] hover:bg-[var(--color-emerald)] hover:text-[var(--color-obsidian)] transition-colors disabled:opacity-40"
            title="Send"
          >
            {isLoading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Send className="w-3 h-3" />
            )}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-[var(--color-silver-muted)] hover:text-[var(--color-ruby)] transition-colors"
            title="Close"
          >
            <X className="w-3 h-3" />
          </button>
        </div>

        {showResult && (
          <div className="flex items-center gap-2 text-xs">
            <DelegationResultBadge result={lastDelegation!} />
            {lastDelegation!.status === "error" && (
              <span className="text-[var(--color-ruby)] truncate">
                {lastDelegation!.error}
              </span>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function TheCouncil() {
  const connectionStatus = useMissionControlStore((s) => s.connectionStatus);
  const agentBridgeStatus = useMissionControlStore((s) => s.agentBridgeStatus);
  const agentsTimedOut = useMissionControlStore((s) => s.agentsStatusTimedOut);
  const isDelegating = useMissionControlStore((s) => s.isDelegating);
  const { fetchAgents, isLoading } = useDaemonAPI();

  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    await fetchAgents();
  }, [fetchAgents]);

  const isDisconnected =
    connectionStatus === "disconnected" || connectionStatus === "unknown";
  const hasAgentData = Object.keys(agentBridgeStatus).length > 0;

  if (isDisconnected) {
    return (
      <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-primary)] border-[var(--color-border)]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            Agents
            <span className="text-xs font-normal text-[var(--color-silver-muted)]">The Council</span>
          </h2>
        </div>
        <EmptyState
          icon="offline"
          message="Daemon not connected"
          description="Connect to the daemon to see agent availability"
        />
      </Card>
    );
  }

  if (!hasAgentData) {
    return (
      <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-primary)] border-[var(--color-border)]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            Agents
            <span className="text-xs font-normal text-[var(--color-silver-muted)]">The Council</span>
          </h2>
          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="flex items-center gap-1 text-xs text-[var(--color-silver-muted)] hover:text-[var(--color-foreground)] transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
            Check agents
          </button>
        </div>
        <EmptyState
          icon="inbox"
          message="Agent status not fetched"
          description="Click 'Check agents' to query bridge availability"
        />
      </Card>
    );
  }

  const availableCount = Object.values(agentBridgeStatus).filter((s) => s === "available").length;
  const totalCount = Object.keys(agentBridgeStatus).length;

  return (
    <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-primary)] border-[var(--color-border)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          Agents
          <span className="text-xs font-normal text-[var(--color-silver-muted)]">The Council</span>
          <Badge variant={availableCount > 0 ? "emerald" : "ruby"}>
            {availableCount}/{totalCount} available
          </Badge>
          {isDelegating && (
            <Badge variant="secondary" className="gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              Delegating
            </Badge>
          )}
        </h2>
        <button
          onClick={handleRefresh}
          disabled={isLoading}
          className="flex items-center gap-1 text-xs text-[var(--color-silver-muted)] hover:text-[var(--color-foreground)] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {agentsTimedOut && (
        <div className="mb-3 px-3 py-2 rounded-md bg-[var(--color-gold)]/10 border border-[var(--color-gold)]/30 text-xs text-[var(--color-gold)]">
          ⚠ Bridge check timed out — some agents may show as unknown
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-auto">
        {Object.entries(agentBridgeStatus).map(([agentName, status], index) => (
          <motion.div
            key={agentName}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.08 }}
          >
            <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--color-surface-secondary)] border border-[var(--color-border)]">
              <div className="flex items-center gap-3">
                <span className="text-xl">{AGENT_ICONS[agentName] ?? "🤖"}</span>
                <div>
                  <div className="font-semibold text-sm">
                    {AGENT_LABELS[agentName] ?? agentName}
                  </div>
                  <div className="text-xs text-[var(--color-silver-muted)]">
                    {agentName}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {status === "available" && (
                  <button
                    onClick={() =>
                      setExpandedAgent(expandedAgent === agentName ? null : agentName)
                    }
                    className="px-2 py-1 rounded-md text-[10px] font-semibold bg-[var(--color-gold)]/20 text-[var(--color-gold)] hover:bg-[var(--color-gold)] hover:text-[var(--color-obsidian)] transition-colors"
                  >
                    {expandedAgent === agentName ? "Close" : "Delegate"}
                  </button>
                )}
                <StatusIcon status={status} />
                <StatusBadge status={status} />
              </div>
            </div>

            <AnimatePresence>
              {expandedAgent === agentName && (
                <InlineDelegateForm
                  agentName={agentName}
                  onClose={() => setExpandedAgent(null)}
                />
              )}
            </AnimatePresence>
          </motion.div>
        ))}
      </div>

      <div className="mt-4 pt-3 border-t border-[var(--color-border)]">
        <div className="flex items-center gap-2 text-xs text-[var(--color-silver-muted)]">
          <Zap className="w-3 h-3" />
          <span>Dispatch tasks via daemon.delegate RPC</span>
        </div>
      </div>
    </Card>
  );
}