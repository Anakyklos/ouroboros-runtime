import { cn } from "@/lib/utils";
import { InboxIcon, WifiOff, AlertCircle } from "lucide-react";

interface EmptyStateProps {
  message: string;
  description?: string;
  icon?: "inbox" | "offline" | "error";
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

const iconMap = {
  inbox: InboxIcon,
  offline: WifiOff,
  error: AlertCircle,
};

export function EmptyState({
  message,
  description,
  icon = "inbox",
  action,
  className,
}: EmptyStateProps) {
  const IconComponent = iconMap[icon];

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center h-full min-h-[120px] py-8 px-4 text-center",
        className
      )}
    >
      <IconComponent className="w-10 h-10 text-[var(--color-silver-muted)] mb-3 opacity-50" />
      <p className="text-sm font-medium text-[var(--color-foreground)] mb-1">
        {message}
      </p>
      {description && (
        <p className="text-xs text-[var(--color-silver-muted)] max-w-[240px]">
          {description}
        </p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-3 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer
            bg-[var(--color-emerald)]/10 text-[var(--color-emerald)]
            hover:bg-[var(--color-emerald)]/20 transition-colors duration-200
            border border-[var(--color-emerald)]/30"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
