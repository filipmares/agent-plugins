# Marketplace Scripts

Utility scripts for managing and validating plugins in the marketplace.

## Available Scripts

### validate-plugin.js

Validates that a plugin follows the marketplace structure and standards.

**Usage:**
```bash
node scripts/validate-plugin.js <plugin-path>
```

**Example:**
```bash
node scripts/validate-plugin.js plugins/web-tools/web-fetcher
```

**What it checks:**
- Required files (README.md, plugin.json, src/index.js)
- Plugin metadata completeness
- Valid category
- Documentation structure
- Module exports

### list-plugins.js

Lists all plugins in the marketplace with their metadata.

**Usage:**
```bash
node scripts/list-plugins.js
```

**Output:**
- Grouped by category
- Shows name, version, description
- Displays compatibility information
- Shows relative path to plugin

## For Contributors

Before submitting a plugin, run the validator to ensure it meets marketplace standards:

```bash
# Validate your plugin
node scripts/validate-plugin.js path/to/your/plugin

# See all existing plugins
node scripts/list-plugins.js
```

## For Maintainers

These scripts help maintain consistency across the marketplace:

- Use `validate-plugin.js` during PR reviews
- Run `list-plugins.js` to update the plugin index
- Add new validation rules as standards evolve
