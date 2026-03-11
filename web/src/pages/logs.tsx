import { useLogStore } from "@/stores/log-store";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

const levelConfig = {
  info: { color: "text-[var(--color-emerald)]", label: "INFO", dot: "bg-[var(--color-emerald)]" },
  warn: { color: "text-[var(--color-gold)]", label: "WARN", dot: "bg-[var(--color-gold)]" },
  error: { color: "text-[var(--color-ruby)]", label: "ERROR", dot: "bg-[var(--color-ruby)]" },
  debug: { color: "text-[var(--color-silver-muted)]", label: "DEBUG", dot: "bg-[var(--color-silver-muted)]" },
};

export function LogsPage() {
  const entries = useLogStore((state) => state.entries);
  const clearLogs = useLogStore((state) => state.clearEntries);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-[var(--color-foreground)]">Logs</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-[var(--color-silver-muted)] font-mono">
            {entries.length} entries
          </span>
          {entries.length > 0 && (
            <button
              onClick={() => {
                if (confirm("Clear all log entries?")) clearLogs?.();
              }}
              className="text-xs px-2 py-1 rounded border border-[var(--color-border)]
                text-[var(--color-silver-muted)] hover:text-[var(--color-ruby)]
                hover:border-[var(--color-ruby)]/30 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Log Entries */}
      {entries.length === 0 ? (
        <EmptyState
          icon="inbox"
          message="No log entries"
          description="Log entries from the daemon and agents will appear here"
        />
      ) : (
        <div className="flex-1 overflow-y-auto font-mono text-sm bg-[var(--color-surface-secondary)] rounded-lg border border-[var(--color-border)] p-2">
          {entries.map((entry, i) => {
            const config = levelConfig[entry.level as keyof typeof levelConfig] ?? levelConfig.info;
            return (
              <div
                key={i}
                className="flex items-start gap-2 py-1 px-2 hover:bg-[var(--color-surface-tertiary)] rounded transition-colors"
              >
                <span className={cn("w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0", config.dot)} />
                <span className={cn("w-10 flex-shrink-0 text-xs uppercase font-semibold", config.color)}>
                  {config.label}
                </span>
                {entry.source && (
                  <span className="text-xs text-[var(--color-silver-muted)] w-16 flex-shrink-0 truncate">
                    [{entry.source}]
                  </span>
                )}
                <span className="text-[var(--color-foreground)] break-all">
                  {entry.message}
                </span>
                {entry.timestamp && (
                  <span className="text-xs text-[var(--color-silver-muted)] ml-auto flex-shrink-0">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
