// game3d/net/transport.js — the Transport contract shared by the netcode (session/replica) and
// the matchmaking layer, plus two serverless test transports. See game3d/net/CONTRACT.md.
//
// A Transport connects the local peer to the other peers of ONE room (star topology in practice:
// clients talk to the host, the host talks to everybody).
//
//   transport.selfId                     string, unique per peer
//   transport.hostId                     peer id of the room host
//   transport.isHost                     selfId === hostId
//   transport.peers()                    ids of the connected peers (without self)
//   transport.send(channel, data, to)    data: JSON-serialisable value or Uint8Array;
//                                        to: peer id, array of ids, or undefined = everybody
//   transport.on(channel, fn(data, from))  one handler per channel; a later call replaces it
//   transport.onPeerJoin(fn(id)), transport.onPeerLeave(fn(id))
//   transport.leave()
//
// Channel names are at most 12 ASCII characters.
// Delivery is ordered per peer and reliable. Messages are never delivered to the sender.
// One exception in the real transport (relay.js): the channels `snap` and `cmd` are "latest
// wins" — a message lost on the relay is not repeated and a stale one is dropped, because each
// carries a complete state. The test transports below deliver everything.
// The real transport also offers link(id) -> { via: 'direct'|'relay', rtt }, onRoute(fn) and
// stats(); callers must treat them as optional.

export const NET_VERSION = 2;          // 2: squadrons in the snapshot, air commands (carriers in net games)

class BaseTransport {
   constructor(selfId, hostId) {
      this.selfId = selfId; this.hostId = hostId;
      this._on = new Map(); this._peers = new Set(); this._join = null; this._leave = null;
   }
   get isHost() { return this.selfId === this.hostId; }
   peers() { return [...this._peers]; }
   on(channel, fn) { this._on.set(channel, fn); }
   onPeerJoin(fn) { this._join = fn; }
   onPeerLeave(fn) { this._leave = fn; }
   _deliver(channel, data, from) { this._on.get(channel)?.(data, from); }
   _addPeer(id) { if (id !== this.selfId && !this._peers.has(id)) { this._peers.add(id); this._join?.(id); } }
   _dropPeer(id) { if (this._peers.delete(id)) this._leave?.(id); }
}

const wants = (to, id) => to === undefined || to === id || (Array.isArray(to) && to.includes(id));
const copy = (data) => data instanceof Uint8Array ? data.slice() : structuredClone(data);

// ---- in-memory hub for node tests: every transport made by one hub is in the same room.
// opts.latency (ms) and opts.jitter (ms) delay delivery through opts.schedule(fn, ms)
// (default setTimeout); latency 0 delivers synchronously. Order per sender is preserved.
export function makeMemoryHub(opts = {}) {
   const members = new Map();
   const latency = opts.latency || 0, jitter = opts.jitter || 0, rand = opts.rand || Math.random;
   const schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
   let hostId = null;
   class MemoryTransport extends BaseTransport {
      constructor(id) { super(id, hostId); this._due = 0; }
      send(channel, data, to) {
        const payload = copy(data);
        for (const [id, t] of members) {
           if (id === this.selfId || !wants(to, id)) continue;
           const run = () => { if (members.has(id)) t._deliver(channel, copy(payload), this.selfId); };
           if (!latency && !jitter) run();
           else { this._due = Math.max(this._due + 0.001, (opts.now?.() ?? Date.now()) + latency + rand() * jitter); schedule(run, this._due - (opts.now?.() ?? Date.now())); }
        }
      }
      leave() {
         if (!members.delete(this.selfId)) return;
         for (const t of members.values()) t._dropPeer(this.selfId);
         this._peers.clear();
      }
   }
   return {
      // the first join() is the host
      join(id) {
         if (hostId === null) hostId = id;
         const t = new MemoryTransport(id);
         for (const [oid, o] of members) { t._peers.add(oid); o._addPeer(id); }
         members.set(id, t);
         return t;
      },
   };
}

// ---- BroadcastChannel transport: tabs / pages of one browser profile on the same origin.
// For browser tests and local two-tab play (no network). `room` names the channel.
export function makeLocalTransport(room, selfId, hostId) {
   const bc = new BroadcastChannel('ks-net-' + room);
   const t = new (class extends BaseTransport {
      send(channel, data, to) { bc.postMessage({ k: 'm', c: channel, d: data, f: selfId, to }); }
      leave() { bc.postMessage({ k: 'bye', f: selfId }); bc.close(); this._peers.clear(); }
   })(selfId, hostId);
   bc.onmessage = (e) => {
      const m = e.data;
      if (!m || m.f === selfId) return;
      if (m.k === 'hi') { const fresh = !t._peers.has(m.f); t._addPeer(m.f); if (fresh) bc.postMessage({ k: 'hi', f: selfId }); }
      else if (m.k === 'bye') t._dropPeer(m.f);
      else if (m.k === 'm' && wants(m.to, selfId)) { t._addPeer(m.f); t._deliver(m.c, m.d, m.f); }
   };
   bc.postMessage({ k: 'hi', f: selfId });
   return t;
}
