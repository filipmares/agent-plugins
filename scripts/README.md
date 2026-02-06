# Marketplace Scripts

Utility scripts for managing and validating Claude Code plugins.

## Available Scripts

### validate-plugin.js

Validates that a plugin follows the official Claude Code structure and standards.

**Usage:**
```bash
node scripts/validate-plugin.js <plugin-path>
```

**Example:**
```bash
node scripts/validate-plugin.js .templates/plugin-template
node scripts/validate-plugin.js plugins/my-plugin
```

**What it checks:**
- Required files (`.claude-plugin/plugin.json`, `README.md`)
- Plugin manifest completeness and structure
- Valid categories and capabilities
- Documentation structure
- Declared capabilities match implementation files

### list-plugins.js

Lists all plugins registered in the marketplace catalog.

**Usage:**
```bash
node scripts/list-plugins.js
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
   node scripts/validate-plugin.js path/to/your/plugin
   ```

2. **Ensure it follows Claude Code conventions:**
   - Has `.claude-plugin/plugin.json` manifest
   - Includes proper README.md
   - Implements declared capabilities

3. **Add to marketplace catalog:**
   Update `.claude-plugin/marketplace.json` with your plugin entry

4. **Verify it appears in the list:**
   ```bash
   node scripts/list-plugins.js
   ```

## For Maintainers

These scripts help maintain consistency:

- Use `validate-plugin.js` during PR reviews
- Run `list-plugins.js` to verify marketplace catalog
- Ensure all plugins meet Claude Code standards
