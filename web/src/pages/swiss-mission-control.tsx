import { useState, useEffect } from "react";
import { useMissionControlStore } from "@/stores/mission-control-store";
import { useDaemonAPI } from "@/hooks/use-daemon-api";
import { useEventBus } from "@/hooks/use-event-bus";
import { useLogStore } from "@/stores/log-store";

export function SwissMissionControl() {
  const [currentTime, setCurrentTime] = useState(new Date());
  const { status, emergencyBrake, setMode, capabilities } = useDaemonAPI();
  const waves = useMissionControlStore((state) => state.waves);
  const logs = useLogStore((state) => state.entries);

  const { connectionStatus } = useEventBus();

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (date: Date) => {
    return date.toUTCString().split(" ")[4];
  };

  const memoryData = status?.memory;
  const systemHealth = {
    cpu: memoryData
      ? Math.round((memoryData.heapUsedBytes / Math.max(memoryData.heapTotalBytes, 1)) * 100)
      : 0,
    mem: memoryData ? Math.round(memoryData.rssBytes / 1024 / 1024) : 0,
    net: 0,
    disk: 0,
    io: 0,
    tmp: 0,
    vlt: 0,
    fan: 0,
  };

  const pendingWaves = waves.filter(w => w.status === "pending").length;
  const doneWaves = waves.filter(w => w.status === "done").length;

  const handleEmergencyStop = async () => {
    if (!capabilities.emergencyBrake) return;
    try {
      await emergencyBrake();
    } catch {
      /* lastControlError in store */
    }
  };

  const handlePause = async () => {
    if (!capabilities.modeSwitching) return;
    try {
      await setMode("pause");
    } catch {
      /* lastControlError in store */
    }
  };

  const handleRestart = async () => {
    if (!capabilities.modeSwitching) return;
    try {
      await setMode("running");
    } catch {
      /* lastControlError in store */
    }
  };

  return (
    <div className="min-h-screen bg-black text-white font-sans selection:bg-white selection:text-black overflow-x-hidden">
      {/* Header */}
      <header className="w-full border-b border-white/20 px-6 py-8 md:px-10 md:py-10 flex justify-between items-center">
        <h1 className="text-4xl md:text-5xl font-black tracking-tight uppercase">
          Ouroboros Swiss <br className="hidden md:block lg:hidden"/> Mission Control <span className="text-gray-500">V2</span>
        </h1>
        <div className="hidden md:flex flex-col items-end text-right">
          <span className="text-xs font-light tracking-widest uppercase text-gray-400">System Time (UTC)</span>
          <span className="text-2xl font-bold font-mono mt-1">{formatTime(currentTime)}</span>
        </div>
      </header>

      {/* Main Grid */}
      <main className="p-6 md:p-10 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6 md:gap-8 max-w-[1920px] mx-auto">
        
        {/* Left Column */}
        <div className="flex flex-col gap-6 md:gap-8 lg:col-span-1">
          
          {/* System Health */}
          <section className="border border-white/30 p-6 flex flex-col h-full bg-black relative group hover:border-white/100 transition-colors duration-500">
            <div className="absolute top-0 right-0 w-3 h-3 border-t border-r border-white opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <h2 className="text-xl font-bold uppercase mb-6 tracking-tight">System Health</h2>
            <div className="flex-grow flex items-end justify-between gap-2 h-40 mb-6 font-mono text-xs">
              {Object.entries(systemHealth).map(([key, value]) => (
                <div key={key} className="flex flex-col items-center justify-end h-full w-full gap-2">
                  <div 
                    className="w-full bg-white relative" 
                    style={{ height: `${value}%`, opacity: value / 100 + 0.1 }}
                  >
                    {value > 85 && (
                      <div className="absolute -top-3 left-1/2 transform -translate-x-1/2 w-1.5 h-1.5 bg-red-600 rounded-full"></div>
                    )}
                  </div>
                  <span className="text-gray-500">{key.toUpperCase()}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-white/20 pt-4 flex justify-between items-center">
              <span className="text-sm font-light uppercase text-gray-400">Overall Status</span>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${
                  connectionStatus === 'connected' ? 'bg-green-500' :
                  connectionStatus === 'reconnecting' ? 'bg-yellow-500 animate-pulse' :
                  'bg-red-500'
                }`}></span>
                <span className={`text-sm font-bold uppercase tracking-widest ${
                  connectionStatus === 'connected' ? 'text-white' :
                  connectionStatus === 'reconnecting' ? 'text-yellow-500' :
                  'text-red-500'
                }`}>
                  {connectionStatus === 'connected' ? 'Optimal' :
                   connectionStatus === 'reconnecting' ? 'Reconnecting...' :
                   'Disconnected'}
                </span>
              </div>
            </div>
          </section>

          {/* Task Log */}
          <section className="border border-white/30 p-6 flex flex-col h-full bg-black relative group hover:border-white/100 transition-colors duration-500">
            <div className="absolute bottom-0 left-0 w-3 h-3 border-b border-l border-white opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <h2 className="text-xl font-bold uppercase mb-4 tracking-tight">Task Log</h2>
            <div className="font-mono text-xs md:text-sm space-y-3 leading-tight text-gray-300 max-h-60 overflow-y-auto">
              {logs.slice(-5).reverse().map((log, i) => (
                <div key={i} className="flex gap-3">
                  <span className="text-gray-500">{new Date(log.timestamp || Date.now()).toTimeString().split(' ')[0]}</span>
                  <span className={`font-bold ${log.level === 'error' ? 'text-red-500' : log.level === 'warn' ? 'text-yellow-500' : 'text-white'}`}>
                    [{log.level.toUpperCase()}]
                  </span>
                  <span className="font-light">{log.message}</span>
                </div>
              ))}
              {logs.length === 0 && (
                <div className="text-gray-500 italic">No logs yet...</div>
              )}
            </div>
          </section>
        </div>

        {/* Center Columns */}
        <div className="md:col-span-1 lg:col-span-2 flex flex-col gap-6 md:gap-8">
          
          {/* Core Hub */}
          <section className="border border-white/30 p-8 flex flex-col items-center justify-center h-full bg-black relative min-h-[400px]">
            <div className="absolute top-0 left-0 w-4 h-4 border-t border-l border-white"></div>
            <div className="absolute top-0 right-0 w-4 h-4 border-t border-r border-white"></div>
            <div className="absolute bottom-0 left-0 w-4 h-4 border-b border-l border-white"></div>
            <div className="absolute bottom-0 right-0 w-4 h-4 border-b border-r border-white"></div>
            <h2 className="absolute top-8 text-xl font-bold uppercase tracking-tight">Core Hub</h2>
            
            <div className="relative w-64 h-64 md:w-80 md:h-80 flex items-center justify-center">
              <div className="absolute w-full h-full border border-white/80 rounded-full animate-[spin_10s_linear_infinite]"></div>
              <div className="absolute w-[90%] h-[90%] border border-dashed border-white/30 rounded-full animate-[spin_15s_linear_infinite_reverse]"></div>
              <div className="w-32 h-32 relative text-white">
                <svg className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 100 100">
                  <path d="M50 20 C65 20 80 30 80 50 C80 70 65 80 50 80 C35 80 20 70 20 50 C20 40 25 35 35 35 L45 35 L45 45 L35 45 C30 45 30 50 30 50 C30 60 40 70 50 70 C60 70 70 60 70 50 C70 40 60 30 50 30 C45 30 40 32 40 32"></path>
                  <rect height="16" strokeWidth="1.5" transform="rotate(45 50 50)" width="16" x="42" y="42"></rect>
                  <circle cx="50" cy="50" fill="white" r="2"></circle>
                </svg>
              </div>
            </div>
            
            <div className="absolute bottom-8 w-full px-8 flex justify-between items-end border-t border-white/10 pt-4">
              <div>
                <div className="text-xs font-light text-gray-400 uppercase tracking-wider mb-1">Status</div>
                <div className="text-lg font-bold uppercase flex items-center gap-2">
                  {connectionStatus === 'connected' ? 'Active' : 
                   connectionStatus === 'reconnecting' ? 'Reconnecting' : 'Offline'}
                  <span className={`w-2 h-2 rounded-full ${
                    connectionStatus === 'connected' ? 'bg-white animate-pulse' :
                    connectionStatus === 'reconnecting' ? 'bg-yellow-500 animate-pulse' :
                    'bg-red-500'
                  }`}></span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-light text-gray-400 uppercase tracking-wider mb-1">Waves</div>
                <div className="text-lg font-bold font-mono">{waves.length} Total</div>
              </div>
            </div>
          </section>

          {/* Controls */}
          <section className="border border-white/30 p-6 bg-black relative">
            <h2 className="text-xl font-bold uppercase mb-6 tracking-tight border-b border-white/20 pb-4">Controls</h2>
            <div className="grid grid-cols-3 gap-4">
              <button 
                onClick={handlePause}
                className="border border-white hover:bg-white hover:text-black text-white py-3 px-4 text-sm font-bold uppercase tracking-wider transition-colors"
              >
                Pause
              </button>
              <button 
                onClick={handleRestart}
                className="border border-white hover:bg-white hover:text-black text-white py-3 px-4 text-sm font-bold uppercase tracking-wider transition-colors"
              >
                Restart
              </button>
              <button 
                onClick={handleEmergencyStop}
                className="bg-white text-black hover:bg-red-600 hover:text-white hover:border-red-600 border border-white py-3 px-4 text-sm font-bold uppercase tracking-wider transition-colors group"
              >
                Emergency <span className="hidden xl:inline">Stop</span>
              </button>
            </div>
            
            {/* Wave Stats */}
            <div className="mt-6 pt-4 border-t border-white/20 grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-xs text-gray-400 uppercase">Active</div>
                <div className="text-2xl font-bold font-mono">{waves.filter(w => w.status === 'active').length}</div>
              </div>
              <div>
                <div className="text-xs text-gray-400 uppercase">Pending</div>
                <div className="text-2xl font-bold font-mono">{pendingWaves}</div>
              </div>
              <div>
                <div className="text-xs text-gray-400 uppercase">Completed</div>
                <div className="text-2xl font-bold font-mono">{doneWaves}</div>
              </div>
            </div>
          </section>
        </div>

        {/* Right Column */}
        <div className="flex flex-col gap-6 md:gap-8 lg:col-span-1">
          
          {/* Data Streams */}
          <section className="border border-white/30 p-6 flex flex-col bg-black relative group hover:border-white/100 transition-colors duration-500">
            <h2 className="text-xl font-bold uppercase mb-6 tracking-tight">Data Streams</h2>
            <div className="space-y-6">
              <div>
                <div className="flex justify-between text-xs font-light uppercase text-gray-400 mb-2">
                  <span>Tokens/sec</span>
                  <span className="text-white font-mono">
                    {status?.tokensUsed?.available
                      ? status.tokensUsed.value ?? 0
                      : "n/a"}
                  </span>
                </div>
                <div className="h-10 w-full flex items-end gap-[2px]">
                  {[20, 30, 25, 40, 50, 45, 60, 55, 70, 65, 80, 75].map((h, i) => (
                    <div key={i} className="w-1/12 bg-white" style={{ height: `${h}%` }}></div>
                  ))}
                </div>
                <div className="w-full h-px bg-white/20 mt-1"></div>
              </div>
              
              <div>
                <div className="flex justify-between text-xs font-light uppercase text-gray-400 mb-2">
                  <span>Uptime</span>
                  <span className="text-white font-mono">
                    {Math.floor((status?.uptimeSeconds ?? 0) / 60)}m
                  </span>
                </div>
                <div className="h-10 w-full relative">
                  <svg className="w-full h-full overflow-visible" preserveAspectRatio="none">
                    <polyline 
                      fill="none" 
                      points="0,40 20,35 40,38 60,30 80,32 100,20 120,25 140,15 160,18 180,10 200,12" 
                      stroke="white" 
                      strokeWidth="1.5" 
                      vectorEffect="non-scaling-stroke"
                    ></polyline>
                  </svg>
                </div>
                <div className="w-full h-px bg-white/20"></div>
              </div>
              
              <div>
                <div className="flex justify-between text-xs font-light uppercase text-gray-400 mb-2">
                  <span>Memory</span>
                  <span className="text-white font-mono">
                    {memoryData ? Math.round(memoryData.heapUsedBytes / 1024 / 1024) : 0}MB
                  </span>
                </div>
                <div className="h-10 w-full relative">
                  <svg className="w-full h-full overflow-visible" preserveAspectRatio="none">
                    <polyline 
                      fill="none" 
                      points="0,35 30,35 60,30 90,20 120,10 150,10 180,5 200,5" 
                      stroke="white" 
                      strokeWidth="1.5" 
                      vectorEffect="non-scaling-stroke"
                    ></polyline>
                    <circle cx="200" cy="5" fill="white" r="2"></circle>
                  </svg>
                </div>
                <div className="w-full h-px bg-white/20"></div>
              </div>
            </div>
          </section>

          {/* Active Agents */}
          <section className="border border-white/30 p-6 flex flex-col flex-grow bg-black relative group hover:border-white/100 transition-colors duration-500">
            <h2 className="text-xl font-bold uppercase mb-6 tracking-tight">Active Waves</h2>
            <ul className="space-y-4 text-sm">
              {waves.slice(0, 5).map((wave, i) => (
                <div key={wave.id}>
                  <li className="flex justify-between items-center group/item cursor-pointer">
                    <div className="flex flex-col">
                      <span className="font-bold text-white uppercase group-hover/item:underline decoration-1 underline-offset-4">
                        Wave #{wave.number}
                      </span>
                      <span className="text-xs text-gray-500 font-mono">{wave.tasks.length} tasks</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs uppercase tracking-wider ${
                        wave.status === 'active' ? 'text-white' : 
                        wave.status === 'pending' ? 'text-gray-400' : 'text-gray-600'
                      }`}>
                        {wave.status.charAt(0).toUpperCase() + wave.status.slice(1)}
                      </span>
                      <div className={`w-2 h-2 ${
                        wave.status === 'active' ? 'bg-white' : 
                        wave.status === 'pending' ? 'border border-white' : 'bg-gray-600'
                      }`}></div>
                    </div>
                  </li>
                  {i < waves.slice(0, 5).length - 1 && <li className="w-full h-px bg-white/10 mt-4"></li>}
                </div>
              ))}
              {waves.length === 0 && (
                <li className="text-gray-500 italic">No waves yet...</li>
              )}
            </ul>
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="fixed bottom-6 right-6 hidden md:block">
        <div className="flex gap-1">
          <div className="w-1 h-1 bg-white"></div>
          <div className="w-1 h-1 bg-white opacity-50"></div>
          <div className="w-1 h-1 bg-white opacity-25"></div>
        </div>
      </footer>
    </div>
  );
}
