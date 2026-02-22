import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Terminal } from "./terminal";
import { Plus, Grid3X3, LayoutGrid } from "lucide-react";
import { useSettingsStore } from "@/stores/settings-store";

interface TerminalSession {
  id: string;
  title: string;
  wsUrl: string;
}

interface TerminalGridProps {
  maxTerminals?: number;
}

export function TerminalGrid({ maxTerminals = 4 }: TerminalGridProps) {
  const daemonConfig = useSettingsStore((state) => state.daemonConfig);
  const baseWsUrl = daemonConfig.websocketUrl.replace("/ws", "/pty");
  
  const [terminals, setTerminals] = useState<TerminalSession[]>([
    {
      id: "term-1",
      title: "Main Session",
      wsUrl: `${baseWsUrl}/main`,
    },
  ]);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [layout, setLayout] = useState<"grid" | "tabs">("grid");

  const addTerminal = useCallback(() => {
    if (terminals.length >= maxTerminals) return;

    const newId = `term-${Date.now()}`;
    setTerminals((prev) => [
      ...prev,
      {
        id: newId,
        title: `Session ${prev.length + 1}`,
        wsUrl: `${baseWsUrl}/${newId}`,
      },
    ]);
  }, [terminals.length, maxTerminals, baseWsUrl]);

  const removeTerminal = useCallback((id: string) => {
    setTerminals((prev) => prev.filter((t) => t.id !== id));
    if (maximizedId === id) {
      setMaximizedId(null);
    }
  }, [maximizedId]);

  const toggleMaximize = useCallback((id: string) => {
    setMaximizedId((prev) => (prev === id ? null : id));
  }, []);

  const getGridClass = () => {
    if (maximizedId) return "grid-cols-1 grid-rows-1";
    if (terminals.length === 1) return "grid-cols-1 grid-rows-1";
    if (terminals.length === 2) return "grid-cols-2 grid-rows-1";
    if (terminals.length <= 4) return "grid-cols-2 grid-rows-2";
    return "grid-cols-2 grid-rows-2";
  };

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-[var(--surface-secondary)] border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <span className="font-semibold">Terminals</span>
          <span className="text-sm text-[var(--muted-foreground)]">
            {terminals.length}/{maxTerminals}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLayout("grid")}
            className={`p-1.5 rounded ${layout === "grid" ? "bg-emerald/20 text-emerald" : "text-[var(--muted-foreground)]"}`}
          >
            <Grid3X3 className="w-4 h-4" />
          </button>
          <button
            onClick={() => setLayout("tabs")}
            className={`p-1.5 rounded ${layout === "tabs" ? "bg-emerald/20 text-emerald" : "text-[var(--muted-foreground)]"}`}
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-[var(--border)] mx-1" />
          <button
            onClick={addTerminal}
            disabled={terminals.length >= maxTerminals}
            className="flex items-center gap-1 px-2 py-1 rounded bg-emerald/20 text-emerald hover:bg-emerald hover:text-obsidian disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
          >
            <Plus className="w-3 h-3" />
            New
          </button>
        </div>
      </div>

      {/* Terminal Grid */}
      <div className={`flex-1 p-4 grid gap-4 ${getGridClass()}`}>
        <AnimatePresence mode="popLayout">
          {terminals.map((terminal) => (
            <motion.div
              key={terminal.id}
              layout
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ 
                opacity: maximizedId && maximizedId !== terminal.id ? 0 : 1,
                scale: 1,
              }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.2 }}
              className={maximizedId === terminal.id ? "col-span-full row-span-full" : ""}
            >
              <Terminal
                id={terminal.id}
                title={terminal.title}
                wsUrl={terminal.wsUrl}
                onClose={terminals.length > 1 ? () => removeTerminal(terminal.id) : undefined}
                onMaximize={() => toggleMaximize(terminal.id)}
                isMaximized={maximizedId === terminal.id}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}