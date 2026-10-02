// game3d/net/lobby.js — matchmaking logic without any UI (the screen is game3d/mpui.js):
// game list discovery, hosting, joining with an optional password, the room (players, ships,
// ready, chat, kick) and the hand-over to the game (`session`, see CONTRACT.md).
//
// How peers find each other
//   Everybody who has the multiplayer screen open sits in one shared "lobby" room (a Transport).
//   Hosts send their listing entry to every lobby peer: when a peer appears, when the entry
//   changes and as a heartbeat. A listing disappears when the host withdraws it, when the host's
//   peer leaves, or when no heartbeat arrived for STALE_MS. A client leaves the lobby room while
//   it is inside a game room; a host stays to keep its game listed.
//   With the real transport the lobby room is a WebRTC mesh, so the list only shows hosts this
//   browser can actually reach, and it is meant for dozens of simultaneous browsers, not hundreds.
//
// How a game room works (channels `room` and `chat`, host-authoritative)
//   join: client -> host over the lobby `knock` (password proof), host answers `knockr` and
//   reserves a seat; the client then connects to the game room and says `hello`. The host owns
//   the room state and broadcasts it; clients only send requests (`set`, chat lines).
//
// Password
//   key = PBKDF2-SHA256(password, salt = room id). The knock carries SHA-256(key, room, peer id),
//   never the password. With the real transport the key is also the Trystero room password: the
//   WebRTC session descriptions are AES-GCM encrypted with it, so somebody who skips the knock
//   still cannot connect. With ?net=local (BroadcastChannel, test only) just the knock applies.
import { NET_VERSION, makeLocalTransport } from './transport.js';
import { coopSlots } from './coop.js';
import { MISSIONS, getMission } from '../missions.js';
import { PLAYABLE, SHIPS } from '../config.js';
import { isUnlocked } from '../progress3d.js';

export { NET_VERSION };
export const NAME_KEY = 'warships3d.net.name';
export const MODES = [['coop', 'Koop gegen Bots', true], ['pvp', 'PvP', false]];
export const DIFFICULTIES = ['easy', 'normal', 'hard'];
const HEARTBEAT_MS = 4000, STALE_MS = 13000, TICK_MS = 1000;
const KNOCK_MS = 10000, CONNECT_MS = 20000, SEAT_MS = 30000;
const CHAT_MAX = 200, CHAT_KEEP = 120;

// ---------------------------------------------------------------- small helpers
const randId = (n = 12) => { const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map(x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join(''); };
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const enc = (s) => new TextEncoder().encode(s);
export const cleanName = (s, max = 20) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export function loadName() { try { return cleanName(localStorage.getItem(NAME_KEY)); } catch (e) { return ''; } }
export function saveName(n) { try { localStorage.setItem(NAME_KEY, cleanName(n)); } catch (e) { /* private mode */ } }

async function deriveKey(password, roomId) {
   if (!password) return '';
   const base = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
   return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc('ks3d-room:' + roomId), iterations: 150000 }, base, 256));
}
const proofOf = async (key, roomId, peerId) => hex(await crypto.subtle.digest('SHA-256', enc(`knock:${key}:${roomId}:${peerId}`)));

export const coopMissions = () => MISSIONS.filter(m => coopSlots(m.id) > 0);
export const allowedShips = (missionId) => getMission(missionId)?.playableShips || PLAYABLE;
// the player's own choice for a mission: allowed there and unlocked in the local career profile
export const ownShips = (missionId, profile) => allowedShips(missionId).filter(k => SHIPS[k] && isUnlocked(profile, k));
export function pickShip(missionId, profile, preferred) {
   const own = ownShips(missionId, profile), rec = getMission(missionId)?.recommendedShip;
   return own.includes(preferred) ? preferred : own.includes(rec) ? rec : own[0] || null;
}

// listing entries come from other browsers: never trust their shape
function cleanEntry(d) {
   if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id) return null;
   const int = (x, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(x)) || 0));
   return {
      id: d.id.slice(0, 24), name: cleanName(d.name, 32) || 'Spiel', host: cleanName(d.host) || '?',
      mode: String(d.mode ?? '').slice(0, 8), mission: String(d.mission ?? '').slice(0, 40), difficulty: String(d.difficulty ?? '').slice(0, 8),
      players: int(d.players, 0, 16), max: int(d.max, 1, 16), locked: !!d.locked,
      state: d.state === 'running' ? 'running' : 'lobby', v: int(d.v, 0, 1e6),
   };
}

// f: { q, mode, mission, hideFull, hideLocked, hideRunning }
export function filterGames(list, f = {}) {
   const q = String(f.q || '').trim().toLowerCase();
   return list.filter(g => {
      if (f.mode && g.mode !== f.mode) return false;
      if (f.mission && g.mission !== f.mission) return false;
      if (f.hideFull && g.players >= g.max) return false;
      if (f.hideLocked && g.locked) return false;
      if (f.hideRunning && g.state === 'running') return false;
      if (q && !`${g.name} ${g.host} ${getMission(g.mission)?.name || g.mission}`.toLowerCase().includes(q)) return false;
      return true;
   });
}

export class NetError extends Error {
   constructor(code, message) { super(message); this.code = code; }
}
const DENY = {
   password: 'Falsches Passwort.',
   full: 'Das Spiel ist voll.',
   running: 'Das Gefecht läuft bereits.',
   banned: 'Der Host hat dich aus diesem Spiel entfernt.',
   version: 'Das Spiel verwendet eine andere Version.',
   gone: 'Das Spiel existiert nicht mehr.',
};

// ---------------------------------------------------------------- backends
// A backend opens Transports: the shared lobby room and game rooms.
export async function makeBackend(local) {
   if (local) {
      const selfId = randId(16);
      return {
         local: true, selfId,
         openLobby: async () => makeLocalTransport('lobby', selfId, ''),
         openRoom: async (id, hostId) => makeLocalTransport('g-' + id, selfId, hostId),
         status: () => ({ open: 1, total: 1 }),
      };
   }
   const rtc = await import('./transport_rtc.js');
   return {
      local: false, selfId: rtc.selfId,
      openLobby: (onError) => rtc.makeRtcTransport('lobby-1', '', { onError }),
      openRoom: (id, hostId, key, admit, onError) => rtc.makeRtcTransport('g-' + id, hostId, { password: key, admit, onError }),
      status: rtc.relayStatus,
   };
}

// The Transport handed to the game for one match: the room transport restricted to the players
// of that match, with its own onPeerJoin/onPeerLeave slots (the room keeps the real ones) and
// without access to the matchmaking channels.
function sessionTransport(base, members, onLeave) {
   const set = new Set(members);
   let join = null, leave = null, live = true;
   const peers = () => base.peers().filter(id => set.has(id));
   return {
      selfId: base.selfId, hostId: base.hostId, isHost: base.selfId === base.hostId,
      peers,
      send(channel, data, to) {
         if (!live) return;
         const t = to === undefined ? peers() : (Array.isArray(to) ? to : [to]).filter(id => set.has(id));
         if (t.length) base.send(channel, data, t);
      },
      on(channel, fn) {
         if (channel === 'room' || channel === 'chat') { console.warn('net: channel "' + channel + '" belongs to matchmaking'); return; }
         base.on(channel, (d, from) => { if (live && set.has(from)) fn(d, from); });
      },
      onPeerJoin(fn) { join = fn; },
      onPeerLeave(fn) { leave = fn; },
      leave() { if (live) onLeave(); },
      _join(id) { if (live && set.has(id)) join?.(id); },
      _leave(id) { if (live && set.delete(id)) leave?.(id); },      // at most once per player
      _close() { live = false; },
   };
}

// ---------------------------------------------------------------- lobby
// cb: onList(), onRoom(), onChat(line), onLeft(reason, text), onStart(session), onEnd(result)
export class Lobby {
   constructor(backend, getProfile, cb = {}) {
      this.net = backend; this.selfId = backend.selfId; this.getProfile = getProfile; this.cb = cb;
      this.name = loadName();
      this.games = new Map();       // host peer id -> { entry, seen }
      this.unreachable = new Set(); // lobby peers a direct connection could not be made to
      this.room = null;             // { id, name, mode, mission, difficulty, max, locked, state, hostId, players: [{ id, name, ship, ready }] }
      this.chat = [];
      this.session = null;
      this.lt = null; this.rt = null;
      this._approved = new Map(); this._banned = new Set(); this._key = ''; this._knock = null; this._hello = null; this._ship = null;
      this._timer = null; this._beat = 0; this._closed = false;
   }
   get isHost() { return !!this.room && this.room.hostId === this.selfId; }
   get me() { return this.room?.players.find(p => p.id === this.selfId) || null; }
   list() { return [...this.games.values()].map(g => g.entry).sort((a, b) => a.name.localeCompare(b.name, 'de') || a.id.localeCompare(b.id)); }
   status() { return this.net.status(); }

   setName(n) {
      n = cleanName(n); if (!n) return;
      this.name = n; saveName(n);
      if (!this.room) return;
      if (this.isHost) { this.me.name = n; this._sync(); } else this.rt?.send('room', { t: 'set', name: n }, this.room.hostId);
   }

   // ------------------------------------------------------------ discovery
   async open() {
      if (this.lt || this._closed) return;
      const lt = await this.net.openLobby((e) => { if (e.kind === 'unreachable' && e.peerId) { this.unreachable.add(e.peerId); this.cb.onList?.(); } });
      if (this._closed || this.lt) { lt.leave(); return; }
      this.lt = lt;
      lt.on('list', (d, from) => {
         if (d && d.gone) { if (this.games.delete(from)) this.cb.onList?.(); return; }
         const entry = cleanEntry(d);
         if (!entry) return;
         entry.hostId = from;
         this.games.set(from, { entry, seen: Date.now() });
         this.cb.onList?.();
      });
      lt.on('knock', (d, from) => this._onKnock(d, from));
      lt.on('knockr', (d, from) => { if (this._knock && from === this._knock.hostId) this._knock.resolve(d); });
      lt.onPeerJoin((id) => { this.unreachable.delete(id); if (this.isHost) lt.send('list', this._entry(), id); });
      lt.onPeerLeave((id) => { if (this.games.delete(id)) this.cb.onList?.(); });
      if (this.isHost) lt.send('list', this._entry());
      if (!this._timer) this._timer = setInterval(() => this._tick(), TICK_MS);
   }
   _closeLobby() {
      if (!this.lt) return;
      this.lt.leave(); this.lt = null; this.games.clear();
   }
   _tick() {
      const now = Date.now();
      let changed = false;
      for (const [id, g] of this.games) if (now - g.seen > STALE_MS) { this.games.delete(id); changed = true; }
      if (changed) this.cb.onList?.();
      for (const [id, until] of this._approved) if (until < now && !this.room?.players.some(p => p.id === id)) this._approved.delete(id);
      if (this.isHost && this.lt && now - this._beat >= HEARTBEAT_MS) this._announce();
   }
   _entry() {
      const r = this.room;
      return { id: r.id, name: r.name, host: this.me?.name || this.name, mode: r.mode, mission: r.mission, difficulty: r.difficulty,
         players: r.players.length, max: r.max, locked: r.locked, state: r.state, v: NET_VERSION };
   }
   _announce() { this._beat = Date.now(); this.lt?.send('list', this._entry()); }

   // ------------------------------------------------------------ hosting
   // opts: { name, mode, mission, difficulty, max, password }
   async host(opts) {
      if (this.room) throw new NetError('busy', 'Du bist bereits in einem Spiel.');
      const mission = coopSlots(opts.mission) > 0 ? opts.mission : coopMissions()[0]?.id;
      if (!mission) throw new NetError('nomission', 'Keine Mission für den Mehrspielermodus verfügbar.');
      const id = randId(10), password = String(opts.password || '');
      const key = await deriveKey(password, id);
      this._key = key; this._approved.clear(); this._banned.clear();
      const ship = this._ship = pickShip(mission, this.getProfile(), this._ship);
      this.room = {
         id, name: cleanName(opts.name, 32) || `Spiel von ${this.name}`, mode: 'coop', mission,
         difficulty: DIFFICULTIES.includes(opts.difficulty) ? opts.difficulty : 'normal',
         max: Math.min(coopSlots(mission), Math.max(1, Math.floor(opts.max) || coopSlots(mission))),
         locked: !!password, state: 'lobby', hostId: this.selfId,
         players: [{ id: this.selfId, name: this.name, ship, ready: false }],
      };
      this.chat = [];
      try {
         this.rt = await this.net.openRoom(id, this.selfId, key, (peer) => this._approved.has(peer) && !this._banned.has(peer));
      } catch (e) { this.room = null; throw new NetError('net', 'Das Spiel konnte nicht eröffnet werden.'); }
      this._wireRoom();
      this._announce();
      this.cb.onRoom?.();
   }
   async _onKnock(d, from) {
      if (!this.isHost || !d || d.room !== this.room.id) { if (d && this.lt) this.lt.send('knockr', { ok: false, why: 'gone' }, from); return; }
      const r = this.room, now = Date.now();
      const seats = r.players.length + [...this._approved].filter(([id, until]) => id !== from && until > now && !r.players.some(p => p.id === id)).length;
      let why = null;
      if (d.v !== NET_VERSION) why = 'version';
      else if (this._banned.has(from)) why = 'banned';
      else if (r.locked && d.proof !== await proofOf(this._key, r.id, from)) why = 'password';
      else if (r.state !== 'lobby') why = 'running';
      else if (seats >= r.max) why = 'full';
      if (!this.isHost || this.room !== r) return;
      if (!why) this._approved.set(from, now + SEAT_MS);
      this.lt?.send('knockr', why ? { ok: false, why } : { ok: true }, from);
   }
   // host only: change mission / difficulty / player limit while in the lobby
   configure(o) {
      const r = this.room;
      if (!this.isHost || r.state !== 'lobby') return;
      if (o.mission && o.mission !== r.mission && coopSlots(o.mission) > 0) {
         r.mission = o.mission;
         r.max = Math.max(r.players.length, Math.min(r.max, coopSlots(r.mission)));
         const allowed = allowedShips(r.mission);
         for (const p of r.players) { p.ready = false; if (!allowed.includes(p.ship)) p.ship = null; }
         this._fixOwnShip();
      }
      if (o.difficulty && DIFFICULTIES.includes(o.difficulty)) r.difficulty = o.difficulty;
      if (o.max) r.max = Math.max(r.players.length, Math.min(coopSlots(r.mission), Math.floor(o.max) || r.max));
      this._sync();
   }
   kick(id) {
      const r = this.room;
      if (!this.isHost || id === this.selfId) return;
      const p = r.players.find(x => x.id === id);
      this._banned.add(id); this._approved.delete(id);
      this.rt.send('room', { t: 'kick' }, id);
      if (p) { r.players = r.players.filter(x => x.id !== id); this._say(null, `${p.name} wurde entfernt.`); }
      this.session?.transport._leave(id);
      this._sync();
   }
   canStart() {
      const r = this.room;
      if (!this.isHost || r.state !== 'lobby') return false;
      return r.players.every(p => p.ship && (p.id === this.selfId || p.ready));
   }
   start() {
      if (!this.canStart()) return false;
      const r = this.room;
      const msg = { t: 'start', mode: r.mode, mission: r.mission, difficulty: r.difficulty, seed: crypto.getRandomValues(new Uint32Array(1))[0],
         players: r.players.map(p => ({ id: p.id, name: p.name, ship: p.ship })) };
      r.state = 'running';
      for (const p of r.players) p.ready = false;
      this.rt.send('room', msg);
      this._sync();
      this._begin(msg);
      return true;
   }

   // ------------------------------------------------------------ joining
   async join(entry, password = '') {
      if (this.room || this._joining) throw new NetError('busy', 'Du bist bereits in einem Spiel.');
      if (entry.v !== NET_VERSION) throw new NetError('version', DENY.version);
      if (!this.lt || !this.lt.peers().includes(entry.hostId)) throw new NetError('gone', DENY.gone);
      this._joining = true;
      let rt = null;
      try {
         const key = entry.locked ? await deriveKey(String(password), entry.id) : '';
         const proof = entry.locked ? await proofOf(key, entry.id, this.selfId) : '';
         const answer = await new Promise((resolve) => {
            this._knock = { hostId: entry.hostId, resolve };
            this.lt.send('knock', { room: entry.id, proof, v: NET_VERSION }, entry.hostId);
            setTimeout(() => resolve(null), KNOCK_MS);
         });
         this._knock = null;
         if (!answer) throw new NetError('timeout', 'Der Host antwortet nicht.');
         if (!answer.ok) throw new NetError(answer.why, DENY[answer.why] || 'Der Host hat den Beitritt abgelehnt.');
         // connect to the game room and wait for the host to show up there
         let fail = null, wake = () => { };
         rt = await this.net.openRoom(entry.id, entry.hostId, key, null, (e) => { if (e.peerId === entry.hostId || !e.peerId) { fail = e.kind; wake(); } });
         const result = await new Promise((resolve) => {
            const t = setTimeout(() => resolve('timeout'), CONNECT_MS);
            wake = () => { clearTimeout(t); resolve(fail); };
            this._hello = (r) => { clearTimeout(t); resolve(r); };
            const hello = () => rt.send('room', { t: 'hello', name: this.name, ship: this._ship = pickShip(entry.mission, this.getProfile(), this._ship) }, entry.hostId);
            rt.on('room', (m, from) => { if (from === entry.hostId) this._clientMsg(m); });
            rt.onPeerJoin((id) => { if (id === entry.hostId) hello(); });
            if (rt.peers().includes(entry.hostId)) hello();
            this._pendingRoom = { id: entry.id, hostId: entry.hostId };
         });
         this._hello = null; this._pendingRoom = null;
         if (result !== 'ok') {
            if (result === 'password') throw new NetError('password', DENY.password);
            if (DENY[result]) throw new NetError(result, DENY[result]);
            if (result === 'handshake') throw new NetError('denied', 'Der Host hat den Beitritt abgelehnt.');
            throw new NetError('unreachable', 'Keine direkte Verbindung zum Host möglich. Vermutlich blockiert ein Router oder eine Firewall die Verbindung; einen Relay-Server gibt es nicht.');
         }
         this.rt = rt; rt = null;
         this.chat = [];
         this._wireRoom();
         this._closeLobby();
         this.cb.onRoom?.();
      } finally {
         this._joining = false; this._knock = null; this._hello = null; this._pendingRoom = null;
         if (rt) { rt.leave(); this.room = null; }
      }
   }

   // ------------------------------------------------------------ room (both sides)
   _wireRoom() {
      const rt = this.rt;
      rt.on('room', (m, from) => { if (this.isHost) this._hostMsg(m, from); else if (from === this.room?.hostId) this._clientMsg(m); });
      rt.on('chat', (m, from) => {
         if (this.isHost) { const p = this.room.players.find(x => x.id === from); if (p && m && typeof m.text === 'string') this._say(p, m.text); }
         else if (from === this.room?.hostId && m) this._chatLine(m);
      });
      rt.onPeerJoin((id) => { this.session?.transport._join(id); });
      rt.onPeerLeave((id) => {
         this.session?.transport._leave(id);
         if (!this.room) return;
         if (this.isHost) {
            const p = this.room.players.find(x => x.id === id);
            this._approved.delete(id);
            if (p) { this.room.players = this.room.players.filter(x => x.id !== id); this._say(null, `${p.name} hat das Spiel verlassen.`); this._sync(); }
         } else if (id === this.room.hostId) this._drop('hostleft', 'Der Host hat das Spiel verlassen.');
      });
   }
   _hostMsg(m, from) {
      const r = this.room;
      if (!m || !r) return;
      let p = r.players.find(x => x.id === from);
      if (m.t === 'hello') {
         if (p) { this.rt.send('room', this._state(), from); return; }
         const why = this._banned.has(from) ? 'banned' : !this._approved.has(from) ? 'gone' : r.state !== 'lobby' ? 'running' : r.players.length >= r.max ? 'full' : null;
         if (why) { this.rt.send('room', { t: 'deny', why }, from); return; }
         p = { id: from, name: cleanName(m.name) || 'Kapitän', ship: allowedShips(r.mission).includes(m.ship) ? m.ship : null, ready: false };
         r.players.push(p);
         this._say(null, `${p.name} ist beigetreten.`);
         this._sync();
      } else if (!p) return;
      else if (m.t === 'set') {
         if (r.state !== 'lobby' && ('ship' in m || 'ready' in m)) return;
         if (typeof m.name === 'string' && cleanName(m.name)) p.name = cleanName(m.name);
         if ('ship' in m) { p.ship = allowedShips(r.mission).includes(m.ship) ? m.ship : null; if (!p.ship) p.ready = false; }
         if ('ready' in m) p.ready = !!m.ready && !!p.ship;
         this._sync();
      } else if (m.t === 'bye') {
         this._approved.delete(from);
         r.players = r.players.filter(x => x.id !== from);
         this._say(null, `${p.name} hat das Spiel verlassen.`);
         this.session?.transport._leave(from);
         this._sync();
      }
   }
   _clientMsg(m) {
      if (!m) return;
      if (m.t === 'state' && m.room && Array.isArray(m.players)) {
         const pend = this._pendingRoom, cur = this.room;
         const base = cur || pend; if (!base) return;
         this.room = {
            id: base.id, hostId: base.hostId, name: cleanName(m.room.name, 32), mode: String(m.room.mode), mission: String(m.room.mission), difficulty: String(m.room.difficulty),
            max: Number(m.room.max) || 1, locked: !!m.room.locked, state: m.room.state === 'running' ? 'running' : 'lobby',
            players: m.players.slice(0, 16).map(p => ({ id: String(p.id), name: cleanName(p.name) || '?', ship: SHIPS[p.ship] ? p.ship : null, ready: !!p.ready })),
         };
         const me = this.me;
         if (me && this._hello) this._hello('ok');
         if (me && !me.ship && this.room.state === 'lobby') this._fixOwnShip();
         if (cur) this.cb.onRoom?.();
      } else if (m.t === 'deny') this._hello?.(DENY[m.why] ? m.why : 'gone');
      else if (m.t === 'kick') this._drop('kicked', 'Der Host hat dich aus dem Spiel entfernt.');
      else if (m.t === 'closed') this._drop('hostleft', 'Der Host hat das Spiel geschlossen.');
      else if (m.t === 'start' && this.room && Array.isArray(m.players) && m.players.some(p => p.id === this.selfId)) this._begin(m);
   }
   _state() {
      const r = this.room;
      return { t: 'state', room: { name: r.name, mode: r.mode, mission: r.mission, difficulty: r.difficulty, max: r.max, locked: r.locked, state: r.state }, players: r.players };
   }
   // host: push the room state to everybody and refresh the listing
   _sync() {
      this.rt?.send('room', this._state());
      this._announce();
      this.cb.onRoom?.();
   }
   // my ship is no longer valid for the mission: fall back to an own ship that is
   _fixOwnShip() {
      const me = this.me, ship = pickShip(this.room.mission, this.getProfile(), this._ship);
      if (!me || !ship || me.ship === ship) return;
      if (this.isHost) me.ship = ship; else this.rt?.send('room', { t: 'set', ship }, this.room.hostId);
   }
   setShip(ship) {
      const r = this.room;
      if (!r || r.state !== 'lobby' || !ownShips(r.mission, this.getProfile()).includes(ship)) return;
      this._ship = ship;
      if (this.isHost) { this.me.ship = ship; this._sync(); } else this.rt.send('room', { t: 'set', ship }, r.hostId);
   }
   setReady(on) {
      const r = this.room;
      if (!r || r.state !== 'lobby') return;
      if (this.isHost) { this.me.ready = !!on && !!this.me.ship; this._sync(); } else this.rt.send('room', { t: 'set', ready: !!on }, r.hostId);
   }
   sendChat(text) {
      text = cleanName(text, CHAT_MAX);
      if (!text || !this.room) return;
      if (this.isHost) this._say(this.me, text); else this.rt.send('chat', { text }, this.room.hostId);
   }
   // host: add a chat line (from = player or null for a system line) and send it to everybody
   _say(from, text) {
      const line = { id: from?.id || '', name: from?.name || '', text: cleanName(text, CHAT_MAX), ts: Date.now() };
      this.rt?.send('chat', line);
      this._chatLine(line);
   }
   _chatLine(m) {
      const line = { id: String(m.id || ''), name: cleanName(m.name), text: cleanName(m.text, CHAT_MAX), ts: Number(m.ts) || Date.now() };
      this.chat.push(line);
      if (this.chat.length > CHAT_KEEP) this.chat.shift();
      this.cb.onChat?.(line);
   }

   // ------------------------------------------------------------ match hand-over
   _begin(m) {
      if (this.session) return;
      const players = m.players.map(p => ({ id: String(p.id), name: String(p.name), ship: String(p.ship) }));
      let done = false;
      const transport = sessionTransport(this.rt, players.map(p => p.id), () => this.leaveRoom());
      const session = {
         transport, mode: String(m.mode), mission: String(m.mission), difficulty: String(m.difficulty), seed: m.seed >>> 0, players,
         onEnd: (result) => {
            if (done) return;
            done = true; transport._close();
            if (this.session === session) this.session = null;
            if (this.room && this.isHost && this.room.state === 'running') { this.room.state = 'lobby'; this._sync(); }
            this.cb.onEnd?.(result || { aborted: true, reason: '', victory: null });
         },
      };
      this.session = session;
      if (!this.isHost && this.room) { this.room.state = 'running'; }
      this.cb.onStart?.(session);
   }

   // ------------------------------------------------------------ leaving
   // the room is gone for a reason not chosen by the player (host left, kicked)
   _drop(reason, text) {
      if (this._hello) { this._hello(reason === 'kicked' ? 'banned' : 'gone'); return; }
      if (!this.room) return;
      this.session?.transport._leave(this.room.hostId);      // a running match learns that its host is gone
      this._teardown(false);
      this.cb.onLeft?.(reason, text);
      this.open().catch(() => { });
   }
   leaveRoom() {
      if (!this.room) return;
      this._teardown(true);
      this.cb.onLeft?.('self', '');
      this.open().catch(() => { });
   }
   _teardown(polite) {
      const host = this.isHost;
      if (polite && this.rt) { if (host) this.rt.send('room', { t: 'closed' }); else this.rt.send('room', { t: 'bye' }, this.room.hostId); }
      if (host && this.lt) this.lt.send('list', { gone: true });
      const rt = this.rt;
      this.rt = null; this.room = null; this.chat = []; this._approved.clear(); this._key = '';
      // let the goodbye leave the send queue before the connection closes
      if (rt) setTimeout(() => rt.leave(), polite ? 150 : 0);
   }
   // the multiplayer screen is closed: withdraw everything
   close() {
      this._closed = true;
      if (this.room) this._teardown(true);
      if (this.lt) { const lt = this.lt; this.lt = null; setTimeout(() => lt.leave(), 150); }
      this.games.clear();
      clearInterval(this._timer); this._timer = null;
   }
}
