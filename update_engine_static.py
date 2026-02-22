import re

file_path = 'cli/src/runtime/SelfModifyingEngine.ts'

with open(file_path, 'r') as f:
    content = f.read()

# Replace method definition
content = content.replace("private extractMatches(pattern: RegExp, code: string, results: string[]): void", "private static extractMatches(pattern: RegExp, code: string, results: string[]): void")

# Replace call site
content = content.replace("this.extractMatches(pattern, code, exports);", "SelfModifyingEngine.extractMatches(pattern, code, exports);")

with open(file_path, 'w') as f:
    f.write(content)

print("Updated SelfModifyingEngine.ts to use static extractMatches")
