# Contributing to Plugin Marketplace

Thank you for your interest in contributing to this plugin marketplace! This guide follows the [official Anthropic plugin marketplace guidelines](https://code.claude.com/docs/en/plugin-marketplaces).

## Before You Start

This marketplace follows Anthropic's official plugin structure. All plugins must:
- Include a `.claude-plugin/plugin.json` manifest
- Follow Claude Code plugin conventions
- Be properly documented
- Pass quality and security standards

## Plugin Types

Claude Code supports several plugin types:

1. **Skills**: Task-based capabilities accessed via `/` commands
2. **Commands**: Executable actions via `/run`
3. **Agents**: Autonomous helpers that work in background
4. **Hooks**: Event-triggered automations
5. **MCP Servers**: Model Context Protocol integrations

## Plugin Structure

### Required Structure

```
your-plugin/
├── .claude-plugin/
│   └── plugin.json          # Required manifest
├── skills/                   # For skills (optional)
│   └── skill-name/
│       └── SKILL.md
├── commands/                 # For commands (optional)
│   └── command-name/
│       └── COMMAND.md
├── mcp/                      # For MCP servers (optional)
│   └── server.js
└── README.md                 # Required documentation
```

### Required: plugin.json Manifest

Every plugin must have a `.claude-plugin/plugin.json` file:

```json
{
  "name": "your-plugin",
  "version": "1.0.0",
  "description": "Brief description of what your plugin does",
  "author": { "name": "Your Name" },
  "homepage": "https://github.com/username/your-plugin",
  "license": "MIT",
  "skills": "./skills/",
  "commands": "./commands/"
}
```

### Required Fields

- `name`: Unique plugin identifier (lowercase, hyphens only)
- `version`: Semantic version (e.g., "1.0.0")
- `description`: Clear, concise description
- `author`: Author object with `name` (required), `email` (optional), `url` (optional)

### Optional Fields

- `homepage`: Link to plugin repository or website
- `repository`: Repository URL
- `license`: License identifier (default: MIT)
- `keywords`: Array of keyword strings
- `skills`: Path to skills directory
- `commands`: Path to commands directory
- `agents`: Path to agents directory
- `hooks`: Path to hooks directory
- `mcpServers`: Path to MCP servers directory

## Submission Process

### 1. Fork and Clone

```bash
git clone https://github.com/your-username/marketplace.git
cd marketplace
git checkout -b add-my-plugin
```

### 2. Create Your Plugin

Create your plugin in the `plugins/` directory:

```bash
mkdir -p plugins/my-plugin/.claude-plugin
mkdir -p plugins/my-plugin/skills
# or mkdir -p plugins/my-plugin/commands
# or mkdir -p plugins/my-plugin/mcp
```

### 3. Add Required Files

- `.claude-plugin/plugin.json` - Plugin manifest (required)
- `README.md` - Documentation (required)
- Plugin implementation files (skills, commands, etc.)

### 4. Update Marketplace Catalog

Add your plugin to `.claude-plugin/marketplace.json`:

```json
{
  "plugins": [
    {
      "name": "my-plugin",
      "source": "./plugins/my-plugin",
      "description": "Brief description",
      "author": { "name": "Your Name" }
    }
  ]
}
```

### 5. Test Locally

Test your plugin with Claude Code:

```bash
/plugin marketplace add /path/to/marketplace
/plugin install my-plugin@agent-plugins
```

### 6. Submit Pull Request

```bash
git add .
git commit -m "Add my-plugin"
git push origin add-my-plugin
```

Open a pull request on GitHub with:
- Clear description of what your plugin does
- Screenshots or examples if applicable
- Any special installation or usage notes

## Validation Tools

This marketplace uses [Bun](https://bun.sh) for validation and listing scripts:

```bash
# Install Bun if not already installed
curl -fsSL https://bun.sh/install | bash

# Validate a plugin
bun run scripts/validate-plugin.ts <plugin-path>

# List all plugins
bun run scripts/list-plugins.ts
```

See [scripts/README.md](./scripts/README.md) for more details.

## Quality Standards

### Documentation

Your README.md must include:
- Clear description and purpose
- Installation instructions
- Usage examples
- Configuration options
- Troubleshooting tips

### Code Quality

- Follow consistent coding style
- Include error handling
- Add comments for complex logic
- Avoid hardcoded secrets or credentials
- Use meaningful variable and function names

### Testing

- Test your plugin locally before submitting
- Document how to test the plugin
- Include example usage scenarios
- Verify all capabilities work as expected

## Code of Conduct

- Be respectful and constructive in all interactions
- Help others and share knowledge
- Follow the repository's guidelines
- Report security issues responsibly

## Review Process

1. Pull requests are reviewed by maintainers
2. Feedback may be provided for improvements
3. Security and quality checks are performed
4. Once approved, your plugin will be merged
5. Your contribution will be credited in the repository

## Getting Help

If you need assistance:
- Open an issue for questions
- Review existing plugins for examples
- Check the [README](./README.md)
- Refer to [Official Claude Code Docs](https://code.claude.com/docs)

## Security

If you discover a security vulnerability:
- DO NOT open a public issue
- Contact the maintainers privately
- Provide detailed information about the vulnerability

Thank you for contributing to make this marketplace better!
