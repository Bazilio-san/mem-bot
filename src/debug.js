// Centralized debug categories built on the standard Debug mechanism from af-tools-ts.
// A category is enabled ONLY via the DEBUG environment variable (a comma-separated list of full category
// names; 'llm:*' enables the whole llm:... family, '*' enables everything — e.g. DEBUG=llm,img-gen).
// An entry must match the full name: DEBUG=llm:summarizer does NOT enable 'llm' or 'summarizer'.
// The dotenv bootstrap below MUST stay first: it loads .env before af-tools-ts captures process.env.DEBUG.
import './bootstrap/dotenv.js';
import { bold, yellow, red, magenta, cyan, reset, lBlue, lCyan, lGreen } from 'af-color';
import { Debug } from 'af-tools-ts';

/**
 * LLM calls: requests (model, message/tool counts) and responses (first 400 chars, chunk stats).
 * Enable: DEBUG=llm
 */
export const debugLlm = Debug('llm', {
  noTime: false,
  noPrefix: false,
  prefixColor: cyan,
  messageColor: reset,
});

/**
 * History compression (summarizer): cold-zone size, summarizer errors, compression stats.
 * Enable: DEBUG=llm:summarizer
 */
export const debugSummarizer = Debug('llm:summarizer', {
  noTime: false,
  noPrefix: false,
  prefixColor: magenta,
  messageColor: lCyan,
});

/**
 * MCP tool calls: request arguments and response payloads, reconnects on dropped connections.
 * Enable: DEBUG=mcp:tool
 */
export const debugMcpTool = Debug('mcp:tool', {
  noTime: false,
  noPrefix: false,
  prefixColor: red,
  messageColor: lBlue,
});

/**
 * Image generation: every stage from the tool call to the Telegram delivery — API request/response,
 * sending the photo by URL and the multipart-upload fallback.
 * Enable: DEBUG=img-gen
 */
export const debugImgGen = Debug('img-gen', {
  noTime: false,
  noPrefix: false,
  prefixColor: bold + yellow,
  messageColor: lGreen,
});
