import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useLogStore } from "@/stores/log-store";
import { useMissionControlStore } from "@/stores/mission-control-store";

interface Idea {
  id: string;
  type: "code_improvements" | "ui_ux" | "security" | "performance";
  title: string;
  confidence: number;
}

const ideaTypeConfig = {
  code_improvements: { color: "emerald", label: "Refactor" },
  ui_ux: { color: "gold", label: "UI/UX" },
  security: { color: "ruby", label: "Security" },
  performance: { color: "gold", label: "Perf" },
};

const statusConfig = {
  idle: { label: "Idle", icon: "😴" },
  scanning: { label: "Scanning", icon: "🔍" },
  analyzing: { label: "Analyzing", icon: "🧠" },
  dreaming: { label: "Dreaming", icon: "💭" },
};

export function TheEye() {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "scanning" | "analyzing" | "dreaming">("idle");
  const daemonConnected = useMissionControlStore((state) => state.daemonConnected);
  const addLogEntry = useLogStore((state) => state.addEntry);

  useEffect(() => {
    if (!daemonConnected) {
      setStatus("idle");
      setCurrentFile(null);
      return;
    }

    setStatus("scanning");

    const handleDaemonEvent = (event: CustomEvent) => {
      const { type, data } = event.detail;

      if (type === "eye:file_scan") {
        setCurrentFile(data.file);
      } else if (type === "eye:idea") {
        const newIdea: Idea = {
          id: `idea-${Date.now()}`,
          type: data.type || "code_improvements",
          title: data.title,
          confidence: data.confidence || 75,
        };
        setIdeas((prev) => [...prev.slice(-4), newIdea]);
        addLogEntry({
          level: "info",
          message: `Idea: ${newIdea.title} (${newIdea.confidence}%)`,
          source: "Eye",
        });
      }
    };

    window.addEventListener("daemon:event", handleDaemonEvent as EventListener);
    return () => {
      window.removeEventListener("daemon:event", handleDaemonEvent as EventListener);
    };
  }, [daemonConnected, addLogEntry]);

  useEffect(() => {
    if (daemonConnected && ideas.length > 0) {
      setStatus("dreaming");
    }
  }, [daemonConnected, ideas.length]);

  const statusInfo = statusConfig[status];
  const stats: Record<string, number> = {
    refactors: ideas.filter(i => i.type === "code_improvements").length,
    security: ideas.filter(i => i.type === "security").length,
    performance: ideas.filter(i => i.type === "performance").length,
  };

  return (
    <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-secondary)] border-[var(--color-border)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold flex items-center gap-2 text-[var(--color-foreground)]">
          <span className="text-xl">🔮</span>
          THE EYE
          <Badge 
            variant={daemonConnected ? (status === "dreaming" ? "gold" : "emerald") : "secondary"}
            className={status === "dreaming" ? "animate-pulse" : ""}
          >
            {statusInfo.icon} {statusInfo.label}
          </Badge>
        </h2>
        <span className="text-xs sm:text-sm text-[var(--color-silver-muted)] font-mono">
          Analysis & Ideation
        </span>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col relative">
        <div className="flex-1 relative border-l border-[var(--color-border)] pl-4 ml-2">
          <div className="absolute inset-0 overflow-hidden">
            <div className="font-mono text-xs text-[var(--color-silver-muted)] opacity-80 space-y-1">
              {currentFile ? (
                <motion.div
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-center gap-2"
                >
                  <span className="text-[var(--color-emerald)]">▸</span>
                  <span className="text-[var(--color-foreground)]">{currentFile}</span>
                </motion.div>
              ) : (
                <div className="text-[var(--color-silver-muted)]/50 italic">
                  {daemonConnected ? "Waiting for scan..." : "Disconnected from daemon"}
                </div>
              )}
            </div>
          </div>

          <AnimatePresence>
            {ideas.map((idea, index) => (
              <motion.div
                key={idea.id}
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: -20 }}
                transition={{ type: "spring", stiffness: 200 }}
                className="absolute w-full pr-4"
                style={{ top: `${20 + index * 20}%`, left: "0" }}
              >
                <div className="p-2 sm:px-3 sm:py-2 rounded-lg bg-[var(--color-surface-tertiary)] border border-[var(--color-emerald)]/30 shadow-lg flex items-center justify-between gap-2 backdrop-blur-sm">
                  <div className="flex items-center gap-2 truncate">
                    <div className={`w-2 h-2 rounded-full bg-[var(--color-${ideaTypeConfig[idea.type].color})]`} />
                    <span className="text-xs sm:text-sm truncate text-[var(--color-foreground)]">{idea.title}</span>
                  </div>
                  <span className="text-xs font-mono text-[var(--color-emerald)] whitespace-nowrap">
                    {idea.confidence}%
                  </span>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 text-center border-t border-[var(--color-border)] pt-4">
          {(["code_improvements", "security", "performance"] as const).map((type) => (
            <div key={type} className="p-1 rounded hover:bg-[var(--color-surface-tertiary)] transition-colors">
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-silver-muted)] mb-1">
                {ideaTypeConfig[type].label}
              </div>
              <div className="font-mono text-sm sm:text-base font-bold text-[var(--color-emerald)]">
                {stats[type === "code_improvements" ? "refactors" : type]}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
