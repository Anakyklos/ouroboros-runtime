import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmergencyBrakeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function EmergencyBrakeDialog({ isOpen, onClose, onConfirm }: EmergencyBrakeDialogProps) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

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
              />
            </Dialog.Overlay>
            <Dialog.Content asChild>
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md p-6 bg-[var(--color-surface-primary)] rounded-xl border border-[var(--color-border)] shadow-2xl"
              >
                <div className="flex items-start gap-4">
                  <div className="p-3 rounded-full bg-[var(--color-ruby)]/20">
                    <AlertTriangle className="w-6 h-6 text-[var(--color-ruby)]" />
                  </div>
                  <div className="flex-1">
                    <Dialog.Title className="text-xl font-bold text-[var(--color-foreground)] mb-2">
                      Emergency Brake
                    </Dialog.Title>
                    <Dialog.Description className="text-[var(--color-silver-muted)] mb-6">
                      Stop all execution? This cannot be undone.
                    </Dialog.Description>
                    <p className="text-sm text-[var(--color-silver-muted)] mb-6">
                      All active tasks will be immediately halted and their progress will be lost.
                    </p>
                    <div className="flex gap-3 justify-end">
                      <Button
                        variant="outline"
                        onClick={onClose}
                        className="px-4 py-2"
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={() => {
                          onConfirm();
                          onClose();
                        }}
                        className="px-4 py-2 bg-[var(--color-ruby)] hover:bg-[var(--color-ruby)]/80 text-white"
                      >
                        Confirm
                      </Button>
                    </div>
                  </div>
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
