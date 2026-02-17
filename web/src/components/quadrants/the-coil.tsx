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
  };

  const config = statusConfig[wave.status] || statusConfig.pending;

  const taskStatusIcon = {
    pending: "○",
    in_progress: "◐",
    completed: "●",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
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
          {!minimal && <Badge variant={config.badge}>{wave.status.toUpperCase()}</Badge>}
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
            {wave.tasks.length} tasks
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

      <div className={cn("space-y-1 pl-6", minimal && "pl-2")}>
        {wave.tasks.slice(0, minimal ? 2 : 3).map((task) => (
          <div key={task.id} className="flex items-center gap-2 text-sm py-0.5">
            <span
              className={cn(
                "font-mono",
                task.phase === "complete" && "text-[var(--color-emerald)]",
                task.phase === "coding" && "text-[var(--color-gold)] animate-pulse",
                task.phase !== "complete" && task.phase !== "coding" && "text-[var(--color-silver-muted)]"
              )}
            >
              {taskStatusIcon[task.phase === "complete" ? "completed" : task.phase === "coding" ? "in_progress" : "pending"]}
            </span>
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
    </div>
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

  const displayWaves = waves.length > 0 ? waves : [
    {
      id: "wave-43",
      number: 43,
      status: "pending" as const,
      tasks: [
        { id: "t1", title: "Fix CSS Variables", progress: 0, phase: "planning" as const },
        { id: "t2", title: "Update Theme", progress: 0, phase: "planning" as const },
        { id: "t3", title: "Add Animations", progress: 0, phase: "planning" as const },
      ],
    },
    {
      id: "wave-42",
      number: 42,
      status: "active" as const,
      tasks: [
        { id: "t4", title: "Auth Implementation", progress: 100, phase: "complete" as const },
        { id: "t5", title: "API Integration", progress: 67, phase: "coding" as const },
        { id: "t6", title: "Database Schema", progress: 23, phase: "planning" as const },
      ],
    },
    {
      id: "wave-41",
      number: 41,
      status: "done" as const,
      tasks: [
        { id: "t7", title: "Setup Project", progress: 100, phase: "complete" as const },
        { id: "t8", title: "Configure Tailwind", progress: 100, phase: "complete" as const },
      ],
    },
  ];

  const activeWave = displayWaves.find((w) => w.id === activeId);

  return (
    <Card className={cn("h-full flex flex-col bg-[var(--color-surface-primary)] border-[var(--color-border)]", !minimal && "p-4", className)}>
      {!minimal && (
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2 text-[var(--color-foreground)]">
            <span className="text-xl">🐍</span>
            THE COIL
            <Badge variant="emerald">Planning</Badge>
          </h2>
          <span className="text-sm text-[var(--color-silver-muted)]">
            Wave Queue
          </span>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={displayWaves.map((w) => w.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className={cn("flex-1 overflow-auto space-y-3", minimal && "space-y-2 pr-1")}>
            {displayWaves.map((wave) => (
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

      {!minimal && (
        <div className="mt-4 pt-4 border-t border-[var(--color-border)] flex items-center justify-between text-sm">
          <span className="text-[var(--color-silver-muted)]">
            Next wave in queue
          </span>
          <span className="font-mono text-[var(--color-emerald)]">Wave #44 ready</span>
        </div>
      )}
    </Card>
  );
}
