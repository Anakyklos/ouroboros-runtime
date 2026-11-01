# B2-1 — Entitlement lifecycle e ordenação cross-store

> **Classificação:** investigação factual + recomendações PROPOSED; nenhuma recomendação abaixo está ratificada.
> **Escopo:** issue #166, slice B2-1. Documento exclusivamente técnico e documental.
> **Baseline auditado:** origin/main em 2026-11-01, SHA a4564d4cf650d9b1b11ed062500966150ffbecae.
> **Fora do escopo:** emissão operacional de grants, RPCs, migrations, scopes, enforcement, planejamento, dispatch e efeitos externos.

## 1. Baseline auditado e autoridade das fontes

### 1.1 Referências e classificação

| Classe | Fato auditado |
|---|---|
| CURRENT | origin/main estava em a4564d4cf650d9b1b11ed062500966150ffbecae. O CI pós-merge desse SHA é [run 41340145287](https://github.com/Anakyklos/ouroboros-runtime/actions/runs/41340145287), success. O worktree B2-1 foi criado desse SHA; o checkout compartilhado não foi alterado. |
| CURRENT | O ledger inerte do Slice A está em ab2be0e45192390c7f925e7b366cfe519565ec94 (PR #168). B1 está em 17b94f1c2a0076b41b6965c40f42c4bca09847a8 (PR [#172](https://github.com/Anakyklos/ouroboros-runtime/pull/172)). |
| RATIFIED | O ADR do Slice A aprova D03, D06, D08 e D15; o ADR B1 aprova D09 opção 1 e D14 opção A, apenas para gerações/épocas internas e mudança de scopes. Ver [ADR Slice A](../decisions/2026-11-01-capability-grants-slice-a-partial-ratification.md) e [ADR B1](../decisions/2026-11-01-authstore-authority-generations-b1-ratification.md). |
| NEEDS_APPROVAL | D01, D02, D04, D05, D07, D10, D11, D12 e D13 continuam pendentes. A recomendação de mission.grant_capabilities e limits_json na PR #173 não é ratificação. |
| CURRENT | Não existe emissão operacional de grants, entitlement source, RPC de grant, validação de grant no MissionEngine ou enforcement na policy/dispatch. A matriz de scopes contém apenas mission.read, mission.control, mission.create e daemon.admin ([contrato](../../shared/local-control-auth-contract.ts#L1-L9)). |

Esta auditoria respeita a hierarquia do repositório: comportamento vem de código/testes; decisões ratificadas vêm dos ADRs; propostas históricas permanecem propostas. MissionStore e AuthStore são bancos e autoridades diferentes, mesmo quando abertos pelo mesmo processo.

### 1.2 Fontes examinadas

Foram lidos AGENTS.md, [arquitetura](../ARCHITECTURE.md), [matriz de legado](../LEGACY_MATRIX.md), [contrato Mission](../MISSION_CONTRACT.md), [baseline](../BASELINE.md), [guia de auth local](../LOCAL_CONTROL_AUTH.md), [análise de readiness B2](./capability-grants-b2-authority-readiness.md), [contrato histórico de grants](./operator-capability-grant-trust-contract-2026-10-29.md) e os dois ADRs ratificados acima. O comportamento descrito a seguir foi confrontado com a implementação e testes SQLite atuais; o contrato histórico não é tratado como implementação.

**Reconciliação de provenance:** o contrato histórico foi escrito em HEADs anteriores e ainda contém o status “B1 não implementado” e alternativas de D14 anteriores à ratificação. A nota de supersessão em seu cabeçalho/fecho identifica 17b94f1 como a implementação posterior de B1. Os ADRs foram preservados quanto às decisões; notas aditivas registram somente a mudança factual de status. Nenhuma proposta antiga sobre entitlement, RPC ou D12 foi promovida a decisão.

## 2. Auditoria de identidade, autoridade e caminhos de escrita

### 2.1 Fluxo atual de autenticação

1. O bearer contém um clientId codificado e um segredo aleatório. O parser valida forma/canonicalização do identificador; o segredo só autentica depois de comparar seu SHA-256 em tempo constante com token_hash da linha correspondente ([parser e AuthStore](../../cli/src/daemon/local-control-auth.ts#L163-L172), [token parser](../../cli/src/daemon/local-control-auth.ts#L720-L747)).
2. O AuthStore rejeita cliente ausente, revogado, expirado, hash divergente e scopes inválidos. A identidade retornada usa row.client_id, não um clientId livre enviado nos parâmetros RPC.
3. No HTTP RPC, o daemon autentica, classifica método/operação com requiredLocalControlScope, verifica o scope e revalida a credencial atual antes de encaminhar o handler ([boundary RPC](../../cli/src/daemon/server.ts#L513-L558), [mapa de scopes](../../cli/src/daemon/local-control-auth.ts#L686-L714)). A admissão de Mission usa principal.clientId como chave de idempotência ([admission](../../cli/src/daemon/local-control-admission.ts#L130-L160)).
4. Nenhum caminho atual mapeia mission.grant_capabilities ou métodos mission.*capability*grant* a scope. Os testes afirmam que esses métodos são negados e que o conjunto público de scopes permanece inalterado ([teste B1 de superfície](../../cli/src/daemon/local-control-auth.authority.test.ts#L556-L561)).
5. A CLI valida clientId, nomes de scopes e duração antes de chamar provision; o Store repete validação de identidade/scopes e exige expiração futura antes do SQL ([CLI](../../cli/src/commands/admin-cli.ts#L72-L105), [Store](../../cli/src/daemon/local-control-auth.ts#L93-L100)). A CLI comita a linha de credencial antes de publicar o arquivo de bearer; esses dois artefatos não compartilham transação. Uma falha entre ambos pode deixar a credencial nova ativa no AuthStore sem arquivo entregue ao operador.
6. O guia recomenda provisionar com o daemon parado, mas o código CLI não verifica isso: auth provision/rotate/revoke abre o arquivo AuthStore diretamente. Não há RPC administrativo, lock de processo ou coordenação com a fila do daemon nessa rota.

A autenticação prova identidade do cliente e grants de transporte existentes. Ela não prova que esse cliente pode emitir um binding de capability.

### 2.2 Scopes, credential_generation e authority_epoch

- validateScopes aceita somente os quatro scopes atuais, requer lista não vazia e rejeita duplicatas. O SQL e os métodos de autenticação também falham fechados diante de JSON malformado/desconhecido. Nenhum scope operacional de grants existe.
- credential_generation começa em 1 e sobe a cada execução bem-sucedida de provision, incluindo rotação e reprovisionamento. É interna ao AuthStore e não é retornada em LocalControlAuthenticatedClient.
- authority_epoch começa em 1. A provisão compara o conjunto efetivo de scopes, ignorando ordem após validação: mudança do conjunto avança a época; rotação pura com o mesmo conjunto não; reprovisionamento de cliente revogado avança.
- revoke() marca revoked_at e, no código atual, não muda geração ou época. Reprovisionar depois eleva ambas conforme os respectivos invariantes.
- A tabela local_control_authority_epochs mantém high-water mark por clientId. Triggers rejeitam decremento, exclusão, reuse de época, identidade mutável e inserção com REPLACE sob a fronteira gerenciada. LocalControlCredentialStore habilita recursive_triggers = ON e usa INSERT ... ON CONFLICT DO UPDATE; diretório/arquivo têm permissões privadas. A garantia não cobre usuário de host com escrita/DDL irrestrita nem rollback de um snapshot completo do banco ([construtor](../../cli/src/daemon/local-control-auth.ts#L77-L90), [migração](../../cli/src/daemon/local-control-auth.ts#L202-L289), [triggers](../../cli/src/daemon/local-control-auth.ts#L325-L518), [ADR D09](../decisions/2026-11-01-authstore-authority-generations-b1-ratification.md#L12-L18)).
- authority_epoch não é entitlement. O AuthStore não tem limits_json, parser, versão de entitlement, comparação de bindings ou API de atualização de limites.

Os testes de AuthStore com SQLite real cobrem migração/legado, corrupção, rotação, mudanças de scopes, revogação/reprovisionamento, HWM, triggers, rollback via trigger, overflow, restart e seis processos concorrentes de rotação ([testes de autoridade](../../cli/src/daemon/local-control-auth.authority.test.ts#L98-L171), [ciclo de geração](../../cli/src/daemon/local-control-auth.authority.test.ts#L290-L324), [concorrência](../../cli/src/daemon/local-control-auth.authority.test.ts#L518-L554)). Eles comprovam B1; não comprovam entitlement.

### 2.3 Mapa dos escritores e transações atuais

| Dado/arquivo | Escritor atual e validação prévia | Fronteira transacional demonstrada | O que não coordena |
|---|---|---|---|
| local-control-auth.db — cliente/credencial/scopes | runAdminCli(auth ...) cria LocalControlCredentialStore diretamente. provision valida clientId, scopes e expiração antes de gravar; revoke valida clientId. O daemon lê/revalida para autenticar, mas não expõe mutações administrativas hoje. | Migração usa BEGIN IMMEDIATE/COMMIT e rollback. Cada provision é um único INSERT ... ON CONFLICT DO UPDATE com triggers de sincronização do HWM; revoke é um UPDATE. As instruções SQLite e efeitos de triggers são atômicos no próprio AuthStore; os métodos não abrem transação conjunta com outro banco. | Não ordena a CLI contra a fila do daemon nem contra commit em missions.db. A escrita do bearer no arquivo de configuração vem depois do commit SQLite. |
| missions.db — Mission, grants, revogações, invocações | MissionEngine/SqliteMissionStore validam payloads e invariantes do ledger; RPC de emissão não existe. Admissão é a única rota pública que cria Mission e usa scope vazio. | withTransaction usa BEGIN/COMMIT e fila da instância para transições multi-linha. Appends do ledger são incluídos na transação corrente quando há contexto; fora dela são serializados pela fila local e gravados em autocommit ([fila](../../cli/src/mission/sqlite-mission-store.ts#L325-L353), [transação](../../cli/src/mission/sqlite-mission-store.ts#L2353-L2375), [append](../../cli/src/mission/sqlite-mission-store.ts#L950-L1004)). | A fila pertence ao MissionStore/conexão; não bloqueia nem serializa AuthStore, outra instância/processo, CLI ou conector externo. |
| daemon.db — sessões/eventos | startHeadlessDaemon compõe store separado, além de MissionStore e AuthStore ([composition root](../../cli/src/daemon/main.ts#L124-L150)). | Transações locais do respectivo adapter. | Não integra uma transação conjunta de autoridade + Mission. |

O daemon aceita várias operações RPC em voo (padrão 32) e rejeita quando a capacidade se esgota; isso é limite de concorrência, não uma fila de ordenação ([configuração](../../cli/src/daemon/server.ts#L44-L63), [admission RPC](../../cli/src/daemon/server.ts#L543-L558)). O MissionStore serializa suas próprias transações, mas não cria um ponto de linearização cross-store.

### 2.4 Ledger atual e ausência de enforcement

O Slice A adicionou ledger append-only em missions.db, com provenance não secreta e fingerprints. A migração não cria grants sintéticos para Missions antigas; testes SQLite real cobrem restart, idempotência, concorrência, rollback e corrupção ([DDL](../../cli/src/mission/sqlite-mission-store.ts#L759-L899), [testes](../../cli/src/mission/capability-grants.sqlite.test.ts#L93-L159), [restart/idempotência](../../cli/src/mission/capability-grants.sqlite.test.ts#L161-L262)).

A primitiva validateCapabilityGrantCoverage é função pura. Exige evidência de autoridade injetada para aceitar grant/revoker, mas não consulta AuthStore e não compara automaticamente grantorAuthorityEpoch com a linha corrente ([input](../../cli/src/mission/capability-grants.ts#L27-L48), [predicado](../../cli/src/mission/capability-grants.ts#L477-L552)). O teste de D15 rejeita composição entre grants, mas injeta a autoridade como fixture ([testes puros](../../cli/src/mission/capability-grants.test.ts#L78-L117)).

MissionEngine e PlanPolicyValidator continuam autorizando pelo scope já pertencente à Mission e pelo contrato da capability, sem ledger de grants ([policy](../../cli/src/mission/policy.ts#L175-L213)). A admission cria Missões com EMPTY_SCOPE ([local-control-admission.ts](../../cli/src/daemon/local-control-admission.ts#L145-L160)). No dispatch atual, a policy é revalidada antes de uma transação local que reclama a invocation; o seam grava submitted antes de chamar o conector ([dispatch](../../cli/src/mission/mission-engine.ts#L766-L895), [handoff](../../cli/src/capabilities/dispatch-seam.ts#L413-L429)). Nada disso hoje lê D02.

## 3. Modelo candidato para entitlement D02

### 3.1 Representação e identidade

**Candidata principal PROPOSED:** coluna nullable limits_json na mesma linha local_control_clients do AuthStore. É a alternativa recomendada na PR #173, ainda NEEDS_APPROVAL. A linha é identificada por client_id como chave primária; leitura/decisão de emissão deve usar o clientId do principal autenticado do servidor, nunca um identificador livre do payload da chamada.

Forma proposta, versão 1:

~~~json
{
  "schemaVersion": 1,
  "bindings": [
    {
      "capabilityId": "lifeos.journal.read",
      "effectClass": "read",
      "allowedRefPrefixes": ["refs/lifeos/journal/"]
    }
  ]
}
~~~

Cada binding associa uma capability, exatamente uma classe de efeito e o conjunto de prefixos delegáveis para esse par. Recomenda-se no máximo um binding por par (capabilityId, effectClass); prefixos disjuntos do mesmo par ficam na mesma lista. bindings: [] e valor ausente/null autorizam zero grants. Não derivar bindings de scopes, Mission, planner, catálogo ou nome do operador.

A comparação respeita D15: cada grant candidato é unitário; capabilityId precisa ser igual, allowedEffectClasses precisa conter exatamente o effectClass do binding e do CapabilityContract, e cada prefixo pedido pelo grant precisa ser subconjunto de um prefixo do mesmo binding. Um grant não pode tomar capability de uma linha, efeito de outra e refs de uma terceira. Dentro do conjunto de prefixos do mesmo binding, múltiplos prefixos podem ser cobertos, sem produto cartesiano entre bindings. Prefix containment deve comparar categoria, esquema/autoridade URI e segmentos completos; o helper atual compara referência contra prefixo e não implementa sozinho prefixo ⊆ prefixo. Resolução de symlinks/ownership físico continua com o capability owner, conforme o contrato atual.

### 3.2 Validação, canonicidade e limites

O parser futuro deve validar antes de qualquer mutação durável e novamente ao ler dados persistidos:

- objeto fechado com schemaVersion === 1, sem propriedades desconhecidas; estrutura fixa, sem subobjetos recursivos;
- bindings array de objetos completos; IDs não vazios e limitados; effectClass da enum vigente; prefixos validados pelo parser seguro de referências, sem controles, query, fragment, traversal, autoridade URI ambígua ou escapes inválidos;
- pares duplicados, prefixos duplicados e valores semanticamente ambíguos são rejeitados; ordem é canônica e estável;
- mudança de versão desconhecida, tipo inesperado, parse inválido ou erro semântico não recebe fallback para permissões amplas;
- cada comparação cobre um grant inteiro por binding compatível. Não unir arrays de bindings diferentes nem converter arrays planas em um conjunto combinado.

**Limites iniciais recomendados PROPOSED para evitar payload/CPU sem limite:** JSON canônico UTF-8 de até 64 KiB; até 128 bindings; até 64 prefixos por binding; cada identificador/prefixo com até 512 bytes UTF-8. O cap de bytes é total, além dos caps de contagem. Esses números são candidatos para teste/benchmark antes de ratificação, não fatos existentes no runtime. A forma fixa deve tornar o custo previsível e evitar parser com profundidade arbitrária.

### 3.3 Legado, corrupção, admin e lifecycle

- Migração futura seria aditiva e transacional. Registros preexistentes recebem limits_json = NULL: scopes existentes, mission.create, catálogo e ledger inerte não geram entitlement sintético. D06 já é uma regra ratificada para Missions legadas; a não concessão a operadores legados é a recomendação fail-closed para D02 e precisa constar da ratificação de D02.
- NULL significa sem entitlement e nega emissão. Binding vazio também não concede. Não “reparar” JSON corrompido, versão desconhecida ou row inconsistente. Recomenda-se falhar a abertura do AuthStore para valor persistido inválido, em linha com a migração B1 de scopes; leitura/validação em runtime também deve negar se o store se tornar inacessível ou inconsistente. Nenhum cache antigo substitui a fonte após erro.
- A administração futura deve definir set/clear explícito por clientId, restrito ao operador local autorizado. daemon.admin não ganha essa autoridade por implicação. provision/rotate não devem criar limites por inferência de scopes; cliente novo começa sem entitlement.
- Recomendação para reprovisionamento pós-revogação: manter o cliente inativo como hoje; ao reativar, exigir atribuição explícita de entitlement (default NULL) em vez de recuperar limites anteriores sem confirmação. A regra de authority_epoch já exige nova época ao reprovisionar cliente revogado. O impacto da revogação sobre Missions/passos existentes permanece D04; revogação de bearer impede autenticação nova, mas o comportamento do ledger/dispatch não existe.
- Atualização de limites não altera credential_generation nem token. Deve atualizar limits_json e o ordinal de autoridade escolhido abaixo em uma só mutação SQLite, com os guards de escrita correspondentes. No-op canônico não avança ordinal. Redução, ampliação, remoção e reatribuição têm semântica explícita; não esconder mudança dentro de rotate.
- Se uma emissão já estiver persistida quando limites forem reduzidos, o ledger conserva o fato histórico. Validação futura precisa rejeitar grant antigo conforme estratégia aprovada; essa redução não desfaz um efeito já submetido ao conector.

### 3.4 Estratégias A/B/C para mudanças de entitlement

| Critério | A — avançar authority_epoch | B — versão monotônica independente | C — revalidar limites atuais |
|---|---|---|---|
| Simplicidade | Menor mudança durável: reaproveita a época/HWM existente; exige estender triggers/escritores para que qualquer mudança canônica de entitlement também avance a época. | Conceito mais separado; exige novo campo, contador, regras de incremento e HWM/tombstone próprios. | Menor estado persistido; comparação do grant com os limites correntes em cada gate. |
| Ressurreição | Extinção permanente se todo gate futuro exige igualdade entre época do grant e época atual. Redução seguida de ampliação não revive grant anterior. | Extinção permanente se todo gate exige igualdade de versão. Tem mesma propriedade sem sobrecarregar authority_epoch. | Só suspensão dinâmica: se limite voltar a cobrir grant antigo, ele pode voltar a autorizar. Não satisfaz o invariante recomendado. |
| Persistência | AuthStore atual já persiste época/HWM. Mutação de limites + época devem ser uma escrita SQLite atômica. | Nova geração precisa de persistência e HWM próprios para ser monotônica através de revoke/reprovision. | Persiste só o envelope. Sem versão, o ledger não registra qual revisão de limite autorizou a emissão. |
| Concorrência | Atualização fica atômica dentro do AuthStore; a janela até append em MissionStore continua D12. Epoch detecta snapshot obsoleto apenas se comparado no gate futuro. | Mesma janela D12; versão independente também permite detectar snapshot obsoleto no gate futuro. | O gate precisa ler limite fresco; ainda existe TOCTOU entre leitura e MissionStore/efeito. |
| Recovery | Reinício lê limite e época atuais; HWM impede reuse dentro do estado atual do AuthStore. Restore do DB inteiro ainda pode voltar os dois valores. | Reinício lê limite/versão; snapshot completo também reverte ambos sem âncora externa. | Reinício relê limites; reexpansão posterior torna novamente utilizável grant que ficou fora do envelope durante a redução. |
| Retrocompatibilidade | Compatível com contrato público atual se ordinal continuar interno; muda a semântica interna de authority_epoch, hoje ratificada para scopes. Exige aprovação explícita; não é D14 atual. | Mantém semântica de D14; nova coluna é migração interna aditiva. Grants antigos não têm versão de entitlement e precisam falhar fechados. | Não exige novo campo público; todo consumo tem de consultar limite atual. Grants antigos continuariam sem envelope de emissão confiável. |
| Custo operacional | Toda alteração efetiva invalida grants antigos, inclusive ampliação ou mudança benigna; exige reemissão. Reduz ambiguidade de recuperação. | Mesmo custo de reemissão, com novo ordinal para operar/auditar. | Menos reemissão quando grant continua coberto; custo de consulta e análise dinâmica em cada gate e risco de reativação. |
| Complexidade de implementação | Baixa a moderada: validação do JSON, guardas de epoch/HWM e integração futura de validação por igualdade. É menor, mas requer alterar a regra interna de avanço. | Moderada/alta: migração, novos triggers/HWM, provenance e testes adicionais. | Baixa no AuthStore, mas maior no runtime: todos os gates precisam ler e comparar fonte atual sem cache obsoleto. |

**Recomendação técnica para Pedro PROPOSED / NEEDS_APPROVAL: A.** Qualquer alteração canônica de limits_json avança authority_epoch uma vez; quando scopes e entitlement mudarem juntos, uma única transição de época basta. Um grant só pode ser usado futuramente se a identidade estiver ativa, tiver o scope D01, e seu grantorAuthorityEpoch corresponder exatamente à época atual. Esse contrato faz grant antigo permanecer extinto após reduzir e depois ampliar limites.

**Limite normativo:** D14 ratificou avanço por mudança do conjunto efetivo de scopes; o ADR B1 declarou que redução de entitlement não foi decidida. A regra acima é uma nova recomendação para D02/alteração do modelo de autoridade, não uma semântica atribuída a D14. Requer ratificação explícita e mudança futura de implementação. Um HWM dentro do mesmo arquivo não detecta restauração de um backup anterior do arquivo inteiro; rollback de snapshot deve permanecer fora da garantia ou exigir âncora de recuperação independente.

## 4. D02 e D12 conjuntamente: fronteira de emissão

Escolher limits_json põe identidade e envelope na mesma linha/AuthStore e permite que uma atualização de envelope e ordinal seja atômica nesse banco. Isso não torna atômicos o snapshot de autoridade e o append do grant em missions.db. A implementação atual não tem emissão; portanto, não existe hoje um ponto de linearização de grant para descrever como garantido.

### 4.1 Opção 1 — serialização pelo daemon

- **Escritor de autoridade:** o daemon seria o único escritor durante execução normal. A CLI passaria as mudanças administrativas ao daemon por RPC autenticado e entraria na mesma fila/seção crítica da validação + append do grant/reserva Mission.
- **Condição necessária:** a CLI atual viola esse modelo porque escreve diretamente no AuthStore. Deve ser roteada pelo daemon quando ativo; modo bootstrap/emergência offline precisa de exclusão verificável do daemon (ex.: lock de proprietário/processo) e só pode operar sem daemon. Uma convenção “daemon parado” sem fencing não ordena processos concorrentes.
- **Ordenação:** uma fila comum deve ordenar mutação de scopes/entitlement/revogação, emissão e cada gate de submissão que prometa observar autoridade atual. O limite RPC atual de 32 operações em voo não ordena nada.
- **Ponto de linearização:** para emissão, append do grant no MissionStore enquanto a mesma seção crítica permanece dona; para redução antes/depois do append, a fila define qual operação vence. Para impedir uso depois de revogação, cada gate posterior ainda consulta/valida autoridade corrente. A fila não altera fatos já submetidos.
- **Transação e crash:** AuthStore e MissionStore continuam com transações separadas. Crash entre leitura e append pode deixar nenhuma concessão ou, se o append comitou antes do crash/resposta, um fato durável. Use identidade/fingerprint idempotentes e revalide autoridade no replay; não alegar rollback cross-store.
- **O que não garante:** nenhuma proteção contra escritor fora da fila, alteração direta por host com acesso ao arquivo, rollback de snapshot completo ou cancelamento de efeito externo já aceito. Sem controlar CLI/offline writers, não há ordenação garantida.

### 4.2 Opção 2 — transação relacional real em armazenamento unificado

- **Escritor de autoridade:** um coordenador de armazenamento com autoridade de escrita para AuthStore e MissionStore.
- **Condição necessária:** ler identidade/scope/limites/época e gravar grant ou reserva usando a mesma conexão e mesma transação SQLite. Apenas colocar tabelas em um arquivo, manter duas conexões/transações ou usar ATTACH não prova um commit conjunto. A topologia atual usa arquivos distintos.
- **Ordenação:** SQLite ordena writers na base comum; mutação de autoridade antes do commit faz a emissão ver/usar a nova versão e negar se necessário; emissão que comita primeiro fica anterior à mutação seguinte e o próximo gate detecta época diferente.
- **Ponto de linearização:** commit da transação única que leu a autoridade e escreveu o grant/reserva. A mudança administrativa ocorre numa outra transação ordenada pelo mesmo banco.
- **Transação e crash:** snapshot de autoridade e registro Mission são um resultado all-or-nothing. Morte antes do commit reverte ambos; morte após o commit deixa estado durável e resposta incerta, resolvida por idempotência. Recovery reabre o banco, valida schema e registros, sem replay automático de efeitos.
- **O que não garante:** transação SQLite termina antes de invocar conector; não torna SQLite atômico com rede, APIs ou efeito físico. Uma revogação posterior não reverte bytes já submetidos. Migração, backups/WAL, lifecycle e writer allowlist passam a ter superfície nova.

### 4.3 Opção 3 — consistência eventual com garantias limitadas

- **Escritores de autoridade:** AuthStore aceita CLI direta como hoje; MissionStore aceita writes do daemon. Cada store é autoridade apenas de seus próprios fatos.
- **Ordenação:** só existe ordem local no commit de cada banco. A leitura de AuthStore pode preceder ou suceder o append no MissionStore; não existe ordem total compartilhada.
- **Ponto de linearização:** cada atualização tem seu próprio commit local; não há ponto linearizável para “emissão autorizada sob os limites correntes”.
- **Mecanismo contra estado obsoleto:** cada etapa futura deve consultar AuthStore sem cache, negar falha/corrupção, gravar geração/época não secreta no grant e comparar com a linha atual nos gates seguintes. Isso detecta divergência na leitura posterior, mas não remove a janela entre leitura e commit/submit.
- **Transação e crash:** append idempotente só resolve repetição dentro do ledger; AuthStore pode ter atualizado enquanto nenhum grant foi gravado, ou o grant pode ter comitado antes da resposta. Recovery lê ambos e fail-closes discrepâncias; nenhuma compensação apaga ledger append-only.
- **O que não garante:** ordem entre CLI/daemon, grant válido no instante exato do commit, propagação com prazo, zero submissões após mudança, cancelamento ou reversão de efeito já em voo.

**Recomendação técnica para D12 PROPOSED / NEEDS_APPROVAL:** para o escopo M1, a menor boundary coerente é a opção 1 somente se todos os writers forem cercados: CLI delega ao daemon ativo; bootstrap offline é mutuamente exclusivo; mutations de autoridade, emissão e gate autorizado usam a mesma seção crítica. Se não for possível controlar escritores fora do daemon, deve-se escolher explicitamente a opção 2 para atomicidade local ou aceitar opção 3 e documentar a janela sem SLA. D02 não decide D12. Nenhuma das opções promete atomicidade de SQLite com sistemas externos.

## 5. Interleavings de referência

Os interleavings abaixo especificam resultados futuros; não descrevem comportamento de grants ativo hoje.

### 5.1 Emissão e alteração no mesmo cliente

1. Emitir: validar bearer, cliente ativo, scope e limites; capturar clientId, credential_generation, authority_epoch; validar um único binding; persistir grant unitário com fingerprint.
2. Revogar/alterar scope/limite: persistir alteração no AuthStore. Mudança de scopes usa D14 ratificada; mudança de entitlement usa apenas a estratégia proposta em §3.4.
3. Usar grant: revalidar a fonte atual e provenance no gate que antecede o efeito. Se cliente revogado, scope ausente, época divergente ou limite corrompido, negar.
4. Se alteração for ordenada antes da emissão, negar emissão. Se emissão for ordenada antes, conservar fato histórico, mas alteração proposta de época extingue grant antigo antes de qualquer gate futuro. Não apagar grant para simular revogação.

### 5.2 Persistência, crash e replay

- AuthStore mantém atomics locais: migração é transacional; uma mutação de cliente + trigger/HWM é uma instrução SQLite. MissionStore mantém atomics locais: ledger append-only e transações explícitas para operações agrupadas.
- Um crash antes do commit SQLite deixa a escrita sem efeito; depois do commit e antes da resposta pode deixar fato persistido com resultado desconhecido para o chamador.
- Grant futuro precisa de chave idempotente estável e fingerprint do payload canônico. Replay idêntico não duplica; mesma identidade com conteúdo diferente conflita. Replay sempre reautentica e revalida autoridade atual; um replay não pode devolver novo poder após revogação/epoch change.
- Recovery reabre AuthStore/MissionStore, valida schema/JSON/HWM/fingerprints e reconstrói decisões a partir de estado durável. Nenhuma escrita compensatória deve reescrever ledger. Nenhum efeito externo incerto é repetido automaticamente, conforme ADR Slice A.
- Restauração de backup que volta AuthStore e HWM juntos não é detectada pelo HWM do próprio arquivo. Uma garantia de anti-rollback requer âncora externa confiável/protocolo de restore ou exclusão explícita desse evento do threat model.

## 6. Matriz adversarial determinística

**Legenda:** Esperado é o contrato recomendado, não implementação. Hoje limita-se à evidência existente. Cada teste futuro deve rodar contra SQLite real; mocks podem testar parser puro, mas não persistência/ordenação.

### 1. Emissão concorrente com revogação de credencial

- **Estado/eventos:** cliente ativo, scope D01 e entitlement válido; daemon valida; CLI grava revoked_at; daemon tenta appendar grant.
- **Autoridade:** AuthStore para atividade/credencial/época; MissionStore para fato do grant.
- **Esperado:** com D12 forte, revoke antes da emissão vence e nenhuma concessão nova é confirmada; emissão antes do revoke deixa fato histórico que falha no próximo gate. Efeito já submetido não é desfeito.
- **Hoje:** bearer revogado é negado em revalidação; revoke() não muda época. Não há emissão nem uso de grant ligado ao AuthStore.
- **Ausente / decisão / teste:** D04 e D12. Testar ambas as ordens com barrier em dois processos, examinar AuthStore e ledger após restart e afirmar somente bloqueio futuro, sem cancelamento retroativo.

### 2. Emissão concorrente com mudança de scopes

- **Estado/eventos:** emissor autorizado; emissão lê scope/época; CLI remove ou adiciona scope e comita antes/depois do append.
- **Autoridade:** scopes e authority_epoch do AuthStore; D14 ratificada.
- **Esperado:** mutação de scopes avança época; emissão ordenada depois exige scope atual; grants antigos com época anterior não são aceitos em gate futuro.
- **Hoje:** B1 avança época para mudança do conjunto efetivo e preserva rotação pura; predicate de grants não compara AuthStore atual.
- **Ausente / decisão / teste:** integração de grant e ordem D12. Teste SQLite com dois writers e emissão bloqueada entre leitura/append, confirmando época e decisão em cada interleaving.

### 3. Redução de entitlement antes do commit do grant

- **Estado/eventos:** limites autorizam binding G; emissão captura estado; admin reduz envelope antes do append no MissionStore.
- **Autoridade:** limits_json candidato e versão/época no AuthStore.
- **Esperado:** na opção 1/2, redução que lineariza primeiro faz emissão negar. Na opção 3, pode sobrar fato stale, mas ele nunca passa no gate que compara época/envelope atual.
- **Hoje:** não existe limite nem emissor operacional; não há comparação antes de persistência.
- **Ausente / decisão / teste:** D02/D12. Red/green com barrier real entre AuthStore e MissionStore; provar ausência de grant utilizável após redução e nenhuma promessa de commit conjunto na opção eventual.

### 4. Redução de entitlement depois do commit do grant

- **Estado/eventos:** grant G foi persistido sob época E; admin reduz limite e comita nova época E+1; tentativa futura de uso.
- **Autoridade:** ledger preserva provenance histórica; AuthStore decide a época corrente.
- **Esperado:** sob A proposta, todo grant em E fica extinto, mesmo se parte dele ainda caberia no novo limite. Não cancelar/reverter submissão anterior.
- **Hoje:** ledger conserva append; não há limits_json, gate de grant ou epoch check atual.
- **Ausente / decisão / teste:** aprovação da extensão da época. Emitir, reduzir, reiniciar, consultar decisão de coverage com AuthStore real; também verificar que nenhuma expansão posterior reativa G.

### 5. Revogação seguida de reprovisionamento

- **Estado/eventos:** emissor em época E, grant G; revoke; provisiona o mesmo clientId com scopes anteriores.
- **Autoridade:** linha e HWM do AuthStore; grant histórico no MissionStore.
- **Esperado:** revoke torna o principal inativo; reprovision não reutiliza época, como D14. Recomendação adicional: entitlement volta como NULL até atribuição explícita; grants anteriores continuam extintos.
- **Hoje:** revoke mantém época/geração; reprovision incrementa ambos e atualiza scopes/token. Não há campo de entitlement.
- **Ausente / decisão / teste:** D02/D04 e lifecycle de entitlement. Testar revoke/reopen/reprovision/reatribuição, incluindo reuso do mesmo ID, sem recuperar limite antigo implicitamente.

### 6. Restauração de estado de autoridade anterior

- **Estado/eventos:** época E+1 extingue G(E); operador restaura cópia anterior do local-control-auth.db que contém época/HWM E.
- **Autoridade:** arquivo restaurado e eventuais âncoras/manifestos externos, que hoje não existem.
- **Esperado:** não alegar que HWM local detecta rollback do próprio arquivo. Se anti-rollback estiver no threat model, startup deve validar âncora independente e negar estado restaurado; restaurar também MissionStore antigo não pode ser apresentado como seguro sem essa âncora.
- **Hoje:** triggers protegem monotonicidade do estado corrente; D09 exclui ator host irrestrito. Não há checkpoint externo anti-rollback.
- **Ausente / decisão / teste:** definir threat model e protocolo de backup/restore. Testar restauração de AuthStore isolado e de conjunto de arquivos; o teste deve provar rejeição só quando a âncora proposta existir, não simular anti-rollback com mock.

### 7. Corrupção de limits_json

- **Estado/eventos:** row ativa tem JSON truncado, schemaVersion desconhecido, binding malformado ou tipo indevido; tenta autenticar/emitir/usar.
- **Autoridade:** AuthStore persistido; o parser não pode recorrer ao cache nem a grants anteriores.
- **Esperado:** falha fechada. Recomendação: AuthStore não abre se um envelope persistido inválido for encontrado; em erro detectado depois do startup, operação e uso negam sem reparo automático.
- **Hoje:** scopes/ordinais/HWM são validados na abertura e corrupção causa falha; limits_json não existe.
- **Ausente / decisão / teste:** política de erro de D02. Corromper DB SQLite real (incluindo JSON válido mas semântico inválido), reabrir, provar que não há defaults permissivos nem mutação de recuperação.

### 8. Falha entre validação e persistência

- **Estado/eventos:** validação de principal/limites passa; processo morre ou o segundo store falha antes de inserir grant.
- **Autoridade:** AuthStore é leitura; MissionStore é escrita do ledger.
- **Esperado:** nenhuma resposta de sucesso sem fato durável. Sem opção 2, o sistema admite estado parcial; retry com a mesma chave/fingerprint resolve resultado desconhecido sem duplicar. Se autoridade mudou, replay deve negar uso/emissão corrente.
- **Hoje:** append tem validação local, transação local quando ambientada e autocommit próprio fora dela; AuthStore não participa. O teste de rollback cobre transação do MissionStore, não crash cross-store.
- **Ausente / decisão / teste:** D12 e contrato de idempotência. Fault injection entre leitura AuthStore e append SQLite, matar/reabrir processos e comparar ambos os DBs, sob cada topologia escolhida.

### 9. Falha entre persistência e resposta ao cliente

- **Estado/eventos:** grant comitou no MissionStore; daemon termina antes de responder; cliente não sabe se houve sucesso.
- **Autoridade:** ledger durável para existência; AuthStore para reautorização/replay.
- **Esperado:** replay idêntico identifica o mesmo fato; conteúdo divergente conflita; a resposta não torna o grant ativo sem revalidação corrente.
- **Hoje:** appendCapabilityGrant é idempotente por (missionId, grantId) + fingerprint em SQLite; não existe handler RPC.
- **Ausente / decisão / teste:** chave de idempotência pública ainda depende de contrato de emissão. Reiniciar entre commit/resposta e repetir mesma/diferente requisição, provando um único fato e reauth antes de devolver resultado.

### 10. Replay de requisição após restart

- **Estado/eventos:** chamada de emissão pode ter comitado antes do crash; daemon reinicia e recebe replay.
- **Autoridade:** AuthStore corrente + registro do grant recuperado do MissionStore.
- **Esperado:** persistência idempotente e autoridade reavaliada após restart; nunca reconstruir limite do payload antigo como fonte de verdade.
- **Hoje:** ledger real persiste e aceita append idêntico; admission de Mission tem idempotência separada. Não há RPC/grant replay.
- **Ausente / decisão / teste:** contrato de replay e D12. Teste E2E com dois processos e DB real, restart entre requests, replay idêntico e divergente; verificar scope, época e entitlement atual.

### 11. CLI administrativa concorrendo com daemon

- **Estado/eventos:** daemon valida snapshot; processo CLI atualiza scopes/revoga (ou, no futuro, entitlement) no AuthStore; daemon grava em MissionStore.
- **Autoridade:** CLI é hoje escritor direto de AuthStore; daemon é writer de MissionStore.
- **Esperado:** opção 1 só pode prometer ordem se CLI usar RPC/fila comum ou se offline estiver fenced; opção 2 lê/grava por transação compartilhada; opção 3 admite stale window explicitamente.
- **Hoje:** comandos CLI abrem AuthStore diretamente; servidor permite RPC em voo e não serializa operações AuthStore/MissionStore em uma fila compartilhada.
- **Ausente / decisão / teste:** D12. Teste concorrente com CLI real e daemon real, dois DBs separados, barriers determinísticos, conferência do resultado para cada order; provar que escritor direto é bloqueado/roteado antes de atribuir ordem.

### 12. Processo encerrado durante alteração de autoridade

- **Estado/eventos:** matar processo durante provision, revoke ou futura atualização de limites; reabrir AuthStore após WAL recovery.
- **Autoridade:** transação SQLite do AuthStore e HWM no mesmo arquivo.
- **Esperado:** linha e HWM recuperam ambos antes ou ambos depois, sem época parcial; falha/corrupção nega. O arquivo de bearer é publicado separadamente e pode não acompanhar commit.
- **Hoje:** instruções cliente + trigger são locais; migration tem begin/commit; testes forçam abort via trigger e testam restart, mas não provam todas as janelas de morte do processo/host.
- **Ausente / decisão / teste:** durability/synchronous e processo de recovery. Kill tests determinísticos em subprocesso antes/depois do commit, reopen real e comparação da linha/HWM/limits_json; separar resultado SQLite da publicação de bearer.

### 13. Grant antigo utilizado depois de mudança de época

- **Estado/eventos:** ledger contém grantorAuthorityEpoch = E; AuthStore muda scopes/época para E+1; tenta dispatch usando G(E).
- **Autoridade:** epoch atual + high-water mark AuthStore, grant histórico MissionStore.
- **Esperado:** negar grant antigo; não comparar apenas credential_generation, que muda também em rotação pura. Adições de scopes também mudam época conforme D14.
- **Hoje:** grantor_authority_epoch é nullable no ledger e no predicado puro não há comparação automática com AuthStore. D14 existe no Store, mas não está conectado a grant.
- **Ausente / decisão / teste:** binding da autoridade validada ao coverage/dispatch. SQLite real, persistir G(E), avançar época, restart e verificar negativa; pure test isolado não prova o vínculo.

### 14. Grant persistido válido, seguido de redução de entitlement

- **Estado/eventos:** G(E) foi persistido e passava no envelope; redução para E+1; depois os limites originais são restaurados.
- **Autoridade:** valor atual versionado do AuthStore mais provenance imutável no ledger.
- **Esperado:** A proposta mantém G extinto após redução e restauração; reatribuição exige grants novos. Se Pedro preferir suspensão dinâmica, deve assumir explicitamente que expansão pode reativar G (C), contra a recomendação deste contrato.
- **Hoje:** não existe envelope nem gate de uso; ledger pode persistir fato histórico inerte.
- **Ausente / decisão / teste:** D02 e regra de mudança. Testar shrink → restart → expand → attempt, incluindo grant que ainda cabe no limite reduzido, para distinguir extinção de suspensão.

### 15. Efeito externo já submetido quando ocorre revogação

- **Estado/eventos:** invocation cruza o seam e submitted é persistido; conector recebe a chamada; AuthStore é revogado/reduzido antes da resposta externa.
- **Autoridade:** ledger/AuthStore controla autorizações futuras; o sistema externo controla o resultado já recebido.
- **Esperado:** não alegar rollback/cancelamento. Resultado pode concluir ou ficar incerto; restringir próximas submissões nos gates atualizados. A execução que já cruzou o boundary não é revertida por mudar AuthStore.
- **Hoje:** seam persiste submitted antes de connector.invoke; exceção após handoff fica uncertain. Não existe grant authorization ou mecanismo cross-store de revogação ali.
- **Ausente / decisão / teste:** D04, D10, D11, D12 e capability de cancelamento do owner. Teste com conector bloqueado/barrier: submeter, revogar, liberar resposta e provar que nenhum relato afirma efeito revertido nem retry cego.

## 7. Garantias atuais versus propostas

| Tema | CURRENT comprovado | PROPOSED / lacuna |
|---|---|---|
| Identidade/scopes | Bearer ligado a clientId de linha autenticada; quatro scopes; revoke/expiry/rotação revalidados no boundary. | D01 para emissão e D02 envelope por emissor. |
| Gerações | credential_generation, authority_epoch para scopes e HWM duráveis no AuthStore; triggers e testes SQLite real. | Nenhuma leitura desses valores por emissão/dispatch de grant. |
| Entitlement | Não existe. | limits_json por cliente, schema versionado, validação fechada. |
| Ledger | Append-only, unitário, correlacionado, idempotência por identidade/fingerprint e restart; sem synthetic grants para legacy. | RPC/serviço de emissão e validação de authority ainda ausentes. |
| Redução | B1 extingue grants antigos em mudanças de scopes se futuramente interpretados conforme D14; no código atual esse enforcement ainda não conecta ledger. | D02 deve escolher dinâmica, época existente estendida ou geração separada. Recomendação A exige decisão nova. |
| Cross-store | Transações locais separadas; CLI AuthStore direta; fila MissionStore local; não há ponto de linearização conjunto. | D12 escolhe daemon com fencing, store unificado real ou consistência eventual com garantias menores. |
| Recovery | Cada store valida seu estado; grants persistem e replay idêntico de append é deduplicado; corrupção do ledger falha fechado. | Não há recuperação conjunta nem anti-rollback de backup completo; integração futura deve definir isso. |
| Efeitos externos | Handoff atual precede chamada; após submission pode existir resultado incerto. | Nenhuma alternativa D12 oferece atomicidade com sistema externo ou reversão física. |

## 8. Recomendações para ratificação de Pedro

Estas são recomendações, não decisões:

1. **D02:** selecionar limits_json nullable no AuthStore por clientId; bindings correlacionados, schemaVersion 1, fail-closed para nulo/ausente/inválido e sem entitlement sintético para clientes existentes.
2. **D02 + lifecycle:** recomendar estratégia A, em regra nova e explícita: toda mudança canônica de entitlement avança authority_epoch, invalidando grants anteriores em shrink, expand, clear e reassign. A implementação futura deve validar igualdade de época; a recomendação não altera hoje o alcance ratificado de D14.
3. **D02 + D12:** não considerar que coluna no AuthStore resolve a corrida. Se a garantia desejada exige ordem, escolher serialização pelo daemon com todos os writers cercados, ou transação real com AuthStore e MissionStore sob a mesma conexão. Sem isso, selecionar eventual consistency e declarar que a decisão representa o snapshot observado, não a autoridade exata no commit/submission.
4. **Reprovisionamento:** exigir atribuição explícita de limites depois de revoke/reprovision, para que o mesmo clientId não herde capacidade delegatória sem confirmação operacional.
5. **Revogação/efeitos:** separar “nega novas admissões/gates após revalidação” de “cancela Mission” ou “reverte efeito já submetido”. D04 e decisões de delivery continuam próprias.
6. **D01:** mission.grant_capabilities é recomendação da PR #173 e continua pendente; scopes existentes não o implicam.
7. **D05/D07/D10/D11/D13:** permanecem dependências independentes. Nenhuma conclusão deste slice decide leitura/revogação cross-grantor, contrato de submission, delivery, cancelamento, downgrade ou recovery externo.

## 9. Contrato de verificação para futura implementação

Uma issue operacional futura deve exigir, no mínimo:

- migration aditiva/atômica com fixture legada contendo clientes ativos/revogados; NULL para todos os limites legados; migration repetida; nenhuma reescrita de scopes/credenciais; falha fechada em schema parcial/corrupto;
- parser real cobrindo versão desconhecida, campos extras/ausentes, duplicatas, limite de bytes/contagens, efeitos desconhecidos, IDs malformados, prefixos traversal/URI/sibling e comparação grant-prefix dentro do mesmo binding;
- testes matriciais que provem ausência de produto cartesiano entre bindings e grants, e que cada binding do grant seja coberto por um único binding de entitlement;
- under A: cada mudança semântica de limites avança epoch exactly once, no-op não avança, shrink→expand não reativa grant antigo, rotação pura preserva epoch, scopes seguem D14, revoke/reprovision nunca reutiliza valor. Testar guards com conexão gerenciada e unmanaged, REPLACE, trigger abort e overflow;
- AuthStore e MissionStore SQLite reais, WAL/restart, replay idêntico e conflitante, falhas antes/depois do commit/resposta, corrupção de páginas/JSON/fingerprint e recovery sem escrita compensatória ou duplicação;
- concorrência em subprocessos separados entre CLI administrativa, daemon e dois pedidos de emissão, com barriers e assertions de ordem para cada interleaving. A opção 1 precisa provar que CLI direta está fenced; teste com um Mutex in-memory isolado não é prova cross-process;
- para opção 2, demonstrar em teste que leitura atual de autoridade e append/reserva ocorrem na mesma conexão/transação; duas conexões para o mesmo arquivo não contam como evidência suficiente;
- para opção 3, comprovar explicitamente o comportamento limitado: sem prazo de propagação, com stale snapshot possível, gate posterior fail-closed e sem alegação de zero efeitos;
- restart com grant antigo + autoridade atual, e teste de backup rollback conforme ameaça/âncora escolhida. Sem âncora externa, registrar que restauração conjunta de snapshot não é detectada;
- verificar que token/hash/segredo não entra no ledger, que scopes/contratos públicos não mudaram, que grants continuam inertes até decisões e integração futuras e que nenhum mock é usado como prova de persistência/atomicidade;
- rodar bun install --frozen-lockfile, cd web && bun install --frozen-lockfile, bun run check, git diff --check, registrar Bun local/pinado e CI no SHA exato.

## 10. Dependências e bloqueios remanescentes

- D01: scope operacional de emissão.
- D02: source, forma, legado, corrupção, atualização e semântica de redução/ampliação.
- D04: efeitos da revogação de credencial sobre Missions/passos.
- D05/D07: projeção e autoridade de revogação.
- D10/D11: fronteira de submission e validação de delivery.
- D12: coordenação AuthStore/MissionStore/CLI e limite de consistência.
- D13: downgrade, backup e restore sem perda de evidência.
- Qualquer grant continua sem issuer source e sem gate integrado até tarefa operacional futura autorizada. Esta análise não altera a issue #166, não encerra gates e não autoriza iniciar B2 operacional.
