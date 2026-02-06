# Contributing to Plugin Marketplace

Thank you for your interest in contributing to the Plugin Marketplace! This guide will help you submit high-quality plugins that benefit the community.

## Submission Guidelines

### Plugin Requirements

1. **Documentation**: Every plugin must include a comprehensive README.md with:
   - Clear description of what the plugin does
   - Installation instructions
   - Usage examples
   - Configuration options
   - Any dependencies or requirements

2. **Metadata**: Include a `plugin.json` file with:
   ```json
   {
     "name": "plugin-name",
     "version": "1.0.0",
     "description": "Brief description",
     "author": "Your Name",
     "license": "MIT",
     "category": "web-tools|development-tools|data-tools|utilities",
     "compatibility": ["claude-code", "copilot-cli"],
     "tags": ["tag1", "tag2"]
   }
   ```

3. **Code Quality**:
   - Follow consistent coding style
   - Include error handling
   - Add comments for complex logic
   - Avoid hardcoded credentials or secrets

4. **Testing**: If your plugin includes tests, document how to run them

5. **License**: Use MIT license or another permissive open-source license

### How to Submit a Plugin

1. **Fork the Repository**
   ```bash
   git clone https://github.com/tinytoolstown/marketplace.git
   cd marketplace
   ```

2. **Create a Branch**
   ```bash
   git checkout -b add-my-plugin
   ```

3. **Add Your Plugin**
   - Choose the appropriate category directory under `plugins/`
   - Create a directory for your plugin
   - Add all necessary files (README.md, plugin.json, source code)

4. **Test Your Plugin**
   - Verify it works with the intended AI assistant
   - Check that documentation is clear and complete

5. **Submit a Pull Request**
   - Provide a clear description of what your plugin does
   - Include screenshots or examples if applicable
   - Reference any related issues

### Plugin Categories

- **web-tools**: Web scraping, HTTP clients, browser automation, API wrappers
- **development-tools**: Linters, formatters, code generators, build tools
- **data-tools**: Data parsers, converters, validators, analysis tools
- **utilities**: File operations, text processing, system utilities

### Code of Conduct

- Be respectful and constructive in all interactions
- Help others and share knowledge
- Follow the repository's guidelines
- Report security issues responsibly

### Review Process

1. Pull requests are reviewed by maintainers
2. Feedback may be provided for improvements
3. Once approved, your plugin will be merged
4. Your contribution will be credited in the repository

### Getting Help

If you need assistance:
- Open an issue for questions
- Review existing plugins for examples
- Check the main README.md for guidance

## Security

If you discover a security vulnerability:
- DO NOT open a public issue
- Contact the maintainers privately
- Provide detailed information about the vulnerability

Thank you for contributing to make this marketplace better!
