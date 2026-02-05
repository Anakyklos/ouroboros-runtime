import os
import json

# Arquivos críticos que precisamos ler para entender o contexto
TARGET_FILES = [
    "SPEC_OUROBOROS_ENV.md",
    "humanlayer.json",
    "cli/package.json",
    "cli/tsconfig.json",
    "cli/src/providers/z-ai.ts",  # Provider atual
    "setup_ouroboros.ts",
    ".agent/rules.md",            # Se existir
]

# Pastas para listar estrutura (sem ler conteudo)
TARGET_DIRS = ["cli", "integrations", ".agent", "scripts"]

def read_file_safe(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        return "[NOT FOUND]"
    except Exception as e:
        return f"[ERROR: {str(e)}]"

report = {
    "structure": {},
    "file_contents": {}
}

# 1. Mapear estrutura de diretorios
print("--- SCANNED STRUCTURE ---")
for target_dir in TARGET_DIRS:
    tree = []
    for root, dirs, files in os.walk(target_dir):
        if "node_modules" in root or "__pycache__" in root:
            continue
        level = root.replace(target_dir, '').count(os.sep)
        indent = ' ' * 4 * (level)
        tree.append(f"{indent}{os.path.basename(root)}/")
        subindent = ' ' * 4 * (level + 1)
        for f in files:
            tree.append(f"{subindent}{f}")
    report["structure"][target_dir] = tree
    print(f"\n[{target_dir}]")
    print("\n".join(tree[:20])) # Mostrar preview
    if len(tree) > 20: print("... (truncated)")

# 2. Ler arquivos criticos
print("\n--- CRITICAL FILES CONTENT ---")
for f_path in TARGET_FILES:
    content = read_file_safe(f_path)
    report["file_contents"][f_path] = content
    print(f"\n>>> FILE: {f_path}")
    print(content[:500] + "\n... [TRUNCATED]" if len(content) > 500 else content)

print("\n--- END REPORT ---")
