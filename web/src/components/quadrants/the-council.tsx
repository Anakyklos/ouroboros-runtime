import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useLogStore } from "@/stores/log-store";

interface AgentVote {
  name: string;
  avatar: string;
  stance: "approve" | "warn" | "reject";
  message: string;
}

interface CouncilDebate {
  topic: string;
  consensus: number;
  agents: AgentVote[];
  autoMergeIn?: number;
}

const mockDebate: CouncilDebate = {
  topic: "Cache Strategy Implementation",
  consensus: 73,
  autoMergeIn: 28,
  agents: [
    {
      name: "SecurityBot",
      avatar: "🔴",
      stance: "warn",
      message: "Redis without TLS exposes data in transit",
    },
    {
      name: "ArchitectBot",
      avatar: "🟢",
      stance: "approve",
      message: "Internal network only, acceptable risk",
    },
    {
      name: "PerfBot",
      avatar: "🟡",
      stance: "approve",
      message: "Redis adds 2ms per request, worth the trade-off",
    },
  ],
};

const stanceConfig = {
  approve: { color: "emerald", label: "Approve" },
  warn: { color: "gold", label: "Warning" },
  reject: { color: "ruby", label: "Reject" },
};

export function TheCouncil() {
  const { topic, consensus, agents, autoMergeIn } = mockDebate;
  const addLogEntry = useLogStore((state) => state.addEntry);
  
  const getConsensusColor = (value: number) => {
    if (value >= 80) return "bg-emerald";
    if (value >= 60) return "bg-gold";
    return "bg-ruby";
  };

  const handleVeto = () => {
    addLogEntry({
      level: "warn",
      message: `VETO triggered on "${topic}"`,
      source: "Council",
    });
  };

  return (
    <Card className="h-full p-4 flex flex-col bg-[var(--surface-primary)] border-[var(--border)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <span className="text-xl">🏛️</span>
          THE COUNCIL
          <Badge variant={consensus >= 80 ? "emerald" : consensus >= 60 ? "gold" : "ruby"}>
            Debating
          </Badge>
        </h2>
        <span className="text-sm text-[var(--muted-foreground)]">
          Multi-Agent Review
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="mb-4 p-3 rounded-lg bg-[var(--surface-secondary)]">
          <div className="text-sm font-semibold mb-2">
            Topic: <span className="text-emerald">{topic}</span>
          </div>
        </div>

        <div className="space-y-3">
          {agents.map((agent, index) => {
            const config = stanceConfig[agent.stance];
            
            return (
              <motion.div
                key={agent.name}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.15 }}
                className="p-3 rounded-lg bg-[var(--surface-secondary)] border-l-2"
                style={{
                  borderLeftColor:
                    agent.stance === "approve"
                      ? "#10B981"
                      : agent.stance === "warn"
                      ? "#F59E0B"
                      : "#EF4444",
                }}
              >
                <div className="flex items-start gap-3">
                  <span className="text-xl">{agent.avatar}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-sm">{agent.name}</span>
                      <Badge variant={config.color as "emerald" | "gold" | "ruby"}>
                        {config.label}
                      </Badge>
                    </div>
                    <p className="text-sm text-[var(--muted-foreground)]">
                      "{agent.message}"
                    </p>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>

        <div className="mt-4 p-3 rounded-lg border border-emerald/30 bg-emerald/5">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold">CONSENSUS</span>
            <span className="font-mono font-bold text-emerald">{consensus}%</span>
          </div>
          <Progress
            value={consensus}
            className="h-2"
            indicatorClassName={getConsensusColor(consensus)}
          />
          <div className="mt-2 text-xs text-center">
            {consensus >= 80 ? (
              <span className="text-emerald">✓ Auto-merge threshold reached</span>
            ) : (
              <span className="text-gold">⚠ Needs human review below 80%</span>
            )}
          </div>
        </div>
      </div>

      {autoMergeIn && consensus >= 60 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="mt-4 pt-4 border-t border-[var(--border)] flex items-center justify-between"
        >
          <span className="text-sm text-[var(--muted-foreground)]">
            ⏳ Auto-merge in
          </span>
          <div className="flex items-center gap-3">
            <span className="font-mono font-bold text-emerald">{autoMergeIn}s</span>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleVeto}
              className="px-3 py-1 rounded-md bg-ruby/20 text-ruby text-sm font-semibold 
                border border-ruby/30 hover:bg-ruby hover:text-pearl transition-colors"
            >
              VETO
            </motion.button>
          </div>
        </motion.div>
      )}
    </Card>
  );
}