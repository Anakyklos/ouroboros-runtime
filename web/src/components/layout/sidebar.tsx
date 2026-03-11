import { useState } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Layers,
  Users,
  Search,
  ScrollText,
  Settings,
  StopCircle,
  Orbit,
  AlertTriangle,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMissionControlStore } from "@/stores/mission-control-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDaemonAPI } from "@/hooks/use-daemon-api";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/waves", icon: Layers, label: "Waves" },
  { to: "/agents", icon: Users, label: "Agents" },
  { to: "/analysis", icon: Search, label: "Analysis" },
  { to: "/logs", icon: ScrollText, label: "Logs" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export function Sidebar() {
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const daemonConnected = useMissionControlStore((state) => state.daemonConnected);
  const confirmRequired = useSettingsStore((state) => state.confirmEmergencyBrake);
  const { emergencyBrake } = useDaemonAPI();

  const executeStop = () => {
    emergencyBrake();
    useMissionControlStore.getState().setMode("pause");
    setStopDialogOpen(false);
  };

  const handleStopAll = () => {
    if (confirmRequired) {
      setStopDialogOpen(true);
    } else {
      executeStop();
    }
  };

  return (
    <aside className="w-56 h-full bg-[var(--color-surface-primary)] border-r border-[var(--color-border)] flex flex-col">
      {/* Logo */}
      <div className="h-14 flex items-center gap-2 px-4 border-b border-[var(--color-border)]">
        <Orbit className="w-5 h-5 text-[var(--color-emerald)]" />
        <span className="text-gradient font-sans font-bold tracking-tight text-lg">OUROBOROS</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-2 space-y-1 overflow-y-auto">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-200 cursor-pointer",
                isActive
                  ? "bg-[var(--color-emerald)]/10 text-[var(--color-emerald)]"
                  : "text-[var(--color-silver-muted)] hover:text-[var(--color-foreground)] hover:bg-[var(--color-surface-secondary)]"
              )
            }
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Daemon Status + Stop All */}
      <div className="p-3 border-t border-[var(--color-border)] space-y-2">
        <div className="flex items-center gap-2 px-2 text-xs font-mono">
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

        <Dialog.Root open={stopDialogOpen} onOpenChange={setStopDialogOpen}>
          <button
            onClick={handleStopAll}
            data-testid="stop-all-button"
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer
              bg-[var(--color-ruby)]/10 text-[var(--color-ruby)] border border-[var(--color-ruby)]/30
              hover:bg-[var(--color-ruby)] hover:text-[var(--color-pearl)] transition-all duration-200"
          >
            <StopCircle className="w-3.5 h-3.5" />
            Stop All
          </button>

          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/60 z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
            <Dialog.Content
              data-testid="stop-all-dialog"
              className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50
                w-full max-w-md p-6 rounded-xl
                bg-[var(--color-surface-primary)] border border-[var(--color-border)]
                shadow-2xl focus:outline-none"
            >
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-[var(--color-ruby)]/15 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle className="w-5 h-5 text-[var(--color-ruby)]" />
                </div>
                <div className="flex-1">
                  <Dialog.Title className="text-lg font-semibold text-[var(--color-foreground)]">
                    Stop all running tasks?
                  </Dialog.Title>
                  <Dialog.Description className="text-sm text-[var(--color-silver-muted)] mt-1">
                    This will pause the entire system. All active waves and tasks will be halted immediately. You can resume later.
                  </Dialog.Description>
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <Dialog.Close asChild>
                  <button
                    data-testid="stop-all-cancel"
                    className="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer
                      bg-[var(--color-surface-secondary)] text-[var(--color-foreground)]
                      border border-[var(--color-border)]
                      hover:bg-[var(--color-surface-secondary)]/80 transition-colors duration-200"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  onClick={executeStop}
                  data-testid="stop-all-confirm"
                  className="px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer
                    bg-[var(--color-ruby)] text-white
                    hover:bg-[var(--color-ruby)]/80 transition-colors duration-200"
                >
                  Stop All
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </aside>
  );
}
