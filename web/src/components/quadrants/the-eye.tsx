import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useLogStore } from "@/stores/log-store";

interface Idea {
  id: string;
  type: "code_improvements" | "ui_ux" | "security" | "performance";
  title: string;
  confidence: number;
}

const ideaTypeConfig = {
  code_improvements: { color: "emerald", label: "Refactor" },
  ui_ux: { color: "gold", label: "UI/UX" },
  security: { color: "ruby", label: "Security" },
  performance: { color: "gold", label: "Perf" },
};

const mockFiles = [
  "src/auth/middleware.ts",
  "src/api/routes.ts",
  "src/db/schema.ts",
  "src/utils/parser.ts",
  "src/components/Button.tsx",
  "src/hooks/useAuth.ts",
  "src/stores/session.ts",
];

export function TheEye() {
  const [scanningFiles, setScanningFiles] = useState<string[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [isDreaming] = useState(true);
  const addLogEntry = useLogStore((state) => state.addEntry);

  useEffect(() => {
    if (isDreaming) {
      const interval = setInterval(() => {
        const randomFile = mockFiles[Math.floor(Math.random() * mockFiles.length)];
        setScanningFiles((prev) => [...prev.slice(-5), randomFile]);
      }, 300);
      return () => clearInterval(interval);
    }
  }, [isDreaming]);

  useEffect(() => {
    if (isDreaming) {
      const ideaInterval = setInterval(() => {
        const types: Idea["type"][] = ["code_improvements", "ui_ux", "security", "performance"];
        const randomType = types[Math.floor(Math.random() * types.length)];
        
        const newIdea: Idea = {
          id: `idea-${Date.now()}`,
          type: randomType,
          title: `Optimize ${randomType.replace("_", " ")} in module`,
          confidence: Math.floor(Math.random() * 30) + 70,
        };
        
        setIdeas((prev) => [...prev.slice(-4), newIdea]);
        
        // Log to store
        addLogEntry({
          level: "info",
          message: `New idea generated: ${newIdea.title} (${newIdea.confidence}% confidence)`,
          source: "Eye",
        });
      }, 2000);
      return () => clearInterval(ideaInterval);
    }
  }, [isDreaming, addLogEntry]);

  return (
    <Card className="h-full p-4 flex flex-col bg-[var(--color-surface-secondary)] border-[var(--color-border)] shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold flex items-center gap-2 font-sans tracking-tight text-[var(--color-foreground)]">
          <span className="text-xl">🔮</span>
          THE EYE
          {isDreaming && (
            <Badge variant="gold" className="animate-pulse bg-[var(--color-gold)]/20 text-[var(--color-gold)] border-[var(--color-gold)]/50">Dreaming</Badge>
          )}
        </h2>
        <span className="text-xs sm:text-sm text-[var(--color-silver-muted)] font-mono">
          Analysis & Ideation
        </span>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col relative">
        {/* Scanning Files Stream */}
        <div className="flex-1 relative border-l border-[var(--color-border)] pl-4 ml-2">
          <div className="absolute inset-0 overflow-hidden">
            <div className="font-mono text-xs text-[var(--color-silver-muted)] opacity-80 space-y-1">
              <AnimatePresence>
                {scanningFiles.map((file, i) => (
                  <motion.div
                    key={`${file}-${i}`}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    className="flex items-center gap-2"
                  >
                    <span className="text-[var(--color-emerald)]">▸</span>
                    {file}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>

          {/* Ideas Overlay */}
          <AnimatePresence>
            {ideas.map((idea, index) => (
              <motion.div
                key={idea.id}
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: -20 }}
                transition={{ type: "spring", stiffness: 200 }}
                className="absolute w-full pr-4"
                style={{ top: `${20 + index * 20}%`, left: "0" }}
              >
                <div className="p-2 sm:px-3 sm:py-2 rounded-lg bg-[var(--color-surface-tertiary)] border border-[var(--color-emerald)]/30 shadow-lg flex items-center justify-between gap-2 backdrop-blur-sm">
                  <div className="flex items-center gap-2 truncate">
                    <div className={`w-2 h-2 rounded-full bg-[var(--color-${ideaTypeConfig[idea.type].color})]`} />
                    <span className="text-xs sm:text-sm truncate text-[var(--color-foreground)]">{idea.title}</span>
                  </div>
                  <span className="text-xs font-mono text-[var(--color-emerald)] whitespace-nowrap">
                    {idea.confidence}%
                  </span>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Footer Stats */}
        <div className="mt-4 grid grid-cols-3 gap-2 text-center border-t border-[var(--color-border)] pt-4">
          {(["code_improvements", "security", "performance"] as const).map((type) => (
            <div key={type} className="p-1 rounded hover:bg-[var(--color-surface-tertiary)] transition-colors">
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-silver-muted)] mb-1">
                {ideaTypeConfig[type].label}
              </div>
              <div className="font-mono text-sm sm:text-base font-bold text-[var(--color-emerald)]">
                {Math.floor(Math.random() * 5) + 2}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
