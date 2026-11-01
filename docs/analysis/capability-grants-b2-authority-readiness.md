# Capability Grants — prontidão normativa para B2 (B2-0)

**Tipo:** pacote de decisão documental; sem implementação operacional.
**Estado:** `NEEDS_APPROVAL`. Esta análise não ratifica decisões e não autoriza B2.

## 1. Baseline verificado

Em 2026-11-01, `origin/main` foi buscada novamente e está em [`17b94f1c2a0076b41b6965c40f42c4bca09847a8`](https://github.com/Anakyklos/ouroboros-runtime/commit/17b94f1c2a0076b41b6965c40f42c4bca09847a8), merge da PR [#172](https://github.com/Anakyklos/ouroboros-runtime/pull/172). A CI oficial [run 41337928676](https://github.com/Anakyklos/ouroboros-runtime/actions/runs/41337928676) concluiu `success` nesse SHA exato. A issue [#166](https://github.com/Anakyklos/ouroboros-runtime/issues/166) permanece aberta; [#168](https://github.com/Anakyklos/ouroboros-runtime/issues/168) e [#171](https://github.com/Anakyklos/ouroboros-runtime/issues/171) estão fechadas. As PRs [#169](https://github.com/Anakyklos/ouroboros-runtime/pull/169), [#170](https://github.com/Anakyklos/ouroboros-runtime/pull/170) e [#172](https://github.com/Anakyklos/ouroboros-runtime/pull/172) estão integradas.

As ratificações vigentes são limitadas:

- Slice A: D03 (expiração opcional, revogação preservada), D06 (migração legada fail-closed, sem grants sintéticos), D08 (sem limites de recursos decorativos no v1) e D15 (grant unitário correlacionado). Ver [ADR do Slice A](../decisions/2026-11-01-capability-grants-slice-a-partial-ratification.md#L10-L25).
- B1: D09 opção 1 e D14 opção A. D14 extingue permanentemente grants de épocas anteriores após **qualquer alteração no conjunto efetivo de scopes**; rotação pura de segredo mantém a época. A ratificação declara expressamente que semântica de redução de entitlement continua pendente. Ver [ADR B1](../decisions/2026-11-01-authstore-authority-generations-b1-ratification.md#L12-L42).

D01, D02, D04, D05, D07, D10, D11, D12 e D13 continuam `NEEDS_APPROVAL`. Este pacote recomenda opções para D01 e D02, mas não muda seu estado.

## 2. O que A/B1 comprovam — e o que não comprovam

O contrato de autenticação contém somente `mission.read`, `mission.control`, `mission.create` e `daemon.admin`; o tipo do cliente autenticado continua com `clientId`, `credentialVersion`, `scopes` e expiração opcional. Não existe escopo de grant no contrato atual ([contrato](../../shared/local-control-auth-contract.ts#L1-L27)). A tabela de roteamento concede `mission.create` apenas a `local_control.admit`, `daemon.admin` apenas a controles do daemon, e rejeita métodos sem classificação ([mapeamento](../../cli/src/daemon/local-control-auth.ts#L686-L713)). O daemon revalida scope e credencial antes de executar a RPC ([server](../../cli/src/daemon/server.ts#L543-L552)).

A composição real mantém `daemon.db`, `missions.db` e `local-control-auth.db` separados; cria um `CapabilityRegistry` vazio por padrão, o `MissionEngine`, o seam e o admission service ([composition root](../../cli/src/daemon/main.ts#L124-L151)). A CLI `auth provision/rotate/revoke` abre o AuthStore e o altera diretamente, inclusive no fluxo documentado para daemon parado ([admin-cli](../../cli/src/commands/admin-cli.ts#L73-L105), [guia de autenticação](../LOCAL_CONTROL_AUTH.md#L1-L23)).

`mission.create` só cria Missions com `allowedCapabilityScope` vazio ([admission](../../cli/src/daemon/local-control-admission.ts#L25-L29), [criação](../../cli/src/daemon/local-control-admission.ts#L145-L154)). O ledger A persiste fatos unitários e revogações no MissionStore, mas seu módulo declara que planning, policy, dispatch e RPC não o chamam; a cobertura exige uma chave de autoridade validada fornecida por uma fonte futura ([primitivas](../../cli/src/mission/capability-grants.ts#L1-L6), [entrada da validação](../../cli/src/mission/capability-grants.ts#L35-L47), [predicado](../../cli/src/mission/capability-grants.ts#L477-L551)). `PlanPolicyValidator` valida o escopo da Mission e o contrato da capability; não consulta grants ([policy](../../cli/src/mission/policy.ts#L166-L227)). O `MissionEngine` revalida a policy antes de criar invocação, também sem ler AuthStore ou grants ([dispatch gate](../../cli/src/mission/mission-engine.ts#L712-L787)).

O B1 persiste `credential_generation`, `authority_epoch` e high-water mark por cliente no AuthStore, com migração aditiva transacional e rejeição de inconsistência. Os valores não entram no cliente autenticado nem são interpretados como entitlement ([migração](../../cli/src/daemon/local-control-auth.ts#L202-L289), [guia B1](../LOCAL_CONTROL_AUTH.md#L25-L64)). Token válido prova identidade de credencial; época válida prova proveniência ordinal. Nenhum dos dois prova quais bindings de capability aquele operador pode conceder.

### Evidência de testes existente

Os testes de autoridade do AuthStore usam SQLite real e cobrem legado, migração parcial, restart, monotonicidade, reprovisionamento e concorrência (`cli/src/daemon/local-control-auth.authority.test.ts`). Os testes do ledger usam SQLite real e cobrem migração legada sem grants sintéticos, restart, idempotência, concorrência e rollback (`cli/src/mission/capability-grants.sqlite.test.ts`). Testes de policy, MissionEngine, autenticação e composição cobrem os caminhos atuais. Isso comprova as primitivas e o comportamento atual; **não** comprova emissão, entitlement, leitura de grants, revogação cross-operator nem enforcement em dispatch, pois esses caminhos não existem.

## 3. D01 — escopo dedicado de emissão

**Recomendação técnica: alternativa 1, `mission.grant_capabilities`. `NEEDS_APPROVAL`.** O nome descreve a operação em nível de Mission e separa emissão de controles globais. `capability.grant` também seria dedicado, mas introduziria uma segunda família de namespace sem benefício demonstrado no contrato atual. `daemon.admin` é amplo e atualmente significa modo do daemon, emergency brake e shutdown; usá-lo como autorização implícita para delegar capacidades violaria least privilege e tornaria o mapeamento difícil de auditar.

O novo scope, se ratificado em decisão posterior, seria **necessário, mas insuficiente**:

1. **Autenticação:** validar bearer/session, `clientId`, expiração, revogação e geração de credencial.
2. **Autorização da operação:** classificar explicitamente a futura RPC de emissão com `mission.grant_capabilities`; desconhecidos continuam negados. `daemon.admin` e `mission.create` não implicam esse scope.
3. **Entitlement:** consultar fonte governada vinculada ao `clientId` e provar que cada binding unitário submetido cabe em um binding correlacionado `(capabilityId, efeito, prefixos)` do emissor. Scope e `authority_epoch` não substituem essa checagem.
4. **Validação e persistência:** validar Mission, capability, contrato do owner, referências, identidade/proveniência e replay; persistir o fato no ledger append-only. Revalidar a autoridade pertinente nos gates definidos pela decisão.

Assim, um cliente sem o scope não pode emitir; um cliente com o scope ainda pode ser recusado por falta de entitlement ou por binding excessivo. Texto de intent, plano, modelo, executor, projeção e capability discovery não concedem authority. Manter a lista de scopes existente não altera os tokens atuais; um scope novo requer provisionamento explícito. Sob D14 ratificada, qualquer mudança efetiva do conjunto de scopes incrementa a época e extingue grants anteriores do operador, inclusive mudanças benignas.

## 4. D02 — fonte de entitlement

O envelope precisa preservar correlação por binding: cada grant unitário deve ser coberto por **um** binding máximo do mesmo emissor; não se pode combinar capability de uma linha com efeito ou referência de outra. Essa regra segue D15 e a proposta de envelope em [§5.4 do contrato de referência](./operator-capability-grant-trust-contract-2026-10-29.md#L341-L380).

| Critério | A — arquivo local de governança | B — `limits_json` no AuthStore |
|---|---|---|
| Fonte e identidade | Estado de autoridade separado da credencial; precisa de associação inequívoca a `clientId` e governança de arquivo. Não há loader/contrato desse arquivo em `main`. | O limite fica na mesma linha durável do `clientId` que autentica o emissor; evita uma segunda fonte local independente para essa autoridade. |
| Correlação e validação | Pode serializar tuplas correlacionadas, mas exige schema/versionamento, parser estrito, limites e rejeição de qualquer campo ambíguo. | Pode serializar as mesmas tuplas, mas `limits_json` não é validado hoje; exige parser e regras de integridade novos. |
| Persistência/restart e corrupção | Depende de leitura consistente, atomicidade de atualização, permissões, proprietário e política de backup implementados para o novo arquivo. Ausência, JSON inválido ou identidade duplicada precisam negar emissão e uso. | Reutiliza durabilidade SQLite e abertura do AuthStore a cada processo; coluna e leitura ainda exigem migração e validação. Valor ausente/inválido precisa equivaler a nenhum entitlement e falhar fechado. |
| Alteração/revogação | Alteração do arquivo não compartilha transação com AuthStore ou MissionStore; cache/refresh e ordem entre processo CLI e daemon precisam de regra explícita. | Escrita do limite pode ser atômica com os demais fatos do cliente no AuthStore, mas continua sem transação conjunta com MissionStore. Requer definir quem pode escrever e como o runtime observa a mudança. |
| Rollback | Arquivo antigo restaurado pode restaurar limites antigos; não há versão monotônica ou proteção anti-rollback aprovada para ele. Permissões não provam frescor. | A HWM B1 protege épocas dentro do AuthStore sob seu trust boundary, mas restore do próprio banco pode restaurar um snapshot antigo. D09 não promete proteção contra operador/root do host nem backup rollback. Não atribuir proteção ao campo sem decisão e mecanismo explícitos. |
| Concorrência | A edição do arquivo e as operações nos dois bancos não têm commit comum; estabelecer locking e validade do snapshot é trabalho adicional. | SQLite serializa mutações dentro do AuthStore, mas leitura/alteração do AuthStore e commit no MissionStore continuam separados. Não resolve D12. |
| Custo e superfície | Evita acoplar schema de credenciais à taxonomia, mas cria outro artefato de autoridade, caminho, ACL, parser, backup e sincronização. | Exige migração aditiva, tratamento de legado, validação SQL/aplicativa e possivelmente guards/allowlist de escritores para o novo dado; acopla o AuthStore ao formato de entitlement. Não exige nova tabela se uma coluna satisfizer as invariantes. |

**Recomendação técnica: alternativa B, `limits_json` por `clientId` no AuthStore. `NEEDS_APPROVAL`.** Ela mantém a fonte de autorização de emissão junto à identidade autenticada, reduz divergência entre dois arquivos locais e aproveita a fronteira privada e a transação de provisionamento do AuthStore. A recomendação depende de ratificação e não prova que o host seja confiável contra seu administrador. D09 limita explicitamente o que triggers SQLite garantem ([ADR B1](../decisions/2026-11-01-authstore-authority-generations-b1-ratification.md#L14-L18)).

Se Pedro escolher B, o desenho ainda precisa especificar antes da implementação: migração aditiva sem concessão implícita a clientes legados; forma canônica de bindings; validação de JSON/tuplas; escritores e guards; o que invalida grants quando limites são reduzidos; e se alterações de entitlement afetam `authority_epoch`. D14 cobre mudanças de **scopes**, não mudanças de `limits_json` ([ADR B1](../decisions/2026-11-01-authstore-authority-generations-b1-ratification.md#L20-L30)). Como mínimo, limite ausente/corrompido nega; emissão compara com limites atuais; consumo de grant revalida contra os limites atuais. Se redução deve extinguir permanentemente grants ou apenas suspender seu uso, isso requer decisão explícita. Nem `credential_generation` nem `authority_epoch` podem ser reinterpretados para resolver essa lacuna.

## 5. Dependências normativas: D05, D07 e D12

### D05 — leitura de grants

As alternativas registradas são `mission.read` ou scope dedicado como `mission.grants.read`; nenhuma está aprovada. `mission.read` hoje cobre projeções de Missions, invocações, sessões, diagnósticos e catálogo. Grants acrescentariam enumeração de capability, efeitos, prefixos de referência, emissor e estado de revogação. Uma projeção sanitizada ainda pode revelar provenance e superfície de autoridade. Scope dedicado reduz exposição por padrão, ao custo de credenciais adicionais; se Pedro escolher `mission.read`, o contrato deve delimitar missão visível, campos públicos e comportamento `includeRevoked`. D05 não deve ser decidido implicitamente por D01.

### D07 — revogação cross-grantor

As alternativas em aberto são revogação somente pelo emissor original ou `daemon.admin`, versus qualquer cliente com scope de emissão. O scope atual `daemon.admin` não contém hoje revogação de grants. Dar a ele essa capacidade por implicação mistura administração do processo com custódia de grants; conceder poder a todo emissor também permite interferência entre operadores. A regra precisa autenticar o revoker e validar a autoridade específica para aquela revogação, sem confiar apenas no registro do evento. O primitivo atual deliberadamente exige evidência externa para validar revogadores e não escolhe regra cross-grantor ([tipos](../../cli/src/mission/capability-grants.ts#L27-L48), [ADR Slice A](../decisions/2026-11-01-capability-grants-slice-a-partial-ratification.md#L27-L32)).

### D12 — AuthStore/MissionStore e concorrência

O código confirma dois SQLite distintos e dois caminhos de escrita: a CLI altera credenciais diretamente no AuthStore, enquanto grants/invocações pertencem ao MissionStore. `SqliteMissionStore` serializa transações e appends na sua própria conexão/banco ([fila](../../cli/src/mission/sqlite-mission-store.ts#L325-L353), [transação](../../cli/src/mission/sqlite-mission-store.ts#L2353-L2375)); isso não serializa a CLI contra o daemon nem uma leitura de AuthStore contra um commit no MissionStore.

| Alternativa | O que seria necessário | Limite ou custo que não pode ser omitido |
|---|---|---|
| 1. Mutações via daemon RPC | Roteia provisionamento, rotação, revogação e mudanças de entitlement pelo daemon; grants e revalidação de autorização de novos envios passam pela mesma fila/seção crítica. Define bootstrap/offline e desativa ou controla escritores diretos. | “Usar RPC” isoladamente não prova ordenação: o daemon aceita operações concorrentes e a fila atual é local ao MissionStore. É necessário implementar e testar a seção crítica comum. Operações administrativas passam a depender do daemon ativo. |
| 2. Stores unificados | Um banco e um único coordenador/connection path que lê autoridade e commita a reserva na mesma transação; migração, backup, recovery e escritores compatíveis. | Mudar o nome do arquivo ou apontar dois stores independentes ao mesmo SQLite não cria transação conjunta. É a mudança arquitetural maior; deve provar atomicidade no caminho real. |
| 3. Consistência eventual, sem SLA | Declare a limitação; não prometa prazo de propagação, zero efeitos ou cancelamento. Revalide autoridade fresca nos gates escolhidos e trate falhas da fonte como deny. | Entre leitura de AuthStore e commit no MissionStore ainda pode haver interleaving. Um efeito que já cruzou para conector/rede pode não ser cancelável; no máximo, bloqueiam-se novos envios em gates futuros e tenta-se cancelar quando o protocolo permite. |

**Não há base para declarar D12 resolvida.** A alternativa 1 só remove a corrida se todos os escritores relevantes e o gate de novos envios forem serializados pelo mesmo mecanismo. A alternativa 2 só oferece atomicidade se ambos os dados forem realmente lidos/escritos pelo mesmo coordenador transacional. A alternativa 3 é a única que explicitamente aceita a janela; as garantias devem ficar restritas ao gate em que a nova autoridade for efetivamente consultada.

Separar os fatos do efeito: rejeitar antes de criar/reservar um envio bloqueia um novo envio; revogar depois que a chamada foi submetida não desfaz bytes já transmitidos nem efeito externo já executado. O `MissionEngine` revalida a policy antes de criar invocação, e o scheduler/seam trata a entrega em etapa posterior ([engine](../../cli/src/mission/mission-engine.ts#L774-L800), [scheduler](../../cli/src/mission/mission-scheduler.ts#L232-L271)). O contrato atual não possui uma autoridade de grants conectada a esses pontos.

## 6. Matriz adversarial compacta

“Resultado” abaixo é o comportamento que uma futura ratificação/implementação precisa definir, não uma alegação de comportamento atual. A evidência citada comprova apenas a primitiva indicada; a lacuna marca a integração ausente.

| Cenário / entrada | Fonte de autoridade e checagem necessária | Resultado esperado | Evidência atual | Lacuna restante |
|---|---|---|---|---|
| Cliente autenticado sem scope de emissão tenta criar grant | AuthStore/clientId; mapeamento RPC exige scope dedicado | `403`, sem escrita | Escopos e mapeamento exatos; métodos desconhecidos negados (`local-control-auth.ts:686-713`) | Scope/RPC de grant não existe |
| Cliente com scope, sem entitlement | AuthStore + envelope governado; comparar cada binding | Deny, sem ledger change | Predicado aceita autoridade somente via evidência injetada (`capability-grants.ts:539-551`) | Fonte e serviço de entitlement inexistem |
| Capability fora dos limites | Envelope atual correlacionado pelo clientId | Deny, sem persistência | D15 unitário ratificado; issue #166 §5.4 especifica a regra proposta | Nenhum enforcement de grantor |
| Efeito/ref combinados de bindings distintos | Um binding do entitlement precisa cobrir capability, efeito e cada ref | Deny; sem produto cartesiano | Grant A mantém campos unitários; predicate exige um grant para toda a operação (`capability-grants.ts:477-538`) | Comparador grant-vs-entitlement inexistente |
| Scopes mudam durante a concessão | AuthStore e D14; checar época atual no ponto de commit | Concessão usa uma única época válida ou falha; nunca mistura snapshots | D14 HWM/guards em B1; teste de concorrência de rotação no AuthStore | Não há fila cross-store nem emissão; ordem não definida |
| Entitlement reduzido após emissão | Fonte D02 atual; revalidar no gate de novo envio | Grant que excede limite novo deixa de autorizar; sem prometer cancelar efeito em voo | Proposta §5.4 e limites D12 documentados | Sem D02 ratificada nem gate de entitlement |
| Rotação pura de credencial | AuthStore: geração nova, época preservada se scope/authority iguais | Revoga token anterior, preserva autoridade histórica do grant | ADR D14; `local-control-auth.authority.test.ts` cobre rotação/restart | Não existe vínculo operacional de grant com fonte confiável |
| Revogação e reprovisionamento | AuthStore HWM + D14 | Nova época; grants antigos nunca ressuscitam | ADR B1 e testes reais SQLite de autoridade | Enforcement de época em validação de grants ausente |
| Tentativa de ressuscitar época antiga | AuthStore/HWM e triggers | Rejeitar escrita; preservar histórico | D09/D14 e testes B1 de decremento/REPLACE/reopen | Admin do host e rollback de banco seguem fora da garantia D09 |
| CLI e daemon alteram autoridade concorrentemente | AuthStore, MissionStore e mecanismo D12 | Ordenação explícita ou admitir janela sem SLA | CLI escreve AuthStore diretamente; fila MissionStore é local | Não existe coordenador comum |
| Falha entre validação e commit | Autoridade consultada + ledger/reserva | Falha fechada; não publicar/reservar com autoridade desconhecida | Cada store tem transação própria; predicate falha sem chave confiável | Sem commit conjunto nem checagem conectada ao envio |
| Replay de request após restart | Idempotência do endpoint e ledger no MissionStore | Replay idêntico não duplica; payload divergente conflita; revalidar autoridade corrente | Testes SQLite do ledger cobrem append/restart/idempotência | Não há endpoint ou regra operacional de replay |
| Fonte de entitlement ausente/corrompida | Fonte D02 e parser versionado | Deny; manter diagnóstico; sem default allow/repair permissivo | B1 AuthStore rejeita inconsistências; grants negam autoridade ausente | Formato, atualização e recuperação de D02 inexistem |
| Texto, modelo, executor ou projeção tenta conceder autoridade | Policy/servidor/owner do módulo; não aceitar authority de payload | Nenhum efeito; só fonte governada e operação autorizada concede | Arquitetura e `PlanPolicyValidator` mantêm planner advisory | Predicate de grants ainda não integrado a policy/dispatch |
| Operador tenta revogar grant de outro | AuthStore + regra D07 e provenance do grantor/revoker | Deny sem autoridade cross-grantor explícita | Ledger exige chave de revogação validada; não escolhe regra | D07 pendente; RPC/revogação operacionais não existem |

## 7. Invariantes e contratos que permanecem inalterados

- Scopes públicos atuais, `credentialVersion: string`, autenticação bearer/browser e revalidação continuam como estão.
- `mission.create` não inclui capability no Mission e não emite grant.
- Grant é fato append-only por Mission, com uma capability e efeito/referências correlacionados; sem grants sintéticos para Missions legadas.
- D03, D06, D08, D09, D14 e D15 mantêm exatamente o alcance descrito nos ADRs. D09/D14 não conferem entitlement por época, não definem redução de `limits_json` nem aprovam RPC.
- Token, época, approval de Mission, plano, texto do modelo e presença no registry são dados/condições distintas; nenhum isoladamente confere grant.
- A policy determinística e a validação do owner continuam obrigatórias. Nenhuma integração de dispatcher ou executor é criada por este documento.
- D04 permanece pendente: efeito da revogação do operador sobre novos passos versus cancelamento em cascata. D10, D11 e D13 permanecem pendentes para delivery/recovery; não são ratificadas aqui.

## 8. Decisões exatas para ratificação

1. **D01:** aprovar ou rejeitar `mission.grant_capabilities` como scope dedicado; explicitar que scopes existentes não o implicam.
2. **D02:** escolher arquivo local ou AuthStore; se AuthStore, ratificar `limits_json` por `clientId`, envelope correlacionado, migração de legados sem autoridade implícita, falha fechada e semântica para redução/rollback/época. Se arquivo, definir identidade, ACL, versão/frescor, atualização atômica e comportamento de corrupção/rollback.
3. **D05:** escolher `mission.read` ou scope dedicado para listagem; delimitar projeções, enumeração, `includeRevoked` e provenance exposta.
4. **D07:** escolher quem pode revogar; ratificar explicitamente se algum operador central pode revogar grants alheios. `daemon.admin` não deve ganhar essa autoridade por implicação.
5. **D12:** escolher daemon RPC serializado, stores unificados com transaction coordinator ou consistência eventual sem SLA; definir exatamente quais mutações e gates participam e quais limites valem para efeitos submetidos.
6. **D04:** ratificar consequência de revogar credencial do operador para novos passos e missões existentes.
7. **D10/D11/D13:** continuar pendentes para a evolução de entrega/recovery; só entram no escopo operacional correspondente quando ratificadas.

## 9. Menor decomposição após ratificação

1. **Contrato e AuthStore:** source de entitlement por cliente, validação correlacionada, migração aditiva/fail-closed e semântica de atualização, usando apenas decisões ratificadas.
2. **Emissão e revogação:** RPC de escrita com scope D01, validação atual de clientId/geração/época/entitlement, regra D07 e append/idempotência no MissionStore; transação local não pode ser apresentada como cross-store.
3. **Leitura:** superfície e projeção mínimas segundo D05.
4. **Enforcement:** integrar a autoridade validada aos gates de policy e de novo envio; revalidar redução/revogação conforme D02/D04/D12 e provar restart, concorrência, rollback e recuperação em SQLite real.
5. **Entrega externa:** alterar delivery/recovery apenas se necessário e após D10/D11/D13; diferenciar bloqueio de novos envios de cancelamento de efeitos já submetidos.

Cada bloco precisa de issue/PR operacional própria ou de escopo filho explicitamente aprovado, testes e CI. Este pacote é documentação para ratificação; **não autoriza iniciar qualquer bloco B2**.
