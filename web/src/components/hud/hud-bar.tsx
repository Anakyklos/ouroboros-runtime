import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface HUDBarProps {
  mode: "pause" | "running" | "frenzy";
  onModeChange: (mode: "pause" | "running" | "frenzy") => void;
  confidence: number;
  onConfidenceChange: (value: number) => void;
  waveNumber?: number;
  activeTasks?: number;
  tasksDone?: number;
  uptime?: string;
  tokens?: number;
  onEmergencyBrake?: () => void;
}

const modeConfig = {
  pause: {
    label: "PAUSE",
    color: "bg-silver",
    textColor: "text-obsidian",
    glow: "",
  },
  running: {
    label: "RUNNING",
    color: "bg-emerald",
    textColor: "text-obsidian",
    glow: "glow-emerald",
  },
  frenzy: {
    label: "FRENZY",
    color: "bg-gold",
    textColor: "text-obsidian",
    glow: "glow-gold",
  },
};

export function HUDBar({
  mode,
  onModeChange,
  confidence,
  onConfidenceChange,
  waveNumber = 42,
  activeTasks = 3,
  tasksDone = 47,
  uptime = "4h 23m",
  tokens = 142000,
  onEmergencyBrake,
}: HUDBarProps) {
  return (
    <footer className="fixed bottom-0 left-0 right-0 h-16 bg-[var(--surface-primary)] border-t border-[var(--border)] px-6 flex items-center justify-between z-50">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-1">
          <span className="text-xl">🐍</span>
          <span className="font-bold text-lg tracking-wide text-gradient">
            OUROBOROS
          </span>
        </div>

        <div className="flex items-center gap-2">
          {(["pause", "running", "frenzy"] as const).map((m) => (
            <motion.button
              key={m}
              onClick={() => onModeChange(m)}
              className={cn(
                "px-4 py-1.5 rounded-md font-semibold text-sm transition-all duration-200",
                m === mode
                  ? `${modeConfig[m].color} ${modeConfig[m].textColor} ${modeConfig[m].glow}`
                  : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              )}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              {modeConfig[m].label}
            </motion.button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-8">
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-[var(--muted-foreground)]">Wave</span>
            <span className="font-mono font-semibold text-emerald">#{waveNumber}</span>
            <span className="w-2 h-2 rounded-full bg-emerald animate-pulse" />
            <span className="text-[var(--muted-foreground)]">{activeTasks} active</span>
          </div>
          
          <span className="text-[var(--border)]">│</span>
          
          <div className="flex items-center gap-1">
            <span className="text-[var(--muted-foreground)]">📊</span>
            <span className="font-mono">{tasksDone} done</span>
          </div>
          
          <span className="text-[var(--border)]">│</span>
          
          <div className="flex items-center gap-1">
            <span className="text-[var(--muted-foreground)]">⏱</span>
            <span className="font-mono">{uptime}</span>
          </div>
          
          <span className="text-[var(--border)]">│</span>
          
          <div className="flex items-center gap-1">
            <span className="text-[var(--muted-foreground)]">🪙</span>
            <span className="font-mono">{(tokens / 1000).toFixed(1)}k</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-[var(--muted-foreground)]">Confidence:</span>
          <input
            type="range"
            min={50}
            max={95}
            step={5}
            value={confidence}
            onChange={(e) => onConfidenceChange(Number(e.target.value))}
            className="w-24 h-2 bg-[var(--secondary)] rounded-full appearance-none cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald 
              [&::-webkit-slider-thumb]:shadow-[0_0_10px_rgba(16,185,129,0.5)]
              [&::-webkit-slider-thumb]:cursor-pointer"
          />
          <span className="font-mono font-semibold text-emerald w-12">{confidence}%</span>
        </div>

        <motion.button
          onClick={onEmergencyBrake}
          className="px-4 py-2 rounded-lg bg-ruby/20 text-ruby font-semibold text-sm border border-ruby/30 
            hover:bg-ruby hover:text-pearl transition-all duration-200 flex items-center gap-2"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          <span>🛑</span>
          EMERGENCY BRAKE
        </motion.button>
      </div>
    </footer>
  );
}