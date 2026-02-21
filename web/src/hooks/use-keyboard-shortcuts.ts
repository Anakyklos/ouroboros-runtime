import { useEffect, useCallback } from "react";
import { useMissionControlStore } from "@/stores/mission-control-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useLogStore } from "@/stores/log-store";

interface UseKeyboardShortcutsOptions {
  onPause?: () => void;
  onResume?: () => void;
  onEmergencyBrake?: () => void;
  onToggleLogs?: () => void;
  onFocusTerminal?: () => void;
  onQuadrantSwitch?: (quadrant: 1 | 2 | 3 | 4) => void;
}

export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions = {}) {
  const {
    onPause,
    onResume,
    onEmergencyBrake,
    onToggleLogs,
    onFocusTerminal,
    onQuadrantSwitch,
  } = options;

  const mode = useMissionControlStore((state) => state.mode);
  const setMode = useMissionControlStore((state) => state.setMode);
  const setActiveQuadrant = useMissionControlStore((state) => state.setActiveQuadrant);
  const setViewMode = useMissionControlStore((state) => state.setViewMode);
  const addLogEntry = useLogStore((state) => state.addEntry);
  const confirmEmergency = useSettingsStore((state) => state.confirmEmergencyBrake);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      switch (event.key) {
        case " ":
          // Space to toggle pause/resume
          event.preventDefault();
          if (mode === "pause") {
            setMode("running");
            onResume?.();
            addLogEntry({
              level: "info",
              message: "Resumed via keyboard shortcut",
              source: "Keyboard",
            });
          } else {
            setMode("pause");
            onPause?.();
            addLogEntry({
              level: "info",
              message: "Paused via keyboard shortcut",
              source: "Keyboard",
            });
          }
          break;

        case "Escape":
          // Escape for emergency brake
          event.preventDefault();
          if (confirmEmergency) {
            const confirmed = window.confirm(
              "🛑 EMERGENCY BRAKE\n\nThis will immediately stop all active tasks. Are you sure?"
            );
            if (!confirmed) return;
          }
          setMode("pause");
          onEmergencyBrake?.();
          addLogEntry({
            level: "error",
            message: "EMERGENCY BRAKE activated via keyboard",
            source: "Keyboard",
          });
          break;

        case "l":
        case "L":
          // L to toggle logs
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            onToggleLogs?.();
          }
          break;

        case "`":
        case "~":
          // Backtick to focus terminal
          event.preventDefault();
          onFocusTerminal?.();
          break;

        case "1":
        case "2":
        case "3":
        case "4":
          // Number keys to switch quadrants
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            const quadrant = parseInt(event.key) as 1 | 2 | 3 | 4;
            setActiveQuadrant(quadrant);
            setViewMode("focused");
            onQuadrantSwitch?.(quadrant);
            addLogEntry({
              level: "info",
              message: `Switched to quadrant ${quadrant}`,
              source: "Keyboard",
            });
          }
          break;

        case "f":
        case "F":
          // F for frenzy mode (with confirmation)
          if (event.shiftKey) {
            event.preventDefault();
            const confirmed = window.confirm(
              "🔥 FRENZY MODE\n\nThis removes all safety checks. Continue?"
            );
            if (confirmed) {
              setMode("frenzy");
              addLogEntry({
                level: "warn",
                message: "FRENZY mode activated",
                source: "Keyboard",
              });
            }
          }
          break;
      }
    },
    [mode, setMode, setActiveQuadrant, setViewMode, onPause, onResume, onEmergencyBrake, onToggleLogs, onFocusTerminal, onQuadrantSwitch, confirmEmergency, addLogEntry]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return {
    shortcuts: [
      { key: "Space", action: "Pause/Resume" },
      { key: "Esc", action: "Emergency Brake" },
      { key: "Ctrl+L", action: "Toggle Logs" },
      { key: "`", action: "Focus Terminal" },
      { key: "Ctrl+1/2/3/4", action: "Switch Quadrant" },
      { key: "Shift+F", action: "Frenzy Mode" },
    ],
  };
}