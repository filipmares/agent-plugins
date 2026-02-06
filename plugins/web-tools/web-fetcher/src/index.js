/**
 * Web Fetcher Plugin
 * 
 * Fetches and parses web content for AI analysis
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Fetch content from a URL
 * @param {string} urlString - The URL to fetch
 * @param {object} options - Optional fetch options
 * @returns {Promise<string>} The fetched content
 */
function fetchUrl(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlString);
      const client = url.protocol === 'https:' ? https : http;
      
      const requestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: options.headers || {
          'User-Agent': 'Mozilla/5.0 (compatible; AI-Assistant/1.0)'
        },
        timeout: options.timeout || 10000
      };

      const req = client.request(requestOptions, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Parse HTML and extract text content
 * @param {string} html - The HTML content to parse
 * @returns {string} Extracted text content
 */
function parseHtml(html) {
  // Remove script and style tags
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  
  // Decode HTML entities
  text = text.replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  
  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').trim();
  
  return text;
}

/**
 * Extract links from HTML
 * @param {string} html - The HTML content
 * @returns {Array<string>} Array of extracted URLs
 */
function getLinks(html) {
  const links = [];
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["']/gi;
  let match;
  
  while ((match = linkRegex.exec(html)) !== null) {
    links.push(match[1]);
  }
  
  return links;
}

// Main function for testing
async function main() {
  console.log('Web Fetcher Plugin loaded');
  
  // Example usage
  if (process.argv.length > 2) {
    const url = process.argv[2];
    try {
      console.log(`Fetching: ${url}`);
      const content = await fetchUrl(url);
      const text = parseHtml(content);
      console.log('\nExtracted text:');
      console.log(text.substring(0, 500) + '...');
      
      const links = getLinks(content);
      console.log(`\nFound ${links.length} links`);
    } catch (error) {
      console.error('Error:', error.message);
    }
  }
}

// Export functions
module.exports = {
  fetchUrl,
  parseHtml,
  getLinks
};

// Run main if executed directly
if (require.main === module) {
  main();
}
