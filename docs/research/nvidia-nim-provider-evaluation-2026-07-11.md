# Avaliação da NVIDIA NIM como provider BYOK do Ouroboros

- **Issue:** #42
- **Parent:** #34
- **Data de verificação inicial:** 2026-07-11
- **Revisão de visão:** 2026-07-11, após alinhamento com Pedro
- **Natureza:** pesquisa arquitetural; nenhuma integração de produção foi implementada
- **Resultado recomendado:** adotar NVIDIA NIM como provider opcional BYOK, desenhado para execução lenta, durável e consciente de quota

## 1. Resumo executivo

O produto analisado é o conjunto de endpoints hospedados do NVIDIA API Catalog/NIM, acessível por API no formato OpenAI Chat Completions em `https://integrate.api.nvidia.com/v1/chat/completions`.

A visão do Ouroboros não é construir o agente mais rápido. O objetivo é construir um agente que continue trabalhando sob condições ruins: pouca quota, modelos gratuitos, hardware modesto, interrupções, indisponibilidade e orçamento quase nulo. Latência é secundária; continuidade, qualidade acumulada e capacidade de retomar são prioritárias.

A NVIDIA é especialmente relevante para esse objetivo porque fornece uma variedade grande de modelos sob uma chave gratuita de desenvolvimento, mesmo com quota baixa. O limite padrão observado para chaves gratuitas é **40 RPM por chave**. Fóruns da NVIDIA registram repetidamente contas com esse limite e pedidos de aumento. Há também orientação de que a camada gratuita é para prototipagem e não recebe aumento manual pelo fórum.

O número de 40 RPM deve ser usado como **baseline operacional conservador**, mas não como garantia contratual eterna. O cliente deve continuar configurável e reagir a `429`, `Retry-After`, mudanças por modelo e alterações futuras da plataforma.

A arquitetura correta não é compartilhar uma única chave do mantenedor entre todos os usuários. Cada usuário informa sua própria chave — modelo BYOK, _bring your own key_. Consequentemente, quota, cooldown, métricas e circuit breaker devem ser isolados por credencial do usuário, nunca tratados como uma quota global do Ouroboros.

## 2. Princípio de produto: continuidade acima de velocidade

O Ouroboros deve otimizar para:

1. **trabalho concluído por quota disponível**, não requisições por segundo;
2. **progresso persistente**, não sessões rápidas e descartáveis;
3. **serialização segura**, não paralelismo agressivo;
4. **retomada após horas ou dias**, não timeout global curto;
5. **degradação controlada**, não falha total quando um provider acaba;
6. **qualidade acumulada**, usando planejamento, execução, teste e revisão em etapas espaçadas;
7. **infraestrutura do usuário**, sem subsidiar todos com uma chave central.

Uma tarefa pode levar horas. Isso não é falha, desde que:

- o estado esteja persistido;
- o próximo passo seja conhecido;
- o usuário consiga pausar, retomar e cancelar;
- a fila não repita trabalho já concluído;
- os limites e motivos de espera estejam visíveis;
- o resultado passe por validação antes de promoção.

## 3. Produto, uso e limitações

| Opção | Natureza | Adequação ao Ouroboros |
|---|---|---|
| NVIDIA Build / NIM hosted | Endpoints hospedados, chave de desenvolvedor e catálogo amplo | Boa opção BYOK para execução restrita e prototipagem pessoal |
| NIM auto-hospedado | Containers executados em hardware do usuário | Alternativa futura para usuários com GPU/infraestrutura compatível |
| NVIDIA AI Enterprise | Licença e suporte comercial | Fora do objetivo gratuito inicial; avaliar apenas quando houver demanda real |

A oferta gratuita não deve ser apresentada como SLA de produção. O Ouroboros pode, porém, ser deliberadamente útil em ambientes pessoais e de desenvolvimento sem fingir que o endpoint possui garantias empresariais.

## 4. Limite de 40 RPM

### 4.1 Estado da premissa

A premissa foi atualizada para:

> **40 RPM é o limite padrão operacional observado para chaves gratuitas NVIDIA Build/NIM em 2026.**

Evidências operacionais:

- tópico de junho de 2026 registra `Current limit: 40 RPM` e resposta descrevendo o teto gratuito como limite rígido do sandbox;
- múltiplos pedidos de aumento de `40 → 200 RPM` relatam o mesmo limite;
- moderação informa que não há aumento de quota pela camada gratuita e que os limites podem depender de modelo, uso e tráfego.

Portanto, a implementação deve:

- usar `40 RPM` como default do perfil `nvidia-free`;
- mirar **36 RPM** por padrão, equivalente a aproximadamente uma chamada a cada 1,67 segundo, preservando margem;
- usar `maxConcurrency = 1` por credencial no modo restrito;
- permitir override explícito quando a conta tiver outro contrato;
- reduzir dinamicamente a cadência após `429`;
- respeitar `Retry-After` quando presente;
- persistir `nextEligibleAt`, para que reiniciar o daemon não apague o cooldown;
- nunca executar load test para descobrir quota.

### 4.2 Escopo da quota

O limiter deve ser chaveado, no mínimo, por:

```text
providerId + credentialScope
```

E pode possuir buckets subordinados por:

```text
providerId + credentialScope + modelId + operation
```

`credentialScope` é um identificador interno opaco da chave do usuário. Não é a chave, não contém prefixo suficiente para reconstruí-la e pode ser derivado por hash com salt local.

A regra conservadora para NVIDIA gratuita é um bucket superior de 40 RPM por credencial, mesmo quando modelos diferentes forem usados. Perfis inferiores podem ficar mais restritivos quando a POC ou headers indicarem limites por modelo/operação.

## 5. BYOK: cada usuário usa a própria chave

### 5.1 Decisão

O Ouroboros não fornecerá uma chave NVIDIA compartilhada para todos os usuários.

Cada usuário ou workspace configura sua própria credencial. Isso significa:

- a quota de um usuário não consome a quota de outro;
- erros `401`, `403` e `429` são atribuídos ao escopo correto;
- métricas são separadas por identificador opaco de credencial;
- fallback não pode trocar silenciosamente para a chave de outra pessoa;
- nenhuma chave do mantenedor é distribuída no código, instalador, frontend ou documentação.

### 5.2 Tratamento seguro

A chave bruta:

- nunca entra no repositório;
- nunca aparece em logs, eventos, traces, métricas ou snapshots;
- nunca é persistida na fila ou no SQLite de tarefas;
- deve ficar em variável de ambiente, memória do processo ou secret store seguro;
- só pode ser persistida quando existir armazenamento de segredo explicitamente projetado para isso;
- deve ser redigida de mensagens de erro e dumps de request.

A configuração comum referencia `credentialScope`/`credentialRef`, não o valor da chave.

## 6. Capacidades por modelo

A compatibilidade OpenAI é apenas de transporte. Capacidades devem ser declaradas por `provider + model`.

| Modelo inspecionado | Chat | Streaming | Tools documentadas | Structured output garantido |
|---|---:|---:|---:|---:|
| `z-ai/glm4.7` | Sim | Sim | Não localizado no contrato consultado | Não localizado |
| `qwen/qwen3-coder-480b-a35b-instruct` | Sim | Sim | Sim | Não localizado |
| `nvidia/nemotron-3-nano-30b-a3b` | Sim | Sim | Não localizado no contrato consultado | Não localizado |

“Não localizado” significa que a capacidade não pode ser presumida. JSON solicitado por prompt continua sendo texto não confiável e precisa de validação local conservadora.

## 7. Inventário da arquitetura atual

| Área | Implementação atual | Problema para BYOK durável |
|---|---|---|
| Concierge | `groq-sdk` direto | modelo e credencial fora de um registry comum |
| Agente com tools | `DirectZAIProvider` concreto | loop acoplado a um provider |
| Gemini | REST própria | timeout/configuração específicos |
| Review | fetch OpenAI-style direto | provider/model incoerentes e fallback silencioso, tratado em #36 |
| Inferência local | `LocalInferenceProvider`/Ollama | arquitetura separada dos providers remotos |
| RPC | strings `gemini`, `glm`, `jules`, `antigravity` | seleção não baseada em capacidades/credenciais |
| Fila | `PriorityTaskQueue` com snapshot JSON | não possui `nextEligibleAt`, espera de quota ou estado `blocked_by_quota` |
| Scheduler | `EvolutionScheduler` | possui budget e frequência, mas não governa quota por credencial/provider |
| Porta conceitual | `ILLMProvider` | insuficiente para streaming, usage, abort, erro e escopo de credencial |

O projeto já possui peças úteis — fila persistível, deduplicação, budget, scheduler e circuit breaker — mas elas ainda não formam uma máquina de execução durável orientada por quota.

## 8. Arquitetura alvo

### 8.1 Contrato de provider

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
  signal?: AbortSignal;
  deadlineAt?: string;
  taskId: string;
  stepId: string;
}
```

O contrato deve normalizar chat, streaming opcional, tools opcionais, usage, finish reason, cancelamento e erros. Embeddings, reranking, visão e agentes externos continuam em portas específicas.

### 8.2 Taxonomia de erros

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

Cada erro informa `retryable`, `retryAfterMs`, `fallbackAllowed` e o escopo opaco da credencial.

### 8.3 Scheduler restrito

O scheduler precisa tratar espera como estado normal:

```text
pending
ready
running
waiting_for_quota
waiting_for_provider
waiting_for_budget
waiting_for_human
completed
failed_terminal
cancelled
```

Cada etapa persiste:

- input normalizado ou referência segura;
- output validado ou hash/referência;
- número de tentativas;
- provider/modelo escolhido;
- `credentialScope` opaco;
- `nextEligibleAt`;
- motivo de bloqueio;
- checkpoint anterior e próxima ação.

Timeout de uma chamada não deve virar timeout da tarefa inteira. A tarefa pode voltar à fila e continuar mais tarde.

## 9. Estratégias para produzir qualidade com pouca quota

- concorrência 1 por chave no perfil restrito;
- agrupar contexto antes de chamar o modelo;
- usar uma chamada maior e bem preparada em vez de várias chamadas impulsivas;
- deduplicar subtarefas e perguntas equivalentes;
- cachear respostas reutilizáveis com invalidação explícita;
- executar parsing, busca local, testes, lint e transformações determinísticas sem LLM;
- usar modelo local para classificação, sumarização e embeddings quando possível;
- reservar o modelo remoto mais forte para planejamento, síntese, correções difíceis e revisão final;
- limitar loops de reflexão e revisão por orçamento de valor esperado;
- fazer checkpoint antes e depois de cada chamada externa;
- pausar em vez de falhar quando a quota acabar.

## 10. Resiliência e backpressure

| Evento | Comportamento |
|---|---|
| `401`/`403` | bloquear somente a credencial afetada e pedir correção ao usuário |
| `400`/`422` | não repetir; corrigir payload/capability profile |
| `429` | persistir cooldown, respeitar `Retry-After`, reduzir ritmo e reagendar |
| rede/DNS/socket | `network_error`, backoff com jitter e retomada |
| `5xx` | retry limitado, circuit breaker e espera |
| cancelamento | interromper chamada e marcar passo como cancelado, sem retry |
| daemon reiniciado | restaurar fila, cooldowns e checkpoints |
| provider indisponível | usar fallback permitido ou aguardar, conforme política da tarefa |

Não existe retry infinito. Toda política possui limite de tentativas por etapa, limite de tempo ativo, orçamento de tokens/custo e opção de espera longa.

## 11. Estratégia de adoção

1. consolidar contrato mínimo com `credentialScope`;
2. centralizar BYOK e redaction;
3. criar scheduler/limiter durável para ambientes restritos;
4. executar POC NVIDIA isolada usando chave do próprio usuário;
5. validar 40 RPM, `429`, headers, streaming, cancelamento e retomada;
6. implementar adapter NVIDIA opcional;
7. permitir seleção por configuração e capacidade;
8. medir tarefas concluídas, não apenas latência;
9. manter rollback removendo o provider da configuração.

## 12. Métricas corretas para esta visão

Além de latência e erros, medir:

- tarefas concluídas por 100 chamadas;
- chamadas desperdiçadas por retry evitável;
- tempo total em `waiting_for_quota`;
- retomadas bem-sucedidas após reinício;
- passos reutilizados por cache/deduplicação;
- percentual de trabalho feito localmente;
- falhas terminais versus pausas recuperáveis;
- qualidade/gates aprovados por tarefa concluída;
- consumo por `credentialScope`, sem revelar identidade ou chave.

O sucesso não é “respondeu em cinco segundos”. É “continuou avançando e entregou algo verificável sem estourar os recursos do usuário”.

## 13. Premissas atualizadas

| Premissa | Estado |
|---|---|
| Chave gratuita usa 40 RPM | Confirmada como baseline operacional observado em 2026 |
| 40 RPM é contrato imutável para toda conta/modelo | Não confirmado; manter configuração e adaptação dinâmica |
| Uma chave do projeto atenderá todos | Rejeitado; arquitetura é BYOK |
| Paralelismo alto é necessário | Rejeitado; continuidade pode usar serialização |
| Esperar quota é falha | Rejeitado; espera é estado persistente normal |
| NVIDIA deve substituir todos os providers | Rejeitado; será uma opção entre providers do usuário |
| Um agente lento não é útil | Rejeitado; qualidade acumulada e retomada são objetivos centrais |

## 14. Fontes

Documentação oficial consultada:

- NVIDIA NIM — General FAQ: https://docs.api.nvidia.com/nim/docs/product
- NVIDIA NIM — LLM APIs: https://docs.api.nvidia.com/nim/reference/llm-apis
- GLM4.7 API: https://docs.api.nvidia.com/nim/reference/z-ai-glm4-7-infer
- Qwen3 Coder API: https://docs.api.nvidia.com/nim/reference/qwen-qwen3-coder-480b-a35b-instruct-infer
- Nemotron 3 Nano API: https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-30b-a3b-infer
- NVIDIA Technology Access Terms: https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA_Technology_Access_TOU.pdf

Evidência operacional de 40 RPM:

- https://forums.developer.nvidia.com/t/request-to-increase-nvidia-nim-api-rate-limit-from-40-rpm-to-250-300-rpm/372594
- https://forums.developer.nvidia.com/t/request-for-nvidia-nim-api-rate-limit-increase-40-200-rpm/369472
- https://forums.developer.nvidia.com/t/api-rate-limit-increase-for-nvidia-nim/366043

## 15. Conclusão

A NVIDIA não deve ser descartada por ser lenta ou limitada. Essas limitações são precisamente o tipo de ambiente que o Ouroboros pretende dominar.

A recomendação revisada é: **adotar NVIDIA NIM como provider opcional BYOK, com perfil restrito de 40 RPM, execução serial, fila durável, checkpoints e retomada**.

A arquitetura não promete rapidez. Ela promete não desperdiçar a pouca capacidade disponível e continuar construindo, passo a passo, com os recursos que cada usuário possui.