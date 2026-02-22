# Manual Testing Checklist - Anti-Vibe Protocol Quality Gates

## Overview
This checklist provides manual verification steps for all acceptance criteria of the Complete Anti-Vibe Protocol Quality Gates feature.

**Feature ID:** 002-complete-anti-vibe-protocol-quality-gates
**Date:** 2026-02-21
**Tester:** _________________
**Status:** _________________

---

## Acceptance Criteria Verification

### ✅ AC1: Code specifications are generated before any code writing begins

**Status:** ⬜ PASS | ⬜ FAIL | ⬜ N/A

**Verification Steps:**

1. **Check Spec Generator Implementation**
   - [ ] File exists: `cli/src/utils/spec-generator.ts`
   - [ ] Function `generateSpecTemplate()` exists with required sections
   - [ ] Function `validateSpecContent()` validates required sections
   - [ ] Function `canTransitionToExecution()` blocks phase transition without spec

2. **Check Spec Validator Integration**
   - [ ] File exists: `cli/src/orchestration/validators/SpecValidator.ts`
   - [ ] Validator checks for required sections:
     - [ ] 🎯 Objetivo (Objective)
     - [ ] 💡 Contexto e Justificativa (Context and Justification)
     - [ ] 🚀 Plano de Implementação (Implementation Plan)
     - [ ] ✅ Critérios de Aceitação / Verificação (Acceptance Criteria)
   - [ ] Validator checks for spec approval status

3. **Check Orchestrator Integration**
   - [ ] `Orchestrator.ts` imports SpecValidator
   - [ ] `validatePhase()` method calls SpecValidator for EXECUTION phase
   - [ ] Phase transition to EXECUTION blocked without approved spec

4. **Manual Test - Spec Generation**
   ```bash
   # Run a simple task to verify spec is required
   cd cli
   bun run src/utils/spec-generator.ts  # If standalone runner exists
   # OR check integration test
   bun test cli/src/orchestration/AntiVibeWorkflow.test.ts
   ```

**Expected Result:**
- Spec template generator creates complete spec with all required sections
- Spec validator enforces section presence
- Orchestrator blocks EXECUTION phase without approved spec

**Actual Result:**
_______________________________________________________________

**Notes:**
_______________________________________________________________

---

### ✅ AC2: All code in playground must pass tests before promotion is considered

**Status:** ⬜ PASS | ⬜ FAIL | ⬜ N/A

**Verification Steps:**

1. **Check Quality Gate Infrastructure**
   - [ ] File exists: `cli/src/orchestration/PromotionManager.ts`
   - [ ] File exists: `cli/src/orchestration/strategies/QualityGateRegistry.ts`
   - [ ] File exists: `cli/src/orchestration/strategies/TestValidationStrategy.ts`

2. **Check Test Validation Strategy**
   - [ ] TestValidationStrategy implements ValidationStrategy interface
   - [ ] Parses bun test output for metrics (total, passed, failed)
   - [ ] Returns failure result if tests fail

3. **Check Quality Gate Registry**
   - [ ] Registry has TEST gate registered by default
   - [ ] TEST gate is required (not optional)
   - [ ] Registry runs all gates before promotion

4. **Check Promotion Manager Integration**
   - [ ] `runQualityGates()` method exists
   - [ ] Quality gates run before file promotion
   - [ ] Failed gates prevent promotion

5. **Check Test Coverage Validator**
   - [ ] File exists: `cli/src/orchestration/validators/TestCoverageValidator.ts`
   - [ ] Validates test files exist for source files
   - [ ] Checks coverage thresholds (line, function, branch)

6. **Manual Test - Quality Gates**
   ```bash
   # Run integration test
   bun test cli/src/orchestration/AntiVibeWorkflow.test.ts
   # Look for "Quality Gate Validation" test cases
   ```

**Expected Result:**
- TestValidationStrategy runs tests and checks exit code
- QualityGateRegistry requires TEST gate to pass
- PromotionManager prevents promotion without passing tests
- TestCoverageValidator enforces test coverage thresholds

**Actual Result:**
_______________________________________________________________

**Notes:**
_______________________________________________________________

---

### ✅ AC3: Human approval is required before code moves from playground to src

**Status:** ⬜ PASS | ⬜ FAIL | ⬜ N/A

**Verification Steps:**

1. **Check Approval Manager**
   - [ ] File exists: `cli/src/orchestration/ApprovalManager.ts`
   - [ ] File exists: `cli/src/orchestration/approval-types.ts`
   - [ ] ApprovalManager has `createRequest()` method
   - [ ] ApprovalManager has `approveRequest()` and `rejectRequest()` methods
   - [ ] Approval status lifecycle: PENDING → APPROVED/REJECTED/CANCELLED

2. **Check Approval CLI Commands**
   - [ ] File exists: `cli/src/commands/approval-commands.ts`
   - [ ] `listApprovalsCommand()` lists pending requests
   - [ ] `approveCommand()` approves requests interactively
   - [ ] `rejectCommand()` rejects requests interactively
   - [ ] `reviewCommand()` provides batch review workflow

3. **Check Approval History**
   - [ ] File exists: `cli/src/orchestration/ApprovalHistory.ts`
   - [ ] Records all approval events (created, approved, rejected, cancelled, promoted)
   - [ ] Stores history in Markdown format in `.agent/approval-history/`
   - [ ] Provides query capabilities for audit trail

4. **Check Promotion Manager Integration**
   - [ ] `promote()` method checks approval status
   - [ ] Only APPROVED files can be promoted
   - [ ] `executePromotions()` promotes approved files in batch

5. **Manual Test - Approval Workflow**
   ```bash
   # Run integration test
   bun test cli/src/orchestration/AntiVibeWorkflow.test.ts
   # Look for "Human Approval" test cases
   # Or test CLI commands
   bun run cli/src/commands/approval-commands.ts list
   ```

**Expected Result:**
- ApprovalManager queues promotion requests for human review
- CLI commands allow listing, reviewing, approving, and rejecting requests
- ApprovalHistory tracks audit trail of all approvals
- PromotionManager only promotes approved files

**Actual Result:**
_______________________________________________________________

**Notes:**
_______________________________________________________________

---

### ✅ AC4: Skill creator scripts have no remaining TODO placeholders

**Status:** ⬜ PASS | ⬜ FAIL | ⬜ N/A

**Verification Steps:**

1. **Check init_skill.py for TODOs**
   ```bash
   grep -n 'TODO' .agent/skills/tooling/skill-creator/scripts/init_skill.py
   ```
   - [ ] No TODO placeholders found in user-facing template
   - [ ] No TODO placeholders found in example scripts
   - [ ] No TODO placeholders found in skill generation logic

2. **Check skill-creator/SKILL.md for TODO references**
   ```bash
   grep -n 'TODO' .agent/skills/tooling/skill-creator/SKILL.md
   ```
   - [ ] No TODO placeholders found in workflow documentation
   - [ ] All phases are documented with complete instructions

3. **Verify skill-creator Phase 3 (Spec Generation)**
   - [ ] Phase 3 documented in skill-creator/SKILL.md
   - [ ] Spec generation workflow follows Anti-Vibe methodology
   - [ ] SPEC.md template includes all required sections

4. **Verify skill-creator Phase 4 (Quality Gates)**
   - [ ] Phase 4 includes quality gate validation step
   - [ ] quick_validate.py integration documented
   - [ ] Quality gate checks explained

5. **Manual Test - Create New Skill**
   ```bash
   # Run skill creator
   source .auto-claude/.venv/bin/activate
   python .agent/skills/tooling/skill-creator/scripts/init_skill.py test-skill
   # Check generated skill for TODO placeholders
   grep -r 'TODO' .agent/skills/test-skill/
   ```

**Expected Result:**
- Zero TODO placeholders in init_skill.py
- Zero TODO placeholders in skill-creator/SKILL.md
- Generated skills have complete, non-placeholder content
- Phase 3 (Spec Generation) and Phase 4 (Quality Gates) documented

**Actual Result:**
_______________________________________________________________

**Notes:**
_______________________________________________________________

---

### ✅ AC5: Validation checks prevent promotion of code that doesn't meet quality standards

**Status:** ⬜ PASS | ⬜ FAIL | ⬜ N/A

**Verification Steps:**

1. **Check Validation Strategies**
   - [ ] TestValidationStrategy validates test execution
   - [ ] TestCoverageValidator validates test coverage
   - [ ] SpecValidator validates spec completeness
   - [ ] TypeCheckValidator validates TypeScript compilation
   - [ ] LintValidator validates code style (optional)

2. **Check Quality Gate Registry**
   - [ ] Default gates: TEST (required), TYPE_CHECK (required), LINT (optional)
   - [ ] Registry runs gates in priority order
   - [ ] Failed gates prevent promotion

3. **Check Validation Reporter**
   - [ ] File exists: `cli/src/orchestration/ValidationReporter.ts`
   - [ ] Generates clear pass/fail reports
   - [ ] Formats validation results for human review

4. **Check Orchestrator Integration**
   - [ ] Orchestrator runs quality gates after EXECUTION phase
   - [ ] Quality gates enabled via `enableQualityGates` config
   - [ ] Failed gates trigger retry loop

5. **Manual Test - Validation Enforcement**
   ```bash
   # Run integration test
   bun test cli/src/orchestration/AntiVibeWorkflow.test.ts
   # Look for validation failure scenarios
   ```

**Expected Result:**
- Multiple validation strategies enforce quality standards
- QualityGateRegistry orchestrates validation checks
- Failed validations block code promotion
- Clear error messages explain validation failures

**Actual Result:**
_______________________________________________________________

**Notes:**
_______________________________________________________________

---

## End-to-End Workflow Verification

### Complete Anti-Vibe Workflow Test

**Status:** ⬜ PASS | ⬜ FAIL | ⬜ N/A

**Test Scenario:** Create a new feature using the anti-vibe workflow

**Steps:**

1. **Phase 1: RESEARCH**
   - [ ] Start new feature task
   - [ ] Orchestrator enforces RESEARCH phase constraints
   - [ ] No code can be written during RESEARCH

2. **Phase 2: SPECIFICATION**
   - [ ] Spec generator creates spec template
   - [ ] Spec filled with required sections:
     - [ ] 🎯 Objetivo
     - [ ] 💡 Contexto e Justificativa
     - [ ] 🚀 Plano de Implementação
     - [ ] ✅ Critérios de Aceitação
   - [ ] Spec marked as approved (✅, APPROVED, APROVADO, [x], or [X])

3. **Phase 3: EXECUTION**
   - [ ] Spec validator checks spec completeness
   - [ ] Phase transition blocked without approved spec
   - [ ] Code written to playground directory
   - [ ] Test files created alongside source files
   - [ ] Quality gates run automatically:
     - [ ] Tests pass
     - [ ] Type check passes
     - [ ] Coverage thresholds met

4. **Phase 4: HUMAN APPROVAL**
   - [ ] Approval request created for each playground file
   - [ ] Approval manager queues requests for review
   - [ ] Human reviews requests via CLI commands
   - [ ] Files approved or rejected

5. **Phase 5: PROMOTION**
   - [ ] Approved files promoted from playground to src
   - [ ] Promotion status updated to PROMOTED
   - [ ] Approval history records promotion event
   - [ ] Playground files cleaned up

**Integration Test:**
```bash
bun test cli/src/orchestration/AntiVibeWorkflow.test.ts
```

- [ ] All integration tests pass
- [ ] Test coverage: _______%

**Expected Result:**
- Complete workflow executes without errors
- Each phase gate enforces its constraints
- Quality standards validated before promotion
- Human approval required for promotion
- Audit trail maintained throughout

**Actual Result:**
_______________________________________________________________

**Issues Found:**
_______________________________________________________________

---

## Verification Tests

### Automated Test Suite

**Unit Tests:**
```bash
bun test cli/src/orchestration/PromotionManager.test.ts
bun test cli/src/orchestration/QualityGateRegistry.test.ts
bun test cli/src/orchestration/ApprovalManager.test.ts
```
- [ ] All unit tests pass

**Integration Tests:**
```bash
bun test cli/src/orchestration/Orchestrator.test.ts
```
- [ ] All integration tests pass

**E2E Tests:**
```bash
bun test cli/src/orchestration/AntiVibeWorkflow.test.ts
```
- [ ] All E2E tests pass

**Type Check:**
```bash
bun run typecheck
```
- [ ] No type errors

**TODO Check:**
```bash
grep -r 'TODO' .agent/skills/tooling/skill-creator/ | wc -l
```
- [ ] Output: 0 TODO placeholders found

---

## File Existence Checklist

### Core Infrastructure Files
- [ ] `cli/src/orchestration/PromotionManager.ts`
- [ ] `cli/src/orchestration/promotion-types.ts`
- [ ] `cli/src/orchestration/strategies/QualityGateRegistry.ts`
- [ ] `cli/src/orchestration/strategies/TestValidationStrategy.ts`
- [ ] `cli/src/orchestration/validators/TestCoverageValidator.ts`
- [ ] `cli/src/orchestration/validators/SpecValidator.ts`
- [ ] `cli/src/orchestration/ValidationReporter.ts`

### Workflow Files
- [ ] `cli/src/utils/spec-generator.ts`
- [ ] `cli/src/utils/playground-tracker.ts`
- [ ] `cli/src/utils/anti-vibe.ts` (modified)

### Approval System Files
- [ ] `cli/src/orchestration/ApprovalManager.ts`
- [ ] `cli/src/orchestration/approval-types.ts`
- [ ] `cli/src/orchestration/ApprovalHistory.ts`
- [ ] `cli/src/commands/approval-commands.ts`

### Test Files
- [ ] `cli/src/orchestration/AntiVibeWorkflow.test.ts`

### Orchestrator Integration
- [ ] `cli/src/orchestration/Orchestrator.ts` (modified for quality gates and spec validation)

### Skill Creator Files
- [ ] `.agent/skills/tooling/skill-creator/SKILL.md` (modified for Phase 3 and 4)
- [ ] `.agent/skills/tooling/skill-creator/scripts/init_skill.py` (TODO placeholders removed)

---

## Final Signoff

### Acceptance Criteria Summary
- [ ] AC1: Code specifications generated before code
- [ ] AC2: Playground code passes tests before promotion
- [ ] AC3: Human approval required for promotion
- [ ] AC4: Skill creator has no TODO placeholders
- [ ] AC5: Validation checks enforce quality standards

### Test Results Summary
- Unit Tests: ⬜ PASS | ⬜ FAIL
- Integration Tests: ⬜ PASS | ⬜ FAIL
- E2E Tests: ⬜ PASS | ⬜ FAIL
- Type Check: ⬜ PASS | ⬜ FAIL
- TODO Check: ⬜ PASS | ⬜ FAIL

### Overall Assessment
**Status:** ⬜ READY FOR QA | ⬜ NEEDS FIXES | ⬜ READY FOR PRODUCTION

**QA Reviewer:** _________________
**Date:** _________________
**Signature:** _________________

---

## Additional Notes

**Blockers:**
_______________________________________________________________

**Workarounds:**
_______________________________________________________________

**Suggestions for Improvement:**
_______________________________________________________________
