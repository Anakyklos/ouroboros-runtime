# ADR-0042 — NVIDIA NIM como provider BYOK para execução restrita

- **Status:** Proposed
- **Date:** 2026-07-11
- **Decision owners:** Pedro / Ouroboros maintainers
- **Research:** `docs/research/nvidia-nim-provider-evaluation-2026-07-11.md`
- **Related:** #42, #34, #36

## Context

O Ouroboros não busca ser o agente mais rápido. Seu objetivo é permanecer útil em condições adversas: pouca quota, hardware modesto, providers gratuitos, interrupções, indisponibilidade e orçamento baixo.

A NVIDIA Build/NIM oferece um catálogo amplo de modelos sob chaves gratuitas de desenvolvimento. O limite padrão operacional observado para essas chaves em 2026 é 40 RPM. Esse teto é baixo para workflows multiagentes paralelos, mas é suficiente para um runtime que serialize chamadas, persista estado, espere quota e continue durante longos períodos.

A arquitetura pretendida é BYOK: cada usuário fornece sua própria chave. O Ouroboros não distribui nem compartilha uma chave central do mantenedor. Portanto, quotas, cooldowns, circuit breakers e métricas precisam ser isolados por credencial do usuário.

O runtime atual possui integrações paralelas para Groq, Z.AI, Gemini, Antigravity e Ollama, sem contrato remoto único nem scheduler durável orientado por quota.

## Decision

O Ouroboros adotará NVIDIA NIM como **provider opcional BYOK**, inicialmente experimental e desligado até que suas dependências sejam implementadas e verificadas.

A decisão segue estas regras:

1. Cada usuário ou workspace fornece sua própria `NVIDIA_API_KEY`.
2. Nenhuma chave do mantenedor será compartilhada, embutida ou usada como quota comum.
3. A chave bruta não será escrita em repositório, fila, SQLite, logs, eventos, traces ou métricas.
4. A configuração referenciará uma `credentialRef` e um `credentialScope` opaco.
5. O perfil gratuito NVIDIA usará 40 RPM como baseline conservador por credencial.
6. A cadência nominal será 36 RPM, preservando margem para variação de janela e overhead.
7. O modo restrito usará `maxConcurrency = 1` por credencial por padrão.
8. `429` e `Retry-After` prevalecem sobre o default e atualizam o cooldown persistido.
9. Espera por quota será estado normal da tarefa, não falha terminal.
10. O scheduler persistirá checkpoints, tentativas, `nextEligibleAt` e próxima ação.
11. Reiniciar o daemon não apagará fila, cooldown ou progresso validado.
12. Capacidades serão declaradas por `provider + model`; compatibilidade OpenAI não implicará tools ou JSON Schema.
13. O usuário poderá escolher NVIDIA como provider disponível, sem torná-la provider universal ou obrigatório.
14. Tarefas sensíveis continuarão sujeitas aos termos e à política de dados do endpoint escolhido.
15. Produção comercial com garantias exigirá decisão separada sobre licença, custo, região, retenção e SLA.

## Product priority

A prioridade arquitetural é:

```text
continuidade > aproveitamento da quota > qualidade verificável > latência
```

O sistema pode levar horas ou dias para completar uma tarefa. Isso é aceitável quando há:

- progresso persistido;
- pausa e retomada;
- motivo de espera observável;
- deduplicação;
- orçamento finito;
- validação antes de promoção;
- cancelamento controlado.

## Credential and quota scope

O limiter superior será chaveado por:

```text
providerId + credentialScope
```

Buckets subordinados podem usar:

```text
providerId + credentialScope + modelId + operation
```

Para o perfil `nvidia-free`, o bucket superior começa com:

```text
limit: 40 requests
window: 60 seconds
nominalTarget: 36 requests/minute
maxConcurrency: 1
burst: 1
```

O valor é configurável. Não é autorização para ignorar headers, `429` ou mudanças futuras.

`credentialScope` não contém a chave. Deve ser um identificador opaco, preferencialmente derivado por hash com salt local, usado apenas para isolamento de estado e métricas.

## Durable constrained execution

A fila/scheduler precisa suportar:

- `pending`
- `ready`
- `running`
- `waiting_for_quota`
- `waiting_for_provider`
- `waiting_for_budget`
- `waiting_for_human`
- `completed`
- `failed_terminal`
- `cancelled`

Cada passo persiste:

- `taskId` e `stepId`;
- provider e modelo selecionados;
- `credentialScope` opaco;
- tentativas e último erro tipado;
- `nextEligibleAt`;
- checkpoint validado;
- próxima ação;
- orçamento restante.

Timeout de request não encerra automaticamente a tarefa inteira. A política pode reagendar o passo, usar fallback permitido ou aguardar o provider.

## Minimal provider boundary

```ts
interface ModelProvider {
  readonly id: string;
  capabilities(modelId: string): ModelCapabilities;
  chat(request: ChatRequest, context: ProviderCallContext): Promise<ChatResult>;
  stream?(request: ChatRequest, context: ProviderCallContext): AsyncIterable<ChatChunk>;
}

interface ProviderCallContext {
  credentialRef: string;
  credentialScope: string;
  taskId: string;
  stepId: string;
  signal?: AbortSignal;
  deadlineAt?: string;
}
```

O contrato comum cobre chat, streaming opcional, tool calls opcionais, usage, finish reason, timeout, cancelamento e erros. Embeddings, reranking, visão e agentes externos permanecem em portas específicas.

## Error policy

Taxonomia mínima:

- `authentication`
- `authorization`
- `invalid_request`
- `rate_limited`
- `timeout`
- `cancelled`
- `network_error`
- `unavailable`
- `provider_error`
- `malformed_response`

Cada erro informa:

- `retryable`;
- `retryAfterMs`;
- `fallbackAllowed`;
- `credentialScope` opaco;
- se a credencial, o modelo ou o provider deve ser temporariamente bloqueado.

## Efficiency policy

Para extrair valor de recursos escassos:

- preparar contexto localmente antes da chamada;
- serializar chamadas remotas no perfil restrito;
- deduplicar instruções e subtarefas;
- cachear resultados reutilizáveis;
- executar testes, lint, parsing e transformações determinísticas localmente;
- usar modelos locais para tarefas simples quando possível;
- reservar chamadas remotas fortes para planejamento, síntese e correções difíceis;
- limitar loops de reflexão/revisão por orçamento;
- fazer checkpoint antes e depois de chamadas externas;
- pausar em vez de descartar progresso.

## Rollout

1. Definir contrato comum com `credentialRef` e `credentialScope`.
2. Centralizar BYOK, secret resolution e redaction.
3. Implementar limiter e scheduler durável para quota baixa.
4. Adaptar um provider existente para provar o contrato.
5. Executar POC NVIDIA isolada com chave do próprio usuário.
6. Validar chat, streaming, cancelamento, 40 RPM, `429`, cooldown e retomada.
7. Implementar adapter NVIDIA opcional.
8. Integrar seleção por capacidade/configuração.
9. Medir tarefas concluídas por quota, não apenas latência.

## Rollback

- remover NVIDIA da configuração do usuário;
- desligar a feature flag durante a fase experimental;
- manter fila e checkpoints independentes do provider;
- selecionar outro provider disponível;
- não migrar estado para formato proprietário da NVIDIA;
- remover o adapter sem perder histórico de tarefa.

## Consequences

### Positive

- cada usuário utiliza sua própria quota;
- nenhuma chave central vira gargalo ou custo do mantenedor;
- 40 RPM se torna restrição administrável em vez de falha constante;
- tarefas sobrevivem a reinícios e longos cooldowns;
- a arquitetura melhora também Groq, Z.AI, Gemini e outros providers;
- o sistema é coerente com a visão de construir bem usando recursos limitados.

### Negative

- tarefas podem demorar muito;
- exige persistência mais rica que a fila atual;
- requer UX clara para estados de espera;
- BYOK transfere ao usuário a responsabilidade por termos, quota e validade da chave;
- capability profiles e isolamento por credencial aumentam a complexidade interna.

### Risks

- 40 RPM pode mudar por conta, modelo ou tráfego;
- cooldown incorreto pode desperdiçar tempo ou gerar novos `429`;
- persistência insegura poderia vazar credenciais;
- fallback mal configurado poderia consumir outra chave sem autorização;
- loops longos poderiam desperdiçar quota lentamente sem gates de valor;
- termos do endpoint gratuito podem mudar.

## Rejected alternatives

### Chave NVIDIA única do projeto

Rejeitada. Criaria gargalo global, custo, risco de abuso e mistura de quotas entre usuários.

### Otimizar para paralelismo máximo

Rejeitada. Não corresponde ao objetivo do produto e colide com quotas gratuitas.

### Tratar `429` como falha definitiva

Rejeitada. No modo restrito, quota esgotada normalmente significa reagendar e continuar depois.

### Trocar apenas o `baseUrl` do DirectZAIProvider

Rejeitada. Capacidades, credenciais, quota e respostas variam por provider/modelo.

### Abstração universal para toda IA

Rejeitada. Chat, embeddings, reranking, visão e execução de agentes possuem contratos diferentes.

## Acceptance gates

- [ ] contrato suporta `credentialRef` e `credentialScope`;
- [ ] nenhuma chave bruta é persistida fora de secret store aprovado;
- [ ] limiter isola cada credencial;
- [ ] perfil `nvidia-free` usa baseline 40 RPM e alvo nominal 36 RPM;
- [ ] `429` persiste cooldown e respeita `Retry-After`;
- [ ] fila restaura `waiting_for_quota` após reinício;
- [ ] concorrência 1 evita rajadas no modo restrito;
- [ ] POC real usa chave fornecida pelo próprio usuário;
- [ ] logs e métricas não revelam chave, prompt ou resposta integral;
- [ ] tarefas podem pausar e retomar sem repetir passos concluídos;
- [ ] fallback nunca usa credencial de outro usuário;
- [ ] rollback para outro provider preserva checkpoint e fila;
- [ ] Pedro aprova a implementação após o baseline da #34 permitir expansão.

## Status transition

Esta ADR permanece **Proposed** até que contrato, BYOK, scheduler durável e POC sejam verificados. A decisão de usar NVIDIA em produção comercial continua fora deste ADR.