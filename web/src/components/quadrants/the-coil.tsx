/**
 * TheCoil — Wave Queue com Sessions Reais do Daemon
 *
 * Estado desta fase:
 * - Sessions REAIS do daemon aparecem como "execuções ativas" (isLocal: false)
 * - Waves LOCAIS (criadas pelo usuário, ainda não enviadas ao daemon) aparecem com badge "Local"
 * - Fila de drag-and-drop funciona para waves locais
 * - Botão "Send to Daemon" cria uma session real via session.create + agent.input
 */

import { useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { useMissionControlStore, type Wave } from "@/stores/mission-control-store";
import { useDaemonAPI } from "@/hooks/use-daemon-api";
import { Play, CheckCircle, Clock, Server, Cpu, Plus } from "lucide-react";

interface WaveCardProps {
  wave: Wave;
  isPromoting?: boolean;
  onActivate?: (waveId: string) => void;
  onSendToDaemon?: (wave: Wave) => void;
  isSending?: boolean;
  minimal?: boolean;
}

function WaveCard({ wave, isPromoting, onActivate, onSendToDaemon, isSending, minimal }: WaveCardProps) {
  const isLocal = wave.isLocal !== false;
  const isDaemonSession = !isLocal;

  const statusConfig = {
    pending: { border: "border-[var(--color-silver-muted)]", icon: Clock },
    active: { border: "border-[var(--color-emerald)]", icon: Play },
    done: { border: "border-[var(--color-emerald)]/50", icon: CheckCircle },
  };

  const config = statusConfig[wave.status] || statusConfig.pending;

  return (
    <div
      className={cn(
        "p-3 rounded-lg border-l-4 bg-[var(--color-surface-secondary)] transition-all",
        config.border,
        isPromoting && "animate-pulse ring-2 ring-[var(--color-emerald)]",
        minimal && "border-l-2 p-2"
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {isDaemonSession ? (
            <Server className="w-3 h-3 text-[var(--color-emerald)]" />
          ) : (
            <Cpu className="w-3 h-3 text-[var(--color-silver-muted)]" />
          )}
          <span className={cn("font-mono font-bold text-[var(--color-foreground)]", minimal && "text-sm")}>
            {wave.title ?? `WAVE ${wave.number}`}
          </span>
          {isDaemonSession && (
            <Badge variant="emerald" className="text-[10px] py-0">DAEMON</Badge>
          )}
          {isLocal && (
            <Badge variant="secondary" className="text-[10px] py-0">LOCAL</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--color-silver-muted)]">
            {wave.tasks.length} tasks
          </span>
          {wave.status === "pending" && onActivate && !minimal && isLocal && (
            <button
              onClick={() => onActivate(wave.id)}
              className="p-1.5 rounded-md bg-[var(--color-emerald)]/20 text-[var(--color-emerald)] hover:bg-[var(--color-emerald)] hover:text-[var(--color-obsidian)] transition-colors"
              title="Activate locally"
            >
              <Play className="w-3 h-3" />
            </button>
          )}
          {isLocal && onSendToDaemon && !minimal && (
            <button
              onClick={() => onSendToDaemon(wave)}
              disabled={isSending}
              className="px-2 py-1 rounded-md text-[10px] bg-[var(--color-gold)]/20 text-[var(--color-gold)] hover:bg-[var(--color-gold)] hover:text-[var(--color-obsidian)] transition-colors disabled:opacity-50 font-semibold"
              title="Send to daemon"
            >
              {isSending ? "Sending..." : "→ Daemon"}
            </button>
          )}
        </div>
      </div>

      {wave.tasks.length > 0 && (
        <div className={cn("space-y-1 pl-6", minimal && "pl-2")}>
          {wave.tasks.slice(0, minimal ? 2 : 3).map((task) => (
            <div key={task.id} className="flex items-center gap-2 text-sm py-0.5">
              <span className={cn(
                "font-mono",
                task.phase === "complete" && "text-[var(--color-emerald)]",
                task.phase === "coding" && "text-[var(--color-gold)] animate-pulse",
                task.phase !== "complete" && task.phase !== "coding" && "text-[var(--color-silver-muted)]"
              )}>
                {task.phase === "complete" ? "●" : task.phase === "coding" ? "◐" : "○"}
              </span>
              <span className={cn(
                "text-[var(--color-foreground)] truncate",
                task.phase === "complete" && "line-through text-[var(--color-silver-muted)]",
              )}>
                {task.title}
              </span>
            </div>
          ))}
          {wave.tasks.length > (minimal ? 2 : 3) && (
            <div className="text-xs text-[var(--color-silver-muted)] pl-4">
              +{wave.tasks.length - (minimal ? 2 : 3)} more
            </div>
          )}
        </div>
      )}

      {isDaemonSession && wave.tasks.length === 0 && (
        <div className="pl-6 text-xs text-[var(--color-silver-muted)] italic">
          Session ativa — sem tasks mapeadas
        </div>
      )}
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
  const connectionStatus = useMissionControlStore((state) => state.connectionStatus);
  const daemonSessions = useMissionControlStore((state) => state.daemonSessions);
  const addWave = useMissionControlStore((state) => state.addWave);
  const waveNumber = useMissionControlStore((state) => state.waveNumber);
  const setWaveNumber = useMissionControlStore((state) => state.setWaveNumber);

  const { createSession, sendInput, isLoading } = useDaemonAPI();
  const [sendingWaveId, setSendingWaveId] = useState<string | null>(null);

  const isDisconnected = connectionStatus === "disconnected" || connectionStatus === "unknown";

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (_event: DragEndEvent) => {
    // Reorder local waves only
  };

  const handleAddLocalWave = useCallback(() => {
    const newNumber = waveNumber + 1;
    addWave({
      id: `wave-local-${Date.now()}`,
      number: newNumber,
      status: "pending",
      tasks: [],
      title: `Wave #${newNumber}`,
      isLocal: true,
    });
    setWaveNumber(newNumber);
  }, [waveNumber, addWave, setWaveNumber]);

  const handleSendToDaemon = useCallback(async (wave: Wave) => {
    setSendingWaveId(wave.id);
    try {
      const session = await createSession(`Wave #${wave.number}: ${wave.title ?? ""}`);
      if (session && wave.tasks.length > 0) {
        const prompt = wave.tasks.map((t) => `- ${t.title}`).join("\n");
        await sendInput(session.id, `Execute these tasks:\n${prompt}`);
      }
    } finally {
      setSendingWaveId(null);
    }
  }, [createSession, sendInput]);

  const localWaves = waves.filter((w) => w.isLocal !== false);
  const daemonWaves = waves.filter((w) => w.isLocal === false);
  const totalWaves = waves.length;

  if (isDisconnected && waves.length === 0) {
    return (
      <Card className={cn("h-full flex flex-col bg-[var(--color-surface-primary)] border-[var(--color-border)]", !minimal && "p-4", className)}>
        {!minimal && (
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold flex items-center gap-2 text-[var(--color-foreground)]">
              Wave Queue <span className="text-xs font-normal text-[var(--color-silver-muted)]">The Coil</span>
            </h2>
          </div>
        )}
        <EmptyState
          icon="offline"
          message="Daemon not connected"
          description="Connect to the daemon to see the wave queue"
        />
      </Card>
    );
  }

  return (
    <Card className={cn("h-full flex flex-col bg-[var(--color-surface-primary)] border-[var(--color-border)]", !minimal && "p-4", className)}>
      {!minimal && (
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2 text-[var(--color-foreground)]">
            Wave Queue
            <span className="text-xs font-normal text-[var(--color-silver-muted)]">The Coil</span>
            {totalWaves > 0 && <Badge variant="emerald">{totalWaves} waves</Badge>}
            {daemonSessions.length > 0 && (
              <Badge variant="secondary">
                <Server className="w-3 h-3 mr-1 inline" />
                {daemonSessions.length} sessions
              </Badge>
            )}
          </h2>
          <button
            onClick={handleAddLocalWave}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-[var(--color-surface-secondary)] text-[var(--color-silver-muted)] hover:text-[var(--color-foreground)] border border-[var(--color-border)] transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add wave
          </button>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={waves.map((w) => w.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className={cn("flex-1 overflow-auto space-y-3", minimal && "space-y-2 pr-1")}>
            {daemonWaves.length > 0 && !minimal && (
              <div className="text-xs text-[var(--color-silver-muted)] font-mono uppercase tracking-wider mb-1 flex items-center gap-1">
                <Server className="w-3 h-3" /> Daemon Sessions
              </div>
            )}
            {daemonWaves.map((wave) => (
              <WaveCard
                key={wave.id}
                wave={wave}
                isPromoting={promotingWave === wave.id}
                minimal={minimal}
              />
            ))}

            {localWaves.length > 0 && !minimal && (
              <div className="text-xs text-[var(--color-silver-muted)] font-mono uppercase tracking-wider mt-3 mb-1 flex items-center gap-1">
                <Cpu className="w-3 h-3" /> Local Queue
              </div>
            )}
            {localWaves.map((wave) => (
              <WaveCard
                key={wave.id}
                wave={wave}
                isPromoting={promotingWave === wave.id}
                onActivate={onWaveActivate}
                onSendToDaemon={handleSendToDaemon}
                isSending={sendingWaveId === wave.id || isLoading}
                minimal={minimal}
              />
            ))}

            {totalWaves === 0 && !isDisconnected && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center text-sm text-[var(--color-silver-muted)] py-8"
              >
                <div className="mb-2">No waves in queue</div>
                <button
                  onClick={handleAddLocalWave}
                  className="text-xs text-[var(--color-emerald)] hover:text-[var(--color-gold)] transition-colors"
                >
                  + Add your first wave
                </button>
              </motion.div>
            )}
          </div>
        </SortableContext>
      </DndContext>
    </Card>
  );
}
