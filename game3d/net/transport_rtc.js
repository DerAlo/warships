// game3d/net/transport_rtc.js — the direct route of a game room: WebRTC data channels between the
// browsers, no own server. The peers of a room find each other through public Nostr relays
// (registration-free: every page load makes a throw-away key pair); those only carry the
// encrypted WebRTC session descriptions, game data then flows between the browsers (DTLS).
// The signalling/room logic is the vendored Trystero library (vendor/trystero/, MIT).
//
// This is only the *carrier* for relay.js: makeRoomTransport() there uses it for every peer a
// data channel comes up with and keeps the MQTT relay for all the others. NAT traversal uses
// public STUN servers only (Trystero's defaults: Google + Cloudflare) — there is no TURN server,
// so two peers behind strict/symmetric NATs never get a direct channel and simply stay relayed.
//
// Loaded through a dynamic import from lobby.js when the multiplayer screen is opened (not with
// ?net=local or ?net=relay), so the singleplayer game never touches the network.
import { joinRoom, selfId, getRelaySockets } from '../../vendor/trystero/trystero-nostr.min.js';

export { selfId };
export const APP_ID = 'kriegsschiffe-3d-net';
// Public Nostr relays that accepted and forwarded Trystero's ephemeral events when this was
// written (2026-10; 19 of the library's 28 defaults worked, these answered fastest). Every peer
// must share at least one live relay with the others, so all clients use the same list. Relays
// come and go: when no connection is ever "direkt" any more, re-test and refresh this list.
export const RELAYS = [
   'wss://nos.lol', 'wss://basspistol.org', 'wss://nostr-01.uid.ovh', 'wss://bucket.coracle.social',
   'wss://purplerelay.com', 'wss://nostr.data.haus', 'wss://relay.mostro.network',
];

// how many signalling relays are connected right now
export function relayStatus() {
   let open = 0;
   try { for (const s of Object.values(getRelaySockets())) if (s && s.readyState === 1) open++; } catch (e) { /* not started yet */ }
   return { open, total: RELAYS.length };
}

const leaving = new Map();      // room id -> promise of a leave() still in flight (a re-join waits for it)

// room: room id.
// o.password    shared secret: Trystero encrypts the session descriptions with a key derived from
//               it (AES-GCM) and runs a challenge handshake, so a peer without it cannot connect
// o.admit(id)   host-side gate, checked before a peer's channel is reported
// o.onUp(id), o.onDown(id), o.onData(bytes: Uint8Array, id), o.onFail(kind, id)
//               kind: 'password' | 'unreachable' | 'handshake'
// Returns { send(bytes, id), leave() }.
export async function makeRtcCarrier(room, o = {}) {
   if (leaving.has(room)) await leaving.get(room);
   const peers = new Set();
   let left = false;
   const r = joinRoom({ appId: APP_ID, ...(o.password ? { password: o.password } : {}), relayConfig: { urls: RELAYS, warnOnRelayFailure: false } }, room, {
      onJoinError: (d) => {
         const error = String(d?.error || '');
         o.onFail?.(/password/i.test(error) ? 'password' : /could not connect/i.test(error) ? 'unreachable' : 'handshake', d?.peerId);
      },
      ...(o.admit ? { onPeerHandshake: async (id) => { if (!o.admit(id)) throw new Error('not admitted'); } } : {}),
   });
   const action = r.makeAction('x');
   action.onMessage = (data, meta) => {
      if (left || !peers.has(meta.peerId)) return;
      o.onData?.(data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data), meta.peerId);
   };
   r.onPeerJoin = (id) => { if (!left && !peers.has(id)) { peers.add(id); o.onUp?.(id); } };
   r.onPeerLeave = (id) => { if (peers.delete(id) && !left) o.onDown?.(id); };
   return {
      send(bytes, id) {
         if (left || !peers.has(id)) return;
         Promise.resolve(action.send(bytes, { target: [id] })).catch(() => { /* peer vanished while sending */ });
      },
      leave() {
         if (left) return;
         left = true; peers.clear();
         const p = Promise.resolve(r.leave()).catch(() => { }).then(() => { if (leaving.get(room) === p) leaving.delete(room); });
         leaving.set(room, p);
      },
   };
}
