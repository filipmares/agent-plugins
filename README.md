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

Currently, this marketplace contains no plugins. We're accepting contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to submit a plugin.

## Support

For issues or questions:
- Open an issue in this repository
- Check the [official Claude Code documentation](https://code.claude.com/docs)

## License

MIT License - see [LICENSE](LICENSE) for details.
