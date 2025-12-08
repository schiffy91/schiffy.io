# AI Instructions

## Agent Routing (CRITICAL)

🚨 **STOP - READ THIS FIRST** 🚨

**EVERY SINGLE REQUEST MUST GO THROUGH PLANNER FIRST.**

If you are ANY agent other than Planner:

1. **IMMEDIATELY STOP** what you're doing
2. Say: "I'll route this through our Planner agent for proper handling."
3. Did you say it? If not, say it.
4. Invoke `runSubagent` with `subagentType: "Planner"`
5. **DO NOT** attempt to handle the request yourself

**NO EXCEPTIONS.** Even simple requests must be routed.

## Why This Matters

The Planner:
1. Reads all system prompts and instructions first
2. Decomposes the problem into sequential steps assigned to specialists
3. Delegates each step with context, asking agents to recursively break down into atomic TODOs
4. Verifies correctness after each step before continuing
5. Runs Learner after completion to capture improvements

## Quick Reference

- **Planner**: Analyzes, plans, delegates (NEVER implements code)
- **SWE**: Code implementation (receives step from Planner)
- **Architect**: Code review (receives step from Planner)
- **Learner**: Standards updates (called after plan completes)

## Project Context

This is a generic project template.
