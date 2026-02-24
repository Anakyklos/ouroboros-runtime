import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSettingsStore, type Theme } from "@/stores/settings-store";
import { 
  Moon, 
  Sun, 
  Monitor, 
  Type, 
  Bell, 
  Volume2, 
  Terminal,
  Keyboard,
  Save,
  RotateCcw
} from "lucide-react";

interface SettingsSectionProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

function SettingsSection({ title, icon, children }: SettingsSectionProps) {
  return (
    <Card className="p-6 bg-[var(--surface-primary)] border-[var(--border)]">
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <h3 className="text-lg font-semibold">{title}</h3>
      </div>
      {children}
    </Card>
  );
}

export function Settings() {
  const settings = useSettingsStore();
  const [hasChanges, setHasChanges] = useState(false);

  const handleChange = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    setHasChanges(true);
  };

  const handleReset = () => {
    if (confirm("Reset all settings to defaults?")) {
      localStorage.removeItem("ouroboros-settings");
      window.location.reload();
    }
  };

  const themeOptions: { value: Theme; label: string; icon: React.ReactNode }[] = [
    { value: "dark", label: "Dark", icon: <Moon className="w-4 h-4" /> },
    { value: "light", label: "Light", icon: <Sun className="w-4 h-4" /> },
    { value: "system", label: "System", icon: <Monitor className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)] p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-3">
              <span className="text-3xl">⚙️</span>
              Settings
            </h1>
            <p className="text-[var(--muted-foreground)] mt-1">
              Customize your Ouroboros experience
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={handleReset}
              className="flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              Reset
            </Button>
            {hasChanges && (
              <Badge variant="emerald" className="animate-pulse">
                <Save className="w-3 h-3 mr-1" />
                Auto-saved
              </Badge>
            )}
          </div>
        </div>

        {/* Settings Grid */}
        <div className="grid gap-6">
          {/* Appearance */}
          <SettingsSection title="Appearance" icon={<Sun className="w-5 h-5 text-gold" />}>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Theme</label>
                <div className="flex gap-2">
                  {themeOptions.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => handleChange(settings.setTheme, option.value)}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-all ${
                        settings.theme === option.value
                          ? "border-emerald bg-emerald/10 text-emerald"
                          : "border-[var(--border)] hover:border-emerald/50"
                      }`}
                    >
                      {option.icon}
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">
                  UI Scale: {settings.uiScale}%
                </label>
                <input
                  type="range"
                  min={75}
                  max={150}
                  step={5}
                  value={settings.uiScale}
                  onChange={(e) => handleChange(settings.setUIScale, Number(e.target.value))}
                  className="w-full h-2 bg-[var(--secondary)] rounded-full appearance-none cursor-pointer
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald"
                />
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.reducedMotion}
                  onChange={(e) => handleChange(settings.setReducedMotion, e.target.checked)}
                  className="w-4 h-4 rounded border-[var(--border)] bg-[var(--secondary)] text-emerald focus:ring-emerald"
                />
                <span>Reduce motion (accessibility)</span>
              </label>
            </div>
          </SettingsSection>

          {/* Behavior */}
          <SettingsSection title="Behavior" icon={<Type className="w-5 h-5 text-emerald" />}>
            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.autoScrollLogs}
                  onChange={(e) => handleChange(settings.setAutoScrollLogs, e.target.checked)}
                  className="w-4 h-4 rounded border-[var(--border)] bg-[var(--secondary)] text-emerald focus:ring-emerald"
                />
                <span>Auto-scroll logs to bottom</span>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.confirmEmergencyBrake}
                  onChange={(e) => handleChange(settings.setConfirmEmergencyBrake, e.target.checked)}
                  className="w-4 h-4 rounded border-[var(--border)] bg-[var(--secondary)] text-emerald focus:ring-emerald"
                />
                <span>Confirm before emergency brake</span>
              </label>

              <div>
                <label className="text-sm font-medium mb-2 block">
                  Max Log Entries: {settings.maxLogEntries}
                </label>
                <input
                  type="range"
                  min={100}
                  max={2000}
                  step={100}
                  value={settings.maxLogEntries}
                  onChange={(e) => handleChange(settings.setMaxLogEntries, Number(e.target.value))}
                  className="w-full h-2 bg-[var(--secondary)] rounded-full appearance-none cursor-pointer
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald"
                />
              </div>
            </div>
          </SettingsSection>

          {/* Notifications */}
          <SettingsSection title="Notifications" icon={<Bell className="w-5 h-5 text-ruby" />}>
            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.soundEnabled}
                  onChange={(e) => handleChange(settings.setSoundEnabled, e.target.checked)}
                  className="w-4 h-4 rounded border-[var(--border)] bg-[var(--secondary)] text-emerald focus:ring-emerald"
                />
                <Volume2 className="w-4 h-4" />
                <span>Enable sound effects</span>
              </label>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.desktopNotifications}
                  onChange={(e) => handleChange(settings.setDesktopNotifications, e.target.checked)}
                  className="w-4 h-4 rounded border-[var(--border)] bg-[var(--secondary)] text-emerald focus:ring-emerald"
                />
                <span>Desktop notifications</span>
              </label>
            </div>
          </SettingsSection>

          {/* Terminal */}
          <SettingsSection title="Terminal" icon={<Terminal className="w-5 h-5 text-sky-400" />}>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">
                  Font Size: {settings.terminalFontSize}px
                </label>
                <input
                  type="range"
                  min={10}
                  max={20}
                  step={1}
                  value={settings.terminalFontSize}
                  onChange={(e) => handleChange(settings.setTerminalFontSize, Number(e.target.value))}
                  className="w-full h-2 bg-[var(--secondary)] rounded-full appearance-none cursor-pointer
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald"
                />
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Font Family</label>
                <select
                  value={settings.terminalFontFamily}
                  onChange={(e) => handleChange(settings.setTerminalFontFamily, e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--secondary)] border border-[var(--border)] 
                    focus:border-emerald focus:outline-none"
                >
                  <option value="JetBrains Mono">JetBrains Mono</option>
                  <option value="Fira Code">Fira Code</option>
                  <option value="Source Code Pro">Source Code Pro</option>
                  <option value="Consolas">Consolas</option>
                </select>
              </div>
            </div>
          </SettingsSection>

          {/* Keyboard Shortcuts */}
          <SettingsSection title="Keyboard Shortcuts" icon={<Keyboard className="w-5 h-5 text-violet-400" />}>
            <div className="grid grid-cols-2 gap-3">
              {[
                { key: "Space", action: "Pause/Resume" },
                { key: "Esc", action: "Exit Focused View / Emergency Brake" },
                { key: "Ctrl + 0", action: "Return to Grid View" },
                { key: "Ctrl + 1", action: "Switch to Quadrant 1" },
                { key: "Ctrl + 2", action: "Switch to Quadrant 2" },
                { key: "Ctrl + 3", action: "Switch to Quadrant 3" },
                { key: "Ctrl + 4", action: "Switch to Quadrant 4" },
                { key: "Ctrl + L", action: "Toggle Logs" },
                { key: "`", action: "Focus Terminal" },
                { key: "Shift + F", action: "Frenzy Mode" },
              ].map((shortcut) => (
                <div
                  key={shortcut.key}
                  className="flex items-center justify-between p-3 rounded-lg bg-[var(--surface-secondary)]"
                >
                  <kbd className="px-2 py-1 rounded bg-[var(--surface-tertiary)] font-mono text-sm">
                    {shortcut.key}
                  </kbd>
                  <span className="text-sm text-[var(--muted-foreground)]">{shortcut.action}</span>
                </div>
              ))}
            </div>
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}