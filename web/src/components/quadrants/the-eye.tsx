import { motion, AnimatePresence } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useEffect, useState } from "react";
import { useLogStore } from "@/stores/log-store";

interface Idea {
  id: string;
  type: "code_improvements" | "ui_ux" | "documentation" | "security" | "performance" | "quality";
  title: string;
  confidence: number;
}

const ideaTypeConfig = {
  code_improvements: { color: "emerald", label: "Code" },
  ui_ux: { color: "violet-400", label: "UI/UX" },
  documentation: { color: "sky-400", label: "Docs" },
  security: { color: "ruby", label: "Security" },
  performance: { color: "gold", label: "Perf" },
  quality: { color: "silver", label: "Quality" },
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
    <Card className="h-full p-4 flex flex-col bg-[var(--surface-primary)] border-[var(--border)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <span className="text-xl">🔮</span>
          THE EYE
          {isDreaming && (
            <Badge variant="gold" className="animate-pulse">Dreaming</Badge>
          )}
        </h2>
        <span className="text-sm text-[var(--muted-foreground)]">
          Analysis & Ideation
        </span>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 relative">
          <div className="absolute inset-0 overflow-hidden">
            <div className="font-mono text-xs text-[var(--muted-foreground)] opacity-60 space-y-0.5">
              <AnimatePresence>
                {scanningFiles.map((file, i) => (
                  <motion.div
                    key={`${file}-${i}`}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 0.6, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    className="text-silver-muted"
                  >
                    <span className="text-emerald mr-2">▸</span>
                    {file}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>

          <AnimatePresence>
            {ideas.map((idea, index) => (
              <motion.div
                key={idea.id}
                initial={{ opacity: 0, scale: 0.8, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.8, y: -20 }}
                transition={{ type: "spring", stiffness: 200 }}
                className="absolute"
                style={{ top: `${20 + index * 18}%`, left: "10%" }}
              >
                <div className="px-3 py-2 rounded-lg bg-[var(--surface-secondary)] border border-emerald/30 shadow-lg">
                  <div className="flex items-center gap-2">
                    <Badge variant={ideaTypeConfig[idea.type].color as "emerald" | "gold" | "ruby" | "silver"}>
                      {ideaTypeConfig[idea.type].label}
                    </Badge>
                    <span className="text-sm">{idea.title}</span>
                    <span className="text-xs font-mono text-emerald">
                      {idea.confidence}%
                    </span>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          {(["code_improvements", "security", "performance"] as const).map((type) => (
            <div key={type} className="p-2 rounded-lg bg-[var(--surface-secondary)]">
              <div className="text-xs text-[var(--muted-foreground)]">
                {ideaTypeConfig[type].label}
              </div>
              <div className="font-mono text-lg font-bold text-emerald">
                {Math.floor(Math.random() * 5) + 2}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}