# Avaliação da NVIDIA NIM como provider do Ouroboros

- **Issue:** #42
- **Parent:** #34
- **Data de verificação:** 2026-07-11
- **Natureza:** pesquisa arquitetural; nenhuma integração de produção foi implementada
- **Resultado recomendado:** **experimentar de forma opcional e reversível**, nunca como provider principal neste ciclo

## 1. Resumo executivo

O produto analisado é o conjunto de **endpoints hospedados do NVIDIA API Catalog/NIM**, acessível por API compatível com o formato de Chat Completions da OpenAI em `https://integrate.api.nvidia.com/v1/chat/completions`. O NIM auto-hospedado é uma alternativa distinta, baseada em containers e infraestrutura NVIDIA.

A oferta hospedada é adequada para protótipos, pesquisa, desenvolvimento e testes. A documentação oficial afirma que o acesso do NVIDIA Developer Program não é destinado a produção e não inclui estabilidade ou suporte empresarial. Uso real por usuários finais exige NVIDIA AI Enterprise. Por isso, a oferta hospedada gratuita não pode ser tratada como infraestrutura principal do Ouroboros.

A hipótese de **40 requisições por minuto** não foi confirmada nas fontes oficiais consultadas. Não foi encontrada uma tabela pública estável de quota, granularidade, headers ou política por modelo/conta. O número não deve ser hardcoded.

A compatibilidade com OpenAI é parcial e varia por modelo. Streaming SSE aparece nos modelos inspecionados, mas `tools` foi documentado para Qwen3 Coder e não apareceu nos contratos consultados de GLM4.7 e Nemotron 3 Nano. `response_format`/JSON Schema também não foi documentado nesses três contratos. Logo, o Ouroboros precisa de perfis de capacidade por modelo, não de uma flag genérica “OpenAI-compatible”.

O principal bloqueio atual é interno: o runtime possui integrações paralelas e fortemente acopladas para Groq, Z.AI, Gemini, Antigravity e Ollama. Há uma interface `ILLMProvider`, mas ela não governa os providers usados pelo CLI atual. Integrar a NVIDIA diretamente aumentaria a fragmentação.

### Decisão proposta

1. Não substituir Groq, Z.AI, Gemini ou Ollama pela NVIDIA agora.
2. Consolidar primeiro um contrato mínimo e uma taxonomia comum de erros/capacidades.
3. Criar depois uma prova de conceito isolada do endpoint hospedado, sem dados sensíveis e sem custo não aprovado.
4. Somente após a prova, considerar um adapter `nvidia-nim` atrás de feature flag, desligado por padrão.
5. Manter o provider existente como caminho primário e rollback imediato.
6. Reabrir a decisão de produção apenas com licença, custos, regiões, retenção e SLA documentados.

## 2. Produto e contrato oficial

### 2.1 Produto considerado

| Opção | Natureza | Uso apropriado | Conclusão para o Ouroboros |
|---|---|---|---|
| NVIDIA API Catalog / NIM hosted endpoints | Inferência hospedada pela NVIDIA, chave de desenvolvedor, APIs por modelo | Protótipos, pesquisa, desenvolvimento e testes | Candidato apenas experimental |
| NIM auto-hospedado | Containers de inferência executados em infraestrutura NVIDIA | Controle de dados e operação própria | Fora do ciclo atual; exige GPU/infraestrutura e avaliação de licença |
| NVIDIA AI Enterprise | Licença e suporte empresarial para produção | Produção, estabilidade e suporte | Só considerar mediante decisão explícita de custo |

A FAQ oficial apresenta o catálogo como ambiente para construir POCs e recomenda migrar para compute próprio após o protótipo. Também diferencia o Developer Program, destinado a prototipagem, do NVIDIA AI Enterprise, exigido para produção.

### 2.2 Autenticação e endpoint

- Autenticação: token Bearer.
- Endpoint de chat hospedado observado: `POST https://integrate.api.nvidia.com/v1/chat/completions`.
- Formato: descrito como compatível com Chat Completions da OpenAI.
- O catálogo também expõe APIs distintas para embeddings, reranking, visão e outros domínios; não se deve presumir um contrato único.

### 2.3 Gratuidade, créditos e produção

**Confirmado:** membros do NVIDIA Developer Program possuem acesso gratuito a endpoints NIM para prototipagem e a NIMs auto-hospedáveis para pesquisa/desenvolvimento/experimentação, dentro das condições do programa.

**Confirmado:** o programa gratuito não é uma licença de produção. A FAQ define produção como atividade além de desenvolvimento, teste, pesquisa ou avaliação, incluindo servir usuários reais.

**Confirmado:** a documentação consultada informa que NVIDIA AI Enterprise começa em aproximadamente USD 4.500 por GPU/ano ou cerca de USD 1 por GPU/hora na nuvem. Esses números são referência do licenciamento de produção, não preço por requisição do endpoint de desenvolvimento.

**Risco:** os termos permitem encerrar promoções gratuitas/descontadas, aplicar cobranças padrão após o fim da promoção ou após exceder seus termos, e alterar/depreciar tecnologia sem aviso prévio.

### 2.4 Dados, privacidade e segurança

Os Termos de Acesso à Tecnologia concedem à NVIDIA, afiliadas e prestadores uma licença sobre conteúdo enviado para operar, dar suporte, proteger e melhorar produtos/serviços. Salvo acordo de produto em contrário, os termos também proíbem o envio de informação confidencial, dados pessoais/controlados/sensíveis e outras categorias protegidas.

Consequências para o Ouroboros hospedado:

- não enviar código privado, segredos, dados pessoais ou conteúdo acadêmico/confidencial;
- aplicar redaction antes da requisição;
- nunca registrar chave, header Authorization, prompt integral ou resposta sensível;
- considerar retenção, residência regional e prazo de exclusão como **desconhecidos** até existir documento específico do produto/conta;
- tratar o endpoint gratuito como ambiente externo de desenvolvimento, não como boundary confiável de produção.

## 3. Modelos e capacidades observadas

A lista do catálogo é dinâmica. A tabela abaixo registra somente o contrato oficial consultado em 2026-07-11, não uma garantia permanente.

| Modelo inspecionado | Chat OpenAI-style | Streaming | Tool calling documentado | Structured output documentado | `max_tokens` de saída documentado |
|---|---:|---:|---:|---:|---:|
| `z-ai/glm4.7` | Sim | Sim, SSE | Não localizado no contrato consultado | Não localizado | 1–32768 |
| `qwen/qwen3-coder-480b-a35b-instruct` | Sim | Sim, SSE | Sim, campo `tools` | Não localizado | 1–16384 |
| `nvidia/nemotron-3-nano-30b-a3b` | Sim | Sim, SSE | Não localizado no contrato consultado | Não localizado | 1–32768 |

Observações:

- “Não localizado” não significa que o modelo nunca suporte a capacidade; significa que ela não deve ser assumida sem prova e contrato oficial atual.
- `max_tokens` é limite de geração documentado, não prova do contexto total.
- Os defaults variam por modelo, inclusive `stream`; o adapter deve enviar valores explícitos.
- O endpoint pode devolver `202` em algumas operações/modelos, portanto o contrato normalizado precisa admitir execução assíncrona ou rejeitá-la explicitamente.
- A ausência de `response_format` nos contratos analisados impede chamar JSON por prompt de “structured output garantido”.

## 4. Limites operacionais

### 4.1 Hipótese de 40 RPM

**Resultado:** não confirmada.

Nas páginas oficiais consultadas não foi encontrada uma tabela pública que estabeleça 40 RPM como limite geral ou específico do Ouroboros. Também não foi localizado contrato público estável para:

- quota por conta, chave, modelo ou endpoint;
- requests/minuto e tokens/minuto;
- concorrência;
- headers de limite;
- janela de reset;
- comportamento formal de `429`.

Portanto:

- não codificar `40` como constante;
- tornar limites configuráveis por `provider + model + operation`;
- capturar, sem conteúdo sensível, status e headers de resposta observados na POC;
- respeitar `Retry-After` quando presente;
- classificar `429` como defesa genérica de gateway, sem alegar que é contrato NVIDIA confirmado.

### 4.2 Política de resiliência proposta

| Evento | Retry? | Política |
|---|---:|---|
| `401`/`403` | Não | falhar como `authentication`/`authorization`; nunca trocar chave automaticamente |
| `400`/`422` | Não | falhar como `invalid_request`; corrigir payload/capability profile |
| `408`, rede transitória | Sim | falhar como `network_error` quando não houver resposta HTTP; backoff exponencial com full jitter e limite de tentativas |
| `429` | Sim, controlado | honrar `Retry-After`; não multiplicar carga; abrir circuito se recorrente |
| `5xx` transitório | Sim | backoff+jitter; fallback após orçamento de tentativas |
| timeout/cancelamento | Não automaticamente | distinguir timeout de cancelamento do usuário; propagar `AbortSignal` |

Circuit breaker recomendado: chaveado por `providerId + modelId + operation`. Um estado local em memória é suficiente enquanto houver um único daemon. Só adotar estado distribuído quando houver múltiplos processos/instâncias concorrentes.

## 5. Inventário da arquitetura atual

### 5.1 Chamadas diretas e acoplamentos

| Área | Arquivo | Provider/contrato atual | Riscos relevantes |
|---|---|---|---|
| Classificação de intenção | `cli/src/concierge/ConciergeClient.ts` | `groq-sdk`, modelo hardcoded | sem contrato compartilhado; fallback genérico; `console.error` |
| Agente com tools | `cli/src/providers/direct-zai.ts` | HTTP OpenAI-style da Z.AI | modelo/base URL hardcoded; sem retry/rate limit/circuit breaker |
| Loop de agente | `cli/src/providers/agent-loop.ts` | depende concretamente de `DirectZAIProvider` | não permite substituir provider sem refatorar o loop |
| Review multi-modelo | `cli/src/orchestration/strategies/MultiModelReviewStrategy.ts` | fetch direto OpenAI-style | default de modelo Gemini combinado com endpoint Z.AI; falha pode virar heurística silenciosa; já coberto parcialmente por #36 |
| Gemini | `cli/src/runtime/GeminiDirectAPI.ts` | REST específica do Google | tipos/modelos hardcoded; chave em query string; sem retry/rate limit |
| Delegação daemon | `cli/src/daemon/rpc-gateway.ts` | roteamento por strings `gemini`, `glm`, `jules`, `antigravity` | Z.AI acoplada a wave/parser; carregamento de segredo fragmentado |
| Inferência local | `cli/src/inference/LocalInferenceProvider.ts` | Ollama HTTP | retries e métricas locais, mas contrato exclusivo de Ollama |
| Registry/router local | `cli/src/inference/ModelRegistry.ts`, `ModelRouter.ts`, `InferenceSubsystem.ts` | `LocalInferenceProvider` e `ollamaModel` | capacidades/roteamento não incluem dimensão de provider remoto |
| Porta conceitual | `src/core/ports/ILLMProvider.ts` | interface mínima `chat()` | não governa os providers ativos do CLI; insuficiente para streaming, abort, usage e erros |
| Configuração | `cli/src/utils/env-loader.ts`, `.env.example` | Groq/Google como obrigatórios | ausência de registry central de credenciais/providers; Z.AI carregada em outros pontos |

### 5.2 Achados críticos

1. Existem ao menos três arquiteturas de inferência em paralelo: core/ports, CLI providers remotos e subsistema local/Ollama.
2. Compatibilidade OpenAI é usada como detalhe de transporte, mas não existe perfil formal de capacidades por modelo.
3. Timeouts, retries, fallback, métricas e segredo são implementados de formas diferentes em cada integração.
4. O `ModelRouter` possui circuit breaker e fallback somente no domínio de modelos locais e não controla Z.AI/Groq/Gemini.
5. O `MultiModelReviewStrategy` já possui uma incoerência provider/model e deve ser corrigido pela #36, sem ampliar aquela issue para NVIDIA.
6. Integrar NVIDIA diretamente em `direct-zai.ts` ou trocar apenas `baseUrl` criaria compatibilidade aparente e falhas silenciosas em tools, JSON e defaults.

## 6. Compatibilidade com os fluxos do Ouroboros

| Necessidade atual | NVIDIA hosted | Situação |
|---|---|---|
| Chat simples | Compatível nos modelos analisados | Favorável |
| Streaming SSE | Documentado | Favorável, requer parser robusto e cancelamento |
| Tool calling do AgentLoop | Modelo-específico | Qwen3 Coder é candidato; não assumir para GLM/Nemotron |
| JSON para routing/review | Prompt JSON possível; schema garantido não documentado | Insuficiente para gate crítico sem validação conservadora |
| Usage/tokens | Resposta OpenAI-style pode fornecer usage, mas deve ser validada por modelo | POC necessária |
| Embeddings/reranking | Existem APIs específicas no catálogo | Não usar o adapter de chat como abstração universal |
| AbortSignal/timeout | Implementável no cliente | Favorável |
| Fallback | Responsabilidade do Ouroboros | Requer contrato e roteador comuns |
| Custos/orçamento | Oferta de dev não equivale a produção; quota pública não confirmada | Bloqueador para default/produção |
| Dados confidenciais | Termos gerais não permitem no uso analisado sem acordo específico | Bloqueador para tarefas sensíveis |

## 7. Matriz de alternativas

Escala: 1 = ruim/alto risco; 5 = favorável.

| Alternativa | Custo inicial | Disponibilidade previsível | Complexidade | Lock-in | Segurança de dados | Testabilidade | Nota |
|---|---:|---:|---:|---:|---:|---:|---|
| NVIDIA principal | 3 | 1 | 2 | 2 | 1 | 3 | Rejeitar neste ciclo |
| NVIDIA fallback global | 3 | 2 | 2 | 3 | 2 | 3 | Ainda amplo demais |
| NVIDIA opcional por configuração | 4 | 3 | 3 | 4 | 3 | 4 | Recomendado após contrato/POC |
| NVIDIA para tarefa/modelo específico | 4 | 3 | 3 | 4 | 3 | 4 | Melhor primeiro rollout |
| Não adotar | 5 | 5 | 5 | 5 | 5 | 5 | Seguro, mas perde evidência prática |
| NIM auto-hospedado agora | 1 | 3 | 1 | 2 | 5 | 3 | Fora do escopo/hardware atual |

## 8. Premissas: confirmadas, rejeitadas e desconhecidas

| Premissa | Estado | Evidência/consequência |
|---|---|---|
| “A NVIDIA é gratuita para desenvolvedores” | **Confirmada com qualificação** | gratuita para prototipagem/pesquisa/dev/testes no Developer Program; não é promessa de produção |
| “O limite é 40 RPM” | **Não confirmada** | não localizada em fonte oficial consultada; proibir hardcode |
| “É OpenAI-compatible” | **Confirmada parcialmente** | endpoint e formato de chat compatíveis; campos/capacidades variam por modelo |
| “Todos os modelos têm tools” | **Rejeitada como premissa** | `tools` apareceu no Qwen3 Coder, não nos outros contratos analisados |
| “JSON estruturado é garantido” | **Não confirmada** | `response_format`/schema não localizado nos três contratos |
| “Pode substituir providers atuais” | **Rejeitada neste ciclo** | contrato de uso, quotas desconhecidas e fragmentação interna tornam a troca arriscada |
| “Um limiter único de 40 RPM resolve” | **Rejeitada** | granularidade desconhecida; política deve ser configurável por provider/model/operação |
| Retenção de prompts/outputs | **Desconhecida** | exigir documento específico antes de dados sensíveis |
| Data residency/região do endpoint | **Desconhecida** | não assumir residência no Brasil/EUA |
| SLA do endpoint gratuito | **Ausente para o caso analisado** | Developer Program não oferece estabilidade/suporte empresarial |

## 9. Arquitetura alvo mínima

Evitar uma abstração universal excessiva. O primeiro contrato deve cobrir apenas chat/streaming/tools usados pelo runtime.

```ts
interface ModelProvider {
  readonly id: string;
  capabilities(modelId: string): ModelCapabilities;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
  stream?(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
}
```

Elementos obrigatórios do contrato normalizado:

- `providerId`, `modelId`, operação e capability profile;
- mensagens e tools normalizadas;
- timeout externo e `AbortSignal` propagável;
- conteúdo, tool calls, finish reason e usage;
- status HTTP e headers permitidos para diagnóstico, sem segredo;
- taxonomia: `authentication`, `authorization`, `invalid_request`, `rate_limited`, `timeout`, `cancelled`, `network_error`, `unavailable`, `provider_error`, `malformed_response`;
- `retryable`, `retryAfterMs` e `fallbackAllowed` explícitos;
- validação de resposta antes de entregar a gates críticos.

`network_error` cobre falhas locais anteriores a qualquer resposta HTTP, como DNS, conexão recusada e queda de socket. Ele é diferente de indisponibilidade HTTP e de erro interno do provider.

Perfis de modelo devem declarar capacidades, não inferi-las do nome do provider:

```ts
interface ModelCapabilities {
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  structuredOutput: 'none' | 'json_object' | 'json_schema';
  embeddings: boolean;
  reranking: boolean;
  vision: boolean;
  maxOutputTokens?: number;
}
```

## 10. Plano incremental e reversível

### Fase A — contrato e inventário

- consolidar o contrato mínimo sem mudar o provider padrão;
- adaptar primeiro um provider existente como prova do contrato;
- centralizar resolução de configuração e segredo;
- criar testes de contrato com transport fake.

### Fase B — POC NVIDIA isolada

- script/teste não importado pelo runtime principal;
- chave apenas por `NVIDIA_API_KEY`;
- modelo selecionado explicitamente;
- chamada simples e streaming;
- tool calling apenas em modelo cujo contrato documente `tools`;
- JSON validado localmente;
- credencial inválida, timeout, cancelamento e `429` simulado;
- registrar status/headers de limite observados sem prompt/segredo;
- nenhuma chamada paga ou teste de carga.

### Fase C — adapter experimental

- feature flag `NVIDIA_NIM_ENABLED=false` por padrão;
- allowlist de tarefas não sensíveis;
- profile por modelo;
- fallback para provider atual;
- orçamento e limites configuráveis;
- métricas e redaction.

### Fase D — decisão de rollout

Só liberar além de experimento após Pedro aprovar:

- finalidade exata;
- custo/licença;
- limites observados e termos atualizados;
- região/retenção;
- modelo e capacidades verificadas;
- rollback testado.

## 11. Plano de testes

### Contrato

- resposta simples normalizada;
- usage ausente/presente;
- tool calls válidas e malformadas;
- streaming fragmentado entre chunks e `[DONE]`;
- resposta vazia/malformada;
- `202` tratado ou rejeitado explicitamente.

### Falhas

- `401`, `403`, `422`, `429`, `500`, `503`;
- DNS, conexão recusada e queda de socket classificados como `network_error`;
- rede desconectada;
- timeout;
- cancelamento pelo chamador;
- `Retry-After` em segundos e data;
- backoff com jitter determinístico via clock/RNG fake;
- circuito abre, fica half-open e fecha após sucesso.

### Segurança

- chave não aparece em logs, eventos, erros ou snapshots;
- headers são allowlisted;
- prompt/resposta não são logados por padrão;
- redaction de padrões de segredo;
- provider experimental rejeita tarefas marcadas como sensíveis.

### Fallback

- primário saudável não chama NVIDIA;
- erro não retryable não gera loop;
- erro transitório respeita orçamento de retries;
- fallback registra motivo e provider/model usados;
- desligar feature flag restaura caminho anterior sem migração de dados.

## 12. Observabilidade e rollback

Métricas mínimas, sem conteúdo:

- requests, sucessos e erros por `provider/model/operation`;
- latência p50/p95/p99;
- tokens de entrada/saída quando disponíveis;
- retries, `429`, timeouts e circuit-open;
- fallback count e motivo;
- custo estimado somente quando houver tabela de preço aprovada.

Rollback:

1. desligar `NVIDIA_NIM_ENABLED`;
2. retirar o modelo da allowlist;
3. manter provider anterior como default;
4. não persistir estado específico da NVIDIA;
5. remover o adapter sem alterar histórico, memória ou formato de sessão.

## 13. Decomposição recomendada

Ordem de dependência:

1. contrato mínimo de provider + capability profiles + taxonomia de erros;
2. configuração/segredos centralizados e redaction;
3. POC NVIDIA isolada e sem custo inesperado;
4. resiliência genérica: retry, jitter, limiter configurável e circuit breaker;
5. adapter NVIDIA experimental e feature flag;
6. testes de contrato, métricas e runbook de rollout/rollback.

Todas as issues de implementação devem permanecer bloqueadas até aprovação de Pedro e até o baseline da épica #34 permitir expansão arquitetural.

## 14. Questões ainda abertas

- Quais quotas são aplicadas à conta/chave/modelo real do projeto?
- Quais headers de rate limit são retornados na conta de Pedro?
- Existe retenção específica para API Catalog/NIM hosted além dos termos gerais?
- Qual região processa e armazena as solicitações?
- O modelo candidato mantém tool calling e usage com estabilidade suficiente?
- A conta exige billing ou apenas Developer Program para a POC?

Essas questões exigem conta/chave e, quando aplicável, confirmação contratual. Não foram simuladas como fatos.

## 15. Fontes oficiais

Consultadas em 2026-07-11:

- NVIDIA NIM — General FAQ: https://docs.api.nvidia.com/nim/docs/product
- NVIDIA NIM — LLM APIs: https://docs.api.nvidia.com/nim/reference/llm-apis
- GLM4.7 API contract: https://docs.api.nvidia.com/nim/reference/z-ai-glm4-7-infer
- Qwen3 Coder API contract: https://docs.api.nvidia.com/nim/reference/qwen-qwen3-coder-480b-a35b-instruct-infer
- Nemotron 3 Nano API contract: https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-30b-a3b-infer
- NVIDIA Technology Access Terms of Use: https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA_Technology_Access_TOU.pdf

## 16. Conclusão

**Recomendação final: experimentar, não migrar.**

A NVIDIA oferece um catálogo tecnicamente interessante e um transporte familiar, mas a oferta hospedada gratuita é explicitamente orientada a desenvolvimento, com limites operacionais não confirmados, termos incompatíveis com conteúdo sensível e diferenças de capacidade por modelo. O Ouroboros deve primeiro corrigir sua própria fragmentação de providers. Depois disso, uma POC pequena com Qwen3 Coder ou outro modelo de capacidade documentada pode gerar evidência real sem criar dependência estrutural.
