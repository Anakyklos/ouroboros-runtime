# 🧠 Ouroboros Agent Patterns - Quick Reference

> Síntese dos principais padrões extraídos das skills analisadas do repositório awesome-skills

---

## 1. Agent Loop Pattern (Core)

```
┌─────────────────────────────────────────────────────────┐
│                     AGENT LOOP                          │
│                                                         │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐         │
│   │  THINK   │───▶│  DECIDE  │───▶│   ACT    │         │
│   │ (LLM)    │    │ (Tools?) │    │ (Execute)│         │
│   └──────────┘    └──────────┘    └──────────┘         │
│        ▲                                │               │
│        │          ┌──────────┐          │               │
│        └──────────│ OBSERVE  │◀─────────┘               │
│                   │ (Result) │                          │
│                   └──────────┘                          │
└─────────────────────────────────────────────────────────┘
```

**Python Reference:**
```python
class AgentLoop:
    def run(self, task: str) -> str:
        self.history.append({"role": "user", "content": task})
        for i in range(self.max_iterations):
            response = self.llm.chat(
                messages=self.history,
                tools=self._format_tools(),
                tool_choice="auto"
            )
            if response.tool_calls:
                for tool_call in response.tool_calls:
                    result = self._execute_tool(tool_call)
                    self.history.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": str(result)
                    })
            else:
                return response.content
        return "Max iterations reached"
```

---

## 2. Multi-Agent Architecture Patterns

### Pattern A: Supervisor/Orchestrator
```
User Query → Supervisor → [Specialist₁, Specialist₂, Specialist₃] → Aggregation → Output
```
**Use when:** Clear task decomposition, need for aggregation
**Pitfalls:** Supervisor bottleneck, "Telephone Game" problem

### Pattern B: Peer-to-Peer/Swarm
```
Agent₁ ←→ Agent₂ ←→ Agent₃
   ↑__________|__________↓
```
**Use when:** Collaborative refinement, consensus needed
**Pitfalls:** Coordination overhead, divergence

### Pattern C: Hierarchical
```
      Manager
    /    |    \
  Lead  Lead  Lead
  / \    |    / \
 W   W   W   W   W
```
**Use when:** Complex domains, scalability needed
**Pitfalls:** Communication latency, context fragmentation

---

## 3. Subagent-Driven Development (Two-Stage Review)

```
┌─────────────────────────────────────────────────────────┐
│              SUBAGENT DEVELOPMENT FLOW                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [1] Extract all tasks with full text from plan         │
│                     │                                   │
│                     ▼                                   │
│  [2] Dispatch IMPLEMENTER subagent ──────┐              │
│         │                                 │             │
│         ▼                                 │             │
│     Questions? ─── yes ───▶ Answer & Loop │             │
│         │                                 │             │
│        no                                 │             │
│         ▼                                 │             │
│  [3] Implement + Test + Commit            │             │
│         │                                 │             │
│         ▼                                 │             │
│  [4] Dispatch SPEC REVIEWER               │             │
│         │                                 │             │
│    Compliant? ─── no ───▶ Fix & Re-review │             │
│         │                                 │             │
│        yes                                │             │
│         ▼                                 │             │
│  [5] Dispatch CODE QUALITY REVIEWER       │             │
│         │                                 │             │
│    Approved? ─── no ───▶ Fix & Re-review  │             │
│         │                                 │             │
│        yes                                │             │
│         ▼                                 │             │
│  [6] Mark task complete                   │             │
│         │                                 │             │
│     More tasks? ─── yes ───▶ Loop to [2]  │             │
│         │                                 │             │
│        no                                 │             │
│         ▼                                 │             │
│  [7] Final code review + finish branch    │             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Key Principles:**
- Fresh subagent per task = no context pollution
- Never skip reviews
- Spec compliance BEFORE code quality review

---

## 4. Permission System

```python
class PermissionLevel(Enum):
    AUTO = "auto"           # Execute without asking
    ASK_ONCE = "ask_once"   # Ask once per session
    ASK_EACH = "ask_each"   # Ask every time
    NEVER = "never"         # Block entirely

PERMISSION_CONFIG = {
    "read_file": PermissionLevel.AUTO,
    "write_file": PermissionLevel.ASK_ONCE,
    "run_command": PermissionLevel.ASK_EACH,
    "sudo_command": PermissionLevel.NEVER,
    "delete_file": PermissionLevel.ASK_EACH,
    "network_request": PermissionLevel.ASK_ONCE
}
```

---

## 5. Sandboxed Execution

```python
def execute_sandboxed(command: str, workspace: str) -> ToolResult:
    ALLOWED_COMMANDS = ["ls", "cat", "grep", "node", "npm", "python"]
    
    if not validate_command(command, ALLOWED_COMMANDS):
        return ToolResult(success=False, error=f"Command not allowed: {command}")
    
    result = subprocess.run(
        command,
        shell=True,
        cwd=workspace,
        capture_output=True,
        timeout=30,
        env={**os.environ, "HOME": workspace}
    )
    return ToolResult(
        success=result.returncode == 0,
        output=result.stdout.decode(),
        error=result.stderr.decode() if result.returncode != 0 else None
    )
```

---

## 6. Memory Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│                  MEMORY SPECTRUM                        │
├────────────┬────────────────────────────┬───────────────┤
│   LAYER    │      CHARACTERISTICS       │   EXAMPLES    │
├────────────┼────────────────────────────┼───────────────┤
│  WORKING   │ Zero latency, volatile     │ Context window│
│  (L1)      │ Active processing          │ Current task  │
├────────────┼────────────────────────────┼───────────────┤
│ SHORT-TERM │ Session-persistent         │ Session cache │
│  (L2)      │ Searchable, volatile       │ Task progress │
├────────────┼────────────────────────────┼───────────────┤
│ LONG-TERM  │ Cross-session persistent   │ User prefs    │
│  (L3)      │ Structured, semi-permanent │ Domain KB     │
├────────────┼────────────────────────────┼───────────────┤
│  ENTITY    │ Entity identity tracking   │ Knowledge     │
│  (L4)      │ Relationships, properties  │ graph nodes   │
├────────────┼────────────────────────────┼───────────────┤
│ TEMPORAL   │ Validity periods           │ Time-travel   │
│  (L5)      │ Time-aware queries         │ queries       │
└────────────┴────────────────────────────┴───────────────┘
```

---

## 7. Tool Design Best Practices (MCP)

### Tool Schema Pattern
```python
def tool_schema(name: str, description: str, params: dict) -> dict:
    return {
        "name": name,
        "description": description,  # MUST be task-oriented!
        "parameters": {
            "type": "object",
            "properties": params,
            "required": list(params.keys())
        }
    }
```

### Description Guidelines
```
❌ BAD: "Gets issues from GitHub"
✅ GOOD: "Find open issues assigned to me sorted by priority"

❌ BAD: "Runs SQL query"
✅ GOOD: "Query database for customer records matching criteria"
```

### Output Patterns
```python
# Return original + processed
return {
    "original": raw_data,      # Raw API response
    "summary": summarize(raw_data),  # For context efficiency
    "next_steps": suggest_actions(raw_data)  # Actionable hints
}
```

---

## 8. Parallel Agent Dispatching

### Decision Tree
```
┌──────────────────────────────────────────────────────────┐
│           WHEN TO USE PARALLEL AGENTS                    │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Are failures independent? ─── no ───▶ Sequential        │
│         │                                                │
│        yes                                               │
│         ▼                                                │
│  Can you define clear domains? ─── no ───▶ Sequential    │
│         │                                                │
│        yes                                               │
│         ▼                                                │
│  Are there 2+ independent problems? ─── no ───▶ Single   │
│         │                                                │
│        yes                                               │
│         ▼                                                │
│  ✅ USE PARALLEL AGENTS                                  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Agent Prompt Structure
```markdown
# Task: [One-sentence description]

## Context
- [Relevant background only]
- [Files to focus on]

## Your Scope
ONLY investigate/modify:
- [Specific file or module]
- [Specific function or component]

DO NOT:
- [What to avoid]
- [Other areas to stay out of]

## Success Criteria
- [How to know you're done]
```

---

## 9. Context Window Optimization

### Serial Position Effect
```
┌─────────────────────────────────────────────────────────┐
│              ATTENTION DISTRIBUTION                      │
│                                                          │
│  █████████  ░░░░░░░░░░░░░░░░░░░░░░░░░  █████████        │
│   START              MIDDLE               END            │
│  (recency)      (lost in middle)       (primacy)        │
│                                                          │
│  STRATEGY: Put critical info at START and END           │
└─────────────────────────────────────────────────────────┘
```

### Tiered Context Strategy
```
Tier 1: System prompt (always present)
Tier 2: Project rules (load on init)
Tier 3: Current task context (dynamic)
Tier 4: Retrieved knowledge (just-in-time)
```

---

## 10. Checkpoint/Resume Pattern

```python
def save_checkpoint(session_id: str, state: dict) -> str:
    checkpoint = {
        "timestamp": datetime.now().isoformat(),
        "session_id": session_id,
        "history": state["history"],
        "context": state["context"],
        "workspace_state": capture_git_status(state["workspace"]),
        "metadata": state.get("metadata", {})
    }
    path = f"./checkpoints/{session_id}.json"
    with open(path, 'w') as f:
        json.dump(checkpoint, f, indent=2)
    return path

def restore_checkpoint(session_id: str) -> dict:
    with open(f"./checkpoints/{session_id}.json") as f:
        return json.load(f)
```

---

## 🎯 Quick Decision Guide

| Situation | Pattern to Use |
|-----------|----------------|
| Need task decomposition | Supervisor/Orchestrator |
| Need consensus | Peer-to-Peer/Swarm |
| Complex hierarchy | Hierarchical |
| Independent problems | Parallel Agents |
| Sequential dependent tasks | Single Agent Loop |
| Long-running session | Checkpoint/Resume |
| Needs human approval | Permission System |
| Untrusted code execution | Sandboxed Execution |
| Cross-session learning | Memory Layers 3-5 |

---

## 📚 Source Skills

- `multi-agent-patterns` - Arquiteturas multi-agent
- `autonomous-agent-patterns` - Agent loop, permissions, sandbox
- `subagent-driven-development` - Two-stage review workflow
- `dispatching-parallel-agents` - Parallel execution
- `mcp-builder` - Tool design best practices
- `memory-systems` - Memory architecture
- `context-window-management` - Context optimization
