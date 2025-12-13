// src/utils/agentSessions.js - Agent session directory utilities

const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Escape a path for Claude's project directory naming scheme
 * e.g., /home/user/foo → -home-user-foo
 */
function escapePathForClaude(p) {
  return p.replace(/\//g, '-').replace(/^-/, '');
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
    case 'claude':
      // {uuid}.jsonl → uuid
      if (filename.endsWith('.jsonl')) {
        return path.basename(filename, '.jsonl');
      }
      return null;

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
 * Find the current date directory for Codex sessions
 * Codex organizes sessions as: ~/.codex/sessions/{year}/{month}/{day}/
 * @param {string} baseDir - Base sessions directory
 * @returns {Promise<string|null>} Path to today's session directory or null
 */
async function findCodexDateDir(baseDir) {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');

  const todayDir = path.join(baseDir, year, month, day);
  try {
    await fs.promises.access(todayDir);
    return todayDir;
  } catch {
    // Today's dir doesn't exist, try to find most recent
    try {
      const years = await fs.promises.readdir(baseDir);
      const sortedYears = years.sort().reverse();
      for (const y of sortedYears) {
        const yearPath = path.join(baseDir, y);
        const months = await fs.promises.readdir(yearPath);
        const sortedMonths = months.sort().reverse();
        for (const m of sortedMonths) {
          const monthPath = path.join(yearPath, m);
          const days = await fs.promises.readdir(monthPath);
          const sortedDays = days.sort().reverse();
          if (sortedDays.length > 0) {
            return path.join(monthPath, sortedDays[0]);
          }
        }
      }
    } catch {
      // Ignore errors
    }
  }
  return null;
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
 * Find the first session file created after startTime
 * For Codex/Gemini, uses filename timestamp; for Claude, uses file mtime
 * @param {string} agentType - Agent type
 * @param {string} cwd - Current working directory
 * @param {number} startTime - Timestamp (ms) - only consider files created after this
 * @returns {Promise<string|null>} Session UUID or null
 */
async function findLatestSession(agentType, cwd, startTime) {
  const baseDir = getSessionDir(agentType, cwd);
  if (!baseDir) return null;

  let searchDir;
  switch (agentType) {
    case 'claude':
      searchDir = baseDir;
      break;
    case 'codex':
      searchDir = await findCodexDateDir(baseDir);
      break;
    case 'gemini':
      searchDir = await findGeminiChatDir(baseDir);
      break;
    default:
      return null;
  }

  if (!searchDir) return null;

  try {
    const files = await fs.promises.readdir(searchDir);
    let oldest = null;
    let oldestTime = Infinity;

    for (const file of files) {
      // Skip non-session files
      if (agentType === 'claude' && !file.endsWith('.jsonl')) continue;
      if (agentType === 'codex' && !file.endsWith('.jsonl')) continue;
      if (agentType === 'gemini' && !file.endsWith('.json')) continue;

      // Get creation time - from filename for Codex/Gemini, from mtime for Claude
      let createTime;
      if (agentType === 'codex' || agentType === 'gemini') {
        createTime = extractCreationTime(agentType, file);
      }

      if (!createTime) {
        // Fallback to file mtime
        const filepath = path.join(searchDir, file);
        try {
          const stat = await fs.promises.stat(filepath);
          createTime = stat.mtimeMs;
        } catch {
          continue;
        }
      }

      // Find the FIRST (oldest) session created after startTime
      if (createTime > startTime && createTime < oldestTime) {
        oldestTime = createTime;
        oldest = file;
      }
    }

    return oldest ? extractSessionId(agentType, oldest) : null;
  } catch {
    return null;
  }
}

module.exports = {
  getSessionDir,
  extractSessionId,
  extractCreationTime,
  findLatestSession,
  escapePathForClaude
};
