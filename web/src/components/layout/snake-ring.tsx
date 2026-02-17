import { motion } from "framer-motion";

interface SnakeRingProps {
  status: "healthy" | "debating" | "error";
  pulseEnabled?: boolean;
}

const statusConfig = {
  healthy: { color: "var(--color-emerald)", shadow: "var(--shadow-glow-emerald)" },
  debating: { color: "var(--color-gold)", shadow: "var(--shadow-glow-gold)" },
  error: { color: "var(--color-ruby)", shadow: "0 0 20px rgba(239, 68, 68, 0.4)" },
};

export function SnakeRing({ status, pulseEnabled = true }: SnakeRingProps) {
  const config = statusConfig[status];

  return (
    <div className="relative w-64 h-64 sm:w-96 sm:h-96 flex items-center justify-center">
      {/* Outer Ring - Static */}
      <svg className="absolute inset-0 w-full h-full animate-[spin_60s_linear_infinite] opacity-30">
        <circle
          cx="50%"
          cy="50%"
          r="48%"
          fill="none"
          stroke={config.color}
          strokeWidth="1"
          strokeDasharray="4 4"
        />
      </svg>

      {/* Middle Ring - Counter Spin */}
      <svg className="absolute inset-4 w-[calc(100%-2rem)] h-[calc(100%-2rem)] animate-[spin_45s_linear_infinite_reverse] opacity-50">
        <circle
          cx="50%"
          cy="50%"
          r="48%"
          fill="none"
          stroke={config.color}
          strokeWidth="2"
          strokeDasharray="20 40"
        />
      </svg>

      {/* Inner Ring - Pulse */}
      <motion.div
        animate={pulseEnabled ? { scale: [1, 1.05, 1], opacity: [0.8, 1, 0.8] } : {}}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
        className="absolute inset-16 w-[calc(100%-8rem)] h-[calc(100%-8rem)] rounded-full border-4 border-double"
        style={{
          borderColor: config.color,
          boxShadow: config.shadow,
        }}
      />

      {/* Core Symbol */}
      <div className="relative z-10 text-6xl sm:text-8xl select-none filter drop-shadow-lg animate-pulse">
        🐍
      </div>

      {/* Status Text Watermark */}
      <div className="absolute -bottom-8 font-mono text-xs tracking-[0.3em] uppercase opacity-60 text-[var(--color-silver-muted)]">
        {status}
      </div>
    </div>
  );
}
