# 🤖 Jules Handoff: Ouroboros Environment Setup

> **Status:** Ready for Jules  
> **Priority:** High  
> **Type:** Autonomous Implementation  
> **Date:** 2026-02-06

---

## 📋 Contexto

O Ouroboros é um runtime de agente autônomo em TypeScript/Bun que usa:
- **Groq API** para classificação de intents (Concierge)
- **Gemini CLI** para execução de tasks
- **Python venv isolado** em `.ouroboros/venv/`

**Problema atual:** O sistema depende de um wizard interativo (`BootWizard`) que coleta API keys em runtime. Isso impede execução headless/CI.

---

## 🎯 Objetivo

Tornar o Ouroboros executável de forma **headless** (sem interação humana), permitindo:
1. Configuração via variáveis de ambiente
2. Execução em CI/CD
3. Testes automatizados

---

## ✅ Tasks para Jules

### Task 1: Criar `.env.example`

**Arquivo:** `/.env.example`

**Conteúdo:**
```env
# Ouroboros Environment Configuration
# Copy this file to .env and fill in your API keys

# Required: Groq API Key (for Concierge intent classification)
GROQ_API_KEY=gsk_your_key_here

# Required: Google API Key (for Gemini CLI)
GOOGLE_API_KEY=your_google_api_key_here

# Optional: Override default paths
# OUROBOROS_ROOT=.ouroboros
# OUROBOROS_WORKSPACE=.ouroboros/workspace
```

**Como testar:**
```bash
cp .env.example .env
# Editar .env com keys reais
cat .env  # Verificar formato
```

---

### Task 2: Instalar `dotenv` e Criar Loader

**Passo 1:** Adicionar dependência
```bash
cd /workspace/ouroboros  # ou o diretório do projeto
bun add dotenv
```

**Passo 2:** Criar arquivo `cli/src/utils/env-loader.ts`

```typescript
/**
 * 🐍 Ouroboros Environment Loader
 * 
 * Loads environment variables from .env file.
 * Must be imported FIRST in main.ts before any other imports.
 */

import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface EnvConfig {
    groqApiKey: string;
    googleApiKey: string;
    ouroborosRoot?: string;
}

/**
 * Load .env file if it exists
 */
export function loadEnv(projectRoot?: string): void {
    const root = projectRoot ?? process.cwd();
    const envPath = resolve(root, '.env');
    
    if (existsSync(envPath)) {
        config({ path: envPath });
        console.log('📦 Loaded environment from .env');
    }
}

/**
 * Get required environment variables
 * @throws Error if required variables are missing
 */
export function getEnvConfig(): EnvConfig {
    const groqApiKey = process.env.GROQ_API_KEY;
    const googleApiKey = process.env.GOOGLE_API_KEY;
    
    const missing: string[] = [];
    if (!groqApiKey) missing.push('GROQ_API_KEY');
    if (!googleApiKey) missing.push('GOOGLE_API_KEY');
    
    if (missing.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}\n` +
            `Please create a .env file or set these variables.`
        );
    }
    
    return {
        groqApiKey: groqApiKey!,
        googleApiKey: googleApiKey!,
        ouroborosRoot: process.env.OUROBOROS_ROOT,
    };
}

/**
 * Check if running in headless mode (env vars present, no TTY)
 */
export function isHeadlessMode(): boolean {
    return !!(process.env.GROQ_API_KEY && process.env.GOOGLE_API_KEY);
}
```

**Como testar:**
```bash
# Criar arquivo de teste
cat > test-env-loader.ts << 'EOF'
import { loadEnv, getEnvConfig, isHeadlessMode } from './cli/src/utils/env-loader.js';

loadEnv();

console.log('Headless mode:', isHeadlessMode());

try {
    const config = getEnvConfig();
    console.log('✅ Config loaded successfully');
    console.log('GROQ_API_KEY:', config.groqApiKey.slice(0, 10) + '...');
    console.log('GOOGLE_API_KEY:', config.googleApiKey.slice(0, 10) + '...');
} catch (e) {
    console.error('❌ Error:', e.message);
}
EOF

bun run test-env-loader.ts
```

---

### Task 3: Refatorar `BootWizard` para Modo Headless

**Arquivo:** `cli/src/boot/BootWizard.ts`

**Modificações necessárias:**

1. Importar o env-loader no topo do arquivo:
```typescript
import { loadEnv, getEnvConfig, isHeadlessMode } from '../utils/env-loader.js';
```

2. Modificar a função `runBootWizard()` para detectar modo headless:
```typescript
export async function runBootWizard(): Promise<BootConfig> {
    // Carregar .env primeiro
    loadEnv();
    
    // Se estiver em modo headless, pular wizard
    if (isHeadlessMode()) {
        const envConfig = getEnvConfig();
        console.log('🤖 Running in headless mode');
        return {
            groqApiKey: envConfig.groqApiKey,
            googleApiKey: envConfig.googleApiKey,
            // ... outros campos com defaults
        };
    }
    
    // Código existente do wizard interativo...
}
```

**Como testar:**
```bash
# Teste 1: Com .env (headless)
echo "GROQ_API_KEY=gsk_test123" >> .env
echo "GOOGLE_API_KEY=google_test456" >> .env
bun run cli/src/main.ts
# Deve mostrar "Running in headless mode"

# Teste 2: Sem .env (interativo)
mv .env .env.backup
bun run cli/src/main.ts
# Deve mostrar o wizard interativo
mv .env.backup .env
```

---

### Task 4: Criar Script de Health Check

**Arquivo:** `scripts/health-check.ts`

```typescript
#!/usr/bin/env bun
/**
 * 🐍 Ouroboros Health Check
 * 
 * Verifies all dependencies and configurations are ready.
 * Exit code 0 = ready, 1 = problems found
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadEnv, isHeadlessMode } from '../cli/src/utils/env-loader.js';
import { getOuroborosConfig } from '../cli/src/utils/ouroboros.js';

interface CheckResult {
    name: string;
    status: 'ok' | 'warn' | 'error';
    message: string;
}

const results: CheckResult[] = [];

function check(name: string, condition: boolean, okMsg: string, errorMsg: string): void {
    results.push({
        name,
        status: condition ? 'ok' : 'error',
        message: condition ? okMsg : errorMsg,
    });
}

async function checkCommand(command: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        const proc = spawn(command, args, { shell: true, timeout: 5000 });
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
}

async function main() {
    console.log('🐍 Ouroboros Health Check\n');
    console.log('='.repeat(50));
    
    // 1. Check .env
    loadEnv();
    check(
        '.env file',
        existsSync('.env'),
        'Found .env file',
        'Missing .env file (create from .env.example)'
    );
    
    // 2. Check environment variables
    check(
        'GROQ_API_KEY',
        !!process.env.GROQ_API_KEY,
        'GROQ_API_KEY is set',
        'GROQ_API_KEY is missing'
    );
    
    check(
        'GOOGLE_API_KEY',
        !!process.env.GOOGLE_API_KEY,
        'GOOGLE_API_KEY is set',
        'GOOGLE_API_KEY is missing'
    );
    
    // 3. Check Ouroboros environment
    const config = getOuroborosConfig();
    check(
        'Ouroboros workspace',
        config.isReady,
        `Workspace ready at ${config.workspace}`,
        'Workspace not found. Run: bun run setup'
    );
    
    check(
        'Python venv',
        existsSync(config.python),
        `Python found at ${config.python}`,
        'Python venv not found. Run: bun run setup'
    );
    
    // 4. Check Gemini CLI
    const geminiAvailable = await checkCommand('gemini', ['--version']);
    check(
        'Gemini CLI',
        geminiAvailable,
        'Gemini CLI is available',
        'Gemini CLI not found. Install: npm install -g @anthropic-ai/gemini-cli'
    );
    
    // 5. Check Bun
    const bunAvailable = await checkCommand('bun', ['--version']);
    check(
        'Bun runtime',
        bunAvailable,
        'Bun is available',
        'Bun not found'
    );
    
    // Print results
    console.log('\n📊 Results:\n');
    
    let hasErrors = false;
    for (const r of results) {
        const icon = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '❌';
        console.log(`${icon} ${r.name}: ${r.message}`);
        if (r.status === 'error') hasErrors = true;
    }
    
    console.log('\n' + '='.repeat(50));
    
    if (hasErrors) {
        console.log('❌ Some checks failed. Please fix the issues above.');
        process.exit(1);
    } else {
        console.log('✅ All checks passed! Ouroboros is ready.');
        process.exit(0);
    }
}

main().catch(console.error);
```

**Como testar:**
```bash
bun run scripts/health-check.ts
```

---

### Task 5: Atualizar `package.json`

Adicionar novos scripts:

```json
{
  "scripts": {
    "health": "bun run scripts/health-check.ts",
    "start:headless": "bun run cli/src/main.ts"
  }
}
```

**Como testar:**
```bash
bun run health
```

---

## 🧪 Checklist de Validação Final

Após completar todas as tasks, rodar:

```bash
# 1. Verificar que .env.example existe
ls -la .env.example

# 2. Verificar que env-loader compila
bun build cli/src/utils/env-loader.ts --outdir=dist/test

# 3. Rodar health check
bun run health

# 4. Testar modo headless (com .env)
GROQ_API_KEY=test GOOGLE_API_KEY=test bun run cli/src/main.ts --help

# 5. Build completo
bun run build
```

---

## 📁 Estrutura de Arquivos Esperada

```
Ouroboros/
├── .env.example                    # [NEW] Template de configuração
├── .env                            # [GITIGNORED] Config real
├── cli/src/
│   ├── boot/
│   │   └── BootWizard.ts          # [MODIFIED] Suporta headless
│   └── utils/
│       ├── env-loader.ts          # [NEW] Carrega .env
│       └── ouroboros.ts           # [EXISTING] Paths
├── scripts/
│   └── health-check.ts            # [NEW] Validação
└── package.json                   # [MODIFIED] Novos scripts
```

---

## ⚠️ Notas Importantes para Jules

1. **Não modificar** arquivos em `node_modules/`
2. **Sempre rodar** `bun install` após modificar `package.json`
3. **Testar cada task** antes de passar para a próxima
4. **Commitar** após cada task com mensagem descritiva

---

## 🔗 Referências

- [cli/src/main.ts](file:///c:/Users/pedro/Documents/Ouroboros/cli/src/main.ts) - Entry point
- [cli/src/boot/BootWizard.ts](file:///c:/Users/pedro/Documents/Ouroboros/cli/src/boot) - Wizard atual
- [cli/src/utils/ouroboros.ts](file:///c:/Users/pedro/Documents/Ouroboros/cli/src/utils/ouroboros.ts) - Path utils
- [SPEC_OUROBOROS_ENV.md](file:///c:/Users/pedro/Documents/Ouroboros/SPEC_OUROBOROS_ENV.md) - Spec do ambiente

---

> **Jules:** Ao completar, crie um commit com a mensagem:
> `feat: add headless mode support for CI/cloud execution`
