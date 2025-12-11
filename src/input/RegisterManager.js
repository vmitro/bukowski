// src/input/RegisterManager.js - Vim registers system

class RegisterEntry {
  constructor(content = '', type = 'char') {
    this.content = content;  // String content
    this.type = type;        // 'char' | 'line'
  }
}

class AgentRegisterSet {
  constructor() {
    this.unnamed = new RegisterEntry();  // "" register
    this.yank = new RegisterEntry();     // "0 register (last yank)
    this.named = {};                     // a-z registers

    // Initialize named registers a-z
    for (let c = 97; c <= 122; c++) {
      this.named[String.fromCharCode(c)] = new RegisterEntry();
    }
  }

  /**
   * Get register by name
   * @param {string} name - Register name: '"' (unnamed), '0' (yank), 'a'-'z' (named)
   */
  get(name) {
    if (name === '"' || name === '' || name === null) {
      return this.unnamed;
    }
    if (name === '0') {
      return this.yank;
    }
    if (/^[a-z]$/.test(name)) {
      return this.named[name];
    }
    return null;
  }

  /**
   * Set register content
   * @param {string} name - Register name
   * @param {string} content - Content to store
   * @param {string} type - 'char' or 'line'
   * @param {boolean} append - If true, append to existing content
   */
  set(name, content, type, append = false) {
    let register;

    if (name === '"' || name === '' || name === null) {
      register = this.unnamed;
    } else if (name === '0') {
      register = this.yank;
    } else if (/^[a-z]$/.test(name)) {
      register = this.named[name];
    } else {
      return;
    }

    if (append && register.content) {
      register.content += (type === 'line' ? '\n' : '') + content;
      // Append makes it line-wise if either was line-wise
      if (type === 'line' || register.type === 'line') {
        register.type = 'line';
      }
    } else {
      register.content = content;
      register.type = type;
    }
  }
}

class RegisterManager {
  constructor() {
    this.agentRegisters = new Map();  // agentId -> AgentRegisterSet
    this.clipboard = new RegisterEntry();  // + and * registers (system clipboard)
  }

  /**
   * Get or create register set for an agent
   */
  getOrCreateAgentSet(agentId) {
    if (!this.agentRegisters.has(agentId)) {
      this.agentRegisters.set(agentId, new AgentRegisterSet());
    }
    return this.agentRegisters.get(agentId);
  }

  /**
   * Get register content for an agent
   * @param {string} agentId - Agent ID
   * @param {string} registerName - Register name
   */
  get(agentId, registerName) {
    const name = registerName?.toLowerCase() || '"';

    // System clipboard registers
    if (name === '+' || name === '*') {
      return this.clipboard;
    }

    const agentSet = this.getOrCreateAgentSet(agentId);
    return agentSet.get(name);
  }

  /**
   * Set register content
   * @param {string} agentId - Agent ID
   * @param {string} registerName - Register name
   * @param {string} content - Content to store
   * @param {string} type - 'char' or 'line'
   * @param {boolean} append - If true, append to existing
   */
  set(agentId, registerName, content, type, append = false) {
    const name = registerName?.toLowerCase() || '"';

    // System clipboard registers
    if (name === '+' || name === '*') {
      this.setClipboard(content);
      return;
    }

    const agentSet = this.getOrCreateAgentSet(agentId);
    agentSet.set(name, content, type, append);
  }

  /**
   * Set system clipboard via OSC 52
   */
  setClipboard(content) {
    this.clipboard = new RegisterEntry(content, 'char');
    const b64 = Buffer.from(content).toString('base64');
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
  }

  /**
   * Yank operation - updates unnamed, yank register, and optionally a named register
   * @param {string} agentId - Agent ID
   * @param {string} content - Content to yank
   * @param {string} type - 'char' or 'line'
   * @param {string} targetRegister - Optional specific register (null = unnamed only)
   * @param {boolean} append - Append mode (for A-Z registers)
   */
  yank(agentId, content, type, targetRegister = null, append = false) {
    const agentSet = this.getOrCreateAgentSet(agentId);

    // Always update unnamed register
    agentSet.set('"', content, type);

    // Always update "0 (last yank)
    agentSet.set('0', content, type);

    // If specific register requested, update it too
    if (targetRegister && /^[a-z]$/.test(targetRegister.toLowerCase())) {
      agentSet.set(targetRegister.toLowerCase(), content, type, append);
    }
  }

  /**
   * Clean up registers for a removed agent
   */
  removeAgent(agentId) {
    this.agentRegisters.delete(agentId);
  }
}

module.exports = { RegisterManager, RegisterEntry, AgentRegisterSet };
