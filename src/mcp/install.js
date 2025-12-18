// src/mcp/install.js - MCP server installation for Claude, Codex, Gemini
// Adds/removes bukowski MCP server from each agent's config

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Path to bridge script (relative to this file when installed)
const BRIDGE_SCRIPT = path.resolve(__dirname, 'bukowski-mcp-bridge.js');

// Config file locations
const CONFIG_PATHS = {
  claude: path.join(os.homedir(), '.claude.json'),
  codex: path.join(os.homedir(), '.codex', 'config.toml'),
  gemini: path.join(os.homedir(), '.gemini', 'settings.json')
};

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
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Check if a command exists
 */
function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install bukowski MCP server for Claude
 */
function installClaude() {
  const configPath = CONFIG_PATHS.claude;
  let config = readJSON(configPath) || {};

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  config.mcpServers.bukowski = {
    type: 'stdio',
    command: 'node',
    args: [BRIDGE_SCRIPT],
    env: { BUKOWSKI_AGENT_TYPE: 'claude' }
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

  if (!config?.mcpServers?.bukowski) {
    return false;
  }

  delete config.mcpServers.bukowski;

  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }

  writeJSON(configPath, config);
  return true;
}

/**
 * Install bukowski MCP server for Codex
 * Uses `codex mcp add` CLI when available
 */
function installCodex() {
  // First try to remove existing entry (in case of update)
  try {
    if (commandExists('codex')) {
      execSync('codex mcp remove bukowski 2>/dev/null || true', { stdio: 'pipe' });
    }
  } catch {
    // Ignore - might not exist
  }

  // Try using codex CLI
  // No --env: let bridge inherit BUKOWSKI_AGENT_ID and BUKOWSKI_AGENT_TYPE from parent process
  if (commandExists('codex')) {
    try {
      execSync(
        `codex mcp add bukowski -- node "${BRIDGE_SCRIPT}"`,
        { stdio: 'pipe' }
      );
      return true;
    } catch {
      // CLI failed, fall back to manual config
    }
  }

  // Fallback: manual TOML editing
  const configPath = CONFIG_PATHS.codex;
  const dir = path.dirname(configPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let content = '';
  try {
    content = fs.readFileSync(configPath, 'utf-8');
  } catch {
    // File doesn't exist yet
  }

  // Remove existing bukowski section if present
  content = content.replace(/\[mcp_servers\.bukowski\][\s\S]*?(?=\[|$)/g, '');
  content = content.replace(/\n{3,}/g, '\n\n').trim();

  // Append new config (no env section - inherit from parent process)
  const newSection = `
[mcp_servers.bukowski]
command = "node"
args = ["${BRIDGE_SCRIPT}"]
`;

  content = content + '\n' + newSection;
  fs.writeFileSync(configPath, content.trim() + '\n', 'utf-8');
  return true;
}

/**
 * Uninstall bukowski MCP server from Codex
 */
function uninstallCodex() {
  // Try using codex CLI
  if (commandExists('codex')) {
    try {
      execSync('codex mcp remove bukowski', { stdio: 'pipe' });
      return true;
    } catch {
      // CLI failed, fall back to manual removal
    }
  }

  // Fallback: manual TOML editing
  const configPath = CONFIG_PATHS.codex;

  if (!fs.existsSync(configPath)) {
    return false;
  }

  let content = fs.readFileSync(configPath, 'utf-8');
  const hadBukowski = content.includes('[mcp_servers.bukowski]');

  // Remove the bukowski sections
  content = content.replace(/\[mcp_servers\.bukowski\][\s\S]*?(?=\[|$)/g, '');
  content = content.replace(/\[mcp_servers\.bukowski\.env\][\s\S]*?(?=\[|$)/g, '');
  content = content.replace(/\n{3,}/g, '\n\n').trim();

  fs.writeFileSync(configPath, content + '\n', 'utf-8');
  return hadBukowski;
}

/**
 * Install bukowski MCP server for Gemini
 */
function installGemini() {
  const configPath = CONFIG_PATHS.gemini;
  let config = readJSON(configPath) || {};

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  config.mcpServers.bukowski = {
    command: 'node',
    args: [BRIDGE_SCRIPT],
    env: { BUKOWSKI_AGENT_TYPE: 'gemini' }
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

  if (!config?.mcpServers?.bukowski) {
    return false;
  }

  delete config.mcpServers.bukowski;

  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }

  writeJSON(configPath, config);
  return true;
}

/**
 * Install bukowski MCP server for all agents
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

  // Check Codex - try CLI first, then check file
  if (commandExists('codex')) {
    try {
      const output = execSync('codex mcp list 2>/dev/null || true', { encoding: 'utf-8' });
      status.codex.installed = output.includes('bukowski');
    } catch {
      // Fall back to file check
      try {
        const content = fs.readFileSync(CONFIG_PATHS.codex, 'utf-8');
        status.codex.installed = content.includes('[mcp_servers.bukowski]');
      } catch {
        status.codex.installed = false;
      }
    }
  } else {
    try {
      const content = fs.readFileSync(CONFIG_PATHS.codex, 'utf-8');
      status.codex.installed = content.includes('[mcp_servers.bukowski]');
    } catch {
      status.codex.installed = false;
    }
  }

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
