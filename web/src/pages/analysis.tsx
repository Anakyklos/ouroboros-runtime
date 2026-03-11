import { TheEye } from "@/components/quadrants/the-eye";

export function AnalysisPage() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-[var(--color-foreground)]">Analysis</h1>
      </div>
      <div className="flex-1">
        <TheEye />
      </div>
    </div>
  );
}
