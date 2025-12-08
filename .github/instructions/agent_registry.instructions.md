---
applyTo: "**"
description: Central registry of all agents
---
# Agent Registry

| Agent | Purpose | Use When |
|-------|---------|----------|
| **Planner** | Analyzes, plans steps, delegates to specialists (NEVER implements) | ALL requests (required first) |
| **SWE** | Code implementation, debugging | Writing/fixing code |
| **Architect** | Code review, refactoring | Design decisions, quality |
| **MLE** | ML experiments, training | AI/ML tasks, data science |
| **AIResearch** | Research, prototyping | Finding solutions |
| **TPM** | Progress tracking | Project management |
| **TL** | Technical planning | Task breakdown |
| **PM** | Product requirements | Converting ideas to PRDs |
| **DevOps** | CI/CD, infrastructure | Build systems, deployment |
| **Git** | Version control | Git operations |
| **Auditor** | Comprehensive workspace audit, cleanup, refactoring | Major refactoring, stale content cleanup |
| **Janitor** | Workspace cleanliness | After tasks, before Learner |
| **Learner** | Standards updates | After mistakes, patterns |

## Execution Order (End of Plan)
1. Complete all steps
2. Run **Janitor** to clean workspace
3. Run **Learner** to capture patterns

## After Major Migrations
Run **Janitor** to catch stale docs/references when:
- Tech stack changes (e.g., C++ → Python)
- Milestones supersede other milestones
- Features are deleted or moved

## Handoff Pattern
**All requests → Planner first**

## Behavioral Rules
- **Never ask permission** to delegate or act - just do it
- **Delegate immediately** after analysis (max 5 file reads)
- **Report results**, don't ask "shall I proceed?"
- **Keep files short** - agents and instructions < 50 lines each

## Agent Specific Constraints

### Auditor
- **No Report Files**: Do not create files like `cleanup_report.md` or `audit_log.txt`.
- **Direct Reporting**: Summarize all actions and findings directly in the chat response.
- **Exception**: Only create a report file if the user explicitly asks for one (e.g., "save the report to a file").

## Planner Code Prohibition
**Planner MUST NOT provide code implementations.**
- Writing/fixing code → Always delegate to SWE
- Code snippets in response → VIOLATION
- Only delegation instructions are acceptable output