import { Routes, Route } from "react-router-dom";
import { ErrorBoundary } from "@/components/error-boundary";
import { Sidebar } from "@/components/layout/sidebar";
import { StatusBar } from "@/components/layout/status-bar";
import { Dashboard } from "@/pages/dashboard";
import { WavesPage } from "@/pages/waves";
import { AgentsPage } from "@/pages/agents";
import { AnalysisPage } from "@/pages/analysis";
import { LogsPage } from "@/pages/logs";
import { Settings } from "@/pages/settings";
import { useEventBus } from "@/hooks/use-event-bus";
import "@/styles/globals.css";

export function App() {
  // Initialize daemon WebSocket connection
  useEventBus({ url: "ws://localhost:7777/ws" });

  return (
    <ErrorBoundary>
      <div className="h-screen w-screen bg-[var(--color-background)] text-[var(--color-foreground)] flex flex-col overflow-hidden">
        {/* Top Status Bar */}
        <StatusBar />

        {/* Main Layout: Sidebar + Content */}
        <div className="flex-1 flex overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto p-6">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/waves" element={<WavesPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/analysis" element={<AnalysisPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </div>
    </ErrorBoundary>
  );
}