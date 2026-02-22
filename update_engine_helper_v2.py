import re

file_path = 'cli/src/runtime/SelfModifyingEngine.ts'

with open(file_path, 'r') as f:
    content = f.read()

# Define the helper method and the new extractExports implementation
# We will inject the helper *after* extractExports for cleanliness

new_extractExports = """    private extractExports(code: string): string[] {
        const exports: string[] = [];

        for (const pattern of EXPORT_PATTERNS) {
            this.extractMatches(pattern, code, exports);
        }

        return exports;
    }"""

helper_method = """    private extractMatches(pattern: RegExp, code: string, results: string[]): void {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(code)) !== null) {
            results.push(match[1]);
        }
    }"""

# Locate old implementation of extractExports to replace
# We need to find the block more robustly.
start_marker = "private extractExports(code: string): string[] {"
end_marker = "return exports;\n    }"

idx_start = content.find(start_marker)
if idx_start == -1:
    print("Could not find extractExports start")
    exit(1)

idx_end = content.find(end_marker, idx_start)
if idx_end == -1:
    print("Could not find extractExports end")
    exit(1)

idx_end += len(end_marker)

# Replace the block
old_impl = content[idx_start:idx_end]
content = content.replace(old_impl, new_extractExports + "\n\n" + helper_method)

with open(file_path, 'w') as f:
    f.write(content)

print("Successfully updated SelfModifyingEngine.ts with helper method (v2)")
