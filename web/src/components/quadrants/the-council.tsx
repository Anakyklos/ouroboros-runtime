import { motion, AnimatePresence } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useMissionControlStore } from "@/stores/mission-control-store";
import { useLogStore } from "@/stores/log-store";
import { useEffect, useState } from "react";

const stanceConfig = {
  approve: { color: "emerald" as const, label: "Approve" },
  warn: { color: "gold" as const, label: "Warning" },
  reject: { color: "ruby" as const, label: "Reject" },
};

export function TheCouncil() {
  const currentDebate = useMissionControlStore((state) => state.currentDebate);
  const addLogEntry = useLogStore((state) => state.addEntry);
  const [showCelebration, setShowCelebration] = useState(false);

  useEffect(() => {
    if (currentDebate && currentDebate.consensus >= 80) {
      setShowCelebration(true);
      const timer = setTimeout(() => setShowCelebration(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [currentDebate?.consensus]);

  if (!currentDebate) {
    return (
      <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-secondary)] border-[var(--color-border)]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2 text-[var(--color-foreground)]">
            <span className="text-xl">🏛️</span>
            THE COUNCIL
            <Badge variant="secondary">Idle</Badge>
          </h2>
          <span className="text-sm text-[var(--color-silver-muted)]">
            Multi-Agent Review
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-[var(--color-silver-muted)]">
            <div className="text-4xl mb-3">⚖️</div>
            <p className="text-sm">No active debate</p>
            <p className="text-xs mt-1">Council will convene when tasks need review</p>
          </div>
        </div>
      </Card>
    );
  }

  const { topic, consensus, agents, autoMergeIn } = currentDebate;

  const getConsensusColor = (value: number) => {
    if (value >= 80) return "bg-[var(--color-emerald)]";
    if (value >= 60) return "bg-[var(--color-gold)]";
    return "bg-[var(--color-ruby)]";
  };

  const handleVeto = () => {
    addLogEntry({
      level: "warn",
      message: `VETO triggered on "${topic}"`,
      source: "Council",
    });
  };

  return (
    <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-secondary)] border-[var(--color-border)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold flex items-center gap-2 text-[var(--color-foreground)]">
          <span className="text-xl">🏛️</span>
          THE COUNCIL
          <Badge variant={consensus >= 80 ? "emerald" : consensus >= 60 ? "gold" : "ruby"}>
            Debating
          </Badge>
        </h2>
        <span className="text-sm text-[var(--color-silver-muted)]">
          Multi-Agent Review
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="mb-4 p-3 rounded-lg bg-[var(--color-surface-tertiary)]">
          <div className="text-sm font-semibold text-[var(--color-silver-muted)]">
            Topic: <span className="text-[var(--color-emerald)]">{topic}</span>
          </div>
        </div>

        <div className="space-y-3">
          {agents.map((agent, index) => {
            const config = stanceConfig[agent.stance];
            const borderColor = agent.stance === "approve" 
              ? "border-l-[var(--color-emerald)]" 
              : agent.stance === "warn" 
              ? "border-l-[var(--color-gold)]" 
              : "border-l-[var(--color-ruby)]";
            
            return (
              <motion.div
                key={agent.name}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.15 }}
                className={`p-3 rounded-lg bg-[var(--color-surface-tertiary)] border-l-2 ${borderColor}`}
              >
                <div className="flex items-start gap-3">
                  <span className="text-xl">{agent.avatar}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-semibold text-sm text-[var(--color-foreground)]">{agent.name}</span>
                      <Badge variant={config.color}>{config.label}</Badge>
                    </div>
                    <p className="text-sm text-[var(--color-silver-muted)] truncate">
                      "{agent.message}"
                    </p>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>

        <div className="mt-4 p-3 rounded-lg border border-[var(--color-emerald)]/30 bg-[var(--color-emerald)]/5">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-[var(--color-foreground)]">CONSENSUS</span>
            <span className="font-mono font-bold text-[var(--color-emerald)]">{consensus}%</span>
          </div>
          <Progress
            value={consensus}
            className="h-2"
            indicatorClassName={getConsensusColor(consensus)}
          />
          <div className="mt-2 text-xs text-center">
            {consensus >= 80 ? (
              <motion.span
                initial={{ scale: 1 }}
                animate={{ scale: [1, 1.2, 1] }}
                transition={{ duration: 0.5 }}
                className="text-[var(--color-emerald)]"
              >
                ✓ Consensus reached!
              </motion.span>
            ) : (
              <span className="text-[var(--color-gold)]">⚠ Needs human review below 80%</span>
            )}
          </div>
        </div>

        <AnimatePresence>
          {showCelebration && (
            <motion.div
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5 }}
              className="absolute inset-0 flex items-center justify-center bg-[var(--color-surface-secondary)]/90 rounded-lg z-10"
            >
              <motion.div
                animate={{ 
                  scale: [1, 1.2, 1],
                  rotate: [0, 10, -10, 0]
                }}
                transition={{ duration: 0.5, repeat: 2 }}
                className="text-6xl"
              >
                🎉
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {autoMergeIn && consensus >= 60 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="mt-4 pt-4 border-t border-[var(--color-border)] flex items-center justify-between"
        >
          <span className="text-sm text-[var(--color-silver-muted)]">
            ⏳ Auto-merge in
          </span>
          <div className="flex items-center gap-3">
            <span className="font-mono font-bold text-[var(--color-emerald)]">{autoMergeIn}s</span>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleVeto}
              className="px-3 py-1 rounded-md bg-[var(--color-ruby)]/20 text-[var(--color-ruby)] text-sm font-semibold 
                border border-[var(--color-ruby)]/30 hover:bg-[var(--color-ruby)] hover:text-[var(--color-pearl)] transition-colors"
            >
              VETO
            </motion.button>
          </div>
        </motion.div>
      )}
    </Card>
  );
}
