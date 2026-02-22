import re

file_path = 'cli/src/runtime/SelfModifyingEngine.ts'

with open(file_path, 'r') as f:
    content = f.read()

# We have two extractMatches. One (pattern, code, results) and one (code, pattern, results).
# We want to keep (pattern, code, results) as used in extractExports loop.

# The duplicate looks like:
#     private extractMatches(pattern: RegExp, code: string, results: string[]): void {
#         pattern.lastIndex = 0;
#         let match;
#         while ((match = pattern.exec(code)) !== null) {
#             results.push(match[1]);
#         }
#     }
#
#     private extractMatches(code: string, pattern: RegExp, results: string[]): void {
# ...

# We will just rewrite the bottom of the file from extractExports onwards to be clean.

# Find extractExports
start_marker = "private extractExports(code: string): string[] {"
if start_marker in content:
    start_idx = content.find(start_marker)

    # We'll just truncate and append the correct implementation + walkDir + end of class

    # Wait, walkDir is after.
    # Let's verify what comes after the duplicate. walkDir.

    # Let's find the start of the duplicate block
    # It seems I appended it...

    # Let's search for the second occurrence of private extractMatches
    first_occ = content.find("private extractMatches")
    second_occ = content.find("private extractMatches", first_occ + 1)

    if second_occ != -1:
        # We need to remove from second_occ until the start of walkDir
        walk_dir_start = content.find("private async walkDir", second_occ)

        # Remove the chunk
        content = content[:second_occ] + content[walk_dir_start:]
    else:
        print("Duplicate not found via simple search")

with open(file_path, 'w') as f:
    f.write(content)

print("Removed duplicate method")
