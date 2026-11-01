# ADR — Ratificação D09/D14: gerações e épocas de autoridade no AuthStore (B1)

- **Data:** 2026-11-01
- **Estado na ratificação:** RATIFICADA — D09 opção 1 e D14 opção A; implementação ainda pendente naquele momento
- **Autoridade normativa:** Pedro, aprovação explícita na conversa do projeto em 2026-11-01 da recomendação do mantenedor para estas duas decisões e somente para o Slice B1.
- **Rastreamento:** issue #166; epic #70; Slice A issue #168 / PR #169 já integrado à `main`.
- **Fonte das alternativas:** `docs/analysis/operator-capability-grant-trust-contract-2026-10-29.md`, §§6.1, 8.4, 12, 13 e 14.
- **ADR precedente:** `docs/decisions/2026-11-01-capability-grants-slice-a-partial-ratification.md` (D03/D06/D08/D15, não alterado retroativamente).

## Decisões ratificadas

### D09 — Opção 1: high-water mark durável e trust boundary do AuthStore

O AuthStore deverá manter o máximo histórico de `authority_epoch` por `clientId` em tabela persistente `local_control_authority_epochs`. A implementação B1 deverá usar invariantes SQLite para prevenir exclusão e decremento de épocas, deleção indevida de clientes, mutação de identidade e inserção/reprovisionamento que reutilize época extinta.

Escritores administrativos controlados devem usar mutações parametrizadas por UPSERT (`INSERT ... ON CONFLICT(client_id) DO UPDATE`), **não** `INSERT OR REPLACE`/`REPLACE INTO`, e abrir as conexões de escrita com `PRAGMA recursive_triggers = ON`. Preservar permissões privadas dos arquivos (alvo `0600` no Linux) e o isolamento do usuário do serviço quando aplicável.

**Limite explícito:** SQLite triggers não são autenticação nem proteção contra ator com acesso irrestrito de escrita/DDL no arquivo; `REPLACE` com `recursive_triggers = OFF` tem semântica adversarial. O trust boundary também depende das permissões do host e do controle dos caminhos de escrita. Não afirmar segurança absoluta em presença de administrador do host comprometido.

### D14 — Opção A: extinção permanente por mudança de escopos

Qualquer **alteração do conjunto efetivo de escopos provisionados** do operador exige avanço monotônico da `authority_epoch` (com proteção no próprio SQLite, não apenas em caller). Grants emitidos sob épocas anteriores **nunca** voltam a autorizar efeitos apenas porque o operador recuperou escopos; a extinção da época é permanente.

- **Rotação pura de segredo:** gera nova `credential_generation` ordinal, invalida credenciais/sessões anteriores pela verificação existente e **não altera** `authority_epoch` se os escopos efetivos e a autoridade permanecerem idênticos.
- **Mudança de escopos, inclusive adição:** incrementa `authority_epoch`; pode invalidar grants antigos mesmo em alterações benignas. Esse custo é aceito em favor de um modelo simples e verificável.
- **Revogação/reprovisionamento:** nenhum reprovisionamento sob o mesmo `clientId` pode reutilizar época antiga. Uma época anterior permanece extinta; não converter revogação em autorização implícita.
- **Persistência:** a geração da credencial e a época de autoridade são ordinais inteiros, monotônicos e não secretos, emitidos no servidor; nunca timestamps como fonte de ordem. Tratar overflow, corrupção e falhas de transação como fail-closed.
- **Compatibilidade:** preservar `LocalControlAuthenticatedClient.credentialVersion: string` e a revalidação ativa do token/sessões/WebSocket. Não persistir `token_hash`, bearer nem seus derivados como provenance de grants no MissionStore.

A redução de um entitlement externo não está decidida nesta ratificação (D02 permanece pendente); não criar política nova para limites de grantor no B1.

## Limite de autorização de implementação

Pedro autorizou **apenas a implementação interna, delimitada e verificável do Slice B1**, depois da integração deste ADR e da abertura de uma issue operacional filha com testes e critérios de aceite.

B1 pode introduzir migrações **aditivas, idempotentes e recuperáveis** do AuthStore, geração ordinal de credencial, `authority_epoch`, high-water mark, guards SQL e testes reais SQLite/restart/rollback/concurrency. A migração preserva credenciais ativas, escopos, revogações, sessões e dados existentes; na dúvida, falhar fechado, sem apagar/recriar banco ou ressuscitar privilégios.

**Não autorizado:** endpoint RPC de grants, `mission.grant_capabilities`, `mission.list_capability_grants`, leitura pública de concessões, emissão/revogação operacional de grants, entitlement source, integração com MissionEngine/planning/acceptance/dispatch, alteração do AuthStore de outros projetos, mudança de transporte, upgrade de delivery, autoplan ou execução externa. O ledger do Slice A permanece inerte, sem authority source operacional.

## Outros gates pendentes

**Permanecem NEEDS_APPROVAL:** D01, D02, D04, D05, D07, D10, D11, D12 e D13 (nove decisões). Nenhuma delas é ratificada por implicação. A issue #166 permanece aberta até fechamento do contrato de confiança completo. Slice B2/C/D exigem gates próprios.

## Provas exigidas da futura implementação B1

- Testes RED/GREEN contra SQLite real, não só mocks, incluindo triggers com `recursive_triggers`, UPSERT, `REPLACE`, `DELETE`, identity mutation, epoch rollback/reuse, overflow, SQL malformado e falha fechada.
- Provisionamento, rotação pura, modificação de escopos, revogação, reprovisionamento e restart demonstrados sem ressurreição de autoridade.
- Migração de fixture legada preservando dados, reexecução idempotente, rollback/concorrência e nenhuma publicação precoce de fatos.
- Auth vigente, browser sessions e WebSocket continuam invalidando credenciais antigas; `credentialVersion: string` permanece compatível.
- `bun install --frozen-lockfile`, `bun run check`, `git diff --check`, CI no HEAD exato e regressões documentadas, respeitando Bun 1.3.9 do CI.
- Nenhuma integração operacional de grants, ampliação de scopes, execução externa ou segredo exposto.

**Critério de conclusão:** somente após revisão independente, gates comprovados, merge em `main`, confirmação pós-merge e issue B1 atualizada; a ratificação documental não é implementação.

## Nota de supersessão factual pós-merge (2026-11-01)

O status de implementação pendente acima registrava o estado no momento da ratificação. B1 foi posteriormente integrado pela PR [#172](https://github.com/Anakyklos/ouroboros-runtime/pull/172), commit `17b94f1c2a0076b41b6965c40f42c4bca09847a8`, presente no baseline `a4564d4cf650d9b1b11ed062500966150ffbecae`. Esta nota atualiza apenas o status factual de implementação; D09/D14 conservam exatamente o alcance ratificado neste ADR. Entitlement, RPC e emissão operacional continuam não autorizados.
