/**
 * 📝 Spec Template Generator
 *
 * Gera templates de especificação baseados no Anti-Vibe Protocol e
 * no Architect Specification Workflow.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkflowPhase, SPEC_FILE, DIAG_FILE, DEFAULT_CONTEXT_DIR } from './anti-vibe.js';

export interface SpecTemplateOptions {
    taskDescription: string;
    filesToModify?: string[];
    filesToCreate?: string[];
    patternFiles?: string[];
    verificationCommand?: string;
    contextDir?: string;
    author?: string;
}

export interface SpecSection {
    title: string;
    required: boolean;
    placeholder: string;
}

// Required sections based on Architect Specification Workflow
const REQUIRED_SPEC_SECTIONS: SpecSection[] = [
    { title: '🎯 Objetivo', required: true, placeholder: '[Descreva o objetivo principal desta especificação]' },
    { title: '💡 Contexto e Justificativa', required: true, placeholder: '[Descreva o problema que esta especificação resolve]' },
    { title: '🚀 Plano de Implementação', required: true, placeholder: '[Descreva a abordagem de alto nível]' },
    { title: '✅ Critérios de Aceitação / Verificação', required: true, placeholder: '[Liste os critérios de sucesso]' },
    { title: '🚧 Possíveis Riscos e Desafios', required: false, placeholder: '[Identifique obstáculos potenciais]' },
];

/**
 * Generates a comprehensive spec template based on the Anti-Vibe Protocol.
 */
function buildSpecTemplateContent(options: SpecTemplateOptions): string {
    const {
        taskDescription,
        filesToModify = [],
        filesToCreate = [],
        patternFiles = [],
        verificationCommand = 'bun run test',
        author = 'System Architect',
    } = options;

    const timestamp = new Date().toISOString().split('T')[0];
    const filesSection = buildFilesSection(filesToModify, filesToCreate, patternFiles);

    return `---
description: ${taskDescription}
author: ${author}
date: ${timestamp}
phase: SPECIFICATION
---

# Especificação Técnica: ${taskDescription}

> Gerado pelo Anti-Vibe Protocol - ${timestamp}
> Status: **DRAFT** - Aguardando revisão e aprovação

---

## 🎯 Objetivo

Implementar a seguinte funcionalidade: **${taskDescription}**

## 💡 Contexto e Justificativa

[Descreva aqui o problema que esta especificação resolve, por que ela é importante e o valor que agrega.]

**Perguntas a responder:**
- Qual problema estamos resolvendo?
- Por que esta solução é necessária agora?
- Qual o impacto esperado?

---

## 🚀 Plano de Implementação

### 1. Visão Geral

[Descreva a abordagem de alto nível. Quais componentes serão afetados? Qual a estratégia geral?]

### 2. Detalhes da Implementação

${filesSection}

[Detalhe os passos de implementação. Use subtítulos para seções lógicas.]

**Estrutura sugerida:**
1. Preparação do ambiente/dependências
2. Implementação dos componentes principais
3. Integração com sistemas existentes
4. Configuração e setup

### 3. Decisões Arquiteturais (se houver)

[Justifique quaisquer decisões arquiteturais importantes tomadas durante o planejamento.]

**Exemplo:**
> Decidimos usar X em vez de Y porque:
> - Razão 1: ...
> - Razão 2: ...

---

## ✅ Critérios de Aceitação / Verificação

A implementação será considerada concluída e correta quando:

1. **Funcionalidade Principal**: A funcionalidade **"${taskDescription}"** estiver implementada e funcionando conforme o esperado.
2. **Testes**: Todos os testes existentes (e novos, se aplicável) passarem sem erros.
3. **Validação Técnica**: O comando de verificação for executado com sucesso:
   \`\`\`bash
   ${verificationCommand}
   \`\`\`
4. **Qualidade de Código**: O código estiver limpo, legível e seguir os padrões de codificação do projeto.
5. **Sem Regressões**: Nenhuma regressão for introduzida em funcionalidades existentes.

### Checklist de Spec Review (antes de aprovar):

- [ ] Cobre todos os requisitos?
- [ ] Interfaces estão claras?
- [ ] Plano de verificação existe?
- [ ] Não há over-engineering?
- [ ] Riscos foram identificados?

---

## 🚧 Possíveis Riscos e Desafios

[Identifique quaisquer obstáculos potenciais ou áreas de incerteza.]

**Exemplos:**
- Dependências externas que podem mudar
- Limitações de performance
- Complexidade de migração
- Riscos de segurança

---

## 📦 Artefatos Gerados

Após a implementação, os seguintes artefatos serão produzidos:

- [ ] Código fonte nos arquivos especificados
- [ ] Testes unitários/de integração (se aplicável)
- [ ] \`${DIAG_FILE}\` (documento de diagnóstico prévio)
- [ ] \`${SPEC_FILE}\` (este documento, aprovado)
- [ ] Validação de qualidade gates aprovada

---

## 🔄 Anti-Vibe Protocol Checklist

### Fase 1: RESEARCH ✅
- [x] Exploração do código fonte concluída
- [x] Dependências identificadas
- [x] Riscos documentados

### Fase 2: SPECIFICATION (em progresso)
- [ ] Especificação completa
- [ ] Revisão e aprovação
- [ ] Criteria de aceitação definidos

### Fase 3: EXECUTION (bloqueado até aprovação)
- [ ] Implementação estrita seguindo a spec
- [ ] Testes implementados
- [ ] Validação quality gates

### Fase 4: VERIFICATION (bloqueado)
- [ ] Testes passando
- [ ] Code review
- [ ] Aprovação humana

---

> [!IMPORTANT]
> **Regra de Ouro:** Esta especificação deve ser aprovada antes de qualquer código ser escrito.
> A fase EXECUTION só pode iniciar após a aprovação explícita desta spec.
`;
}

/**
 * Build the files section of the spec template.
 */
function buildFilesSection(
    filesToModify: string[],
    filesToCreate: string[],
    patternFiles: string[]
): string {
    const sections: string[] = [];

    if (filesToModify.length > 0) {
        sections.push(`#### Arquivos a Modificar:
${filesToModify.map(file => `- \`${file}\``).join('\n')}
`);
    }

    if (filesToCreate.length > 0) {
        sections.push(`#### Arquivos a Criar:
${filesToCreate.map(file => `- \`${file}\``).join('\n')}
`);
    }

    if (patternFiles.length > 0) {
        sections.push(`#### Arquivos de Referência (Padrões a Seguir):
${patternFiles.map(file => `- \`${file}\``).join('\n')}

**Estude estes arquivos primeiro para entender:**
- Convenções de código
- Padrões de arquitetura
- Estilo de nomenclatura
`);
    }

    return sections.join('\n') || '[Nenhum arquivo especificado ainda]';
}

/**
 * Generate a spec template with the given options.
 */
export function generateSpecTemplate(options: SpecTemplateOptions): string {
    return buildSpecTemplateContent(options);
}

/**
 * Validate that a spec content has all required sections.
 */
export function validateSpecContent(content: string): { valid: boolean; missing: string[] } {
    const missing: string[] = [];

    for (const section of REQUIRED_SPEC_SECTIONS) {
        if (section.required) {
            const sectionPattern = new RegExp(`##\\s+${section.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
            if (!sectionPattern.test(content)) {
                missing.push(section.title);
            }
        }
    }

    return {
        valid: missing.length === 0,
        missing,
    };
}

/**
 * Ensure a spec file exists in the context directory.
 * Creates it with a basic template if it doesn't exist.
 */
export async function ensureSpecFile(
    contextDir: string = DEFAULT_CONTEXT_DIR,
    specFile: string = SPEC_FILE
): Promise<void> {
    const filePath = path.join(contextDir, specFile);

    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
        // File exists, validate it
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const validation = validateSpecContent(content);

        if (!validation.valid) {
            console.warn(`[Anti-Vibe] ⚠️ Spec file exists but is missing sections: ${validation.missing.join(', ')}`);
        }
    } catch {
        // File does not exist, create it with a basic template
        await fs.promises.mkdir(contextDir, { recursive: true });

        const initialContent = generateSpecTemplate({
            taskDescription: 'Descreva a tarefa aqui.',
            author: 'System Architect',
        });

        await fs.promises.writeFile(filePath, initialContent, 'utf-8');
        console.log(`[Anti-Vibe] 📝 Created initial spec file: ${specFile}`);
    }
}

/**
 * Create a spec file with specific options, enforcing anti-vibe phase requirements.
 *
 * @throws Error if called during EXECUTION phase without proper validation
 */
export async function createSpecFile(
    options: SpecTemplateOptions,
    contextDir: string = DEFAULT_CONTEXT_DIR,
    specFile: string = SPEC_FILE
): Promise<void> {
    const currentPhase = process.env.ANTI_VIBE_PHASE?.toUpperCase();

    // Allow spec creation during SPECIFICATION phase or if no phase is set
    if (currentPhase === 'EXECUTION') {
        throw new Error(
            '⛔ [ANTI-VIBE BLOCK] Cannot create new spec during EXECUTION phase. ' +
            'Spec creation is only allowed during RESEARCH or SPECIFICATION phases.'
        );
    }

    // Ensure context directory exists
    await fs.promises.mkdir(contextDir, { recursive: true });

    // Generate content
    const content = generateSpecTemplate(options);

    // Write spec file
    const filePath = path.join(contextDir, specFile);
    await fs.promises.writeFile(filePath, content, 'utf-8');

    console.log(`[Anti-Vibe] 📝 Spec template created: ${filePath}`);
    console.log(`[Anti-Vibe] 💡 Next: Review and fill in the spec, then approve to proceed to EXECUTION phase.`);
}

/**
 * Load and parse the spec file for validation before phase transition.
 */
export async function loadSpecForValidation(
    contextDir: string = DEFAULT_CONTEXT_DIR,
    specFile: string = SPEC_FILE
): Promise<{ content: string; validation: { valid: boolean; missing: string[] } } | null> {
    const filePath = path.join(contextDir, specFile);

    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const validation = validateSpecContent(content);

        return { content, validation };
    } catch {
        return null;
    }
}

/**
 * Check if the spec is ready for EXECUTION phase.
 */
export async function canTransitionToExecution(
    contextDir: string = DEFAULT_CONTEXT_DIR,
    specFile: string = SPEC_FILE
): Promise<{ canProceed: boolean; reason: string }> {
    const specData = await loadSpecForValidation(contextDir, specFile);

    if (!specData) {
        return {
            canProceed: false,
            reason: `Spec file '${specFile}' not found. Create and complete the specification first.`,
        };
    }

    if (!specData.validation.valid) {
        return {
            canProceed: false,
            reason: `Spec is incomplete. Missing required sections: ${specData.validation.missing.join(', ')}`,
        };
    }

    // Check if spec is marked as approved (simple heuristic: contains "✅" or "APPROVED")
    const isApproved = /✅|APPROVED|APROVADO/i.test(specData.content);

    if (!isApproved) {
        return {
            canProceed: false,
            reason: 'Spec has not been approved yet. Complete the checklist and mark as approved.',
        };
    }

    return { canProceed: true, reason: 'Spec is complete and approved. Ready for EXECUTION phase.' };
}
