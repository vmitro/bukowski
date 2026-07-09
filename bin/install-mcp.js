#!/usr/bin/env node
// bin/install-mcp.js — privileged, idempotent installer.
//
// Run with sudo:   sudo npm run install-mcp
//
// Does two things:
//   1. (root) Allowlists the bukowski channel plugin in the Claude Code managed
//      settings file (/etc/claude-code/managed-settings.json) by setting
//      channelsEnabled:true and adding {marketplace:"bukowski",
//      plugin:"bukowski-channel"} to allowedChannelPlugins. This is the ONLY
//      tier that honors allowedChannelPlugins, and it's what lets the QUIET
//      `--channels plugin:bukowski-channel@bukowski` flag actually register the
//      channel (otherwise the custom plugin is silently ignored).
//   2. Installs the bukowski MCP server + channel plugin for the INVOKING user
//      (claude/codex/gemini configs under their home), via `bukowski-mcp
//      install`. When run under sudo we drop back to $SUDO_USER so those files
//      land in the real user's home and stay owned by them, not root.
//
// Idempotent: re-running merges (never duplicates) the allowlist entry and
// rewrites the same user config. Existing managed-settings keys are preserved.
//
// The managed-settings path can be overridden with BUKOWSKI_MANAGED_SETTINGS_FILE
// (used by tests). Channel identity must match what install.js generates.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MANAGED_FILE = process.env.BUKOWSKI_MANAGED_SETTINGS_FILE
  || '/etc/claude-code/managed-settings.json';
const MARKETPLACE = 'bukowski';
const PLUGIN = 'bukowski-channel';
const BUKOWSKI_MCP_BIN = path.resolve(__dirname, 'bukowski-mcp');

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Merge the channel allowlist into the managed settings file (idempotent).
 * Preserves any other keys already present. Returns a small status object.
 */
function allowlistChannelPlugin(file = MANAGED_FILE) {
  let cfg = {};
  let existed = false;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    existed = true;
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  } catch { /* new or unreadable -> start fresh */ }

  cfg.channelsEnabled = true;
  if (!Array.isArray(cfg.allowedChannelPlugins)) cfg.allowedChannelPlugins = [];
  const already = cfg.allowedChannelPlugins.some(
    (e) => e && e.marketplace === MARKETPLACE && e.plugin === PLUGIN
  );
  if (!already) cfg.allowedChannelPlugins.push({ marketplace: MARKETPLACE, plugin: PLUGIN });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return { file, fileExisted: existed, added: !already };
}

/** Resolve the invoking (non-root) user's name + home when running under sudo. */
function realUser() {
  const name = process.env.SUDO_USER;
  if (!name || name === 'root') return null;
  let home = null;
  try {
    const line = execFileSync('getent', ['passwd', name], { encoding: 'utf8' }).trim();
    home = line.split(':')[5] || null;
  } catch { /* getent unavailable */ }
  if (!home) home = path.join('/home', name);
  return { name, home };
}

/**
 * Install the per-user MCP config + channel plugin. Under sudo, drop to the
 * real user (with their HOME) so files are written to and owned by them.
 */
function installForUser() {
  const user = realUser();
  if (isRoot() && user) {
    // env sets HOME/PATH for the dropped process so os.homedir() and any
    // `which <agent>` resolve against the real user, not root.
    execFileSync(
      'sudo',
      ['-u', user.name, 'env', `HOME=${user.home}`, `PATH=${process.env.PATH || ''}`,
        process.execPath, BUKOWSKI_MCP_BIN, 'install'],
      { stdio: 'inherit' }
    );
    return user.name;
  }
  // Not under sudo (or genuine root): install in-process for the current user.
  require('../src/mcp/install').installAll();
  return null;
}

function main() {
  const root = isRoot();
  console.log('bukowski install-mcp\n');

  // 1. Channel allowlist (root-only file).
  if (root) {
    try {
      const r = allowlistChannelPlugin();
      console.log(r.added
        ? `✓ allowlisted ${PLUGIN}@${MARKETPLACE} in ${r.file}`
        : `✓ ${PLUGIN}@${MARKETPLACE} already allowlisted in ${r.file}`);
      console.log('  (channelsEnabled: true)');
    } catch (err) {
      console.error(`✗ failed writing ${MANAGED_FILE}: ${err.message}`);
      process.exitCode = 1;
    }
  } else {
    console.log(`- skipping channel allowlist: ${MANAGED_FILE} needs root.`);
    console.log('  Re-run with:  sudo npm run install-mcp');
  }

  // 2. Per-user MCP + plugin install.
  try {
    const asUser = installForUser();
    console.log(asUser
      ? `\n✓ installed MCP server + channel plugin for user "${asUser}"`
      : '\n✓ installed MCP server + channel plugin for current user');
  } catch (err) {
    console.error(`\n✗ user install failed: ${err.message}`);
    process.exitCode = 1;
  }

  if (root) {
    console.log('\nDone. Restart bukowski; claude agents launch with '
      + '`--channels plugin:bukowski-channel@bukowski` (quiet, no warning).');
    console.log('Note: allowedChannelPlugins REPLACES the default Anthropic channel '
      + 'allowlist — add any official channel plugins you use to '
      + `${MANAGED_FILE} too.`);
  }
}

if (require.main === module) main();

module.exports = { allowlistChannelPlugin, realUser, MANAGED_FILE, MARKETPLACE, PLUGIN };
