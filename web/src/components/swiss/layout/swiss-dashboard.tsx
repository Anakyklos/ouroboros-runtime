import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { SwissSidebar } from "./swiss-sidebar";
import { useDaemonAPI } from "@/hooks/use-daemon-api";
import { useMissionControlStore } from "@/stores/mission-control-store";
import { useWaveManager } from "@/hooks/use-wave-manager";
import { useLogStore } from "@/stores/log-store";
import { Activity, Clock, Shield, AlertTriangle, Eye, GitBranch, Terminal as TerminalIcon } from "lucide-react";

// Sub-components for specific sections
import { TheEye } from "@/components/quadrants/the-eye";
import { TheCoil } from "@/components/quadrants/the-coil";
import { TheCouncil } from "@/components/quadrants/the-council";
import { TheStrike } from "@/components/quadrants/the-strike";

export function SwissDashboard() {
  const [activeSection, setActiveSection] = useState("dashboard");
  const { status } = useDaemonAPI();
  const daemonConnected = useMissionControlStore((state) => state.daemonConnected);
  const logs = useLogStore((state) => state.entries);

  // Format uptime
  const uptime = status ? `${Math.floor(status.uptime / 3600)}h ${Math.floor((status.uptime % 3600) / 60)}m` : "0h 0m";

  const renderContent = () => {
    switch (activeSection) {
      case "dashboard":
        return (
          <>
            <header className="mb-12 flex items-baseline justify-between border-b-2 border-[var(--color-foreground)] pb-4">
              <h1 className="text-6xl sm:text-8xl font-bold tracking-tighter text-[var(--color-foreground)] uppercase font-display">
                Ouroboros
              </h1>
              <div className={cn(
                "flex items-center gap-2 text-xl font-medium font-mono uppercase tracking-widest",
                daemonConnected ? "text-[var(--color-emerald)]" : "text-[var(--color-ruby)]"
              )}>
                <span className={cn("w-3 h-3 rounded-full animate-pulse", daemonConnected ? "bg-[var(--color-emerald)]" : "bg-[var(--color-ruby)]")} />
                {daemonConnected ? "SYSTEM ONLINE" : "DISCONNECTED"}
              </div>
            </header>

            {/* Metrics Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 mb-16 font-sans">
              {[
                { label: "UPTIME", value: uptime, icon: Clock },
                { label: "NODES", value: status?.activeTasks || 0, icon: Activity }, // Mapping activeTasks to Nodes for concept
                { label: "LATENCY", value: "4ms", icon: Shield },
                { label: "WAVES", value: status?.activeWaves || 0, icon: AlertTriangle },
              ].map((metric) => (
                <div key={metric.label} className="p-6 border border-[var(--color-border)] bg-[var(--color-surface-primary)] hover:border-[var(--color-foreground)] transition-colors group">
                  <div className="flex items-center justify-between mb-4 text-[var(--color-silver-muted)] group-hover:text-[var(--color-foreground)] transition-colors">
                    <span className="text-sm font-bold tracking-widest uppercase">{metric.label}</span>
                    <metric.icon className="w-5 h-5" />
                  </div>
                  <div className="text-4xl lg:text-5xl font-bold text-[var(--color-foreground)] tracking-tight font-display">
                    {metric.value}
                  </div>
                </div>
              ))}
            </div>

            {/* Main Content Area - Split View */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 h-[600px] mb-12">
              {/* Central Data Panel (Reusing The Coil logic visualized differently or placeholder) */}
              <div className="col-span-1 lg:col-span-8 border border-[var(--color-border)] bg-[var(--color-surface-primary)] p-8 flex flex-col">
                <h2 className="text-2xl font-bold mb-6 tracking-wide uppercase border-b border-[var(--color-border)] pb-2 flex items-center gap-2 font-display">
                  <GitBranch className="w-6 h-6" />
                  Active Operations
                </h2>
                <div className="flex-1 bg-[var(--color-surface-tertiary)] relative overflow-hidden">
                   {/* We can embed TheCoil here but stripped down, or use a custom visualization */}
                   <TheCoil className="h-full w-full" minimal={true} />
                </div>
              </div>

              {/* Critical Alerts Sidebar */}
              <div className="col-span-1 lg:col-span-4 border border-[var(--color-swiss-orange)] bg-[var(--color-surface-primary)] p-8 relative overflow-hidden flex flex-col">
                <div className="absolute top-0 left-0 w-2 h-full bg-[var(--color-swiss-orange)]" />
                <h2 className="text-2xl font-bold mb-6 tracking-wide uppercase text-[var(--color-swiss-orange)] flex items-center gap-2 font-display">
                  <AlertTriangle className="w-6 h-6" />
                  Critical Alerts
                </h2>
                <div className="space-y-4 font-mono text-sm flex-1 overflow-y-auto">
                  <div className="p-4 bg-[var(--color-swiss-orange)]/10 border-l-4 border-[var(--color-swiss-orange)] text-[var(--color-foreground)]">
                    <span className="font-bold block mb-1">ERR_NODE_SYNC_FAIL</span>
                    <span className="opacity-80">Node #04 failing to handshake. Retrying...</span>
                  </div>
                  {/* Mock alerts mixed with real status if critical */}
                  {!daemonConnected && (
                     <div className="p-4 bg-[var(--color-ruby)]/10 border-l-4 border-[var(--color-ruby)] text-[var(--color-ruby)]">
                      <span className="font-bold block mb-1">FATAL_DISCONNECT</span>
                      <span className="opacity-80">Daemon connection lost. Check backend service.</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Bottom Log Table */}
            <div className="border-t border-[var(--color-border)] pt-8">
              <h3 className="text-lg font-bold mb-4 tracking-wider uppercase text-[var(--color-silver-muted)] font-display">
                System Logs
              </h3>
              <div className="font-mono text-xs text-[var(--color-foreground)] space-y-2 opacity-80 h-48 overflow-y-auto">
                {logs.slice(-5).reverse().map((log, i) => (
                  <div key={i} className="flex gap-4 border-b border-[var(--color-border)] pb-1 items-start">
                    <span className="w-24 text-[var(--color-silver-muted)] whitespace-nowrap">{new Date(log.timestamp).toLocaleTimeString()}</span>
                    <span className={cn(
                      "w-16 font-bold uppercase",
                      log.level === "info" ? "text-[var(--color-emerald)]" :
                      log.level === "warn" ? "text-[var(--color-swiss-orange)]" :
                      "text-[var(--color-ruby)]"
                    )}>{log.level}</span>
                    <span className="truncate">{log.message}</span>
                  </div>
                ))}
                {logs.length === 0 && (
                  <div className="text-[var(--color-silver-muted)] italic">No logs available.</div>
                )}
              </div>
            </div>
          </>
        );

      case "the_eye":
        return <div className="h-full border border-[var(--color-border)] p-4"><TheEye /></div>;

      case "the_coil":
         return <div className="h-full border border-[var(--color-border)] p-4"><TheCoil /></div>;

      case "the_council":
         return <div className="h-full border border-[var(--color-border)] p-4"><TheCouncil /></div>;

      default:
        return null;
    }
  };

  return (
    <div className="flex h-screen w-screen bg-[var(--color-background)] overflow-hidden font-sans text-[var(--color-foreground)]" data-theme="swiss">
      <SwissSidebar activeSection={activeSection} onNavigate={setActiveSection} />
      <main className="flex-1 ml-[240px] p-8 lg:p-12 overflow-y-auto h-full">
        {renderContent()}
      </main>
    </div>
  );
}
