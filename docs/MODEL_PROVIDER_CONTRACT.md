# Contrato mínimo de `ModelProvider`

Este documento descreve a fronteira interna de providers introduzida pela Issue #44. O contrato existe para desacoplar o loop de execução do transporte específico de um fornecedor, sem transformar todas as modalidades de inferência em uma abstração universal.

## Escopo da fronteira

`ModelProvider` representa uma chamada de chat que recebe mensagens, retorna uma resposta normalizada e pode, quando houver suporte comprovado, expor streaming e tool calls. O contrato também carrega o contexto necessário para execução durável: referências opacas de credencial, identidade da tarefa e do step, sinal de cancelamento e deadline.

A fronteira não inclui embeddings, reranking, visão ou agentes externos. Essas capacidades continuam fora do contrato até que exista um caso de uso e uma semântica comum comprovados. O método legado `LocalInferenceProvider.embed` permanece disponível, mas não é apresentado como parte de `ModelProvider`.

## Tipos principais

Uma chamada usa `ModelRequest` e `ProviderCallContext`:

```ts
const response = await provider.complete(
    {
        modelId: "model-id",
        messages: [{ role: "user", content: "texto" }],
        requestTimeoutMs: 30_000,
    },
    {
        credentialRef: "credential-ref",
        credentialScope: "opaque-scope",
        taskId: "task-id",
        stepId: "step-id",
        signal,
        deadline,
    },
);
```

`credentialRef` identifica uma credencial selecionada por uma camada superior de credenciais e autorização. `credentialScope` identifica a fronteira de isolamento definida por essa camada. Ambos são opacos: não são a chave, não devem ser resolvidos por um secret store criado pelo provider e não devem conter material secreto. O contrato não possui campo para chave bruta.

### Responsabilidade por autorização

A camada superior é responsável por autenticar o chamador, autorizar o uso da credencial e escolher as referências que entram em `ProviderCallContext`. O provider recebe `credentialRef` e `credentialScope` apenas como contexto opaco para correlação ou seleção já autorizada; ele **não resolve a referência, não consulta um secret store, não concede autorização e não valida que o escopo autoriza a chamada**. Portanto, um `ModelProviderError` de `authentication` ou `authorization` só representa uma rejeição observada no transporte/provider, não uma decisão de autorização feita pelo adapter local.

O provider também não deve persistir, registrar ou misturar essas referências no payload de transporte. Os testes do contrato usam apenas sentinelas artificiais e verificam que elas não aparecem no payload, nos eventos de log ou no estado serializado do adapter.

`ModelResponse` normaliza o resultado em `content`, `modelId`, `usage` opcional, `finishReason` e `toolCalls` opcionais. `stream` também é opcional na interface, mas sua presença não anuncia suporte: consumidores devem consultar `getCapabilities(modelId)` antes de selecionar a operação.

## Capacidades declaradas, implementadas e verificadas

Cada capability é representada por três estados independentes. `declared` registra o que o provider afirma suportar; `implemented` registra o que o adapter realmente executa; `verified` só deve ser marcado quando houver teste determinístico ou outra verificação equivalente. Compatibilidade superficial com uma API, especialmente compatibilidade com OpenAI, não preenche esses estados automaticamente.

`CapabilityProfile` é a **fonte de verdade para os consumidores**. A existência de um método opcional, como `stream`, ou a possibilidade técnica de enviar um campo ao transporte não torna a capability disponível. Antes de chamar uma operação ou enviar tools/structured output, o consumidor deve consultar o perfil do `providerId`/`modelId` e respeitar os estados publicados. No caso do adapter local, o método `stream` não existe e o perfil mantém streaming como não declarado, não implementado e não verificado; mesmo que uma implementação futura adicione esse método, ela não estará disponível até o perfil afirmar a capacidade.

O perfil atual do provider local é o seguinte:

| Operação ou recurso | Declarado | Implementado | Verificado | Observação |
|---|---:|---:|---:|---|
| `complete` | Sim | Sim | Sim | Chat síncrono via transporte Ollama |
| `stream` | Não | Não | Não | Não é exposto pelo adapter atual |
| Streaming | Não | Não | Não | Não deve ser inferido do transporte |
| Tools | Não | Não | Não | A chamada é rejeitada antes do transporte |
| Structured output | Não | Não | Não | A chamada é rejeitada antes do transporte |

Os limites conhecidos ficam vazios quando o adapter não possui uma fonte confiável para informá-los. O perfil é obtido por `getCapabilities(modelId)` e sempre identifica o par `providerId`/`modelId`.

## Erros e política de retry/fallback

Falhas do contrato são instâncias de `ModelProviderError`. Cada erro informa uma categoria, se uma nova tentativa é segura, um `retryAfterMs` quando o transporte fornecer essa informação e se um fallback pode ser considerado por uma camada superior.

| Situação | Categoria | Retry | Fallback |
|---|---|---:|---:|
| HTTP 401 | `authentication` | Não | Não |
| HTTP 403 | `authorization` | Não | Não |
| HTTP 400 ou 422 | `invalid_request` | Não | Não |
| HTTP 429 | `rate_limit` | Sim | Sim |
| Deadline ou timeout da chamada | `timeout` | Conforme `retryable` explícito | Sim |
| Abort do chamador | `cancellation` | Não | Não |
| Falha de conexão ou `fetch` | `network` | Sim | Sim |
| HTTP 5xx | `http_unavailable` | Sim | Sim |
| Resposta sem o shape obrigatório | `malformed_response` | Não | Sim |
| Erro específico não classificado | `provider` | Não | Sim |

O adapter continua sem executar retry dentro do método `complete`; ele devolve os hints tipados para a camada superior. Quando a chamada passa por `CredentialedProviderInvoker` com `ProviderResilience`, a camada de boundary aplica uma política comum e limitada: somente erros `ModelProviderError` explicitamente retryable podem repetir, `maxAttempts` inclui a chamada inicial, `Retry-After` tem precedência sobre o backoff configurado e o `AbortSignal` interrompe espera e novas chamadas. Erros permanentes, autenticação, configuração e cancelamento saem sem repetição. A API legada `chat` mantém seus retries e seu formato público existente para não alterar o comportamento atual.

`ProviderResilience` também mantém um token bucket por `credentialScope` e um circuit breaker por `(providerId, credentialScope)`. Os snapshots contêm somente scopes opacos, contagens, timestamps, cooldowns e estados; a aplicação hospedeira decide quando persistir e restaurar esse estado. Não há scheduler ou fila durável nesta camada.

## Cancelamento e duração da tarefa

O `AbortSignal` do chamador é composto com o timeout da chamada e com o deadline recebido. O sinal composto é entregue diretamente ao `fetch`, de modo que o cancelamento alcança o transporte. Cancelamento do chamador é classificado como `cancellation` e nunca vira retry. Expiração do timeout ou do deadline é classificada como `timeout`.

O timeout encerra somente a chamada em andamento. `ModelProvider` não persiste estado da tarefa, não remove checkpoints e não decide que uma tarefa durável terminou. A separação permite que uma tarefa seja retomada posteriormente por scheduler ou checkpoint sem confundir falha transitória de request com falha terminal da tarefa.

## Segurança operacional

O novo caminho não registra prompt, resposta integral, credencial ou referências de credencial. O contexto de chamada não é serializado no corpo enviado ao Ollama; referências de credencial e escopo permanecem metadados internos e não são usados como autorização pelo adapter. O teste de isolamento cobre simultaneamente payload, eventos de log e estado serializado do provider. Nenhuma chave real é necessária nos testes ou na CI.

A implementação mantém `chat`, `embed`, a factory e o provider default existentes. `complete` prova a adaptação de exatamente um provider, enquanto os consumidores atuais continuam usando suas APIs públicas legadas.

## Eventos de observabilidade

Os eventos opcionais da política carregam somente `providerId`, `credentialScope`, timestamps, tentativa, motivo de espera e categoria tipada do erro. Não carregam prompt, resposta, `credentialRef`, segredo ou headers. O snapshot de resiliência segue a mesma regra de dados mínimos.

## Fora de escopo

A Issue #44 não implementa o provider NVIDIA, BYOK completo, limiter, circuit breaker, scheduler durável, migração de todos os providers ou troca do provider padrão. Nesta base, a política de limiter/circuit breaker/retry comum é adicionada pela Issue #47 no `CredentialedProviderInvoker`; scheduler, fila durável e a decisão final de retomada continuam fora deste contrato. Também não se define contrato para embeddings, reranking, visão ou agentes externos.
