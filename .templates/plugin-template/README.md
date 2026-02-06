# Plugin Template

A template for creating Claude Code plugins following the official Anthropic guidelines.

## Overview

This template demonstrates the proper structure for a Claude Code plugin. Use it as a starting point for creating your own plugins.

## Plugin Structure

```
plugin-template/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest (required)
├── skills/                   # Skill definitions (optional)
│   └── example-skill/
│       └── SKILL.md
├── commands/                 # Command definitions (optional)
├── mcp/                      # MCP server implementations (optional)
└── README.md                 # This file (required)
```

## Installation

Add the marketplace containing this plugin:

```bash
/plugin marketplace add https://github.com/tinytoolstown/marketplace
/plugin install plugin-template@tinytoolstown-marketplace
```

## Usage

After installation, you can use the plugin's capabilities. For this template:

```bash
/example-skill
```

## Configuration

No additional configuration required for this template.

## Development

To create your own plugin based on this template:

1. Copy this directory structure
2. Update `.claude-plugin/plugin.json` with your plugin details
3. Add your skills, commands, or MCP servers
4. Update this README with your plugin documentation
5. Submit to a marketplace following the contributing guidelines

## Documentation

- Each skill needs a `SKILL.md` file describing its functionality
- Each command needs a `COMMAND.md` file with usage instructions
- MCP servers should include implementation documentation

## License

MIT License

## Author

Your Name

## Contributing

See the marketplace [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines on submitting plugins.
