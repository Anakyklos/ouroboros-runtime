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

## Autenticação do transporte

Todo `POST /rpc` exige bearer credential e o escopo server-side correspondente à operação. O mapa de operações é fechado; métodos desconhecidos ou parâmetros sem classificação são negados antes do gateway. `GET /health` permanece público e contém somente estado mínimo do processo. Requests com `Origin` só são aceitos quando a origem exata está configurada em `OUROBOROS_ALLOWED_ORIGINS`; preflight aceita apenas `POST`, `Authorization` e `Content-Type`.

### Admissão RPC

Depois da autenticação, validação JSON-RPC, autorização de escopo e
revalidação de revogação, o daemon admite no máximo 32 operações RPC
simultâneas por padrão. `maxInFlightRpcOperations` aceita inteiros de 1 a
1024. Uma operação autorizada que excede a capacidade recebe HTTP 503 com a
resposta genérica `SERVICE_UNAVAILABLE`; não há fila nem chamada ao gateway.
O limite conta operações, não bytes ou RSS.

Uma operação admitida mantém seu slot até o handler terminar **e** a resposta
ou transporte terminar. A desconexão do cliente, sozinha, não libera o slot,
pois o handler pode continuar usando SQLite. Esse accounting preserva o drain
de shutdown da #129. Ver `rpc-admission.test.ts`,
`rpc-admission.e2e.test.ts` e `daemon-shutdown-race.test.ts`.

O handshake de `GET /ws` autentica e exige `mission.read` antes da conexão e do snapshot. O browser troca seu bearer em memória por um cookie HttpOnly, SameSite=Strict, vinculado à Origin e válido por cinco minutos. Um timer compartilhado revalida credenciais e escopo a cada 500 ms somente enquanto há streams elegíveis ativos; ele é removido após o último stream fechar ou entrar em fechamento. Expiração, rotação ou revogação fecha o stream afetado. Provisionamento, rotação e revogação offline estão descritos em [LOCAL_CONTROL_AUTH.md](LOCAL_CONTROL_AUTH.md). O daemon não inicia sem ao menos uma credencial ativa.

### Admissão agregada

Após autenticação, validação de `mission.read` e validação de Origin, o daemon
reserva um slot antes do upgrade WebSocket e da leitura assíncrona do snapshot.
O limite padrão é 64 slots simultâneos entre handshakes e streams ativos; a
configuração `maxProjectionClients` pode definir outro inteiro positivo seguro.
Quando a capacidade está cheia, o handshake recebe HTTP 503 com erro genérico,
sem snapshot, registro de cliente conectado ou timer de revalidação. A
verificação de capacidade não substitui autenticação/autorização: clientes sem
credencial, escopo ou Origin válidos continuam recebendo a rejeição própria da
boundary mesmo quando cheia.

O slot de um handshake HTTP é liberado quando o request falha, é abortado ou o
daemon inicia cleanup. Depois do upgrade, o slot permanece contabilizado
enquanto o socket estiver ativo ou fechando, inclusive após envio de close
frame por revogação ou falha de snapshot. Só o evento real de `close` ou
`error` do WebSocket libera essa vaga; shutdown força a terminação do transporte
e deixa o mesmo callback concluir a liberação. A capacidade cheia não altera
estado de Mission, não fecha streams saudáveis e não afeta RPC HTTP autorizado.
O limite é de cardinalidade, não um orçamento global de bytes; permanecem os
limites individuais de fila de handshake e de bytes buffered.

O handshake do snapshot tem prazo padrão de 5 segundos, configurável por
snapshotHandshakeTimeoutMs. Timeout, desconexão e shutdown encerram a espera
do cliente e limpam seu timer. Um timeout fecha somente o cliente afetado e não
autoriza cancelar uma Promise de snapshot não cooperativa. O daemon observa o
resultado tardio para evitar rejeição não tratada e impede qualquer envio após
timeout/fechamento. O número de operações subjacentes ainda não liquidadas é
limitado separadamente por maxProjectionClients; enquanto esse limite estiver
ocupado, novas tentativas recebem HTTP 503 antes do upgrade. Uma operação que
nunca liquida pode manter essa admissão ocupada até o daemon reiniciar.

## Lifecycle

O daemon registra um único wildcard listener e mantém seu unsubscribe. `stop()` remove esse listener e fecha clientes. A conexão frontend remove handlers do socket, cancela o timer de backoff e invalida callbacks antigos. Cada instância mantém no máximo um timer de reconexão.

## Diagnósticos e segurança

Diagnósticos contêm somente códigos enumerados. Payloads malformados, versões incompatíveis, eventos desconhecidos e payloads não permitidos são rejeitados antes de alterar qualquer projection/store. O stream normal não inclui API keys, Authorization headers, credenciais, chain-of-thought, hidden prompts, prompts completos, respostas completas de provider ou schemas privados de outros módulos.

## Limitações deliberadas

Este contrato não implementa exactly-once distribuído, replay histórico, novo scheduler, nova persistence layer, provider, migração para Go, redesign completo da Mission Control ou as Issues #59 e #65/#66/#67.
