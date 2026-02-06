# Plugin Marketplace

A curated collection of plugins for AI coding assistants like Claude Code and GitHub Copilot CLI.

## 🚀 Quick Start

New here? Check out the [Getting Started Guide](./GETTING_STARTED.md) for detailed instructions on finding, installing, and using plugins.

## What is this?

This marketplace provides a centralized repository of plugins that extend the capabilities of AI coding assistants. Whether you need web scraping tools, API integrations, or specialized development utilities, you'll find high-quality, community-contributed plugins here.

## Plugin Categories

- **web-tools**: Plugins for web scraping, HTTP requests, and web automation
- **development-tools**: Code analysis, linting, formatting, and development utilities
- **data-tools**: Data processing, transformation, and analysis plugins
- **utilities**: General-purpose utility plugins

## How to Use Plugins

### For Claude Code

1. Browse the plugins directory to find a plugin that fits your needs
2. Copy the plugin directory or specific MCP server configuration
3. Add the plugin to your Claude Code configuration file
4. Restart Claude Code to load the plugin

### For GitHub Copilot CLI

1. Browse the plugins directory to find a plugin that fits your needs
2. Follow the plugin's specific installation instructions
3. Use the plugin commands as documented in the plugin's README

## Plugin Structure

Each plugin should follow this structure:

```
plugin-name/
├── README.md          # Plugin documentation
├── package.json       # Dependencies and metadata
├── plugin.json        # Plugin configuration
└── src/              # Source code
    └── index.js      # Main entry point
```

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on:

- Submitting new plugins
- Plugin quality standards
- Documentation requirements
- Testing requirements

## Available Plugins

📋 View the complete [Plugin Index](./PLUGIN_INDEX.md) for a detailed catalog of all plugins.

Browse by category:
- [Web Tools](./plugins/web-tools) - 1 plugin
- [Development Tools](./plugins/development-tools) - 1 plugin
- [Data Tools](./plugins/data-tools) - Coming soon
- [Utilities](./plugins/utilities) - Coming soon

## License

MIT License - see [LICENSE](LICENSE) for details.

## Documentation

- 📖 [Getting Started Guide](./GETTING_STARTED.md) - Installation and usage
- 📋 [Plugin Index](./PLUGIN_INDEX.md) - Complete plugin catalog
- 🤝 [Contributing Guidelines](./CONTRIBUTING.md) - Submit your plugins
- 📝 [Plugin Template](./.templates/plugin-template) - Create new plugins

## Support

For issues or questions:
- Open an issue in this repository
- Check existing plugin documentation
- Review the [Getting Started Guide](./GETTING_STARTED.md)
