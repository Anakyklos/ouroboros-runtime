/**
 * 🔥 Agent Fire Test
 *
 * This script validates that the Z.AI provider can:
 * 1. Write files to the isolated workspace
 * 2. Use Python from the isolated venv (with pandas)
 * 3. Execute Python scripts
 *
 * This is the "first life" test - proving the agent has motor control.
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ZAIProvider } from "../cli/src/providers/z-ai";
import { getOuroborosConfig } from "../cli/src/utils/ouroboros";

const SEPARATOR = "═".repeat(60);

async function main() {
    console.log(SEPARATOR);
    console.log("🔥 OUROBOROS AGENT FIRE TEST");
    console.log(SEPARATOR);

    // 1. Initialize Provider
    console.log("\n📦 Step 1: Initializing Z.AI Provider...");
    const provider = new ZAIProvider({ verbose: true });
    const config = provider.getConfig();

    console.log(`   ✅ Provider initialized`);
    console.log(`   Workspace: ${config.workspace}`);

    // 2. Write Python Script
    console.log("\n📝 Step 2: Writing Python script to workspace...");

    const pythonScript = `"""
Análise de Dados - Teste de Primeira Vida
Criado pelo Ouroboros Agent
"""

import pandas as pd
from datetime import datetime

# Criar DataFrame com dados fictícios de vendas
vendas_data = {
    "produto": ["Laptop", "Mouse", "Teclado", "Monitor", "Webcam"],
    "quantidade": [15, 45, 30, 12, 25],
    "preco_unitario": [2500.00, 89.90, 199.00, 899.00, 299.00],
    "categoria": ["Computadores", "Periféricos", "Periféricos", "Computadores", "Periféricos"],
}

df = pd.DataFrame(vendas_data)

# Calcular valor total
df["valor_total"] = df["quantidade"] * df["preco_unitario"]

# Adicionar data de geração
df["data_geracao"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

# Salvar como CSV
output_path = "vendas.csv"
df.to_csv(output_path, index=False, encoding="utf-8")

# Imprimir resumo
print("=" * 50)
print("📊 RELATÓRIO DE VENDAS GERADO")
print("=" * 50)
print(f"\\nTotal de produtos: {len(df)}")
print(f"Valor total: R$ {df['valor_total'].sum():,.2f}")
print(f"\\nArquivo salvo em: {output_path}")
print("\\nPreview dos dados:")
print(df.to_string(index=False))
print("=" * 50)
`;

    // Ensure workspace exists
    if (!existsSync(config.workspace)) {
        mkdirSync(config.workspace, { recursive: true });
        console.log(`   Created workspace directory`);
    }

    const scriptPath = join(config.workspace, "analise_dados.py");
    writeFileSync(scriptPath, pythonScript, "utf-8");
    console.log(`   ✅ Script written to: ${scriptPath}`);

    // 3. Execute Python Script
    console.log("\n🚀 Step 3: Executing Python script...\n");

    const result = await provider.executePython("analise_dados.py");

    if (result.success) {
        console.log("\n   ✅ Script executed successfully!");
    } else {
        console.log("\n   ❌ Script execution failed!");
        if (result.error) {
            console.log(`   Error: ${result.error}`);
        }
    }

    // 4. Verify Output
    console.log("\n📋 Step 4: Verifying output...");

    const csvPath = join(config.workspace, "vendas.csv");
    if (existsSync(csvPath)) {
        console.log(`   ✅ CSV file created: ${csvPath}`);
        const csvContent = readFileSync(csvPath, "utf-8");
        const lineCount = csvContent.split("\n").length;
        console.log(`   Lines in CSV: ${lineCount}`);
        console.log(`\n   📄 CSV Preview (first 3 lines):`);
        csvContent.split("\n").slice(0, 3).forEach((line) => {
            console.log(`      ${line}`);
        });
    } else {
        console.log(`   ❌ CSV file NOT created`);
    }

    // Summary
    console.log(`\n${SEPARATOR}`);

    const tests = [
        { name: "Provider Initialization", passed: true },
        { name: "File Write (Python Script)", passed: existsSync(scriptPath) },
        { name: "Python Execution", passed: result.success },
        { name: "Output Generation (CSV)", passed: existsSync(csvPath) },
    ];

    const passed = tests.filter((t) => t.passed).length;
    const total = tests.length;

    console.log("\n📊 FIRE TEST RESULTS:");
    tests.forEach((t) => {
        console.log(`   ${t.passed ? "✅" : "❌"} ${t.name}`);
    });

    console.log(`\n   Score: ${passed}/${total}`);

    if (passed === total) {
        console.log("\n🎉 PRIMEIRA VIDA CONFIRMADA!");
        console.log("   O agente tem controle motor completo sobre o ambiente isolado.");
    } else {
        console.log("\n⚠️  Alguns testes falharam. Verifique a configuração.");
    }

    console.log(SEPARATOR);

    process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
});
