import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import { Keyboard, X } from "lucide-react";

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const shortcuts = [
  { keys: ["Space"], action: "Pause/Resume", category: "Control" },
  { keys: ["Esc"], action: "Emergency Brake", category: "Control" },
  { keys: ["Shift", "F"], action: "Frenzy Mode", category: "Control" },
  { keys: ["`"], action: "Toggle Terminal", category: "Navigation" },
  { keys: ["Ctrl", "L"], action: "Toggle Logs", category: "Navigation" },
  { keys: ["?"], action: "Show this help", category: "Navigation" },
  { keys: ["1-4"], action: "Switch Quadrants", category: "Navigation" },
  { keys: ["Ctrl", "M"], action: "Toggle Memory Panel", category: "Navigation" },
];

export function KeyboardShortcutsModal({ isOpen, onClose }: KeyboardShortcutsModalProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, onClose]);

  const groupedShortcuts = shortcuts.reduce((acc, s) => {
    if (!acc[s.category]) acc[s.category] = [];
    acc[s.category].push(s);
    return acc;
  }, {} as Record<string, typeof shortcuts>);

  return (
    <AnimatePresence>
      {isOpen && (
        <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
          <Dialog.Portal>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/70 z-50"
                onClick={onClose}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild>
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg p-6 bg-[var(--color-surface-primary)] rounded-xl border border-[var(--color-border)] shadow-2xl"
              >
                <div className="flex items-center gap-3 mb-6">
                  <div className="p-2 rounded-lg bg-[var(--color-emerald)]/20">
                    <Keyboard className="w-5 h-5 text-[var(--color-emerald)]" />
                  </div>
                  <Dialog.Title className="text-xl font-bold text-[var(--color-foreground)]">
                    Keyboard Shortcuts
                  </Dialog.Title>
                </div>

                <div className="space-y-6">
                  {Object.entries(groupedShortcuts).map(([category, items]) => (
                    <div key={category}>
                      <h3 className="text-xs font-semibold text-[var(--color-silver-muted)] uppercase tracking-wider mb-3">
                        {category}
                      </h3>
                      <div className="space-y-2">
                        {items.map((shortcut, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between py-2 px-3 rounded-lg bg-[var(--color-surface-secondary)]"
                          >
                            <span className="text-sm text-[var(--color-foreground)]">
                              {shortcut.action}
                            </span>
                            <div className="flex items-center gap-1">
                              {shortcut.keys.map((key, j) => (
                                <span key={j} className="flex items-center gap-1">
                                  {j > 0 && <span className="text-[var(--color-silver-muted)]">+</span>}
                                  <kbd className="px-2 py-1 rounded bg-[var(--color-surface-tertiary)] border border-[var(--color-border)] font-mono text-xs text-[var(--color-foreground)]">
                                    {key}
                                  </kbd>
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-6 pt-4 border-t border-[var(--color-border)] text-center">
                  <p className="text-xs text-[var(--color-silver-muted)]">
                    Press <kbd className="px-1.5 py-0.5 rounded bg-[var(--color-surface-secondary)] font-mono">Esc</kbd> to close
                  </p>
                </div>

                <Dialog.Close asChild>
                  <button
                    className="absolute top-4 right-4 p-2 rounded-lg hover:bg-[var(--color-surface-secondary)] transition-colors"
                    aria-label="Close"
                  >
                    <X className="w-4 h-4 text-[var(--color-silver-muted)]" />
                  </button>
                </Dialog.Close>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </AnimatePresence>
  );
}
