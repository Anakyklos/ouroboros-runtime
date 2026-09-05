# Contrato público de eventos do daemon

A Issue #38 usa um único envelope para o snapshot inicial, snapshots de resync e fatos operacionais normais:

```ts
interface DaemonEventEnvelope<T = DaemonEventData> {
  version: 1;
  eventId: string;
  sequence: number;
  event: AllowedDaemonEvent;
  data: T;
  timestamp: string;
  missionId?: string;
  invocationId?: string;
  sessionId?: string;
}
```

## Allowlist

Os eventos públicos são:

- `snapshot`
- `mission`
- `plan_revision`
- `approval`
- `capability_invocation`
- `capability_availability`
- `context_request`
- `human_decision`
- `mission_verification`
- `daemon`
- `log`

`thought`, `task`, `wave` e `budget` podem existir no `EventBus` interno, mas não são eventos públicos do WebSocket. O transporte não interpreta `rawData.type` nem usa fallback entre `event` e `type`.

## Snapshot e capabilities

`event: "snapshot"` carrega `data.protocolVersion = 1`, capabilities de transporte, cursor, status operacional sanitizado, capabilities reais do daemon, Missions e CapabilityInvocations. A projeção de Missions é lida pelo `MissionStore` durável da #50. O snapshot omite intent, prompts, constraints, context contents, input refs, fingerprints, idempotency keys, resultados, erros brutos e internals de módulos.

Os estados `waiting_for_context`, `waiting_for_approval`, `waiting_for_capability`, `waiting_for_provider` e `waiting_for_budget` são estados válidos e são preservados.

## Sequence e cursor

O cursor é global por processo do daemon. Snapshots usam o cursor corrente, sem consumir uma nova sequência por cliente. Eventos normais transmitidos incrementam a sequência somente quando existe ao menos um cliente elegível. A conexão recebe seu snapshot antes de eventos normais. Fatos que chegam durante uma leitura assíncrona de snapshot ficam em uma fila de handshake limitada.

O cliente aceita um evento normal somente quando `sequence === cursor + 1`. O mesmo `eventId` é deduplicado em uma janela limitada. Sequência repetida ou menor é rejeitada como `out_of_order`. Um salto de sequência não é aplicado, marca `resync_required` e provoca reconexão para obter um snapshot autoritativo. O protocolo não promete exactly-once distribuído.

## Disconnect e reconnect

O WebSocket é observacional. Fechar, perder ou reconectar o cliente não chama operações de Mission, Invocation ou connector. A conexão não persiste fila de comandos e não reenvia `agent.input`, controles, invocações ou efeitos. Após reconectar, o cliente recebe snapshot atual e continua a observação.

## Backpressure e isolamento

Cada cliente é avaliado isoladamente. Exceção em `send`, estado de socket inválido ou `bufferedAmount` acima do limite finito remove somente aquele cliente. A fila temporária de handshake também é bounded. Não há fila ilimitada em RAM e um cliente lento não bloqueia siblings.

## Lifecycle

O daemon registra um único wildcard listener e mantém seu unsubscribe. `stop()` remove esse listener e fecha clientes. A conexão frontend remove handlers do socket, cancela o timer de backoff e invalida callbacks antigos. Cada instância mantém no máximo um timer de reconexão.

## Diagnósticos e segurança

Diagnósticos contêm somente códigos enumerados. Payloads malformados, versões incompatíveis, eventos desconhecidos e payloads não permitidos são rejeitados antes de alterar qualquer projection/store. O stream normal não inclui API keys, Authorization headers, credenciais, chain-of-thought, hidden prompts, prompts completos, respostas completas de provider ou schemas privados de outros módulos.

## Limitações deliberadas

Este contrato não implementa autenticação WebSocket, exactly-once distribuído, replay histórico, novo scheduler, nova persistence layer, provider, migração para Go, redesign completo da Mission Control ou as Issues #59 e #65/#66/#67.
