import { useState } from "react";
import { motion } from "framer-motion";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useMissionControlStore, type Wave } from "@/stores/mission-control-store";
import { GripVertical, Play, CheckCircle, Clock } from "lucide-react";

interface SortableWaveCardProps {
  wave: Wave;
  isPromoting?: boolean;
  onActivate?: (waveId: string) => void;
  minimal?: boolean;
}

function SortableWaveCard({ wave, isPromoting, onActivate, minimal }: SortableWaveCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: wave.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 1,
  };

  const statusConfig = {
    pending: { border: "border-[var(--color-silver-muted)]", badge: "secondary" as const, icon: Clock },
    active: { border: "border-[var(--color-emerald)]", badge: "emerald" as const, icon: Play },
    done: { border: "border-[var(--color-emerald)]/50", badge: "outline" as const, icon: CheckCircle },
    failed: { border: "border-[var(--color-ruby)]", badge: "ruby" as const, icon: CheckCircle },
  };

  const config = statusConfig[wave.status] || statusConfig.pending;

  const taskStatusIcon = {
    pending: "○",
    in_progress: "◐",
    completed: "●",
  };

  const completedTasks = wave.tasks.filter(t => t.phase === "complete").length;
  const totalTasks = wave.tasks.length;
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className={cn(
        "p-3 rounded-lg border-l-4 bg-[var(--color-surface-secondary)] transition-all",
        config.border,
        isDragging && "opacity-50 shadow-lg",
        isPromoting && "animate-pulse ring-2 ring-[var(--color-emerald)]",
        minimal && "border-l-2 p-2"
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {!minimal && (
            <button
              {...attributes}
              {...listeners}
              className="p-1 rounded hover:bg-[var(--color-surface-tertiary)] cursor-grab active:cursor-grabbing"
            >
              <GripVertical className="w-4 h-4 text-[var(--color-silver-muted)]" />
            </button>
          )}
          <span className={cn("font-mono font-bold text-[var(--color-foreground)]", minimal && "text-sm")}>WAVE {wave.number}</span>
          <motion.div
            key={wave.status}
            initial={{ scale: 1.3, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.2 }}
          >
            <Badge variant={config.badge}>{wave.status.toUpperCase()}</Badge>
          </motion.div>
          {wave.status === "active" && !minimal && (
            <motion.span
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ duration: 1, repeat: Infinity }}
              className="text-lg"
            >
              🐍
            </motion.span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--color-silver-muted)]">
            {completedTasks}/{totalTasks} tasks
          </span>
          {wave.status === "pending" && onActivate && !minimal && (
            <button
              onClick={() => onActivate(wave.id)}
              className="p-1.5 rounded-md bg-[var(--color-emerald)]/20 text-[var(--color-emerald)] hover:bg-[var(--color-emerald)] hover:text-[var(--color-obsidian)] transition-colors"
            >
              <Play className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {!minimal && totalTasks > 0 && (
        <div className="mb-2 px-1">
          <div className="h-1.5 bg-[var(--color-surface-tertiary)] rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-[var(--color-emerald)] rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.5, ease: "easeOut" }}
            />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[10px] text-[var(--color-silver-muted)]">{progress}% complete</span>
            {wave.status === "active" && (
              <span className="text-[10px] text-[var(--color-emerald)]">In progress...</span>
            )}
          </div>
        </div>
      )}

      <div className={cn("space-y-1 pl-6", minimal && "pl-2")}>
        {wave.tasks.slice(0, minimal ? 2 : 3).map((task) => (
          <div 
            key={task.id} 
            className="flex items-center gap-2 text-sm py-0.5 cursor-pointer hover:bg-[var(--color-surface-tertiary)] rounded px-1 -mx-1"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("task:click", {
                detail: { taskId: task.id, waveId: wave.id }
              }));
            }}
          >
            <motion.span
              key={task.phase}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className={cn(
                "font-mono",
                task.phase === "complete" && "text-[var(--color-emerald)]",
                task.phase === "coding" && "text-[var(--color-gold)] animate-pulse",
                task.phase !== "complete" && task.phase !== "coding" && "text-[var(--color-silver-muted)]"
              )}
            >
              {taskStatusIcon[task.phase === "complete" ? "completed" : task.phase === "coding" ? "in_progress" : "pending"]}
            </motion.span>
            <span
              className={cn(
                "text-[var(--color-foreground)]",
                task.phase === "complete" && "line-through text-[var(--color-silver-muted)]",
                minimal && "truncate max-w-[200px]"
              )}
            >
              {task.title}
            </span>
          </div>
        ))}
        {wave.tasks.length > (minimal ? 2 : 3) && (
          <div className="text-xs text-[var(--color-silver-muted)] pl-4">
            +{wave.tasks.length - (minimal ? 2 : 3)} more tasks
          </div>
        )}
      </div>
    </motion.div>
  );
}

interface TheCoilProps {
  onWaveActivate?: (waveId: string) => void;
  promotingWave?: string | null;
  className?: string;
  minimal?: boolean;
}

export function TheCoil({ onWaveActivate, promotingWave, className, minimal = false }: TheCoilProps) {
  const waves = useMissionControlStore((state) => state.waves);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (over && active.id !== over.id) {
      console.log(`Reordered: ${active.id} → ${over.id}`);
    }
  };

  const activeWave = waves.find((w) => w.id === activeId);
  const pendingCount = waves.filter(w => w.status === "pending").length;
  const activeCount = waves.filter(w => w.status === "active").length;
  const doneCount = waves.filter(w => w.status === "done").length;

  return (
    <Card className={cn("h-full flex flex-col bg-[var(--color-surface-secondary)] border-[var(--color-border)]", !minimal && "p-4", className)}>
      {!minimal && (
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2 text-[var(--color-foreground)]">
            <span className="text-xl">🐍</span>
            THE COIL
            <Badge variant={activeCount > 0 ? "emerald" : pendingCount > 0 ? "gold" : "secondary"}>
              {activeCount > 0 ? "Running" : pendingCount > 0 ? "Ready" : "Idle"}
            </Badge>
          </h2>
          <span className="text-sm text-[var(--color-silver-muted)]">
            Wave Queue
          </span>
        </div>
      )}

      {waves.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-[var(--color-silver-muted)]">
            <div className="text-4xl mb-3">🌀</div>
            <p className="text-sm">No waves in queue</p>
            <p className="text-xs mt-1">Waves will appear when tasks are scheduled</p>
          </div>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={waves.map((w) => w.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className={cn("flex-1 overflow-auto space-y-3", minimal && "space-y-2 pr-1")}>
              {waves.map((wave) => (
                <SortableWaveCard
                  key={wave.id}
                  wave={wave}
                  isPromoting={promotingWave === wave.id}
                  onActivate={onWaveActivate}
                  minimal={minimal}
                />
              ))}
            </div>
          </SortableContext>

          <DragOverlay>
            {activeWave ? (
              <div className="p-3 rounded-lg border-l-4 border-[var(--color-emerald)] bg-[var(--color-surface-secondary)] shadow-xl opacity-90">
                <div className="font-mono font-bold text-[var(--color-foreground)]">WAVE {activeWave.number}</div>
                <div className="text-sm text-[var(--color-silver-muted)]">
                  {activeWave.tasks.length} tasks
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {!minimal && (
        <div className="mt-4 pt-4 border-t border-[var(--color-border)] flex items-center justify-between text-sm">
          <span className="text-[var(--color-silver-muted)]">
            Queue: {pendingCount} pending • {doneCount} done
          </span>
          <span className="font-mono text-[var(--color-emerald)]">
            {activeCount > 0 ? "Wave active" : "Ready for tasks"}
          </span>
        </div>
      )}
    </Card>
  );
}
