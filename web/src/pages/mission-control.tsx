import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TheEye } from "@/components/quadrants/the-eye";
import { TheCoil } from "@/components/quadrants/the-coil";
import { TheStrike } from "@/components/quadrants/the-strike";
import { TheCouncil } from "@/components/quadrants/the-council";
import { LogViewer } from "@/components/ui/log-viewer";
import { TerminalGrid } from "@/components/terminal/terminal-grid";
import { useEventBus } from "@/hooks/use-event-bus";
import { useDaemonAPI } from "@/hooks/use-daemon-api";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useMissionControlStore } from "@/stores/mission-control-store";
import { useWaveManager } from "@/hooks/use-wave-manager";
import { Settings, Terminal, LayoutTemplate, StopCircle } from "lucide-react";
import { CoilDashboard } from "@/components/swiss/layout/CoilDashboard";

interface MissionControlProps {
  onSettingsClick?: () => void;
}

export function MissionControl({ onSettingsClick }: MissionControlProps) {
  const [showLogs, setShowLogs] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [theme, setTheme] = useState<"snake" | "swiss">("snake");
  const [secondsSinceLastPoll, setSecondsSinceLastPoll] = useState<number | null>(null);

  const connectionStatus = useMissionControlStore((state) => state.connectionStatus);
  const lastSuccessfulPoll = useMissionControlStore((state) => state.lastSuccessfulPoll);
  const daemonSessions = useMissionControlStore((state) => state.daemonSessions);
  const activeQuadrant = useMissionControlStore((state) => state.activeQuadrant);
  const viewMode = useMissionControlStore((state) => state.viewMode);
  const mode = useMissionControlStore((state) => state.mode);
  const waveNumber = useMissionControlStore((state) => state.waveNumber);
  const tasksDone = useMissionControlStore((state) => state.tasksDone);
  const tokens = useMissionControlStore((state) => state.tokens);
  const setActiveQuadrant = useMissionControlStore((state) => state.setActiveQuadrant);
  const setViewMode = useMissionControlStore((state) => state.setViewMode);

  // useEventBus é no-op honesto nesta fase (WS não implementado no daemon)
  useEventBus();
  const { status, emergencyBrake } = useDaemonAPI();
  const { promotingWave, activateWave } = useWaveManager();

  // Atualizar "X segundos desde último polling" a cada segundo
  useEffect(() => {
    const interval = setInterval(() => {
      if (lastSuccessfulPoll) {
        const secs = Math.floor((Date.now() - lastSuccessfulPoll.getTime()) / 1000);
        setSecondsSinceLastPoll(secs);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [lastSuccessfulPoll]);

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onPause: () => useMissionControlStore.getState().setMode("pause"),
    onResume: () => useMissionControlStore.getState().setMode("running"),
    onEmergencyBrake: () => {
      emergencyBrake();
      useMissionControlStore.getState().setMode("pause");
    },
    onToggleLogs: () => setShowLogs((prev) => !prev),
    onFocusTerminal: () => setShowTerminal(true),
    onQuadrantSwitch: (quadrant: 1 | 2 | 3 | 4) => {
      setActiveQuadrant(quadrant);
      setViewMode("focused");
    },
  });

  // Sync mode with daemon status
  useEffect(() => {
    if (status?.status === "paused") {
      useMissionControlStore.getState().setMode("pause");
    } else if (status?.status === "running") {
      useMissionControlStore.getState().setMode("running");
    }
  }, [status]);

  const handleStopAll = () => {
    if (!confirm("Stop all running tasks? This will pause the entire system.")) return;
    emergencyBrake();
    useMissionControlStore.getState().setMode("pause");
  };

  const toggleTheme = () => {
    setTheme(prev => prev === "snake" ? "swiss" : "snake");
  };

  // Render the focused quadrant component
  const renderFocusedQuadrant = () => {
    switch (activeQuadrant) {
      case 1:
        return <TheEye />;
      case 2:
        return (
          <TheCoil
            onWaveActivate={activateWave}
            promotingWave={promotingWave}
          />
        );
      case 3:
        return <TheCouncil />;
      case 4:
        return <TheStrike />;
      default:
        return null;
    }
  };

  if (theme === "swiss") {
    return (
      <div className="relative h-screen w-screen overflow-hidden bg-white">
        <CoilDashboard />
        <button
          onClick={toggleTheme}
          className="fixed bottom-24 right-4 z-50 p-2 bg-white border-2 border-black shadow-lg hover:bg-black hover:text-white transition-colors uppercase text-[10px] font-bold tracking-widest"
        >
          Switch to Cyberpunk
        </button>
      </div>
    );
  }

  // Status bar: configuração visual por connectionStatus
  const connectionConfig: Record<string, { dot: string; label: string; text: string }> = {
    connected: {
      dot: "bg-[var(--color-emerald)] animate-pulse",
      label: "text-[var(--color-emerald)]",
      text: "Connected",
    },
    polling: {
      dot: "bg-[var(--color-emerald)]",
      label: "text-[var(--color-emerald)]",
      text: "Polling",
    },
    disconnected: {
      dot: "bg-[var(--color-ruby)]",
      label: "text-[var(--color-ruby)]",
      text: "Disconnected",
    },
    error: {
      dot: "bg-[var(--color-ruby)] animate-pulse",
      label: "text-[var(--color-ruby)]",
      text: "Error",
    },
    unknown: {
      dot: "bg-[var(--color-silver-muted)]",
      label: "text-[var(--color-silver-muted)]",
      text: "Connecting...",
    },
  };

  const cc = connectionConfig[connectionStatus] ?? connectionConfig.unknown;
  const activeSessions = daemonSessions.filter((s) => s.status === "active").length;

  return (
    <div className="h-screen w-screen bg-[var(--color-background)] text-[var(--color-foreground)] overflow-hidden flex flex-col pb-16 transition-colors duration-300">
      {/* === Top Status Bar — Estados Honestos de Conexão === */}
      <div className="h-10 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)] flex items-center px-4 sm:px-6 gap-4 text-sm font-mono">
        {/* Estado de conexão granular */}
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${cc.dot}`} />
          <span className={cc.label}>
            Daemon: {cc.text}
          </span>
        </div>
        <span className="text-[var(--color-border)]">│</span>

        {/* Sessions ativas reais do daemon */}
        <span className="text-[var(--color-silver-muted)]">
          Sessions: <span className="font-semibold text-[var(--color-foreground)]">{activeSessions > 0 ? activeSessions : "—"}</span>
        </span>
        <span className="text-[var(--color-border)]">│</span>

        {/* Wave number (local) */}
        <span className="text-[var(--color-silver-muted)]">
          Wave <span className="font-semibold text-[var(--color-foreground)]">#{waveNumber || "—"}</span>
        </span>
        <span className="text-[var(--color-border)] hidden sm:inline">│</span>

        {/* Last poll */}
        {secondsSinceLastPoll !== null && (
          <span className="text-[var(--color-silver-muted)] hidden sm:inline text-xs">
            Polled {secondsSinceLastPoll}s ago
          </span>
        )}

        {/* Tasks e tokens — somente se houver dados */}
        {tasksDone > 0 && (
          <>
            <span className="text-[var(--color-border)] hidden sm:inline">│</span>
            <span className="text-[var(--color-silver-muted)] hidden sm:inline">
              Tasks <span className="font-semibold text-[var(--color-foreground)]">{tasksDone}</span>
            </span>
          </>
        )}
        {tokens > 0 && (
          <>
            <span className="text-[var(--color-border)] hidden sm:inline">│</span>
            <span className="text-[var(--color-silver-muted)] hidden sm:inline">
              Tokens <span className="font-semibold text-[var(--color-foreground)]">{(tokens / 1000).toFixed(1)}k</span>
            </span>
          </>
        )}

        {/* Modo — note: local-only, não reflete daemon. Apenas para controle local */}
        <span className="text-[var(--color-border)] hidden sm:inline">│</span>
        <span className="hidden sm:inline text-[var(--color-silver-muted)]">
          Mode: <span className={`font-semibold ${
            mode === "pause" ? "text-[var(--color-gold)]" : "text-[var(--color-emerald)]"
          }`}>
            {mode.toUpperCase()} <span className="text-[10px] opacity-60">(local)</span>
          </span>
        </span>
      </div>

      {/* === Header === */}
      <header className="h-12 border-b border-[var(--color-border)] flex items-center justify-between px-4 sm:px-6 bg-[var(--color-surface-primary)] z-50">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold flex items-center gap-2">
            <span className="text-xl">🐍</span>
            <span className="text-gradient font-sans font-bold tracking-tight">OUROBOROS</span>
          </h1>
          <span className="text-sm text-[var(--color-silver-muted)] hidden sm:inline">
            Dashboard
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleTheme}
            className="flex items-center gap-2 text-sm text-[var(--color-silver-muted)] hover:text-[var(--color-foreground)] transition-colors"
            title="Toggle Swiss Theme"
          >
            <LayoutTemplate className="w-4 h-4" />
            <span className="hidden sm:inline">Swiss UI</span>
          </button>
          <button
            onClick={() => setShowTerminal(!showTerminal)}
            className="flex items-center gap-2 text-sm text-[var(--color-silver-muted)] hover:text-[var(--color-foreground)] transition-colors"
          >
            <Terminal className="w-4 h-4" />
            <span className="hidden sm:inline">{showTerminal ? "Hide Terminal" : "Terminal"}</span>
          </button>
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="flex items-center gap-2 text-sm text-[var(--color-silver-muted)] hover:text-[var(--color-foreground)] transition-colors"
          >
            {showLogs ? "Hide Logs" : "Show Logs"}
          </button>
          {onSettingsClick && (
            <button
              onClick={onSettingsClick}
              className="flex items-center gap-2 text-sm text-[var(--color-silver-muted)] hover:text-[var(--color-foreground)] transition-colors"
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">Settings</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Content - Grid or Focused View */}
      <main className="flex-1 p-4 sm:p-6 overflow-y-auto sm:overflow-hidden">
        {viewMode === "focused" && activeQuadrant ? (
          <AnimatePresence mode="wait">
            <motion.div
              key="focused-view"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="h-full relative"
            >
              {renderFocusedQuadrant()}
            </motion.div>
          </AnimatePresence>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 lg:grid-rows-2 gap-4 sm:gap-6 h-full min-h-[800px] sm:min-h-0 relative">
            {/* Top Left: Analysis (The Eye) */}
            <motion.section
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="col-span-1 row-span-1 h-64 sm:h-auto"
            >
              <TheEye />
            </motion.section>

            {/* Top Right: Wave Queue (The Coil) */}
            <motion.section
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="col-span-1 row-span-1 h-64 sm:h-auto"
            >
              <TheCoil
                onWaveActivate={activateWave}
                promotingWave={promotingWave}
              />
            </motion.section>

            {/* Bottom Left: Agent Review (The Council) */}
            <motion.section
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="col-span-1 row-span-1 h-64 sm:h-auto"
            >
              <TheCouncil />
            </motion.section>

            {/* Bottom Right: Execution (The Strike) */}
            <motion.section
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
              className="col-span-1 row-span-1 h-64 sm:h-auto"
            >
              <TheStrike />
            </motion.section>
          </div>
        )}
      </main>

      {/* Overlays */}
      <AnimatePresence>
        {showLogs && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className="fixed bottom-20 right-4 w-full sm:w-96 z-50 px-4 sm:px-0"
          >
            <LogViewer maxHeight="200px" />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showTerminal && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed inset-2 sm:inset-8 z-50 bg-[var(--color-surface-primary)] rounded-xl border border-[var(--color-border)] shadow-2xl overflow-hidden"
          >
            <TerminalGrid />
            <button
              onClick={() => setShowTerminal(false)}
              className="absolute top-4 right-4 p-2 rounded-lg bg-[var(--color-surface-secondary)] hover:bg-[var(--color-ruby)]/20 text-[var(--color-foreground)] hover:text-[var(--color-ruby)] transition-colors z-10"
            >
              Close
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom Bar — Simplified: Stop All button only */}
      <footer className="fixed bottom-0 left-0 right-0 h-14 bg-[var(--color-surface-primary)] border-t border-[var(--color-border)] px-4 sm:px-6 flex items-center justify-between z-50">
        <div className="flex items-center gap-2">
          <span className="text-xl">🐍</span>
          <span className="font-bold text-lg tracking-wide text-gradient font-sans">
            OUROBOROS
          </span>
        </div>
        <button
          onClick={handleStopAll}
          className="px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg bg-[var(--color-ruby)]/10 text-[var(--color-ruby)] font-semibold text-xs sm:text-sm border border-[var(--color-ruby)]/30
            hover:bg-[var(--color-ruby)] hover:text-[var(--color-pearl)] transition-all duration-200 flex items-center gap-2 whitespace-nowrap"
        >
          <StopCircle className="w-4 h-4" />
          <span className="hidden sm:inline">Stop All</span>
        </button>
      </footer>
    </div>
  );
}
