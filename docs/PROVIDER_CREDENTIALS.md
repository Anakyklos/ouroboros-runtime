# Provider credentials e configuração segura

Esta documentação descreve a base de segurança introduzida para a configuração de providers. O runtime persiste apenas metadados de provider/modelo e referências opacas; o valor bruto de uma credencial deve permanecer em memória no processo que executa a chamada.

## Configuração persistível

`ProviderModelConfig` contém `providerId`, `modelId`, `endpoint`, timeout, flags de capacidade, `credentialRef` opcional e `quotaProfile` opcional. Esses campos identificam o destino e suas capacidades, mas não carregam uma chave, token, senha ou header de autorização. O carregador de configuração continua fornecendo o provider Ollama local como default e preserva as variáveis de ambiente legadas.

Uma configuração pode conter uma referência semelhante a `credential://workspace/provider`, mas esse valor é apenas um identificador. A referência não deve ser interpretada como uma chave e não deve ser usada para montar headers diretamente.

## Registry em memória

`CredentialRegistry` associa referências a segredos somente durante a vida do processo. A resolução é explícita e falha de forma genérica quando a referência não existe ou foi revogada. A representação JSON do registry contém somente as referências registradas; o campo secreto do resultado de resolução é não enumerável para evitar persistência acidental por serialização ingênua.

O registry também deriva um `credentialScope` opaco a partir da referência e de um salt privado. O mesmo par produz o mesmo scope, enquanto referências diferentes produzem scopes diferentes. O scope serve para comparar autorização de contexto; ele não é uma credencial, não substitui autenticação e não deve ser tratado como material secreto reversível.

## Redaction

A redaction é aplicada no limite do `EventBus`, portanto logs e eventos estruturados recebem uma cópia sanitizada antes de chegar aos listeners. O mesmo módulo cobre mensagens de erro, causas aninhadas, headers `Authorization`, tokens Bearer/Basic/Token, parâmetros sensíveis de URL, atribuições de chave/segredo e padrões comuns de chaves de providers. Chamadores que conhecem um segredo sintético ou obtido em memória podem fornecer a lista de segredos exatos ao redactor sem armazená-la em configuração persistível.

`DatasetPipeline` redige inputs, outputs, decisões, consultas, instruções e patches antes de manter as entradas e exportá-las em JSONL. Isso impede que uma credencial conhecida ou um token reconhecível reapareça no estado exportado. O runtime não deve registrar prompts ou respostas integrais em logs de produção; diagnósticos devem preferir IDs, tipos de erro, duração, contagens e referências opacas.

## Compatibilidade e limites

O provider Ollama local, suas APIs legadas (`chat`, `embed`, `complete`), a factory existente, retries legados e métricas continuam compatíveis. A configuração nova não substitui a superfície antiga imediatamente; ela fornece o contrato seguro para a migração gradual de adapters.

Esta camada não implementa NVIDIA NIM, quota global, retry novo, circuit breaker, scheduler, fila durável ou secret manager externo. Uma integração futura deve resolver a referência imediatamente antes do transporte, comparar o scope autorizado, manter a chave apenas no frame da chamada e passar mensagens/corpos de erro pelas mesmas fronteiras de redaction.

## Regras de uso

Não coloque chaves brutas em arquivos de configuração, SQLite, traces, datasets, eventos, logs, métricas ou payloads de frontend. Não use `credentialRef` como header. Não faça fallback silencioso para outra credencial quando a resolução falhar ou o scope não corresponder. Em testes, use apenas valores sintéticos e asserte explicitamente que logs, eventos, erros, estado serializado e exportações não contêm o valor original.
