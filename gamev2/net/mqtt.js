// gamev2/net/mqtt.js — a minimal MQTT 3.1.1 client over WebSocket (QoS 0 only: connect,
// subscribe, publish, ping) and a small bus that talks to several public brokers at once.
//
// Why: every browser that can open a web page can open a WebSocket, so public MQTT brokers are a
// meeting point that works where WebRTC between two home routers does not. The brokers used here
// need no account. They are a shared public service: everything published is readable by anybody
// who subscribes to the topic, and nothing is guaranteed (QoS 0 may drop, brokers may throttle
// or disappear). Callers therefore publish to every connected broker, deduplicate on receive
// (relay.js) and encrypt what is not meant to be public.
//
// No DOM in here; runs in the browser and in node >= 22 (global WebSocket).

// Public brokers with a TLS WebSocket listener that accepted anonymous clients and forwarded our
// traffic when this was written (2026-10; measured with 20 messages/s of 700 bytes for 60 s):
//   HiveMQ (mqtt-dashboard.com = broker.hivemq.com)  everything delivered, ~10 ms broker delay
//   test.mosquitto.org                               everything delivered, ~20 ms; connecting
//                                                    sometimes takes several attempts
//   broker.emqx.io                                   forwards at most 10 messages/s per connection
//                                                    and silently drops the rest -> `gap`
// `urls`: alternative names of the same broker, tried in turn. `gap`: minimum pause in ms between
// two publishes of game-room traffic on that connection (relay.js bundles what queues up).
// Every peer must share at least one live broker with the others, so all clients use the same
// list. When multiplayer stops finding anybody, re-test and refresh this list first.
export const BROKERS = [
   { urls: ['wss://mqtt-dashboard.com:8884/mqtt', 'wss://broker.hivemq.com:8884/mqtt'], gap: 0 },
   { urls: ['wss://test.mosquitto.org:8081/mqtt'], gap: 0 },
   { urls: ['wss://broker.emqx.io:8084/mqtt'], gap: 130 },
];

const KEEPALIVE = 30;               // s; a ping goes out every KEEPALIVE / 2
const te = new TextEncoder(), td = new TextDecoder();

function varLen(n) { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return out; }
function str(s) { const b = te.encode(s); return [b.length >> 8, b.length & 255, ...b]; }
function packet(type, ...parts) {
   let len = 0;
   for (const p of parts) len += p.length;
   const head = [type, ...varLen(len)], out = new Uint8Array(head.length + len);
   out.set(head, 0);
   let o = head.length;
   for (const p of parts) { out.set(p, o); o += p.length; }
   return out;
}

// One connection to one broker. Reconnects by itself with a growing pause.
//   urls: one URL or several names of the same broker
//   cb.onMessage(topic, payload: Uint8Array), cb.onState(open: bool)
export class MqttClient {
   constructor(urls, cb = {}, WS = globalThis.WebSocket) {
      this.urls = Array.isArray(urls) ? urls : [urls]; this._try = 0; this.cb = cb; this.WS = WS;
      this.open = false; this.closed = false; this.subs = new Set();
      this.stat = { connects: 0, drops: 0, sent: 0, received: 0, bytesOut: 0, bytesIn: 0, lastError: '' };
      this._ws = null; this._buf = new Uint8Array(0); this._ping = null; this._retry = null; this._pause = 500; this._pid = 1; this._pong = 0;
      this._connect();
   }
   get url() { return this.urls[this._try % this.urls.length]; }
   _connect() {
      if (this.closed) return;
      let ws;
      try { ws = new this.WS(this.url, 'mqtt'); this._try++; } catch (e) { this.stat.lastError = String(e?.message || e); this._again(); return; }
      this._ws = ws; ws.binaryType = 'arraybuffer'; this._buf = new Uint8Array(0);
      ws.onopen = () => {
         const id = 'ks' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
         // protocol name, level 4 (3.1.1), clean session, keep-alive, client id
         ws.send(packet(0x10, str('MQTT'), [4, 2, KEEPALIVE >> 8, KEEPALIVE & 255], str(id)));
      };
      ws.onmessage = (e) => { if (ws === this._ws) this._feed(new Uint8Array(e.data)); };
      ws.onerror = () => { this.stat.lastError = 'socket error'; };
      ws.onclose = (e) => {
         if (ws !== this._ws) return;
         if (e && e.reason) this.stat.lastError = `closed ${e.code} ${e.reason}`;
         this._down(); this._again();
      };
   }
   _down() {
      clearInterval(this._ping); this._ping = null;
      if (this.open) { this.open = false; this.stat.drops++; this.cb.onState?.(false); }
   }
   _again() {
      if (this.closed || this._retry) return;
      this._retry = setTimeout(() => { this._retry = null; this._connect(); }, this._pause);
      this._pause = Math.min(15000, this._pause * 2);
   }
   // MQTT is a byte stream: one WebSocket frame may hold several packets or a part of one
   _feed(chunk) {
      this.stat.bytesIn += chunk.length;
      let buf = chunk;
      if (this._buf.length) { buf = new Uint8Array(this._buf.length + chunk.length); buf.set(this._buf, 0); buf.set(chunk, this._buf.length); }
      let o = 0;
      for (;;) {
         if (buf.length - o < 2) break;
         let len = 0, mul = 1, i = o + 1, done = false;
         for (; i < buf.length && i < o + 5; i++) { len += (buf[i] & 127) * mul; mul *= 128; if (!(buf[i] & 128)) { done = true; i++; break; } }
         if (!done || buf.length - i < len) break;
         this._packet(buf[o], buf.subarray(i, i + len));
         o = i + len;
      }
      this._buf = o < buf.length ? buf.slice(o) : new Uint8Array(0);
   }
   _packet(head, body) {
      const type = head >> 4;
      if (type === 2) {                                     // CONNACK
         if (body[1] !== 0) { this.stat.lastError = 'connack ' + body[1]; try { this._ws.close(); } catch (e) { /* closing anyway */ } return; }
         this.open = true; this._pause = 500; this.stat.connects++; this._pong = Date.now();
         if (this.subs.size) this._subscribe([...this.subs]);
         this._ping = setInterval(() => {
            // a broker that stopped answering pings is dead even when the socket looks open
            if (Date.now() - this._pong > KEEPALIVE * 1500) { try { this._ws.close(); } catch (e) { /* closing anyway */ } this._down(); this._again(); return; }
            this._raw(new Uint8Array([0xC0, 0]));
         }, KEEPALIVE * 500);
         this.cb.onState?.(true);
      } else if (type === 3) {                              // PUBLISH (QoS 0: no packet id)
         const tl = (body[0] << 8) | body[1];
         let o = 2 + tl;
         if (head & 6) o += 2;
         this.stat.received++;
         this.cb.onMessage?.(td.decode(body.subarray(2, 2 + tl)), body.slice(o));
      } else if (type === 13) this._pong = Date.now();      // PINGRESP
   }
   _raw(bytes) {
      if (this._ws && this._ws.readyState === 1) { this._ws.send(bytes); this.stat.bytesOut += bytes.length; return true; }
      return false;
   }
   _subscribe(topics) {
      const parts = [[this._pid >> 8, this._pid & 255]];
      this._pid = this._pid % 65535 + 1;
      for (const t of topics) parts.push(str(t), [0]);
      this._raw(packet(0x82, ...parts));
   }
   subscribe(topic) { if (!this.subs.has(topic)) { this.subs.add(topic); if (this.open) this._subscribe([topic]); } }
   unsubscribe(topic) {
      if (!this.subs.delete(topic) || !this.open) return;
      this._raw(packet(0xA2, [this._pid >> 8, this._pid & 255], str(topic)));
      this._pid = this._pid % 65535 + 1;
   }
   // payload: Uint8Array. Returns false when the broker is not connected (the message is dropped).
   publish(topic, payload) {
      if (!this.open) return false;
      this.stat.sent++;
      return this._raw(packet(0x30, str(topic), payload));
   }
   // bytes the socket has accepted but not sent yet: a growing number means the uplink or the
   // broker cannot keep up
   get backlog() { return this._ws ? this._ws.bufferedAmount || 0 : 0; }
   close() {
      this.closed = true;
      clearTimeout(this._retry); this._retry = null;
      this._raw(new Uint8Array([0xE0, 0]));
      const ws = this._ws;
      this._down(); this._ws = null;
      try { ws?.close(); } catch (e) { /* already closed */ }
   }
}
