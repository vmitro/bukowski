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

// Marker that records an explicit `bukowski-mcp uninstall`. Startup
// auto-install checks for this and bails so an explicit uninstall sticks
// even though every later boot would otherwise reinstall.
const AUTO_INSTALL_MARKER = path.join(os.homedir(), '.bukowski', '.no-auto-install');

// --- Claude Code channel plugin --------------------------------------------
// To load the bukowski channel via the QUIET `--channels plugin:...@...` flag
// (instead of `--dangerously-load-development-channels`, which prints a notice
// every launch) the channel must come from a plugin in a known marketplace.
// We generate a tiny local marketplace + plugin whose ONLY job is to provide a
// channel-only MCP server (the same bridge, role=channel). The plugin is purely
// additive: the FIPA tools still come from the bare mcpServers.bukowski entry,
// so a misconfigured plugin can never remove tools — worst case the channel
// just doesn't load and we fall back to the dangerous flag.
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const CHANNEL_ROOT = path.join(os.homedir(), '.bukowski', 'channel-plugin');
const CHANNEL_MARKETPLACE = 'bukowski';
const CHANNEL_PLUGIN = 'bukowski-channel';
const CHANNEL_PLUGIN_KEY = `${CHANNEL_PLUGIN}@${CHANNEL_MARKETPLACE}`;
const CHANNEL_PLUGIN_REF = `plugin:${CHANNEL_PLUGIN_KEY}`;
const CHANNEL_PLUGIN_DIR = path.join(CHANNEL_ROOT, 'plugins', CHANNEL_PLUGIN);
const CHANNEL_PLUGIN_VERSION = '1.0.0';

// Claude Code does NOT load an enabled plugin from our source marketplace dir;
// it loads a CACHE COPY recorded in installed_plugins.json. If that record
// survives but the cache dir is gone, Claude treats the plugin as installed,
// finds nothing at installPath, and silently loads no channel server (no error,
// /mcp just omits it). We therefore populate the cache + records ourselves so
// the channel is deterministic and self-healing rather than relying on Claude's
// fragile lazy directory-source install. All under the (real) user's home.
const CLAUDE_PLUGINS_DIR = path.join(os.homedir(), '.claude', 'plugins');
const CLAUDE_PLUGIN_CACHE_DIR = path.join(
  CLAUDE_PLUGINS_DIR, 'cache', CHANNEL_MARKETPLACE, CHANNEL_PLUGIN, CHANNEL_PLUGIN_VERSION
);
const CLAUDE_KNOWN_MARKETPLACES = path.join(CLAUDE_PLUGINS_DIR, 'known_marketplaces.json');
const CLAUDE_INSTALLED_PLUGINS = path.join(CLAUDE_PLUGINS_DIR, 'installed_plugins.json');

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
 * Write the local marketplace + channel-only plugin files to disk (idempotent).
 * The plugin's MCP server runs the SAME bridge with role=channel, by ABSOLUTE
 * path (not ${CLAUDE_PLUGIN_ROOT}) so it works regardless of where/whether the
 * plugin dir is copied on install.
 * @private
 */
function _writeChannelPluginFiles() {
  const marketplaceManifest = {
    name: CHANNEL_MARKETPLACE,
    description: 'bukowski FIPA channel marketplace — push-only MCP plugin for inter-agent messaging',
    owner: { name: 'bukowski' },
    plugins: [
      {
        name: CHANNEL_PLUGIN,
        source: `./plugins/${CHANNEL_PLUGIN}`,
        description: 'bukowski FIPA channel — pushes inbound agent messages into Claude Code out-of-turn'
      }
    ]
  };
  const pluginManifest = {
    name: CHANNEL_PLUGIN,
    description: 'bukowski FIPA channel (push-only MCP server)',
    version: CHANNEL_PLUGIN_VERSION
  };
  const mcpManifest = {
    mcpServers: {
      [CHANNEL_PLUGIN]: {
        command: 'node',
        // --role=channel is the AUTHORITATIVE signal: Claude Code's channel
        // loader forwards args but drops a plugin's declared `env`, so an
        // env-only role left the server running in tools mode (duplicate
        // connection, full tool surface) and Claude cycled it. `env` is kept as
        // a harmless fallback for any path that does honor it.
        args: [BRIDGE_SCRIPT, '--role=channel'],
        env: { BUKOWSKI_AGENT_TYPE: 'claude', BUKOWSKI_BRIDGE_ROLE: 'channel' }
      }
    }
  };

  fs.mkdirSync(path.join(CHANNEL_ROOT, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(CHANNEL_PLUGIN_DIR, '.claude-plugin'), { recursive: true });
  writeJSON(path.join(CHANNEL_ROOT, '.claude-plugin', 'marketplace.json'), marketplaceManifest);
  writeJSON(path.join(CHANNEL_PLUGIN_DIR, '.claude-plugin', 'plugin.json'), pluginManifest);
  // .mcp.json lives at the PLUGIN ROOT (not inside .claude-plugin/).
  writeJSON(path.join(CHANNEL_PLUGIN_DIR, '.mcp.json'), mcpManifest);
}

/**
 * Register + enable the channel plugin in ~/.claude/settings.json (additive).
 * We deliberately do NOT write managed-settings/allowedChannelPlugins: on a
 * personal account channels load with no allowlist, and allowedChannelPlugins
 * would REPLACE Anthropic's default channel allowlist globally. Returns true if
 * the file was changed.
 * @private
 */
function _enableChannelPluginInSettings() {
  const cfg = readJSON(CLAUDE_SETTINGS_PATH) || {};
  const before = JSON.stringify(cfg);

  if (!cfg.extraKnownMarketplaces) cfg.extraKnownMarketplaces = {};
  cfg.extraKnownMarketplaces[CHANNEL_MARKETPLACE] = {
    // 'directory' is the valid source type for a local on-disk marketplace
    // (the 'local' value an earlier version wrote fails Claude Code's settings
    // validation / `/doctor`).
    source: { source: 'directory', path: CHANNEL_ROOT }
  };
  if (!cfg.enabledPlugins) cfg.enabledPlugins = {};
  cfg.enabledPlugins[CHANNEL_PLUGIN_KEY] = true;

  if (JSON.stringify(cfg) === before) return false;
  writeJSON(CLAUDE_SETTINGS_PATH, cfg);
  return true;
}

/**
 * Recursively copy a directory (dependency-free; the plugin is two small files).
 * @private
 */
function _copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) _copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Populate Claude Code's plugin cache + install records for the channel plugin
 * so it actually loads. Enabling it in settings.json only declares intent;
 * Claude loads the plugin's MCP server from the cache copy named in
 * installed_plugins.json, NOT from our source marketplace. We do that install
 * ourselves (idempotent, merge-preserving other plugins) so a wiped or never-
 * created cache self-heals on the next `bukowski-mcp install` / launch instead
 * of leaving a dangling record that makes the channel silently vanish.
 * @private
 */
function _installChannelPluginCache() {
  // 1. Mirror the generated plugin into Claude's cache installPath.
  _copyDirSync(CHANNEL_PLUGIN_DIR, CLAUDE_PLUGIN_CACHE_DIR);

  // 2. Make the directory marketplace known to Claude (preserve other entries).
  const known = readJSON(CLAUDE_KNOWN_MARKETPLACES) || {};
  known[CHANNEL_MARKETPLACE] = {
    source: { source: 'directory', path: CHANNEL_ROOT },
    installLocation: CHANNEL_ROOT,
    lastUpdated: new Date().toISOString()
  };
  writeJSON(CLAUDE_KNOWN_MARKETPLACES, known);

  // 3. Record the install pointing at the cache copy (preserve other plugins;
  //    keep a stable installedAt across re-runs so this stays idempotent).
  const installed = readJSON(CLAUDE_INSTALLED_PLUGINS) || { version: 2, plugins: {} };
  if (!installed.plugins || typeof installed.plugins !== 'object') installed.plugins = {};
  const prev = Array.isArray(installed.plugins[CHANNEL_PLUGIN_KEY])
    ? installed.plugins[CHANNEL_PLUGIN_KEY][0] : null;
  installed.plugins[CHANNEL_PLUGIN_KEY] = [{
    scope: 'user',
    installPath: CLAUDE_PLUGIN_CACHE_DIR,
    version: CHANNEL_PLUGIN_VERSION,
    installedAt: prev?.installedAt || new Date().toISOString()
  }];
  writeJSON(CLAUDE_INSTALLED_PLUGINS, installed);
}

/**
 * Ensure the quiet channel plugin is set up, returning the `--channels` ref to
 * launch with (e.g. "plugin:bukowski-channel@bukowski"), or null if it should
 * not be used (opted out, uninstall marker, or — unless forced — claude isn't
 * in use). Idempotent and safe to call on every launch.
 * @param {boolean} [force] - explicit install: ignore opt-outs and the marker.
 */
function ensureChannelPlugin(force = false) {
  if (!force) {
    if (process.env.BUKOWSKI_NO_CHANNEL_PLUGIN === '1' || process.env.BUKOWSKI_NO_CHANNEL_PLUGIN === 'true') return null;
    if (process.env.BUKOWSKI_NO_AUTO_INSTALL) return null;
    try { if (fs.existsSync(AUTO_INSTALL_MARKER)) return null; } catch { /* ignore */ }
    if (!_hasAgent('claude')) return null;
  }
  try {
    _writeChannelPluginFiles();
    _enableChannelPluginInSettings();
    _installChannelPluginCache();
    return CHANNEL_PLUGIN_REF;
  } catch {
    return null; // any failure falls back to the dangerous-flag path
  }
}

/**
 * Read-only: return the `--channels` ref if the channel plugin is enabled in
 * claude settings, else null. Used to compute launch args WITHOUT side effects
 * (so importing/spawning never writes config — only the explicit auto-install
 * step does). Setup happens in ensureChannelPlugin via autoInstallIfNeeded.
 */
function channelPluginRef() {
  const cfg = readJSON(CLAUDE_SETTINGS_PATH);
  return cfg?.enabledPlugins?.[CHANNEL_PLUGIN_KEY] === true ? CHANNEL_PLUGIN_REF : null;
}

/**
 * Remove the channel plugin: drop the settings keys and delete generated files.
 */
function uninstallChannelPlugin() {
  let changed = false;
  const cfg = readJSON(CLAUDE_SETTINGS_PATH);
  if (cfg) {
    if (cfg.extraKnownMarketplaces?.[CHANNEL_MARKETPLACE]) {
      delete cfg.extraKnownMarketplaces[CHANNEL_MARKETPLACE];
      if (Object.keys(cfg.extraKnownMarketplaces).length === 0) delete cfg.extraKnownMarketplaces;
      changed = true;
    }
    if (cfg.enabledPlugins?.[CHANNEL_PLUGIN_KEY] !== undefined) {
      delete cfg.enabledPlugins[CHANNEL_PLUGIN_KEY];
      if (Object.keys(cfg.enabledPlugins).length === 0) delete cfg.enabledPlugins;
      changed = true;
    }
    if (changed) writeJSON(CLAUDE_SETTINGS_PATH, cfg);
  }
  try { fs.rmSync(CHANNEL_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  return changed;
}

/**
 * Install bukowski MCP server for all agents
 */
function installAll() {
  // Explicit install: clear the "stay off" marker so future bukowski
  // startups will re-install if the user nukes the config later.
  try { fs.unlinkSync(AUTO_INSTALL_MARKER); } catch { /* ignore */ }

  const results = {
    claude: { installed: false, error: null },
    codex: { installed: false, error: null },
    gemini: { installed: false, error: null },
    channelPlugin: { installed: false, error: null }
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

  // Quiet `--channels plugin:...` path: generate the plugin, enable it in user
  // settings, AND populate Claude's plugin cache + install records so it loads.
  // force: this is an explicit install, so ignore the markers/agent check.
  try {
    results.channelPlugin.installed = !!ensureChannelPlugin(true);
  } catch (err) {
    results.channelPlugin.error = err.message;
  }

  return results;
}

/**
 * Uninstall bukowski MCP server from all agents
 */
function uninstallAll() {
  // Explicit uninstall: drop a marker so the next bukowski startup
  // doesn't quietly re-install behind the user's back.
  try {
    fs.mkdirSync(path.dirname(AUTO_INSTALL_MARKER), { recursive: true, mode: 0o700 });
    fs.writeFileSync(AUTO_INSTALL_MARKER, `${new Date().toISOString()}\n`);
  } catch { /* ignore */ }

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

  try {
    results.channelPlugin = { uninstalled: uninstallChannelPlugin() };
  } catch (err) {
    results.channelPlugin = { uninstalled: false, error: err.message };
  }

  return results;
}

/**
 * Per-agent "is the user even using this CLI?" probe. If neither the
 * config file exists nor the binary is on PATH, the user almost
 * certainly doesn't use the agent; auto-install skips it rather than
 * littering ~/.{claude,codex,gemini}* with config they didn't ask for.
 * Explicit `bukowski-mcp install` ignores this and writes everywhere.
 */
function _hasAgent(agent) {
  if (fs.existsSync(CONFIG_PATHS[agent])) return true;
  return commandExists(agent);
}

/**
 * Per-agent "is the bukowski entry missing OR pointing at a stale bridge
 * path?" check. Drives idempotent startup behavior so we only write
 * when something would actually change.
 */
function _claudeNeedsInstall() {
  const cfg = readJSON(CONFIG_PATHS.claude);
  const entry = cfg?.mcpServers?.bukowski;
  if (!entry) return true;
  if (entry.args?.[0] !== BRIDGE_SCRIPT) return true;
  return false;
}
function _codexNeedsInstall() {
  let content;
  try { content = fs.readFileSync(CONFIG_PATHS.codex, 'utf-8'); }
  catch { return true; }
  if (!content.includes('[mcp_servers.bukowski]')) return true;
  if (!content.includes(`"${BRIDGE_SCRIPT}"`)) return true;
  return false;
}
function _geminiNeedsInstall() {
  const cfg = readJSON(CONFIG_PATHS.gemini);
  const entry = cfg?.mcpServers?.bukowski;
  if (!entry) return true;
  if (entry.args?.[0] !== BRIDGE_SCRIPT) return true;
  return false;
}

/**
 * Idempotent auto-install for bukowski startup. Bails on
 * BUKOWSKI_NO_AUTO_INSTALL or the user's `bukowski-mcp uninstall`
 * marker; otherwise writes the bukowski entry for every agent that
 * looks like it's actually in use (config exists or binary on PATH)
 * and whose current entry is missing or stale. Returns a summary
 * `{ skipped?: string, installed: { claude, codex, gemini }, errors: {...} }`.
 */
function autoInstallIfNeeded() {
  if (process.env.BUKOWSKI_NO_AUTO_INSTALL) return { skipped: 'env' };
  try { if (fs.existsSync(AUTO_INSTALL_MARKER)) return { skipped: 'marker' }; }
  catch { /* ignore */ }

  const summary = {
    installed: { claude: false, codex: false, gemini: false },
    errors: {}
  };

  if (_hasAgent('claude') && _claudeNeedsInstall()) {
    try { installClaude(); summary.installed.claude = true; }
    catch (err) { summary.errors.claude = err.message; }
  }
  if (_hasAgent('codex') && _codexNeedsInstall()) {
    try { installCodex(); summary.installed.codex = true; }
    catch (err) { summary.errors.codex = err.message; }
  }
  if (_hasAgent('gemini') && _geminiNeedsInstall()) {
    try { installGemini(); summary.installed.gemini = true; }
    catch (err) { summary.errors.gemini = err.message; }
  }

  // Maintain the quiet channel plugin (generate files + enable in user
  // settings, idempotent). The plugin only actually registers as a channel once
  // it's on the effective allowlist via allowedChannelPlugins in
  // /etc/claude-code/managed-settings.json — that managed-tier file needs root,
  // so it's a one-time manual step (see `bukowski-mcp install` output / docs);
  // we can't write it from here. Until then the bootstrap falls back to the
  // dangerous flag.
  try { summary.installed.channelPlugin = !!ensureChannelPlugin(); }
  catch (err) { summary.errors.channelPlugin = err.message; }

  return summary;
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

  // Channel plugin (the quiet `--channels` path): enabled in claude settings
  // AND actually present in Claude's plugin cache. Enabled-but-uncached is the
  // silent-failure state (Claude loads no channel server), so report it as not
  // installed rather than trusting the settings flag alone.
  const claudeSettings = readJSON(CLAUDE_SETTINGS_PATH);
  const channelEnabled = claudeSettings?.enabledPlugins?.[CHANNEL_PLUGIN_KEY] === true;
  const channelCached = fs.existsSync(path.join(CLAUDE_PLUGIN_CACHE_DIR, '.mcp.json'));
  status.channelPlugin = {
    installed: channelEnabled && channelCached,
    configPath: CLAUDE_SETTINGS_PATH
  };

  return status;
}

module.exports = {
  installAll,
  uninstallAll,
  autoInstallIfNeeded,
  checkStatus,
  installClaude,
  installCodex,
  installGemini,
  uninstallClaude,
  uninstallCodex,
  uninstallGemini,
  ensureChannelPlugin,
  channelPluginRef,
  uninstallChannelPlugin,
  CONFIG_PATHS,
  BRIDGE_SCRIPT,
  AUTO_INSTALL_MARKER,
  CHANNEL_PLUGIN_REF
};
