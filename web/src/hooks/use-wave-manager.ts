import { useState, useCallback } from "react";
import { useMissionControlStore, type Wave } from "@/stores/mission-control-store";
import { useLogStore } from "@/stores/log-store";

interface UseWaveManagerOptions {
  maxActiveWaves?: number;
}

export function useWaveManager(options: UseWaveManagerOptions = {}) {
  const { maxActiveWaves = 1 } = options;
  
  const waves = useMissionControlStore((state) => state.waves);
  const waveNumber = useMissionControlStore((state) => state.waveNumber);
  const setWaveNumber = useMissionControlStore((state) => state.setWaveNumber);
  const updateWave = useMissionControlStore((state) => state.updateWave);
  const addLogEntry = useLogStore((state) => state.addEntry);

  const [promotingWave, setPromotingWave] = useState<string | null>(null);

  const createWave = useCallback((title?: string) => {
    const newWaveNumber = waveNumber + 1;
    
    const newWave: Wave = {
      id: `wave-${Date.now()}`,
      number: newWaveNumber,
      status: "pending",
      tasks: [],
      ...(title && { title }),
    };

    setWaveNumber(newWaveNumber);
    
    // Add to waves array (would be in store)
    addLogEntry({
      level: "info",
      message: `Wave #${newWaveNumber} created`,
      source: "WaveManager",
    });

    return newWave;
  }, [waveNumber, setWaveNumber, addLogEntry]);

  const activateWave = useCallback((waveId: string) => {
    const wave = waves.find((w) => w.id === waveId);
    if (!wave) return;

    // Check if we can activate (max active waves limit)
    const activeWaves = waves.filter((w) => w.status === "active").length;
    if (activeWaves >= maxActiveWaves) {
      addLogEntry({
        level: "warn",
        message: `Cannot activate Wave #${wave.number}: max active waves reached`,
        source: "WaveManager",
      });
      return;
    }

    setPromotingWave(waveId);

    // Simulate promotion animation delay
    setTimeout(() => {
      updateWave(waveId, { status: "active" });
      setPromotingWave(null);
      
      addLogEntry({
        level: "info",
        message: `Wave #${wave.number} activated`,
        source: "WaveManager",
      });
    }, 500);
  }, [waves, maxActiveWaves, updateWave, addLogEntry]);

  const completeWave = useCallback((waveId: string) => {
    const wave = waves.find((w) => w.id === waveId);
    if (!wave) return;

    updateWave(waveId, { status: "done" });
    
    addLogEntry({
      level: "info",
      message: `Wave #${wave.number} completed`,
      source: "WaveManager",
    });
  }, [waves, updateWave, addLogEntry]);

  const reorderWaves = useCallback((oldIndex: number, newIndex: number) => {
    // This would reorder waves in the store
    addLogEntry({
      level: "debug",
      message: `Waves reordered: ${oldIndex} → ${newIndex}`,
      source: "WaveManager",
    });
  }, [addLogEntry]);

  const getNextPendingWave = useCallback(() => {
    return waves.find((w) => w.status === "pending");
  }, [waves]);

  const autoPromoteNextWave = useCallback(() => {
    const nextWave = getNextPendingWave();
    if (nextWave && canActivateWave()) {
      activateWave(nextWave.id);
    }
  }, [getNextPendingWave, activateWave]);

  const canActivateWave = useCallback(() => {
    const activeWaves = waves.filter((w) => w.status === "active").length;
    return activeWaves < maxActiveWaves;
  }, [waves, maxActiveWaves]);

  return {
    waves,
    promotingWave,
    createWave,
    activateWave,
    completeWave,
    reorderWaves,
    getNextPendingWave,
    autoPromoteNextWave,
    canActivateWave,
  };
}