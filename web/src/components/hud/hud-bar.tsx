import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface HUDBarProps {
  mode: "pause" | "running" | "frenzy";
  /** When omitted, mode controls are disabled (capability off). */
  onModeChange?: (mode: "pause" | "running" | "frenzy") => void;
  confidence: number;
  onConfidenceChange: (value: number) => void;
  /** Display label for current wave number (not active-wave count). */
  waveNumber?: number | null;
  /** Concurrent active waves (optional separate metric). */
  activeWaveCount?: number | null;
  activeTasks?: number | null;
  tasksDone?: number | null;
  uptime?: string | null;
  /** null = token metrics unavailable (show n/a, never scenic 0). */
  tokens?: number | null;
  onEmergencyBrake?: () => void;
}

const modeConfig = {
  pause: {
    label: "PAUSE",
    color: "bg-[var(--color-silver)]",
    textColor: "text-[var(--color-obsidian)]",
    glow: "",
  },
  running: {
    label: "RUNNING",
    color: "bg-[var(--color-emerald)]",
    textColor: "text-[var(--color-obsidian)]",
    glow: "shadow-[var(--shadow-glow-emerald)]",
  },
  frenzy: {
    label: "FRENZY",
    color: "bg-[var(--color-gold)]",
    textColor: "text-[var(--color-obsidian)]",
    glow: "shadow-[var(--shadow-glow-gold)]",
  },
};

function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return "n/a";
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

export function HUDBar({
  mode,
  onModeChange,
  confidence,
  onConfidenceChange,
  waveNumber = null,
  activeWaveCount = null,
  tasksDone = null,
  tokens = null,
  onEmergencyBrake,
}: HUDBarProps) {
  return (
    <footer className="fixed bottom-0 left-0 right-0 h-16 bg-[var(--color-surface-primary)] border-t border-[var(--color-border)] px-4 sm:px-6 flex items-center justify-between z-50 overflow-x-auto">
      <div className="flex items-center gap-4 sm:gap-6 min-w-max">
        <div className="flex items-center gap-1 hidden sm:flex">
          <span className="text-xl">🐍</span>
          <span className="font-bold text-lg tracking-wide text-gradient font-sans">
            OUROBOROS
          </span>
        </div>

        <div className="flex items-center gap-2">
          {(["pause", "running", "frenzy"] as const).map((m) => (
            <motion.button
              key={m}
              type="button"
              disabled={!onModeChange}
              title={!onModeChange ? "Mode switching unavailable" : undefined}
              onClick={() => onModeChange?.(m)}
              className={cn(
                "px-3 py-1.5 rounded-md font-semibold text-xs sm:text-sm transition-all duration-200 uppercase tracking-wider",
                !onModeChange && "opacity-40 cursor-not-allowed",
                m === mode
                  ? `${modeConfig[m].color} ${modeConfig[m].textColor} ${modeConfig[m].glow}`
                  : "bg-[var(--color-surface-secondary)] text-[var(--color-silver-muted)] hover:text-[var(--color-foreground)] border border-[var(--color-border)]"
              )}
              whileHover={onModeChange ? { scale: 1.02 } : undefined}
              whileTap={onModeChange ? { scale: 0.98 } : undefined}
            >
              {modeConfig[m].label}
            </motion.button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-4 sm:gap-8 min-w-max pl-4">
        <div className="flex items-center gap-4 text-xs sm:text-sm overflow-x-auto no-scrollbar max-w-[240px] sm:max-w-none">
          <div className="flex items-center gap-2 whitespace-nowrap">
            <span className="text-[var(--color-silver-muted)]">Wave</span>
            <span className="font-mono font-semibold text-[var(--color-emerald)]">
              {waveNumber === null || waveNumber === undefined ? "—" : `#${waveNumber}`}
            </span>
            {activeWaveCount !== null && activeWaveCount !== undefined && (
              <span className="text-[var(--color-silver-muted)] font-mono text-xs">
                ({activeWaveCount} active)
              </span>
            )}
          </div>

          <span className="text-[var(--color-border)] hidden sm:inline">│</span>

          <div className="hidden sm:flex items-center gap-1 whitespace-nowrap">
            <span className="text-[var(--color-silver-muted)]">Tasks done</span>
            <span className="font-mono">
              {tasksDone === null || tasksDone === undefined ? "—" : tasksDone}
            </span>
          </div>

          <span className="text-[var(--color-border)] hidden sm:inline">│</span>

          <div className="hidden sm:flex items-center gap-1 whitespace-nowrap">
            <span className="text-[var(--color-silver-muted)]">Tokens</span>
            <span className="font-mono">{formatTokens(tokens)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <span className="text-xs text-[var(--color-silver-muted)] hidden sm:inline">Confidence:</span>
          <input
            type="range"
            min={50}
            max={95}
            step={5}
            value={confidence}
            onChange={(e) => onConfidenceChange(Number(e.target.value))}
            className="w-16 sm:w-24 h-2 bg-[var(--color-surface-secondary)] rounded-full appearance-none cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--color-emerald)]
              [&::-webkit-slider-thumb]:shadow-[0_0_10px_rgba(16,185,129,0.5)]
              [&::-webkit-slider-thumb]:cursor-pointer"
          />
          <span className="font-mono font-semibold text-[var(--color-emerald)] w-8 sm:w-12 text-right">{confidence}%</span>
        </div>

        {onEmergencyBrake && (
          <motion.button
            type="button"
            onClick={onEmergencyBrake}
            className="px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg bg-[var(--color-ruby)]/10 text-[var(--color-ruby)] font-semibold text-xs sm:text-sm border border-[var(--color-ruby)]/30
              hover:bg-[var(--color-ruby)] hover:text-[var(--color-pearl)] transition-all duration-200 flex items-center gap-2 whitespace-nowrap"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <span>🛑</span>
            <span className="hidden sm:inline">EMERGENCY BRAKE</span>
          </motion.button>
        )}
      </div>
    </footer>
  );
}
