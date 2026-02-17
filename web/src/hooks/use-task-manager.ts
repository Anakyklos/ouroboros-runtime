import { useState, useCallback } from "react";
import { useMissionControlStore, type Task } from "@/stores/mission-control-store";
import { useLogStore } from "@/stores/log-store";

interface UseTaskManagerOptions {
  maxParallelTasks?: number;
}

export function useTaskManager(options: UseTaskManagerOptions = {}) {
  const { maxParallelTasks = 3 } = options;
  
  const waves = useMissionControlStore((state) => state.waves);
  const updateWave = useMissionControlStore((state) => state.updateWave);
  const updateTask = useMissionControlStore((state) => state.updateTask);
  const addLogEntry = useLogStore((state) => state.addEntry);

  const [isDragging, setIsDragging] = useState(false);

  const createTask = useCallback((waveId: string, title: string, description?: string) => {
    const newTask: Task = {
      id: `task-${Date.now()}`,
      title,
      progress: 0,
      phase: "planning",
      ...(description && { description }),
    };

    const wave = waves.find((w) => w.id === waveId);
    if (wave) {
      updateWave(waveId, {
        tasks: [...wave.tasks, newTask],
      });
      
      addLogEntry({
        level: "info",
        message: `Task created: ${title}`,
        source: "TaskManager",
      });
    }

    return newTask;
  }, [waves, updateWave, addLogEntry]);

  const deleteTask = useCallback((waveId: string, taskId: string) => {
    const wave = waves.find((w) => w.id === waveId);
    if (wave) {
      const task = wave.tasks.find((t) => t.id === taskId);
      updateWave(waveId, {
        tasks: wave.tasks.filter((t) => t.id !== taskId),
      });
      
      addLogEntry({
        level: "info",
        message: `Task deleted: ${task?.title || taskId}`,
        source: "TaskManager",
      });
    }
  }, [waves, updateWave, addLogEntry]);

  const moveTask = useCallback((
    sourceWaveId: string,
    targetWaveId: string,
    taskId: string,
    newIndex?: number
  ) => {
    const sourceWave = waves.find((w) => w.id === sourceWaveId);
    const targetWave = waves.find((w) => w.id === targetWaveId);
    
    if (!sourceWave || !targetWave) return;

    const task = sourceWave.tasks.find((t) => t.id === taskId);
    if (!task) return;

    // Remove from source
    updateWave(sourceWaveId, {
      tasks: sourceWave.tasks.filter((t) => t.id !== taskId),
    });

    // Add to target
    const newTasks = [...targetWave.tasks];
    if (newIndex !== undefined) {
      newTasks.splice(newIndex, 0, task);
    } else {
      newTasks.push(task);
    }

    updateWave(targetWaveId, { tasks: newTasks });

    addLogEntry({
      level: "info",
      message: `Task moved: ${task.title} → Wave ${targetWave.number}`,
      source: "TaskManager",
    });
  }, [waves, updateWave, addLogEntry]);

  const reorderTasks = useCallback((waveId: string, oldIndex: number, newIndex: number) => {
    const wave = waves.find((w) => w.id === waveId);
    if (!wave) return;

    const tasks = [...wave.tasks];
    const [movedTask] = tasks.splice(oldIndex, 1);
    tasks.splice(newIndex, 0, movedTask);

    updateWave(waveId, { tasks });
  }, [waves, updateWave]);

  const startTask = useCallback((waveId: string, taskId: string) => {
    updateTask(waveId, taskId, { phase: "coding", progress: 0 });
    
    addLogEntry({
      level: "info",
      message: `Task started: ${taskId}`,
      source: "TaskManager",
    });
  }, [updateTask, addLogEntry]);

  const pauseTask = useCallback((waveId: string, taskId: string) => {
    updateTask(waveId, taskId, { phase: "paused" });
    
    addLogEntry({
      level: "warn",
      message: `Task paused: ${taskId}`,
      source: "TaskManager",
    });
  }, [updateTask, addLogEntry]);

  const completeTask = useCallback((waveId: string, taskId: string) => {
    updateTask(waveId, taskId, { phase: "complete", progress: 100 });
    
    addLogEntry({
      level: "info",
      message: `Task completed: ${taskId}`,
      source: "TaskManager",
    });
  }, [updateTask, addLogEntry]);

  const getActiveTaskCount = useCallback(() => {
    return waves.reduce((count, wave) => {
      return count + wave.tasks.filter((t) => t.phase === "coding").length;
    }, 0);
  }, [waves]);

  const canStartNewTask = useCallback(() => {
    return getActiveTaskCount() < maxParallelTasks;
  }, [getActiveTaskCount, maxParallelTasks]);

  return {
    waves,
    isDragging,
    setIsDragging,
    createTask,
    deleteTask,
    moveTask,
    reorderTasks,
    startTask,
    pauseTask,
    completeTask,
    getActiveTaskCount,
    canStartNewTask,
  };
}