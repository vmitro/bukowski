// src/utils/agentSessions.js - Agent session directory utilities

const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Escape a path for Claude's project directory naming scheme
 * e.g., /home/user/foo → -home-user-foo
 * Note: Claude keeps the leading dash from the root /
 */
function escapePathForClaude(p) {
  return p.replace(/\//g, '-');
}

/**
 * Get the session directory for an agent type
 * Checks multiple platform-specific locations
 * @param {string} agentType - 'claude', 'codex', or 'gemini'
 * @param {string} cwd - Current working directory (used by Claude)
 * @returns {string|null} Path to session directory or null if not found
 */
function getSessionDir(agentType, cwd) {
  const home = os.homedir();
  const appData = process.env.APPDATA;

  const candidates = {
    claude: [
      path.join(home, '.claude', 'projects', escapePathForClaude(cwd)),
      appData && path.join(appData, 'Claude', 'projects', escapePathForClaude(cwd))
    ].filter(Boolean),
    codex: [
      path.join(home, '.codex', 'sessions'),
      appData && path.join(appData, 'codex', 'sessions')
    ].filter(Boolean),
    gemini: [
      path.join(home, '.gemini', 'tmp'),
      appData && path.join(appData, 'gemini', 'tmp')
    ].filter(Boolean)
  };

  const paths = candidates[agentType];
  if (!paths) return null;

  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // Ignore access errors
    }
  }

  return null;
}

/**
 * Extract session UUID from a session filename
 * @param {string} agentType - Agent type
 * @param {string} filename - Session filename
 * @returns {string|null} Session UUID or null
 */
function extractSessionId(agentType, filename) {
  switch (agentType) {
    case 'claude': {
      // {uuid}.jsonl → uuid (validate UUID format)
      if (filename.endsWith('.jsonl')) {
        const id = path.basename(filename, '.jsonl');
        // Validate it's a proper UUID
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          return id;
        }
      }
      return null;
    }

    case 'codex':
      // rollout-2025-09-03T10-24-19-{uuid}.jsonl → uuid
      const codexMatch = filename.match(/-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i);
      return codexMatch?.[1] || null;

    case 'gemini':
      // session-2025-12-13T08-25-{id}.json → id
      const geminiMatch = filename.match(/-([a-f0-9]+)\.json$/i);
      return geminiMatch?.[1] || null;

    default:
      return null;
  }
}

/**
 * Extract creation timestamp from session filename
 * @param {string} agentType - Agent type
 * @param {string} filename - Session filename
 * @returns {number|null} Timestamp in ms or null
 */
function extractCreationTime(agentType, filename) {
  switch (agentType) {
    case 'codex': {
      // rollout-2025-12-13T11-18-09-{uuid}.jsonl
      const match = filename.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/);
      if (match) {
        const [, year, month, day, hour, min, sec] = match;
        return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`).getTime();
      }
      return null;
    }
    case 'gemini': {
      // session-2025-12-13T08-25-{id}.json
      const match = filename.match(/session-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-/);
      if (match) {
        const [, year, month, day, hour, min] = match;
        return new Date(`${year}-${month}-${day}T${hour}:${min}:00`).getTime();
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Find ALL Codex session directories (not just today's)
 * Codex organizes sessions as: ~/.codex/sessions/{year}/{month}/{day}/
 * We need to search all directories because resumed sessions may be in older date folders
 * @param {string} baseDir - Base sessions directory
 * @returns {Promise<string[]>} Array of all date directory paths
 */
async function findAllCodexDateDirs(baseDir) {
  const dirs = [];
  try {
    const years = await fs.promises.readdir(baseDir);
    for (const year of years) {
      const yearPath = path.join(baseDir, year);
      try {
        const months = await fs.promises.readdir(yearPath);
        for (const month of months) {
          const monthPath = path.join(yearPath, month);
          try {
            const days = await fs.promises.readdir(monthPath);
            for (const day of days) {
              dirs.push(path.join(monthPath, day));
            }
          } catch {
            // Ignore errors for individual month dirs
          }
        }
      } catch {
        // Ignore errors for individual year dirs
      }
    }
  } catch {
    // Ignore errors
  }
  return dirs;
}

/**
 * Find Gemini's chat directory (inside tmp/{hash}/chats/)
 * @param {string} baseDir - Base tmp directory
 * @returns {Promise<string|null>} Path to chats directory or null
 */
async function findGeminiChatDir(baseDir) {
  try {
    const entries = await fs.promises.readdir(baseDir);
    for (const entry of entries) {
      const chatDir = path.join(baseDir, entry, 'chats');
      try {
        await fs.promises.access(chatDir);
        return chatDir;
      } catch {
        // Not this one
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Extract full session ID from Gemini session file content
 * @param {string} filepath - Path to session JSON file
 * @returns {Promise<string|null>} Full session UUID or null
 */
async function extractGeminiSessionIdFromFile(filepath) {
  try {
    const content = await fs.promises.readFile(filepath, 'utf-8');
    const data = JSON.parse(content);
    return data.sessionId || null;
  } catch {
    return null;
  }
}

/**
 * Extract cwd from Codex session file (first line contains SessionMeta)
 * @param {string} filepath - Path to session JSONL file
 * @returns {Promise<string|null>} Working directory or null
 */
async function extractCodexSessionCwd(filepath) {
  try {
    const readline = require('readline');
    const stream = fs.createReadStream(filepath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      rl.close();
      stream.destroy();
      const data = JSON.parse(line);
      return data.cwd || null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Find the most recently modified session file after startTime
 * Searches all relevant directories for the agent type
 * @param {string} agentType - Agent type
 * @param {string} cwd - Current working directory
 * @param {number} startTime - Timestamp (ms) - only consider files modified after this
 * @param {Set<string>} excludeIds - Session IDs to exclude (already assigned to other agents)
 * @returns {Promise<string|null>} Session UUID or null
 */
async function findLatestSession(agentType, cwd, startTime, excludeIds = new Set()) {
  const baseDir = getSessionDir(agentType, cwd);
  if (!baseDir) return null;

  // Get all directories to search
  let searchDirs;
  switch (agentType) {
    case 'claude':
      searchDirs = [baseDir];
      break;
    case 'codex':
      // Search ALL date directories - resumed sessions may be in older folders
      searchDirs = await findAllCodexDateDirs(baseDir);
      break;
    case 'gemini': {
      const geminiDir = await findGeminiChatDir(baseDir);
      searchDirs = geminiDir ? [geminiDir] : [];
      break;
    }
    default:
      return null;
  }

  if (searchDirs.length === 0) return null;

  let newestFile = null;
  let newestFilePath = null;
  let newestMtime = 0;

  // Search all directories for the most recently modified session
  for (const searchDir of searchDirs) {
    try {
      const files = await fs.promises.readdir(searchDir);

      for (const file of files) {
        // Skip non-session files
        if (agentType === 'claude' && !file.endsWith('.jsonl')) continue;
        if (agentType === 'codex' && !file.endsWith('.jsonl')) continue;
        if (agentType === 'gemini' && !file.endsWith('.json')) continue;

        // Extract session ID early to check exclusion
        const sessionId = extractSessionId(agentType, file);
        if (sessionId && excludeIds.has(sessionId)) continue;

        // Use mtime (last modified) to find the active session
        // This handles both new sessions AND resumed older sessions
        const filepath = path.join(searchDir, file);
        let mtime;
        try {
          const stat = await fs.promises.stat(filepath);
          mtime = stat.mtimeMs;
        } catch {
          continue;
        }

        // For Codex, filter by cwd to scope sessions to current directory
        if (agentType === 'codex') {
          const sessionCwd = await extractCodexSessionCwd(filepath);
          if (sessionCwd && sessionCwd !== cwd) {
            continue; // Skip sessions from other directories
          }
        }

        // Find the session most recently MODIFIED after startTime
        if (mtime > startTime && mtime > newestMtime) {
          newestMtime = mtime;
          newestFile = file;
          newestFilePath = filepath;
        }
      }
    } catch {
      // Ignore errors for individual directories
      continue;
    }
  }

  if (!newestFile) return null;

  // For Gemini, read the file to get full UUID (filename only has short prefix)
  if (agentType === 'gemini') {
    return await extractGeminiSessionIdFromFile(newestFilePath);
  }

  // For Claude/Codex, extract from filename
  return extractSessionId(agentType, newestFile);
}

module.exports = {
  getSessionDir,
  extractSessionId,
  extractCreationTime,
  findLatestSession,
  escapePathForClaude
};
