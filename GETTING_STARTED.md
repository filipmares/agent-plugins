# Getting Started with Plugin Marketplace

This guide will help you use the tinytoolstown plugin marketplace with Claude Code.

## What is Claude Code?

Claude Code is Anthropic's AI coding assistant that can be extended with plugins. Plugins add new commands, skills, agents, hooks, and MCP servers to enhance your development workflow.

## Adding This Marketplace

To add this marketplace to your Claude Code installation:

```bash
/plugin marketplace add https://github.com/tinytoolstown/marketplace
```

This command registers the marketplace, making all its plugins available for installation.

## Managing Marketplaces

```bash
/plugin marketplace list              # List all registered marketplaces
/plugin marketplace update           # Update all marketplace catalogs
/plugin marketplace remove <name>    # Remove a marketplace
```

## Installing Plugins

Once you've added the marketplace, you can browse and install plugins:

```bash
/plugin                              # Open plugin browser UI
/plugin list                         # List available plugins
/plugin install <plugin-name>@tinytoolstown-marketplace
```

## Using Installed Plugins

Plugins extend Claude Code with new capabilities. Depending on the plugin type:

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

## Troubleshooting

### Marketplace Not Loading

- Ensure you have Claude Code installed and running
- Check your internet connection
- Verify the marketplace URL is correct
- Try running `/plugin marketplace update`

### Plugin Installation Fails

- Check plugin compatibility with your Claude Code version
- Review plugin dependencies and requirements
- Check the plugin's README for specific installation notes
- Ensure you're using the correct marketplace name

### Plugin Not Working

- Verify the plugin is installed: `/plugin list --installed`
- Check the plugin's documentation for usage instructions
- Look for error messages in Claude Code's output
- Try reinstalling: `/plugin uninstall <name>` then `/plugin install <name>`

## Getting Help

Need assistance?

1. **Check Documentation**: Review the plugin's README and documentation
2. **Review Examples**: Look at existing plugins in this marketplace
3. **Open an Issue**: Report problems or ask questions on GitHub
4. **Official Docs**: See [Claude Code documentation](https://code.claude.com/docs)

## Additional Resources

- [Claude Code Plugin Marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) - Official guide
- [Plugin Discovery](https://code.claude.com/docs/en/discover-plugins) - How to find and use plugins
- [Contributing Guide](./CONTRIBUTING.md) - Submit your own plugins
- [Plugin Index](./PLUGIN_INDEX.md) - Browse available plugins
