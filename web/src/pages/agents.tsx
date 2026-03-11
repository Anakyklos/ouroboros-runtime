import { TheCouncil } from "@/components/quadrants/the-council";

export function AgentsPage() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-[var(--color-foreground)]">Agents</h1>
      </div>
      <div className="flex-1">
        <TheCouncil />
      </div>
    </div>
  );
}
