# ADR-0042 — NVIDIA NIM somente como provider experimental

- **Status:** Proposed
- **Date:** 2026-07-11
- **Decision owners:** Pedro / Ouroboros maintainers
- **Research:** `docs/research/nvidia-nim-provider-evaluation-2026-07-11.md`
- **Related:** #42, #34, #36

## Context

O Ouroboros precisa avaliar se endpoints da NVIDIA podem complementar os providers atuais. O runtime, porém, não possui um contrato único em uso: Groq, Z.AI, Gemini, Antigravity e Ollama são chamados por integrações diferentes, com semânticas distintas de timeout, retries, tools, JSON, configuração, métricas e fallback.

Os endpoints hospedados do NVIDIA API Catalog/NIM usam um formato compatível com Chat Completions da OpenAI, mas as capacidades variam por modelo. A oferta gratuita do NVIDIA Developer Program é destinada a prototipagem, pesquisa, desenvolvimento e testes, não a produção. Quotas públicas estáveis, residência regional e retenção específica não foram confirmadas.

Adicionar NVIDIA diretamente a uma integração existente ou trocar apenas a URL criaria acoplamento e compatibilidade ilusória.

## Decision

O Ouroboros **não adotará NVIDIA NIM como provider principal ou default neste ciclo**.

Será permitido, após aprovação explícita e conclusão das dependências, um provider experimental com estas restrições:

1. `nvidia-nim` será opcional, desligado por padrão e ativado por feature flag.
2. A integração hospedada será limitada a protótipos e tarefas não sensíveis.
3. Nenhum código privado, segredo, dado pessoal, dado acadêmico confidencial ou conteúdo marcado como sensível será enviado.
4. Um contrato mínimo de provider será definido antes do adapter NVIDIA.
5. Capacidades serão declaradas por modelo; “OpenAI-compatible” não implicará tools, JSON Schema, embeddings ou multimodalidade.
6. O provider atual permanecerá como primário e rollback.
7. Nenhum limite de 40 RPM será codificado sem evidência oficial ou observada e registrada.
8. Rate limits serão configuráveis por provider, modelo e operação.
9. Retries serão restritos a falhas transitórias, com backoff exponencial, full jitter e respeito a `Retry-After`.
10. O adapter propagará `AbortSignal`, distinguirá timeout de cancelamento e não registrará conteúdo ou credenciais.
11. Produção exigirá nova ADR, aprovação de custo/licença, revisão de termos, região, retenção e SLA.

## Minimal provider boundary

O contrato comum deverá normalizar somente o necessário aos fluxos existentes:

- chat não streaming;
- streaming opcional;
- tool calls opcionais;
- usage e finish reason;
- timeout e cancelamento;
- status/headers permitidos;
- erros tipados e retry hints;
- capability profile por modelo.

Embeddings, reranking, visão e execução de agentes externos não serão forçados no mesmo contrato de chat. Poderão usar portas específicas.

## Error policy

Taxonomia mínima:

- `authentication`
- `authorization`
- `invalid_request`
- `rate_limited`
- `timeout`
- `cancelled`
- `unavailable`
- `provider_error`
- `malformed_response`

Cada erro deverá indicar `retryable`, `retryAfterMs` quando conhecido e `fallbackAllowed`.

## Rollout

1. Criar contrato e testes com transport fake.
2. Adaptar um provider existente sem alterar comportamento externo.
3. Executar POC NVIDIA isolada com chave fornecida por ambiente.
4. Registrar capacidades e limites observados.
5. Implementar adapter experimental somente se a POC passar.
6. Liberar para allowlist de tarefas não sensíveis.
7. Avaliar dados de erro, latência, throttling e qualidade antes de qualquer ampliação.

## Rollback

- desligar a feature flag;
- remover o modelo da allowlist;
- rotear para o provider anterior;
- não migrar nem persistir estado específico da NVIDIA;
- remover o adapter sem alterar memória, sessões ou formatos públicos.

## Consequences

### Positive

- reduz lock-in;
- impede que diferenças entre modelos virem falhas silenciosas;
- torna resiliência e observabilidade reutilizáveis;
- permite obter evidência real sem comprometer o runtime principal;
- mantém caminho de rollback imediato.

### Negative

- exige trabalho arquitetural antes da POC integrada;
- adiciona capability profiles e taxonomia de erros;
- não explora imediatamente todos os modelos do catálogo;
- o endpoint gratuito não pode atender fluxos sensíveis ou de produção.

### Risks

- o catálogo, modelos ou termos podem mudar;
- quotas podem variar por conta/modelo;
- comportamento observado pode divergir da documentação;
- um adapter OpenAI-style pode esconder parâmetros incompatíveis;
- fallback automático pode elevar custo ou mascarar falhas sem limites claros.

## Rejected alternatives

### NVIDIA como provider principal

Rejeitada por restrições de produção, ausência de SLA gratuito, quotas não confirmadas, risco de dados e fragmentação interna.

### Trocar `baseUrl` do DirectZAIProvider

Rejeitada porque o loop depende de tool calling e formatos Z.AI; capacidades NVIDIA são por modelo e não equivalentes.

### Criar abstração universal para todos os tipos de IA

Rejeitada por excesso de generalização. Chat, embeddings, reranking e agentes externos possuem contratos diferentes.

### Não investigar NVIDIA

Rejeitada porque uma POC isolada pode produzir evidência útil com baixo risco após as dependências.

## Acceptance gates before implementation

- [ ] Pedro aprova o experimento e qualquer risco/custo.
- [ ] Baseline da #34 permite nova integração.
- [ ] Contrato mínimo e capability profiles aprovados.
- [ ] Configuração e segredo centralizados.
- [ ] POC não integrada comprova autenticação, chat, streaming e cancelamento.
- [ ] Tool calling comprovado no modelo candidato, se necessário.
- [ ] `429`, timeout, retries e fallback possuem testes determinísticos.
- [ ] Nenhum segredo ou conteúdo sensível aparece em logs.
- [ ] Rollback por feature flag foi testado.

## Status transition

Esta ADR permanece **Proposed**. Ela pode virar **Accepted** somente após decisão de Pedro e conclusão das gates. Uma futura decisão de produção exige ADR separada.