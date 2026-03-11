/**
 * TheStrike — Monitor de Execução com Sessions Reais do Daemon
 *
 * Estado desta fase:
 * - Sessions ATIVAS do daemon são mostradas como execuções em andamento
 * - Dados de progresso individuais de tasks só disponíveis quando
 *   passados via metadata da session (ainda não populado automaticamente)
 * - Progress de tasks: local-only nesta fase
 *
 * O que é real: lista de sessions ativas + status + timestamps
 * O que é local: progresso individual de tasks dentro de cada session
 */

import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { useMissionControlStore, type DaemonSession, type Task } from "@/stores/mission-control-store";
import { Server, Clock, CheckCircle, Loader2 } from "lucide-react";

function SessionStatusBadge({ status }: { status: string }) {
  if (status === "active") return <Badge variant="emerald">Active</Badge>;
  if (status === "completed") return <Badge variant="secondary">Done</Badge>;
  if (status === "error") return <Badge variant="ruby">Error</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}

function SessionStatusIcon({ status }: { status: string }) {
  if (status === "active") return <Loader2 className="w-4 h-4 text-[var(--color-emerald)] animate-spin" />;
  if (status === "completed") return <CheckCircle className="w-4 h-4 text-[var(--color-emerald)]" />;
  return <Clock className="w-4 h-4 text-[var(--color-silver-muted)]" />;
}

function SessionCard({ session, index }: { session: DaemonSession; index: number }) {
  const createdAt = new Date(session.createdAt);
  const elapsed = Math.floor((Date.now() - createdAt.getTime()) / 1000);
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.1 }}
      className="p-3 rounded-lg bg-[var(--color-surface-secondary)] border border-[var(--color-border)] space-y-2"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SessionStatusIcon status={session.status} />
          <span className="font-mono text-sm font-semibold">
            Session {session.id.slice(0, 8)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--color-silver-muted)] font-mono">
            {elapsedStr}
          </span>
          <SessionStatusBadge status={session.status} />
        </div>
      </div>

      {session.status === "active" && (
        <div className="relative h-1.5 rounded-full bg-[var(--color-surface-tertiary)] overflow-hidden">
          <motion.div
            className="h-full rounded-full bg-[var(--color-emerald)]"
            initial={{ width: "0%" }}
            animate={{ width: ["15%", "45%", "70%", "45%", "15%"] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>
      )}

      {session.status === "completed" && (
        <div className="relative h-1.5 rounded-full bg-[var(--color-surface-tertiary)] overflow-hidden">
          <div className="h-full w-full rounded-full bg-[var(--color-emerald)]" />
        </div>
      )}

      <div className="text-xs text-[var(--color-silver-muted)] font-mono">
        ID: {session.id}
      </div>
    </motion.div>
  );
}

/** TaskProgress clássico — para tasks locais passadas via prop */
interface TaskProgress {
  id: string;
  title: string;
  progress: number;
  phase: Task["phase"];
}

interface TheStrikeProps {
  /** Tasks locais (prop legacy — ainda funcional para uso programático) */
  tasks?: TaskProgress[];
  /** Wave ID (prop legacy) */
  waveId?: string;
  eta?: string;
  tokens?: number;
  slots?: string;
}

export function TheStrike({ tasks, waveId, eta, tokens }: TheStrikeProps) {
  const connectionStatus = useMissionControlStore((s) => s.connectionStatus);
  const daemonSessions = useMissionControlStore((s) => s.daemonSessions);

  const isDisconnected = connectionStatus === "disconnected" || connectionStatus === "unknown";
  const activeSessions = daemonSessions.filter((s) => s.status === "active");
  const hasRealData = activeSessions.length > 0;
  const hasLocalTasks = tasks && tasks.length > 0;

  if (isDisconnected) {
    return (
      <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-primary)] border-[var(--color-border)]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            Execution
            <span className="text-xs font-normal text-[var(--color-silver-muted)]">The Strike</span>
          </h2>
        </div>
        <EmptyState
          icon="offline"
          message="Daemon not connected"
          description="Connect to the daemon to monitor task execution"
        />
      </Card>
    );
  }

  if (!hasRealData && !hasLocalTasks) {
    return (
      <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-primary)] border-[var(--color-border)]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            Execution
            <span className="text-xs font-normal text-[var(--color-silver-muted)]">The Strike</span>
          </h2>
        </div>
        <EmptyState
          icon="inbox"
          message="No active executions"
          description="Send a wave to the daemon via The Coil to start execution"
        />
      </Card>
    );
  }

  return (
    <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-primary)] border-[var(--color-border)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          Execution
          <span className="text-xs font-normal text-[var(--color-silver-muted)]">The Strike</span>
          {hasRealData && (
            <Badge variant="emerald">
              <Server className="w-3 h-3 mr-1 inline" />
              {activeSessions.length} active
            </Badge>
          )}
        </h2>
        {waveId && (
          <span className="text-sm text-[var(--color-silver-muted)]">
            Wave #{waveId}
          </span>
        )}
      </div>

      <div className="flex-1 space-y-3 overflow-auto">
        {/* Sessions reais do daemon */}
        {activeSessions.map((session, i) => (
          <SessionCard key={session.id} session={session} index={i} />
        ))}

        {/* Tasks locais legacy (se passadas via prop) */}
        {hasLocalTasks && (
          <>
            {hasRealData && (
              <div className="text-xs text-[var(--color-silver-muted)] font-mono uppercase tracking-wider mt-2 mb-1">
                Local Tasks
              </div>
            )}
            {tasks!.map((task, index) => {
              const phaseColor = cn(
                task.phase === "complete" && "bg-[var(--color-emerald)]",
                task.phase === "coding" && "bg-[var(--color-gold)]",
                task.phase === "stuck" && "bg-[var(--color-ruby)]",
                task.phase !== "complete" && task.phase !== "coding" && task.phase !== "stuck" && "bg-[var(--color-gold)]"
              );

              return (
                <motion.div
                  key={task.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.1 }}
                  className="space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">{task.title}</span>
                    <span className="font-mono text-sm">{task.progress}%</span>
                  </div>
                  <div className="relative h-2 rounded-full bg-[var(--color-surface-tertiary)] overflow-hidden">
                    <motion.div
                      className={cn("h-full rounded-full", phaseColor)}
                      initial={{ width: 0 }}
                      animate={{ width: `${task.progress}%` }}
                      transition={{ duration: 0.5, ease: "easeOut" }}
                    />
                  </div>
                </motion.div>
              );
            })}
          </>
        )}
      </div>

      {(eta || tokens != null) && (
        <div className="mt-4 pt-4 border-t border-[var(--color-border)] flex items-center gap-6 text-sm">
          {eta && (
            <div className="flex items-center gap-2">
              <span className="text-[var(--color-silver-muted)]">ETA:</span>
              <span className="font-mono">{eta}</span>
            </div>
          )}
          {tokens != null && (
            <div className="flex items-center gap-2">
              <span className="text-[var(--color-silver-muted)]">Tokens:</span>
              <span className="font-mono">{(tokens / 1000).toFixed(1)}k</span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}