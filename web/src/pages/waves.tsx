import { TheCoil } from "@/components/quadrants/the-coil";
import { useWaveManager } from "@/hooks/use-wave-manager";

export function WavesPage() {
  const { promotingWave, activateWave } = useWaveManager();

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-[var(--color-foreground)]">Waves</h1>
      </div>
      <div className="flex-1">
        <TheCoil
          onWaveActivate={activateWave}
          promotingWave={promotingWave}
          className="h-full"
        />
      </div>
    </div>
  );
}
