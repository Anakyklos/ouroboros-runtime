import { useState, useEffect } from "react";
import { SwissMissionControl } from "@/pages/swiss-mission-control";
import { Settings } from "@/pages/settings";
import { ErrorBoundary } from "@/components/error-boundary";
import { LoadingState } from "@/components/loading-states";
import "@/styles/globals.css";

type Page = "mission-control" | "settings";

export function App() {
  const [currentPage, setCurrentPage] = useState<Page>("mission-control");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Simulate initial load
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

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <ErrorBoundary>
      {currentPage === "mission-control" ? (
        <SwissMissionControl />
      ) : (
        <Settings />
      )}
    </ErrorBoundary>
  );
}