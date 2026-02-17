import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "xterm/css/xterm.css";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Maximize2, Minimize2, X } from "lucide-react";

interface TerminalProps {
  id: string;
  title?: string;
  onClose?: () => void;
  onMaximize?: () => void;
  isMaximized?: boolean;
  wsUrl?: string;
}

export function Terminal({
  id,
  title = `Terminal ${id}`,
  onClose,
  onMaximize,
  isMaximized = false,
  wsUrl,
}: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Initialize terminal
  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new XTerm({
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 14,
      theme: {
        background: "#0F172A",
        foreground: "#F8FAFC",
        cursor: "#10B981",
        selectionBackground: "#334155",
        black: "#0F172A",
        red: "#EF4444",
        green: "#10B981",
        yellow: "#F59E0B",
        blue: "#3B82F6",
        magenta: "#A855F7",
        cyan: "#06B6D4",
        white: "#F8FAFC",
        brightBlack: "#334155",
        brightRed: "#F87171",
        brightGreen: "#34D399",
        brightYellow: "#FBBF24",
        brightBlue: "#60A5FA",
        brightMagenta: "#C084FC",
        brightCyan: "#22D3EE",
        brightWhite: "#FFFFFF",
      },
      cursorBlink: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Try to load WebGL addon for better performance
    try {
      const webglAddon = new WebglAddon();
      term.loadAddon(webglAddon);
    } catch {
      // WebGL not supported, fallback to canvas
    }

    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Welcome message
    term.writeln("\x1b[1;32m🐍 Ouroboros Terminal\x1b[0m");
    term.writeln("\x1b[90mConnected to daemon\x1b[0m");
    term.writeln("");

    // Handle input
    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Handle resize
    const handleResize = () => {
      fitAddon.fit();
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const { cols, rows } = term;
        wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      term.dispose();
      xtermRef.current = null;
    };
  }, [id]);

  // Connect to WebSocket
  useEffect(() => {
    if (!wsUrl) return;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      xtermRef.current?.writeln("\x1b[32m✓ Connected to session\x1b[0m");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "output" && xtermRef.current) {
          xtermRef.current.write(data.data);
        }
      } catch {
        // Raw output
        if (xtermRef.current) {
          xtermRef.current.write(event.data);
        }
      }
    };

    ws.onclose = () => {
      xtermRef.current?.writeln("\x1b[31m✗ Disconnected\x1b[0m");
    };

    ws.onerror = () => {
      xtermRef.current?.writeln("\x1b[31m✗ Connection error\x1b[0m");
    };

    return () => {
      ws.close();
    };
  }, [wsUrl]);

  const focusTerminal = useCallback(() => {
    xtermRef.current?.focus();
  }, []);

  return (
    <Card className="flex flex-col bg-[var(--surface-primary)] border-[var(--border)] overflow-hidden h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--surface-secondary)] border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <span className="text-emerald">$</span>
          <span className="font-mono text-sm">{title}</span>
          <Badge variant="emerald" className="text-[10px]">● Live</Badge>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onMaximize}
            className="p-1 rounded hover:bg-[var(--surface-tertiary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-ruby/20 text-[var(--muted-foreground)] hover:text-ruby transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Terminal */}
      <div
        ref={terminalRef}
        className="flex-1 p-2"
        onClick={focusTerminal}
      />
    </Card>
  );
}