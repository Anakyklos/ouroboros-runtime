# Workflow "Anti-Vibe Coding" (Spec Driven Development - SDD)

Este documento descreve o fluxo de trabalho "Spec Driven Development" (SDD) para desenvolvimento de software com LLMs (especificamente Claude/Gemini), focado em evitar problemas comuns como **Over-engineering**, **Reinventar a roda**, **Alucinações** e **Context Window overload**.

## 🛑 O Problema: "Vibe Coding"
"Vibe Coding" é jogar prompts aleatórios e torcer para funcionar. Isso leva a:
1.  **Over-engineering:** A IA complica o que poderia ser simples.
2.  **Reinventar a roda:** Cria soluções do zero quando existem bibliotecas prontas.
3.  **Conhecimento desatualizado:** Não sabe usar features novas se não ler a doc.
4.  **Duplicação de código:** Cria componentes (ex: botões) novos ao invés de reutilizar.
5.  **Arquivos Monolíticos:** Mistura responsabilidades no mesmo arquivo.
6.  **Context Window Overflow:** Excesso de informação irrelevante degrada a qualidade.

---

## 🚀 O Solução: Spec Driven Development (SDD)

O método consiste em **3 Etapas Estritas** com limpeza de contexto entre elas.

### Passo 1: Pesquisa & PRD (`prd.md`)
**Objetivo:** Coletar todo contexto necessário e filtrar o ruído.

1.  **Prompt de Pesquisa:**
    *   "Quero implementar X."
    *   "Pesquise na base de código arquivos afetados e padrões existentes."
    *   "Pesquise na internet documentações (ex: NextAuth, Resend) e padrões externos."
2.  **Output Esperado:** `prd.md`
    *   Lista de arquivos da base de código relevantes.
    *   Trechos de documentação externa essenciais.
    *   Code snippets/padrões de implementação (StackOverflow, GitHub).
3.  **Ação Final:** `/clear` (Limpar contexto).

### Passo 2: Especificação Técnica (`spec.md`)
**Objetivo:** Definir *taticamente* o que será feito antes de codar.

1.  **Input:** `prd.md` (gerado no passo anterior) + Descrição do objetivo.
2.  **Prompt:**
    *   "Leia este PRD."
    *   "Gere uma SPEC dizendo exatamente quais arquivos criar e quais modificar."
    *   "Detalhe o que mudar em cada arquivo."
3.  **Output Esperado:** `spec.md`
    *   Lista tática de arquivos.
    *   Instruções de modificação per-file.
    *   Pseudocódigo ou snippets específicos.
4.  **Ação Final:** `/clear` (Limpar contexto).

### Passo 3: Implementação
**Objetivo:** Escrever o código com contexto limpo e diretrizes claras.

1.  **Input:** `spec.md`.
2.  **Prompt:** "Implemente o plano descrito na spec."
3.  **Resultado:**
    *   Código mais simples e assertivo.
    *   Menor uso de tokens (janela de contexto focada).
    *   Modularização correta (seguindo a spec).
    *   Reuso de código existente (identificado na pesquisa).

---

## 💡 Princípios Chave
*   **Qualidade do Input = Qualidade do Output:** Informação incorreta, incompleta ou excessiva (ruído) destrói o resultado.
*   **Context Management:** Manter a janela de contexto limpa (40-50% de uso ideal). O `prd.md` e `spec.md` funcionam como compressão de contexto.
*   **Copiar Padrões:** Se você não é especialista, busque padrões consolidados (GitHub, Docs) para a IA replicar, evitando over-engineering.
