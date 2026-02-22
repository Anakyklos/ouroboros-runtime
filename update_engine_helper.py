import re

file_path = 'cli/src/runtime/SelfModifyingEngine.ts'

with open(file_path, 'r') as f:
    content = f.read()

# 1. Update extractExports to use a helper
# The helper  will handle the loop and reset.

new_method_body = """private extractExports(code: string): string[] {
        const exports: string[] = [];

        for (const pattern of EXPORT_PATTERNS) {
            this.extractMatches(code, pattern, exports);
        }

        return exports;
    }

    private extractMatches(code: string, pattern: RegExp, results: string[]): void {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(code)) !== null) {
            results.push(match[1]);
        }
    }"""

# Locate old implementation of extractExports
# It currently looks like:
# private extractExports(code: string): string[] {
#     const exports: string[] = [];
#
#     for (const pattern of EXPORT_PATTERNS) {
#         pattern.lastIndex = 0;
#         let match;
#         while ((match = pattern.exec(code)) !== null) {
#             exports.push(match[1]);
#         }
#     }
#
#     return exports;
# }

start_marker = "private extractExports(code: string): string[] {"
end_marker = "return exports;\n    }"

if start_marker in content:
    start_idx = content.find(start_marker)
    # Finding the end is tricky because the internal block structure is similar to what we wrote.
    # We can search for the end marker, assuming no nested functions use the exact same return line indentation.
    end_idx = content.find(end_marker, start_idx) + len(end_marker)

    if start_idx != -1 and end_idx != -1:
        old_impl = content[start_idx:end_idx]
        content = content.replace(old_impl, new_method_body)
    else:
        print("Could not find end of extractExports")
        exit(1)
else:
    print("Could not find start of extractExports")
    exit(1)

with open(file_path, 'w') as f:
    f.write(content)

print("Successfully updated SelfModifyingEngine.ts with helper method")
