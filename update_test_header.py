import re

file_path = 'cli/src/runtime/SelfModifyingEngine.test.ts'

with open(file_path, 'r') as f:
    content = f.read()

header = """/**
 * 🧪 Tests for SelfModifyingEngine
 *
 * Verifica:
 * 1. Extração de exports (funções, classes, const, interfaces, types)
 * 2. Manipulação de identificadores com $ e unicode
 * 3. Validação de padrões regex e segurança (prevenção de loops infinitos)
 */
"""

if "🧪 Tests for SelfModifyingEngine" not in content:
    content = header + content

with open(file_path, 'w') as f:
    f.write(content)

print("Added test file header")
