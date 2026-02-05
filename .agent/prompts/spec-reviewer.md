# Spec Reviewer Prompt - Ouroboros

Template para review de compliance com especificação.

---

```markdown
# Spec Review: [Nome da Task]

## O Que Foi Especificado

[COLAR SPEC/TASK ORIGINAL AQUI]

## O Que Foi Reportado

[COLAR REPORT DO IMPLEMENTER]

## ⚠️ CRÍTICO: Não Confie no Report

O implementer pode ter:
- Interpretado requisitos diferente
- Esquecido de implementar algo
- Adicionado coisas que não foram pedidas
- Sido otimista sobre completude

**VOCÊ DEVE VERIFICAR INDEPENDENTEMENTE.**

## Seu Trabalho

Ler o código implementado e verificar:

### 1. Missing Requirements
- [ ] Implementou TUDO que foi especificado?
- [ ] Há requisitos pulados ou esquecidos?
- [ ] Algo foi alegado mas não implementado?

**Para verificar:** Ler spec linha por linha, verificar cada item no código

### 2. Extra/Unneeded Work
- [ ] Construiu coisas que NÃO foram pedidas?
- [ ] Over-engineered? Features desnecessárias?
- [ ] Adicionou "nice to haves" não especificados?

**Para verificar:** Comparar código com spec, identificar adições

### 3. Misunderstandings
- [ ] Interpretou requisitos diferente do esperado?
- [ ] Resolveu o problema errado?
- [ ] Implementou feature certa de jeito errado?

**Para verificar:** Entender Intent da spec vs implementação real

## Como Verificar

1. Abrir cada arquivo modificado
2. Ler código real (não confiar em reports)
3. Comparar com spec item por item
4. Anotar discrepâncias com file:line

## Formato do Report

```
# Spec Review Result

## Verdict: ✅ COMPLIANT / ❌ NON-COMPLIANT

### Missing (não implementado)
- [Requisito X] - não encontrado em [arquivo:linha esperada]
- [Requisito Y] - parcialmente implementado, falta [detalhe]

### Extra (não especificado)  
- [Feature Z] em [arquivo:linha] - não estava na spec
- [Abstração W] - over-engineering não pedido

### Misunderstanding
- [Requisito A] foi interpretado como [X] mas deveria ser [Y]

### Implementation Notes (se compliant)
- Implementação correta em [arquivos]
- Testes cobrem requisitos
```
```

---

## Critérios de Aprovação

**✅ COMPLIANT quando:**
- Todos os requisitos da spec estão implementados
- Nenhuma adição não especificada
- Interpretação correta dos requisitos

**❌ NON-COMPLIANT quando:**
- Qualquer requisito faltando
- Adições não autorizadas
- Interpretação incorreta de requisitos
