# ADR — Ratificação D02 e lifecycle de entitlement (Slice B2-2 interno)

- **Data:** 2026-11-01.
- **Estado:** RATIFICADA PARCIALMENTE — D02 alternativa B e lifecycle alternativa A, **somente** para o B2-2 interno e inerte.
- **Autoridade normativa:** Pedro, aprovação explícita em conversa do projeto em 2026-11-01 da recomendação apresentada pelo mantenedor: `limits_json` no AuthStore por `clientId`, lifecycle A e limites propostos, exclusivamente para B2-2.
- **Referências:** issue #166; epic #70; `docs/analysis/capability-grants-b2-authority-readiness.md` (B2-0); `docs/analysis/capability-grants-b2-entitlement-lifecycle-ordering.md` (B2-1).
- **ADRs precedentes:** `2026-11-01-capability-grants-slice-a-partial-ratification.md` (D03/D06/D08/D15); `2026-11-01-authstore-authority-generations-b1-ratification.md` (D09/D14).
- **Baseline documental avaliado:** `main` em `b06dec8cec183487816ef777712c628637233c9f` (PR #174 integrada). O registro normativo não afirma que B2-2 já esteja implementado.

## 1. D02 — Fonte de entitlement ratificada: alternativa B

A fonte local de limites do emissor de grants será um campo **`limits_json` nullable** na linha do `clientId` em `local_control_clients`, no AuthStore existente. O `clientId` autoritativo deriva da identidade autenticada pelo servidor; um identificador arbitrário enviado pelo solicitante não pode escolher outro envelope.

A representação interna v1 é um objeto fechado `{ schemaVersion: 1, bindings: [...] }`. Cada binding correlaciona exatamente:

- `capabilityId` — identificador específico da capability;
- `effectClass` — uma classe de efeito compatível com o contrato da capability;
- `allowedRefPrefixes` — prefixos autorizados **para essa mesma capability e classe**.

Cada par `(capabilityId, effectClass)` tem no máximo um binding; prefixos distintos desse par pertencem à lista desse binding. D15 continua aplicável: nenhum consumidor pode construir produto cartesiano ou recombinar capability de um binding com efeito/referências de outro. O grant unitário inteiro deve caber em um único binding do entitlement; prefix containment exige comparação correta de categoria, autoridade/esquema URI quando aplicável e segmentos completos, sem traversal nem ambiguidades. Contenção física/symlink e validação de ownership continuam sendo responsabilidade do capability owner, não do AuthStore.

`NULL`, valor ausente e `bindings: []` concedem **zero entitlement**. Entitlement não deriva de scopes, `mission.create`, `daemon.admin`, MissionIntent, catálogo, planejamento, agente/modelo, projeção nem de qualquer outro estado por inferência. Scope de autenticação e epoch, por si, não concedem autorização de emitir grants.

### 1.1 Validação, limites e corrupção

A implementação B2-2 deverá validar antes de persistir e ao reler:

- `schemaVersion === 1`, tipos exatos e allowlist fechada de propriedades, sem versões desconhecidas nem campos extras;
- no máximo **64 KiB** de JSON UTF-8 canônico por envelope; no máximo **128 bindings**; no máximo **64 prefixos por binding**; cada identificador/prefixo com no máximo **512 bytes UTF-8**;
- IDs válidos e não vazios, effect classes reconhecidas, prefixos válidos, duplicatas e ambiguidade rejeitadas;
- ordenação/canonicalização estável para equivalência semântica e fingerprint interno, sem modificar o significado dos limites;
- erros de schema, dados persistidos inválidos ou fonte indisponível: **fail-closed**, nunca permissões amplas, grants sintéticos, reparo automático permissivo ou reaproveitamento de cache obsoleto.

Os limites acima são normativos para o B2-2 e sujeitos à comprovação por testes; qualquer ampliação posterior de formato, enum ou caps exige novo gate de compatibilidade/decisão.

### 1.2 Migração e provisionamento

A migração de clientes existentes será aditiva, transacional, idempotente e recuperável, atribuindo `NULL` a entitlement legado — tanto clientes ativos quanto revogados. Não recriar banco, tokens, scopes ou épocas históricas. Nenhuma autorização antiga passa a delegar capabilities por efeito da migração.

Novos clientes iniciam sem entitlement. Após revogação/reprovisionamento, atribuição de entitlement exige ação administrativa **explícita**; o `clientId` reativado não recupera limites anteriores por padrão. Mudança de entitlement não altera `credential_generation` ou invalida token por si só. Este ADR não cria interface administrativa pública nem autoriza `daemon.admin` implicitamente a escrever limites.

## 2. Lifecycle A — extinção permanente por mudança de entitlement

Como **regra nova**, além do alcance histórico de D14, qualquer alteração **semântica e canônica** de `limits_json` avança `authority_epoch` **exatamente uma vez**, de forma atômica com a alteração no próprio AuthStore e com as proteções monotônicas/high-water-mark de D09.

- Redução, ampliação, remoção e reatribuição efetivas avançam a época. Redução seguida de ampliação **não** ressuscita grants de épocas anteriores.
- Atualização canonicamente equivalente é no-op de autoridade e não avança época.
- Se scopes e entitlement mudarem na mesma mutação, a época avança uma vez, não duas.
- Rotação pura de segredo com autoridade efetiva inalterada avança `credential_generation`, mas preserva `authority_epoch`.
- Revogação e reprovisionamento preservam a extinção monotônica; overflow, corrupção, escrita adversarial e rollback de transação falham fechados.
- Quando existir consumo operacional de grants **aprovado em slice posterior**, ele deverá exigir identidade ativa, scope operacional apropriado, entitlement aplicável e igualdade entre `grantorAuthorityEpoch` do grant e época atual; sem essas revalidações, não pode tratar grant como autorização. Este ADR **não implementa nem autoriza** esse consumo.

Esta decisão **não altera retroativamente D14**: o ADR B1 ratificou mudanças de **scopes**; a extensão a entitlement está ratificada **neste ADR**, com escopo próprio.

## 3. Limitações e decisões não abrangidas

D12 (coordenação AuthStore/MissionStore, CLI/daemon, concorrência, ordem de emissão e delivery) **permanece NEEDS_APPROVAL**. Atomicidade da atualização `limits_json` + epoch dentro do AuthStore não é atomicidade entre arquivos SQLite e não garante ausência de race entre leitura de autoridade e futuro commit em MissionStore. O high-water mark local não detecta restauração integral de backup antigo do próprio AuthStore; o administrador comprometido do host está fora da proteção garantida por triggers.

Efeitos já submetidos ou incertos não são automaticamente cancelados, revertidos ou reexecutados quando entitlement muda. Isso depende dos contratos futuros de delivery, reconciliação, cancelamento e gates de execução. B2-2 não pode afirmar que grant persistido autoriza execução.

**Continuam NEEDS_APPROVAL:** D01, D04, D05, D07, D10, D11, D12 e D13. Esta ratificação não escolhe scope de emissão, issuer operacional, leitura pública, revogação cross-grantor, submission, rollback externo, protocolo público ou integração planner/dispatch.

## 4. Autorização delimitada de implementação

Pedro autorizou que, **depois de este ADR estar integrado à `main` e existir uma issue operacional filha explícita**, um executor implemente **somente** o B2-2 interno e inerte:

1. Coluna/contrato interno e parser estrito versionado com limites ratificados.
2. Migração aditiva e compatível de AuthStore; `NULL` como ausência de entitlement.
3. Persistência e APIs **internas** mínimas para consulta/atualização explicitamente autorizadas dentro do trust boundary local existente, sem nova operação RPC/CLI pública.
4. Evolução atômica `limits_json` + `authority_epoch` com guards SQLite, preservando high-water mark.
5. Testes reais SQLite (legacy, corrupção, compatibilidade, concorrência, restart, rollback, validação e no-op/shrink/expand/reprovision).

**Explicitamente NÃO autorizado:** scope novo `mission.grant_capabilities`, grants operacionais, RPC de emissão/revogação/leitura, alterações de public auth contract, policy/planner/acceptance/dispatch, provider/conector real, mudança de transporte, cross-store coordinator, alteração em Runstead/Katherine ou efeitos externos.

O ledger de grant do Slice A permanece inerte. B2-2 não satisfaz sozinho o trust contract completo da issue #166. A issue #166 permanece aberta.

## 5. Gates de prova e conclusão

Issue filha deve exigir RED/GREEN quando aplicável, testes SQLite real para migração/restart/rollback, tentativas de escrita adversarial (`REPLACE`, UPDATE direto, triggers/epoch), parser/byte caps, equivalência semântica, grants incompatíveis, comparação prefixo-correlacionada, não ressurreição de época, isolamento de autenticação e zero exposição de segredo.

Executar instalações frozen de root/web, `bun run check`, `git diff --check`, e CI no HEAD exato. Não introduzir nova quarentena, dependência ou permissões por conveniência. CI verde, sozinho, não comprova recovery nem compatibilidade.

**Conclusão:** revisão técnica e gates → merge em `main` → CI pós-merge → issue filha atualizada/fechada. Nenhum agente executor pode promover sua PR por conta própria.
