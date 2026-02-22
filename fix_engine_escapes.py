import re

file_path = 'cli/src/runtime/SelfModifyingEngine.ts'

with open(file_path, 'r') as f:
    content = f.read()

# Replace EXPORT_PATTERNS with properly escaped strings
# We want the file to contain: 'export\s...'
# So we need to replace single backslashes with double backslashes?
# Wait, existing content is 'export\s'.
# We need 'export\s'.

# Let's replace the whole block again with quadruple backslashes in Python string to get double in file.

new_patterns = """const EXPORT_PATTERNS: ReadonlyArray<string> = Object.freeze([
    'export\\\\s+(?:async\\\\s+)?function\\\\s+([\\\\p{ID_Start}$][\\\\p{ID_Continue}$]*)',
    'export\\\\s+class\\\\s+([\\\\p{ID_Start}$][\\\\p{ID_Continue}$]*)',
    'export\\\\s+const\\\\s+([\\\\p{ID_Start}$][\\\\p{ID_Continue}$]*)',
    'export\\\\s+interface\\\\s+([\\\\p{ID_Start}$][\\\\p{ID_Continue}$]*)',
    'export\\\\s+type\\\\s+([\\\\p{ID_Start}$][\\\\p{ID_Continue}$]*)',
]);"""

# Match existing incorrect block
old_block_start = "const EXPORT_PATTERNS: ReadonlyArray<string> = Object.freeze(["
end_marker = "]);"

idx_start = content.find(old_block_start)
if idx_start != -1:
    idx_end = content.find(end_marker, idx_start) + len(end_marker)
    content = content[:idx_start] + new_patterns + content[idx_end:]
else:
    print("Could not find EXPORT_PATTERNS block")
    exit(1)

with open(file_path, 'w') as f:
    f.write(content)

print("Fixed escapes in EXPORT_PATTERNS")
