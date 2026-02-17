<!-- ╔══════════════════════════════════════════════════════════════════╗ -->
<!-- ║              OUROBOROS RUNTIME — SELF-MODIFYING AGENT            ║ -->
<!-- ╚══════════════════════════════════════════════════════════════════╝ -->

<div align="center">

<!-- ▓▓▓ HEADER ▓▓▓ -->
<img width="100%" src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=0,2,2,30&height=280&section=header&text=OUROBOROS&fontSize=90&fontColor=50fa7b&animation=fadeIn&fontAlignY=35&desc=Self-Modifying%20AI%20Runtime%20%7C%20Isolated%20Python%20Environment%20%7C%20Persistent%20Memory&descAlignY=58&descSize=18&descColor=f1fa8c"/>

<!-- ▓▓▓ TYPING ANIMATION ▓▓▓ -->
<a href="https://github.com/RenyEnnos/ouroboros-runtime">
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=22&duration=3000&pause=1000&color=50FA7B&center=true&vCenter=true&repeat=true&width=620&height=45&lines=%3E+The+snake+eats+its+own+tail.;%3E+Agents+that+write+their+own+code.;%3E+Anti-Vibe+Protocol%3A+Strict+Validation.;%3E+Persistent+Memory.+Parallel+Waves." alt="Typing SVG" />
</a>

<br/>

<!-- ▓▓▓ TECH STACK BADGES ▓▓▓ -->
<img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"/>
<img src="https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white" alt="Bun"/>
<img src="https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python"/>
<img src="https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite"/>
<img src="https://img.shields.io/badge/React_TUI-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React Ink"/>
<img src="https://img.shields.io/badge/Groq_SDK-f55036?style=for-the-badge&logo=probot&logoColor=white" alt="Groq"/>

</div>

<br/>

<!-- ═══════════════════════════════════════════════════════════════════ -->

## <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Animals/Snake.png" width="30"/> &nbsp; The Ouroboros System

> **"A self-modifying agent runtime that evolves through disciplined execution."**

Ouroboros is a multi-agent orchestration system designed to break the cycle of amnesiac AI. It features a **Daemon architecture**, **persistent SQLite memory**, and a strictly isolated **Python playground** where agents can write, test, and execute their own tools safely.

It enforces the **Anti-Vibe Protocol** — a rigorous quality gate system that prevents "vibes-based coding" by requiring specifications, validation, and human promotion before any code becomes permanent.

<br/>

<!-- ═══════════════════════════════════════════════════════════════════ -->

## <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Gear.png" width="30"/> &nbsp; Core Architecture

<table>
<tr>
<td width="50%" valign="top">

### <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Symbols/Radioactive.png" width="22"/> Isolated Python Sandbox
Agents operate in a strict `.ouroboros/venv` environment. They can:
- Write code to `.ouroboros/playground/`
- Execute scripts safely via `SandboxRunner`
- **CANNOT** modify core system files directly
- **MUST** pass human review to promote scripts to `src/`

</td>
<td width="50%" valign="top">

### <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Satellite%20Antenna.png" width="22"/> Gateway Daemon & RPC
A persistent background service (`bun run daemon`) that:
- Maintains agent state across sessions
- Exposes RPC endpoints for tools/extensions
- Coordinates **Wave Execution** (parallel tasks)
- Orchestrates multi-agent handoffs

</td>
</tr>
<tr>
<td width="50%" valign="top">

### <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Floppy%20Disk.png" width="22"/> Persistent Memory
SQLite-based memory system (`better-sqlite3`) with WAL mode.
- Context snapshots
- Structured logs
- Semantic search ready
- **Hexagonal Architecture**: Storage ports & adapters

</td>
<td width="50%" valign="top">

### <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Shield.png" width="22"/> Anti-Vibe Protocol
**Strict Quality Gates:**
1. **Spec Phase**: Design before code.
2. **Validation**: Gate blocks execution without spec.
3. **Implementation**: 2-stage (Review → Generate).
4. **Verification**: Tests + Human Approval.

</td>
</tr>
</table>

<br/>

<!-- ═══════════════════════════════════════════════════════════════════ -->

## <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Laptop.png" width="30"/> &nbsp; TUI Interface

Powered by **React Ink**, the Ouroboros TUI provides real-time visualization of the agent's thought process.

```bash
bun run tui
```

- **Emerald Theme**: Success & Stability
- **Wave Visualization**: See parallel tasks executing
- **Intent Classification**: Real-time concierge status
- **System Health**: Daemon & Memory metrics

<br/>

<!-- ═══════════════════════════════════════════════════════════════════ -->

## <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Hammer%20and%20Wrench.png" width="30"/> &nbsp; Installation & Setup

### Prerequisites
- **Bun** (Latest)
- **Python 3.10+** (for isolated venv)
- **Node.js 20+**

### Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Run the Setup Wizard (Creates .ouroboros env)
bun run setup

# 3. Start the Daemon (Background Service)
bun run daemon

# 4. Launch the TUI (Terminal Interface)
bun run tui
```

<br/>

<!-- ═══════════════════════════════════════════════════════════════════ -->

## <img src="https://raw.githubusercontent.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis/master/Emojis/Objects/Japanese%20Dolls.png" width="30"/> &nbsp; The Council (Agents)

The system is composed of specialized agents:

- **🐍 Ouroboros (Core)**: The runtime orchestrator.
- **👁️ Vision**: Multi-modal analysis.
- **🧠 Architect**: System design & spec generation.
- **🛡️ Guardian**: Anti-Vibe protocol enforcement.
- **⚡ Kinetic**: Wave execution & task running.

<br/>

<!-- ═══════════════════════════════════════════════════════════════════ -->

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=0,2,2,30&height=120&section=footer"/>

</div>
