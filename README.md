# Tiny Tools Plugin Marketplace

A marketplace of tiny plugins intended to boost productivity for developers and anyone working with AI agents, following the official [Anthropic plugin marketplace guidelines](https://code.claude.com/docs/en/plugin-marketplaces).

## Quick Start

### Adding the Marketplace

Add this marketplace to your agent:

```bash
/plugin marketplace add https://github.com/tinytoolstown/marketplace
```

### Installing Plugins

Browse and install plugins from this marketplace:

```bash
/plugin                                    # Open plugin browser UI
/plugin list                               # List available plugins
/plugin install <plugin-name>@tinytoolstown-marketplace
```

## Managing Marketplaces

```bash
/plugin marketplace list              # List all registered marketplaces
/plugin marketplace update           # Update all marketplace catalogs
/plugin marketplace remove <name>    # Remove a marketplace
```

## Using Installed Plugins

Plugins extend your agent with new capabilities. Depending on the plugin type:

- **Skills**: Access via `/` commands (e.g., `/review`, `/analyze`)
- **Commands**: Run with `/run <command-name>`
- **Agents**: Autonomous helpers that work in the background
- **Hooks**: Automatic actions triggered by events
- **MCP Servers**: Model Context Protocol integrations

Check each plugin's documentation for specific usage instructions.

## Managing Installed Plugins

```bash
/plugin list --installed            # Show installed plugins
/plugin update <plugin-name>        # Update a plugin
/plugin uninstall <plugin-name>     # Remove a plugin
```

## Available Plugins

Currently, this marketplace contains no plugins. We're accepting contributions!

See the [Plugin Index](./PLUGIN_INDEX.md) for available plugins organized by category.

## Creating Your Own Plugin

Want to create a plugin for this marketplace?

1. **Choose a Plugin Type**: Skills, commands, agents, hooks, or MCP servers
2. **Create Plugin Structure**: Include `.claude-plugin/plugin.json` manifest
3. **Follow Guidelines**: See [CONTRIBUTING.md](./CONTRIBUTING.md) for requirements
4. **Test Locally**: Test your plugin before submitting
5. **Submit**: Open a pull request to add your plugin to this marketplace

### Basic Plugin Structure

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # Required manifest
├── skills/                   # For skill-based plugins
│   └── my-skill/
│       └── SKILL.md
├── commands/                 # For command-based plugins
│   └── my-command/
│       └── COMMAND.md
└── README.md                # Plugin documentation
```

### Sample plugin.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Brief description of what this plugin does",
  "author": "Your Name",
  "homepage": "https://github.com/username/my-plugin",
  "categories": ["development-tools"],
  "capabilities": {
    "skills": ["my-skill"],
    "commands": ["my-command"]
  }
}
```

## Plugin Categories

- **development-tools**: Code analysis, formatting, linting, and development utilities
- **productivity**: Task automation, note-taking, and workflow optimization
- **web-tools**: Web scraping, HTTP requests, and browser automation
- **data-tools**: Data processing, transformation, and analysis
- **testing**: Testing frameworks, test generation, and quality assurance
- **security**: Security scanning, vulnerability detection, and compliance

## Development

This marketplace uses [Bun](https://bun.sh) for TypeScript scripts. To work with the validation and listing tools:

```bash
# Install Bun if not already installed
curl -fsSL https://bun.sh/install | bash

# Validate a plugin
bun run scripts/validate-plugin.ts <plugin-path>

# List all plugins
bun run scripts/list-plugins.ts
```

See [scripts/README.md](./scripts/README.md) for more details.

## Troubleshooting

### Marketplace Not Loading

- Ensure you have a compatible agent installed and running
- Check your internet connection
- Verify the marketplace URL is correct
- Try running `/plugin marketplace update`

### Plugin Installation Fails

- Check plugin compatibility with your agent version
- Review plugin dependencies and requirements
- Check the plugin's README for specific installation notes
- Ensure you're using the correct marketplace name

### Plugin Not Working

- Verify the plugin is installed: `/plugin list --installed`
- Check the plugin's documentation for usage instructions
- Look for error messages in your agent's output
- Try reinstalling: `/plugin uninstall <name>` then `/plugin install <name>`

## Support

For issues or questions:
- Open an issue in this repository
- Check the [official Claude Code documentation](https://code.claude.com/docs)

## License

MIT License - see [LICENSE](LICENSE) for details.
