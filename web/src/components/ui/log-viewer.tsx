import { useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useLogStore } from "@/stores/log-store";
import { cn } from "@/lib/utils";
import { Terminal, Download, Trash2 } from "lucide-react";

interface LogViewerProps {
  maxHeight?: string;
  showControls?: boolean;
}

const levelColors = {
  debug: "text-silver-muted",
  info: "text-emerald",
  warn: "text-gold",
  error: "text-ruby",
};

const levelBadges = {
  debug: "silver" as const,
  info: "emerald" as const,
  warn: "gold" as const,
  error: "ruby" as const,
};

export function LogViewer({ maxHeight = "300px", showControls = true }: LogViewerProps) {
  const entries = useLogStore((state) => state.entries);
  const clearEntries = useLogStore((state) => state.clearEntries);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries]);

  const handleExport = () => {
    const content = entries
      .map(
        (e) =>
          `[${new Date(e.timestamp).toLocaleTimeString()}] [${e.level.toUpperCase()}] [${e.source}] ${e.message}`
      )
      .join("\n");
    
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ouroboros-logs-${new Date().toISOString()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="flex flex-col bg-[var(--surface-primary)] border-[var(--border)] overflow-hidden">
      {showControls && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-emerald" />
            <span className="font-semibold text-sm">Live Logs</span>
            <Badge variant="emerald" className="text-xs">
              {entries.length}
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleExport}
              className="p-1.5 rounded-md hover:bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              title="Export logs"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              onClick={clearEntries}
              className="p-1.5 rounded-md hover:bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-ruby transition-colors"
              title="Clear logs"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        className="overflow-auto font-mono text-xs p-4 space-y-1"
        style={{ maxHeight }}
      >
        {entries.length === 0 ? (
          <div className="text-[var(--muted-foreground)] text-center py-8">
            No logs yet. Waiting for daemon events...
          </div>
        ) : (
          entries.map((entry) => (
            <motion.div
              key={entry.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.1 }}
              className="flex items-start gap-3 hover:bg-[var(--surface-secondary)]/50 rounded px-1 -mx-1"
            >
              <span className="text-[var(--muted-foreground)] shrink-0">
                {new Date(entry.timestamp).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                })}
              </span>
              <Badge
                variant={levelBadges[entry.level]}
                className="shrink-0 text-[10px] px-1.5 py-0"
              >
                {entry.level.toUpperCase()}
              </Badge>
              <span className="text-silver-muted shrink-0">[{entry.source}]</span>
              <span className={cn("break-all", levelColors[entry.level])}>
                {entry.message}
              </span>
            </motion.div>
          ))
        )}
      </div>
    </Card>
  );
}