# Provider credentials e configuração segura

Esta documentação descreve a base de segurança da configuração e do uso de providers. O runtime persiste somente metadados de provider/modelo e referências opacas; o valor bruto de uma credencial permanece em memória e só atravessa a camada de transporte durante a chamada autorizada.

## Configuração persistível

`ProviderModelConfig` contém `providerId`, `modelId`, `endpoint`, timeout, flags de capacidade, `credentialRef` opcional e `quotaProfile` opcional. Esses campos identificam destino e capacidades, mas não carregam chave, token, senha ou header de autorização. O carregador de configuração mantém o provider Ollama local como default e preserva as variáveis de ambiente legadas.

Uma configuração pode conter uma referência como `credential://workspace/provider`, mas esse valor é apenas um identificador. A referência não deve ser interpretada como chave nem usada diretamente para montar headers.

Valores numéricos de `INFERENCE_TIMEOUT_MS`, `INFERENCE_MAX_RETRIES` e `INFERENCE_RETRY_DELAY_MS` são validados como inteiros seguros dentro de seus domínios. Valores ausentes usam os defaults existentes; `NaN`, decimais, valores negativos ou inteiros fora do limite falham no carregamento em vez de produzir comportamento implícito.

## Registry em memória e scopes duráveis

`CredentialRegistry` associa referências a segredos somente durante a vida do processo. A resolução é explícita e falha de forma genérica quando a referência não existe ou foi revogada. A representação JSON do registry contém somente as referências registradas; o campo secreto do resultado de resolução é não enumerável para evitar persistência acidental por serialização ingênua.

Por padrão, o registry lê ou cria uma identidade aleatória em `.ouroboros/credential-scope-salt`, usando o diretório de estado já adotado pelo runtime. A criação é atômica e o arquivo recebe modo restrito; reinicializações do processo no mesmo projeto derivam o mesmo `credentialScope`. `OUROBOROS_CREDENTIAL_SCOPE_SALT` pode fornecer uma identidade explícita para ambientes controlados. Testes podem injetar um salt determinístico ou um diretório temporário.

O scope é um hash opaco do salt e da referência. O mesmo par produz o mesmo scope, enquanto referências diferentes produzem scopes diferentes. Ele serve para comparar o contexto selecionado pela camada superior; não é uma credencial, não substitui autenticação e não concede autorização.

## Chamada credentialed

`CredentialedProviderInvoker` é a camada superior entre o registry e um `ModelProvider`. Antes do transporte, ele verifica que `credentialRef` e `credentialScope` do contexto coincidem com a seleção e com o scope derivado pelo registry. Depois resolve a credencial, registra-a temporariamente para redaction, executa uma chamada real através do transport boundary e, em `finally`, revoga o segredo do EventBus. Ausência, revogação ou mismatch de scope falham fechadamente e nunca fazem fallback silencioso para outra referência.

O `ModelProvider` continua sem consultar secret store, sem resolver referências e sem receber decisão de autorização. O segredo só é entregue ao callback de transporte da chamada atual; esse callback não deve persistir nem registrar o argumento. Mensagens e causas de erro são reempacotadas com redaction antes de sair da camada credentialed.

## Redaction automática no lifecycle

O `EventBus` redige uma cópia dos eventos antes de entregá-los aos listeners. Além disso, ele publica o ciclo de vida dos segredos ativos. O `DatasetPipeline` assina esse ciclo automaticamente, portanto recebe a credencial somente enquanto a chamada está ativa e deixa de redigi-la quando o invoker executa o `finally`. Não é necessário registrar manualmente a chave no dataset para cada chamada.

O mesmo módulo cobre mensagens de erro, causas aninhadas, headers `Authorization`, tokens Bearer/Basic/Token, parâmetros sensíveis de URL, atribuições de chave/segredo e padrões comuns de chaves de providers. `DatasetPipeline` redige inputs, outputs, decisões, consultas, instruções e patches antes de manter as entradas e exportá-las em JSONL. Logs, eventos, erros, traces, datasets e métricas não devem conter chaves brutas.

## BYOK opcional

O suporte BYOK é opt-in. `loadInferenceConfig({ credentialRegistry, env })` reconhece `NVIDIA_API_KEY` somente para registrá-la no registry fornecido em memória e retorna apenas a metadata `credential://env/nvidia-api-key`; o objeto de configuração nunca contém o valor bruto. Sem um registry explícito, a configuração pode descrever a fonte sem habilitar uma chamada credentialed. Isso não implementa o provider NVIDIA nem transforma uma variável de ambiente em autorização automática.

## Compatibilidade e limites

O provider Ollama local, suas APIs legadas (`chat`, `embed`, `complete`), a factory existente, retries legados e métricas continuam compatíveis. A configuração nova não substitui a superfície antiga imediatamente; ela fornece contratos seguros para migração gradual de adapters. O invoker e o registry são opt-in para consumidores que precisam de credenciais.

Esta camada não implementa NVIDIA NIM, quota global, retry novo, circuit breaker, scheduler, fila durável ou secret manager externo. Uma integração futura deve resolver a referência imediatamente antes do transporte, comparar o scope autorizado, manter a chave apenas no frame da chamada e passar mensagens/corpos de erro pelas mesmas fronteiras de redaction.

## Regras de uso

Não coloque chaves brutas em arquivos de configuração, SQLite, traces, datasets, eventos, logs, métricas ou payloads de frontend. Não use `credentialRef` como header. Não faça fallback silencioso para outra credencial quando a resolução falhar ou o scope não corresponder. Em testes, use somente valores sintéticos e asserte explicitamente que logs, eventos, erros, estado serializado e exportações não contêm o valor original.

---
> **Nota de realinhamento (#60)**: esta documentação permanece válida para a
> base de segurança de credenciais, mas provider não é a identidade do produto.
> Providers servem o planning advisory; code/policy autoriza effects.
> Ver [docs/ARCHITECTURE.md](ARCHITECTURE.md).
