import { useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, RotateCcw, Clock, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Task } from "@/stores/mission-control-store";

interface TaskDetailPanelProps {
  task: Task | null;
  isOpen: boolean;
  onClose: () => void;
  onRetry?: (taskId: string) => void;
  logs?: Array<{ timestamp: string; message: string; level: string }>;
}

const statusConfig: Record<string, { icon: typeof Clock; color: string; label: string }> = {
  planning: { icon: Clock, color: "text-[var(--color-silver-muted)]", label: "Planning" },
  coding: { icon: Loader2, color: "text-[var(--color-gold)]", label: "Coding" },
  testing: { icon: Loader2, color: "text-[var(--color-gold)]", label: "Testing" },
  reviewing: { icon: Loader2, color: "text-[var(--color-gold)]", label: "Reviewing" },
  complete: { icon: CheckCircle, color: "text-[var(--color-emerald)]", label: "Complete" },
  paused: { icon: AlertCircle, color: "text-[var(--color-silver-muted)]", label: "Paused" },
  stuck: { icon: AlertCircle, color: "text-[var(--color-ruby)]", label: "Stuck" },
};

export function TaskDetailPanel({ task, isOpen, onClose, onRetry, logs = [] }: TaskDetailPanelProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, handleKeyDown]);

  if (!task) return null;

  const config = statusConfig[task.phase] || statusConfig.pending;
  const StatusIcon = config.icon;

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
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed right-0 top-0 h-full w-full sm:w-96 bg-[var(--color-surface-primary)] border-l border-[var(--color-border)] z-50 overflow-y-auto"
          >
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold text-[var(--color-foreground)]">Task Details</h2>
                <button
                  onClick={onClose}
                  className="p-2 rounded-lg hover:bg-[var(--color-surface-secondary)] transition-colors"
                >
                  <X className="w-5 h-5 text-[var(--color-silver-muted)]" />
                </button>
              </div>

              <div className="space-y-6">
                <Card className="p-4 bg-[var(--color-surface-secondary)]">
                  <div className="flex items-start justify-between mb-3">
                    <Badge variant={
                      task.phase === "complete" ? "emerald" :
                      ["coding", "testing", "reviewing"].includes(task.phase) ? "gold" :
                      task.phase === "stuck" ? "ruby" : "secondary"
                    }>
                      {config.label}
                    </Badge>
                    <StatusIcon className={cn("w-5 h-5", config.color, ["coding", "testing", "reviewing"].includes(task.phase) && "animate-spin")} />
                  </div>

                  <h3 className="text-base font-semibold text-[var(--color-foreground)] mb-2">
                    {task.title}
                  </h3>

                  <p className="text-sm text-[var(--color-silver-muted)] mb-4">
                    {task.description || "No description provided."}
                  </p>

                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-[var(--color-silver-muted)]">Task ID</span>
                      <span className="font-mono text-[var(--color-foreground)]">{task.id}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--color-silver-muted)]">Phase</span>
                      <span className="text-[var(--color-foreground)]">{task.phase}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--color-silver-muted)]">Created</span>
                      <span className="text-[var(--color-foreground)]">
                        {task.createdAt ? new Date(task.createdAt).toLocaleString() : "N/A"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--color-silver-muted)]">Updated</span>
                      <span className="text-[var(--color-foreground)]">
                        {task.updatedAt ? new Date(task.updatedAt).toLocaleString() : "N/A"}
                      </span>
                    </div>
                  </div>
                </Card>

                {task.phase === "stuck" && onRetry && (
                  <Button
                    onClick={() => onRetry(task.id)}
                    className="w-full bg-[var(--color-emerald)] hover:bg-[var(--color-emerald)]/80"
                  >
                    <RotateCcw className="w-4 h-4 mr-2" />
                    Retry Task
                  </Button>
                )}

                <div>
                  <h3 className="text-sm font-semibold text-[var(--color-foreground)] mb-3">
                    Execution Logs
                  </h3>
                  <Card className="p-3 bg-[var(--color-obsidian)] max-h-64 overflow-y-auto">
                    {logs.length > 0 ? (
                      <div className="space-y-1 font-mono text-xs">
                        {logs.map((log, i) => (
                          <div key={i} className="flex gap-2">
                            <span className="text-[var(--color-silver-muted)]">{log.timestamp}</span>
                            <span className={cn(
                              log.level === "error" && "text-[var(--color-ruby)]",
                              log.level === "warn" && "text-[var(--color-gold)]",
                              log.level === "info" && "text-[var(--color-emerald)]",
                              !["error", "warn", "info"].includes(log.level) && "text-[var(--color-foreground)]"
                            )}>
                              {log.message}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-[var(--color-silver-muted)] italic">
                        No execution logs available
                      </p>
                    )}
                  </Card>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
