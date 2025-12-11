// src/core/Session.js - Session class with serialization

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Default session directory
const DEFAULT_SESSION_DIR = path.join(os.homedir(), '.config', 'bukowski', 'sessions');

class Session {
  constructor(name) {
    this.id = crypto.randomUUID();
    this.name = name;
    this.agents = new Map();      // agentId -> Agent
    this.layout = null;           // Root LayoutNode (Container or Pane)
    this.focusedPaneId = null;    // Track focused pane for restore
    this.ipcHub = null;           // IPCHub instance
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
  }

  addAgent(agent) {
    this.agents.set(agent.id, agent);
    this.updatedAt = new Date().toISOString();
  }

  removeAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.kill();
      this.agents.delete(agentId);
      this.updatedAt = new Date().toISOString();
    }
  }

  getAgent(agentId) {
    return this.agents.get(agentId);
  }

  getAllAgents() {
    return Array.from(this.agents.values());
  }

  // Serialization
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      agents: Array.from(this.agents.values()).map(a => a.toJSON()),
      layout: this.layout?.toJSON() ?? null,
      focusedPaneId: this.focusedPaneId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  static fromJSON(data, AgentClass, LayoutNodeClass) {
    const session = new Session(data.name);
    session.id = data.id;
    session.createdAt = data.createdAt;
    session.updatedAt = data.updatedAt;
    session.focusedPaneId = data.focusedPaneId || null;

    // Reconstruct agents
    for (const agentData of data.agents) {
      const agent = AgentClass.fromJSON(agentData);
      session.agents.set(agent.id, agent);
    }

    // Reconstruct layout
    if (data.layout) {
      session.layout = LayoutNodeClass.fromJSON(data.layout);
    }

    return session;
  }

  async save(dir = DEFAULT_SESSION_DIR) {
    await fs.promises.mkdir(dir, { recursive: true });
    const filepath = path.join(dir, `${this.id}.json`);
    await fs.promises.writeFile(filepath, JSON.stringify(this.toJSON(), null, 2));
    return filepath;
  }

  static async load(filepath, AgentClass, LayoutNodeClass) {
    const data = JSON.parse(await fs.promises.readFile(filepath, 'utf-8'));
    return Session.fromJSON(data, AgentClass, LayoutNodeClass);
  }

  /**
   * Load session by ID or name
   */
  static async loadByIdOrName(idOrName, AgentClass, LayoutNodeClass, dir = DEFAULT_SESSION_DIR) {
    const sessions = await Session.listSessions(dir);

    // Try exact ID match first
    let match = sessions.find(s => s.id === idOrName);

    // Try name match
    if (!match) {
      match = sessions.find(s => s.name.toLowerCase() === idOrName.toLowerCase());
    }

    // Try partial ID match
    if (!match) {
      match = sessions.find(s => s.id.startsWith(idOrName));
    }

    if (match) {
      return Session.load(match.filepath, AgentClass, LayoutNodeClass);
    }

    return null;
  }

  /**
   * Get the most recent session
   */
  static async loadLatest(AgentClass, LayoutNodeClass, dir = DEFAULT_SESSION_DIR) {
    const sessions = await Session.listSessions(dir);
    if (sessions.length === 0) return null;
    return Session.load(sessions[0].filepath, AgentClass, LayoutNodeClass);
  }

  static async listSessions(dir = DEFAULT_SESSION_DIR) {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const files = await fs.promises.readdir(dir);
      const sessions = [];
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filepath = path.join(dir, file);
          try {
            const data = JSON.parse(await fs.promises.readFile(filepath, 'utf-8'));
            sessions.push({
              id: data.id,
              name: data.name,
              agentCount: data.agents.length,
              updatedAt: data.updatedAt,
              filepath
            });
          } catch {
            // Skip invalid session files
          }
        }
      }
      return sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch {
      return [];
    }
  }

  static getSessionDir() {
    return DEFAULT_SESSION_DIR;
  }

  destroy() {
    for (const agent of this.agents.values()) {
      agent.kill();
    }
    this.agents.clear();
    if (this.ipcHub) {
      this.ipcHub.stop();
    }
  }
}

module.exports = { Session };
