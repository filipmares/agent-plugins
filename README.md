# Plugin Marketplace

A curated collection of plugins for Claude Code, following the official [Anthropic plugin marketplace guidelines](https://code.claude.com/docs/en/plugin-marketplaces).

## 🚀 Quick Start

### Installing the Marketplace

Add this marketplace to your Claude Code:

```bash
/plugin marketplace add https://github.com/tinytoolstown/marketplace
```

### Installing Plugins

Browse and install plugins from this marketplace:

```bash
/plugin                                    # Browse available plugins
/plugin install <plugin-name>@tinytoolstown-marketplace
```

## What is this?

This is an official Claude Code plugin marketplace that follows Anthropic's marketplace specification. It provides a centralized catalog of plugins that extend Claude Code's capabilities with commands, skills, agents, hooks, and MCP servers.

## Marketplace Structure

This repository follows the official Claude Code marketplace structure:

```
marketplace/
├── .claude-plugin/
│   └── marketplace.json      # Marketplace catalog
├── plugins/
│   └── [plugin-directories]  # Individual plugins
└── README.md
```

Each plugin has its own `.claude-plugin/plugin.json` manifest describing its capabilities.

## Available Plugins

Currently, this marketplace contains no plugins. We're accepting contributions!

📋 See the [Plugin Index](./PLUGIN_INDEX.md) for available plugins organized by category.

## Contributing Plugins

Want to add a plugin to this marketplace? See [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Plugin structure requirements
- How to create a `.claude-plugin/plugin.json` manifest
- Categories and metadata standards
- Submission process

## Plugin Categories

- **development-tools**: Code analysis, formatting, linting, and development utilities
- **productivity**: Task automation, note-taking, and workflow optimization
- **web-tools**: Web scraping, HTTP requests, and browser automation
- **data-tools**: Data processing, transformation, and analysis
- **testing**: Testing frameworks, test generation, and quality assurance
- **security**: Security scanning, vulnerability detection, and compliance

## Documentation

- 📖 [Getting Started Guide](./GETTING_STARTED.md) - How to use this marketplace
- 🤝 [Contributing Guidelines](./CONTRIBUTING.md) - Submit your plugins
- 📋 [Plugin Index](./PLUGIN_INDEX.md) - Browse available plugins
- 📚 [Official Docs](https://code.claude.com/docs/en/plugin-marketplaces) - Anthropic's marketplace guide

## Support

For issues or questions:
- Open an issue in this repository
- Check the [official Claude Code documentation](https://code.claude.com/docs)
- Review the [Getting Started Guide](./GETTING_STARTED.md)

## License

MIT License - see [LICENSE](LICENSE) for details.
