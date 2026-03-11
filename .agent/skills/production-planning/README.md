# Production Planning Skill

## O que é?

A skill `production-planning` é um protocolo rigoroso de planejamento que o agente deve seguir **antes** de escrever qualquer código. Ela foi criada para eliminar código "bagunçado" ou soluções "aleatórias", garantindo que toda nova funcionalidade seja pensada com foco em:

1. **Prontidão para Produção (Production-Readiness):** Tratamento de erros, validação de dados, e observabilidade (logs/traces).
2. **Design de Funções:** Definição clara de inputs, outputs e responsabilidades de cada função antes da implementação.

## Como usar

O agente ativará esta skill automaticamente ao iniciar novas features ou quando você pedir para "planejar" algo.

Para forçar o uso, você pode dizer:
> "Siga a skill production-planning para a próxima tarefa."

## O que o Agente fará?

1. Ele não vai escrever código imediatamente.
2. Ele vai analisar o problema e gerar um `implementation_plan.md` com o design da arquitetura e a assinatura das funções.
3. Ele mapeará todos os edge-cases de erro e validação.
4. Ele vai pedir sua **aprovação** final antes de começar a codificar.
