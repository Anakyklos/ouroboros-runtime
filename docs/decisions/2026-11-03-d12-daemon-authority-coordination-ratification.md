# ADR — D12: coordenação administrativa da autoridade pelo daemon (M1 / B2-4)

- **Data:** 2026-11-03.
- **Estado:** RATIFICADA PARCIALMENTE — **D12, Alternativa 1**, exclusivamente para a fronteira de coordenação administrativa no M1. Implementação pendente.
- **Autoridade normativa:** Pedro, aprovação explícita nesta conversa em 2026-11-03 da recomendação do mantenedor: coordenação pelo daemon, fencing verificável, recovery conservador e ausência de promessa de atomicidade cross-store.
- **Referências:** issue #166, epic #70, PR #178 (B2-3), `docs/analysis/capability-grants-b2-3-d12-runtime-evidence.md`.
- **Baseline verificado antes da ratificação:** `main` em `9801eb3b7691c703f0e988c1cf6098e3bb34f201`. Este ADR não afirma que o mecanismo proposto já exista.
- **Precedentes:** ADRs de Slice A (D03/D06/D08/D15), B1 (D09/D14) e B2-2 (D02 + lifecycle A).

## 1. Decisão ratificada e motivo

**D12 — Alternativa 1: coordenação pelo daemon**, em vez de unificar os bancos SQLite neste slice ou aceitar consistência eventual sem coordenação como contrato operacional.

O daemon será o proprietário da **ordenação das mutações administrativas de autoridade durante sua operação**. Provisionamento, rotação, revogação e alteração de entitlement devem passar pela mesma fronteira de coordenação que qualquer gate futuro que prometa observar essa autoridade. A CLI administrativa não pode continuar como escritor concorrente independente **quando se declarar essa garantia**.

A seleção busca a menor mudança suficiente para organizar escritores e estabelecer uma garantia de ordem verificável no M1, preservando a separação atual de AuthStore e MissionStore. O B2-3 demonstrou com processos e SQLite reais que: (a) uma admissão já autenticada pode completar após alteração concorrente de scopes; (b) snapshots de entitlement ficam obsoletos; e (c) commits separados não formam uma transação conjunta. A recomendação técnica do B2-3 deixa de ser PROPOSED **somente quanto à escolha D12 aqui expressamente aprovada**.

## 2. Garantias exigidas da implementação autorizada

1. **Um dono de coordenação explícito:** durante operação do daemon, todas as mutações administrativas gerenciadas que afetem credenciais, scopes, entitlement, epochs ou revogação devem ser cercadas por uma fronteira compartilhada, verificável, com ordem definida. Limites de concorrência HTTP, fila por instância, transações independentes ou checagens pontuais não comprovam esse requisito.
2. **Escritores offline:** bootstrap, CLI/recovery e qualquer outro escritor gerenciado devem obedecer a exclusão/fencing verificável em relação ao daemon. Escrita offline só pode ocorrer após comprovação de posse exclusiva; impossibilidade de garantir exclusão deve resultar em **fail-closed**, nunca fallback silencioso de escrita direta. Não pressupor que todos os scripts legados respeitam a fronteira sem inventário e teste.
3. **Gates de autoridade:** qualquer futuro gate de emissão, reserva ou submissão que reivindique observar autoridade precisa ser coberto pelo mesmo modelo de coordenação, com identidade/entitlement/epoch atuais verificados dentro da fronteira prometida. **Nenhum desses gates operacionais é criado ou autorizado neste ADR.** O modelo deve registrar limitações de chamadas já autenticadas/admitidas.
4. **Integridade durável:** preservar D09, D14 e B2-2: gerações/epochs monotônicos, limites correlacionados, `NULL` como zero entitlement, revogação e extinção permanente de grants antigos após alteração efetiva de autoridade. Não registrar segredos em MissionStore ou diagnósticos.
5. **Crash e retry:** depois de falha, queda de processo, commit com resposta incerta ou desconexão, reabrir/consultar fatos duráveis e revalidar antes de decidir. Sem replay cego, grants sintéticos, conclusão inventada ou reversão presumida de efeitos externos. Qualquer identidade/idempotência de futura emissão depende de contrato próprio.
6. **Custo e isolamento:** mecanismo limitado, sem polling cego, loops/retries ilimitados, novo broker ou framework de supervision. Shutdown e recovery preservam fatos não terminais e não sacrificam segurança para obter disponibilidade.

A proteção requerida é contra concorrência entre **escritores gerenciados dentro do trust boundary local**. Não promete isolamento contra root/administrador do host comprometido, DDL arbitrário ou alteração externa de arquivos SQLite por atores fora da fronteira gerenciada.

## 3. Garantias explicitamente NÃO estabelecidas

- **Não existe atomicidade cross-store:** AuthStore (`local-control-auth.db`) e MissionStore (`missions.db`) continuam em arquivos/conexões/transações separados. A ordem do daemon não faz dois commits serem all-or-nothing. Crash entre os commits pode produzir estado parcialmente persistido, inclusive resposta incerta após commit.
- **Não existe garantia de zero efeitos pós-revogação:** efeitos externos já submetidos, em trânsito ou de resultado incerto não podem ser cancelados, revertidos ou reexecutados apenas porque a autoridade foi alterada.
- **Não existe SLA de propagação, exatamente-uma-vez distribuído, recuperação de backup integral contra rollback, nem garantia automática de precedência de revoke sobre operações já admitidas.** Propriedades mais fortes exigem outra decisão e evidência.
- A **Alternativa 2 (unificação transacional)** permanece opção futura se passar a ser obrigatória indivisibilidade local da leitura de autoridade e do fato Mission; isso exige nova autorização e migração própria. A Alternativa 3 não é o contrato selecionado para novos fluxos coordenados.

## 4. Alcance da autoridade desta ratificação

Esta aprovação autoriza **somente** registrar D12 e, após issue operacional filha delimitada, implementar componentes internos de propriedade, coordenação, fencing e recuperação que preservem a autoridade já aprovada. A PR de ratificação é documental.

**NÃO ratifica e NÃO autoriza implicitamente:**

- D01, D04, D05, D07, D10, D11 ou D13, que permanecem `NEEDS_APPROVAL`;
- scope novo (`mission.grant_capabilities` ou outro), principal/issuer novo, grants operacionais, entitlement implícito, emissão/revogação/leitura pública de grants;
- endpoint RPC administrativo novo, mudança de auth/permissões/protocolo público, nova superfície CLI que amplie autoridade, nem transporte obrigatório; **se a implementação precisar dessas mudanças, trazer proposta concreta ao gate normativo antes de ativá-las**;
- planner/acceptance/dispatch, conector de produção, efeitos externos, Runstead/Katherine/Cadinho, UI/M2, migração de banco, alteração de ownership ou relaxamento de recovery.

A ratificação da topologia **não autoriza por si só** alterar semânticas de credencial ou o contrato público existente. Enquanto não existir rota administrativa aprovada no daemon, um caminho de escrita concorrente deve permanecer bloqueado/conservador; não anunciar coordenação completa prematuramente.

## 5. Decomposição e prova obrigatória

A issue operacional B2-4 deverá começar por inventariar **todos** os escritores gerenciados, inclusive CLI direta, bootstrap, fixtures e scripts legados, distinguindo produção de testes. Implementar primeiro a menor parte testável sem ampliar contratos públicos. Se uma garantia depender de RPC novo, autoridade nova ou mudança de produto, **parar em NEEDS_APPROVAL** e devolver o contrato ao mantenedor/Pedro.

Antes de alegar cumprimento, exigir pelo menos:

- RED/GREEN determinístico com processos reais e SQLite real para exclusão/ordenação, CLI concorrente, daemon ativo, bootstrap/recovery offline e writer que não obedece à fronteira;
- falha fechada quando fencing não puder ser adquirido ou estado estiver corrompido/indisponível; ausência de deadlock e limite de espera;
- crash antes/depois de commits, reinício e resposta incerta sem reexecutar efeito nem ressuscitar autoridade;
- preservação de revogação, epochs/HWM, entitlement e autenticação atual; teste de isolamento, logs sem segredo, `mission.create` ainda inerte;
- `bun install --frozen-lockfile` na raiz e em `web/`, `bun run check`, `git diff --check`, revisão no HEAD exato, CI de PR e pós-merge; Bun 1.3.9 conforme baseline.

Não interpretar teste de fixture/ledger interno como prova de emissão ou integração real de grants. Mantenedor só conclui a issue após PR integrada em `main`, verificação pós-merge e documentação factual coerente.

## 6. Estado de rastreamento

A issue #166 permanece **OPEN / DESIGN / NEEDS_APPROVAL** para D01, D04, D05, D07, D10, D11 e D13. D12 fica **RATIFICADA PARCIALMENTE** apenas com os limites acima; integração de emissão/dispatch continua bloqueada. O B2-4 é a próxima folha executável, **não** o fechamento do trust model.
