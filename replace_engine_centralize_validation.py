import sys
import re

filepath = "cli/src/runtime/SelfModifyingEngine.ts"

with open(filepath, "r") as f:
    content = f.read()

# 1. Update Constructor: keep normalization but simplify comment?
# The request was: "considere centralizar essa validação... ou torne o Semaphore aceitar apenas valores confiáveis".
# I'm deciding to keep the normalization in Engine (so it passes trusted values) but I'll make sure it's correct.
# It currently is:
# if (!Number.isFinite(this.config.concurrencyLimit) || this.config.concurrencyLimit <= 0) {
#     this.config.concurrencyLimit = DEFAULT_CONFIG.concurrencyLimit;
# }
# This is fine. It guarantees > 0.

# 2. Cleanup Semaphore.release comments
# This needs to be done in Semaphore.ts, not here. Wait, I should check Semaphore.ts.

# 3. Mark scanDirectory as internal
pattern_scan = r'/\*\*\n\s+\*\s+Public wrapper for directory scanning \(testing purposes\)\n\s+\*/\n\s+async scanDirectory'
replacement_scan = r'/**\n     * Public wrapper for directory scanning (testing purposes)\n     * @internal\n     */\n    async scanDirectory'

if re.search(pattern_scan, content):
    content = re.sub(pattern_scan, replacement_scan, content)
else:
    # If regex fails (whitespace issues), try loose match
    loose_scan = r'async scanDirectory'
    if loose_scan in content:
        # Check if JSDoc exists
        if '@internal' not in content: # Avoid double add
             # Find the JSDoc before it
             content = content.replace('Public wrapper for directory scanning (testing purposes)', 'Public wrapper for directory scanning (testing purposes)\n     * @internal')

with open(filepath, "w") as f:
    f.write(content)

print("Engine refactoring applied.")
