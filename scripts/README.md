# Marketplace Scripts

Utility scripts for managing and validating plugins, written in TypeScript and run with Bun.

## Prerequisites

- [Bun](https://bun.sh) runtime installed

## Available Scripts

### validate-plugin.ts

Validates that a plugin follows the official plugin structure and standards.

**Usage:**
```bash
bun run scripts/validate-plugin.ts <plugin-path>
```

**Example:**
```bash
bun run scripts/validate-plugin.ts .templates/plugin-template
bun run scripts/validate-plugin.ts plugins/my-plugin
```

**What it checks:**
- Required files (`.claude-plugin/plugin.json`, `README.md`)
- Plugin manifest completeness and structure
- Valid categories and capabilities
- Documentation structure
- Declared capabilities match implementation files

### list-plugins.ts

Lists all plugins registered in the marketplace catalog.

**Usage:**
```bash
bun run scripts/list-plugins.ts
```

**Or using npm scripts:**
```bash
bun run list
```

**Output:**
- Shows all plugins from `.claude-plugin/marketplace.json`
- Displays name, version, description
- Shows categories and capabilities
- Includes author and path information

## For Contributors

Before submitting a plugin:

1. **Validate your plugin structure:**
   ```bash
   bun run scripts/validate-plugin.ts path/to/your/plugin
   ```

2. **Ensure it follows Claude Code conventions:**
   - Has `.claude-plugin/plugin.json` manifest
   - Includes proper README.md
   - Implements declared capabilities


3. **Add to marketplace catalog:**
   Update `.claude-plugin/marketplace.json` with your plugin entry

4. **Verify it appears in the list:**
   ```bash
   bun run scripts/list-plugins.ts
   ```

## For Maintainers

These scripts help maintain consistency:

- Use `validate-plugin.ts` during PR reviews
- Run `list-plugins.ts` to verify marketplace catalog
- Ensure all plugins meet marketplace standards

## Development

The scripts are written in TypeScript and use Bun's native TypeScript support. No compilation step is needed.

