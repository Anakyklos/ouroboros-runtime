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
}

function SortableWaveCard({ wave, isPromoting, onActivate }: SortableWaveCardProps) {
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
    pending: { border: "border-sky-400", badge: "secondary" as const, icon: Clock },
    active: { border: "border-emerald", badge: "emerald" as const, icon: Play },
    done: { border: "border-emerald/50", badge: "outline" as const, icon: CheckCircle },
  };

  const config = statusConfig[wave.status];

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
        "p-3 rounded-lg border-l-4 bg-[var(--surface-secondary)] transition-all",
        config.border,
        isDragging && "opacity-50 shadow-lg",
        isPromoting && "animate-pulse ring-2 ring-emerald"
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <button
            {...attributes}
            {...listeners}
            className="p-1 rounded hover:bg-[var(--surface-tertiary)] cursor-grab active:cursor-grabbing"
          >
            <GripVertical className="w-4 h-4 text-[var(--muted-foreground)]" />
          </button>
          <span className="font-mono font-bold">WAVE {wave.number}</span>
          <Badge variant={config.badge}>{wave.status.toUpperCase()}</Badge>
          {wave.status === "active" && (
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
          <span className="text-xs text-[var(--muted-foreground)]">
            {wave.tasks.length} tasks
          </span>
          {wave.status === "pending" && onActivate && (
            <button
              onClick={() => onActivate(wave.id)}
              className="p-1.5 rounded-md bg-emerald/20 text-emerald hover:bg-emerald hover:text-obsidian transition-colors"
            >
              <Play className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1 pl-6">
        {wave.tasks.slice(0, 3).map((task) => (
          <div key={task.id} className="flex items-center gap-2 text-sm py-0.5">
            <span
              className={cn(
                "font-mono",
                task.phase === "complete" && "text-emerald",
                task.phase === "coding" && "text-gold animate-pulse",
                task.phase !== "complete" && task.phase !== "coding" && "text-silver-muted"
              )}
            >
              {taskStatusIcon[task.phase === "complete" ? "completed" : task.phase === "coding" ? "in_progress" : "pending"]}
            </span>
            <span
              className={cn(
                task.phase === "complete" && "line-through text-silver-muted"
              )}
            >
              {task.title}
            </span>
          </div>
        ))}
        {wave.tasks.length > 3 && (
          <div className="text-xs text-[var(--muted-foreground)] pl-4">
            +{wave.tasks.length - 3} more tasks
          </div>
        )}
      </div>
    </div>
  );
}

interface TheCoilProps {
  onWaveActivate?: (waveId: string) => void;
  promotingWave?: string | null;
}

export function TheCoil({ onWaveActivate, promotingWave }: TheCoilProps) {
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
      // In a real implementation, this would reorder waves in the store
      console.log(`Reordered: ${active.id} → ${over.id}`);
    }
  };

  // Default mock waves if none exist
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
    <Card className="h-full p-4 flex flex-col bg-[var(--surface-primary)] border-[var(--border)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <span className="text-xl">🐍</span>
          THE COIL
          <Badge variant="emerald">Planning</Badge>
        </h2>
        <span className="text-sm text-[var(--muted-foreground)]">
          Wave Queue
        </span>
      </div>

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
          <div className="flex-1 overflow-auto space-y-3">
            {displayWaves.map((wave) => (
              <SortableWaveCard
                key={wave.id}
                wave={wave}
                isPromoting={promotingWave === wave.id}
                onActivate={onWaveActivate}
              />
            ))}
          </div>
        </SortableContext>

        <DragOverlay>
          {activeWave ? (
            <div className="p-3 rounded-lg border-l-4 border-emerald bg-[var(--surface-secondary)] shadow-xl opacity-90">
              <div className="font-mono font-bold">WAVE {activeWave.number}</div>
              <div className="text-sm text-[var(--muted-foreground)]">
                {activeWave.tasks.length} tasks
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <div className="mt-4 pt-4 border-t border-[var(--border)] flex items-center justify-between text-sm">
        <span className="text-[var(--muted-foreground)]">
          Next wave in queue
        </span>
        <span className="font-mono text-emerald">Wave #44 ready</span>
      </div>
    </Card>
  );
}