# Web Fetcher Plugin

A simple plugin to fetch and parse web content, making it easy for AI assistants to analyze web pages.

## Features

- Fetch HTML content from URLs
- Basic HTML parsing and text extraction
- Support for custom headers
- Error handling and timeout management
- Simple and lightweight implementation

## Installation

### For Claude Code

1. Copy the `web-fetcher` directory to your Claude Code plugins folder
2. Add the plugin configuration to your Claude Code MCP settings:
   ```json
   {
     "mcpServers": {
       "web-fetcher": {
         "command": "node",
         "args": ["path/to/web-fetcher/src/index.js"]
       }
     }
   }
   ```
3. Restart Claude Code

### For GitHub Copilot CLI

This plugin works as a standalone Node.js module that can be integrated with GitHub Copilot CLI extensions.

## Usage

The plugin provides web fetching capabilities that can be used by AI assistants to:
- Retrieve web page content
- Extract text from HTML
- Analyze web resources
- Gather information from online sources

## Configuration

The plugin uses default Node.js HTTP/HTTPS modules and doesn't require external dependencies.

## Requirements

- Node.js 18 or higher
- Internet connection

## Example Use Cases

### Fetch a web page
AI assistants can request web content retrieval for analysis and summarization.

### Extract information
Parse HTML content to extract specific information, links, or metadata.

### Monitor resources
Check if web resources are available and retrieve their content.

## API Reference

The plugin exposes functions that can be called by AI assistants:

- `fetchUrl(url)`: Fetch content from a URL
- `parseHtml(html)`: Parse HTML and extract text
- `getLinks(html)`: Extract links from HTML

## Troubleshooting

- **Connection timeout**: Increase timeout settings or check network connectivity
- **SSL errors**: Ensure you're accessing HTTPS sites with valid certificates
- **Rate limiting**: Some sites may rate limit requests; implement delays if needed

## Security Notes

- Be cautious when fetching content from untrusted sources
- Validate URLs before making requests
- Consider implementing rate limiting to avoid abuse

## Contributing

Contributions are welcome! Please see the main [CONTRIBUTING.md](../../../CONTRIBUTING.md) for guidelines.

## License

MIT License - see [LICENSE](../../../LICENSE) for details.

## Changelog

### 1.0.0
- Initial release
- Basic URL fetching
- HTML text extraction
- Link extraction
