import { useState, useEffect } from "react";
import { SwissMissionControl } from "@/pages/swiss-mission-control";
import { MissionControl } from "@/pages/mission-control";
import { Settings } from "@/pages/settings";
import { ErrorBoundary } from "@/components/error-boundary";
import { LoadingState } from "@/components/loading-states";
import { useSettingsStore } from "@/stores/settings-store";
import "@/styles/globals.css";

type Page = "mission-control" | "settings";

export function App() {
  const [currentPage, setCurrentPage] = useState<Page>("mission-control");
  const [isLoading, setIsLoading] = useState(true);
  const uiLayout = useSettingsStore((state) => state.uiLayout);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsLoading(false);
    }, 1000);

    return () => clearTimeout(timer);
  }, []);

  // Handle navigation from keyboard or events
  useEffect(() => {
    const handleNavigate = (event: CustomEvent<Page>) => {
      setCurrentPage(event.detail);
    };

    window.addEventListener("navigate" as any, handleNavigate);
    return () => window.removeEventListener("navigate" as any, handleNavigate);
  }, []);

  // Listen for UI layout changes from settings
  useEffect(() => {
    const handleLayoutChange = () => {
      // Force re-render when layout changes
    };
    window.addEventListener("ui:layout-change" as any, handleLayoutChange);
    return () => window.removeEventListener("ui:layout-change" as any, handleLayoutChange);
  }, []);

  if (isLoading) {
    return <LoadingState />;
  }

  const MissionControlComponent = uiLayout === "swiss" ? SwissMissionControl : MissionControl;

  return (
    <ErrorBoundary>
      {currentPage === "mission-control" ? (
        <MissionControlComponent />
      ) : (
        <Settings />
      )}
    </ErrorBoundary>
  );
}