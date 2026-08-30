# Local Inference Layer

> Camada de inferência local com três modelos especializados para operação agentic sem dependência de APIs pagas.

## Visão Geral

O ouroboros-runtime agora inclui uma camada de inferência local que opera inteiramente no hardware do desenvolvedor, usando modelos pequenos e especializados via [Ollama](https://ollama.ai).

### Três Modelos, Três Papéis

| Modelo | Papel | Tarefas |
|--------|-------|---------|
| **FunctionGemma** (gemma3:1b) | Policy | Seleção de ação, roteamento de tools, classificação de intenção, sumarização de estado |
| **Qwen2.5-Coder** (0.5B) | Coder | Geração de patches, correção de testes, refatoração local |
| **EmbeddingGemma** (all-minilm:33m) | Embedding | Embeddings locais, busca semântica, cache semântico, clustering de traces |

### Princípios

- **Runtime soberano**: modelos sugerem, runtime valida
- **Execução local**: zero dependência de APIs pagas
- **CPU-first**: otimizado para i5 + 32GB RAM, sem GPU
- **Isolamento**: camada nova, sem modificar módulos estáveis
- **Saídas estruturadas**: toda saída validada por Zod

## Instalação

### 1. Instalar Ollama

```bash
curl -fsSL https://ollama.ai/install.sh | sh
```

### 2. Baixar os modelos

```bash
ollama pull gemma3:1b          # Policy model (~700MB)
ollama pull qwen2.5-coder:0.5b # Code model (~400MB)
ollama pull all-minilm:33m     # Embedding model (~70MB)
```

### 3. Verificar

```bash
ollama list  # Deve mostrar os 3 modelos
```

## Configuração

Via variáveis de ambiente:

```env
OLLAMA_BASE_URL=http://localhost:11434
INFERENCE_TIMEOUT_MS=60000
INFERENCE_MAX_RETRIES=3
INFERENCE_RETRY_DELAY_MS=1000
INFERENCE_LOG_REQUESTS=true
INFERENCE_COLLECT_METRICS=true
INFERENCE_TRACE_DIR=.agent/traces

# Override de modelos
POLICY_MODEL=gemma3:1b
CODER_MODEL=qwen2.5-coder:0.5b
EMBEDDING_MODEL=all-minilm:33m
```

## Arquitetura

```
cli/src/inference/
├── index.ts                    # Barrel export
├── inference-config.ts         # Configuração + system prompts
├── LocalInferenceProvider.ts   # Backend Ollama (HTTP API)
├── ModelRegistry.ts            # Registro declarativo de modelos
├── ModelRouter.ts              # Roteamento determinístico + circuit breaker
├── PolicyEngine.ts             # FunctionGemma: decisão operacional
├── CodeWorker.ts               # Qwen2.5-Coder: geração de patches
├── EmbeddingEngine.ts          # EmbeddingGemma: embeddings locais
├── MemoryIndexer.ts            # Indexação semântica (JSONL)
├── SemanticRetriever.ts        # Busca semântica com política
├── SemanticCache.ts            # Cache de queries similares
├── TraceEmbedder.ts            # Análise de padrões em traces
├── RetrievalPolicy.ts          # Regras de ingestão/retrieval
├── InferenceGuardrails.ts      # Segurança obrigatória
├── DatasetPipeline.ts          # Export JSONL para fine-tuning
├── LocalBenchmark.ts           # Benchmark de latência/qualidade
├── schemas/
│   └── inference-schemas.ts    # 12 schemas Zod
└── types/
    └── inference-types.ts      # Types compartilhados
```

### Fluxo de Decisão

```
Tarefa → ModelRouter → Modelo (Policy/Coder/Embedding)
                         ↓
                    Ollama HTTP API
                         ↓
                    Resposta JSON
                         ↓
                  Validação Zod + Guardrails
                         ↓
                   Runtime valida e executa
```

### Circuit Breaker

O `ModelRouter` implementa circuit breaker: após 3 falhas consecutivas de um modelo, roteia automaticamente para o fallback (policy ↔ coder). Embeddings não têm fallback.

## Testes

```bash
# Testes unitários e integração (não requerem Ollama)
bun test cli/src/inference/__tests__/

# Todos os testes do projeto
bun test
```

## Limitações

- Modelos pequenos: limitados a tarefas bem definidas e curtas
- Latência: 1-5s por chamada em CPU (varia por hardware)
- JSON: taxa de JSON válido depende do modelo e prompt
- Embedding: dimensão fixa (384), não comparável com modelos maiores
- Sem GPU: performance otimizada mas limitada a CPU

---
> **Status: Legacy/experimental** — Classificado em [docs/LEGACY_MATRIX.md](LEGACY_MATRIX.md)
> (item 13, local inference: ADAPT/DEFER — planner backend opcional, não é
> identidade do produto). Provider/modelo não define roadmap do core (#60).
> Ver [docs/ARCHITECTURE.md](ARCHITECTURE.md).
