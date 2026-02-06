# JSON Formatter Plugin

A utility plugin for formatting, validating, and manipulating JSON data.

## Features

- Pretty-print JSON with customizable indentation
- Validate JSON syntax
- Minify JSON (remove whitespace)
- Sort JSON keys alphabetically
- Parse and stringify JSON safely
- Handle common JSON errors gracefully

## Installation

### For Claude Code

1. Copy the `json-formatter` directory to your plugins folder
2. Add configuration to Claude Code MCP settings:
   ```json
   {
     "mcpServers": {
       "json-formatter": {
         "command": "node",
         "args": ["path/to/json-formatter/src/index.js"]
       }
     }
   }
   ```
3. Restart Claude Code

### For GitHub Copilot CLI

Use as a standalone Node.js utility or integrate with Copilot CLI extensions.

## Usage

AI assistants can use this plugin to:
- Format JSON code for better readability
- Validate JSON before processing
- Minify JSON for storage or transmission
- Sort JSON keys for consistent output

## API Reference

### format(jsonString, options)
Format JSON with pretty-printing
- `jsonString`: JSON string or object
- `options.indent`: Number of spaces for indentation (default: 2)
- `options.sorted`: Sort keys alphabetically (default: false)

### validate(jsonString)
Validate JSON syntax
- Returns: `{valid: boolean, error: string|null}`

### minify(jsonString)
Remove all unnecessary whitespace
- Returns: Minified JSON string

### sortKeys(jsonObject)
Sort object keys recursively
- Returns: Object with sorted keys

## Examples

### Format JSON
```javascript
const { format } = require('./json-formatter');

const ugly = '{"name":"John","age":30,"city":"NYC"}';
const pretty = format(ugly, { indent: 2 });
console.log(pretty);
// Output:
// {
//   "name": "John",
//   "age": 30,
//   "city": "NYC"
// }
```

### Validate JSON
```javascript
const { validate } = require('./json-formatter');

const result = validate('{"valid": "json"}');
console.log(result.valid); // true

const bad = validate('{invalid json}');
console.log(bad.valid); // false
console.log(bad.error); // Error message
```

### Minify JSON
```javascript
const { minify } = require('./json-formatter');

const json = `{
  "name": "John",
  "age": 30
}`;
console.log(minify(json));
// Output: {"name":"John","age":30}
```

## Requirements

- Node.js 14 or higher (Node.js 18+ recommended)

## Troubleshooting

- **Parse errors**: Check for common JSON syntax issues (trailing commas, unquoted keys)
- **Invalid input**: Ensure input is a valid JSON string
- **Memory issues**: Very large JSON files may require streaming solutions

## Contributing

Contributions welcome! See [CONTRIBUTING.md](../../../CONTRIBUTING.md) for guidelines.

## License

MIT License - see [LICENSE](../../../LICENSE) for details.

## Changelog

### 1.0.0
- Initial release
- JSON formatting with customizable indentation
- JSON validation
- JSON minification
- Key sorting
