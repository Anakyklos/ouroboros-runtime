# Daemon headless local — operação e limites

Este guia descreve o entrypoint implementado no repositório. Ele não declara
concluída a epic M1 (#70) nem apresenta a interface desktop como disponível.

## Estado das opções

| Estado | O que significa neste guia |
|---|---|
| **Current** | Comportamento presente no código e coberto pelos contracts/testes atuais. |
| **Direction** | Arquitetura desejada, ainda sem equivalência operacional comprovada. |
| **Legacy** | Scripts, rotas ou componentes antigos que não pertencem ao caminho atual. |
| **Hypothesis / não suportado** | Opção sem avaliação ou evidência de deployment suficiente. |

O daemon atual é um processo Bun em primeiro plano, com HTTP/WebSocket
autenticado em loopback. Não há deployment de produção validado para acesso
remoto, Nginx público, Docker oficial, unidade systemd de sistema ou frontend
Mission Control servido pelo daemon.

## Requisitos e instalação

- Bun **1.3.9 ou superior** (CI fixa 1.3.9).
- Instale as dependências usando os lockfiles versionados:

```bash
bun install --frozen-lockfile
cd web
bun install --frozen-lockfile
cd ..
```

`bun run check` é o gate de integridade do repositório: instalação congelada,
compilação runtime/CLI, build web e testes obrigatórios. Ele não instala nem
configura um serviço de sistema.

## Entry points e configuração atual

Os comandos existentes relevantes no `package.json` raiz são:

| Comando | Uso comprovado |
|---|---|
| `bun run daemon` | Inicia `cli/src/daemon/main.ts` em primeiro plano. |
| `bun run start:headless` | Alias de `bun run daemon`. |
| `bun run ouroboros <comando>` | CLI factual de operação/administração. |
| `bun run check` | Gate completo de integridade; não é comando de deployment. |

O processo usa `127.0.0.1` como bind fixo e `7777` como porta padrão. Os
valores operacionais lidos pelo entrypoint atual são:

| Variável | Processo | Sem valor definido |
|---|---|---|
| `OUROBOROS_DATA_DIR` | daemon e CLI de provisioning | `.ouroboros` no diretório atual |
| `OUROBOROS_PORT` | daemon | `7777` |
| `OUROBOROS_ALLOWED_ORIGINS` | daemon, acesso de browser | lista vazia; configure origins exatas separadas por vírgula quando necessárias |
| `XDG_CONFIG_HOME` | CLI, arquivo de credencial | `~/.config` |
| `OUROBOROS_CLIENT_CREDENTIAL_FILE` | CLI, arquivo de credencial | `$XDG_CONFIG_HOME/ouroboros/local-control/<client-id>.json` |

`OUROBOROS_ALLOWED_ORIGINS` restringe o Origin de browser; não autentica
clientes, não altera o bind loopback e não habilita acesso remoto. O daemon
recusa iniciar se não houver uma credencial local ativa.

## Provisionar credenciais locais

Faça o bootstrap com o daemon parado. Use o mesmo `OUROBOROS_DATA_DIR` no
provisioning e no daemon. Por exemplo, em um shell dedicado:

```bash
export OUROBOROS_DATA_DIR="$HOME/.local/share/ouroboros"
export XDG_CONFIG_HOME="$HOME/.config"
bun run ouroboros auth provision operator-cli mission.read
```

O comando gera uma credencial aleatória e grava o arquivo com permissão `0600`;
mostra caminho, scopes e validade, sem imprimir o bearer. Proteja o diretório de
configuração e seus backups. Não coloque o valor bearer em argumentos, scripts,
logs ou no repositório. Uma API key de modelo não é credencial administrativa.

Conceda somente os scopes necessários:

| Scope | Permissão |
|---|---|
| `mission.read` | Ler status e projeções autorizadas de Mission, Invocation, sessão e capabilities. |
| `mission.control` | Pausar, retomar e cancelar Missions. |
| `daemon.admin` | Operações administrativas do daemon, como modo, emergency brake e shutdown, quando invocadas por uma operação RPC autorizada. |

A CLI factual usa `mission.read` para leituras, `mission.control` para comandos
de Mission. `daemon.admin` autoriza operações RPC administrativas de daemon,
mas não há comandos CLI atuais para esses controles. Um scope não torna uma
operação indisponível em comando CLI automaticamente disponível; consulte a
interface CLI real antes de automatizar. Provisioning, rotação e revogação
são feitos por `bun run ouroboros auth provision`, `bun run ouroboros auth
rotate` e `bun run ouroboros auth revoke`, respectivamente. A referência
normativa de autenticação por operação é
[`LOCAL_CONTROL_AUTH.md`](LOCAL_CONTROL_AUTH.md).

O diretório de dados é privado (modo `0700`); o banco registra hashes,
scopes, validade e revogação, não o bearer em texto claro. As permissões de
arquivo protegem contra outros usuários locais, mas **mesmo UID não é uma
fronteira de isolamento**.

## Iniciar e consultar

Com dependências instaladas e credencial ativa:

```bash
export OUROBOROS_DATA_DIR="$HOME/.local/share/ouroboros"
export XDG_CONFIG_HOME="$HOME/.config"
bun run daemon
```

O processo fica no primeiro plano; encerre-o com `Ctrl+C`. Para uma verificação
mínima de vida do processo, sem estado administrativo:

```bash
curl --fail --silent http://127.0.0.1:7777/health
```

Para status autenticado e comandos factuais da CLI, em outro shell com as
mesmas variáveis de dados/configuração:

```bash
export OUROBOROS_DATA_DIR="$HOME/.local/share/ouroboros"
export XDG_CONFIG_HOME="$HOME/.config"
bun run ouroboros status
bun run ouroboros missions
bun run ouroboros capabilities
```

`/health` é um endpoint mínimo de saúde e não substitui a leitura autenticada.
`status`, `missions` e `capabilities` exigem credencial com `mission.read`.
Use `bun run ouroboros --help` para a CLI presente nesta revisão; não presuma
subcomandos de administração que não apareçam na ajuda.

## Superfície de rede e rotas

O bind atual é somente loopback (`127.0.0.1`; a configuração do servidor também
aceita `::1`). O entrypoint não expõe uma variável para bind público e o
servidor rejeita hosts não-loopback. Não encaminhe a porta para a rede, não a
publique por Nginx/reverse proxy e não use `DAEMON_HOST=0.0.0.0` como caminho
operacional.

| Rota atual | Acesso e finalidade |
|---|---|
| `GET /` | Metadados mínimos do serviço e da superfície. |
| `GET /health` | Health mínimo; não retorna estado de Mission. |
| `POST /rpc` | JSON-RPC autenticado; valida bearer, scope e revogação antes do dispatch. |
| `GET /ws` | Projeção autenticada, requer `mission.read`; browser usa sessão/cookie de curta duração. |
| `POST /auth/browser-session` | Troca de sessão para browser, quando configurada; exige Origin permitido e credencial válida. |

O Origin do browser precisa corresponder exatamente a um item em
`OUROBOROS_ALLOWED_ORIGINS`. Origin é uma proteção de origem de browser, não
autenticação. A autenticação continua sendo por credencial e scope em cada
operação protegida. As rotas antigas `/api/status`, `/api/rpc`, `/pty/*` e
`/api/stream/*` não fazem parte da superfície deste servidor.

## Limites operacionais conhecidos

- O RPC admite até 32 operações autenticadas simultâneas por padrão; o servidor
  permite configuração de 1 a 1024 ao ser composto diretamente. O entrypoint
  atual não expõe essa opção por variável de ambiente.
- A projeção WebSocket limita clientes simultâneos a 64 por padrão; esse limite
  também é configurado na composição do servidor, não pelo entrypoint atual.
- Esses limites são contagens de concorrência/clientes, não limites globais de
  bytes, memória ou CPU.
- A allowlist de Origin só afeta o fluxo de browser. Não amplia bind,
  autenticação ou trust boundary.
- Lifecycle supervisionado, restart automático e deployment como serviço não
  foram validados neste repositório.

## Opções sem suporte de deployment

- `daemon:enhanced`, `web:build`, `DAEMON_HOST`, `DAEMON_PORT`, `API_KEY` e
  `CORS_ORIGINS` não são comandos/variáveis do entrypoint raiz atual.
- Dockerfile, serviço systemd global, configuração Nginx pública, TLS público,
  exposição remota e serving de frontend pelo daemon não têm artefatos ou
  validação de deployment neste repositório.
- `bun run --cwd web dev` e o build do pacote `web` são ferramentas de
  desenvolvimento/validação da UI; não comprovam um deployment integrado ou
  suportado do Mission Control.
- Mission Control desktop e IPC local de produção são Direction/gated (M2/#68
  para a experiência); Unix socket e lifecycle de serviço continuam
  dependentes de avaliação. Não os trate como Current.

As rotas legadas `/api/*`, PTY e SSE citadas em guias antigos não são endpoints
operacionais do entrypoint headless atual.
