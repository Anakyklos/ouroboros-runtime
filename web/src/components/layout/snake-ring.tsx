import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface SnakeRingProps {
  status?: "healthy" | "debating" | "error";
  pulseEnabled?: boolean;
}

const statusColors = {
  healthy: {
    ring: "#10B981",
    glow: "rgba(16, 185, 129, 0.4)",
    text: "text-emerald",
  },
  debating: {
    ring: "#F59E0B",
    glow: "rgba(245, 158, 11, 0.4)",
    text: "text-gold",
  },
  error: {
    ring: "#EF4444",
    glow: "rgba(239, 68, 68, 0.4)",
    text: "text-ruby",
  },
};

export function SnakeRing({ status = "healthy", pulseEnabled = true }: SnakeRingProps) {
  const config = statusColors[status];

  return (
    <div className="relative w-40 h-40 flex items-center justify-center">
      <motion.div
        className="absolute inset-0 rounded-full"
        style={{
          background: `conic-gradient(from 0deg, transparent, ${config.ring}, ${config.ring}, transparent)`,
        }}
        animate={pulseEnabled ? { rotate: 360 } : {}}
        transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
      />
      
      <motion.div
        className="absolute inset-2 rounded-full"
        style={{
          background: `conic-gradient(from 180deg, transparent, ${config.ring}80, transparent)`,
        }}
        animate={pulseEnabled ? { rotate: -360 } : {}}
        transition={{ duration: 12, repeat: Infinity, ease: "linear" }}
      />

      <motion.div
        className="absolute inset-4 rounded-full bg-[var(--surface-primary)]"
        animate={
          pulseEnabled
            ? {
                boxShadow: [
                  `0 0 20px ${config.glow}`,
                  `0 0 40px ${config.glow}, 0 0 60px ${config.glow}`,
                  `0 0 20px ${config.glow}`,
                ],
              }
            : {}
        }
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="relative z-10 flex flex-col items-center">
        <motion.span
          className="text-4xl"
          animate={pulseEnabled ? { scale: [1, 1.1, 1] } : {}}
          transition={{ duration: 2, repeat: Infinity }}
        >
          🐍
        </motion.span>
        <span className={cn("text-xs font-mono mt-1", config.text)}>
          WAVE #42
        </span>
      </div>
    </div>
  );
}