// game3d/net/relay.js — everything that runs over the public MQTT brokers (mqtt.js):
//
//   Bus               one connection per broker, shared by the lobby and the game room
//   makeBusLobby()    the game list and the knock: plain JSON, readable by anybody
//   makeRoomTransport()  the Transport of one game room (see transport.js). Every peer is reached
//                     over the brokers at once ("relay") and, when the browsers manage to open a
//                     WebRTC data channel, over that instead ("direct"). The route is chosen per
//                     peer and may change at any time in either direction.
//
// What the room transport adds on top of the brokers' QoS 0 (may drop, may throttle):
//   - every message is published to all connected brokers and deduplicated by sequence number
//   - reliable, ordered delivery per peer: gaps are held back for a moment (another broker
//     usually fills them), then requested again from the sender (NACK)
//   - the channels in LATEST carry complete states (`snap`, `cmd`): only the newest counts, a
//     missing one is never waited for or repeated, and they go at full rate to one broker only
//   - brokers with a rate limit (`gap`) get everything that queued up bundled into one publish
//   - relayed traffic is AES-GCM encrypted with the room key
// The same framing runs over the direct channel, so a route change loses and reorders nothing.
//
// No DOM in here; runs in node >= 22 with a fake bus (tests/relay3d.test.mjs).
import { MqttClient, BROKERS } from './mqtt.js';

const ROOT = 'ks3d/1';
const te = new TextEncoder(), td = new TextDecoder();
const now = () => performance.now();
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id);   // also keeps MQTT wildcards out of topics

// ---------------------------------------------------------------- bus
// Connects while somebody is subscribed, disconnects shortly after the last unsubscribe.
export class Bus {
   constructor(brokers = BROKERS, WS = globalThis.WebSocket) {
      this.brokers = brokers; this.WS = WS;
      this.clients = brokers.map(() => null);
      this.subs = new Map();           // topic -> Set of fn(payload, brokerIndex)
      this.watch = new Set();          // fn(brokerIndex, open)
      this._held = []; this._linger = null;
   }
   get size() { return this.brokers.length; }
   gap(i) { return this.brokers[i].gap || 0; }
   isOpen(i) { return !!this.clients[i]?.open; }
   backlog(i) { return this.clients[i]?.backlog || 0; }
   status() { let open = 0; for (const c of this.clients) if (c?.open) open++; return { open, total: this.clients.length }; }
   stats() { return this.clients.map((c, i) => ({ url: this.brokers[i].urls[0], open: !!c?.open, ...(c ? c.stat : null) })); }
   _start() {
      clearTimeout(this._linger); this._linger = null;
      this.clients.forEach((c, i) => {
         if (c) return;
         c = this.clients[i] = new MqttClient(this.brokers[i].urls, {
            onMessage: (topic, payload) => { const set = this.subs.get(topic); if (set) for (const fn of [...set]) fn(payload, i); },
            onState: (open) => {
               if (open && this._held.length) { for (const [t, p] of this._held) c.publish(t, p); this._held.length = 0; }
               for (const fn of [...this.watch]) fn(i, open);
            },
         }, this.WS);
         for (const t of this.subs.keys()) c.subscribe(t);
      });
   }
   subscribe(topic, fn) {
      let set = this.subs.get(topic);
      if (!set) { this.subs.set(topic, set = new Set()); for (const c of this.clients) c?.subscribe(topic); }
      set.add(fn);
      this._start();
   }
   unsubscribe(topic, fn) {
      const set = this.subs.get(topic);
      if (!set || !set.delete(fn) || set.size) return;
      this.subs.delete(topic);
      for (const c of this.clients) c?.unsubscribe(topic);
      if (!this.subs.size && !this._linger) this._linger = setTimeout(() => { this._linger = null; if (!this.subs.size) this.close(); }, 1500);
   }
   publish(i, topic, payload) { return !!this.clients[i]?.publish(topic, payload); }
   // hold: keep the message for the first broker that connects when none is connected yet
   publishAll(topic, payload, hold = false) {
      let n = 0;
      for (let i = 0; i < this.clients.length; i++) if (this.publish(i, topic, payload)) n++;
      if (!n && hold) { this._held.push([topic, payload]); if (this._held.length > 20) this._held.shift(); }
      return n;
   }
   close() {
      clearTimeout(this._linger); this._linger = null; this._held.length = 0;
      this.clients.forEach((c, i) => { if (c) { c.close(); this.clients[i] = null; } });
   }
}

// ---------------------------------------------------------------- lobby channel
// The lobby part of a Transport: send(channel, data, to) / on(channel, fn(data, from)) / leave().
// No peer list: who is there shows only in what they send. Nothing here is secret or
// authenticated — the listing is public by design and the sender id is a claim, so the lobby
// must treat everything as untrusted input (lobby.js does; joining needs the room key anyway).
let busSeq = Math.floor(Math.random() * 1e9);
export function makeBusLobby(bus, selfId) {
   const handlers = new Map(), seen = new Set(), order = [];
   const all = `${ROOT}/l`, mine = `${ROOT}/p/${selfId}`;
   let left = false;
   const rx = (payload) => {
      if (left || payload.length > 4096) return;
      let m;
      try { m = JSON.parse(td.decode(payload)); } catch (e) { return; }
      if (!m || !validId(m.f) || m.f === selfId || typeof m.c !== 'string') return;
      const key = m.f + ':' + m.n;                     // the same message arrives once per broker
      if (seen.has(key)) return;
      seen.add(key); order.push(key);
      if (order.length > 3000) seen.delete(order.shift());
      handlers.get(m.c)?.(m.d, m.f);
   };
   bus.subscribe(all, rx); bus.subscribe(mine, rx);
   return {
      selfId,
      send(channel, data, to) {
         if (left) return;
         const payload = te.encode(JSON.stringify({ f: selfId, n: ++busSeq, c: channel, d: data }));
         if (to === undefined) bus.publishAll(all, payload, true);
         else for (const id of Array.isArray(to) ? to : [to]) if (validId(id)) bus.publishAll(`${ROOT}/p/${id}`, payload, true);
      },
      on(channel, fn) { handlers.set(channel, fn); },
      leave() { if (left) return; left = true; bus.unsubscribe(all, rx); bus.unsubscribe(mine, rx); },
   };
}

// ---------------------------------------------------------------- room transport
const LATEST = new Set(['snap', 'cmd']);
const K_REL = 0, K_LATEST = 1, K_HI = 2, K_BYE = 3, K_PING = 4, K_PONG = 5, K_NACK = 6, K_RESET = 7;
const TICK_MS = 250;
const HI_MS = 3000;                  // presence broadcast on the relay
const PING_MS = 2000;                // per peer, on the route in use (round trip time, liveness)
const DEAD_MS = 11000;               // nothing heard on any route: the peer is gone
const STALL_MS = 7000;               // direct channel open but silent: use the relay again
const GAP_MS = 250;                  // how long a gap may wait for another broker to fill it
const NACK_MS = 500;                 // pause between two requests for missing frames
const NACK_RANGES = 40, NACK_FRAMES = 300;   // per request: ranges asked for, frames repeated
const KEEP = 600;                    // reliable frames kept per peer for a repeat
const SIDE_MS = 200;                 // LATEST frames to the brokers that are not the peer's fastest
const BUNDLE_MAX = 12000;            // bytes of frames per publish

// frame: [kind u8][seq u32][binary u8][channel length u8][channel][payload]
function makeFrame(kind, seq, channel, data) {
   const bin = data instanceof Uint8Array;
   const body = data === undefined ? new Uint8Array(0) : bin ? data : te.encode(JSON.stringify(data));
   const ch = te.encode(channel);
   const f = new Uint8Array(7 + ch.length + body.length);
   f[0] = kind; new DataView(f.buffer).setUint32(1, seq); f[5] = bin ? 1 : 0; f[6] = ch.length;
   f.set(ch, 7); f.set(body, 7 + ch.length);
   return f;
}
function readFrame(f) {
   if (f.length < 7 || 7 + f[6] > f.length) return null;
   const body = f.subarray(7 + f[6]);
   let data;
   if (f[5]) data = body.slice();                      // own buffer, offset 0
   else if (body.length) { try { data = JSON.parse(td.decode(body)); } catch (e) { return null; } }
   return { kind: f[0], seq: new DataView(f.buffer, f.byteOffset).getUint32(1), channel: td.decode(f.subarray(7, 7 + f[6])), data };
}
// bundle: [version u8][epoch f64][newest reliable seq sent to the receiver u32] then ([length u32][frame])*
function makeBundle(epoch, relHigh, frames) {
   let len = 13;
   for (const f of frames) len += 4 + f.length;
   const out = new Uint8Array(len), dv = new DataView(out.buffer);
   out[0] = 1; dv.setFloat64(1, epoch); dv.setUint32(9, relHigh);
   let o = 13;
   for (const f of frames) { dv.setUint32(o, f.length); out.set(f, o + 4); o += 4 + f.length; }
   return out;
}
function readBundle(b) {
   if (b.length < 13 || b[0] !== 1) return null;
   const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), frames = [];
   let o = 13;
   while (o + 4 <= b.length) {
      const n = dv.getUint32(o);
      if (o + 4 + n > b.length) return null;
      frames.push(b.subarray(o + 4, o + 4 + n)); o += 4 + n;
   }
   return { epoch: dv.getFloat64(1), relHigh: dv.getUint32(9), frames };
}

// The key of the relayed room traffic. With a password it comes from the PBKDF2 room key, so
// only who knows the password can read or write the room. WITHOUT a password it is derived from
// the room id alone, which everybody sees in the game list: that is obscurity, not secrecy — it
// keeps casual topic readers out and nothing more.
async function roomCipher(room, key) {
   const raw = await crypto.subtle.digest('SHA-256', te.encode(`ks3d-relay:${room}:${key || 'open'}`));
   return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// o: { bus, selfId, room, hostId, key, admit(id), direct(hooks) }
//   admit   host-side gate: a peer that is not admitted stays invisible to the application
//   direct  optional factory of the WebRTC carrier, see makeRtcCarrier() in transport_rtc.js:
//           async (hooks: { onUp(id), onDown(id), onData(bytes, id), onFail(kind, id) }) ->
//           { send(bytes, id), leave() }. The room works without it.
// Besides the Transport interface: link(id) -> { via: 'direct'|'relay', rtt }, onRoute(fn(id, via)),
// stats().
export async function makeRoomTransport(o) {
   const { bus, selfId, room, hostId } = o;
   const cipher = await roomCipher(room, o.key);
   const base = `${ROOT}/r/${room}/`, topicAll = base + '_', topicMe = base + selfId;
   const idBytes = te.encode(selfId);
   // strictly growing over the instances of one page, so a peer can tell a re-join from a late packet
   const epoch = Math.max(Date.now(), makeRoomTransport._last + 1 || 0); makeRoomTransport._last = epoch;
   const handlers = new Map(), peers = new Map(), bye = new Map();
   const nB = bus.size, nextAt = new Array(nB).fill(0), timers = new Array(nB).fill(null), rr = new Array(nB).fill(0);
   const st = { relayOut: 0, relayIn: 0, relayBytesOut: 0, relayBytesIn: 0, directOut: 0, directIn: 0, dups: 0, held: 0, nacks: 0, resent: 0, resets: 0, badCrypto: 0, directFail: 0, rx: {} };
   let onJoin = null, onLeave = null, onRoute = null, left = false, carrier = null, hiN = 0, hiAt = 0;
   let txChain = Promise.resolve(), rxChain = Promise.resolve();

   const mkPeer = (id) => ({
      id, joined: false, epoch: 0, direct: false, directAt: 0, relayAt: 0, born: now(),
      txSeq: 0, sent: new Map(), latestTx: 0,
      rxNext: 1, held: new Map(), relHigh: 0, gapAt: 0, nackAt: 0, latestRx: new Map(), hiN: 0,
      out: Array.from({ length: nB }, () => ({ rel: [], latest: new Map() })), sideAt: new Array(nB).fill(0), score: new Array(nB).fill(0),
      rtt: null, pingAt: 0,
   });
   const via = (p) => p.direct ? 'direct' : 'relay';
   function drop(p) {
      if (peers.get(p.id) !== p) return;
      peers.delete(p.id);
      if (p.joined && !left) onLeave?.(p.id);
   }
   function setDirect(p, on) {
      if (p.direct === on) return;
      p.direct = on; p.directAt = now();
      if (p.joined && !left) onRoute?.(p.id, via(p));
   }

   // ------------------------------------------------------------ sending
   // the broker this peer's traffic arrived on first most often (among the connected ones)
   function primary(p) {
      let best = -1;
      for (let b = 0; b < nB; b++) if (bus.isOpen(b) && !bus.gap(b) && (best < 0 || p.score[b] > p.score[best])) best = b;
      if (best < 0) for (let b = 0; b < nB; b++) if (bus.isOpen(b) && (best < 0 || p.score[b] > p.score[best])) best = b;
      return best;
   }
   function emit(p, frame, latestKey) {
      if (p.direct && carrier) { st.directOut++; carrier.send(makeBundle(epoch, p.txSeq, [frame]), p.id); return; }
      const t = now(), first = latestKey ? primary(p) : -1;
      for (let b = 0; b < nB; b++) {
         if (!bus.isOpen(b)) continue;
         if (latestKey) {
            // application states go at full rate to the peer's fastest broker only, thinned out to the others
            if (frame[0] === K_LATEST && b !== first && !p.out[b].latest.has(latestKey)) { if (t - p.sideAt[b] < SIDE_MS) continue; p.sideAt[b] = t; }
            p.out[b].latest.set(latestKey, frame);
         } else p.out[b].rel.push(frame);
         flush(b);
      }
   }
   function pending(p, b) { return p.out[b].rel.length || p.out[b].latest.size; }
   function flush(b, force = false) {
      if (!bus.isOpen(b)) { for (const p of peers.values()) { p.out[b].rel.length = 0; p.out[b].latest.clear(); } return; }
      const gap = bus.gap(b);
      for (;;) {
         const list = [...peers.values()].filter(p => pending(p, b));
         if (!list.length) return;
         const t = now();
         if (!force && t < nextAt[b]) {
            if (!timers[b]) timers[b] = setTimeout(() => { timers[b] = null; if (!left) flush(b); }, nextAt[b] - t + 1);
            return;
         }
         const p = list[rr[b]++ % list.length], q = p.out[b], frames = [];
         let size = 0;
         while (q.rel.length && (size + q.rel[0].length <= BUNDLE_MAX || !frames.length)) { size += q.rel[0].length; frames.push(q.rel.shift()); }
         for (const f of q.latest.values()) frames.push(f);
         q.latest.clear();
         nextAt[b] = t + gap;
         publish(b, base + p.id, p.id, makeBundle(epoch, p.txSeq, frames));
      }
   }
   // payload on the wire: [id length u8][sender id][iv 12][AES-GCM(bundle)], bound to room, sender and receiver
   function publish(b, topic, to, bundle, all = false) {
      txChain = txChain.then(async () => {
         const iv = crypto.getRandomValues(new Uint8Array(12));
         const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(`${room}|${selfId}|${to}`) }, cipher, bundle));
         const out = new Uint8Array(1 + idBytes.length + 12 + ct.length);
         out[0] = idBytes.length; out.set(idBytes, 1); out.set(iv, 1 + idBytes.length); out.set(ct, 13 + idBytes.length);
         const n = all ? bus.publishAll(topic, out) : bus.publish(b, topic, out) ? 1 : 0;
         st.relayOut += n; st.relayBytesOut += n * out.length;
      }).catch(() => { });
   }
   function sendRel(p, channel, data, kind = K_REL) {
      const f = makeFrame(kind, ++p.txSeq, channel, data);
      p.sent.set(p.txSeq, f);
      if (p.sent.size > KEEP) p.sent.delete(p.txSeq - KEEP);
      emit(p, f, null);
   }
   const sendLatest = (p, channel, data, kind = K_LATEST) => emit(p, makeFrame(kind, ++p.latestTx, channel, data), kind + channel);
   function sayHi() {
      hiAt = now();
      publish(0, topicAll, '_', makeBundle(epoch, 0, [makeFrame(K_HI, ++hiN, '', undefined)]), true);
   }

   // ------------------------------------------------------------ receiving
   function onRelay(payload, b, to) {
      if (left || payload.length < 30) return;
      const n = payload[0], from = td.decode(payload.subarray(1, 1 + n));
      if (from === selfId || !validId(from)) return;
      st.relayIn++; st.relayBytesIn += payload.length;
      rxChain = rxChain.then(async () => {
         let plain;
         try {
            plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.subarray(1 + n, 13 + n), additionalData: te.encode(`${room}|${from}|${to}`) }, cipher, payload.subarray(13 + n)));
         } catch (e) { st.badCrypto++; return; }          // wrong key or not for us
         if (!left) onBundle(from, plain, b);
      }).catch((e) => { console.warn('net: relay message failed', e); });
   }
   function onBundle(from, bytes, b) {
      const bundle = readBundle(bytes);
      if (!bundle) return;
      let p = peers.get(from);
      if (p && bundle.epoch < p.epoch) return;           // a late packet of an earlier visit
      if ((bye.get(from) || 0) >= bundle.epoch) return;  // said goodbye already (slow duplicate)
      if (p && p.epoch && bundle.epoch > p.epoch) { drop(p); p = null; }      // the peer came back as a new instance
      if (!p) {
         if (o.admit && !o.admit(from)) return;
         p = mkPeer(from); peers.set(from, p);
         if (now() - hiAt > 400) sayHi();                // let the newcomer know us at once
      }
      p.epoch = bundle.epoch;
      const t = now();
      if (b >= 0) p.relayAt = t; else { p.directAt = t; if (!p.direct) setDirect(p, true); }
      if (bundle.relHigh > p.relHigh) p.relHigh = bundle.relHigh;
      for (const raw of bundle.frames) {
         const f = readFrame(raw);
         if (!f) continue;
         if (f.kind === K_BYE) { bye.set(from, bundle.epoch); drop(p); return; }
         if (!p.joined) { p.joined = true; onJoin?.(p.id); if (left || peers.get(from) !== p) return; }
         onFrame(p, f, b);
         if (left || peers.get(from) !== p) return;
      }
   }
   const credit = (p, b) => { if (b >= 0) for (let i = 0; i < nB; i++) p.score[i] = p.score[i] * 0.9 + (i === b ? 1 : 0); };
   function deliver(p, f) {
      const s = st.rx[f.channel] || (st.rx[f.channel] = { n: 0, maxGap: 0, last: 0 }), t = now();
      if (s.last && t - s.last > s.maxGap) s.maxGap = t - s.last;
      s.last = t; s.n++;
      handlers.get(f.channel)?.(f.data, p.id);
   }
   function drain(p) {
      for (let f; (f = p.held.get(p.rxNext)) && peers.get(p.id) === p && !left;) { p.held.delete(p.rxNext); p.rxNext++; p.gapAt = 0; if (f.kind === K_REL) deliver(p, f); }
   }
   function onFrame(p, f, b) {
      if (f.kind !== K_REL && f.kind !== K_HI) {          // everything else: only the newest of its kind counts
         const key = f.kind === K_LATEST ? f.channel : ' ' + f.kind;
         if (f.seq <= (p.latestRx.get(key) || 0)) { st.dups++; return; }
         p.latestRx.set(key, f.seq);
         if (f.kind !== K_LATEST) credit(p, b);
      }
      switch (f.kind) {
         case K_REL:
            if (f.seq < p.rxNext || p.held.has(f.seq)) { st.dups++; return; }
            credit(p, b);
            if (f.seq === p.rxNext) { p.rxNext++; p.gapAt = 0; deliver(p, f); drain(p); }
            else if (p.held.size < KEEP) { p.held.set(f.seq, f); st.held++; }
            return;
         case K_LATEST: deliver(p, f); return;
         case K_HI: if (f.seq > p.hiN) { p.hiN = f.seq; credit(p, b); } return;
         case K_PING: sendLatest(p, '', f.data, K_PONG); return;
         case K_PONG: { const d = now() - Number(f.data); if (d >= 0 && d < 60000) p.rtt = p.rtt == null ? d : p.rtt * 0.7 + d * 0.3; return; }
         case K_NACK: {
            // data: the missing ranges [[first, last], ...]
            let budget = NACK_FRAMES, tooOld = false;
            for (const r of Array.isArray(f.data) ? f.data.slice(0, NACK_RANGES) : []) {
               const a = r?.[0] >>> 0, z = Math.min(r?.[1] >>> 0, p.txSeq);
               for (let s = a; s <= z && budget > 0; s++) { const old = p.sent.get(s); if (old) { budget--; st.resent++; emit(p, old, null); } else tooOld = true; }
            }
            if (tooOld) {                                    // too old to repeat: tell the peer where the stream goes on
               let low = p.txSeq + 1;
               for (const s of p.sent.keys()) if (s < low) low = s;
               st.resets++;
               emit(p, makeFrame(K_RESET, ++p.latestTx, '', low), 'reset');
            }
            return;
         }
         case K_RESET:
            if (Number(f.data) > p.rxNext) { for (const s of [...p.held.keys()]) if (s < f.data) p.held.delete(s); p.rxNext = Number(f.data); p.gapAt = 0; drain(p); }
            return;
      }
   }

   // ------------------------------------------------------------ housekeeping
   function tick() {
      if (left) return;
      const t = now();
      if (t - hiAt >= HI_MS) sayHi();
      for (const p of [...peers.values()]) {
         if (p.direct && t - p.directAt > STALL_MS) setDirect(p, false);
         if (!p.direct && t - Math.max(p.relayAt, p.directAt, p.born) > DEAD_MS) { drop(p); continue; }
         if (!p.joined) continue;
         if (t - p.pingAt >= PING_MS) { p.pingAt = t; sendLatest(p, '', t, K_PING); }
         // something is missing: frames wait behind a gap, or the sender is ahead of what arrived
         let high = p.relHigh;
         for (const s of p.held.keys()) if (s > high) high = s;
         if (high >= p.rxNext) {
            if (!p.gapAt) p.gapAt = t - (t - p.nackAt < 3000 ? GAP_MS : 0);      // already repairing: no new grace period
            else if (t - p.gapAt >= GAP_MS && t - p.nackAt >= NACK_MS) {
               const miss = [];
               let s = p.rxNext;
               for (const k of [...p.held.keys()].sort((x, y) => x - y)) { if (k > s) miss.push([s, k - 1]); s = k + 1; if (miss.length >= NACK_RANGES) break; }
               if (miss.length < NACK_RANGES && high >= s) miss.push([s, high]);
               p.nackAt = t; st.nacks++;
               emit(p, makeFrame(K_NACK, ++p.latestTx, '', miss), 'nack');
            }
         } else p.gapAt = 0;
      }
   }

   const rxAll = (payload, b) => onRelay(payload, b, '_'), rxMe = (payload, b) => onRelay(payload, b, selfId);
   const watch = (b, open) => { if (!open) flush(b); else if (!left) sayHi(); };
   bus.subscribe(topicAll, rxAll); bus.subscribe(topicMe, rxMe); bus.watch.add(watch);
   const timer = setInterval(tick, TICK_MS);
   const onHide = () => transport.leave();
   globalThis.addEventListener?.('pagehide', onHide);
   sayHi();

   const transport = {
      selfId, hostId,
      get isHost() { return selfId === hostId; },
      peers: () => [...peers.values()].filter(p => p.joined).map(p => p.id),
      send(channel, data, to) {
         if (left) return;
         const ids = to === undefined ? [...peers.keys()] : Array.isArray(to) ? to : [to];
         for (const id of ids) {
            const p = peers.get(id);
            if (!p || !p.joined) continue;
            if (LATEST.has(channel)) sendLatest(p, channel, data); else sendRel(p, channel, data);
         }
      },
      on(channel, fn) { handlers.set(channel, fn); },
      onPeerJoin(fn) { onJoin = fn; },
      onPeerLeave(fn) { onLeave = fn; },
      onRoute(fn) { onRoute = fn; },
      link(id) { const p = peers.get(id); return p && p.joined ? { via: via(p), rtt: p.rtt } : null; },
      stats() {
         return { ...st, rx: JSON.parse(JSON.stringify(st.rx)), brokers: bus.stats(),
            peers: [...peers.values()].filter(p => p.joined).map(p => ({ id: p.id, via: via(p), rtt: p.rtt, primary: primary(p) })) };
      },
      leave() {
         if (left) return;
         const gone = makeBundle(epoch, 0, [makeFrame(K_BYE, 0, '', undefined)]);
         for (const p of peers.values()) if (p.direct && carrier) carrier.send(gone, p.id);
         for (let b = 0; b < nB; b++) { clearTimeout(timers[b]); flush(b, true); }
         publish(0, topicAll, '_', gone, true);
         left = true; peers.clear();
         clearInterval(timer); bus.watch.delete(watch);
         globalThis.removeEventListener?.('pagehide', onHide);
         const c = carrier; carrier = null;
         // let the goodbye leave the sockets before they may close
         txChain.then(() => setTimeout(() => { bus.unsubscribe(topicAll, rxAll); bus.unsubscribe(topicMe, rxMe); c?.leave(); }, 300));
      },
   };

   // the WebRTC attempt runs beside the relay and never blocks it
   if (o.direct) {
      Promise.resolve().then(() => o.direct({
         onUp(id) {
            if (left || !validId(id) || id === selfId) return;
            let p = peers.get(id);
            if (!p) { p = mkPeer(id); peers.set(id, p); }
            p.directAt = now();
            setDirect(p, true);
            sendLatest(p, '', now(), K_PING);              // the first bundle tells the peer our epoch
         },
         onDown(id) { const p = peers.get(id); if (p) setDirect(p, false); },
         onData(bytes, id) { if (!left) { st.directIn++; onBundle(id, bytes, -1); } },
         onFail() { st.directFail++; },
      })).then((c) => { if (left) c?.leave(); else carrier = c; }).catch((e) => { console.warn('net: no direct connections, the relay is used', e); });
   }
   return transport;
}
