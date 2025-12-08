---
description: Agent file verification checklist
name: Agent-Verification-Standards
applyTo: "**/*.agent.md"
---
# Agent Verification Standards

**CRITICAL**: Before modifying ANY agent file, read `.github/instructions/vscode_customization_reference.instructions.md`

## Verification Checklist

For each `.agent.md` file, verify:

### YAML Frontmatter
- [ ] Valid YAML frontmatter with `---` delimiters
- [ ] Required `description` field
- [ ] Required `name` field  
- [ ] `tools` field uses array format: `["tool1", "tool2"]`
- [ ] `handoffs` has proper `label`, `agent`, `prompt`, `send` structure

### File Structure
- [ ] File extension is `.agent.md`
- [ ] Located in `.github/agents/` directory
- [ ] Filename matches agent purpose

### Tool References
- [ ] All tools in `tools` array exist and are valid
- [ ] Tool references in body use `#tool:<tool-name>` syntax
- [ ] No references to non-existent tools

### Content Quality
- [ ] Clear, focused instructions
- [ ] Well-defined role and responsibilities
- [ ] No conflicting instructions
- [ ] Proper Markdown links to shared instructions