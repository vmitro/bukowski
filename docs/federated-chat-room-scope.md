# Scope: Federated Chat Room (room as FIPA-addressable agent proxy)

Status: proposed · depends on shipped `machineHost`/`via` roster (fd33b9c) + multi-hop message relay (9e0df65).

## Problem
A chat room is a session-local pseudo-agent and cannot receive from another session.

- Room = `new ChatAgent(convId, …)`, id `chat-<convId>`, `type:'chat'`, `pty:null` (`multi.js:1760`, `ChatAgent.js:15`).
- Federation gate excludes it two ways: `isFederatable = !!agent && agent.type !== 'chat' && !!agent.pty` (`multi.js:879`). Rooms never get a `federatedId`, never enter peers' `remoteAgents`.
- `to="user"` is local-only: delivered out-of-band via ConversationManager, never federated (`IPCHub.js:233`).
- Inbound federated msg to a room fails: `injectFederatedMessage` does `agentSockets.get(to)` → room has no socket → `delivery:failed 'federated_target_not_local'` (`IPCHub.js:271`).

Result: only agents **co-located with the room host** post into it. (Observed: only 1blu's `hi` reached the room — 1blu is where the room is hosted.)

## Goal
Any agent on any box can address a room; a message to it fans out to **all participants** — remote agents (any box) + the human at the host terminal.

## Design — host session as a fan-out reflector
Reuse the shipped roster path-vector + multi-hop relay. The room's HOST session advertises the room as a federated agent and reflects inbound messages.

1. **Identity.** `chat-<convId>` is already a UUID (globally unique). Keep it as the federated id; carry host truthfully via the existing `machineHost`/`via` roster fields. (No host-qualifying rename needed.)

2. **Pass the federation gate** (`multi.js:879`). Add a room branch so a *shared* room federates: `isFederatable(agent) || isSharedRoom(agent)`. Private per-agent chats must stay LOCAL — gate on a `shared` flag, not just `type==='chat'`. `snapshotLocalRoster` then includes the room with `federatedId = chat-<convId>`, `type:'chat'`.

3. **Advertise + learn** (no new code). Room enters `snapshotLocalRoster` → `announceLocalAgent` → path-vector gossip → peers' `remoteAgents` gain it. `list_agents` everywhere shows the room (`type:chat`, truthful host + via).

4. **Inbound routing** (send TO room). Remote sender → `forwardIpcMessage(chat-<convId>)` → `forwardTo(via)` → multi-hop relay carries to host (all shipped). At host, `injectFederatedMessage` must special-case a room target: instead of a socket lookup that fails, hand to a **room handler**.

5. **Reflector** (the new core). On a message reaching the room (local OR federated), the host delivers to every participant except the sender:
   - human → record in ConversationManager (ChatAgent renders) — existing;
   - local agents → `queueMessage` + `notifyNewMessage` channel push — existing (handle codex-poll vs claude-push);
   - remote agents → `forwardIpcMessage` per remote participant — NEW.

6. **Reverse direction** (human → room). Human's room post must also federate outbound to remote participant agents, not just local channel push. NEW in the room-send path (`FIPAHub.send`).

7. **Loop/echo suppression: single-reflector model.** ONLY the room host fans out. A remote agent receiving a room message just delivers locally, never re-fans. Sender is skipped. `hops` (shipped) guards the transport. No dedup engine needed.

## Membership
- **MVP — implicit:** room reflects to ALL agents the host knows (its `remoteAgents` + local) + the human. No membership state. Matches the "everyone say hi" broadcast semantics.
- **Full — explicit:** agents join/leave; membership gossiped like the roster. Enables scoping + multi-room.

## MVP ("faux FIPA'able agent proxy") — minimum to make cross-session room chat work
1. Federate shared rooms (relax gate, advertise `chat-<convId>`). — `multi.js`
2. Room inbound target handled in `injectFederatedMessage` (→ room handler, not `delivery:failed`). — `IPCHub.js`
3. Reflector: host fans room msg to human + all known agents (local queue + remote `forwardIpcMessage`), skip sender, single-reflector no re-fan. — new wiring in `multi.js` / `FIPAHub`
4. Human's room posts federate outbound to remote agents. — `FIPAHub.send` room path

## Changed files (est.)
- `multi.js` — room federatable branch; `snapshotLocalRoster` includes room; reflector wiring.
- `src/ipc/IPCHub.js` — room inbound target (not `delivery:failed`).
- `src/acl/FIPAHub.js` — room send path federates outbound + drives reflector.
- `src/acl/ConversationManager.js` / `ChatAgent.js` — minor: accept federated room msgs.
- Reuses `FederationHub` roster + relay unchanged.

## Edge cases / risks
- Room-host down → room unreachable (acceptable, like any agent; host is a SPOF for its rooms).
- Multi-human: MVP shows the room only to the HOST's human + all agents; a remote box's human seeing it needs full membership / a room proxy per box.
- Sender identity across hops — reuse `_federatedTo` rewriting.
- Channel push is claude-only; fanout must also serve codex (poll) participants.
- Must NOT federate private per-agent chats — gate on `shared`, verify.

## Effort
- MVP: **medium**, ~1 focused session. Roster + relay already exist; new work = reflector + inbound room target + outbound federation of human posts.
- Full (federated membership, multi-human, join/leave): larger, separate.

## Open questions (need user calls)
1. Membership: implicit broadcast-to-all (MVP) vs explicit join/leave?
2. Multi-human: must a remote box's human also see the room, or just agents + host human?
3. Reflector: single-host (simple, SPOF) vs every-node re-fan (needs dedup)? — recommend single-host for MVP.
4. Scope of "shared room": all rooms federate, or an explicit opt-in flag?
