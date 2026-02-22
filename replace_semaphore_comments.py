import sys
import re

filepath = "cli/src/utils/Semaphore.ts"

with open(filepath, "r") as f:
    content = f.read()

# Remove the long comment block
# // Immediately activate the next task ... // Result: 1/1. Correct.

pattern = r'\s+// Immediately activate[\s\S]*?// Result: 1/1\. Correct\.'
if re.search(pattern, content):
    content = re.sub(pattern, '', content)

with open(filepath, "w") as f:
    f.write(content)

print("Semaphore comments cleaned.")
