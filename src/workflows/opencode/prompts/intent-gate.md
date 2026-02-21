# Intent Gate Pattern

> Extraído de `oh-my-opencode` (Sisyphus & Hephaestus)

O "Intent Gate" é um padrão de engenharia de prompt projetado para combater a tendência dos LLMs de interpretarem instruções de forma excessivamente literal ou passiva. Ele força o modelo a verbalizar e classificar a "verdadeira intenção" do usuário antes de agir.

## O Problema

Muitas vezes, usuários fazem perguntas que implicam ação ("Como isso funciona?" muitas vezes significa "Entenda isso para que possamos consertar/alterar"), ou fazem perguntas retóricas ("Você viu o erro X?"). Agentes ingênuos respondem apenas à pergunta ("Sim, eu vi") e param.

## A Solução

O Intent Gate obriga o agente a passar por 3 etapas antes de qualquer execução:

### Passo 0: Extração da Verdadeira Intenção (Verbalizada)

O agente deve mapear a forma superficial da mensagem para a intenção real e anunciar sua decisão de roteamento.

| Forma Superficial | Intenção Real | Roteamento |
|---|---|---|
| "Explique X" | Pesquisa/Entendimento | Explorar → Sintetizar → Responder |
| "Implemente X" | Implementação Explícita | Planejar → Delegar/Executar |
| "Dê uma olhada em Y" | Investigação + Resolução | Investigar → Resolver |
| "O que você acha de Z?" | Avaliação | Avaliar → Propor → Aguardar |
| "Estou vendo erro X" | Correção Necessária | Diagnosticar → Corrigir |

**Template de Verbalização:**
> "Detecto intenção de [pesquisa / implementação / investigação] — [motivo]. Minha abordagem: [explorar → responder / planejar → delegar]."

### Passo 1: Classificação do Tipo de Tarefa

- **Trivial:** Arquivo único, local conhecido → Ferramentas diretas.
- **Explícito:** Arquivo/linha específicos → Executar diretamente.
- **Exploratório:** "Como X funciona?" → Disparar agentes de exploração em paralelo.
- **Open-ended:** "Melhore isso" → Avaliar codebase primeiro.
- **Ambíguo:** Escopo incerto → Perguntar (apenas 1 pergunta clarificadora).

### Passo 2: Protocolo de Ambiguidade

- Se houver informação faltando que PODE existir → **EXPLORAR PRIMEIRO** (não perguntar).
- Se houver múltiplas interpretações plausíveis → Cobrir todas ou escolher a mais provável e avisar.
- Perguntar ao usuário é o **ÚLTIMO RECURSO**.

## Aplicação no Ouroboros

Este padrão deve ser injetado no System Prompt de todos os Agentes do Council (especialmente o Concierge e os Workers de Coding) para garantir proatividade e evitar loops de perguntas desnecessárias.
