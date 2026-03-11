import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { X, Search, Brain, Lightbulb, FileText, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

interface MemoryEntry {
  id: string;
  type: "fact" | "decision" | "context";
  content: string;
  timestamp: string;
  source?: string;
}

interface MemoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  memories?: MemoryEntry[];
}

const typeConfig = {
  fact: { icon: Lightbulb, color: "text-[var(--color-gold)]", label: "Fact", badge: "gold" as const },
  decision: { icon: Brain, color: "text-[var(--color-emerald)]", label: "Decision", badge: "emerald" as const },
  context: { icon: FileText, color: "text-[var(--color-silver-muted)]", label: "Context", badge: "secondary" as const },
};

const mockMemories: MemoryEntry[] = [
  { id: "1", type: "fact", content: "Project uses bun as package manager", timestamp: "2026-02-22T20:00:00Z", source: "AGENTS.md" },
  { id: "2", type: "decision", content: "Use Zustand for state management with persist middleware", timestamp: "2026-02-22T20:15:00Z", source: "architecture" },
  { id: "3", type: "context", content: "User prefers Swiss theme for minimal interface", timestamp: "2026-02-22T20:30:00Z", source: "settings" },
  { id: "4", type: "fact", content: "WebSocket connection uses exponential backoff for reconnection", timestamp: "2026-02-22T20:45:00Z", source: "use-event-bus.ts" },
  { id: "5", type: "decision", content: "Task detail panel uses slide-in animation from right", timestamp: "2026-02-22T21:00:00Z", source: "task-detail-panel.tsx" },
];

export function MemoryPanel({ isOpen, onClose, memories = mockMemories }: MemoryPanelProps) {
  const [filter, setFilter] = useState<"all" | "fact" | "decision" | "context">("all");
  const [search, setSearch] = useState("");

  const filteredMemories = useMemo(() => {
    return memories.filter((m) => {
      if (filter !== "all" && m.type !== filter) return false;
      if (search && !m.content.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [memories, filter, search]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-40"
            onClick={onClose}
          />
          <motion.div
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed left-0 top-0 h-full w-full sm:w-96 bg-[var(--color-surface-primary)] border-r border-[var(--color-border)] z-50 overflow-y-auto"
          >
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold text-[var(--color-foreground)] flex items-center gap-2">
                  <Brain className="w-5 h-5" />
                  Agent Memory
                </h2>
                <button
                  onClick={onClose}
                  className="p-2 rounded-lg hover:bg-[var(--color-surface-secondary)] transition-colors"
                >
                  <X className="w-5 h-5 text-[var(--color-silver-muted)]" />
                </button>
              </div>

              <div className="space-y-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-silver-muted)]" />
                  <input
                    type="text"
                    placeholder="Search memories..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--color-surface-secondary)] border border-[var(--color-border)] text-sm focus:border-[var(--color-emerald)] focus:outline-none"
                  />
                </div>

                <div className="flex gap-2">
                  {(["all", "fact", "decision", "context"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setFilter(t)}
                      className={cn(
                        "px-3 py-1 rounded-full text-xs font-medium transition-colors",
                        filter === t
                          ? "bg-[var(--color-emerald)] text-[var(--color-obsidian)]"
                          : "bg-[var(--color-surface-secondary)] text-[var(--color-silver-muted)] hover:text-[var(--color-foreground)]"
                      )}
                    >
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>

                <div className="space-y-3">
                  {filteredMemories.length === 0 ? (
                    <div className="text-center text-[var(--color-silver-muted)] py-8">
                      <Brain className="w-8 h-8 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No memories found</p>
                    </div>
                  ) : (
                    filteredMemories.map((memory, i) => {
                      const config = typeConfig[memory.type];
                      const Icon = config.icon;
                      return (
                        <motion.div
                          key={memory.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.05 }}
                        >
                          <Card className="p-3 bg-[var(--color-surface-secondary)]">
                            <div className="flex items-start gap-3">
                              <Icon className={cn("w-4 h-4 mt-0.5", config.color)} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <Badge variant={config.badge} className="text-[10px]">
                                    {config.label}
                                  </Badge>
                                  <span className="text-[10px] text-[var(--color-silver-muted)] flex items-center gap-1">
                                    <Clock className="w-3 h-3" />
                                    {new Date(memory.timestamp).toLocaleTimeString()}
                                  </span>
                                </div>
                                <p className="text-sm text-[var(--color-foreground)]">{memory.content}</p>
                                {memory.source && (
                                  <p className="text-[10px] text-[var(--color-silver-muted)] mt-1">
                                    Source: {memory.source}
                                  </p>
                                )}
                              </div>
                            </div>
                          </Card>
                        </motion.div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
