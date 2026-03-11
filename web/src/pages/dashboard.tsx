import { motion } from "framer-motion";
import { TheEye } from "@/components/quadrants/the-eye";
import { TheCoil } from "@/components/quadrants/the-coil";
import { TheStrike } from "@/components/quadrants/the-strike";
import { TheCouncil } from "@/components/quadrants/the-council";
import { useWaveManager } from "@/hooks/use-wave-manager";

export function Dashboard() {
  const { promotingWave, activateWave } = useWaveManager();

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6 h-full min-h-[600px]">
      {/* Top Left: Analysis */}
      <motion.section
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="min-h-[280px]"
      >
        <TheEye />
      </motion.section>

      {/* Top Right: Wave Queue */}
      <motion.section
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="min-h-[280px]"
      >
        <TheCoil
          onWaveActivate={activateWave}
          promotingWave={promotingWave}
        />
      </motion.section>

      {/* Bottom Left: Agent Review */}
      <motion.section
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="min-h-[280px]"
      >
        <TheCouncil />
      </motion.section>

      {/* Bottom Right: Execution */}
      <motion.section
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="min-h-[280px]"
      >
        <TheStrike />
      </motion.section>
    </div>
  );
}
