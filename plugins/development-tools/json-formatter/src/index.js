/**
 * JSON Formatter Plugin
 * 
 * Format, validate, and manipulate JSON data
 */

/**
 * Format JSON with pretty-printing
 * @param {string|object} input - JSON string or object
 * @param {object} options - Formatting options
 * @returns {string} Formatted JSON string
 */
function format(input, options = {}) {
  const indent = options.indent || 2;
  const sorted = options.sorted || false;
  
  try {
    let obj = typeof input === 'string' ? JSON.parse(input) : input;
    
    if (sorted) {
      obj = sortKeys(obj);
    }
    
    return JSON.stringify(obj, null, indent);
  } catch (error) {
    throw new Error(`Failed to format JSON: ${error.message}`);
  }
}

/**
 * Validate JSON syntax
 * @param {string} input - JSON string to validate
 * @returns {object} Validation result with {valid: boolean, error: string|null}
 */
function validate(input) {
  try {
    JSON.parse(input);
    return { valid: true, error: null };
  } catch (error) {
    return { 
      valid: false, 
      error: error.message 
    };
  }
}

/**
 * Minify JSON by removing whitespace
 * @param {string|object} input - JSON string or object
 * @returns {string} Minified JSON string
 */
function minify(input) {
  try {
    const obj = typeof input === 'string' ? JSON.parse(input) : input;
    return JSON.stringify(obj);
  } catch (error) {
    throw new Error(`Failed to minify JSON: ${error.message}`);
  }
}

/**
 * Sort object keys recursively
 * @param {*} obj - Object to sort
 * @returns {*} Object with sorted keys
 */
function sortKeys(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }
  
  const sorted = {};
  const keys = Object.keys(obj).sort();
  
  for (const key of keys) {
    sorted[key] = sortKeys(obj[key]);
  }
  
  return sorted;
}

/**
 * Parse JSON with error handling
 * @param {string} input - JSON string
 * @returns {object} Parsed object or error
 */
function safeParse(input) {
  try {
    return { success: true, data: JSON.parse(input) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Stringify with error handling
 * @param {*} input - Value to stringify
 * @param {object} options - Stringify options
 * @returns {object} Result with string or error
 */
function safeStringify(input, options = {}) {
  try {
    const indent = options.indent || 0;
    return { 
      success: true, 
      data: JSON.stringify(input, null, indent) 
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Main function for CLI usage
function main() {
  console.log('JSON Formatter Plugin loaded');
  
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage:');
    console.log('  node index.js format <json-string>');
    console.log('  node index.js validate <json-string>');
    console.log('  node index.js minify <json-string>');
    return;
  }
  
  const command = args[0];
  const input = args[1];
  
  try {
    switch (command) {
      case 'format':
        console.log(format(input, { indent: 2 }));
        break;
      case 'validate':
        const result = validate(input);
        console.log(result.valid ? 'Valid JSON' : `Invalid: ${result.error}`);
        break;
      case 'minify':
        console.log(minify(input));
        break;
      case 'sort':
        console.log(format(input, { indent: 2, sorted: true }));
        break;
      default:
        console.log(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Export functions
module.exports = {
  format,
  validate,
  minify,
  sortKeys,
  safeParse,
  safeStringify
};

// Run main if executed directly
if (require.main === module) {
  main();
}
