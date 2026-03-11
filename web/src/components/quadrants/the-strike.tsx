/**
 * TheStrike — Monitor de Execução + Session Controls + Dispatch
 *
 * Estado desta fase:
 * - Sessions ATIVAS do daemon com botões Interrupt/Resume
 * - Formulário de dispatch inline (agent + prompt → daemon.delegate)
 * - Feed de resultados de delegação do store
 */

import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import {
  useMissionControlStore,
  type DaemonSession,
  type DelegationResult,
  type Task,
} from "@/stores/mission-control-store";
import { useDaemonAPI } from "@/hooks/use-daemon-api";
import {
  Server,
  Clock,
  CheckCircle,
  Loader2,
  Pause,
  Play,
  Send,
  Trash2,
  ChevronDown,
} from "lucide-react";

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

interface SessionCardProps {
  session: DaemonSession;
  index: number;
  onInterrupt: (sessionId: string) => void;
  onResume: (sessionId: string) => void;
  isActioning: boolean;
}

function SessionCard({ session, index, onInterrupt, onResume, isActioning }: SessionCardProps) {
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

          {session.status === "active" && (
            <button
              onClick={() => onInterrupt(session.id)}
              disabled={isActioning}
              className="p-1 rounded-md bg-[var(--color-gold)]/20 text-[var(--color-gold)] hover:bg-[var(--color-gold)] hover:text-[var(--color-obsidian)] transition-colors disabled:opacity-40"
              title="Interrupt session"
            >
              <Pause className="w-3 h-3" />
            </button>
          )}

          {session.status !== "active" && session.status !== "completed" && (
            <button
              onClick={() => onResume(session.id)}
              disabled={isActioning}
              className="p-1 rounded-md bg-[var(--color-emerald)]/20 text-[var(--color-emerald)] hover:bg-[var(--color-emerald)] hover:text-[var(--color-obsidian)] transition-colors disabled:opacity-40"
              title="Resume session"
            >
              <Play className="w-3 h-3" />
            </button>
          )}

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

function DelegationResultItem({ result }: { result: DelegationResult }) {
  const statusConfig = {
    pending: { color: "text-[var(--color-gold)]", icon: <Loader2 className="w-3 h-3 animate-spin" /> },
    success: { color: "text-[var(--color-emerald)]", icon: <CheckCircle className="w-3 h-3" /> },
    error: { color: "text-[var(--color-ruby)]", icon: <Clock className="w-3 h-3" /> },
  };
  const config = statusConfig[result.status];

  return (
    <div className="flex items-start gap-2 p-2 rounded-md bg-[var(--color-surface-tertiary)] text-xs">
      <span className={config.color}>{config.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{result.agent}</span>
          <Badge
            variant={result.status === "success" ? "emerald" : result.status === "error" ? "ruby" : "secondary"}
            className="text-[9px] py-0"
          >
            {result.status}
          </Badge>
        </div>
        <div className="text-[var(--color-silver-muted)] truncate mt-0.5">
          {result.prompt}
        </div>
        {result.error && (
          <div className="text-[var(--color-ruby)] mt-0.5">{result.error}</div>
        )}
      </div>
    </div>
  );
}

const AVAILABLE_AGENTS = ["gemini", "antigravity", "claude", "jules", "glm"];

function DispatchForm() {
  const [agent, setAgent] = useState("gemini");
  const [prompt, setPrompt] = useState("");
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const { delegateTask, isLoading } = useDaemonAPI();
  const agentBridgeStatus = useMissionControlStore((s) => s.agentBridgeStatus);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim()) return;
    await delegateTask(agent, prompt.trim());
    setPrompt("");
  }, [agent, prompt, delegateTask]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const isAgentAvailable = agentBridgeStatus[agent] === "available";

  return (
    <div className="p-3 rounded-lg bg-[var(--color-surface-secondary)] border border-[var(--color-border)] space-y-2">
      <div className="flex items-center gap-2 text-xs text-[var(--color-silver-muted)] font-mono uppercase tracking-wider">
        <Send className="w-3 h-3" />
        Quick Dispatch
      </div>
      <div className="flex items-center gap-2">
        {/* Agent selector */}
        <div className="relative">
          <button
            onClick={() => setShowAgentPicker(!showAgentPicker)}
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-mono bg-[var(--color-surface-tertiary)] border border-[var(--color-border)] text-[var(--color-foreground)] hover:border-[var(--color-emerald)] transition-colors"
          >
            {agent}
            <ChevronDown className="w-3 h-3" />
          </button>
          <AnimatePresence>
            {showAgentPicker && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="absolute bottom-full left-0 mb-1 bg-[var(--color-surface-primary)] border border-[var(--color-border)] rounded-md shadow-lg z-10 min-w-[120px]"
              >
                {AVAILABLE_AGENTS.map((a) => (
                  <button
                    key={a}
                    onClick={() => {
                      setAgent(a);
                      setShowAgentPicker(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-[var(--color-surface-secondary)] transition-colors",
                      a === agent && "text-[var(--color-emerald)] font-semibold"
                    )}
                  >
                    {a}
                    {agentBridgeStatus[a] === "available" && (
                      <span className="ml-1 text-[var(--color-emerald)]">●</span>
                    )}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Prompt input */}
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Prompt for ${agent}...`}
          className="flex-1 bg-[var(--color-surface-tertiary)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-sm text-[var(--color-foreground)] placeholder:text-[var(--color-silver-muted)] outline-none focus:border-[var(--color-emerald)] transition-colors"
          disabled={isLoading}
        />

        {/* Send button */}
        <button
          onClick={handleSubmit}
          disabled={!prompt.trim() || isLoading}
          className="p-1.5 rounded-md bg-[var(--color-emerald)]/20 text-[var(--color-emerald)] hover:bg-[var(--color-emerald)] hover:text-[var(--color-obsidian)] transition-colors disabled:opacity-40"
          title={isAgentAvailable ? "Send" : `Agent ${agent} may not be available`}
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </button>
      </div>

      {!isAgentAvailable && agentBridgeStatus[agent] && (
        <div className="text-[10px] text-[var(--color-gold)]">
          ⚠ Agent "{agent}" status: {agentBridgeStatus[agent]} — dispatch may fail
        </div>
      )}
    </div>
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
  const delegationResults = useMissionControlStore((s) => s.delegationResults);
  const clearDelegationResults = useMissionControlStore((s) => s.clearDelegationResults);

  const { interruptSession, resumeSession, isLoading } = useDaemonAPI();
  const [actioningSessionId, setActioningSessionId] = useState<string | null>(null);

  const isDisconnected = connectionStatus === "disconnected" || connectionStatus === "unknown";
  const activeSessions = daemonSessions.filter((s) => s.status === "active");
  const allSessions = daemonSessions;
  const hasRealData = allSessions.length > 0;
  const hasLocalTasks = tasks && tasks.length > 0;
  const hasDelegationResults = delegationResults.length > 0;

  const handleInterrupt = useCallback(async (sessionId: string) => {
    setActioningSessionId(sessionId);
    await interruptSession(sessionId);
    setActioningSessionId(null);
  }, [interruptSession]);

  const handleResume = useCallback(async (sessionId: string) => {
    setActioningSessionId(sessionId);
    await resumeSession(sessionId);
    setActioningSessionId(null);
  }, [resumeSession]);

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

  if (!hasRealData && !hasLocalTasks && !hasDelegationResults) {
    return (
      <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-primary)] border-[var(--color-border)]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            Execution
            <span className="text-xs font-normal text-[var(--color-silver-muted)]">The Strike</span>
          </h2>
        </div>
        <div className="flex-1 space-y-3 overflow-auto">
          <DispatchForm />
          <EmptyState
            icon="inbox"
            message="No active executions"
            description="Use the dispatch form above or send a wave via The Coil"
          />
        </div>
      </Card>
    );
  }

  return (
    <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-primary)] border-[var(--color-border)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          Execution
          <span className="text-xs font-normal text-[var(--color-silver-muted)]">The Strike</span>
          {activeSessions.length > 0 && (
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
        {/* Dispatch form */}
        <DispatchForm />

        {/* Sessions reais do daemon */}
        {allSessions.map((session, i) => (
          <SessionCard
            key={session.id}
            session={session}
            index={i}
            onInterrupt={handleInterrupt}
            onResume={handleResume}
            isActioning={actioningSessionId === session.id || isLoading}
          />
        ))}

        {/* Delegation results feed */}
        {hasDelegationResults && (
          <>
            <div className="flex items-center justify-between text-xs text-[var(--color-silver-muted)] font-mono uppercase tracking-wider mt-2 mb-1">
              <span>Recent Delegations</span>
              <button
                onClick={clearDelegationResults}
                className="p-1 rounded hover:text-[var(--color-ruby)] transition-colors"
                title="Clear results"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            {delegationResults.slice(0, 5).map((result) => (
              <DelegationResultItem key={result.id} result={result} />
            ))}
            {delegationResults.length > 5 && (
              <div className="text-xs text-[var(--color-silver-muted)] text-center">
                +{delegationResults.length - 5} more
              </div>
            )}
          </>
        )}

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