# WebSocket Projection Contract Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current issue-38 branch. Every implementation step follows TDD: write the failing test, run it and confirm the expected failure, implement the minimum behavior, rerun the focused test, then run the affected suite.

**Goal:** Corrigir o contrato WebSocket entre daemon e web para que toda mensagem use um envelope versionado, validado e ordenado, com handshake/resync autoritativo, isolamento de clientes, backpressure controlado e cleanup completo, sem alterar o contrato interno do EventBus nem a máquina de estados da #50.

**Architecture:** Criar um contrato canônico em `shared/daemon-event-contract.ts`, consumido pelos builds do daemon e da web. O servidor manterá um cursor global monotônico por processo, produzirá envelopes apenas para uma allowlist explícita, enviará o handshake/resync como o mesmo envelope versionado e usará o snapshot real de `daemon.status`; o encaminhamento por cliente terá isolamento de exceções, limite de buffer e remoção controlada de sockets lentos. O frontend terá um decodificador/stream testável que valida antes de tocar stores, ignora eventos desconhecidos ou inválidos com diagnóstico seguro, deduplica por `eventId`, detecta duplicatas/lacunas por `sequence`, solicita resync sem repetir comandos e limpa socket/timer/listener no unmount.

**Tech Stack:** TypeScript strict, Bun test, Fastify 5, `@fastify/websocket`, WebSocket API, React hooks, Zustand, Vite.

**Spec:** GitHub Issue #38 (`Anakyklos/ouroboros-runtime#38`), body arquivado durante a análise em `/tmp/ouroboros-issue-38.md`.

## Global Constraints

- Manter `version: 1`, `eventId`, `sequence`, `event`, `data` e `timestamp` em todos os envelopes; campos opcionais de correlação só aparecem quando já existirem e forem seguros.
- `sequence` será global por processo do daemon, estritamente crescente apenas para eventos transmitidos; o cursor no handshake representa o último evento disponível e não promete replay exatamente uma vez.
- Usar allowlist explícita; eventos desconhecidos/malformados nunca chegam a `window.dispatchEvent` nem alteram stores.
- A projeção WebSocket é observacional: desconexão do navegador não cancela sessão, task, wave ou trabalho durable, e conexão ativa nunca significa automaticamente que o trabalho está rodando.
- Não transmitir chave, `Authorization`, prompt ou resposta integral; diagnósticos não devem incluir payload bruto, URL completa, tokens ou mensagens sensíveis.
- Reusar `daemon.status` e suas capabilities reais da issue #37; não corrigir nem reimplementar métricas/controles neste trabalho.
- Não alterar o EventBus interno para adotar o envelope; o adaptador do servidor é a fronteira de transporte.
- Não implementar persistência/scheduler/checkpoint durável da #50, autenticação WebSocket, exatamente-uma-vez distribuído ou uma nova máquina de estados.
- Não remover nem alterar entradas existentes em `scripts/quarantine-manifest.json`.
- Não criar novo pacote, workspace ou monorepo; uma pasta `shared/` e pequenos ajustes nos dois tsconfigs são permitidos para manter uma definição canônica.
- Fazer uma única PR contra `main`; não fazer merge local nem remoto.

---

### Task 1: Contrato compartilhado e validação estrutural

**Files:**
- Create: `shared/daemon-event-contract.ts`
- Create: `shared/daemon-event-contract.test.ts`
- Modify: `tsconfig.json:18-30` para incluir `shared/**/*.ts`
- Modify: `web/tsconfig.json:25` para incluir o contrato compartilhado, se o build exigir inclusão explícita

**Interfaces:**
- Produz `DAEMON_EVENT_VERSION = 1`.
- Produz `ALLOWED_DAEMON_EVENTS` somente com `"snapshot"`, `"log"`, `"task"`, `"daemon"`, `"wave"` e `"budget"`. `"snapshot"` é o único evento de controle wire para handshake e resync; `resync_required` existe apenas como decisão/diagnóstico local do stream, nunca como envelope externo.
- Produz `type AllowedDaemonEvent` e `interface DaemonEventEnvelope<T = unknown>` com `version`, `eventId`, `sequence`, `event`, `data`, `timestamp` e os campos opcionais seguros `taskId`, `stepId`, `sessionId`.
- Produz `type DaemonSnapshot` contendo `status: DaemonStatusProjection`, `capabilities` e `cursor`; `status` deve preservar os campos reais de `daemon.status` necessários para `applyDaemonMetrics` e capabilities, sem prompts/respostas.
- Produz `isDaemonEventEnvelope(value: unknown): value is DaemonEventEnvelope` e `isAllowedDaemonEvent(value: unknown): value is AllowedDaemonEvent`.
- A validação deve rejeitar versão diferente de 1, `eventId` vazio/não string, `sequence` inteiro não positivo ou timestamp inválido; rejeitar evento fora da allowlist; rejeitar data ausente; e rejeitar campos opcionais com tipo incorreto.
- Produz uma função de diagnóstico seguro, como `safeProtocolDiagnostic(kind, details?)`, que retorna somente códigos/categorias fixas, sem serializar o objeto recebido.

**Testes:**

- [ ] Escrever primeiro os testes de envelope válido: um envelope normal e um handshake/snapshot com campos opcionais passa pela validação e preserva `sequence`/`eventId`.
- [ ] Escrever teste de rejeição para versão, sequência, timestamp, `eventId`, `event` desconhecido e `data` ausente; cada caso deve falhar pela regra correspondente, não por exceção de runtime.
- [ ] Escrever teste de diagnóstico seguro verificando que payloads contendo `Authorization`, `apiKey`, prompt e resposta não aparecem no retorno.
- [ ] Rodar `bun test shared/daemon-event-contract.test.ts`; confirmar RED antes de criar a implementação.
- [ ] Implementar somente os tipos, allowlist e type guards necessários.
- [ ] Rodar novamente o teste focado; confirmar GREEN.

**Commit:** `git add shared tsconfig.json web/tsconfig.json && git commit -m "feat: add shared daemon websocket contract"`

---

### Task 2: Adaptador de transporte do daemon

**Files:**
- Create: `cli/src/daemon/daemon-projection.ts`
- Modify: `cli/src/daemon/server.ts:27-175`
- Modify: `cli/src/daemon/rpc-gateway.ts:26-45` para expor um snapshot sanitizado, se a implementação optar por centralizar o acesso ao `SessionManager`
- Modify: `cli/src/daemon/enhanced-server.test.ts`
- Create: `cli/src/daemon/daemon-projection.test.ts` se a lógica de cursor/broadcast ficar separada do servidor

**Interfaces:**
- Produz uma classe/funções de projeção com `nextEnvelope(event, data, correlation?)`, `currentSequence`, `snapshotEnvelope()` e `close()` ou equivalentes testáveis.
- O servidor terá um único listener wildcard registrado uma única vez em `initialize()` e guardará a função de unsubscribe; `stop()` chamará esse unsubscribe e limpará a coleção de clientes, timers e referências de sockets sem cancelar trabalho do `SessionManager`.
- O snapshot será autoritativo a partir de `RpcGateway`/`SessionManager.getStatusSnapshot()` e incluirá somente `status`, `capabilities` e cursor atual; se incluir sessões, mapeará apenas `id`, `status`, `createdAt` e `updatedAt`, removendo `metadata` e `contextSnapshot`.
- Toda mensagem de saída, inclusive a inicial, terá o mesmo `DaemonEventEnvelope`; nenhuma mensagem legada `{ event: "connected" }` será enviada.
- O servidor manterá `sequence` global por processo e `eventId` único por envelope; o handshake usará `event: "snapshot"` com `data` contendo o snapshot e cursor atual.
- A allowlist deve ser aplicada no adaptador: `thought` não será transmitido por padrão por poder conter conteúdo de raciocínio/resposta; eventos internos fora da allowlist geram diagnóstico seguro no daemon e não são enviados.
- Ao broadcast, iterar clientes isoladamente; um `send` que lança não interrompe os demais. Fechar/remover sockets com `readyState` inválido ou `bufferedAmount` acima de um limite documentado e finito, evitando fila ilimitada. Não enfileirar payloads sem limite.

**Testes:**

- [ ] Adicionar primeiro teste de handshake que conecta um cliente real a `/ws`, lê uma mensagem e confirma envelope versionado único, `event: "snapshot"`, `data.cursor`, `data.status` real e capabilities sem credenciais.
- [ ] Adicionar teste de evento normal que emite `daemon`/`task` no `EventBus` e confirma envelope com `sequence` crescente e sem inferência de `rawData.event || rawData.type`.
- [ ] Adicionar teste com dois clientes: uma falha de envio injetada em um cliente não impede o segundo de receber o evento.
- [ ] Adicionar teste de conexão lenta/inválida confirmando que o socket é removido quando excede o limite de `bufferedAmount` ou falha, sem crescimento de fila em memória.
- [ ] Adicionar teste de desconexão: fechar o cliente não muda o estado do daemon nem chama cancelamento da sessão; emitir evento depois da desconexão não gera exceção.
- [ ] Adicionar teste de stop/reinitialize que confirma que o listener wildcard antigo não continua publicando e que a coleção de clientes fica vazia.
- [ ] Rodar os testes focados e confirmar RED antes de modificar `server.ts`.
- [ ] Implementar o adaptador mínimo, rodar os testes focados e confirmar GREEN.

**Commit:** `git add cli/src/daemon/server.ts cli/src/daemon/rpc-gateway.ts cli/src/daemon/daemon-projection.ts cli/src/daemon/*test.ts && git commit -m "feat: envelope daemon websocket events"`

---

### Task 3: Stream validado, cursor e resync no frontend

**Files:**
- Create: `web/src/lib/daemon-event-stream.ts`
- Create: `web/src/lib/daemon-event-stream.test.ts`
- Modify: `web/src/hooks/use-event-bus.ts:5-172`
- Modify: `web/src/pages/mission-control.tsx:40-53`
- Modify: `web/src/stores/mission-control-store.ts:60-183` somente se for necessário adicionar uma operação explícita de aplicar snapshot; não redesenhar a store
- Modify: `web/src/stores/mission-control-store.test.ts` somente para a operação de snapshot, se criada

**Interfaces:**
- Produz `DaemonEventStream` testável com dependências injetáveis de `WebSocket`/timer/dispatcher, ou funções puras equivalentes para `acceptEnvelope`, `resetFromSnapshot`, `close` e `nextReconnectDelay`.
- A entrada recebe `unknown`, valida com o contrato compartilhado antes de qualquer store/evento DOM e retorna uma decisão explícita: `apply`, `duplicate`, `gap`, `out_of_order`, `invalid` ou `unknown`.
- O cursor inicial é `0`; primeiro evento aceito deve ser `sequence === 1` ou um snapshot; evento duplicado por `eventId` não reaplica; sequência menor/igual já vista não reaplica; salto de sequência marca resync necessário e não aplica o evento; evento fora de ordem não altera stores.
- Ao aceitar `snapshot`, substituir/reconciliar apenas a projeção suportada: `setDaemonConnected(true)`, `setCapabilities`, `applyDaemonMetrics` com métricas disponíveis reais e `tokens: null` quando indisponível; emitir no máximo um evento interno seguro para consumidores que precisem do snapshot. O snapshot não deve inventar wave/task/council se o backend não os fornece.
- Em `gap`, enviar somente uma mensagem de controle local de resync se o protocolo permitir; como não há comandos RPC no WebSocket, não repetir `daemon.setMode`, `daemon.emergencyBrake`, `agent.input` ou qualquer outro comando. A recuperação deve ocorrer pelo próximo snapshot/reconexão.
- Eventos normais aceitos mantêm o contrato local existente `{ type, data }` para `window.dispatchEvent("daemon:event")`; eventos desconhecidos/malformados nunca são despachados genericamente.
- `disconnect()` cancela timeout, fecha o socket, invalida callbacks da instância antiga e não agenda reconexão durante unmount explícito. `onclose` agenda no máximo um timer por instância. `connect()` não cria segundo socket se já houver OPEN ou CONNECTING.
- Corrigir `mission-control.tsx` para chamar `useEventBus` uma única vez e usar o retorno dessa chamada, eliminando o socket duplicado atual.
- Backoff deve ser limitado e determinístico nos testes; após handshake/snapshot, zerar tentativas sem apagar o cursor até o snapshot autoritativo ser aplicado.

**Testes:**

- [ ] Escrever primeiro testes puros do stream para envelope válido, inválido e evento desconhecido; verificar stores/dispatcher inalterados nos dois últimos.
- [ ] Escrever teste de duplicata com o mesmo `eventId` e `sequence`; verificar uma única aplicação.
- [ ] Escrever teste de lacuna (`1`, depois `3`) e fora de ordem (`2` depois de `3`); verificar decisão de resync e ausência de alteração silenciosa.
- [ ] Escrever teste de snapshot que restaura modo, métricas, capabilities e conexão a partir de `data.status` autoritativo e posiciona o cursor em `data.cursor`.
- [ ] Escrever teste de reconexão em que a primeira instância fecha, o timer é disparado, uma nova instância recebe snapshot e a visualização volta ao estado de execução/espera sem emitir comando de controle.
- [ ] Escrever teste de `disconnect`/unmount que confirma socket fechado, timeout cancelado e nenhum novo `WebSocket` após avanço do relógio.
- [ ] Escrever teste de dupla chamada de `useEventBus`/integração de página, ou uma asserção estrutural, confirmando que a página não cria duas conexões para o mesmo componente.
- [ ] Rodar `bun test web/src/lib/daemon-event-stream.test.ts web/src/stores/mission-control-store.test.ts` e confirmar RED antes da implementação.
- [ ] Implementar o stream/hook mínimo, rodar os testes focados e confirmar GREEN.

**Commit:** `git add web/src/lib/daemon-event-stream.ts web/src/lib/daemon-event-stream.test.ts web/src/hooks/use-event-bus.ts web/src/pages/mission-control.tsx web/src/stores/mission-control-store.ts web/src/stores/mission-control-store.test.ts && git commit -m "feat: validate websocket events and resync frontend"`

---

### Task 4: Regressões, documentação e critérios de segurança

**Files:**
- Modify: `docs/BASELINE.md` somente se a saída real do gate exigir registrar uma nova evidência, sem alterar a política de quarentena
- Create: `docs/superpowers/plans/2026-08-19-websocket-projection-contract.md` (este plano)
- Modify: `README.md` somente se for necessário documentar o novo formato público do WebSocket; incluir exemplo antes/depois curto, sem credenciais ou payload sensível

**Interfaces:**
- Documentar a semântica: `sequence` global por processo, snapshot como fonte autoritativa da projeção, ausência de replay exatamente-uma-vez e resync por snapshot após lacuna.
- Documentar allowlist, estados ainda indisponíveis tratados por capability/versionamento e política de backpressure/remoção de cliente lento.
- Registrar exemplo de envelope snapshot e evento normal com dados fictícios e métricas honestas; não copiar saída real que possa conter IDs, prompts ou respostas.

**Testes e validação:**

- [ ] Rodar `bun test cli/src/daemon/enhanced-server.test.ts cli/src/daemon/daemon-projection.test.ts shared/daemon-event-contract.test.ts web/src/lib/daemon-event-stream.test.ts`.
- [ ] Rodar as suítes diretamente relacionadas a #37 para confirmar que status, capabilities, emergency brake e modo não foram enfraquecidos.
- [ ] Rodar `bun run check:runtime`.
- [ ] Rodar `bun run check:web`.
- [ ] Rodar `bun run check:tests`; verificar que o manifesto de quarentena permanece intacto e que nenhuma suíte nova foi ocultada.
- [ ] Rodar `bun run check` completo. Se falhar, investigar a causa seguindo systematic debugging; não silenciar, quarentenar ou remover teste para obter verde.
- [ ] Fazer revisão de diff procurando `apiKey`, `Authorization`, prompts, respostas integrais, logs de payload bruto, URLs sensíveis e qualquer `window.dispatchEvent` para evento rejeitado.
- [ ] Fazer revisão de lifecycle verificando unsubscribe wildcard, fechamento de socket, clearTimeout, invalidação de callbacks e ausência de cancelamento de backend no close.

**Commit:** `git add README.md docs/BASELINE.md && git commit -m "docs: document websocket projection contract"` (somente se houver mudança necessária além deste plano)

---

### Task 5: Verificação final e PR única

**Files:**
- No production-file changes planned; use `git status`, `git diff`, test logs and PR metadata as evidence.

**Steps:**

- [ ] Rodar `git diff --check` e confirmar ausência de whitespace errors.
- [ ] Rodar `git status --short` e confirmar que só existem arquivos intencionais, sem artefatos temporários, credenciais ou arquivos de `/tmp`.
- [ ] Usar `git diff origin/main...HEAD --stat` e revisar cada arquivo contra os critérios de aceite #38.
- [ ] Confirmar explicitamente: envelope inicial/normais único; contrato compartilhado; snapshot/capabilities; desconexão sem cancelamento; reconexão/resync; deduplicação; lacuna; rejeição sem dispatch; isolamento de falha; limite de cliente lento; cleanup; ausência de conteúdo sensível; runtime/web/check verde.
- [ ] Fazer `git push -u origin issue-38-websocket-contract`.
- [ ] Abrir uma única PR com `gh pr create --base main --head issue-38-websocket-contract`, incluindo resumo, testes executados, exemplo antes/depois e limitações honestas (sem replay exatamente uma vez, sem #50).
- [ ] Não executar merge, squash ou fechamento da PR.
- [ ] Entregar ao usuário o link da PR, resumo dos arquivos alterados e a saída final dos gates.

---

## Revisão de cobertura da especificação

A Task 1 cobre contrato, allowlist, validação, versionamento e diagnósticos seguros. A Task 2 cobre envelope único, handshake, snapshot autoritativo, cursor global, broadcast isolado, backpressure, clientes lentos, desconexão sem cancelamento e cleanup do listener/socket. A Task 3 cobre validação antes das stores, desconhecidos/malformados, duplicatas, ordem/lacunas, resync, reconexão idempotente, ausência de repetição de comandos, cleanup de timers e correção do socket duplicado da página. A Task 4 cobre documentação antes/depois, regressões das issues #37/#35, compilação e `bun run check`. A Task 5 cobre a revisão final e a PR única contra `main` sem merge. A máquina de estados da #50, autenticação, mudança de payloads internos, exatamente-uma-vez distribuído e métricas/controles de #37 permanecem explicitamente fora do escopo.
