// src/mcp/config.js
// The list of MCP servers to connect to is read from a JSON file in Claude Code format (.mcp.json).
// The file is not under version control (see .gitignore): each environment has its own and it may contain secrets.
// A missing file or a parse error must not crash the process — in that case there are simply no servers.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';

// Path to the configuration file. Defaults to .mcp.json in the project root; can be overridden via
// config.mcp.configPath (the MCP_CONFIG_PATH environment variable) if the file lives elsewhere.
// The path is resolved relative to the process's current working directory (process.cwd()).
const CONFIG_PATH = resolve(process.cwd(), config.mcp.configPath);

// Normalize a single entry from the mcpServers section of the Claude Code format into an internal server
// description. Only HTTP transport (StreamableHTTP) is supported: an entry needs a url. The title,
// requiresAdmin and disabled fields are optional extensions; they are not in the standard Claude Code format.
function normalizeServer(alias, raw) {
  const type = raw.type || 'http';
  if (type !== 'http' && type !== 'sse') {
    console.error(`MCP "${alias}": transport "${type}" is not supported (http/sse required). Skipping.`);
    return null;
  }
  if (!raw.url) {
    console.error(`MCP "${alias}": url is not set. Skipping.`);
    return null;
  }
  return {
    alias, // short prefix, ends up in the model's tool names
    title: raw.title || alias, // human-readable name for logs and statuses
    url: raw.url,
    headers: raw.headers || null, // transport headers — the place for a future authorization token
    enabled: raw.disabled !== true, // compatible with the "disabled" field of the Claude Code format
    requiresAdmin: raw.requiresAdmin === true,
    // Forward the caller identity (userId/conversationId) in the _meta of every tools/call. Off by
    // default: internal ids must not leak to third-party servers. Enabled for our own servers that
    // need to know whose data to touch (the notes server).
    forwardUserContext: raw.forwardUserContext === true,
    // Treat the server's tools as BASE tools: available under any active skill, like the built-in
    // memory and scheduler tools. Without this flag MCP tools are domain tools and the model sees them
    // only when the active skill lists them in tools.allowed. Meant for the project's own servers
    // providing cross-domain capabilities (the notes server).
    baseTools: raw.baseTools === true,
  };
}

// Read and parse .mcp.json. Any failure (no file, broken JSON, wrong format) results in an empty server
// list rather than a crashed process. The meaningful reason is written to the log.
export function loadMcpServers() {
  let text;
  try {
    text = readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    } // no file — this is a normal situation, not an error
    console.error(`MCP: failed to read ${CONFIG_PATH}: ${err.message}. MCP servers are disabled.`);
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(`MCP: ${CONFIG_PATH} contains invalid JSON: ${err.message}. MCP servers are disabled.`);
    return [];
  }

  const servers = parsed && parsed.mcpServers;
  if (!servers || typeof servers !== 'object') {
    console.error(`MCP: ${CONFIG_PATH} has no "mcpServers" object. MCP servers are disabled.`);
    return [];
  }

  return Object.entries(servers)
    .map(([alias, raw]) => normalizeServer(alias, raw))
    .filter(Boolean);
}
