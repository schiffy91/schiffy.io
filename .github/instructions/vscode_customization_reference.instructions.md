---
applyTo: "**/*.agent.md,**/*.prompt.md,**/*.instructions.md"
---
# VS Code Customization Reference

This document contains the official VS Code documentation for creating custom instructions, prompts, and agents. Use this as a reference when creating or modifying any .agent.md, .prompt.md, or .instructions.md files.

## Custom Instructions (.instructions.md)

### File Structure
- Header: YAML frontmatter with `description`, `name`, `applyTo` fields
- Body: Markdown instructions

### applyTo Patterns
- `**/*.py` - Apply to all Python files
- `**/*.cpp` - Apply to all C++ files
- `**` - Apply to all files

### Example

```markdown
---
applyTo: "**/*.ts"
---
# TypeScript Coding Guidelines

- Use interfaces over type aliases for object shapes
- Prefer `unknown` over `any`
- Always specify explicit return types for functions
```

### Automatic vs Manual Application
- Instructions with `applyTo` are automatically included when working with matching files
- Instructions without `applyTo` must be manually referenced via `#` in chat or Markdown links

### Location
- `.github/instructions/` - Shared across the team (committed to repo)
- `.vscode/` - Local workspace instructions

## Prompt Files (.prompt.md)

### File Structure
- Header: YAML frontmatter with `description`, `name`, `argument-hint`, `agent`, `model`, `tools` fields
- Body: Prompt text with Markdown formatting

### Frontmatter Fields
| Field | Description |
|-------|-------------|
| `description` | Short description shown in chat completions |
| `name` | Display name for the prompt |
| `argument-hint` | Placeholder text for argument input |
| `agent` | Default agent to run the prompt with |
| `model` | Language model to use |
| `tools` | List of tools the prompt can access |

### Tools Field
- Can specify built-in tools, tool sets, MCP tools
- Use `<server name>/*` for all MCP server tools
- Example: `tools: ["github/*", "codebase"]`

### Variables
| Variable | Description |
|----------|-------------|
| `${workspaceFolder}` | Path to the workspace root |
| `${selection}` | Currently selected text in editor |
| `${file}` | Current file path |
| `${input:variableName}` | Prompt user for input |
| File references | Use hash-file syntax to reference files |

### Example

```markdown
---
description: Generate unit tests for the selected code
name: Generate Tests
argument-hint: Describe specific test scenarios
model: copilot-gpt-4
tools:
  - codebase
  - terminal
---
# Test Generation Prompt

Generate comprehensive unit tests for the following code:

${selection}

Requirements:
- Use the project's existing test framework
- Include edge cases and error scenarios
- Follow existing test patterns in the codebase
```

### Invoking Prompts
- Type `/` in chat followed by prompt name
- Or use `Ctrl+/` to open prompt picker

## Custom Agents (.agent.md)

### File Structure
- Header: YAML frontmatter with `description`, `name`, `argument-hint`, `tools`, `model`, `handoffs` fields
- Body: Agent instructions in Markdown

### Frontmatter Fields
| Field | Description |
|-------|-------------|
| `description` | Short description shown in agent picker |
| `name` | Display name for the agent |
| `argument-hint` | Placeholder text when agent is selected |
| `tools` | List of tools the agent can use |
| `model` | Language model to use |
| `handoffs` | Array of other agents this agent can delegate to |

### Handoffs
Enable guided workflows between agents:

| Field | Description |
|-------|-------------|
| `label` | Display label for the handoff |
| `agent` | Target agent ID |
| `prompt` | Optional context to pass to target agent |
| `send` | Boolean - if true, sends immediately without user confirmation |

### Example

```markdown
---
description: Expert in code review and best practices
name: Code Reviewer
argument-hint: Paste code or describe what to review
tools:
  - codebase
  - problems
model: copilot-gpt-4
handoffs:
  - label: Fix Issues
    agent: workspace
    prompt: Fix the issues identified in the code review
    send: false
---
# Code Review Agent

You are an expert code reviewer. When reviewing code:

1. Check for bugs, security issues, and performance problems
2. Verify adherence to project coding standards
3. Suggest improvements for readability and maintainability
4. Reference existing patterns in the codebase

Always explain your reasoning and provide specific line references.
```

### Invoking Agents
- Type `@` in chat followed by agent name
- Or mention the agent inline: `@code-reviewer check this function`

## Best Practices

### General Guidelines
1. Keep instructions short and self-contained
2. Use multiple .instructions.md files for different tasks
3. Reuse instructions files in prompts and agents via Markdown links
4. Store project-specific instructions in workspace
5. Use the applyTo property for automatic application

### Instructions Best Practices
- One topic per instruction file
- Use clear, imperative language
- Include examples when helpful
- Scope with `applyTo` to relevant file types

### Prompt Best Practices
- Make prompts reusable with variables
- Specify tools needed for the task
- Include context about expected output format
- Use `${input:name}` for user-configurable parts

### Agent Best Practices
- Give agents focused responsibilities
- Define clear handoff paths between agents
- Include domain expertise in system instructions
- Specify minimum required tools only

### File Organization
```
.github/
└── instructions/
    ├── coding_standards.instructions.md
    ├── domain_context.instructions.md
    └── prompts/
        ├── review.prompt.md
        └── refactor.prompt.md
    └── agents/
        ├── reviewer.agent.md
        └── architect.agent.md
```

### Referencing Other Files
Use Markdown links to include shared instructions:

```markdown
# My Agent

Follow the guidelines in:
- `[Coding Standards](coding_standards.instructions.md)`
```

## Tool Reference

### Built-in Tools
| Tool | Description |
|------|-------------|
| `runCommands` | Run commands in the terminal |
| `runTasks` | Run VS Code tasks |
| `edit` | Edit file contents |
| `runNotebooks` | Run Jupyter notebooks |
| `search` | Search files in the workspace |
| `new` | Create new files |
| `extensions` | Manage VS Code extensions |
| `todos` | Manage todo list for task tracking |
| `runSubagent` | Launch subagents for complex tasks |
| `usages` | Find symbol usages and references |
| `vscodeAPI` | Access VS Code API |
| `problems` | Access VS Code problems/diagnostics panel |
| `changes` | View git changes and diffs |
| `testFailure` | Access test failure information |
| `openSimpleBrowser` | Open URLs in simple browser |
| `fetch` | Fetch URLs and web content |
| `githubRepo` | Access GitHub repository information |

### MCP Tools
Reference MCP server tools with `<server-name>/<tool-name>` or `<server-name>/*` for all tools from a server.

# RAW Documentation
Custom agents in VS Code
Custom agents enable you to configure the AI to adopt different personas tailored to specific development roles and tasks. For example, you might create agents for a security reviewer, planner, solution architect, or other specialized roles. Each persona can have its own behavior, available tools, and instructions.

You can also use handoffs to create guided workflows between agents, allowing you to transition seamlessly from one specialized agent to another with a single click. For example, you could move from planning agent directly into implementation agent, or hand off to a code reviewer with the relevant context.

This article describes how to create and manage custom agents in VS Code.

Note
Custom agents are available as of VS Code release 1.106. Custom agents were previously known as custom chat modes.

What are custom agents?
The built-in agents provide general-purpose configurations for chat in VS Code. For a more tailored chat experience, you can create your own custom agents.

Custom agents consist of a set of instructions and tools that are applied when you switch to that agent. For example, a "Plan" agent could include instructions for generating an implementation plan and only use read-only tools. By creating a custom agent, you can quickly switch to that specific configuration without having to manually select relevant tools and instructions each time.

Custom agents are defined in a .agent.md Markdown file, and can be stored in your workspace for others to use, or in your user profile, where you can reuse them across different workspaces.

Why use custom agents?
Different tasks require different capabilities. A planning agent might only need read-only tools for research and analysis to prevent accidental code changes, while an implementation agent would need full editing capabilities. Custom agents let you specify exactly which tools are available for each task, ensuring the AI has the right capabilities for the job.

Custom agents also let you provide specialized instructions that define how the AI should operate. For instance, a planning agent could instruct the AI to collect project context and generate a detailed implementation plan, while a code review agent might focus on identifying security vulnerabilities and suggesting improvements. These specialized instructions ensure consistent, task-appropriate responses every time you switch to that agent.

Note
Subagents can run with a custom agent. Learn more about running subagents with custom agents (experimental).

Handoffs
Handoffs enable you to create guided sequential workflows that transition between agents with suggested next steps. After a chat response completes, handoff buttons appear that let users move to the next agent with relevant context and a pre-filled prompt.

Handoffs are useful for orchestrating multi-step workflows, that give developer's control for reviewing and approving each step before moving to the next one. For example:

Planning → Implementation: Generate a plan in planning agent, then hand off to implementation agent to start coding.
Implementation → Review: Complete implementation, then switch to a code review agent to check for quality and security issues.
Write Failing Tests → Write Passing Tests: Generate failing tests that are easier to review than big implementations, then hand off to make those tests pass by implementing the required code changes.
To define handoffs in your agent file, add them to the frontmatter. Each handoff specifies the target agent, the button label, and an optional prompt to send:

Markdown

description: Generate an implementation plan
tools: ['search', 'fetch']
handoffs:

label: Start Implementation
agent: implementation
prompt: Now implement the plan outlined above.
send: false
When users see the handoff button and select it, they switch to the target agent with the prompt pre-filled. If send: true, the prompt automatically submits to start the next workflow step.

Custom agent file structure
Custom agent files are Markdown files and use the .agent.md extension and have the following structure.

Note
VS Code detects any .md files in the .github/agents folder of your workspace as custom agents.

Header (optional)
The header is formatted as YAML frontmatter with the following fields:

Expand table
Field Description
description A brief description of the custom agent, shown as placeholder text in the chat input field.
name The name of the custom agent. If not specified, the file name is used.
argument-hint Optional hint text shown in the chat input field to guide users on how to interact with the custom agent.
tools A list of tool or tool set names that are available for this custom agent. Can include built-in tools, tool sets, MCP tools, or tools contributed by extensions. To include all tools of an MCP server, use the <server name>/* format.
Learn more about tools in chat.
model The AI model to use when running the prompt. If not specified, the currently selected model in model picker is used.
target The target environment or context for the custom agent (vscode or github-copilot).
mcp-servers Optional list of Model Context Protocol (MCP) server config json to use with custom agents in GitHub Copilot (target: github-copilot).
handoffs Optional list of suggested next actions or prompts to transition between custom agents. Handoff buttons appear as interactive suggestions after a chat response completes.
handoffs.label The display text shown on the handoff button.
handoffs.agent The target agent identifier to switch to.
handoffs.prompt The prompt text to send to the target agent.
handoffs.send Optional boolean flag to auto-submit the prompt (default is false)
Note
If a given tool is not available when using the custom agent, it is ignored.

Body
The custom agent file body contains the custom agent implementation, formatted as Markdown. This is where you provide specific prompts, guidelines, or any other relevant information that you want the AI to follow when in this custom agent.

You can reference other files by using Markdown links, for example to reuse instructions files.

To reference agent tools in the body text, use the #tool:<tool-name> syntax. For example, to reference the githubRepo tool, use `#tool:githubRepo`.

When you select the custom agent in the Chat view, the guidelines in the custom agent file body are prepended to the user chat prompt.

Custom agent example
The following code snippet shows an example of a "Plan" custom agent file that generates an implementation plan and doesn't make any code edits. For more community-contributed examples, see the Awesome Copilot repository.

Markdown

description: Generate an implementation plan for new features or refactoring existing code.
name: Planner
tools: ['fetch', 'githubRepo', 'search', 'usages']
model: Claude Sonnet 4
handoffs:

label: Implement Plan
agent: agent
prompt: Implement the plan outlined above.
send: false
Planning instructions
You are in planning mode. Your task is to generate an implementation plan for a new feature or for refactoring existing code.
Don't make any code edits, just generate a plan.

The plan consists of a Markdown document that describes the implementation plan, including the following sections:

Overview: A brief description of the feature or refactoring task.
Requirements: A list of requirements for the feature or refactoring task.
Implementation Steps: A detailed list of steps to implement the feature or refactoring task.
Testing: A list of tests that need to be implemented to verify the feature or refactoring task.
Create a custom agent
You can create a custom agent file in your workspace or user profile.
Select Configure Custom Agents from the agents dropdown and then select Create new custom agent or run the Chat: New Custom Agent command in the Command Palette (⇧⌘P).

Choose the location where the custom agent file should be created.

Workspace: create the custom agent definition file in the .github/agents folder of your workspace to only use it within that workspace

User profile: create the custom agent definition file in the current profile folder to use it across all your workspaces

Enter a file name for the custom agent. This is the default name that appears in the agents dropdown.

Provide the details for the custom agent in the newly created .agent.md file.

Fill in the YAML frontmatter at the top of the file to configure the custom agent's name, description, tools, and other settings.
Add instructions for the custom agent in the body of the file.
To update a custom agent definition file, select Configure Custom Agents from the agents dropdown, and then select a custom agent from the list to modify it.

Note
If you've previously created custom chat modes with a .chatmode.md extension in the .github/chatmodes folder of your workspace, VS Code still recognizes those files as custom agents. You can use a Quick Fix action to rename and move them to the new .github/agents folder with a .agent.md extension.

Customize the agents dropdown list
If you have multiple custom agents, you can customize which ones appear in the agents dropdown. To show or hide specific custom agents:

Select Configure Custom Agents from the agents dropdown.

Hover over a custom agent in the list, and then select the eye icon to show or hide it from the agents dropdown.

Tool list priority
You can specify the list of available tools for both a custom agent and prompt file by using the tools metadata field. Prompt files can also reference a custom agent by using the agent metadata field.

The list of available tools in chat is determined by the following priority order:

Tools specified in the prompt file (if any)
Tools from the referenced custom agent in the prompt file (if any)
Default tools for the selected agent (if any)
Frequently asked questions
Are custom agents different from chat modes?
Custom agents were previously known as custom chat modes. The functionality remains the same, but the terminology has been updated to better reflect their purpose in customizing AI behavior for specific tasks.

VS Code still recognizes any existing .chatmode.md files as custom agents. You can use a Quick Fix action to rename and move them to the new .github/agents folder with a .agent.md extension.

Use prompt files in VS Code
Prompt files are Markdown files that define reusable prompts for common development tasks like generating code, performing code reviews, or scaffolding project components. They are standalone prompts that you can run directly in chat, enabling the creation of a library of standardized development workflows.

They can include task-specific guidelines or reference custom instructions to ensure consistent execution. Unlike custom instructions that apply to all requests, prompt files are triggered on-demand for specific tasks.

VS Code supports two types of scopes for prompt files:

Workspace prompt files: Are only available within the workspace and are stored in the .github/prompts folder of the workspace.
User prompt files: Are available across multiple workspaces and are stored in the current VS Code profile.
Prompt file structure
Prompt files are Markdown files and use the .prompt.md extension and have this structure:

Header (optional)
The header is formatted as YAML frontmatter with the following fields:

Expand table
Field Description
description A short description of the prompt.
name The name of the prompt, used after typing / in chat. If not specified, the file name is used.
argument-hint Optional hint text shown in the chat input field to guide users on how to interact with the prompt.
agent The agent used for running the prompt: ask, edit, agent (default), or the name of a custom agent.
model The language model used when running the prompt. If not specified, the currently selected model in model picker is used.
tools A list of tool or tool set names that are available for this prompt. Can include built-in tools, tool sets, MCP tools, or tools contributed by extensions. To include all tools of an MCP server, use the <server name>/* format.
Learn more about tools in chat.
Note
If a given tool is not available when running the prompt, it is ignored.

Body
The prompt file body contains the prompt text that is sent to the LLM when running the prompt in chat. Provide specific instructions, guidelines, or any other relevant information that you want the AI to follow.

You can reference other workspace files by using Markdown links. Use relative paths to reference these files, and ensure that the paths are correct based on the location of the prompt file.

To reference agent tools in the body text, use the #tool:<tool-name> syntax. For example, to reference the githubRepo tool, use `#tool:githubRepo`.

Within a prompt file, you can reference variables by using the ${variableName} syntax. You can reference the following variables:

Workspace variables - 
workspaceFolder,
workspaceFolder,{workspaceFolderBasename}
Selection variables - selection,
selection,{selectedText}
File context variables - file,
file,{fileBasename}, fileDirname,
fileDirname,{fileBasenameNoExtension}
Input variables - input:variableName,
input:variableName,{input:variableName:placeholder} (pass values to the prompt from the chat input field)
Prompt file examples
The following examples demonstrate how to use prompt files. For more community-contributed examples, see the Awesome Copilot repository.

Example: generate a React form component
Example: perform a security review of a REST API
Create a prompt file
When you create a prompt file, choose whether to store it in your workspace or user profile. Workspace prompt files apply only to that workspace, while user prompt files are available across multiple workspaces.

To create a prompt file:

Enable the chat.promptFiles setting.

In the Chat view, select Configure Chat (gear icon) > Prompt Files, and then select New prompt file.

Screenshot showing the Chat view, and Configure Chat menu, highlighting the Configure Chat button.

Alternatively, use the Chat: New Prompt File command from the Command Palette (⇧⌘P).

Choose the location where the prompt file should be created.

Workspace: create the prompt file in the .github/prompts folder of your workspace to only use it within that workspace. Add more prompt folders for your workspace with the chat.promptFilesLocations setting.

User profile: create the prompt file in the current profile folder to use it across all your workspaces.

Enter a file name for your prompt file. This is the default name that appears when you type / in chat.

Author the chat prompt by using Markdown formatting.

Fill in the YAML frontmatter at the top of the file to configure the prompt's description, agent, tools, and other settings.
Add instructions for the prompt in the body of the file.
To modify an existing prompt file, in the Chat view, select Configure Chat > Prompt Files, and then select a prompt file from the list. Alternatively, use the Chat: Configure Prompt Files command from the Command Palette (⇧⌘P) and select the prompt file from the Quick Pick.

Use a prompt file in chat
You have multiple options to run a prompt file:

In the Chat view, type / followed by the prompt name in the chat input field.

You can add extra information in the chat input field. For example, /create-react-form formName=MyForm or /create-api for listing customers.

Run the Chat: Run Prompt command from the Command Palette (⇧⌘P) and select a prompt file from the Quick Pick.

Open the prompt file in the editor, and press the play button in the editor title area. You can choose to run the prompt in the current chat session or open a new chat session.

This option is useful for quickly testing and iterating on your prompt files.

Tip
Use the chat.promptFilesRecommendations setting to show prompts as recommended actions when starting a new chat session.

Screenshot showing an "explain" prompt file recommendation in the Chat view.

Tool list priority
You can specify the list of available tools for both a custom agent and prompt file by using the tools metadata field. Prompt files can also reference a custom agent by using the agent metadata field.

The list of available tools in chat is determined by the following priority order:

Tools specified in the prompt file (if any)
Tools from the referenced custom agent in the prompt file (if any)
Default tools for the selected agent (if any)
Sync user prompt files across devices
VS Code can sync your user prompt files across multiple devices by using Settings Sync.

To sync your user prompt files, enable Settings Sync for prompt and instruction files:

Make sure you have Settings Sync enabled.

Run Settings Sync: Configure from the Command Palette (⇧⌘P).

Select Prompts and Instructions from the list of settings to sync.

Tips for defining prompt files
Clearly describe what the prompt should accomplish and what output format is expected.

Provide examples of the expected input and output to guide the AI's responses.

Use Markdown links to reference custom instructions rather than duplicating guidelines in each prompt.

Take advantage of built-in variables like ${selection} and input variables to make prompts more flexible.

Use the editor play button to test your prompts and refine them based on the results.

Use custom instructions in VS Code
Custom instructions enable you to define common guidelines and rules that automatically influence how AI generates code and handles other development tasks. Instead of manually including context in every chat prompt, specify custom instructions in a Markdown file to ensure consistent AI responses that align with your coding practices and project requirements.

You can configure custom instructions to apply automatically to all chat requests or to specific files only. Alternatively, you can manually attach custom instructions to a specific chat prompt.

Note
Custom instructions are not taken into account for inline suggestions as you type in the editor.

Type of instructions files
VS Code supports multiple types of Markdown-based instructions files. If you have multiple types of instructions files in your project, VS Code combines and adds them to the chat context, no specific order is guaranteed.

A single .github/copilot-instructions.md file

Automatically applies to all chat requests in the workspace
Stored within the workspace
One or more .instructions.md files

Conditionally apply instructions based on file type or location by using glob patterns
Stored in the workspace or user profile
One or more AGENTS.md files

Useful if you work with multiple AI agents in your workspace
Automatically applies to all chat requests in the workspace or to specific subfolders (experimental)
Stored in the root of the workspace or in subfolders (experimental)
Whitespace between instructions is ignored, so the instructions can be written as a single paragraph, each on a new line, or separated by blank lines for legibility.

To reference specific context in your instructions, such as files or URLs, you can use Markdown links.

Custom instructions examples
The following examples demonstrate how to use custom instructions. For more community-contributed examples, see the Awesome Copilot repository.

Example: General coding guidelines
Example: Language-specific coding guidelines
Example: Documentation writing guidelines
Use a .github/copilot-instructions.md file
Define your custom instructions in a single .github/copilot-instructions.md Markdown file in the root of your workspace. VS Code applies the instructions in this file automatically to all chat requests within this workspace.

To use a .github/copilot-instructions.md file:

Enable the github.copilot.chat.codeGeneration.useInstructionFiles setting.

Create a .github/copilot-instructions.md file at the root of your workspace. If needed, create a .github directory first.

Describe your instructions by using natural language and in Markdown format.

Note
GitHub Copilot in Visual Studio and GitHub.com also detect the .github/copilot-instructions.md file. If you have a workspace that you use in both VS Code and Visual Studio, you can use the same file to define custom instructions for both editors.

Use .instructions.md files
Instead of using a single instructions file that applies to all chat requests, you can create multiple .instructions.md files that apply to specific file types or tasks. For example, you can create instructions files for different programming languages, frameworks, or project types.

By using the applyTo frontmatter property in the instructions file header, you can specify a glob pattern to define which files the instructions should be applied to automatically. Instructions files are used when creating or modifying files and are typically not applied for read operations.

Alternatively, you can manually attach an instructions file to a specific chat prompt by using the Add Context > Instructions option in the Chat view.

Workspace instructions files: are only available within the workspace and are stored in the .github/instructions folder of the workspace.
User instructions files: are available across multiple workspaces and are stored in the current VS Code profile.
Instructions file format
Instructions files are Markdown files and use the .instructions.md extension and have this structure:

Header (optional)
The header is formatted as YAML frontmatter with the following fields:

Expand table
Field Description
description A short description of the instructions file.
name The name of the instructions file, used in the UI. If not specified, the file name is used.
applyTo Optional glob pattern that defines which files the instructions should be applied to automatically, relative to the workspace root. Use ** to apply to all files. If no value is specified, the instructions are not applied automatically - you can still add them manually to a chat request.
Body
The instructions file body contains the custom instructions that are sent to the LLM when the instructions are applied. Provide specific guidelines, rules, or any other relevant information that you want the AI to follow.

To reference agent tools in the body text, use the #tool:<tool-name> syntax. For example, to reference the githubRepo tool, use `#tool:githubRepo`.

Example:

Markdown

applyTo: "**/*.py"
Project coding standards for Python
Follow the PEP 8 style guide for Python.
Always prioritize readability and clarity.
Write clear and concise comments for each function.
Ensure functions have descriptive names and include type hints.
Maintain proper indentation (use 4 spaces for each level of indentation).
Create an instructions file
When you create an instructions file, choose whether to store it in your workspace or user profile. Workspace instructions files apply only to that workspace, while user instructions files are available across multiple workspaces.
To create an instructions file:

In the Chat view, select Configure Chat (gear icon) > Chat Instructions, and then select New instruction file.

Screenshot showing the Chat view, and Configure Chat menu, highlighting the Configure Chat button.

Alternatively, use the Chat: New Instructions File command from the Command Palette (⇧⌘P).

Choose the location where to create the instructions file.

Workspace: create the instructions file in the .github/instructions folder of your workspace to only use it within that workspace. Add more instruction folders for your workspace with the chat.instructionsFilesLocations setting.

User profile: create the instructions files in the current profile folder to use it across all your workspaces.

Enter a file name for your instructions file. This is the default name that is used in the UI.

Author the custom instructions by using Markdown formatting.

Fill in the YAML frontmatter at the top of the file to configure the instructions' description, name, and when they apply.
Add instructions in the body of the file.
To modify an existing instructions file, in the Chat view, select Configure Chat (gear icon) > Chat Instructions, and then select an instructions file from the list. Alternatively, use the Chat: Configure Instructions command from the Command Palette (⇧⌘P) and select the instructions file from the Quick Pick.

Use an AGENTS.md file
If you work with multiple AI agents in your workspace, you can define custom instructions for all agents in an AGENTS.md Markdown file at the root(s) of the workspace. VS Code applies the instructions in this file automatically to all chat requests within this workspace.

To enable or disable support for AGENTS.md files, configure the chat.useAgentsMdFile setting.

Use multiple AGENTS.md files (experimental)
Using multiple AGENTS.md files in subfolders is useful if you want to apply different instructions to different parts of your project. For example, you can have one AGENTS.md file for the frontend code and another for the backend code.

Use the experimental chat.useNestedAgentsMdFiles setting to enable or disable support for nested AGENTS.md files in your workspace.

When enabled, VS Code searches recursively in all subfolders of your workspace for AGENTS.md files and adds their relative path to the chat context. The agent can then decide which instructions to use based on the files being edited.

Tip
For folder-specific instructions, you can also use multiple .instructions.md files with different applyTo patterns that match the folder structure.

Specify custom instructions in settings
You can configure custom instructions for specialized scenarios by using VS Code user or workspace settings.

Expand table
Type of instruction Setting name
Code review github.copilot.chat.reviewSelection.instructions
Commit message generation github.copilot.chat.commitMessageGeneration.instructions
Pull request title and description generation github.copilot.chat.pullRequestDescriptionGeneration.instructions
Code generation (deprecated)* github.copilot.chat.codeGeneration.instructions
Test generation (deprecated)* github.copilot.chat.testGeneration.instructions

The codeGeneration and testGeneration settings are deprecated as of VS Code 1.102. We recommend that you use instructions files instead (.github/copilot-instructions.md or *.instructions.md).
You can define the custom instructions as text in the settings value (text property) or reference an external file (file property) in your workspace.

The following code snippet shows how to define a set of instructions in the settings.json file.

JSON

{
"github.copilot.chat.pullRequestDescriptionGeneration.instructions": [
{ "text": "Always include a list of key changes." }
],
"github.copilot.chat.reviewSelection.instructions": [
{ "file": "guidance/backend-review-guidelines.md" },
{ "file": "guidance/frontend-review-guidelines.md" }
]
}
Generate an instructions file for your workspace
VS Code can analyze your workspace and generate a matching .github/copilot-instructions.md file with custom instructions that match your coding practices and project structure.

To generate an instructions file for your workspace:

In the Chat view, select Configure Chat (gear icon) > Generate Chat Instructions.

Review the generated instructions file and make any necessary edits.

Sync user instructions files across devices
VS Code can sync your user instructions files across multiple devices by using Settings Sync.

To sync your user instructions files, enable Settings Sync for prompt and instruction files:

Make sure you have Settings Sync enabled.

Run Settings Sync: Configure from the Command Palette (⇧⌘P).

Select Prompts and Instructions from the list of settings to sync.

Tips for defining custom instructions
Keep your instructions short and self-contained. Each instruction should be a single, simple statement. If you need to provide multiple pieces of information, use multiple instructions.

For task or language-specific instructions, use multiple *.instructions.md files per topic and apply them selectively by using the applyTo property.

Store project-specific instructions in your workspace to share them with other team members and include them in your version control.

Reuse and reference instructions files in your prompt files and custom agents to keep them clean and focused, and to avoid duplicating instructions.