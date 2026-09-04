# Contrato de eventos e projeção durável do daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir exclusivamente a Issue #38 para que daemon e web compartilhem envelopes versionados, projetem o estado durável de Missions e CapabilityInvocations e reconectem sem repetir efeitos ou alterar o backend.

**Architecture:** Endurecer o contrato já existente em `shared/daemon-event-contract.ts`, mantendo o `EventBus` como barramento interno e filtrando a fronteira WebSocket por uma allowlist operacional. O snapshot será produzido a partir do `MissionStore` da #50, com projeções sanitizadas e limitadas, enquanto `DaemonProjection` controla cursor, handshake, broadcast isolado e backpressure bounded. O frontend usará o mesmo validator, um reducer de projeção durável e uma conexão que somente observa, detecta gaps e recupera por snapshot.

**Tech Stack:** TypeScript strict, Bun 1.3.9, Fastify 5, `@fastify/websocket`, `bun:sqlite`, React/Zustand, Vite e testes locais com `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-04-daemon-event-durable-projection-design.md`

## Global Constraints

- Trabalhar somente na Issue #38, em `issue-38-durable-event-projection`, baseada em `main` no commit `13ffe20` que contém o PR #75.
- Usar `MissionStore`/`SqliteMissionStore` da #50 somente como fonte durável de leitura, sem criar scheduler, state machine ou persistence layer.
- Usar `version: 1`, `eventId`, `sequence`, `event`, `data` e `timestamp` em todos os envelopes, inclusive snapshot inicial e resync.
- `sequence` é global por processo, monotônico e atribuído a envelopes públicos aceitos para transmissão; não há promessa de exactly-once distribuído.
- A allowlist pública contém somente `snapshot`, `mission`, `plan_revision`, `approval`, `capability_invocation`, `capability_availability`, `context_request`, `human_decision`, `mission_verification`, `daemon` e `log`.
- `thought`, `task`, `wave` e `budget` podem permanecer internos ao `EventBus`, mas não podem ser enviados como contrato público deste WebSocket.
- Validar envelope e payload antes de avançar cursor, alterar store, emitir evento DOM ou chamar callback de aplicação.
- Diagnósticos não podem ecoar payloads, exceções, URLs, Authorization, chaves, prompts, respostas, CoT ou schemas privados.
- Não enfileirar comandos ou efeitos para reconexão; não reenviar `agent.input`, `daemon.setMode`, `emergencyBrake`, invocações ou qualquer comando anterior.
- Fila de handshake e limites de cliente devem ser finitos; falhas de um cliente não interrompem siblings.
- Não usar `skip`, `todo`, `.only`, `continue-on-error`, `|| true`, filtros ocultos, assertions enfraquecidas ou dependências novas.
- Preservar estados `waiting_for_context`, `waiting_for_approval`, `waiting_for_capability`, `waiting_for_provider` e `waiting_for_budget` como estados legítimos.

---

### Task 1: Contrato compartilhado, schemas de payload e diagnósticos fail-closed

**Files:**
- Modify: `shared/daemon-event-contract.ts`
- Modify: `shared/daemon-event-contract.test.ts`
- Modify: `web/tsconfig.json` somente se a compilação exigir incluir explicitamente `../shared/**/*.ts`

**Interfaces:**
- `ALLOWED_DAEMON_EVENTS` e `AllowedDaemonEvent` deixam de incluir eventos legados de wave/task/thought/budget.
- `DaemonEventDataMap` define o payload de cada evento público.
- `DaemonEventEnvelope<T = DaemonEventData>` mantém os campos do wire e os correlators opcionais `missionId`, `invocationId` e `sessionId`.
- `DaemonSnapshot` contém `protocolVersion: 1`, capabilities de transporte, status sanitizado, capabilities reais, `cursor`, `missions` e `invocations`.
- `DaemonMissionProjection`, `DaemonInvocationProjection` e `DaemonDurableProjection` definem os shapes limitados usados pelo snapshot.
- `isDaemonEventData(event, data)`, `validateDaemonEventEnvelope(value)` e `isDaemonEventEnvelope(value)` rejeitam forma, versão, evento, payload, timestamp, campos opcionais e campos extras inválidos.
- `safeProtocolDiagnostic(code)` retorna somente `{ code }`, com códigos fixos para `invalid_envelope`, `unsupported_version`, `unknown_event`, `invalid_payload`, `duplicate_event`, `sequence_gap`, `out_of_order`, `resync_required`, `client_send_failed`, `client_backpressure` e `transport_error`.

- [ ] **Step 1: Escrever testes RED para contrato e payloads**

Adicionar casos determinísticos que usem envelopes construídos localmente:

```ts
it("accepts a valid snapshot and operational event envelope", () => {
  expect(isDaemonEventEnvelope(validSnapshotEnvelope)).toBe(true);
  expect(isDaemonEventEnvelope(validInvocationEnvelope)).toBe(true);
});

for (const invalid of [
  { ...validInvocationEnvelope, version: 2 },
  { ...validInvocationEnvelope, event: "future_event" },
  { ...validInvocationEnvelope, event: "capability_invocation", data: { status: "not-a-status" } },
  { ...validInvocationEnvelope, sequence: 0 },
  { ...validInvocationEnvelope, timestamp: "not-a-date" },
  { ...validInvocationEnvelope, authorization: "Bearer secret" },
]) {
  expect(isDaemonEventEnvelope(invalid)).toBe(false);
}
```

Cobrir também `data` ausente, `missionId` numérico, snapshot com cursor diferente da sequência, estado `waiting_for_provider`, log que contém `Authorization` ou prompt, e diagnóstico serializado sem texto de entrada.

- [ ] **Step 2: Rodar o teste focado e confirmar RED**

Run: `bun test shared/daemon-event-contract.test.ts`

Expected: FAIL porque os novos eventos, payload guards e snapshot durável ainda não existem.

- [ ] **Step 3: Implementar o contrato mínimo compartilhado**

Definir unions e guards manuais, sem importar dependências externas. Cada payload deve aceitar somente os campos públicos necessários. Usar listas fechadas para Mission states, InvocationStatus, plan status, approval state e delivery state. Rejeitar chaves desconhecidas no envelope e nos payloads. Para texto livre de log, limitar comprimento e rejeitar padrões de credencial, header, prompt, resposta integral e raciocínio.

O construtor de envelope usado pelo backend deverá ser tipado assim:

```ts
export function createDaemonEventEnvelope<E extends AllowedDaemonEvent>(
  event: E,
  data: DaemonEventDataMap[E],
  sequence: number,
  ids: { eventId: string; timestamp: string },
  correlation?: { missionId?: string; invocationId?: string; sessionId?: string },
): DaemonEventEnvelope<DaemonEventDataMap[E]>;
```

- [ ] **Step 4: Rodar novamente e confirmar GREEN**

Run: `bun test shared/daemon-event-contract.test.ts`

Expected: todos os casos do contrato passam, incluindo versão inválida, evento desconhecido, payload inválido e ausência de conteúdo sensível no diagnóstico.

- [ ] **Step 5: Commitar o contrato**

```bash
git add shared/daemon-event-contract.ts shared/daemon-event-contract.test.ts web/tsconfig.json
git commit -m "feat: harden shared daemon event contract"
```

---

### Task 2: Projeção sanitizada de Mission e CapabilityInvocation no snapshot

**Files:**
- Create: `cli/src/daemon/durable-projection.ts`
- Create: `cli/src/daemon/durable-projection.test.ts`
- Modify: `cli/src/daemon/rpc-gateway.ts`
- Modify: `cli/src/daemon/main.ts`
- Modify: `cli/src/daemon/enhanced-server.test.ts`

**Interfaces:**
- `projectMission(mission: Mission): DaemonMissionProjection` remove `originalIntent`, `sanitizedOriginalIntent`, `constraints`, `acceptanceCriteria`, `contextRefs`, `inputRefs`, fingerprints e conteúdo de perguntas.
- `projectInvocation(invocation: CapabilityInvocation): DaemonInvocationProjection` preserva apenas IDs, status, delivery state, owner, capability e timestamps, sem result body, idempotency key, effect fingerprint ou error bruto.
- `projectDaemonStatus(status: DaemonStatusResult): DaemonStatusProjection` copia somente campos operacionais tipados e omite `operationalState` e `controlPlane`.
- `readDurableProjection(store: MissionStore, limits?: { maxMissions?: number; maxInvocations?: number }): Promise<DaemonDurableProjection>` faz consultas bounded e retorna arrays determinísticos.
- `RpcGateway` aceita `missionStore?: MissionStore` e expõe `async getProjectionSnapshot(): Promise<DaemonSnapshot>`.
- `DaemonServer` recebe o `MissionStore` opcional sem alterar o construtor existente para callers que não o fornecem.

- [ ] **Step 1: Escrever testes RED de projeção e segurança**

Usar `SqliteMissionStore(":memory:")` e fixtures de Mission/CapabilityInvocation já existentes no diretório `cli/src/mission`, sem provider ou rede. Verificar Mission `EXECUTING`, `WAITING_FOR_PROVIDER` e `WAITING_FOR_BUDGET`, Invocation `RUNNING` e `PENDING`, limites de quantidade e ausência de strings proibidas:

```ts
const projected = projectMission(missionWithSensitiveFields);
expect(projected).toMatchObject({ missionId: mission.missionId, state: "waiting_for_provider" });
expect(JSON.stringify(projected)).not.toContain(mission.originalIntent);
expect(JSON.stringify(projected)).not.toContain("apiKey");

const snapshot = await readDurableProjection(store, { maxMissions: 1, maxInvocations: 2 });
expect(snapshot.missions).toHaveLength(1);
expect(snapshot.invocations.length).toBeLessThanOrEqual(2);
```

- [ ] **Step 2: Rodar o teste focado e confirmar RED**

Run: `bun test cli/src/daemon/durable-projection.test.ts`

Expected: FAIL porque as funções de projeção e o snapshot durável ainda não existem.

- [ ] **Step 3: Implementar a projeção somente leitura**

Mapear Mission e invocações para shapes definidos no contrato compartilhado. Usar limites finitos padrão, ordenar pela ordem retornada pelo store sem reordenar por dados não confiáveis e nunca incluir campos raw. O status do `SessionManager` deve ser copiado campo a campo, omitindo `operationalState` e `controlPlane`.

`getProjectionSnapshot()` deve montar:

```ts
return {
  protocolVersion: 1,
  transportCapabilities: {
    orderedEvents: true,
    authoritativeSnapshot: true,
    resync: true,
    durableMissions: Boolean(this.missionStore),
    durableInvocations: Boolean(this.missionStore),
  },
  cursor: 0,
  status: projectDaemonStatus(this.sessionManager.getStatusSnapshot()),
  capabilities: status.capabilities,
  missions: durable.missions,
  invocations: durable.invocations,
};
```

No entrypoint, inicializar e fechar o `SqliteMissionStore` existente de #50 em `.ouroboros/missions.db`, passando a mesma instância ao `DaemonServer`. Não criar tabela ou camada nova.

- [ ] **Step 4: Rodar testes de projeção e integração do snapshot**

Run: `bun test cli/src/daemon/durable-projection.test.ts cli/src/daemon/enhanced-server.test.ts`

Expected: snapshot de conexão contém `protocolVersion`, capabilities, cursor, Mission e invocation sanitizadas; estados waiting continuam intactos.

- [ ] **Step 5: Commitar a projeção durável**

```bash
git add cli/src/daemon/durable-projection.ts cli/src/daemon/durable-projection.test.ts cli/src/daemon/rpc-gateway.ts cli/src/daemon/main.ts cli/src/daemon/enhanced-server.test.ts
git commit -m "feat: project durable missions in daemon snapshot"
```

---

### Task 3: Handshake assíncrono, sequência e isolamento do broadcast

**Files:**
- Modify: `cli/src/daemon/daemon-projection.ts`
- Modify: `cli/src/daemon/server.ts`
- Modify: `cli/src/daemon/event-bus.ts`
- Modify: `cli/src/daemon/daemon-projection.test.ts`
- Modify: `cli/src/daemon/enhanced-server.test.ts`

**Interfaces:**
- `DaemonProjectionOptions.snapshot(cursor): DaemonSnapshot | Promise<DaemonSnapshot>`.
- `async connectClient(client: ProjectionClient): Promise<void>` envia um único snapshot envelope antes de liberar eventos normais.
- `broadcast<E extends AllowedDaemonEvent>(event: E, data: DaemonEventDataMap[E], correlation?: DaemonEventCorrelation): void` valida payload, cria sequência e isola cada cliente.
- A fila de eventos durante handshake tem limite explícito `maxPendingEvents`, e clientes prontos são removidos quando `bufferedAmount > maxBufferedAmount`.
- `EventBus.EventMap` conhece os fatos operacionais públicos adicionais, mas `server.ts` encaminha somente a allowlist e normaliza `log` sem o `Date` interno.

- [ ] **Step 1: Escrever testes RED de handshake e isolamento**

Expandir o fake client para controlar `bufferedAmount`, falha em `send`, fechamento e mensagens. Cobrir:

```ts
it("sends one snapshot envelope before queued events", async () => {
  let releaseSnapshot!: () => void;
  const snapshotReady = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  const projection = new DaemonProjection({
    snapshot: async (cursor) => { await snapshotReady; return createSnapshot(cursor); },
    maxPendingEvents: 2,
  });
  const client = new FakeClient();
  const connecting = projection.connectClient(client);
  projection.broadcast("mission", missionEvent);
  releaseSnapshot();
  await connecting;
  expect(client.messages.map(readEnvelope).map((value) => value.event))
    .toEqual(["snapshot", "mission"]);
});

it("isolates send failure and bounded slow clients", () => {
  const projection = new DaemonProjection({ snapshot: createSnapshot, maxBufferedAmount: 10 });
  const failing = new FakeClient({ throwOnSend: true });
  const slow = new FakeClient({ bufferedAmount: 11 });
  const healthy = new FakeClient();
  projection.connectClient(failing);
  projection.connectClient(slow);
  projection.connectClient(healthy);
  projection.broadcast("mission", missionEvent);
  expect(failing.closeCalls).toBe(1);
  expect(slow.closeCalls).toBe(1);
  expect(healthy.messages).toHaveLength(2);
});
```

Adicionar teste de server que emite `thought`, `wave` ou `budget` e confirma que nenhum envelope é transmitido, enquanto `mission` válido é transmitido.

- [ ] **Step 2: Rodar os testes focados e confirmar RED**

Run: `bun test cli/src/daemon/daemon-projection.test.ts cli/src/daemon/enhanced-server.test.ts`

Expected: FAIL porque o projection atual é síncrono, não possui estado de handshake/fila limitada e ainda aceita a allowlist antiga.

- [ ] **Step 3: Implementar handshake e broadcast bounded**

Guardar `Map<ProjectionClient, ClientState>` com `phase: "handshaking" | "ready"` e `pending: DaemonEventEnvelope[]`. Capturar uma sequência positiva no início do handshake, ler o snapshot, forçar `snapshot.cursor` e `envelope.sequence` a esse cursor, enviar o snapshot e então liberar/flushar somente eventos posteriores. Ao atingir `maxPendingEvents`, remover e fechar somente aquele cliente.

Antes de incrementar a sequência, chamar `isDaemonEventData`. Envelopes inválidos não avançam cursor. Para cada cliente pronto, testar `readyState` e `bufferedAmount`, chamar `send` em `try/catch`, remover o cliente que falhar e continuar iterando siblings. Nunca armazenar fila ilimitada.

No servidor, guardar unsubscribe do wildcard uma única vez. Normalizar o wildcard para `{ event, data }`, não usar fallback `rawData.event || rawData.type`, e suprimir eventos legados sem dispatch. Remover os handlers `close`/`error` ao desconectar cada socket.

- [ ] **Step 4: Rodar testes de backend e confirmar GREEN**

Run: `bun test cli/src/daemon/daemon-projection.test.ts cli/src/daemon/enhanced-server.test.ts cli/src/daemon/event-bus.test.ts`

Expected: snapshot e eventos válidos usam o mesmo envelope, eventos internos legados não saem, erro de um cliente não afeta outro e limites de buffer removem clientes lentos.

- [ ] **Step 5: Commitar o transporte backend**

```bash
git add cli/src/daemon/daemon-projection.ts cli/src/daemon/server.ts cli/src/daemon/event-bus.ts cli/src/daemon/daemon-projection.test.ts cli/src/daemon/enhanced-server.test.ts
git commit -m "feat: isolate daemon event clients and handshake"
```

---

### Task 4: Reducer/store da projeção durável no frontend

**Files:**
- Create: `web/src/lib/daemon-projection.ts`
- Create: `web/src/lib/daemon-projection.test.ts`
- Create: `web/src/stores/daemon-projection-store.ts`
- Modify: `web/src/hooks/use-event-bus.ts`
- Modify: `web/src/hooks/use-live-mission-control.ts` somente para aceitar o detalhe `{ event, data, envelope }` sem interpretar eventos legados

**Interfaces:**
- `DaemonProjectionState` contém `missions`, `invocations`, `approvals`, `lastEventId` e `cursor`.
- `replaceFromSnapshot(snapshot: DaemonSnapshot): DaemonProjectionState` substitui a projeção sem inferir execução.
- `applyDaemonEnvelope(state, envelope): DaemonProjectionState` aplica apenas fatos públicos já validados.
- `useDaemonProjectionStore` expõe `replaceFromSnapshot`, `applyEnvelope` e `reset` como operações de projeção, nunca comandos ao daemon.

- [ ] **Step 1: Escrever testes RED do reducer e isolamento de estado**

```ts
it("replaces durable projection from running and waiting snapshots", () => {
  const running = replaceFromSnapshot(snapshotWithMission("executing"));
  const waiting = replaceFromSnapshot(snapshotWithMission("waiting_for_provider"));
  expect(running.missions["mission-1"].state).toBe("executing");
  expect(waiting.missions["mission-1"].state).toBe("waiting_for_provider");
});

it("updates an invocation from an accepted operational event without exposing raw data", () => {
  const next = applyDaemonEnvelope(initialState, invocationEnvelope);
  expect(next.invocations["invocation-1"].status).toBe("running");
  expect(JSON.stringify(next)).not.toContain("prompt");
});
```

Cobrir Mission created/updated, plan revision accepted, approval changed, invocation waiting/running/completed/failed, capability availability, context/human decision, verification e substituição integral por snapshot.

- [ ] **Step 2: Rodar o teste focado e confirmar RED**

Run: `bun test web/src/lib/daemon-projection.test.ts`

Expected: FAIL porque reducer e store durável ainda não existem.

- [ ] **Step 3: Implementar reducer e store mínimos**

Usar cópia imutável e IDs como chaves. Eventos `mission` atualizam somente a projeção da Mission, `capability_invocation` atualiza somente a invocation, `plan_revision` pode avançar `currentPlanRevisionId` apenas em status `accepted`, e os demais fatos atualizam registros de observação sem criar estados operacionais inventados. O snapshot deve substituir todos os mapas para apagar dados que o backend não mais retorna.

No hook, aplicar snapshot/evento somente nos callbacks já chamados pelo `DaemonEventStream`. Emitir DOM apenas depois da validação e com detalhe exato:

```ts
window.dispatchEvent(new CustomEvent("daemon:event", {
  detail: { event: envelope.event, data: envelope.data, envelope },
}));
```

Não acessar `rawData.type`, não despachar eventos desconhecidos e não modificar Mission ao receber `disconnected`.

- [ ] **Step 4: Rodar reducer, stream e build web**

Run: `bun test web/src/lib/daemon-projection.test.ts web/src/lib/daemon-event-stream.test.ts && bun run --cwd web build`

Expected: projeção passa pelos cenários running/waiting e build web permanece verde.

- [ ] **Step 5: Commitar a projeção frontend**

```bash
git add web/src/lib/daemon-projection.ts web/src/lib/daemon-projection.test.ts web/src/stores/daemon-projection-store.ts web/src/hooks/use-event-bus.ts web/src/hooks/use-live-mission-control.ts
git commit -m "feat: apply durable daemon projection in web"
```

---

### Task 5: Stream ordenado, resync e lifecycle idempotente da conexão

**Files:**
- Modify: `web/src/lib/daemon-event-stream.ts`
- Modify: `web/src/lib/daemon-event-stream.test.ts`
- Modify: `web/src/lib/daemon-websocket-connection.ts`
- Modify: `web/src/lib/daemon-websocket-connection.test.ts`

**Interfaces:**
- `DaemonEventStream.accept(value: unknown): StreamDecision` usa somente o validator compartilhado.
- Snapshot exige `data.cursor === envelope.sequence`, aceita cursor autoritativo posterior e limpa `awaitingResync`.
- Evento normal exige sequência exatamente `cursor + 1`; duplicata por `eventId`, gap e ordem inválida são decisões distintas sem callback de aplicação.
- `DaemonWebSocketConnection` mantém no máximo um timer, não mantém fila de comandos e remove handlers ao desconectar.

- [ ] **Step 1: Escrever testes RED para todos os cenários de cursor/reconnect**

Adicionar testes determinísticos para envelope inválido, versão incompatível, evento desconhecido, payload inválido, duplicata, out-of-order, gap, snapshot de resync, reconnect recuperando Mission `executing`, reconnect recuperando `waiting_for_provider`, disconnect sem envio e sem callback de cancelamento:

```ts
expect(stream.accept(envelope("mission", 1, runningMission))).toBe("applied");
expect(stream.accept(envelope("mission", 1, runningMission, "same"))).toBe("duplicate");
expect(stream.accept(envelope("mission", 3, runningMission))).toBe("resync_required");
expect(stream.accept(snapshotEnvelope(4, waitingMission))).toBe("applied");
expect(stream.accept(envelope("capability_invocation", 5, waitingInvocation))).toBe("applied");
```

No fake socket, registrar contagem de sockets, sends, timers criados/limpos e handlers removidos. Depois de `disconnect()`, executar callbacks antigos e provar que nenhum novo socket/timer surge.

- [ ] **Step 2: Rodar os testes focados e confirmar RED**

Run: `bun test web/src/lib/daemon-event-stream.test.ts web/src/lib/daemon-websocket-connection.test.ts`

Expected: FAIL nos casos de payload compartilhado, snapshot inconsistente, handlers limpos e reconexão sem callback obsoleto.

- [ ] **Step 3: Implementar stream fail-closed e reconexão**

Remover validators duplicados de status/snapshot e chamar `validateDaemonEventEnvelope`. A ordem de decisão será: parsing/validation, duplicate ID, snapshot consistency, awaiting resync, out-of-order, gap, apply. Só `applied` chama `onSnapshot`/`onEnvelope`, lembra ID e avança cursor.

Em `disconnect()`, marcar `stopped`, incrementar generation, limpar timer, remover `onopen`, `onmessage`, `onclose` e `onerror`, fechar socket e publicar somente status desconectado. Em `onerror`, emitir `transport_error`, fechar o socket atual e agendar uma única reconexão; `onclose` não deve criar timer duplicado. O callback de `onSnapshot` é o único ponto que marca conexão como observavelmente conectada.

Ao receber `resync_required`, fechar somente o socket atual, não enviar mensagem de comando e deixar a próxima conexão obter novo snapshot. Nenhum payload ou comando anterior é armazenado.

- [ ] **Step 4: Rodar todos os testes frontend focados**

Run: `bun test web/src/lib/daemon-event-stream.test.ts web/src/lib/daemon-websocket-connection.test.ts web/src/lib/daemon-projection.test.ts`

Expected: todos os cenários de duplicata, gap, resync, running/waiting, reconnect, ausência de replay e cleanup passam.

- [ ] **Step 5: Commitar stream e lifecycle**

```bash
git add web/src/lib/daemon-event-stream.ts web/src/lib/daemon-event-stream.test.ts web/src/lib/daemon-websocket-connection.ts web/src/lib/daemon-websocket-connection.test.ts
git commit -m "fix: make daemon event resync idempotent"
```

---

### Task 6: Documentação pública e regressões de segurança/lifecycle

**Files:**
- Create: `docs/DAEMON_EVENT_CONTRACT.md`
- Modify: `cli/src/daemon/enhanced-server.test.ts`
- Modify: `cli/src/daemon/daemon-projection.test.ts`
- Modify: `web/src/lib/daemon-websocket-connection.test.ts`
- Modify: `web/src/lib/daemon-event-stream.test.ts`

**Interfaces:**
- A documentação deve publicar o envelope final, allowlist, payloads sanitizados, semântica global de cursor, snapshot/resync, disconnect/reconnect e limite de clientes.
- Os testes devem provar os 18 cenários exigidos pela Issue #38, sem provider ou rede externa real.

- [ ] **Step 1: Adicionar testes RED dos limites restantes**

Adicionar casos específicos para:

1. snapshot inicial com Mission durável;
2. envelope normal com mesma forma;
3. desconexão não chama `cancelMission`, `cancelInvocation` ou comando;
4. reconnect recupera `executing`;
5. reconnect recupera `waiting_for_*`;
6. nenhuma mensagem é reenviada automaticamente;
7. falha de `send` de um cliente não afeta outro;
8. cliente lento é removido por limite finito;
9. wildcard/socket/timer são limpos em stop/unmount;
10. nenhum envelope/diagnóstico contém secret, prompt, CoT, Authorization ou provider response.

- [ ] **Step 2: Rodar as suítes focadas e confirmar cada falha nova**

Run: `bun test shared/daemon-event-contract.test.ts cli/src/daemon/durable-projection.test.ts cli/src/daemon/daemon-projection.test.ts cli/src/daemon/enhanced-server.test.ts web/src/lib/daemon-projection.test.ts web/src/lib/daemon-event-stream.test.ts web/src/lib/daemon-websocket-connection.test.ts`

Expected: testes novos passam; qualquer regressão deve ser corrigida na implementação, sem marcar caso como ignorado.

- [ ] **Step 3: Escrever a documentação sem declarar garantias fora do escopo**

Documentar um exemplo de envelope, a regra `sequence === cursor + 1`, o fato de que snapshot é source of truth para a projeção, a ação conservadora em gap, a ausência de replay exactly-once, a fila de handshake bounded e o fechamento de clientes lentos. Declarar explicitamente que autenticação WebSocket, novo scheduler, persistência nova, provider e redesign da UI não fazem parte desta PR.

- [ ] **Step 4: Rodar a suíte focada completa e revisar segurança**

Run: `bun test shared/daemon-event-contract.test.ts cli/src/daemon/durable-projection.test.ts cli/src/daemon/daemon-projection.test.ts cli/src/daemon/enhanced-server.test.ts web/src/lib/daemon-projection.test.ts web/src/lib/daemon-event-stream.test.ts web/src/lib/daemon-websocket-connection.test.ts`

Expected: todos os testes focados passam e grep no código alterado não encontra fallback `rawData.event || rawData.type`, dispatch de evento desconhecido, fila sem limite ou logging de payload bruto.

- [ ] **Step 5: Commitar documentação e cobertura final**

```bash
git add docs/DAEMON_EVENT_CONTRACT.md cli/src/daemon web/src/lib web/src/hooks
git commit -m "test: cover durable daemon event reconnect contract"
```

---

### Task 7: Verificação obrigatória, revisão e entrega de uma única PR

**Files:**
- Modify only files already justified by Tasks 1-6.

**Interfaces:**
- O resultado final deve compilar runtime e web, manter o baseline verde e conter exatamente uma branch/PR dedicada à #38.

- [ ] **Step 1: Inspecionar escopo, status e diff**

```bash
git status --short --branch
git diff main...HEAD --stat
git diff main...HEAD --check
git diff main...HEAD --name-only
```

Expected: somente arquivos do contrato/projeção/reconexão/testes/docs da #38 aparecem. Arquivos `.agent/memory` e `$JCODE_SCRATCH_DIR` permanecem fora do staging.

- [ ] **Step 2: Executar o baseline exatamente como solicitado**

```bash
bun install --frozen-lockfile
cd web && bun install --frozen-lockfile && cd ..
bun run check
git diff --check
```

Expected: instalações congeladas não alteram lockfiles, `bun run check` passa com a quarentena existente sem fabricar verde e `git diff --check` não reporta erro.

- [ ] **Step 3: Executar novamente as suítes focadas**

```bash
bun test shared/daemon-event-contract.test.ts \
  cli/src/daemon/durable-projection.test.ts \
  cli/src/daemon/daemon-projection.test.ts \
  cli/src/daemon/enhanced-server.test.ts \
  web/src/lib/daemon-projection.test.ts \
  web/src/lib/daemon-event-stream.test.ts \
  web/src/lib/daemon-websocket-connection.test.ts
```

Expected: todos os testes da #38 passam localmente, sem provider/rede externa.

- [ ] **Step 4: Fazer revisão final orientada pelos critérios de aceite**

Confirmar manualmente no diff que:

- snapshot e eventos normais usam o mesmo envelope e versão;
- snapshot lê `MissionStore`, não memória local da UI;
- disconnect não chama autoridade de Mission/Invocation;
- reconnect só recebe snapshot e não repete command/effect;
- duplicatas não chegam ao reducer;
- gaps/out-of-order exigem snapshot;
- eventos desconhecidos/legados não chegam ao DOM;
- falha e backpressure são isolados por cliente;
- wildcard, socket e timers têm cleanup;
- nenhum segredo, prompt, CoT ou resposta integral é transmitido;
- nenhuma alteração foi feita em #50 além do ponto de leitura necessário.

- [ ] **Step 5: Commitar qualquer correção final e publicar a branch**

```bash
git diff --check
git add docs/superpowers/specs/2026-09-04-daemon-event-durable-projection-design.md \
  docs/superpowers/plans/2026-09-04-daemon-event-durable-projection.md \
  docs/DAEMON_EVENT_CONTRACT.md shared cli/src/daemon web/src/hooks web/src/lib web/src/stores
git commit -m "fix: close daemon event reconnect contract gaps"
git push -u origin issue-38-durable-event-projection
```

- [ ] **Step 6: Abrir exatamente uma PR contra `main` e parar**

Antes de criar a PR, salvar a descrição final em `$JCODE_SCRATCH_DIR/issue-38-pr-body.md`, contendo `Fixes #38`, o envelope final, sequence/cursor, snapshot/resync, disconnect/reconnect, backpressure, cleanup, arquivos principais, testes, comandos e resultados, além das limitações fora do escopo. Usar uma única criação de PR:

```bash
gh pr create \
  --base main \
  --head issue-38-durable-event-projection \
  --title "fix: normalize daemon events and durable reconnect" \
  --body-file "$JCODE_SCRATCH_DIR/issue-38-pr-body.md"
```

Não fazer merge, não abrir segunda PR e não iniciar outra issue após a criação.

### Self-review do plano

- **Cobertura do spec:** contrato e segurança estão na Task 1; snapshot durável e integração com #50 na Task 2; handshake, sequence, broadcast, backpressure e isolamento na Task 3; reducer/store e ausência de dispatch desconhecido na Task 4; gaps, duplicatas, resync, reconnect e cleanup na Task 5; documentação, regressões e os 18 cenários obrigatórios na Task 6; baseline e PR única na Task 7.
- **Placeholders:** não há decisões pendentes, tarefas sem arquivo ou comandos com caminho simbólico. Os parâmetros genéricos em assinaturas TypeScript são tipos, não marcadores de preenchimento.
- **Consistência:** `DaemonEventDataMap`, `DaemonEventCorrelation`, `DaemonSnapshot`, `DaemonMissionProjection`, `DaemonInvocationProjection` e `DaemonDurableProjection` são definidos no contrato e usados com os mesmos nomes nas tarefas posteriores. O snapshot é assíncrono no gateway e no projection, mas continua uma única mensagem de wire.
- **Escopo:** nenhuma tarefa altera a máquina de estados, scheduler ou persistência da #50. A única integração durável prevista é leitura sanitizada do `MissionStore` existente.

