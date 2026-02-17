import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface TaskProgress {
  id: string;
  title: string;
  progress: number;
  phase: "planning" | "coding" | "testing" | "reviewing" | "complete" | "paused" | "stuck";
}

interface TheStrikeProps {
  waveId?: string;
  tasks?: TaskProgress[];
  eta?: string;
  tokens?: number;
  slots?: string;
}

const phaseConfig = {
  planning: { color: "bg-sky-400", label: "planning" },
  coding: { color: "bg-emerald", label: "coding" },
  testing: { color: "bg-gold", label: "testing" },
  reviewing: { color: "bg-violet-400", label: "reviewing" },
  complete: { color: "bg-emerald", label: "done" },
  paused: { color: "bg-gold", label: "paused" },
  stuck: { color: "bg-status-stuck", label: "stuck" },
};

function PhaseIndicator({ phase }: { phase: TaskProgress["phase"] }) {
  const phases = ["planning", "coding", "testing", "reviewing", "complete"];
  const currentIndex = phases.indexOf(phase);
  
  return (
    <div className="flex items-center gap-1">
      {phases.map((p, i) => {
        const isPast = i < currentIndex;
        const isCurrent = i === currentIndex;
        
        return (
          <motion.div
            key={p}
            className={cn(
              "w-2 h-2 rounded-full",
              isPast && "bg-emerald",
              isCurrent && phaseConfig[phase].color,
              !isPast && !isCurrent && "bg-[var(--border)]"
            )}
            animate={isCurrent ? { scale: [1, 1.2, 1] } : {}}
            transition={{ duration: 1, repeat: Infinity }}
          />
        );
      })}
    </div>
  );
}

export function TheStrike({
  waveId = "42",
  tasks = [
    { id: "1", title: "Auth Implementation", progress: 100, phase: "complete" },
    { id: "2", title: "API Integration", progress: 67, phase: "coding" },
    { id: "3", title: "Database Schema", progress: 23, phase: "planning" },
  ],
  eta = "~4min",
  tokens = 12400,
  slots = "3/3",
}: TheStrikeProps) {
  return (
    <Card className="h-full p-4 flex flex-col bg-[var(--surface-primary)] border-[var(--border)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <span className="text-xl">⚡</span>
          THE STRIKE
          <Badge variant="emerald">Executing</Badge>
        </h2>
        <span className="text-sm text-[var(--muted-foreground)]">
          Wave #{waveId} — {tasks.length} tasks
        </span>
      </div>

      <div className="flex-1 space-y-4 overflow-auto">
        {tasks.map((task, index) => (
          <motion.div
            key={task.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
            className="space-y-2"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm font-semibold">
                  Task {String.fromCharCode(65 + index)}:
                </span>
                <span className="text-sm">{task.title}</span>
                {task.phase === "stuck" && (
                  <Badge variant="ruby">STUCK</Badge>
                )}
                {task.phase === "paused" && (
                  <Badge variant="gold">PAUSED</Badge>
                )}
              </div>
              <div className="flex items-center gap-3">
                <PhaseIndicator phase={task.phase} />
                <span className="font-mono text-sm font-bold w-12 text-right">
                  {task.progress}%
                </span>
              </div>
            </div>
            
            <div className="relative h-2 rounded-full bg-[var(--surface-tertiary)] overflow-hidden">
              <motion.div
                className={cn(
                  "h-full rounded-full",
                  task.phase === "complete" ? "bg-emerald" : "bg-gold",
                  task.phase === "stuck" && "bg-status-stuck"
                )}
                initial={{ width: 0 }}
                animate={{ width: `${task.progress}%` }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              />
            </div>
          </motion.div>
        ))}
      </div>

      <div className="mt-4 pt-4 border-t border-[var(--border)] flex items-center gap-6 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-[var(--muted-foreground)]">⏱ ETA:</span>
          <span className="font-mono">{eta}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[var(--muted-foreground)]">💰 Tokens:</span>
          <span className="font-mono">{(tokens / 1000).toFixed(1)}k</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[var(--muted-foreground)]">🔄 Slots:</span>
          <span className="font-mono">{slots}</span>
        </div>
      </div>
    </Card>
  );
}