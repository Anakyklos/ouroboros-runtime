# Plan: RE-01 Auto-Claude Reconnaissance and Dissection

## Phase 1: Initialization
- [ ] Task: Create initial reverse engineering artifacts in `Auto-Claude` (ANALYSIS.md, STATUS.md, _extracted/MANIFEST.md)
    - [ ] Create `Auto-Claude/ANALYSIS.md` template
    - [ ] Create `Auto-Claude/STATUS.md` template
    - [ ] Create `Auto-Claude/_extracted/MANIFEST.md`
- [ ] Task: Register repository in `CATALOG.md`
    - [ ] Add `Auto-Claude` entry to `CATALOG.md` with status `RECON`
- [ ] Task: Conductor - User Manual Verification 'Initialization' (Protocol in workflow.md)

## Phase 2: Reconnaissance (RECON)
- [ ] Task: Analyze file structure and update `ANALYSIS.md`
    - [ ] List all files recursively (`find . -maxdepth 3 -not -path '*/.*'`)
    - [ ] Update `ANALYSIS.md` with directory tree
- [ ] Task: Analyze dependencies and update `ANALYSIS.md`
    - [ ] Read `package.json`, `requirements.txt`, `pyproject.toml` (if present)
    - [ ] Identify critical dependencies
    - [ ] Update `ANALYSIS.md` with Tech Stack details
- [ ] Task: Identify entrypoints and update `ANALYSIS.md`
    - [ ] Locate main entry scripts (e.g., `main.py`, `index.js`, `app.py`)
    - [ ] Update `ANALYSIS.md` with Entrypoints
- [ ] Task: Update `STATUS.md` to reflect RECON completion and transition to DISSECT
- [ ] Task: Conductor - User Manual Verification 'Reconnaissance' (Protocol in workflow.md)

## Phase 3: Dissection (DISSECT)
- [ ] Task: Analyze data flow and update `ANALYSIS.md`
    - [ ] Trace execution flow from entrypoints
    - [ ] Create Mermaid diagram or textual description of data flow in `ANALYSIS.md`
- [ ] Task: Identify core abstractions and update `ANALYSIS.md`
    - [ ] List key classes, interfaces, and types
    - [ ] Update `ANALYSIS.md` with Core Abstractions
- [ ] Task: Identify "Diamond" modules (reusable components) and update `ANALYSIS.md`
    - [ ] Identify high-value modules for extraction
    - [ ] Update `ANALYSIS.md` with Critical Modules list
- [ ] Task: Extract prompts (if any) and update `ANALYSIS.md`
    - [ ] Search for system prompts or agent instructions
    - [ ] Document findings in `ANALYSIS.md`
- [ ] Task: Update `STATUS.md` to reflect DISSECT progress
- [ ] Task: Conductor - User Manual Verification 'Dissection' (Protocol in workflow.md)
