// src/mcp/install.js - MCP server installation for Claude, Codex, Gemini
// Adds/removes bukowski MCP server from each agent's config

const fs = require('fs');
const path = require('path');
const os = require('os');

// Path to bridge script (relative to this file when installed)
const BRIDGE_SCRIPT = path.resolve(__dirname, 'bukowski-mcp-bridge.js');

// Config file locations
const CONFIG_PATHS = {
  claude: path.join(os.homedir(), '.claude.json'),
  codex: path.join(os.homedir(), '.codex', 'config.toml'),
  gemini: path.join(os.homedir(), '.gemini', 'settings.json')
};

/**
 * Parse TOML (minimal parser for codex config)
 * Only handles the subset needed for MCP servers
 */
function parseTOML(content) {
  const result = {};
  let currentSection = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Section header [section.subsection]
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const path = sectionMatch[1].split('.');
      currentSection = path;

      // Ensure path exists
      let obj = result;
      for (const part of path) {
        if (!obj[part]) obj[part] = {};
        obj = obj[part];
      }
      continue;
    }

    // Key = value
    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (kvMatch && currentSection) {
      const [, key, rawValue] = kvMatch;

      // Parse value
      let value;
      if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
        value = rawValue.slice(1, -1);
      } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        // Array - parse as JSON with double quotes
        value = JSON.parse(rawValue.replace(/'/g, '"'));
      } else if (rawValue === 'true') {
        value = true;
      } else if (rawValue === 'false') {
        value = false;
      } else {
        value = rawValue;
      }

      // Set in result
      let obj = result;
      for (const part of currentSection) {
        obj = obj[part];
      }
      obj[key] = value;
    }
  }

  return result;
}

/**
 * Serialize object to TOML (minimal)
 */
function serializeTOML(obj, prefix = '') {
  let result = '';

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Nested object - create section
      const sectionPath = prefix ? `${prefix}.${key}` : key;
      result += `[${sectionPath}]\n`;

      // Add non-object properties
      for (const [subKey, subValue] of Object.entries(value)) {
        if (typeof subValue !== 'object' || Array.isArray(subValue)) {
          result += formatTOMLValue(subKey, subValue);
        }
      }
      result += '\n';

      // Recurse for nested objects
      for (const [subKey, subValue] of Object.entries(value)) {
        if (typeof subValue === 'object' && !Array.isArray(subValue)) {
          result += serializeTOML({ [subKey]: subValue }, sectionPath);
        }
      }
    }
  }

  return result;
}

/**
 * Format a single TOML key-value pair
 */
function formatTOMLValue(key, value) {
  if (typeof value === 'string') {
    return `${key} = "${value}"\n`;
  } else if (Array.isArray(value)) {
    const items = value.map(v => typeof v === 'string' ? `"${v}"` : v);
    return `${key} = [${items.join(', ')}]\n`;
  } else if (typeof value === 'boolean') {
    return `${key} = ${value}\n`;
  } else {
    return `${key} = ${value}\n`;
  }
}

/**
 * Read JSON config file
 */
function readJSON(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write JSON config file
 */
function writeJSON(filepath, data) {
  // Ensure directory exists
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Read TOML config file
 */
function readTOML(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    return { content, parsed: parseTOML(content) };
  } catch {
    return { content: '', parsed: {} };
  }
}

/**
 * Install bukowski MCP server for Claude
 */
function installClaude() {
  const configPath = CONFIG_PATHS.claude;
  let config = readJSON(configPath) || {};

  // Initialize mcpServers if not present
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  // Add bukowski server
  config.mcpServers.bukowski = {
    type: 'stdio',
    command: 'node',
    args: [BRIDGE_SCRIPT]
  };

  writeJSON(configPath, config);
  return true;
}

/**
 * Uninstall bukowski MCP server from Claude
 */
function uninstallClaude() {
  const configPath = CONFIG_PATHS.claude;
  const config = readJSON(configPath);

  if (!config || !config.mcpServers || !config.mcpServers.bukowski) {
    return false; // Not installed
  }

  delete config.mcpServers.bukowski;

  // Clean up empty mcpServers
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }

  writeJSON(configPath, config);
  return true;
}

/**
 * Install bukowski MCP server for Codex
 */
function installCodex() {
  const configPath = CONFIG_PATHS.codex;
  const { content, parsed } = readTOML(configPath);

  // Check if already installed
  if (parsed.mcp_servers?.bukowski) {
    // Update the args in case bridge path changed
    const updatedContent = content.replace(
      /\[mcp_servers\.bukowski\][\s\S]*?(?=\[|$)/,
      `[mcp_servers.bukowski]\ncommand = "node"\nargs = ["${BRIDGE_SCRIPT}"]\n\n`
    );
    fs.writeFileSync(configPath, updatedContent, 'utf-8');
    return true;
  }

  // Append new config
  const newConfig = `\n[mcp_servers.bukowski]\ncommand = "node"\nargs = ["${BRIDGE_SCRIPT}"]\n`;

  // Ensure directory exists
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.appendFileSync(configPath, newConfig, 'utf-8');
  return true;
}

/**
 * Uninstall bukowski MCP server from Codex
 */
function uninstallCodex() {
  const configPath = CONFIG_PATHS.codex;

  if (!fs.existsSync(configPath)) {
    return false;
  }

  const content = fs.readFileSync(configPath, 'utf-8');

  // Remove the [mcp_servers.bukowski] section
  const updatedContent = content.replace(
    /\[mcp_servers\.bukowski\][\s\S]*?(?=\[|$)/g,
    ''
  ).replace(/\n{3,}/g, '\n\n'); // Clean up extra newlines

  fs.writeFileSync(configPath, updatedContent, 'utf-8');
  return true;
}

/**
 * Install bukowski MCP server for Gemini
 */
function installGemini() {
  const configPath = CONFIG_PATHS.gemini;
  let config = readJSON(configPath) || {};

  // Initialize mcpServers if not present
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  // Add bukowski server
  config.mcpServers.bukowski = {
    command: 'node',
    args: [BRIDGE_SCRIPT]
  };

  writeJSON(configPath, config);
  return true;
}

/**
 * Uninstall bukowski MCP server from Gemini
 */
function uninstallGemini() {
  const configPath = CONFIG_PATHS.gemini;
  const config = readJSON(configPath);

  if (!config || !config.mcpServers || !config.mcpServers.bukowski) {
    return false; // Not installed
  }

  delete config.mcpServers.bukowski;

  // Clean up empty mcpServers
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }

  writeJSON(configPath, config);
  return true;
}

/**
 * Install bukowski MCP server for all agents
 * @returns {Object} Installation results
 */
function installAll() {
  const results = {
    claude: { installed: false, error: null },
    codex: { installed: false, error: null },
    gemini: { installed: false, error: null }
  };

  try {
    results.claude.installed = installClaude();
  } catch (err) {
    results.claude.error = err.message;
  }

  try {
    results.codex.installed = installCodex();
  } catch (err) {
    results.codex.error = err.message;
  }

  try {
    results.gemini.installed = installGemini();
  } catch (err) {
    results.gemini.error = err.message;
  }

  return results;
}

/**
 * Uninstall bukowski MCP server from all agents
 * @returns {Object} Uninstallation results
 */
function uninstallAll() {
  const results = {
    claude: { uninstalled: false, error: null },
    codex: { uninstalled: false, error: null },
    gemini: { uninstalled: false, error: null }
  };

  try {
    results.claude.uninstalled = uninstallClaude();
  } catch (err) {
    results.claude.error = err.message;
  }

  try {
    results.codex.uninstalled = uninstallCodex();
  } catch (err) {
    results.codex.error = err.message;
  }

  try {
    results.gemini.uninstalled = uninstallGemini();
  } catch (err) {
    results.gemini.error = err.message;
  }

  return results;
}

/**
 * Check installation status for all agents
 * @returns {Object} Installation status
 */
function checkStatus() {
  const status = {
    claude: { installed: false, configPath: CONFIG_PATHS.claude },
    codex: { installed: false, configPath: CONFIG_PATHS.codex },
    gemini: { installed: false, configPath: CONFIG_PATHS.gemini },
    bridgePath: BRIDGE_SCRIPT,
    bridgeExists: fs.existsSync(BRIDGE_SCRIPT)
  };

  // Check Claude
  const claudeConfig = readJSON(CONFIG_PATHS.claude);
  status.claude.installed = !!claudeConfig?.mcpServers?.bukowski;

  // Check Codex
  const { parsed: codexConfig } = readTOML(CONFIG_PATHS.codex);
  status.codex.installed = !!codexConfig?.mcp_servers?.bukowski;

  // Check Gemini
  const geminiConfig = readJSON(CONFIG_PATHS.gemini);
  status.gemini.installed = !!geminiConfig?.mcpServers?.bukowski;

  return status;
}

module.exports = {
  installAll,
  uninstallAll,
  checkStatus,
  installClaude,
  installCodex,
  installGemini,
  uninstallClaude,
  uninstallCodex,
  uninstallGemini,
  CONFIG_PATHS,
  BRIDGE_SCRIPT
};
