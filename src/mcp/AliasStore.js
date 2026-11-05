'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * Durable store for self-chosen agent names (register_agent alias), scoped to
 * ONE instance.
 *
 * Why it exists: the claim map used to be purely in-memory, so every pane
 * respawn wiped every name — the identity an agent was told to prefer
 * *because* seat ids churn did not survive the restart it was meant to
 * outlive (bug-31 follow-up). Agents had to re-claim before anyone could
 * address them again, and a sender holding a name got "Unknown agent".
 *
 * Scope is per-instance and keyed by cwd, not box-wide, and that is deliberate.
 * A box-wide claim is the stable identity you actually want, but it also lets a
 * stale record shadow a LIVE agent on any instance — the bug-21 failure mode,
 * made durable. Keeping the blast radius inside one instance bounds that.
 *
 * Nothing here is authoritative about routing. A loaded claim is a RECORD, not
 * a binding: MCPServer only resolves one once the agent it names exists again,
 * so an unbound claim can never shadow anybody. See _rebindPersisted.
 */
class AliasStore {
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.root = opts.root
      || process.env.BUKOWSKI_ALIAS_ROOT
      || path.join(os.homedir(), '.bukowski', 'aliases');
    // A name claimed once must not hold forever against an agent that never
    // comes back, or a retired seat squats a name nobody can reuse. Pruned on
    // load against lastSeen, which every claim and rebind refreshes.
    const days = parseFloat(process.env.BUKOWSKI_ALIAS_TTL_DAYS);
    this.ttlMs = (Number.isFinite(days) && days > 0 ? days : 14) * 86400000;
    // cwd basename is readable; the hash disambiguates two checkouts that
    // share one (…/azra/azra vs …/azra).
    const slug = (path.basename(this.cwd) || 'instance').replace(/[^a-zA-Z0-9_-]/g, '_');
    const hash = crypto.createHash('sha256').update(this.cwd).digest('hex').slice(0, 8);
    this.file = path.join(this.root, `${slug}-${hash}.json`);
  }

  /**
   * Claims that are still inside the TTL, as alias -> record. Never throws: a
   * missing, unreadable or corrupt file means "no claims", because losing a
   * convenience name must not stop an instance booting.
   */
  load() {
    const out = new Map();
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return out;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return out;
    }
    const claims = parsed && typeof parsed.claims === 'object' ? parsed.claims : {};
    const now = Date.now();
    for (const [alias, rec] of Object.entries(claims)) {
      if (!rec || typeof rec !== 'object' || !rec.agentId) continue;
      const lastSeen = Number(rec.lastSeen) || 0;
      if (now - lastSeen > this.ttlMs) continue; // expired
      out.set(String(alias).toLowerCase(), {
        agentId: String(rec.agentId),
        agentType: rec.agentType ? String(rec.agentType) : null,
        claimedAt: Number(rec.claimedAt) || lastSeen,
        lastSeen,
      });
    }
    return out;
  }

  /** Write the map back. Best-effort and atomic-ish: tmp + rename, never partial. */
  save(claims) {
    try {
      fs.mkdirSync(this.root, { recursive: true });
      const body = {
        version: 1,
        cwd: this.cwd,
        instance: path.basename(this.cwd),
        updatedAt: Date.now(),
        claims: Object.fromEntries(claims),
      };
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { AliasStore };
