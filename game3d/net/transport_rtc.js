// game3d/net/transport_rtc.js — the real Transport (see transport.js): WebRTC data channels
// between browsers, no own server. Peers find each other through public Nostr relays
// (registration-free: every page load makes a throw-away key pair); the relays only carry the
// encrypted WebRTC session descriptions, game data flows directly between the browsers (DTLS).
// The signalling/room logic is the vendored Trystero library (vendor/trystero/, MIT).
//
// This module is only ever loaded through a dynamic import from lobby.js when the multiplayer
// screen is opened without ?net=local, so the singleplayer game never touches the network.
//
// NAT traversal uses public STUN servers only (Trystero's defaults: Google + Cloudflare). There
// is no TURN relay, so two peers behind strict/symmetric NATs cannot connect; the lobby reports
// that through opts.onError instead of waiting forever.
import { joinRoom, selfId, getRelaySockets } from '../../vendor/trystero/trystero-nostr.min.js';

export { selfId };
export const APP_ID = 'kriegsschiffe-3d-net';
// Public Nostr relays that accepted and forwarded Trystero's ephemeral events when this was
// written (2026-10; 19 of the library's 28 defaults worked, these answered fastest). Every peer
// must share at least one live relay with the others, so all clients use the same list. Relays
// come and go: when multiplayer stops finding anybody, re-test and refresh this list first.
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

// room: room id; hostId: peer id of the host ('' for the host-less lobby room).
// opts.password  shared secret: Trystero encrypts the session descriptions with a key derived from
//                it (AES-GCM) and runs a challenge handshake, so a peer without it cannot connect
// opts.admit(id) host-side gate, checked before a peer becomes visible to the application
// opts.onError({ kind: 'password' | 'unreachable' | 'handshake', peerId, error })
export async function makeRtcTransport(room, hostId, opts = {}) {
   if (leaving.has(room)) await leaving.get(room);
   const handlers = new Map(), actions = new Map(), peers = new Set();
   let onJoin = null, onLeave = null, left = false;
   const r = joinRoom({ appId: APP_ID, ...(opts.password ? { password: opts.password } : {}), relayConfig: { urls: RELAYS, warnOnRelayFailure: false } }, room, {
      onJoinError: (d) => {
         const error = String(d?.error || '');
         const kind = /password/i.test(error) ? 'password' : /could not connect/i.test(error) ? 'unreachable' : 'handshake';
         opts.onError?.({ kind, peerId: d?.peerId, error });
      },
      ...(opts.admit ? { onPeerHandshake: async (id) => { if (!opts.admit(id)) throw new Error('not admitted'); } } : {}),
   });
   const action = (channel) => {
      let a = actions.get(channel);
      if (!a) {
         a = r.makeAction(channel);
         a.onMessage = (data, meta) => { if (!left && peers.has(meta.peerId)) handlers.get(channel)?.(data, meta.peerId); };
         actions.set(channel, a);
      }
      return a;
   };
   r.onPeerJoin = (id) => { if (!left && !peers.has(id)) { peers.add(id); onJoin?.(id); } };
   r.onPeerLeave = (id) => { if (peers.delete(id) && !left) onLeave?.(id); };
   return {
      selfId, hostId,
      get isHost() { return selfId === hostId; },
      peers: () => [...peers],
      send(channel, data, to) {
         if (left) return;
         const target = to === undefined ? [...peers] : (Array.isArray(to) ? to : [to]).filter(id => peers.has(id));
         if (target.length) Promise.resolve(action(channel).send(data, { target })).catch(() => { /* peer vanished while sending */ });
      },
      on(channel, fn) { handlers.set(channel, fn); action(channel); },
      onPeerJoin(fn) { onJoin = fn; },
      onPeerLeave(fn) { onLeave = fn; },
      leave() {
         if (left) return;
         left = true; peers.clear();
         const p = Promise.resolve(r.leave()).catch(() => { }).then(() => { if (leaving.get(room) === p) leaving.delete(room); });
         leaving.set(room, p);
      },
   };
}
