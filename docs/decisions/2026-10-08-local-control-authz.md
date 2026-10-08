# Decisão de segurança: autenticação e autorização do controle local

> **Estado:** APROVADA por Pedro em 2026-10-08; **implementação PENDENTE** na [issue #122](https://github.com/Anakyklos/ouroboros-runtime/issues/122).
> **Autoridade:** decisão normativa do owner sobre o trust model do Ouroboros. Não representa comportamento implementado, nem altera por si só o contrato público em produção.
> **Vínculos:** [epic #70](https://github.com/Anakyklos/ouroboros-runtime/issues/70), [issue #100 / PR #119](https://github.com/Anakyklos/ouroboros-runtime/pull/119), `docs/ARCHITECTURE.md`, `docs/DAEMON_EVENT_CONTRACT.md`, `docs/MISSION_CONTRACT.md`.
> **Baseline auditado:** `main` em `94bbb3329127fb5e647228e39de54b4391bf5dc8`.

## Contexto e evidência

Ouroboros é o control plane de Missions; daemon mantém policy, lifecycle, estado durável e authority, e clientes são interfaces. O contrato #70 já afirma que nenhuma UI adquire autoridade só por residir no mesmo computador.

Na reprodução descrita pelo executor, usando daemon real, bind loopback, porta efêmera, SQLite temporário e dados fictícios, um cliente local sem credenciais:
- leu projeções sanitizadas de Mission e Invocation em `local_control.read` e no snapshot WebSocket;
- executou pause/resume/cancel via `local_control.command`, com pause/cancel persistidos;
- alterou mode e emergency brake, persistidos, e invocou `system.shutdown`, encerrando listener.

`server.ts` define `sessionToken` e `apiKey` como opcionais, mas os handlers `POST /rpc` e `GET /ws` não os verificam. `RpcGateway.handleRequest` também envia mensagens brutas de exceção ao transporte: a reprodução com falha *injetada* confirmou o caminho de exposição, não exposição natural de dados secretos.

**Classificação:** P1 confirmado no cenário de processos locais sem credencial, conforme evidência do executor; **não** há comprovação de acesso remoto, vazamento de prompts/segredos, nem isolamento forte entre processos do mesmo UID.

## Decisão aprovada

1. **Transporte inicial:** manter HTTP JSON-RPC e WebSocket **apenas em loopback** durante a correção. A recomendação HYBRID da PR #119 não autoriza migrar transporte; UDS/híbrido ficam adiados.
2. **Identidade:** todo cliente de controle protegido deve autenticar-se com uma credencial explícita provisionada pelo operador de confiança. Mesmo host e mesmo UID **não** são provas suficientes de autorização. Identidade, escopos e revogação são atributos reconhecidos no daemon, jamais confiados a campos enviados pelo cliente.
3. **Autorização:** a avaliação é **por operação** e ocorre antes de qualquer chamada a serviço, consulta sensível, snapshot/evento ou efeito persistente. Política default-deny, sem permissões implícitas para métodos desconhecidos, dinamicamente registrados ou de gateway legado/injetado.
4. **Escopos independentes:** `mission.read`, `mission.control`, `daemon.admin`. Não existe promoção/hierarquia automática entre escopos. Um cliente pode receber múltiplos escopos quando explicitamente provisionado.
5. **Fail-closed:** ausência, expiração, revogação, credencial inválida, scope ausente, configuração incompleta e versão incompatível jamais ativam acesso anônimo ou credencial alternativa implícita.
6. **Provenance não é autoridade:** `pausedBy`, `cancelledBy`, mission IDs, versão e `reason` são dados do cliente. Não substituem identidade autenticada, aprovação humana ou gates de policy.

### Matriz mínima normativa

| Superfície | Operações incluídas | Escopo requerido |
| --- | --- | --- |
| `POST /rpc` | `local_control.read` (inclusive `protocol.negotiate`, `health`, `status`, `mission.*`, invocations, capability, diagnostics) | `mission.read` |
| `POST /rpc` | `session.list`, `session.get`, `daemon.status`, `system.health`, `system.version` | `mission.read` |
| `POST /rpc` | `local_control.command` (`mission.pause`, `mission.resume`, `mission.cancel`) | `mission.control` |
| `POST /rpc` | `daemon.setMode`, `daemon.emergencyBrake`, `system.shutdown` | `daemon.admin` |
| `GET /ws` | handshake, snapshot, sequência de eventos e reconnect | `mission.read` antes de qualquer dado |
| `GET /health`, `GET /` | health/version **mínimos** sem estado de Mission, Invocation, session ou dados sensíveis | Podem permanecer anônimos |
| Método/evento/rota não classificado(a) | Qualquer superfície extra ou dinâmica | **DENY por padrão**; mapear explicitamente antes de habilitar |

Estas regras dizem respeito à **autorização de acesso ao controle local**. A policy determinística de Missions e as verificações de state transition permanecem obrigatórias mesmo para clientes autenticados. Escopo não substitui aprovação de efeito, policy da Mission nem authority do MissionEngine.

## Ciclo de credenciais e clientes

- Gerar material secreto com entropia criptográfica; mapear identidade e escopos **no servidor**, com provisão controlada por operador. Não usar `credentialScope` de providers como token de autenticação; provider credentials têm outro owner/propósito.
- Definir bootstrap seguro e explícito para o primeiro cliente, armazenamento local de acesso restrito (diretório `0700`, arquivo `0600` quando aplicável), renovação/rotação e revogação. Não persistir valor bruto em logs, dados de Mission, SQLite de evidências, snapshots, URLs, query strings ou mensagens de erro.
- Um daemon sem configuração de autenticação válida **não deve abrir listener de operações protegidas**. Não implementar `--insecure`, fallback para token compartilhado fixo, permissões universais silenciosas ou autoemissão de token administrativo a clientes anônimos.
- CLI administrativa deve obter credenciais de uma fonte explicitamente provisionada, sem exposição em stdout/argumentos de linha de comando ou logging. Sem token, retornar falha sanitizada e nenhum efeito.
- Browser/WebSocket: autenticar antes de enviar snapshot; validar Origin de browser contra allowlist explícita e proteger o endpoint contra CSRF/CSWSH. `Origin` não é mecanismo de autenticação; cliente sem Origin continua obrigado a apresentar credencial. Não transportar segredo de longa duração na URL/query; evitar token durável em subprotocolo que possa aparecer em telemetry/logs.
- Aplicar limites de payload, proteção contra requests malformados e comparação de segredos resistente a timing quando aplicável. Nunca ecoar credenciais ou headers.
- Distinguir o caso de autenticação de clientes de um eventual compromisso do mesmo usuário do SO: arquivos `0600` protegem principalmente contra **outros usuários**, e não garantem sigilo diante de processo malicioso com acesso ao mesmo UID e arquivos de credenciais. Não prometer essa propriedade no produto.

## Resposta de erro e evidência

- A boundary externa deve emitir códigos estáveis e mensagens bounded/redigidas; nunca repassar diretamente `Error.message` de storage, path, token, provider, connector ou payload não confiável.
- Diagnóstico detalhado, se necessário, fica separado no logging interno sanitizado e não contém credenciais ou conteúdo bruto de Mission.
- Rejeições precisam demonstrar **zero leitura protegida e zero mutação**: nenhuma gravação de Mission, Invocation, mode/brake, nenhuma parada do serviço, nenhum snapshot/evento antes de auth, mesmo em concorrência/reconnect/revocation.
- Recuperação e restart mantêm a política. Revogação deve invalidar acesso futuro, incluindo stream existente ou reconexão, conforme contrato implementado e testes.
- A implementação deve preservar os contratos versionados existentes; se houver mudança incompatível de interface, versioná-la explicitamente, sem downgrade anônimo.

## Aceite, implementação e exclusões

A issue [#122](https://github.com/Anakyklos/ouroboros-runtime/issues/122) define a unidade de execução: uma PR, teste RED→GREEN, E2E com daemon real/SQLite temporário e canários, matriz RPC × scope e WS, clientes válidos/inválidos/revogados, CLI funcional, falhas de bootstrap/restart, redaction e `bun run check`.

**Fora de escopo:** migrar para UDS/híbrido, oferecer controle remoto, construir UI M2, alterar interfaces cross-project Runstead/Katherine/Cadinho, modificar ownership de capability, reescrever scheduler ou implementar supervisão genérica #59.

## Evolução documental e precedência

- **Aprovado:** esta política de autorização para controle local; **pendente:** implementação e provas.
- O documento `docs/DAEMON_EVENT_CONTRACT.md` descreve corretamente o **estado corrente sem auth WS** até #122 ser implementada. Após merge da implementação, atualizar esse contrato para refletir o comportamento verificado.
- `docs/ARCHITECTURE.md` e #70 mantêm a direção mais ampla: daemon autoritativo + contrato local versionado + interfaces substituíveis. O HTTP loopback desta correção não redefine o IPC preferido de longo prazo.
- Nenhum modelo, UI ou cliente pode expandir unilateralmente os escopos ou alterar esta decisão normativa.
