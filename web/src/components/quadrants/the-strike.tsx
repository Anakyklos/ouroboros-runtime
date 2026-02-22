import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useMissionControlStore } from "@/stores/mission-control-store";

interface TaskProgress {
  id: string;
  title: string;
  progress: number;
  phase: "planning" | "coding" | "testing" | "reviewing" | "complete" | "paused" | "stuck";
}

const phaseConfig = {
  planning: { color: "bg-sky-400", label: "planning", badge: "secondary" as const },
  coding: { color: "bg-[var(--color-emerald)]", label: "coding", badge: "emerald" as const },
  testing: { color: "bg-[var(--color-gold)]", label: "testing", badge: "gold" as const },
  reviewing: { color: "bg-violet-400", label: "reviewing", badge: "secondary" as const },
  complete: { color: "bg-[var(--color-emerald)]", label: "done", badge: "emerald" as const },
  paused: { color: "bg-[var(--color-gold)]", label: "paused", badge: "gold" as const },
  stuck: { color: "bg-[var(--color-ruby)]", label: "stuck", badge: "ruby" as const },
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
              isPast && "bg-[var(--color-emerald)]",
              isCurrent && phaseConfig[phase].color,
              !isPast && !isCurrent && "bg-[var(--color-border)]"
            )}
            animate={isCurrent ? { scale: [1, 1.2, 1] } : {}}
            transition={{ duration: 1, repeat: Infinity }}
          />
        );
      })}
    </div>
  );
}

export function TheStrike() {
  const waves = useMissionControlStore((state) => state.waves);
  
  const activeWave = waves.find(w => w.status === "active");
  const tasks: TaskProgress[] = activeWave?.tasks.map(t => ({
    id: t.id,
    title: t.title,
    progress: t.progress,
    phase: t.phase,
  })) || [];

  if (!activeWave || tasks.length === 0) {
    return (
      <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-secondary)] border-[var(--color-border)]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2 text-[var(--color-foreground)]">
            <span className="text-xl">⚡</span>
            THE STRIKE
            <Badge variant="secondary">Idle</Badge>
          </h2>
          <span className="text-sm text-[var(--color-silver-muted)]">
            Task Execution
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-[var(--color-silver-muted)]">
            <div className="text-4xl mb-3">🎯</div>
            <p className="text-sm">No active wave</p>
            <p className="text-xs mt-1">Tasks will appear when a wave is running</p>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-[var(--color-border)] flex items-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-[var(--color-silver-muted)]">Status:</span>
            <span className="font-mono text-[var(--color-silver-muted)]">Waiting...</span>
          </div>
        </div>
      </Card>
    );
  }

  const runningTasks = tasks.filter(t => t.phase !== "complete").length;
  const completedTasks = tasks.filter(t => t.phase === "complete").length;

  return (
    <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-secondary)] border-[var(--color-border)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold flex items-center gap-2 text-[var(--color-foreground)]">
          <span className="text-xl">⚡</span>
          THE STRIKE
          <Badge variant="emerald">Executing</Badge>
        </h2>
        <span className="text-sm text-[var(--color-silver-muted)]">
          Wave #{activeWave.number} — {tasks.length} tasks
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
                <span className="font-mono text-sm font-semibold text-[var(--color-foreground)]">
                  Task {String.fromCharCode(65 + index)}:
                </span>
                <span className="text-sm text-[var(--color-foreground)]">{task.title}</span>
                {task.phase === "stuck" && (
                  <Badge variant="ruby">STUCK</Badge>
                )}
                {task.phase === "paused" && (
                  <Badge variant="gold">PAUSED</Badge>
                )}
              </div>
              <div className="flex items-center gap-3">
                <PhaseIndicator phase={task.phase} />
                <span className="font-mono text-sm font-bold w-12 text-right text-[var(--color-emerald)]">
                  {task.progress}%
                </span>
              </div>
            </div>
            
            <div className="relative h-2 rounded-full bg-[var(--color-surface-tertiary)] overflow-hidden">
              <motion.div
                className={cn(
                  "h-full rounded-full",
                  task.phase === "complete" ? "bg-[var(--color-emerald)]" : "bg-[var(--color-gold)]",
                  task.phase === "stuck" && "bg-[var(--color-ruby)]"
                )}
                initial={{ width: 0 }}
                animate={{ width: `${task.progress}%` }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              />
            </div>
          </motion.div>
        ))}
      </div>

      <div className="mt-4 pt-4 border-t border-[var(--color-border)] flex items-center gap-6 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-[var(--color-silver-muted)]">Running:</span>
          <span className="font-mono text-[var(--color-gold)]">{runningTasks}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[var(--color-silver-muted)]">Done:</span>
          <span className="font-mono text-[var(--color-emerald)]">{completedTasks}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[var(--color-silver-muted)]">Progress:</span>
          <span className="font-mono text-[var(--color-foreground)]">
            {Math.round(tasks.reduce((sum, t) => sum + t.progress, 0) / tasks.length)}%
          </span>
        </div>
      </div>
    </Card>
  );
}
