import re

file_path = 'cli/src/runtime/SelfModifyingEngine.ts'

with open(file_path, 'r') as f:
    content = f.read()

# Replace EXPORT_PATTERNS declaration
old_pattern = r'const EXPORT_PATTERNS = \[\s+/export\s\+\(\?:async\s\+\)\?function\s\+\(\w\+\)/g,\s+/export\s\+class\s\+\(\w\+\)/g,\s+/export\s\+const\s\+\(\w\+\)/g,\s+/export\s\+interface\s\+\(\w\+\)/g,\s+/export\s\+type\s\+\(\w\+\)/g,\s+\];'

new_pattern = """const EXPORT_PATTERNS: ReadonlyArray<RegExp> = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+const\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
];"""

# We'll do a simple string replace for the block start if regex is fussy
block_start = "const EXPORT_PATTERNS = ["
if block_start in content:
    idx = content.find(block_start)
    end_idx = content.find("];", idx) + 2

    # Check if we found the block
    if idx != -1 and end_idx != -1:
        content = content[:idx] + new_pattern + content[end_idx:]
    else:
        print("Could not find end of EXPORT_PATTERNS block")
        exit(1)
else:
    print("Could not find start of EXPORT_PATTERNS block")
    exit(1)

with open(file_path, 'w') as f:
    f.write(content)

print("Successfully updated types in SelfModifyingEngine.ts")
