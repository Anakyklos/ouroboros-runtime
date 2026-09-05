# Contrato de eventos e projeção durável do daemon

## Escopo

Este design implementa exclusivamente a Issue #38 sobre a `main` que contém o PR #75 da Issue #50. A implementação anterior da #38, incorporada pelo PR #53, permanece a base de compatibilidade do transporte, mas será endurecida para projetar o runtime executivo atual. O WebSocket continua sendo apenas transporte de observação e projeção. Ele não cria, cancela, agenda, retenta ou persiste Missions.

A direção autoritativa usada neste design é:

```text
Intent → Mission → planner proposal → deterministic policy
→ Capability Registry → Capability Invocation → module owner
→ evidence/verification → Mission verification
```

`MissionEngine`, `MissionScheduler`, `SqliteMissionStore` e os contracts de #50 não serão duplicados nem reimplementados. O transporte só lerá o `MissionStore` existente e receberá fatos operacionais já produzidos por fontes explícitas.

## Estado encontrado

- `origin/main` atualizado aponta para `13ffe20`, merge do PR #75.
- O PR #53 já introduziu `shared/daemon-event-contract.ts`, `DaemonProjection`, `DaemonEventStream` e reconexão básica.
- O snapshot atual é baseado em `SessionManager.getStatusSnapshot()` e não inclui a projeção durável de `Mission` e `CapabilityInvocation`.
- O wildcard do `EventBus` ainda encaminha nomes legados como `task`, `wave` e `budget` quando eles coincidem com a allowlist antiga.
- A validação atual garante principalmente a forma do envelope, não o schema do payload de cada evento.

## Contrato de wire

O arquivo `shared/daemon-event-contract.ts` será a única definição compartilhada entre runtime e web. Todos os envelopes, inclusive o primeiro snapshot de conexão e snapshots de resync, terão esta forma:

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

`sequence` é um cursor monotônico global do processo, atribuído somente a envelopes aceitos para transmissão. Um snapshot usa a sequência capturada no início do handshake e carrega o mesmo valor em `data.cursor`. O protocolo não promete replay exatamente uma vez.

A allowlist pública será composta por `snapshot`, `mission`, `plan_revision`, `approval`, `capability_invocation`, `capability_availability`, `context_request`, `human_decision`, `mission_verification`, `daemon` e `log`. Os eventos internos legados `thought`, `wave`, `task` e `budget` continuam disponíveis somente para consumidores internos do `EventBus` e não são contrato público deste transporte.

Cada evento terá um schema discriminado, com IDs não vazios, enums conhecidos, timestamps válidos, números finitos e limites de texto. Payloads desconhecidos, campos de conteúdo livre sensível, campos extra não permitidos, prompts, respostas integrais, chaves, headers `Authorization` e credenciais serão rejeitados antes de qualquer callback ou mutação de store. Diagnósticos terão somente códigos fixos, sem ecoar entrada ou exceção.

O snapshot conterá:

- `protocolVersion: 1` e capabilities de transporte `orderedEvents`, `authoritativeSnapshot`, `resync`, `durableMissions` e `durableInvocations`;
- o status operacional sanitizado já fornecido pelo daemon, sem `operationalState` ou `controlPlane` arbitrários;
- capabilities reais de controle e métricas;
- uma lista limitada de `DaemonMissionProjection`, com identidade, estado atual, revisão atual, timestamps, contagens e IDs de invocações;
- uma lista limitada de `DaemonInvocationProjection`, com identidade, Mission, step, capability, owner, status, delivery state e timestamps;
- nenhum `originalIntent`, `inputRefs`, effect fingerprint, idempotency key, resultado integral ou schema privado de módulo.

Os estados `waiting_for_context`, `waiting_for_approval`, `waiting_for_capability`, `waiting_for_provider` e `waiting_for_budget` permanecem valores legítimos de Mission e nunca serão convertidos em falha.

## Backend e handshake

`RpcGateway.getProjectionSnapshot()` receberá opcionalmente a abstração `MissionStore` existente. Quando configurado pelo entrypoint, ele lerá `listMissions()` e `listInvocations()` e fará uma projeção sanitizada, limitada e somente leitura. O `SqliteMissionStore` default de #50 será inicializado e fechado pelo entrypoint do daemon, sem criar tabela, scheduler ou camada de persistência nova.

`DaemonProjection` aceitará um snapshot síncrono ou assíncrono. Uma conexão será registrada como handshaking, receberá exatamente um envelope `snapshot` e só então será liberada para eventos normais. Fatos que surgirem durante o handshake usarão uma fila temporária limitada; ao exceder o limite, a conexão será fechada e removida. Clientes lentos fora do handshake serão removidos quando `bufferedAmount` atingir o limite finito, sem fila ilimitada em RAM.

O servidor terá um único wildcard listener armazenado e removido no cleanup. A fronteira de transporte aceitará apenas eventos públicos explicitamente conhecidos e payloads validados. Uma falha de `send` ou de fechamento será diagnosticada de forma sanitizada e isolada do restante dos clientes.

## Frontend e resync

`DaemonEventStream` validará o envelope e o payload pelo contrato compartilhado antes de alterar stores, emitir eventos DOM ou avançar o cursor. Ele manterá uma janela limitada de `eventId`s para deduplicação.

- Snapshot válido substitui a projeção durável local e define o cursor autoritativo.
- Evento normal só é aplicado quando sua sequência é exatamente `cursor + 1`.
- Duplicata por `eventId` não chama reducer novamente.
- Sequência menor, fora de ordem ou snapshot inconsistente não altera a projeção.
- Gap marca `awaitingResync`, emite diagnóstico e fecha a conexão para obter novo snapshot.
- Enquanto aguarda resync, eventos normais são recusados.
- Reconexão nunca reenvia comandos ou efeitos. O cliente apenas abre socket, recebe snapshot e continua observando.

A UI terá uma projeção mínima de Missions e invocações, separada da store legada de waves/personas. O reducer só substitui ou atualiza dados fornecidos pelo daemon, sem inferir que conexão significa execução ou que desconexão significa cancelamento. Eventos DOM, quando mantidos para consumidores existentes, serão emitidos somente para eventos públicos já validados e com detalhe `{ event, data, envelope }`; eventos desconhecidos jamais serão despachados.

## Lifecycle e segurança

`DaemonServer.stop()` removerá o wildcard listener, invalidará clientes, fechará sockets e limpará referências. `DaemonWebSocketConnection.disconnect()` invalidará callbacks antigos, removerá handlers, cancelará o timer de backoff e fechará o socket sem agendar reconexão. Cada instância terá no máximo um timer de reconexão.

O transporte não transmitirá segredos ou conteúdo de raciocínio. Erros de parsing, validação e envio usarão apenas diagnósticos enumerados. Nenhum erro bruto, payload recebido ou mensagem de provider será concatenado em logs de protocolo.

## Verificação

Serão adicionados testes locais e determinísticos para contrato válido e inválido, versão, evento e payload desconhecidos, duplicata, ordem, gap, resync, handshake com snapshot, Missions em execução e em espera, desconexão sem alteração do backend, reconexão sem repetição, isolamento de clientes, limite de cliente lento, cleanup e ausência de segredos. O baseline obrigatório continuará sendo `bun install --frozen-lockfile`, instalação congelada em `web/`, `bun run check` e `git diff --check`.

Ficam explicitamente fora do escopo a migração para Go, autenticação WebSocket, exactly-once distribuído, novo scheduler, nova persistence layer, redesign da Mission Control, implementação das Issues #59 e #65/#66/#67, provider novo e remoção ampla de legado.
