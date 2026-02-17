import { useEffect, useRef, useCallback, useState } from "react";
import { useLogStore } from "@/stores/log-store";

interface LogViewerOptions {
  maxHeight?: string;
  followOutput?: boolean;
  showTimestamps?: boolean;
  filterLevel?: "debug" | "info" | "warn" | "error" | null;
}

export function useLogViewer(options: LogViewerOptions = {}) {
  const { followOutput = true, filterLevel = null } = options;
  
  const entries = useLogStore((state) => state.entries);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFollowing, setIsFollowing] = useState(followOutput);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredEntries = entries.filter((entry) => {
    const matchesLevel = filterLevel ? entry.level === filterLevel : true;
    const matchesSearch = searchQuery
      ? entry.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
        entry.source.toLowerCase().includes(searchQuery.toLowerCase())
      : true;
    return matchesLevel && matchesSearch;
  });

  const scrollToBottom = useCallback(() => {
    if (containerRef.current && isFollowing) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [isFollowing]);

  useEffect(() => {
    scrollToBottom();
  }, [filteredEntries, scrollToBottom]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 50;
    setIsFollowing(isNearBottom);
  }, []);

  const clearLogs = useLogStore((state) => state.clearEntries);

  const exportLogs = useCallback(() => {
    const content = filteredEntries
      .map(
        (e) =>
          `[${e.timestamp}] [${e.level.toUpperCase()}] [${e.source}] ${e.message}`
      )
      .join("\n");
    
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ouroboros-logs-${new Date().toISOString()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredEntries]);

  return {
    containerRef,
    entries: filteredEntries,
    isFollowing,
    searchQuery,
    setSearchQuery,
    scrollToBottom,
    handleScroll,
    clearLogs,
    exportLogs,
  };
}

/**
 * Hook for real-time log streaming with ANSI color support
 */
export function useAnsiLogStream() {
  const [lines, setLines] = useState<string[]>([]);
  const maxLines = 1000;

  const addLine = useCallback((line: string) => {
    setLines((prev) => {
      const newLines = [...prev, line];
      if (newLines.length > maxLines) {
        return newLines.slice(-maxLines);
      }
      return newLines;
    });
  }, []);

  const clearLines = useCallback(() => {
    setLines([]);
  }, []);

  return {
    lines,
    addLine,
    clearLines,
  };
}