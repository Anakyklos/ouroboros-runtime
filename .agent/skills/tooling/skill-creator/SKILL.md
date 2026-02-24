---
name: skill-creator
description: "This skill should be used when the user asks to create a new skill, build a skill, make a custom skill, develop a CLI skill, or wants to extend the CLI with new capabilities. Automates the entire skill creation workflow from brainstorming to installation."
version: 1.4.0
author: Eric Andrade
created: 2025-02-01
updated: 2026-02-21
platforms: [github-copilot-cli, claude-code, codex, antigravity]
category: meta
tags: [automation, scaffolding, skill-creation, meta-skill]
risk: safe
---

# skill-creator

## Purpose

To create new CLI skills following Anthropic's official best practices with zero manual configuration. This skill automates brainstorming, template application, validation, and installation processes while maintaining progressive disclosure patterns and writing style standards.

## When to Use This Skill

This skill should be used when:
- User wants to extend CLI functionality with custom capabilities
- User needs to create a skill following official standards
- User wants to automate repetitive CLI tasks with a reusable skill
- User needs to package domain knowledge into a skill format
- User wants both local and global skill installation options

## Core Capabilities

1. **Interactive Brainstorming** - Collaborative session to define skill purpose and scope
2. **Prompt Enhancement** - Optional integration with prompt-engineer skill for refinement
3. **Automated Spec Generation** - Creates comprehensive technical specification document
4. **Template Application** - Automatic file generation from standardized templates
5. **Validation** - YAML, content, and style checks against Anthropic standards
6. **Installation** - Local repository or global installation with symlinks
7. **Progress Tracking** - Visual gauge showing completion status at each step

## Step 0: Discovery

Before starting skill creation, gather runtime information:

```bash
# Detect available platforms
COPILOT_INSTALLED=false
CLAUDE_INSTALLED=false
CODEX_INSTALLED=false

if command -v gh &>/dev/null && gh copilot --version &>/dev/null 2>&1; then
    COPILOT_INSTALLED=true
fi

if [[ -d "$HOME/.claude" ]]; then
    CLAUDE_INSTALLED=true
fi

if [[ -d "$HOME/.codex" ]]; then
    CODEX_INSTALLED=true
fi

# Determine working directory
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SKILLS_REPO="$REPO_ROOT"

# Check if in cli-ai-skills repository
if [[ ! -d "$SKILLS_REPO/.github/skills" ]]; then
    echo "⚠️  Not in cli-ai-skills repository. Creating standalone skill."
    STANDALONE=true
fi

# Get user info from git config
AUTHOR=$(git config user.name || echo "Unknown")
EMAIL=$(git config user.email || echo "")
```

**Key Information Needed:**
- Which platforms to target (Copilot, Claude, Codex, or all three)
- Installation preference (local, global, or both)
- Skill name and purpose
- Skill type (general, code, documentation, analysis)

## Main Workflow

### Progress Tracking Guidelines

Throughout the workflow, display a visual progress bar before starting each phase to keep the user informed. The progress bar format is:

```
[████████████░░░░░░] 57% - Step 4/7: File Generation
```

**Format specifications:**
- 20 characters wide (use █ for filled, ░ for empty)
- Percentage based on current step (Step 1=14%, Step 2=28%, Step 3=42%, Step 4=57%, Step 5=71%, Step 6=85%, Step 7=100%)
- Step counter showing current/total (e.g., "Step 4/7")
- Brief description of current phase

**Display the progress bar using:**
```bash
echo "[████░░░░░░░░░░░░░░] 14% - Step 1/7: Brainstorming & Planning"
```

### Phase 1: Brainstorming & Planning

**Progress:** Display before starting this phase:
```bash
echo "[████░░░░░░░░░░░░░░] 14% - Step 1/7: Brainstorming & Planning"
```

Display progress:
```
╔══════════════════════════════════════════════════════════════╗
║     🛠️  SKILL CREATOR - Creating New Skill                  ║
╠══════════════════════════════════════════════════════════════╣
║ → Phase 1: Brainstorming                 [10%]               ║
║ ○ Phase 2: Prompt Refinement                                 ║
║ ○ Phase 3: Spec Generation                                   ║
║ ○ Phase 4: File Generation                                   ║
║ ○ Phase 5: Validation                                        ║
║ ○ Phase 6: Installation                                      ║
║ ○ Phase 7: Completion                                        ║
╠══════════════════════════════════════════════════════════════╣
║ Progress: ███░░░░░░░░░░░░░░░░░░░░░░░░░░░  10%              ║
╚══════════════════════════════════════════════════════════════╝
```

**Ask the user:**

1. **What should this skill do?** (Free-form description)
   - Example: "Help users debug Python code by analyzing stack traces"
   
2. **When should it trigger?** (Provide 3-5 trigger phrases)
   - Example: "debug Python error", "analyze stack trace", "fix Python exception"

3. **What type of skill is this?**
   - [ ] General purpose (default template)
   - [ ] Code generation/modification
   - [ ] Documentation creation/maintenance
   - [ ] Analysis/investigation

4. **Which platforms should support this skill?**
   - [ ] GitHub Copilot CLI
   - [ ] Claude Code
    - [ ] Codex
    - [ ] All three (recommended)

5. **Provide a one-sentence description** (will appear in metadata)
   - Example: "Analyzes Python stack traces and suggests fixes"

**Capture responses and prepare for next phase.**

### Phase 2: Prompt Enhancement (Optional)

**Progress:** Display before starting this phase:
```bash
echo "[████████░░░░░░░░░░] 28% - Step 2/7: Prompt Enhancement"
```

Update progress:
```
╔══════════════════════════════════════════════════════════════╗
║ ✓ Phase 1: Brainstorming                                     ║
║ → Phase 2: Prompt Refinement             [25%]               ║
╠══════════════════════════════════════════════════════════════╣
║ Progress: ███████░░░░░░░░░░░░░░░░░░░░░░░░  25%              ║
╚══════════════════════════════════════════════════════════════╝
```

**Ask the user:**
"Would you like to refine the skill description using the prompt-engineer skill?"
- [ ] Yes - Use prompt-engineer to enhance clarity and structure
- [ ] No - Proceed with current description

If **Yes**:
1. Check if prompt-engineer skill is available
2. Invoke with current description as input
3. Review enhanced output with user
4. Ask: "Accept enhanced version or keep original?"

If **No** or prompt-engineer unavailable:
- Proceed with original user input

### Phase 3: Spec Generation

**Progress:** Display before starting this phase:
```bash
echo "[████████████░░░░░░] 42% - Step 3/7: Spec Generation"
```

Update progress:
```
╔══════════════════════════════════════════════════════════════╗
║ ✓ Phase 1: Brainstorming                                     ║
║ ✓ Phase 2: Prompt Refinement                                 ║
║ → Phase 3: Spec Generation               [35%]               ║
╠══════════════════════════════════════════════════════════════╣
║ Progress: ██████████░░░░░░░░░░░░░░░░░░░░  35%              ║
╚══════════════════════════════════════════════════════════════╝
```

**Purpose:**
Create a comprehensive technical specification document that serves as the blueprint for skill implementation. This phase follows the Anti-Vibe methodology, ensuring clarity before proceeding to file generation.

**Ask the user:**
"Ready to generate the technical specification for this skill?"

- [ ] **Yes** - Generate spec now
- [ ] **Review parameters first** - Show what will be included
- [ ] **Skip spec** - Proceed directly to file generation (not recommended)

If **Review parameters first**, display:
```
📋 Spec Contents:
─────────────────────────────────────────────────────────────
1. Skill Identity
   • Name: {SKILL_NAME}
   • Type: {general/code/documentation/analysis}
   • Target Platforms: {Copilot/Claude/Codex}

2. Functional Specification
   • Purpose statement
   • Trigger phrases
   • Input/output expectations

3. Technical Architecture
   • File structure
   • Platform-specific adaptations
   • Integration points

4. Implementation Plan
   • Phase breakdown
   • Validation criteria
   • Installation strategy

5. Quality Gates
   • Word count targets
   • Style requirements
   • Testing checklist
```

**Generate spec document:**

```bash
# Create spec filename
SPEC_FILE=".github/skills/${SKILL_NAME}/SPEC.md"

# Generate spec with timestamp
cat > "$SPEC_FILE" << 'EOF'
# Technical Specification: {SKILL_NAME}

**Generated:** {DATE}
**Author:** {AUTHOR}
**Version:** 1.0.0
**Status:** Draft

---

## 1. Skill Identity

### 1.1 Metadata
- **Name:** `{SKILL_NAME}`
- **Type:** `{SKILL_TYPE}`
- **Target Platforms:** `{PLATFORMS}`
- **Version:** 1.0.0
- **Author:** `{AUTHOR} <{EMAIL}>`

### 1.2 Purpose Statement
{PURPOSE_STATEMENT}

### 1.3 Trigger Phrases
{TRIGGER_PHRASES}

---

## 2. Functional Specification

### 2.1 Core Capabilities
1. **{CAPABILITY_1}**
   - Description: {DESCRIPTION}
   - Input: {INPUT_FORMAT}
   - Output: {OUTPUT_FORMAT}

2. **{CAPABILITY_2}**
   - Description: {DESCRIPTION}
   - Input: {INPUT_FORMAT}
   - Output: {OUTPUT_FORMAT}

### 2.2 Usage Patterns
**When to use:**
- {USE_CASE_1}
- {USE_CASE_2}
- {USE_CASE_3}

**When NOT to use:**
- {ANTI_PATTERN_1}
- {ANTI_PATTERN_2}

### 2.3 Workflow
1. **{STEP_1}**
   - Action: {ACTION}
   - Validation: {CHECK}

2. **{STEP_2}**
   - Action: {ACTION}
   - Validation: {CHECK}

---

## 3. Technical Architecture

### 3.1 File Structure
```
{PLATFORM}/skills/{SKILL_NAME}/
├── SKILL.md                 # Main skill documentation
├── README.md                # User-facing documentation
├── SPEC.md                  # This specification
├── references/              # Extended documentation
│   └── detailed-guide.md    # In-depth technical details
├── examples/                # Usage examples
│   ├── basic-usage.md
│   └── advanced-usage.md
└── scripts/                 # Utility scripts
    ├── validate.sh
    └── test.sh
```

### 3.2 Platform-Specific Adaptations
**GitHub Copilot CLI:**
- {COPILOT_SPECIFIC}

**Claude Code:**
- {CLAUDE_SPECIFIC}

**Codex:**
- {CODEX_SPECIFIC}

### 3.3 Integration Points
- **Dependencies:** {DEPENDENCIES}
- **Related Skills:** {RELATED_SKILLS}
- **External Tools:** {EXTERNAL_TOOLS}

---

## 4. Implementation Plan

### 4.1 Phase Breakdown
**Phase 1: File Generation**
- [ ] Create SKILL.md from template
- [ ] Generate README.md
- [ ] Set up directory structure
- [ ] Apply platform-specific adaptations

**Phase 2: Content Development**
- [ ] Write core documentation
- [ ] Create usage examples
- [ ] Add validation scripts
- [ ] Prepare references/ content

**Phase 3: Validation**
- [ ] YAML frontmatter validation
- [ ] Content quality checks
- [ ] Style guide compliance
- [ ] Word count verification

**Phase 4: Installation**
- [ ] Repository setup
- [ ] Global symlinks (if applicable)
- [ ] Installation verification
- [ ] Integration testing

### 4.2 Validation Criteria
**YAML Frontmatter:**
- [ ] All required fields present
- [ ] Description in third-person format
- [ ] Valid version number
- [ ] Platform tags correct

**Content Quality:**
- [ ] SKILL.md: 1,500-2,000 words (ideal)
- [ ] SKILL.md: Under 5,000 words (max)
- [ ] README.md: 300-500 words
- [ ] No second-person language
- [ ] Progressive disclosure followed

**Style Compliance:**
- [ ] Imperative/infinitive verbs
- [ ] Clear section headers
- [ ] Code blocks properly formatted
- [ ] Examples provided

### 4.3 Installation Strategy
**Local Repository:**
- Files in `{PLATFORM}/skills/{SKILL_NAME}/`
- Works when repository is active
- No system-wide installation

**Global Installation:**
- Symlinks in `~/{PLATFORM}/skills/{SKILL_NAME}/`
- Works system-wide
- Auto-updates with git pull

**Recommended:** Both (repository + symlinks)

---

## 5. Quality Gates

### 5.1 Documentation Standards
**SKILL.md Requirements:**
- Word count: 1,500-2,000 (ideal), <5,000 (max)
- Writing style: Imperative/infinitive
- Format: Progressive disclosure
- Sections: Purpose, When to Use, Core Capabilities, Workflow

**README.md Requirements:**
- Word count: 300-500
- Audience: End users
- Content: Installation, usage, examples
- Tone: Accessible, practical

### 5.2 Validation Checklist
**Pre-Generation:**
- [ ] Purpose clearly defined
- [ ] Triggers identified
- [ ] Platform targets confirmed
- [ ] Author information available

**Post-Generation:**
- [ ] YAML validates successfully
- [ ] Word counts within limits
- [ ] Style guide compliance verified
- [ ] Examples provided
- [ ] Installation tested

### 5.3 Testing Strategy
**Manual Testing:**
- Trigger skill in CLI
- Verify expected behavior
- Test edge cases
- Validate error handling

**Automated Testing:**
- Run validation scripts
- Check symlink integrity
- Verify metadata completeness

---

## 6. Success Criteria

**Functional Requirements:**
- [ ] Skill triggers correctly on all specified phrases
- [ ] Provides accurate guidance for target use cases
- [ ] Integrates smoothly with target platforms
- [ ] Documentation is clear and actionable

**Quality Requirements:**
- [ ] Passes all validation checks
- [ ] Meets word count guidelines
- [ ] Follows writing style standards
- [ ] Includes working examples

**Usability Requirements:**
- [ ] README is accessible to new users
- [ ] SKILL.md is comprehensive yet focused
- [ ] Examples are practical and realistic
- [ ] Installation is straightforward

---

## 7. Revision History

| Version | Date       | Author      | Changes                     |
|---------|------------|-------------|-----------------------------|
| 1.0.0   | {DATE}     | {AUTHOR}    | Initial specification       |

---

## Appendix A: Template Variables

**Placeholders to substitute:**
- `{SKILL_NAME}` - kebab-case skill name
- `{SKILL_TYPE}` - general/code/documentation/analysis
- `{PLATFORMS}` - copilot/claude/codex
- `{AUTHOR}` - From git config
- `{EMAIL}` - From git config
- `{DATE}` - Current date (YYYY-MM-DD)
- `{PURPOSE_STATEMENT}` - From Phase 1 brainstorming
- `{TRIGGER_PHRASES}` - From Phase 1 brainstorming

## Appendix B: Reference Documents

- Anthropic Skill Development Guide
- Platform-Specific Documentation
- Writing Style Guide
- Progressive Disclosure Patterns

EOF

echo "✅ Spec generated: $SPEC_FILE"
```

**Display spec summary:**

```
📋 Technical Specification Generated
─────────────────────────────────────────────────────────────
File: .github/skills/{SKILL_NAME}/SPEC.md
Size: {FILE_SIZE}

📊 Spec Breakdown:
   Section 1: Skill Identity
   Section 2: Functional Specification
   Section 3: Technical Architecture
   Section 4: Implementation Plan
   Section 5: Quality Gates
   Section 6: Success Criteria
   Appendix A: Template Variables
   Appendix B: Reference Documents

✅ Ready for Phase 4: File Generation
```

**Next steps:**
1. Review the generated spec for accuracy
2. Make any manual adjustments if needed
3. Proceed to Phase 4 to generate files based on spec

**If user requests changes:**
- Edit SPEC.md directly
- Re-run generation with updated parameters
- Skip spec and proceed to file generation

## Artifact Expected

| Phase | Artifact | Location |
|------|----------|----------|
| 3 | SPEC.md | .github/skills/{SKILL_NAME}/SPEC.md |

### Phase 4: File Generation

**Progress:** Display before starting this phase:
```bash
echo "[██████████████░░░░] 57% - Step 4/7: File Generation"
```

Update progress:
```
╔══════════════════════════════════════════════════════════════╗
║ ✓ Phase 1: Brainstorming                                     ║
║ ✓ Phase 2: Prompt Refinement                                 ║
║ ✓ Phase 3: Spec Generation                                   ║
║ → Phase 4: File Generation               [50%]               ║
╠══════════════════════════════════════════════════════════════╣
║ Progress: ███████████████░░░░░░░░░░░░░░░  50%              ║
╚══════════════════════════════════════════════════════════════╝
```

**Generate skill structure:**

```bash
# Convert skill name to kebab-case
SKILL_NAME=$(echo "$USER_INPUT" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')

# Create directories
if [[ "$PLATFORM" =~ "copilot" ]]; then
    mkdir -p ".github/skills/$SKILL_NAME"/{references,examples,scripts}
fi

if [[ "$PLATFORM" =~ "claude" ]]; then
    mkdir -p ".claude/skills/$SKILL_NAME"/{references,examples,scripts}
fi

if [[ "$PLATFORM" =~ "codex" ]]; then
    mkdir -p ".codex/skills/$SKILL_NAME"/{references,examples,scripts}
fi
```

**Apply templates:**

1. **SKILL.md** - Use appropriate template:
   - `skill-template-copilot.md`, `skill-template-claude.md`, or `skill-template-codex.md`
   - Substitute placeholders:
     - `{{SKILL_NAME}}` → kebab-case name
     - `{{DESCRIPTION}}` → one-line description
     - `{{TRIGGERS}}` → comma-separated trigger phrases
     - `{{PURPOSE}}` → detailed purpose from brainstorming
     - `{{AUTHOR}}` → from git config
     - `{{DATE}}` → current date (YYYY-MM-DD)
     - `{{VERSION}}` → "1.0.0"

2. **README.md** - Use `readme-template.md`:
   - User-facing documentation (300-500 words)
   - Include installation instructions
   - Add usage examples

3. **References/** (optional but recommended):
   - Create `detailed-guide.md` for extended documentation (2k-5k words)
   - Move lengthy content here to keep SKILL.md under 2k words

**File creation commands:**

```bash
# Apply template with substitution
sed "s/{{SKILL_NAME}}/$SKILL_NAME/g; \
     s/{{DESCRIPTION}}/$DESCRIPTION/g; \
     s/{{AUTHOR}}/$AUTHOR/g; \
     s/{{DATE}}/$(date +%Y-%m-%d)/g" \
    resources/templates/skill-template-copilot.md \
    > ".github/skills/$SKILL_NAME/SKILL.md"

# Create README
sed "s/{{SKILL_NAME}}/$SKILL_NAME/g" \
    resources/templates/readme-template.md \
    > ".github/skills/$SKILL_NAME/README.md"

# Apply template for Codex if selected
if [[ "$PLATFORM" =~ "codex" ]]; then
    sed "s/{{SKILL_NAME}}/$SKILL_NAME/g; \
         s/{{DESCRIPTION}}/$DESCRIPTION/g; \
         s/{{AUTHOR}}/$AUTHOR/g; \
         s/{{DATE}}/$(date +%Y-%m-%d)/g" \
        resources/templates/skill-template-codex.md \
        > ".codex/skills/$SKILL_NAME/SKILL.md"
    
    sed "s/{{SKILL_NAME}}/$SKILL_NAME/g" \
        resources/templates/readme-template.md \
        > ".codex/skills/$SKILL_NAME/README.md"
fi
```

**Display created structure:**
```
✅ Created:
   .github/skills/your-skill-name/ (if Copilot selected)
   .claude/skills/your-skill-name/ (if Claude selected)
   .codex/skills/your-skill-name/ (if Codex selected)
   ├── SKILL.md (832 lines)
   ├── README.md (347 lines)
   ├── references/
   ├── examples/
   └── scripts/
```

**Quality Gate Validation:**

After file generation, run automated validation to ensure the skill meets quality standards:

```bash
# Determine the skill path based on platform
if [[ "$PLATFORM" =~ "copilot" ]]; then
    SKILL_PATH=".github/skills/$SKILL_NAME"
elif [[ "$PLATFORM" =~ "claude" ]]; then
    SKILL_PATH=".claude/skills/$SKILL_NAME"
elif [[ "$PLATFORM" =~ "codex" ]]; then
    SKILL_PATH=".codex/skills/$SKILL_NAME"
fi

# Run quality gate validation
python3 .agent/skills/tooling/skill-creator/scripts/quick_validate.py "$SKILL_PATH"
VALIDATION_RESULT=$?

if [ $VALIDATION_RESULT -eq 0 ]; then
    echo "✅ Quality gate passed!"
else
    echo "⚠️  Quality gate validation failed"
    echo ""
    echo "The following issues were found:"
    echo "• Review the error messages above"
    echo "• Common fixes:"
    echo "  - Name must be hyphen-case (lowercase with hyphens)"
    echo "  - Name max 64 characters"
    echo "  - Description max 1024 characters"
    echo "  - Description cannot contain < or >"
    echo "  - Only allowed frontmatter keys: name, description, license, allowed-tools, metadata"
    echo ""
    echo "Would you like to:"
    echo "1. Fix issues automatically (if possible)"
    echo "2. Fix manually and re-validate"
    echo "3. Continue despite validation errors (not recommended)"
fi
```

**Expected successful validation output:**
```
🔍 Running quality gate validation...
✅ Skill is valid!
✅ Quality gate passed!
```

**If validation fails, display specific errors:**
```
⚠️  Quality gate validation failed

❌ Validation Errors:
   • Name 'My_Skill' should be hyphen-case (lowercase letters, digits, and hyphens only)
   • Description is too long (1150 characters). Maximum is 1024 characters.
   • Unexpected key(s) in SKILL.md frontmatter: author, created

💡 Suggested fixes:
   1. Rename skill: My_Skill → my-skill
   2. Shorten description to under 1024 characters
   3. Remove disallowed frontmatter keys (author, created should be in metadata)

Options:
[1] Fix automatically
[2] Edit SKILL.md manually
[3] Continue anyway
```

**Quality Gate Checks:**

The validation script verifies:

1. **File Existence**
   - SKILL.md exists in the skill directory

2. **YAML Frontmatter Format**
   - Valid YAML delimiters (---\n...\n---)
   - Parseable YAML structure

3. **Required Fields**
   - `name`: Required, string type
   - `description`: Required, string type

4. **Name Validation**
   - Format: Hyphen-case (lowercase letters, digits, hyphens only)
   - Length: Maximum 64 characters
   - Pattern: Cannot start/end with hyphen, no consecutive hyphens
   - Regex: `^[a-z0-9-]+$`

5. **Description Validation**
   - Length: Maximum 1024 characters
   - No angle brackets (< or > allowed)
   - String type validation

6. **Allowed Properties**
   - Permitted top-level keys: name, description, license, allowed-tools, metadata
   - Any other keys are rejected

**Auto-fix capabilities:**

When validation fails, offer automated fixes for common issues:

```bash
# Fix naming convention
if [[ "$SKILL_NAME" =~ [A-Z] ]]; then
    FIXED_NAME=$(echo "$SKILL_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
    echo "Suggested fix: Rename '$SKILL_NAME' to '$FIXED_NAME'"
fi

# Fix description length
DESCRIPTION_LENGTH=${#DESCRIPTION}
if [ $DESCRIPTION_LENGTH -gt 1024 ]; then
    echo "Suggested fix: Shorten description by $((DESCRIPTION_LENGTH - 1024)) characters"
fi

# Remove disallowed frontmatter keys
DISALLOWED_KEYS=("author" "created" "updated" "version")
for key in "${DISALLOWED_KEYS[@]}"; do
    if grep -q "^$key:" "$SKILL_PATH/SKILL.md"; then
        echo "Suggested fix: Move '$key' to metadata section"
    fi
done
```

**Integration with Phase 5:**

The quality gate in Phase 4 is a quick sanity check. Phase 5 performs comprehensive validation including:
- Word count verification (SKILL.md: 1,500-2,000 ideal, <5,000 max)
- Writing style checks (imperative/infinitive, no second-person)
- Progressive disclosure compliance
- Content quality assessment

Think of Phase 4 quality gate as "does the basic structure work?" and Phase 5 validation as "does the content meet standards?"

### Phase 5: Validation

**Progress:** Display before starting this phase:
```bash
echo "[████████████████░░] 71% - Step 5/7: Validation"
```

Update progress:
```
╔══════════════════════════════════════════════════════════════╗
║ ✓ Phase 4: File Generation                                   ║
║ → Phase 5: Validation                    [65%]               ║
╠══════════════════════════════════════════════════════════════╣
║ Progress: ████████████████████░░░░░░░░░  65%              ║
╚══════════════════════════════════════════════════════════════╝
```

**Run validation scripts:**

```bash
# Validate YAML frontmatter
scripts/validate-skill-yaml.sh ".github/skills/$SKILL_NAME"

# Validate content quality
scripts/validate-skill-content.sh ".github/skills/$SKILL_NAME"
```

**Expected output:**
```
🔍 Validating YAML frontmatter...
✅ YAML frontmatter valid!

🔍 Validating content...
✅ Word count excellent: 1847 words
✅ Content validation complete!
```

**If validation fails:**
- Display specific errors
- Offer to fix automatically (common issues)
- Ask user to manually correct complex issues

**Common auto-fixes:**
- Convert second-person to imperative form
- Reformat description to third-person
- Add missing required fields

### Phase 6: Installation

**Progress:** Display before starting this phase:
```bash
echo "[████████████████████] 85% - Step 6/7: Installation"
```

Update progress:
```
╔══════════════════════════════════════════════════════════════╗
║ ✓ Phase 5: Validation                                        ║
║ → Phase 6: Installation                  [80%]               ║
╠══════════════════════════════════════════════════════════════╣
║ Progress: ████████████████████████░░░░░░  80%              ║
╚══════════════════════════════════════════════════════════════╝
```

**Ask the user:**
"How would you like to install this skill?"

- [ ] **Repository only** - Files created in `.github/skills/` (works when in repo)
- [ ] **Global installation** - Create symlinks in `~/.copilot/skills/` (works everywhere)
- [ ] **Both** - Repository + global symlinks (recommended, auto-updates with git pull)
- [ ] **Skip installation** - Just create files

**If global installation selected:**

```bash
# Detect which platforms to install for
INSTALL_TARGETS=()

if [[ "$COPILOT_INSTALLED" == "true" ]] && [[ "$PLATFORM" =~ "copilot" ]]; then
    INSTALL_TARGETS+=("copilot")
fi

if [[ "$CLAUDE_INSTALLED" == "true" ]] && [[ "$PLATFORM" =~ "claude" ]]; then
    INSTALL_TARGETS+=("claude")
fi

if [[ "$CODEX_INSTALLED" == "true" ]] && [[ "$PLATFORM" =~ "codex" ]]; then
    INSTALL_TARGETS+=("codex")
fi

# Ask user to confirm detected platforms
echo "Detected platforms: ${INSTALL_TARGETS[*]}"
echo "Install for these platforms? [Y/n]"
```

**Installation process:**

```bash
# GitHub Copilot CLI
if [[ " ${INSTALL_TARGETS[*]} " =~ " copilot " ]]; then
    ln -sf "$SKILLS_REPO/.github/skills/$SKILL_NAME" \
           "$HOME/.copilot/skills/$SKILL_NAME"
    echo "✅ Installed for GitHub Copilot CLI"
fi

# Claude Code
if [[ " ${INSTALL_TARGETS[*]} " =~ " claude " ]]; then
    ln -sf "$SKILLS_REPO/.claude/skills/$SKILL_NAME" \
           "$HOME/.claude/skills/$SKILL_NAME"
    echo "✅ Installed for Claude Code"
fi

# Codex
if [[ " ${INSTALL_TARGETS[*]} " =~ " codex " ]]; then
    ln -sf "$SKILLS_REPO/.codex/skills/$SKILL_NAME" \
           "$HOME/.codex/skills/$SKILL_NAME"
    echo "✅ Installed for Codex"
fi
```

**Verify installation:**

```bash
# Check symlinks
ls -la ~/.copilot/skills/$SKILL_NAME 2>/dev/null
ls -la ~/.claude/skills/$SKILL_NAME 2>/dev/null
ls -la ~/.codex/skills/$SKILL_NAME 2>/dev/null
```

### Phase 7: Completion

**Progress:** Display completion message:
```bash
echo "[████████████████████] 100% - ✓ Skill created successfully!"
```

Update progress:
```
╔══════════════════════════════════════════════════════════════╗
║ ✓ Phase 6: Installation                                      ║
║ ✅ SKILL CREATION COMPLETE!                                  ║
╠══════════════════════════════════════════════════════════════╣
║ Progress: ██████████████████████████████  100%              ║
╚══════════════════════════════════════════════════════════════╝
```

**Display summary:**

```
🎉 Skill created successfully!

📦 Skill Name: your-skill-name
📁 Location: .github/skills/your-skill-name/
🔗 Installed: Global (Copilot + Claude)

📋 Files Created:
   ✅ SPEC.md (technical specification)
   ✅ SKILL.md (1,847 words)
   ✅ README.md (423 words)
   ✅ references/ (empty, ready for extended docs)
   ✅ examples/ (empty, ready for code samples)
   ✅ scripts/ (empty, ready for utilities)

🚀 Next Steps:
   1. Review spec: Check SPEC.md for accuracy
   2. Test the skill: Try trigger phrases in CLI
   3. Add examples: Create working code samples in examples/
   4. Extend docs: Add detailed guides to references/
   5. Commit changes: git add .github/skills/your-skill-name && git commit
   6. Share: Push to repository for team use

💡 Pro Tips:
   - SPEC.md is your blueprint - update it as skill evolves
   - Keep SKILL.md under 2,000 words (currently: 1,847)
   - Move detailed content to references/ folder
   - Add executable scripts to scripts/ folder
   - Update README.md with real usage examples
   - Run validation before committing: scripts/validate-skill-yaml.sh
```

## Error Handling

### Platform Detection Issues

If platforms cannot be detected:
```
⚠️  Unable to detect GitHub Copilot CLI or Claude Code
    
Would you like to:
1. Install for repository only (works when in repo)
2. Specify platform manually
3. Skip installation
```

### Template Not Found

If templates are missing:
```
❌ Error: Template not found at resources/templates/

This skill requires the cli-ai-skills repository structure.

Options:
1. Clone cli-ai-skills: git clone <repo-url>
2. Create minimal skill structure manually
3. Exit and set up templates first
```

### Validation Failures

If content doesn't meet standards:
```
⚠️  Validation Issues Found:

1. YAML: Description not in third-person format
   Expected: "This skill should be used when..."
   Found: "Use this skill when..."
   
2. Content: Word count too high (5,342 words, max 5,000)
   Suggestion: Move detailed sections to references/

Fix automatically? [Y/n]
```

### Installation Conflicts

If symlink already exists:
```
⚠️  Skill already installed at ~/.copilot/skills/your-skill-name

Options:
1. Overwrite existing installation
2. Rename new skill
3. Skip installation
4. Install to different location
```

## Bundled Resources

This skill includes additional resources in subdirectories:

### references/

Detailed documentation loaded when needed:
- `anthropic-best-practices.md` - Official Anthropic skill development guidelines
- `writing-style-guide.md` - Writing standards and examples
- `progressive-disclosure.md` - Content organization patterns
- `validation-checklist.md` - Pre-commit quality checks

### examples/

Working examples demonstrating skill usage:
- `basic-skill-creation.md` - Simple skill creation walkthrough
- `advanced-skill-bundled-resources.md` - Complex skill with references/
- `global-installation.md` - Installing skills system-wide

### scripts/

Executable utilities for skill maintenance:
- `validate-all-skills.sh` - Batch validation of all skills in repository
- `update-skill-version.sh` - Bump version and update changelog
- `generate-skill-index.sh` - Auto-generate skills catalog

## Technical Implementation Notes

**Template Substitution:**
- Use `sed` for simple replacements
- Preserve YAML formatting exactly
- Handle multi-line descriptions with proper escaping

**Symlink Strategy:**
- Always use absolute paths: `ln -sf /full/path/to/source ~/.copilot/skills/name`
- Verify symlink before considering installation complete
- Benefits: Auto-updates when repository is pulled

**Validation Integration:**
- Run validation before installation
- Block installation if critical errors found
- Warnings are informational only

**Git Integration:**
- Extract author from `git config user.name`
- Use repository root detection: `git rev-parse --show-toplevel`
- Respect `.gitignore` patterns

## Quality Standards

**SKILL.md Requirements:**
- 1,500-2,000 words (ideal)
- Under 5,000 words (maximum)
- Third-person description format
- Imperative/infinitive writing style
- Progressive disclosure pattern

**README.md Requirements:**
- 300-500 words
- User-facing language
- Clear installation instructions
- Practical usage examples

**Validation Checks:**
- YAML frontmatter completeness
- Description format (third-person)
- Word count limits
- Writing style (no second-person)
- Required fields present

## References

- **Anthropic Official Skill Development Guide:** https://github.com/anthropics/claude-plugins-official/blob/main/plugins/plugin-dev/skills/skill-development/SKILL.md
- **Repository:** https://github.com/yourusername/cli-ai-skills
- **Writing Style Guide:** `resources/templates/writing-style-guide.md`
- **Progress Tracker Template:** `resources/templates/progress-tracker.md`
