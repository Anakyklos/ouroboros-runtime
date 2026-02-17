import React, { useState } from "react";
import { motion } from "framer-motion";
import {
  Eye,
  Zap,
  Shield,
  Check,
  AlertTriangle,
  Layers
} from "lucide-react";
import { useDaemonAPI } from "@/hooks/use-daemon-api";
import { cn } from "@/lib/utils";

// --- Sub-components ---

const CoilHeader = () => (
  <header className="px-6 py-6 border-b-4 border-black bg-white sticky top-0 z-10">
    <div className="flex justify-between items-end">
      <h1 className="text-4xl font-black tracking-tighter leading-none">THE COIL</h1>
      <span className="font-mono text-sm tracking-widest text-gray-500 mb-1">SYS V.9.2</span>
    </div>
  </header>
);

const CoilStatus = ({ activeWaves }: { activeWaves: number }) => (
  <div className="bg-gray-100 px-6 py-4 flex justify-between items-center border-b border-gray-300">
    <div className="flex flex-col">
      <span className="text-[10px] font-bold text-gray-400 tracking-wider uppercase">Active Cycle</span>
      <span className="font-mono text-sm font-medium">#8X-{activeWaves}-BETA</span>
    </div>
    <div className="flex flex-col items-end">
      <span className="text-[10px] font-bold text-gray-400 tracking-wider uppercase">Est. Completion</span>
      <div className="flex items-center gap-2">
        {/* Animated Timer Spinner */}
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
          className="w-3 h-3 border-2 border-black border-t-transparent rounded-full"
        />
        <span className="font-mono text-xl font-bold tracking-tight">T-MINUS 04:20</span>
      </div>
    </div>
  </div>
);

const PhaseItem = ({
  number,
  title,
  status,
  isActive,
  isCompleted,
  children
}: {
  number: string,
  title: string,
  status?: string,
  isActive?: boolean,
  isCompleted?: boolean,
  children?: React.ReactNode
}) => {
  return (
    <div className={cn(
      "border-b border-gray-200 transition-all duration-300",
      isActive ? "bg-white pb-6" : isCompleted ? "bg-black text-white" : "bg-gray-50 opacity-60"
    )}>
      {/* Header Row */}
      <div className="p-6 flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-xs opacity-50 uppercase tracking-widest">Phase_{number}</span>
            {isActive && (
              <span className="bg-blue-100 text-blue-800 text-[10px] font-bold px-2 py-0.5 rounded-sm uppercase tracking-wide border border-blue-200">
                // {status || "RUNNING"}
              </span>
            )}
          </div>
          <div className="flex items-baseline gap-4">
            <span className={cn("text-4xl font-bold font-mono opacity-100", isActive ? "text-black" : isCompleted ? "text-gray-600" : "text-gray-300")}>
              {number}
            </span>
            <h2 className={cn("text-lg font-bold uppercase tracking-tight", isCompleted ? "text-white" : "text-black")}>
              {title}
            </h2>
          </div>
        </div>

        {isCompleted && <Check className="w-5 h-5 text-green-500" />}
        {isActive && <Zap className="w-5 h-5 text-blue-600 animate-pulse" />}
      </div>

      {/* Content Body (Only if active or completed with logs) */}
      <div className="px-6">
        {children}
      </div>
    </div>
  );
};

const MetricsGrid = () => (
  <div className="grid grid-cols-2 gap-px bg-gray-200 border border-gray-200 mt-2">
    <div className="bg-white p-4 flex flex-col justify-between h-24">
      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">CPU Load</div>
      <div className="text-3xl font-mono font-medium">45<span className="text-sm align-top">%</span></div>
    </div>
    <div className="bg-white p-4 flex flex-col justify-between h-24">
      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Memory</div>
      <div className="text-3xl font-mono font-medium">12<span className="text-sm align-top">GB</span></div>
    </div>
    <div className="bg-white p-4 flex flex-col justify-between h-24">
      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Threads</div>
      <div className="text-3xl font-mono font-medium">84</div>
    </div>
    <div className="bg-white p-4 flex flex-col justify-between h-24">
      <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Temp</div>
      <div className="text-3xl font-mono font-medium">62<span className="text-sm align-top">°C</span></div>
    </div>
  </div>
);

const LogConsole = () => (
  <div className="font-mono text-[10px] text-gray-400 space-y-1 py-2">
    <div className="flex gap-2">
      <span className="opacity-50">&gt; LOG:</span>
      <span>Connection established at 08:00:01</span>
    </div>
    <div className="flex gap-2">
      <span className="opacity-50">&gt; LOG:</span>
      <span>Security protocols verified.</span>
    </div>
  </div>
);

const AbortButton = ({ onAbort }: { onAbort: () => void }) => (
  <div className="p-6 bg-gray-50 border-t border-gray-200 pb-24"> {/* Added padding bottom for nav */}
    <div className="flex justify-between items-center mb-2 px-1">
      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Progress</span>
      <span className="font-mono text-xs font-bold">65%</span>
    </div>
    {/* Progress Bar */}
    <div className="h-1 w-full bg-gray-200 mb-8">
      <div className="h-full bg-black w-[65%]" />
    </div>

    <button
      onClick={onAbort}
      className="w-full group h-14 bg-white border-2 border-red-500 flex items-center justify-center gap-3 hover:bg-red-50 active:bg-red-100 transition-colors"
    >
      <AlertTriangle className="w-5 h-5 text-red-500 group-hover:scale-110 transition-transform" />
      <span className="text-red-600 font-bold tracking-widest uppercase">Abort Sequence</span>
    </button>
  </div>
);

const CoilNav = ({ activeTab, onTabChange }: { activeTab: string, onTabChange: (tab: string) => void }) => {
  const tabs = [
    { id: "dash", label: "DASH", icon: Layers },
    { id: "eye", label: "EYE", icon: Eye },
    { id: "coil", label: "COIL", icon: Zap }, // Using Zap for Coil icon as per screenshot ish
    { id: "council", label: "COUNCIL", icon: Shield },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 h-16 bg-white border-t border-gray-200 flex items-stretch z-50">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "flex-1 flex flex-col items-center justify-center gap-1 transition-colors",
              isActive ? "bg-black text-white" : "text-gray-400 hover:text-black hover:bg-gray-50"
            )}
          >
            <tab.icon className={cn("w-5 h-5", isActive ? "stroke-[3px]" : "stroke-2")} />
            <span className="text-[9px] font-bold tracking-widest uppercase">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
};

// --- Main Component ---

export function CoilDashboard() {
  const [activeTab, setActiveTab] = useState("coil");
  const { status, emergencyBrake } = useDaemonAPI();
  const activeWaves = status?.activeWaves || 0;

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-black selection:bg-black selection:text-white" data-theme="swiss">
      <CoilHeader />
      <CoilStatus activeWaves={activeWaves} />

      <main className="flex-col flex">
        {/* Phase 01: Completed */}
        <PhaseItem
          number="01"
          title="Initialization Handshake"
          isCompleted={true}
        >
          <LogConsole />
        </PhaseItem>

        {/* Phase 02: Active */}
        <PhaseItem
          number="02"
          title="Compilation"
          isActive={true}
          status="RUNNING"
        >
          <div className="mb-6">
            <p className="text-sm text-gray-600 font-medium">Optimizing Shard Clusters</p>
            <MetricsGrid />
          </div>
        </PhaseItem>

        {/* Phase 03: Pending */}
        <PhaseItem
          number="03"
          title="Deployment"
        >
          <div className="py-2 text-xs text-gray-400 font-mono">
            &gt; Waiting for previous phase completion...
          </div>
        </PhaseItem>
      </main>

      <AbortButton onAbort={() => emergencyBrake()} />
      <CoilNav activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
}
