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

- Node.js 14 or higher (Node.js 18+ recommended for security updates)
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
- **HTML parsing**: The built-in HTML parser uses regex for simplicity. For complex or malformed HTML, consider using a proper HTML parsing library

## Limitations

- **HTML parsing is basic**: This plugin uses regex-based parsing for simplicity. It handles standard HTML but may not catch all edge cases or malformed HTML
- **Not for sanitization**: Do NOT use the `parseHtml` function to sanitize HTML for browser rendering. Use a proper HTML parser library for security-critical applications
- **No JavaScript execution**: Fetches static HTML only (no dynamic content from JavaScript)
- **No redirect handling**: Does not follow HTTP redirects automatically
- **Text content only**: Limited to extracting text-based content

## Security Notes

- **Untrusted sources**: Be cautious when fetching content from untrusted sources
- **URL validation**: Always validate URLs before making requests
- **Rate limiting**: Consider implementing rate limiting to avoid abuse
- **HTML sanitization**: This plugin is NOT suitable for sanitizing HTML to prevent XSS attacks
- **Content validation**: Validate and sanitize any extracted content before using it in security-sensitive contexts

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
