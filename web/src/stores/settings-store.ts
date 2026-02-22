import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "dark" | "light" | "system";
export type UILayout = "snake" | "swiss";

interface SettingsState {
  // Appearance
  theme: Theme;
  uiLayout: UILayout;
  uiScale: number;
  reducedMotion: boolean;
  
  // Behavior
  autoScrollLogs: boolean;
  maxLogEntries: number;
  confirmEmergencyBrake: boolean;
  
  // Notifications
  soundEnabled: boolean;
  desktopNotifications: boolean;
  
  // Terminal
  terminalFontSize: number;
  terminalFontFamily: string;
  
  // Actions
  setTheme: (theme: Theme) => void;
  setUILayout: (layout: UILayout) => void;
  setUIScale: (scale: number) => void;
  setReducedMotion: (enabled: boolean) => void;
  setAutoScrollLogs: (enabled: boolean) => void;
  setMaxLogEntries: (max: number) => void;
  setConfirmEmergencyBrake: (enabled: boolean) => void;
  setSoundEnabled: (enabled: boolean) => void;
  setDesktopNotifications: (enabled: boolean) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalFontFamily: (family: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "dark",
      uiLayout: "snake",
      uiScale: 100,
      reducedMotion: false,
      autoScrollLogs: true,
      maxLogEntries: 500,
      confirmEmergencyBrake: true,
      soundEnabled: false,
      desktopNotifications: false,
      terminalFontSize: 14,
      terminalFontFamily: "JetBrains Mono",
      
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
      setUILayout: (uiLayout) => {
        set({ uiLayout });
        applyUILayout(uiLayout);
      },
      setUIScale: (uiScale) => {
        set({ uiScale });
        applyUIScale(uiScale);
      },
      setReducedMotion: (reducedMotion) => set({ reducedMotion }),
      setAutoScrollLogs: (autoScrollLogs) => set({ autoScrollLogs }),
      setMaxLogEntries: (maxLogEntries) => set({ maxLogEntries }),
      setConfirmEmergencyBrake: (confirmEmergencyBrake) => set({ confirmEmergencyBrake }),
      setSoundEnabled: (soundEnabled) => set({ soundEnabled }),
      setDesktopNotifications: (desktopNotifications) => set({ desktopNotifications }),
      setTerminalFontSize: (terminalFontSize) => set({ terminalFontSize }),
      setTerminalFontFamily: (terminalFontFamily) => set({ terminalFontFamily }),
    }),
    {
      name: "ouroboros-settings",
    }
  )
);

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  
  if (theme === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", prefersDark ? "dark" : "light");
  } else {
    root.setAttribute("data-theme", theme);
  }
}

function applyUILayout(layout: UILayout) {
  window.dispatchEvent(new CustomEvent("ui:layout-change", { detail: layout }));
}

function applyUIScale(scale: number) {
  const root = document.documentElement;
  root.style.fontSize = `${scale}%`;
}

// Initialize theme on load
if (typeof window !== "undefined") {
  const stored = localStorage.getItem("ouroboros-settings");
  if (stored) {
    const settings = JSON.parse(stored);
    applyTheme(settings.state.theme);
    applyUIScale(settings.state.uiScale);
  }
}