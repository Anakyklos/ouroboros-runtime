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
import { TaskDetailPanel } from "@/components/task-detail-panel";
import { EmergencyBrakeDialog } from "@/components/emergency-brake-dialog";
import { MemoryPanel } from "@/components/memory-panel";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { useEventBus } from "@/hooks/use-event-bus";
import { useDaemonAPI } from "@/hooks/use-daemon-api";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useMissionControlStore } from "@/stores/mission-control-store";
import { useWaveManager } from "@/hooks/use-wave-manager";
import { useLiveMissionControl } from "@/hooks/use-live-mission-control";
import { Settings, Terminal, LayoutTemplate } from "lucide-react";
import { CoilDashboard } from "@/components/swiss/layout/CoilDashboard";

interface MissionControlProps {
  onSettingsClick?: () => void;
}

export function MissionControl({ onSettingsClick }: MissionControlProps) {
  const [mode, setMode] = useState<"pause" | "running" | "frenzy">("running");
  const [confidence, setConfidence] = useState(80);
  const [showLogs, setShowLogs] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [theme, setTheme] = useState<"snake" | "swiss">("snake");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedWaveId, setSelectedWaveId] = useState<string | null>(null);
  const [showEmergencyDialog, setShowEmergencyDialog] = useState(false);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  
  const { connectionStatus } = useEventBus();
  const waves = useMissionControlStore((state) => state.waves);
  const selectedTask = selectedTaskId && selectedWaveId 
    ? waves.find(w => w.id === selectedWaveId)?.tasks.find(t => t.id === selectedTaskId) 
    : null;
  
  const daemonConnected = useMissionControlStore((state) => state.daemonConnected);
  const activeQuadrant = useMissionControlStore((state) => state.activeQuadrant);
  const viewMode = useMissionControlStore((state) => state.viewMode);
  const setActiveQuadrant = useMissionControlStore((state) => state.setActiveQuadrant);
  const setViewMode = useMissionControlStore((state) => state.setViewMode);

  // Initialize daemon connections
  useEventBus({ url: "ws://localhost:3001/ws" });
  const { status, emergencyBrake } = useDaemonAPI();
  const { promotingWave, activateWave } = useWaveManager();
  const liveData = useLiveMissionControl();

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onPause: () => setMode("pause"),
    onResume: () => setMode("running"),
    onEmergencyBrake: () => setShowEmergencyDialog(true),
    onToggleLogs: () => setShowLogs((prev) => !prev),
    onFocusTerminal: () => setShowTerminal(true),
    onQuadrantSwitch: (quadrant: 1 | 2 | 3 | 4) => {
      setActiveQuadrant(quadrant);
      setViewMode("focused");
    },
  });

  // Listen for keyboard shortcuts modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
          e.preventDefault();
          setShowShortcutsModal(true);
        }
      }
      if (e.key === "m" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setShowMemoryPanel((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Sync mode with daemon status
  useEffect(() => {
    if (status?.status === "paused") {
      setMode("pause");
    } else if (status?.status === "running") {
      setMode("running");
    }
  }, [status]);

  // Listen for task click events
  useEffect(() => {
    const handleTaskClick = (event: CustomEvent<{ taskId: string; waveId: string }>) => {
      setSelectedTaskId(event.detail.taskId);
      setSelectedWaveId(event.detail.waveId);
    };
    window.addEventListener("task:click" as any, handleTaskClick);
    return () => window.removeEventListener("task:click" as any, handleTaskClick);
  }, []);

  const handleEmergencyBrake = () => {
    emergencyBrake();
    setMode("pause");
    setShowEmergencyDialog(false);
  };

  const getSnakeStatus = () => {
    if (mode === "pause") return "debating" as const;
    if (mode === "frenzy") return "healthy" as const;
    return "healthy" as const;
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

  return (
    <div className="h-screen w-screen bg-[var(--color-background)] text-[var(--color-foreground)] overflow-hidden flex flex-col pb-16 transition-colors duration-300">
      <header className="h-14 border-b border-[var(--color-border)] flex items-center justify-between px-4 sm:px-6 bg-[var(--color-surface-primary)] z-50">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <span className="text-2xl">🐍</span>
            <span className="text-gradient font-sans font-bold tracking-tight">OUROBOROS</span>
          </h1>
          <span className="text-sm text-[var(--color-silver-muted)] hidden sm:inline">
            Mission Control
          </span>
        </div>
        <div className="flex items-center gap-4">
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
          <span className="text-sm text-[var(--color-silver-muted)] hidden md:inline">
            Daemon:{" "}
            <span className={`font-mono ${
              connectionStatus === 'connected' ? "text-[var(--color-emerald)]" :
              connectionStatus === 'reconnecting' ? "text-[var(--color-gold)]" :
              "text-[var(--color-ruby)]"
            }`}>
              ● {connectionStatus === 'connected' ? "Connected" : 
                  connectionStatus === 'reconnecting' ? "Reconnecting..." : 
                  "Disconnected"}
            </span>
          </span>
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
            {/* Top Left: The Eye */}
            <motion.section
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="col-span-1 row-span-1 h-64 sm:h-auto"
            >
              <TheEye />
            </motion.section>

            {/* Top Right: The Coil */}
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

            {/* Center: The Snake Ring (Hidden on Mobile, Visible on Tablet/Desktop) */}
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.5, type: "spring" }}
              className="pointer-events-none z-0 hidden lg:block absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px]"
            >
               {/* Center overlay container for desktop */}
              <div className="relative w-full h-full flex items-center justify-center">
                 {/* Background blur to separate ring from grid lines if needed */}
                <div className="absolute inset-0 bg-[var(--color-background)]/80 backdrop-blur-sm rounded-full -z-10 scale-75 blur-3xl" />
                <SnakeRing status={getSnakeStatus()} pulseEnabled={mode !== "pause"} />
              </div>
            </motion.div>

            {/* Bottom Left: The Council */}
            <motion.section
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="col-span-1 row-span-1 h-64 sm:h-auto"
            >
              <TheCouncil />
            </motion.section>

            {/* Bottom Right: The Strike */}
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

      <HUDBar
        mode={mode}
        onModeChange={setMode}
        confidence={confidence}
        onConfidenceChange={setConfidence}
        waveNumber={liveData.stats.waveNumber || status?.activeWaves || 0}
        tasksDone={liveData.stats.tasksDone || 0}
        tokens={liveData.stats.tokens || status?.tokensUsed || 0}
        onEmergencyBrake={handleEmergencyBrake}
      />

      <TaskDetailPanel
        task={selectedTask || null}
        isOpen={!!selectedTask}
        onClose={() => {
          setSelectedTaskId(null);
          setSelectedWaveId(null);
        }}
        onRetry={(taskId) => {
          console.log("Retry task:", taskId);
          setSelectedTaskId(null);
          setSelectedWaveId(null);
        }}
      />

      <EmergencyBrakeDialog
        isOpen={showEmergencyDialog}
        onClose={() => setShowEmergencyDialog(false)}
        onConfirm={handleEmergencyBrake}
      />

      <MemoryPanel
        isOpen={showMemoryPanel}
        onClose={() => setShowMemoryPanel(false)}
      />

      <KeyboardShortcutsModal
        isOpen={showShortcutsModal}
        onClose={() => setShowShortcutsModal(false)}
      />
    </div>
  );
}
