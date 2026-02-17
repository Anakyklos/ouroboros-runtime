import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { HUDBar } from "@/components/hud/hud-bar";
import { TheEye } from "@/components/quadrants/the-eye";
import { TheCoil } from "@/components/quadrants/the-coil";
import { TheStrike } from "@/components/quadrants/the-strike";
import { TheCouncil } from "@/components/quadrants/the-council";
import { SnakeRing } from "@/components/layout/snake-ring";
import { LogViewer } from "@/components/ui/log-viewer";
import { TerminalGrid } from "@/components/terminal/terminal-grid";
import { useEventBus } from "@/hooks/use-event-bus";
import { useDaemonAPI } from "@/hooks/use-daemon-api";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useMissionControlStore } from "@/stores/mission-control-store";
import { useWaveManager } from "@/hooks/use-wave-manager";
import { Settings, Terminal } from "lucide-react";

interface MissionControlProps {
  onSettingsClick?: () => void;
}

export function MissionControl({ onSettingsClick }: MissionControlProps) {
  const [mode, setMode] = useState<"pause" | "running" | "frenzy">("running");
  const [confidence, setConfidence] = useState(80);
  const [showLogs, setShowLogs] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  
  const daemonConnected = useMissionControlStore((state) => state.daemonConnected);
  
  // Initialize daemon connections
  useEventBus({ url: "ws://localhost:3001/ws" });
  const { status, emergencyBrake } = useDaemonAPI();
  const { promotingWave, activateWave } = useWaveManager();

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onPause: () => setMode("pause"),
    onResume: () => setMode("running"),
    onEmergencyBrake: () => {
      emergencyBrake();
      setMode("pause");
    },
    onToggleLogs: () => setShowLogs((prev) => !prev),
    onFocusTerminal: () => setShowTerminal(true),
  });

  // Sync mode with daemon status
  useEffect(() => {
    if (status?.status === "paused") {
      setMode("pause");
    } else if (status?.status === "running") {
      setMode("running");
    }
  }, [status]);

  const handleEmergencyBrake = () => {
    emergencyBrake();
    setMode("pause");
  };

  const getSnakeStatus = () => {
    if (mode === "pause") return "debating" as const;
    if (mode === "frenzy") return "healthy" as const;
    return "healthy" as const;
  };

  return (
    <div className="h-screen w-screen bg-[var(--background)] text-[var(--foreground)] overflow-hidden flex flex-col pb-16">
      <header className="h-14 border-b border-[var(--border)] flex items-center justify-between px-6 bg-[var(--surface-primary)]">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <span className="text-2xl">🐍</span>
            <span className="text-gradient">OUROBOROS</span>
          </h1>
          <span className="text-sm text-[var(--muted-foreground)] hidden sm:inline">
            Mission Control
          </span>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowTerminal(!showTerminal)}
            className="flex items-center gap-2 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            <Terminal className="w-4 h-4" />
            <span className="hidden sm:inline">{showTerminal ? "Hide Terminal" : "Terminal"}</span>
          </button>
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="flex items-center gap-2 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            {showLogs ? "Hide Logs" : "Show Logs"}
          </button>
          {onSettingsClick && (
            <button
              onClick={onSettingsClick}
              className="flex items-center gap-2 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">Settings</span>
            </button>
          )}
          <span className="text-sm text-[var(--muted-foreground)] hidden md:inline">
            Daemon:{" "}
            <span className={daemonConnected ? "text-emerald font-mono" : "text-ruby font-mono"}>
              ● {daemonConnected ? "Connected" : "Disconnected"}
            </span>
          </span>
        </div>
      </header>

      <main className="flex-1 p-4 grid grid-cols-1 md:grid-cols-2 grid-rows-2 gap-4">
        <motion.section
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="row-start-1 col-start-1"
        >
          <TheEye />
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="row-start-1 md:row-start-1 col-start-1 md:col-start-2"
        >
          <TheCoil 
            onWaveActivate={activateWave}
            promotingWave={promotingWave}
          />
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="row-start-2 col-start-1"
        >
          <TheCouncil />
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="row-start-2 col-start-1 md:col-start-2"
        >
          <TheStrike />
        </motion.section>

        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.5, type: "spring" }}
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-40 hidden md:block"
        >
          <div className="relative">
            <SnakeRing status={getSnakeStatus()} pulseEnabled={mode !== "pause"} />
            <div className="absolute inset-0 bg-[var(--background)]/50 backdrop-blur-sm rounded-full -z-10" />
          </div>
        </motion.div>

        <AnimatePresence>
          {showLogs && (
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.95 }}
              className="fixed bottom-20 right-4 w-80 md:w-96 z-50"
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
              className="fixed inset-4 md:inset-8 z-50 bg-[var(--surface-primary)] rounded-xl border border-[var(--border)] shadow-2xl overflow-hidden"
            >
              <TerminalGrid />
              <button
                onClick={() => setShowTerminal(false)}
                className="absolute top-4 right-4 p-2 rounded-lg bg-[var(--surface-secondary)] hover:bg-ruby/20 text-[var(--foreground)] hover:text-ruby transition-colors z-10"
              >
                Close
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <HUDBar
        mode={mode}
        onModeChange={setMode}
        confidence={confidence}
        onConfidenceChange={setConfidence}
        waveNumber={status?.activeWaves || 42}
        activeTasks={status?.activeTasks || 3}
        tasksDone={47}
        uptime={status ? `${Math.floor(status.uptime / 3600)}h ${Math.floor((status.uptime % 3600) / 60)}m` : "0h 0m"}
        tokens={status?.tokensUsed || 142000}
        onEmergencyBrake={handleEmergencyBrake}
      />
    </div>
  );
}