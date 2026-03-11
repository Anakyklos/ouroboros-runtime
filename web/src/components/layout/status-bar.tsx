import { useMissionControlStore } from "@/stores/mission-control-store";
import { cn } from "@/lib/utils";

export function StatusBar() {
  const daemonConnected = useMissionControlStore((state) => state.daemonConnected);
  const mode = useMissionControlStore((state) => state.mode);
  const waveNumber = useMissionControlStore((state) => state.waveNumber);
  const tasksDone = useMissionControlStore((state) => state.tasksDone);
  const tokens = useMissionControlStore((state) => state.tokens);

  return (
    <div className="h-9 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)] flex items-center px-4 gap-4 text-xs font-mono flex-shrink-0">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "w-2 h-2 rounded-full",
            daemonConnected ? "bg-[var(--color-emerald)] animate-pulse" : "bg-[var(--color-ruby)]"
          )}
        />
        <span className={daemonConnected ? "text-[var(--color-emerald)]" : "text-[var(--color-ruby)]"}>
          {daemonConnected ? "Connected" : "Disconnected"}
        </span>
      </div>

      <span className="text-[var(--color-border)]">│</span>

      <span className="text-[var(--color-silver-muted)]">
        Wave <span className="font-semibold text-[var(--color-foreground)]">{waveNumber || "—"}</span>
      </span>

      <span className="text-[var(--color-border)]">│</span>

      <span className="text-[var(--color-silver-muted)]">
        Tasks <span className="font-semibold text-[var(--color-foreground)]">{tasksDone || "—"}</span>
      </span>

      <span className="text-[var(--color-border)] hidden sm:inline">│</span>

      <span className="text-[var(--color-silver-muted)] hidden sm:inline">
        Tokens <span className="font-semibold text-[var(--color-foreground)]">{tokens ? `${(tokens / 1000).toFixed(1)}k` : "—"}</span>
      </span>

      <span className="text-[var(--color-border)] hidden sm:inline">│</span>

      <span className="hidden sm:inline text-[var(--color-silver-muted)]">
        Mode:{" "}
        <span className={cn("font-semibold", mode === "pause" ? "text-[var(--color-gold)]" : "text-[var(--color-emerald)]")}>
          {mode.toUpperCase()}
        </span>
      </span>
    </div>
  );
}
