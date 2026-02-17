import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Activity, Eye, GitBranch, Shield, Settings } from "lucide-react";

interface SwissSidebarProps {
  activeSection: string;
  onNavigate: (section: string) => void;
}

const menuItems = [
  { id: "dashboard", label: "DASHBOARD", icon: Activity },
  { id: "the_eye", label: "THE EYE", icon: Eye },
  { id: "the_coil", label: "THE COIL", icon: GitBranch },
  { id: "the_council", label: "THE COUNCIL", icon: Shield },
];

export function SwissSidebar({ activeSection, onNavigate }: SwissSidebarProps) {
  return (
    <nav className="fixed left-0 top-0 bottom-0 w-[240px] bg-[var(--color-surface-secondary)] border-r border-[var(--color-border)] flex flex-col z-40">
      {/* Header */}
      <div className="h-24 flex items-center px-6 border-b border-[var(--color-border)]">
        <h1 className="text-2xl font-bold tracking-tight text-[var(--color-foreground)] uppercase">
          Ouroboros
        </h1>
      </div>

      {/* Menu */}
      <div className="flex-1 py-8 px-4 space-y-1">
        {menuItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={cn(
              "w-full flex items-center gap-4 px-4 py-3 text-sm font-medium transition-colors uppercase tracking-wider",
              activeSection === item.id
                ? "bg-[var(--color-foreground)] text-[var(--color-background)]"
                : "text-[var(--color-silver-muted)] hover:text-[var(--color-foreground)] hover:bg-[var(--color-surface-tertiary)]"
            )}
          >
            <item.icon className="w-5 h-5" />
            {item.label}
          </button>
        ))}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-[var(--color-border)]">
        <button
          onClick={() => onNavigate("settings")}
          className="w-full flex items-center gap-4 px-4 py-3 text-sm font-medium text-[var(--color-silver-muted)] hover:text-[var(--color-foreground)] uppercase tracking-wider"
        >
          <Settings className="w-5 h-5" />
          SETTINGS
        </button>
      </div>
    </nav>
  );
}
