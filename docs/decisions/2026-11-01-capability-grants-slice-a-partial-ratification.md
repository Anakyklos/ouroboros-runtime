# ADR — Ratificação parcial do contrato de Capability Grants (Slice A)

- **Data:** 2026-11-01
- **Estado:** RATIFICADA PARCIALMENTE — somente D03, D06, D08 e D15
- **Autoridade normativa:** Pedro (concordância explícita com as quatro recomendações apresentadas pelo mantenedor em 2026-11-01)
- **Origem técnica:** issue #166, PR #167, revisão técnica APPROVE `5726240917` no HEAD `df19ece67496ad96e829cbe9ae83aa13cd998f9f`
- **Documento de alternativas:** `docs/analysis/operator-capability-grant-trust-contract-2026-10-29.md`
- **Escopo:** escolhas de contrato necessárias ao desenho do Slice A; **não** há implementação nem ratificação geral do trust model.

## Decisões aprovadas

| ID | Decisão expressamente aprovada | Consequência delimitada |
| --- | --- | --- |
| **D03** | `expiresAt` opcional (opção 1) | Grants podem não ter prazo definido; continuam revogáveis e sujeitos aos gates de autoridade. Não adota lease obrigatório de 24 h como default. |
| **D06** | Migração legada fail-closed (opção 1) | Missões preexistentes não recebem grants sintéticos, bypass retroativo ou autoridade implícita. Histórico e evidências devem ser preservados. |
| **D08** | Remover `resourceLimits` sem enforcement do contrato v1 (opção 1) | Não adicionar `maxInvocations`, `maxDurationMs` ou `budgetUnits` decorativos por grant. A política existente `budget_policy` da Mission continua governando recursos. |
| **D15** | **Alternativa A — grant unitário correlacionado** | Cada grant associa exatamente **uma capabilityId** a suas classes de efeito e prefixos autorizados, sem combinar campos entre grants distintos. Um grant não pode ampliar `CapabilityContract.effectClass`, que é singular no contrato atual. Alternativas B e C não foram aprovadas. |

## Limites da ratificação

**Na data desta ratificação, permaneciam expressamente NEEDS_APPROVAL:** D01, D02, D04, D05, D07, D09, D10, D11, D12, D13 e D14. D09/D14 foram ratificadas depois, no ADR B1; as outras decisões desta lista continuam pendentes.

A aprovação não outorga capacidades a qualquer Mission, não autoriza endpoint RPC, criação de grants por operadores, nova credencial, transporte, mutations de AuthStore, dispatch, fallback de executor, mudanças de Runstead/Katherine ou relaxamento de recovery. `mission.create` continua criando Missions inertes, sem grants.

Não confundir **seleção normativa do desenho** com **execução autorizada**. O Slice A deverá ser delimitado em tarefa/PR específica com base atualizada, testes de persistência, imutabilidade, idempotência, compatibilidade legacy e recuperação. Integrações de autorização pública e efeitos externos dependem de decisões adicionais e gates próprios.

## Condições arquiteturais preservadas

- A permissão será sempre vinculada a `missionId`, emissor validado e tupla correlacionada; um token de autenticação ou texto de modelo jamais cria autorização por si só.
- Proveniência de credenciais no MissionStore usa **geração ordinal não secreta**; nenhum `token_hash` entra no ledger. O contrato ativo `LocalControlAuthenticatedClient.credentialVersion: string` continua intacto até migração independente e versionada.
- Referências `refs/*` permanecem válidas; contenção física é responsabilidade do capability owner/conector, com política fail-closed, sem parser universal de recurso no Mission Core.
- Recovery e retries nunca reexecutam efeitos externos de estado incerto.

## Estado da issue

Na data da ratificação do Slice A, a issue #166 continuava aberta para as 11 escolhas então pendentes e para o fechamento do contrato completo. Após a ratificação posterior de D09/D14 no B1, nove decisões permanecem pendentes. A PR #167 contém documentação; incorporá-la à `main` não implica que seus trechos ainda em estado `PROPOSTA` estejam ratificados.

## Nota de supersessão factual posterior

Após esta ratificação, D09 opção 1 e D14 opção A foram ratificadas no ADR B1 de 2026-11-01. Esta nota atualiza somente a lista de decisões que ainda estavam pendentes na data deste ADR; não altera D03, D06, D08 ou D15 nem amplia o alcance do Slice A. A implementação B1 posterior permanece interna e não ativa entitlement ou emissão operacional de grants.
