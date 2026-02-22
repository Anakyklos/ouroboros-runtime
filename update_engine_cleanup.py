import re

file_path = 'cli/src/runtime/SelfModifyingEngine.ts'

with open(file_path, 'r') as f:
    content = f.read()

# 1. Remove redundant lastIndex assignment
content = content.replace("        const clonedPattern = new RegExp(pattern);\n        clonedPattern.lastIndex = 0;", "        const clonedPattern = new RegExp(pattern);")

# 2. Update documentation
# Replace:
#      * Safety:
#      * - We clone the RegExp instance per call to ensure thread-safety and avoid
#      *   shared mutable state (lastIndex), making this robust against reentrancy
#      *   or concurrent usage.
# With:
#      * Safety:
#      * - The pattern must be global to avoid infinite loops.
#      * - We clone the RegExp instance per call to avoid manually managing shared
#      *   mutable state (lastIndex) on the static constants, which simplifies the
#      *   logic and prevents subtle bugs from reentrancy.

old_doc_safety = """     * Safety:
     * - We clone the RegExp instance per call to ensure thread-safety and avoid
     *   shared mutable state (lastIndex), making this robust against reentrancy
     *   or concurrent usage."""

new_doc_safety = """     * Safety:
     * - The pattern must be global to avoid infinite loops.
     * - We clone the RegExp instance per call to avoid manually managing shared
     *   mutable state (lastIndex) on the static constants, which simplifies the
     *   logic and prevents subtle bugs from reentrancy."""

if old_doc_safety in content:
    content = content.replace(old_doc_safety, new_doc_safety)
else:
    print("Could not find doc safety block")
    # Fallback to loose replacement or manual check
    pass

with open(file_path, 'w') as f:
    f.write(content)

print("Cleaned up SelfModifyingEngine.ts")
