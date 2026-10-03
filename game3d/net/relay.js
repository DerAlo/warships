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
//   - the channels in LATEST carry complete states (`snap`, `cmd`, `mig`): only the newest counts, a
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
   stats() { return this.clients.map((c, i) => ({ url: this.brokers[i].urls[0], open: !!c?.open, backlog: c ? c.backlog : 0, ...(c ? c.stat : null) })); }
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
const LATEST = new Set(['snap', 'cmd', 'mig']);
const K_REL = 0, K_LATEST = 1, K_HI = 2, K_BYE = 3, K_PING = 4, K_PONG = 5, K_NACK = 6, K_RESET = 7;
const K_PROBE = 8, K_PROBED = 9, K_NODIRECT = 10;      // direct channel: question, answer; "I stopped using it"
const TICK_MS = 250;
const HI_MS = 3000;                  // presence broadcast on the relay
const PING_MS = 2000;                // per peer, on the route in use (round trip time, liveness)
const DEAD_MS = 11000;               // nothing heard on any route: the peer is gone
const STALL_MS = 5000;               // direct channel in use but silent: use the relay again
const PROBE_MS = 1000;               // direct channel open but not in use: ask over it
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
   const nB = bus.size, nextAt = new Array(nB).fill(0), timers = new Array(nB).fill(null), rr = new Array(nB).fill(0), soon = new Array(nB).fill(false);
   const st = { relayOut: 0, relayIn: 0, relayBytesOut: 0, relayBytesIn: 0, directOut: 0, directIn: 0, directBytesOut: 0, directBytesIn: 0, dups: 0, held: 0, nacks: 0, resent: 0, resets: 0, badCrypto: 0, directFail: 0, rx: {} };
   let onJoin = null, onLeave = null, onRoute = null, left = false, carrier = null, hiN = 0, hiAt = 0;
   let txChain = Promise.resolve(), rxChain = Promise.resolve();

   const mkPeer = (id) => ({
      id, joined: false, epoch: 0, up: false, direct: false, directAt: 0, probeAt: 0, relayAt: 0, born: now(),
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
   // A peer's traffic moves to the direct channel only after a question sent over that channel
   // came back answered over it (probe): the channel a browser reports as open may be dead or
   // work in one direction only (seen after a re-join), and whatever is sent into it then is lost.
   // tell: let the peer know that we stopped using the channel, so it does not send into it either
   function setDirect(p, on, tell = false) {
      if (p.direct === on) return;
      p.direct = on; p.directAt = now();
      if (!on && tell && p.epoch) emit(p, makeFrame(K_NODIRECT, ++p.latestTx, '', undefined), 'nodirect');
      if (p.joined && !left) onRoute?.(p.id, via(p));
   }
   function sendDirect(bytes, id) {
      if (!carrier) return;
      st.directOut++; st.directBytesOut += bytes.length;
      carrier.send(bytes, id);
   }
   function probe(p) {
      p.probeAt = now();
      sendDirect(makeBundle(epoch, p.txSeq, [makeFrame(K_PROBE, 0, '', undefined)]), p.id);
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
      if (p.direct && carrier) { sendDirect(makeBundle(epoch, p.txSeq, [frame]), p.id); return; }
      const t = now(), first = latestKey ? primary(p) : -1;
      for (let b = 0; b < nB; b++) {
         if (!bus.isOpen(b)) continue;
         if (latestKey) {
            // application states go at full rate to the peer's fastest broker only, thinned out to the others
            if (frame[0] === K_LATEST && b !== first && !p.out[b].latest.has(latestKey)) { if (t - p.sideAt[b] < SIDE_MS) continue; p.sideAt[b] = t; }
            p.out[b].latest.set(latestKey, frame);
         } else p.out[b].rel.push(frame);
         // everything sent in the same turn (a tick's snapshot, events and status) leaves as one publish
         if (!soon[b]) { soon[b] = true; queueMicrotask(() => { soon[b] = false; if (!left) flush(b); }); }
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
         nextAt[b] = t + gap;
         if (gap && list.length > 1) {
            // a rate-limited broker: one publish on the room topic carries a bundle for every waiting
            // peer, otherwise each of N peers would get only 1/N of the broker's few messages per second
            const parts = [], start = rr[b]++;
            let size = 0;
            for (let i = 0; i < list.length && size < BUNDLE_MAX; i++) {
               const p = list[(start + i) % list.length], frames = take(p.out[b], BUNDLE_MAX - size);
               for (const f of frames) size += f.length;
               parts.push([p.id, makeBundle(epoch, p.txSeq, frames)]);
            }
            publishMulti(b, parts);
            continue;
         }
         const p = list[rr[b]++ % list.length];
         publish(b, base + p.id, p.id, makeBundle(epoch, p.txSeq, take(p.out[b], BUNDLE_MAX)));
      }
   }
   // the frames of one publish for one peer: reliable ones in order up to `room` bytes (at least
   // one), then all waiting states
   function take(q, room) {
      const frames = [];
      let size = 0;
      while (q.rel.length && (size + q.rel[0].length <= room || !frames.length)) { size += q.rel[0].length; frames.push(q.rel.shift()); }
      for (const f of q.latest.values()) frames.push(f);
      q.latest.clear();
      return frames;
   }
   const seal = async (to, bundle) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(`${room}|${selfId}|${to}`) }, cipher, bundle));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv, 0); out.set(ct, 12);
      return out;
   };
   // several receivers in one publish on the room topic:
   // [0][id length u8][sender id][count u8] then ([receiver id length u8][receiver id][length u32][iv 12][AES-GCM(bundle)])*
   // each part is sealed for its receiver exactly like a single publish
   function publishMulti(b, parts) {
      txChain = txChain.then(async () => {
         const sealed = [];
         let len = 3 + idBytes.length;
         for (const [to, bundle] of parts) { const id = te.encode(to), box = await seal(to, bundle); sealed.push([id, box]); len += 5 + id.length + box.length; }
         const out = new Uint8Array(len), dv = new DataView(out.buffer);
         out[0] = 0; out[1] = idBytes.length; out.set(idBytes, 2);
         let o = 2 + idBytes.length;
         out[o++] = sealed.length;
         for (const [id, box] of sealed) { out[o++] = id.length; out.set(id, o); o += id.length; dv.setUint32(o, box.length); o += 4; out.set(box, o); o += box.length; }
         const n = bus.publish(b, topicAll, out) ? 1 : 0;
         st.relayOut += n; st.relayBytesOut += n * out.length;
      }).catch(() => { });
   }
   // payload on the wire: [id length u8][sender id][iv 12][AES-GCM(bundle)], bound to room, sender and receiver
   function publish(b, topic, to, bundle, all = false) {
      txChain = txChain.then(async () => {
         const box = await seal(to, bundle), out = new Uint8Array(1 + idBytes.length + box.length);
         out[0] = idBytes.length; out.set(idBytes, 1); out.set(box, 1 + idBytes.length);
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
      if (payload[0] === 0 && to === '_') { const mine = unpackMulti(payload); if (!mine) return; payload = mine; to = selfId; }
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
   // the part of a several-receiver publish (publishMulti) addressed to us, rebuilt as a single
   // publish: [id length][sender id][iv][ciphertext]; null when there is none or it is malformed
   function unpackMulti(payload) {
      const n = payload[1];
      if (!n || payload.length < 3 + n) return null;
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength), from = payload.subarray(2, 2 + n);
      let o = 2 + n, count = payload[o++];
      while (count-- > 0 && o < payload.length) {
         const k = payload[o++], id = td.decode(payload.subarray(o, o + k)); o += k;
         if (o + 4 > payload.length) return null;
         const len = dv.getUint32(o); o += 4;
         if (o + len > payload.length) return null;
         if (id === selfId) {
            const out = new Uint8Array(1 + n + len);
            out[0] = n; out.set(from, 1); out.set(payload.subarray(o, o + len), 1 + n);
            return out;
         }
         o += len;
      }
      return null;
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
      if (b >= 0) p.relayAt = t; else p.directAt = t;
      if (bundle.relHigh > p.relHigh) p.relHigh = bundle.relHigh;
      for (const raw of bundle.frames) {
         const f = readFrame(raw);
         if (!f) continue;
         if (f.kind === K_BYE) { bye.set(from, bundle.epoch); drop(p); return; }
         if (f.kind === K_PROBE || f.kind === K_PROBED) {     // not part of any stream; only count when they came over the channel itself
            if (b < 0 && f.kind === K_PROBE) sendDirect(makeBundle(epoch, p.txSeq, [makeFrame(K_PROBED, 0, '', undefined)]), p.id);
            if (b < 0 && f.kind === K_PROBED && p.up) setDirect(p, true);
            continue;
         }
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
         case K_NODIRECT: setDirect(p, false); return;
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
         if (p.direct && t - p.directAt > STALL_MS) setDirect(p, false, true);
         if (p.up && !p.direct && carrier && t - p.probeAt >= PROBE_MS) probe(p);
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
      selfId, hostId,                 // hostId: the lobby moves it after a host migration
      get isHost() { return selfId === this.hostId; },
      setAdmit(fn) { o.admit = fn; }, // the new host of a room gates newcomers from now on
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
            p.up = true;
            probe(p);                                      // also tells the peer our epoch
         },
         onDown(id) { const p = peers.get(id); if (p) { p.up = false; setDirect(p, false, true); } },
         onData(bytes, id) { if (!left) { st.directIn++; st.directBytesIn += bytes.length; onBundle(id, bytes, -1); } },
         onFail() { st.directFail++; },
      })).then((c) => { if (left) c?.leave(); else carrier = c; }).catch((e) => { console.warn('net: no direct connections, the relay is used', e); });
   }
   return transport;
}
