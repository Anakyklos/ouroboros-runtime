import { motion } from "framer-motion";
import { Orbit } from "lucide-react";
import { Card } from "@/components/ui/card";

interface LoadingStateProps {
  message?: string;
  submessage?: string;
}

export function LoadingState({ 
  message = "Starting Ouroboros...", 
  submessage = "Checking daemon connection" 
}: LoadingStateProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-background)]">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="text-center"
      >
        <div className="mb-6 flex justify-center">
          <Orbit className="w-16 h-16 text-[var(--color-emerald)] animate-spin" style={{ animationDuration: '3s' }} />
        </div>
        
        <motion.h2
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="text-2xl font-bold mb-2 text-[var(--color-foreground)]"
        >
          {message}
        </motion.h2>
        
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="text-[var(--color-silver-muted)]"
        >
          {submessage}
        </motion.p>

        <motion.div
          initial={{ width: 0 }}
          animate={{ width: "100%" }}
          transition={{ duration: 2, repeat: Infinity }}
          className="mt-6 h-1 bg-[var(--color-emerald)]/30 rounded-full max-w-xs mx-auto overflow-hidden"
        >
          <motion.div
            animate={{ x: ["-100%", "100%"] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
            className="h-full w-1/3 bg-[var(--color-emerald)] rounded-full"
          />
        </motion.div>
      </motion.div>
    </div>
  );
}

interface SkeletonCardProps {
  rows?: number;
}

export function SkeletonCard({ rows = 3 }: SkeletonCardProps) {
  return (
    <Card className="p-4 bg-[var(--color-surface-primary)] border-[var(--color-border)]">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-full bg-[var(--color-surface-secondary)] animate-pulse" />
        <div className="h-4 w-24 bg-[var(--color-surface-secondary)] rounded animate-pulse" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-3 bg-[var(--color-surface-secondary)] rounded animate-pulse"
            style={{ width: `${60 + i * 10}%` }}
          />
        ))}
      </div>
    </Card>
  );
}