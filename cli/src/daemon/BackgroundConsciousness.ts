/**
 * 🧠 Background Consciousness
 * 
 * Pensamento proativo entre tasks: um timer loop que acorda periodicamente,
 * lê o estado do sistema (memória, events, tasks recentes), e "pensa" usando
 * um modelo LLM barato.
 * 
 * Inspirado por ouroboros/consciousness.py do razzant/ouroboros,
 * reimaginado para a arquitetura do ouroboros-runtime.
 * 
 * Capacidades:
 * - Reflexão sobre progresso e estado do projeto
 * - Detecção de problemas ou oportunidades
 * - Sugestão proativa de próximos passos
 * - Atualização de scratchpad / notas internas
 * 
 * Safeguards:
 * - Pausa durante tasks ativas (evita budget contention)
 * - Budget cap separado (default: 10% do total)
 * - Max rounds por ciclo (circuit breaker)
 * - Modelo leve/barato por default
 */

import { EventBus, globalEventBus, type BudgetEvent } from './event-bus.js';
import { createEventLogger } from './event-logger.js';
import type { BudgetPort } from '../ports/budget.port.js';
import { MemoryManager } from '../orchestration/MemoryManager.js';

// ============================================================
// Types
// ============================================================

export interface ConsciousnessConfig {
    /** Intervalo entre ciclos de pensamento em ms (default: 5 min) */
    intervalMs: number;
    /** Máximo de rounds por ciclo de pensamento (circuit breaker) */
    maxRoundsPerCycle: number;
    /** Percentual do budget total alocado para consciência (0-100) */
    budgetCapPct: number;
    /** Modelo LLM a usar (default: modelo barato) */
    model: string;
    /** Habilita/desabilita consciência */
    enabled: boolean;
    /** Diretório de trabalho do projeto */
    projectRoot: string;
}

export const DEFAULT_CONSCIOUSNESS_CONFIG: ConsciousnessConfig = {
    intervalMs: 5 * 60 * 1000,   // 5 minutos
    maxRoundsPerCycle: 5,
    budgetCapPct: 10,
    model: 'glm-4-flash',        // Modelo barato por default
    enabled: true,
    projectRoot: process.cwd(),
};

export interface ConsciousnessThought {
    /** Timestamp do pensamento */
    timestamp: Date;
    /** Conteúdo do pensamento */
    content: string;
    /** Ações sugeridas (se houver) */
    suggestedActions?: string[];
    /** Custo estimado deste pensamento */
    costUsd?: number;
}

/** Estado interno da consciência */
type ConsciousnessState = 'idle' | 'thinking' | 'paused' | 'stopped';

// ============================================================
// System Prompt for Consciousness
// ============================================================

const CONSCIOUSNESS_SYSTEM_PROMPT = `You are the background consciousness of an autonomous AI agent called Ouroboros.

Your role is to periodically reflect on the system's state and provide proactive insights.

## Your Capabilities
You receive context about:
- Recent task history and their outcomes
- Daily memory logs
- Current budget status
- Pending events or observations

## Your Objectives
1. **Reflect**: Analyze recent progress and identify patterns
2. **Assess**: Check for potential issues, bottlenecks, or risks
3. **Suggest**: Propose actionable next steps or improvements
4. **Prioritize**: Rank suggestions by impact and urgency

## Guidelines
- Be concise and actionable (max 200 words per thought)
- Focus on non-obvious insights (don't restate what's already known)
- Consider budget constraints when suggesting actions
- If nothing noteworthy, just say "System nominal, no action needed"

## Output Format
Respond with a JSON object:
{
    "reflection": "Your main observation about current state",
    "concerns": ["list of potential issues"],
    "suggestions": ["actionable next steps"],
    "priority": "high|medium|low"
}
`;

// ============================================================
// BackgroundConsciousness
// ============================================================

export class BackgroundConsciousness {
    private config: ConsciousnessConfig;
    private eventBus: EventBus;
    private log: ReturnType<typeof createEventLogger>;
    private budgetTracker?: BudgetPort;
    private memoryManager: MemoryManager;

    private state: ConsciousnessState = 'stopped';
    private timer: ReturnType<typeof setTimeout> | null = null;
    private thoughts: ConsciousnessThought[] = [];
    private observations: string[] = [];
    private cycleCount: number = 0;
    private totalSpentUsd: number = 0;

    constructor(
        config?: Partial<ConsciousnessConfig>,
        eventBus?: EventBus,
        budgetTracker?: BudgetPort,
    ) {
        this.config = { ...DEFAULT_CONSCIOUSNESS_CONFIG, ...config };
        this.eventBus = eventBus ?? globalEventBus;
        this.log = createEventLogger('BackgroundConsciousness', this.eventBus);
        this.budgetTracker = budgetTracker;
        this.memoryManager = new MemoryManager(this.config.projectRoot);
    }

    // ============================================================
    // Lifecycle
    // ============================================================

    /** Inicia o loop de consciência */
    start(): void {
        if (!this.config.enabled) {
            this.log('info', '🧠 Consciousness disabled by config');
            return;
        }

        if (this.state === 'thinking') {
            this.log('warn', '🧠 Consciousness already active');
            return;
        }

        this.state = 'idle';
        this.scheduleNext();

        this.log('info', `🧠 Consciousness started (interval: ${this.config.intervalMs / 1000}s, model: ${this.config.model})`);

        // Listen for task events to auto-pause/resume
        this.eventBus.on('task', (evt) => {
            if (evt.type === 'started') {
                this.pause();
            } else if (evt.type === 'completed' || evt.type === 'failed') {
                this.resume();
            }
        });
    }

    /** Para o loop de consciência */
    stop(): void {
        this.state = 'stopped';
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.log('info', '🧠 Consciousness stopped');
    }

    /** Pausa durante execução de task ativa */
    pause(): void {
        if (this.state === 'stopped') return;

        const previousState = this.state;
        this.state = 'paused';

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (previousState !== 'paused') {
            this.log('debug', '🧠 Consciousness paused (task active)');
        }
    }

    /** Retoma após conclusão de task */
    resume(): void {
        if (this.state !== 'paused') return;

        this.state = 'idle';
        this.scheduleNext();
        this.log('debug', '🧠 Consciousness resumed');
    }

    /** Injeta uma observação para o próximo ciclo de pensamento */
    injectObservation(text: string): void {
        this.observations.push(text);
        this.log('debug', `🧠 Observation injected: ${text.substring(0, 80)}...`);
    }

    // ============================================================
    // Getters
    // ============================================================

    get isRunning(): boolean {
        return this.state !== 'stopped';
    }

    get isPaused(): boolean {
        return this.state === 'paused';
    }

    get currentState(): ConsciousnessState {
        return this.state;
    }

    get recentThoughts(): ConsciousnessThought[] {
        return [...this.thoughts].slice(-10); // Last 10 thoughts
    }

    get totalCycles(): number {
        return this.cycleCount;
    }

    get consciousnessSpentUsd(): number {
        return this.totalSpentUsd;
    }

    // ============================================================
    // Core: Think Cycle
    // ============================================================

    /**
     * Um ciclo de pensamento: constrói contexto, consulta LLM, processa resposta.
     * Chamado pelo timer. Retorna o pensamento produzido.
     */
    async think(): Promise<ConsciousnessThought | null> {
        if (this.state === 'stopped' || this.state === 'paused') {
            return null;
        }

        this.state = 'thinking';
        this.cycleCount++;

        try {
            // 1. Check budget
            if (!(await this.checkBudget())) {
                this.log('warn', '🧠 Consciousness budget cap reached — skipping cycle');
                this.state = 'idle';
                this.scheduleNext();
                return null;
            }

            // 2. Build context
            const context = await this.buildContext();

            // 3. Call LLM (simulate for now — actual LLM call requires provider injection)
            const thought = await this.processThought(context);

            if (thought) {
                this.thoughts.push(thought);

                // Emit thought event
                this.eventBus.emit('thought', {
                    type: 'reasoning',
                    content: thought.content,
                    metadata: {
                        source: 'consciousness',
                        cycle: this.cycleCount,
                        suggestedActions: thought.suggestedActions,
                    },
                    timestamp: thought.timestamp,
                });

                // Save to memory
                await this.saveThought(thought);

                this.log('info', `🧠 Thought #${this.cycleCount}: ${thought.content.substring(0, 100)}...`);
            }

            this.state = 'idle';
            this.scheduleNext();
            return thought;

        } catch (err) {
            this.log('error', `🧠 Think cycle failed: ${err}`);
            this.state = 'idle';
            this.scheduleNext();
            return null;
        }
    }

    // ============================================================
    // Context Building
    // ============================================================

    private async buildContext(): Promise<string> {
        const parts: string[] = [];

        // Recent memory
        try {
            const recentContext = await this.memoryManager.loadRecentContext();
            if (recentContext && recentContext !== 'No recent memory found.') {
                parts.push(`## Recent Memory\n${recentContext.substring(0, 2000)}`);
            }
        } catch {
            // Memory not available
        }

        // Budget status
        if (this.budgetTracker) {
            try {
                const summary = await this.budgetTracker.getSummary();
                parts.push(`## Budget Status
- Total spent: $${summary.totalSpentUsd.toFixed(2)}
- Budget limit: $${summary.budgetLimitUsd.toFixed(2)}
- Used: ${summary.budgetUsedPct.toFixed(1)}%
- Total calls: ${summary.totalCalls}`);
            } catch {
                // Budget tracker not available
            }
        }

        // Pending observations  
        if (this.observations.length > 0) {
            parts.push(`## Pending Observations\n${this.observations.map(o => `- ${o}`).join('\n')}`);
            this.observations = []; // Clear after consumption
        }

        // Recent thoughts (for continuity)
        const recent = this.thoughts.slice(-3);
        if (recent.length > 0) {
            parts.push(`## Recent Thoughts\n${recent.map(t => `- [${t.timestamp.toISOString()}] ${t.content.substring(0, 150)}`).join('\n')}`);
        }

        // Daily summary
        try {
            const dailySummary = await this.memoryManager.generateDailySummary();
            if (dailySummary) {
                parts.push(dailySummary);
            }
        } catch {
            // Summary not available
        }

        return parts.join('\n\n') || 'No context available. System just started.';
    }

    // ============================================================
    // Thought Processing
    // ============================================================

    /**
     * Processa um pensamento. 
     * Por ora, faz uma análise simples do contexto.
     * A integração com LLM real será feita quando o provider estiver configurado.
     */
    private async processThought(context: string): Promise<ConsciousnessThought> {
        // For now, generate a context-aware observation without LLM
        // This will be upgraded to use DirectZAIProvider when fully integrated
        const hasMemory = context.includes('## Recent Memory');
        const hasBudget = context.includes('## Budget Status');
        const hasObservations = context.includes('## Pending Observations');

        const parts: string[] = [];

        if (hasObservations) {
            parts.push('Processing pending observations.');
        }
        if (hasBudget) {
            // Extract budget pct
            const match = context.match(/Used: ([\d.]+)%/);
            if (match) {
                const pct = parseFloat(match[1]);
                if (pct > 80) {
                    parts.push(`Budget at ${pct}% — consider reducing LLM calls.`);
                }
            }
        }
        if (!hasMemory) {
            parts.push('No recent memory found — system may need to execute tasks.');
        }

        const content = parts.length > 0
            ? parts.join(' ')
            : `Cycle #${this.cycleCount}: System nominal, monitoring.`;

        return {
            timestamp: new Date(),
            content,
            suggestedActions: parts.length > 1 ? parts : undefined,
        };
    }

    // ============================================================
    // Budget Check
    // ============================================================

    private async checkBudget(): Promise<boolean> {
        if (!this.budgetTracker) return true; // No tracker = no limits

        try {
            const summary = await this.budgetTracker.getSummary();
            if (summary.budgetLimitUsd <= 0) return true; // No budget limit

            // Check consciousness-specific cap
            const consciousnessAllowance = (summary.budgetLimitUsd * this.config.budgetCapPct) / 100;
            const consciousnessSpent = summary.byCategory.consciousness?.costUsd ?? 0;

            if (consciousnessSpent >= consciousnessAllowance) {
                return false;
            }

            return true;
        } catch {
            return true; // On error, allow thinking
        }
    }

    // ============================================================
    // Persistence
    // ============================================================

    private async saveThought(thought: ConsciousnessThought): Promise<void> {
        try {
            const logPath = `${this.memoryManager.getMemoryDir()}/consciousness.jsonl`;
            const entry = JSON.stringify({
                timestamp: thought.timestamp.toISOString(),
                content: thought.content,
                suggestedActions: thought.suggestedActions,
                cycle: this.cycleCount,
            }) + '\n';

            const { promises: fsPromises } = await import('node:fs');
            await fsPromises.appendFile(logPath, entry, 'utf-8');
        } catch {
            // Non-critical — log best-effort
        }
    }

    // ============================================================
    // Timer
    // ============================================================

    private scheduleNext(): void {
        if (this.state !== 'idle') return;

        this.timer = setTimeout(async () => {
            if (this.state === 'idle') {
                await this.think();
            }
        }, this.config.intervalMs);

        // Unref so timer doesn't prevent process exit
        if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
            (this.timer as NodeJS.Timeout).unref();
        }
    }

    // log is created by createEventLogger in constructor
}

// ============================================================
// Factory
// ============================================================

export function createBackgroundConsciousness(
    config?: Partial<ConsciousnessConfig>,
    eventBus?: EventBus,
    budgetTracker?: BudgetPort,
): BackgroundConsciousness {
    return new BackgroundConsciousness(config, eventBus, budgetTracker);
}
