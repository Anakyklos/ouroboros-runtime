/**
 * TheCouncil — Painel de Status dos Agentes/Bridges
 *
 * Estado desta fase: mostra status real dos agentes externos
 * conforme retornado por daemon.list_agents.
 *
 * O que é real: disponibilidade dos bridges (gemini, antigravity, jules, glm)
 * O que não existe ainda: debate multi-agente em tempo real (Phase 3+)
 */

import { useCallback } from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useMissionControlStore, type AgentBridgeStatus } from "@/stores/mission-control-store";
import { useDaemonAPI } from "@/hooks/use-daemon-api";
import { RefreshCw, CheckCircle, XCircle, HelpCircle, Zap } from "lucide-react";

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

export function TheCouncil() {
  const connectionStatus = useMissionControlStore((s) => s.connectionStatus);
  const agentBridgeStatus = useMissionControlStore((s) => s.agentBridgeStatus);
  const agentsTimedOut = useMissionControlStore((s) => s.agentsStatusTimedOut);
  const { fetchAgents, isLoading } = useDaemonAPI();

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
            className="flex items-center justify-between p-3 rounded-lg bg-[var(--color-surface-secondary)] border border-[var(--color-border)]"
          >
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
              <StatusIcon status={status} />
              <StatusBadge status={status} />
            </div>
          </motion.div>
        ))}
      </div>

      <div className="mt-4 pt-3 border-t border-[var(--color-border)]">
        <div className="flex items-center gap-2 text-xs text-[var(--color-silver-muted)]">
          <Zap className="w-3 h-3" />
          <span>Dispatch tasks via daemon.delegate RPC</span>
        </div>
        <div className="mt-1 text-xs text-[var(--color-silver-muted)]">
          Multi-agent review (debate simulation) disponível na Phase 3
        </div>
      </div>
    </Card>
  );
}