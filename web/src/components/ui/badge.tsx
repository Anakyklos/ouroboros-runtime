import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-[var(--primary)] text-[var(--primary-foreground)]",
        secondary:
          "border-transparent bg-[var(--secondary)] text-[var(--secondary-foreground)]",
        destructive:
          "border-transparent bg-[var(--destructive)] text-[var(--destructive-foreground)]",
        outline: "text-[var(--foreground)]",
        emerald: "border-transparent bg-emerald/20 text-emerald",
        gold: "border-transparent bg-gold/20 text-gold",
        ruby: "border-transparent bg-ruby/20 text-ruby",
        silver: "border-transparent bg-silver/20 text-silver",
        critical: "border-transparent bg-severity-critical/20 text-severity-critical",
        high: "border-transparent bg-severity-high/20 text-severity-high",
        medium: "border-transparent bg-severity-medium/20 text-severity-medium",
        low: "border-transparent bg-severity-low/20 text-severity-low",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
