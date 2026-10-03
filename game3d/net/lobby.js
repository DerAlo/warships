// game3d/net/lobby.js — matchmaking logic without any UI (the screen is game3d/mpui.js):
// game list discovery, hosting, joining with an optional password, the room (players, ships,
// ready, chat, kick) and the hand-over to the game (`session`, see CONTRACT.md).
//
// How peers find each other
//   Discovery does not need a connection between the players. Everybody who has the multiplayer
//   screen open listens on a lobby channel (public MQTT brokers, see relay.js / mqtt.js; with
//   ?net=local a BroadcastChannel). Hosts publish their listing entry there: when somebody asks
//   (`who`, sent on opening the screen), when the entry changes and as a heartbeat. A listing
//   disappears when the host withdraws it or when no heartbeat arrived for STALE_MS. A client
//   stops listening while it is inside a game room; a host keeps announcing.
//   Everything on the lobby channel is public and unauthenticated: treat it as untrusted input.
//
// How a game room works (channels `room` and `chat`, host-authoritative)
//   join: client -> host over the lobby `knock` (password proof), host answers `knockr` and
//   reserves a seat; the client then opens the game room transport and says `hello`. The host
//   owns the room state and broadcasts it; clients only send requests (`set`, chat lines).
//   The room transport reaches every peer over the brokers ("relay") at once and switches to a
//   WebRTC data channel ("direct") for the peers where one comes up. No direct channel is not an
//   error: the peer stays relayed.
//
// Password
//   key = PBKDF2-SHA256(password, salt = room id). The knock carries SHA-256(key, room, peer id),
//   never the password. The key encrypts the relayed room traffic (AES-GCM) and is the Trystero
//   room password of the direct route (encrypted WebRTC session descriptions), so somebody who
//   skips the knock can neither read the room nor connect. A game without password is open to
//   everybody by definition (its relay key is derived from the public room id). With ?net=local
//   (BroadcastChannel, test only) just the knock applies.
import { NET_VERSION, makeLocalTransport } from './transport.js';
import { coopSlots, coopRoles } from './coop.js';
import { pvpMissions, pvpSlots, TEAM_MAX } from './pvp.js';
import { MISSIONS, getMission } from '../missions.js';
import { PLAYABLE, SHIPS, isCarrier } from '../config.js';
import { isUnlocked } from '../progress3d.js';

export { NET_VERSION };
export const NAME_KEY = 'warships3d.net.name';
export const MODES = [['coop', 'Koop gegen Bots', true], ['pvp', 'PvP', true]];
export const TEAMS = [1, 2];
export const DIFFICULTIES = ['easy', 'normal', 'hard'];
const HEARTBEAT_MS = 4000, STALE_MS = 13000, TICK_MS = 1000;
const KNOCK_MS = 10000, KNOCK_AGAIN_MS = 2000, CONNECT_MS = 15000, SEAT_MS = 30000;
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
// missions of a mode and how many captains one takes (0 = not in that mode)
export const modeMissions = (mode) => mode === 'pvp' ? pvpMissions() : coopMissions();
export const modeSlots = (mode, missionId) => mode === 'pvp' ? pvpSlots(missionId) : coopSlots(missionId);
const MIN_PLAYERS = { coop: 1, pvp: 2 };
// carriers stay out of net games until the snapshot carries aircraft
export const allowedShips = (missionId) => (getMission(missionId)?.playableShips || PLAYABLE).filter(k => !isCarrier(k));
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
   norejoin: 'Dieses Gefecht ist vorbei oder du hast nicht daran teilgenommen.',
};

// The seat in a running match, kept per tab (survives a reload, not a closed tab): with it a
// dropped captain may knock again while the match runs (see CONTRACT.md, "Rejoin").
const REJOIN_KEY = 'warships3d.net.rejoin';
const REJOIN_MAX_MS = 3 * 3600e3;
function loadSeat() {
   try {
      const r = JSON.parse(sessionStorage.getItem(REJOIN_KEY) || 'null');
      if (r && typeof r.room === 'string' && typeof r.token === 'string' && Date.now() - (r.at || 0) < REJOIN_MAX_MS) return r;
   } catch (e) { /* no storage */ }
   return null;
}
function saveSeat(r) { try { if (r) sessionStorage.setItem(REJOIN_KEY, JSON.stringify(r)); else sessionStorage.removeItem(REJOIN_KEY); } catch (e) { /* no storage */ } }

// ---------------------------------------------------------------- backends
// A backend opens the lobby channel ({ send, on, leave }) and game room Transports.
// mode: 'local' = BroadcastChannel (tests, no network), 'relay' = brokers only, never WebRTC,
//       anything else = brokers plus a direct WebRTC channel where one comes up.
export async function makeBackend(mode) {
   if (mode === true || mode === 'local') {
      const selfId = randId(16);
      return {
         local: true, selfId,
         openLobby: async () => makeLocalTransport('lobby', selfId, ''),
         openRoom: async (id, hostId) => makeLocalTransport('g-' + id, selfId, hostId),
         status: () => ({ open: 1, total: 1 }),
      };
   }
   const { Bus, makeBusLobby, makeRoomTransport } = await import('./relay.js');
   let rtc = null;
   if (mode !== 'relay') { try { rtc = await import('./transport_rtc.js'); } catch (e) { console.warn('multiplayer: WebRTC module not available, relay only', e); } }
   const selfId = rtc ? rtc.selfId : randId(20);
   const bus = new Bus();
   return {
      local: false, selfId, bus,
      openLobby: async () => makeBusLobby(bus, selfId),
      openRoom: (id, hostId, key, admit) => makeRoomTransport({ bus, selfId, room: id, hostId, key, admit,
         direct: rtc ? (hooks) => rtc.makeRtcCarrier('g-' + id, { password: key, admit, ...hooks }) : null }),
      status: () => bus.status(),
   };
}

// The Transport handed to the game for one match: the room transport restricted to the players
// of that match, with its own onPeerJoin/onPeerLeave slots (the room keeps the real ones) and
// without access to the matchmaking channels. After a host migration the game moves the host
// (_setHost) and adds the players the old host knew under other ids (_add).
function sessionTransport(base, members, onLeave) {
   const set = new Set(members);
   let join = null, leave = null, rejoin = null, live = true, hostId = base.hostId;
   const peers = () => base.peers().filter(id => set.has(id));
   return {
      selfId: base.selfId,
      get hostId() { return hostId; },
      get isHost() { return base.selfId === hostId; },
      peers,
      link: (id) => base.link?.(id) ?? null,            // { via: 'direct'|'relay', rtt } with the real transport
      stats: () => base.stats?.() ?? null,
      // ms since any peer of the room but `except` was last heard (null: nobody else there)
      heardAny: base.heardAny ? (except) => base.heardAny(except) : undefined,
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
      onRejoin(fn) { rejoin = fn; },                    // host: fn(oldId, newId), a captain is back
      leave() { if (live) onLeave(); },
      _join(id) { if (live && set.has(id)) join?.(id); },
      _leave(id) { if (live && set.delete(id)) leave?.(id); },      // at most once per player
      _rejoin(oldId, newId) { if (!live) return; set.delete(oldId); set.add(newId); rejoin?.(oldId, newId); },
      _add(ids) { if (live) for (const id of ids) if (typeof id === 'string' && id !== base.selfId) set.add(id); },
      _setHost(id) { hostId = id; },
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
      this.room = null;             // { id, name, mode, mission, difficulty, max, locked, teamsLocked, state, hostId, players: [{ id, name, ship, ready, team }] }
      this.chat = [];
      this.session = null;
      this.lt = null; this.rt = null;
      this._approved = new Map(); this._banned = new Set(); this._key = ''; this._knock = null; this._hello = null; this._ship = null;
      this._timer = null; this._beat = 0; this._closed = false;
      // host, running match: seat id -> { orig, id, token, name, ship }; peers re-admitted to a seat
      this._seats = new Map(); this._back = new Map(); this._startMsg = null;
      this._pendingStart = null;    // client: a start that came in before the room was wired
      // host migration: host -> the successor it named; client: what the host handed over
      // ({ seats, start, banned }), whether the host is gone while the match runs
      this._succ = null; this._heir = null; this._orphan = false;
   }
   // client: the running match this tab can go back to ({ room, hostId, mission, name, ... }) or null
   rejoinable() { return loadSeat(); }
   canRejoin(entry) {
      const r = loadSeat();
      // by room: after a host migration the game is listed under its new host
      return !!(r && entry && entry.id === r.room && entry.state === 'running');
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
      const lt = await this.net.openLobby();
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
      lt.on('who', () => { if (this.isHost && Date.now() - this._beat > 700) this._announce(); });
      if (this.isHost) this._announce(); else lt.send('who', 1);
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
      const mode = opts.mode === 'pvp' ? 'pvp' : 'coop';
      const mission = modeSlots(mode, opts.mission) > 0 ? opts.mission : modeMissions(mode)[0]?.id;
      if (!mission) throw new NetError('nomission', 'Keine Mission für den Mehrspielermodus verfügbar.');
      const id = randId(10), password = String(opts.password || '');
      const key = await deriveKey(password, id);
      this._key = key; this._approved.clear(); this._banned.clear();
      const ship = this._ship = pickShip(mission, this.getProfile(), this._ship);
      this.room = {
         id, name: cleanName(opts.name, 32) || `Spiel von ${this.name}`, mode, mission,
         difficulty: DIFFICULTIES.includes(opts.difficulty) ? opts.difficulty : 'normal',
         max: Math.min(modeSlots(mode, mission), Math.max(MIN_PLAYERS[mode], Math.floor(opts.max) || modeSlots(mode, mission))),
         locked: !!password, teamsLocked: false, state: 'lobby', hostId: this.selfId,
         players: [{ id: this.selfId, name: this.name, ship, ready: false, team: mode === 'pvp' ? 1 : 0 }],
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
      // the knocking peer itself takes no seat: it may still be listed from a visit whose goodbye got lost
      const seats = r.players.filter(p => p.id !== from).length + [...this._approved].filter(([id, until]) => id !== from && until > now && !r.players.some(p => p.id === id)).length;
      let why = null, seat = null;
      if (d.v !== NET_VERSION) why = 'version';
      else if (this._banned.has(from)) why = 'banned';
      else if (typeof d.seat === 'string') {
         // back to the running match: the proof is made with the seat's token instead of the password
         seat = r.state === 'running' && this.session ? this._seats.get(d.seat) : null;
         if (!seat || d.proof !== await proofOf(seat.token, r.id, from)) why = 'norejoin';
      }
      else if (r.locked && d.proof !== await proofOf(this._key, r.id, from)) why = 'password';
      else if (r.state !== 'lobby') why = 'running';
      else if (seats >= r.max) why = 'full';
      if (!this.isHost || this.room !== r) return;
      if (!why) this._approved.set(from, now + SEAT_MS);
      if (seat && !why) this._back.set(from, d.seat);
      this.lt?.send('knockr', why ? { ok: false, why } : { ok: true }, from);
   }
   // host only: change mission / difficulty / player limit while in the lobby
   configure(o) {
      const r = this.room;
      if (!this.isHost || r.state !== 'lobby') return;
      const slots = (id) => modeSlots(r.mode, id);
      if (o.mission && o.mission !== r.mission && slots(o.mission) >= Math.max(1, r.players.length)) {
         // a prescribed ship is no choice of the player (maybe not even unlocked): everybody picks anew
         const wasFixed = coopRoles(r.mission, r.difficulty).length > 0;
         r.mission = o.mission;
         r.max = Math.max(r.players.length, Math.min(r.max, slots(r.mission)));
         const allowed = allowedShips(r.mission);
         for (const p of r.players) { p.ready = false; if (wasFixed || !allowed.includes(p.ship)) p.ship = null; }
         this._fixOwnShip();
      }
      if (o.difficulty && DIFFICULTIES.includes(o.difficulty)) r.difficulty = o.difficulty;
      if (o.max) r.max = Math.max(r.players.length, MIN_PLAYERS[r.mode] || 1, Math.min(slots(r.mission), Math.floor(o.max) || r.max));
      this._sync();
   }
   // ------------------------------------------------------------ PvP teams
   teamSize(team) { return this.room ? this.room.players.filter(p => p.team === team).length : 0; }
   // the team a newcomer joins: the smaller one (team 1 when even)
   _freeTeam() { return this.teamSize(1) <= this.teamSize(2) ? 1 : 2; }
   // may player p move to `team`? (the host may also while the teams are locked)
   _teamOk(p, team, byHost) {
      const r = this.room;
      return r.mode === 'pvp' && r.state === 'lobby' && TEAMS.includes(team) && p.team !== team && (byHost || !r.teamsLocked) && this.teamSize(team) < TEAM_MAX;
   }
   // the local player asks for a team (host: moves itself)
   chooseTeam(team) {
      const r = this.room;
      if (!r || r.mode !== 'pvp') return;
      if (this.isHost) this.setTeam(this.selfId, team);
      else this.rt?.send('room', { t: 'set', team }, r.hostId);
   }
   // host: move a player to a team
   setTeam(id, team) {
      const p = this.isHost && this.room.players.find(x => x.id === id);
      if (!p || !this._teamOk(p, team, true)) return;
      p.team = team; p.ready = p.id === this.selfId ? p.ready : false;
      this._sync();
   }
   // host: even out the teams (the latest to join move), at most one apart
   balanceTeams() {
      const r = this.room;
      if (!this.isHost || r.mode !== 'pvp' || r.state !== 'lobby') return;
      for (;;) {
         const a = this.teamSize(1), b = this.teamSize(2);
         if (Math.abs(a - b) <= 1) break;
         const from = a > b ? 1 : 2, p = [...r.players].reverse().find(x => x.team === from && x.id !== this.selfId);
         if (!p) break;
         p.team = 3 - from; p.ready = false;
      }
      this._say(null, 'Teams ausgeglichen.');
      this._sync();
   }
   // host: players may (not) change teams themselves
   lockTeams(on) {
      const r = this.room;
      if (!this.isHost || r.mode !== 'pvp') return;
      r.teamsLocked = !!on;
      this._sync();
   }
   kick(id) {
      const r = this.room;
      if (!this.isHost || id === this.selfId) return;
      const p = r.players.find(x => x.id === id);
      this._banned.add(id); this._approved.delete(id); this._back.delete(id);
      for (const [sid, s] of this._seats) if (s.id === id) this._seats.delete(sid);
      this.rt.send('room', { t: 'kick' }, id);
      if (p) { r.players = r.players.filter(x => x.id !== id); this._say(null, `${p.name} wurde entfernt.`); }
      this.session?.transport._leave(id);
      this._sync();
      this._sendSeats();
   }
   canStart() {
      const r = this.room;
      if (!this.isHost || r.state !== 'lobby') return false;
      if (r.mode === 'pvp' && (!this.teamSize(1) || !this.teamSize(2))) return false;   // somebody to fight
      return r.players.every(p => p.ship && (p.id === this.selfId || p.ready));
   }
   start() {
      if (!this.canStart()) return false;
      const r = this.room;
      const msg = { t: 'start', mode: r.mode, mission: r.mission, difficulty: r.difficulty, seed: crypto.getRandomValues(new Uint32Array(1))[0],
         players: r.players.map(p => ({ id: p.id, name: p.name, ship: p.ship, ...(r.mode === 'pvp' ? { team: p.team } : null) })) };
      r.state = 'running';
      for (const p of r.players) p.ready = false;
      this.rt.send('room', msg);
      // every captain gets a seat token: proof for a rejoin after a reload or a lost connection
      this._seats.clear(); this._back.clear(); this._startMsg = msg;
      // the host's own seat is kept here: the way back after it left the match to a successor
      for (const p of msg.players) {
         const seat = { orig: p.id, id: p.id, token: randId(24), name: p.name, ship: p.ship }, sid = randId(10);
         this._seats.set(sid, seat);
         if (p.id === this.selfId) saveSeat({ room: r.id, hostId: this.selfId, seat: sid, token: seat.token, key: this._key, mission: r.mission, name: r.name, at: Date.now() });
         else this.rt.send('room', { t: 'seat', seat: sid, token: seat.token }, p.id);
      }
      this._sync();
      this._begin(msg);
      return true;
   }
   // host: an approved peer with a seat said hello in the room: it takes over its old place
   _rejoinSeat(from) {
      const r = this.room, sid = this._back.get(from), seat = this._seats.get(sid);
      this._back.delete(from);
      if (!seat || r.state !== 'running' || !this.session || !this._startMsg) { this.rt.send('room', { t: 'deny', why: 'norejoin' }, from); return; }
      const old = seat.id;
      seat.id = from;
      r.players = r.players.filter(x => x.id !== old && x.id !== from);
      const p = { id: from, name: seat.name, ship: seat.ship, ready: false, at: Date.now() };
      r.players.push(p);
      this._say(null, `${p.name} ist zurück im Gefecht.`);
      this.session.transport._rejoin(old, from);
      this._sync();
      const ids = new Map([...this._seats.values()].map(s => [s.orig, s.id]));
      const m = this._startMsg;
      this.rt.send('room', { ...m, players: m.players.map(q => ({ ...q, id: ids.get(q.id) || q.id })), back: 1 }, from);
      this.rt.send('room', { t: 'seat', seat: sid, token: seat.token }, from);
      this._sendSeats();
   }
   // host: the successor of the running match gets what the lobby needs to carry on (rejoin
   // seats, the start message, the banned peers)
   _sendSeats() {
      if (!this._succ || !this.rt || !this.isHost || !this._startMsg) return;
      this.rt.send('room', { t: 'seats', seats: [...this._seats].map(([sid, x]) => [sid, x.orig, x.id, x.token, x.name, x.ship]),
         start: this._startMsg, banned: [...this._banned].slice(0, 64) }, this._succ);
   }
   // everybody: `id` runs the match now (game.js, host migration). The room and the listing move
   // to it; the successor takes over the host's part of the lobby.
   _newHost(id) {
      const r = this.room;
      if (!r || !this.rt || r.hostId === id) return;
      const old = r.hostId;
      r.hostId = id; this._orphan = false;
      this.rt.hostId = id;
      const s = loadSeat();
      if (s && s.room === r.id) saveSeat({ ...s, hostId: id });
      r.players = r.players.filter(p => p.id !== old);
      if (id !== this.selfId) {
         // ask the new host for the room state (its first one may have come before the switch)
         this.rt.send('room', { t: 'hello', name: this.name, ship: this.me?.ship || null }, id);
         this.cb.onRoom?.();
         return;
      }
      const h = this._heir; this._heir = null;
      this._seats = new Map((h?.seats || []).map(([sid, orig, pid, token, name, ship]) => [sid, { orig, id: pid, token, name, ship }]));
      this._startMsg = h?.start || null;
      for (const b of h?.banned || []) this._banned.add(b);
      this._back.clear(); this._approved.clear(); this._succ = null;
      for (const p of r.players) p.at = p.at || Date.now();
      this.rt.setAdmit?.((peer) => this._approved.has(peer) && !this._banned.has(peer));
      this._say(null, `Gastgeber gewechselt – ${this.me?.name || this.name} führt das Spiel weiter.`);
      this._sync();
      this.open().catch(() => { });
   }

   // ------------------------------------------------------------ joining
   // back: the seat record of rejoinable() to go back into the running match of that room
   async join(entry, password = '', back = null) {
      if (this.room || this._joining) throw new NetError('busy', 'Du bist bereits in einem Spiel.');
      if (entry.v !== NET_VERSION) throw new NetError('version', DENY.version);
      if (!this.lt) throw new NetError('gone', DENY.gone);
      this._joining = true;
      let rt = null, again = null;
      try {
         const key = back ? String(back.key || '') : entry.locked ? await deriveKey(String(password), entry.id) : '';
         const proof = back ? await proofOf(back.token, entry.id, this.selfId) : entry.locked ? await proofOf(key, entry.id, this.selfId) : '';
         const answer = await new Promise((resolve) => {
            this._knock = { hostId: entry.hostId, resolve };
            // the lobby channel may lose a message: knock until the host answers
            const knock = () => this.lt?.send('knock', back ? { room: entry.id, proof, v: NET_VERSION, seat: back.seat } : { room: entry.id, proof, v: NET_VERSION }, entry.hostId);
            knock();
            again = setInterval(knock, KNOCK_AGAIN_MS);
            setTimeout(() => resolve(null), KNOCK_MS);
         });
         clearInterval(again);
         this._knock = null;
         if (!answer) throw new NetError('timeout', 'Der Host antwortet nicht.');
         if (!answer.ok) {
            if (back && answer.why === 'norejoin') saveSeat(null);
            throw new NetError(answer.why, DENY[answer.why] || 'Der Host hat den Beitritt abgelehnt.');
         }
         this._key = key;
         // open the game room and wait for the host to show up there (over the relay within a
         // moment; whether a direct channel follows does not matter here)
         rt = await this.net.openRoom(entry.id, entry.hostId, key, null);
         const result = await new Promise((resolve) => {
            const t = setTimeout(() => resolve('timeout'), CONNECT_MS);
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
            throw new NetError('unreachable', 'Der Host ist nicht erreichbar: Weder eine direkte Verbindung noch der Weg über das Relay kam zustande. Bitte später erneut versuchen.');
         }
         this.rt = rt; rt = null;
         this.chat = [];
         this._wireRoom();
         this._closeLobby();
         this.cb.onRoom?.();
         const m = this._pendingStart;
         this._pendingStart = null;
         if (m) this._begin(m);
      } finally {
         clearInterval(again);
         this._joining = false; this._knock = null; this._hello = null; this._pendingRoom = null; this._pendingStart = null;
         if (rt) { rt.leave(); this.room = null; this._key = ''; }
      }
   }
   // back into the running match this tab took part in (rejoinable()); leaves a room first
   async rejoin() {
      const rec = loadSeat();
      if (!rec) throw new NetError('norejoin', DENY.norejoin);
      if (this.room) { this._teardown(true); await new Promise(r => setTimeout(r, 300)); }   // the old room transport is closed first
      await this.open();
      // the room's listing names its host now (another one after a host migration)
      const find = () => [...this.games.values()].map(g => g.entry).find(e => e.id === rec.room);
      for (let i = 0; i < 20 && !find(); i++) await new Promise(r => setTimeout(r, 200));
      const known = find();
      return this.join({ id: rec.room, hostId: known?.hostId || rec.hostId, v: NET_VERSION, locked: false, mission: known?.mission || rec.mission, name: known?.name || rec.name }, '', rec);
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
      // a player's route changed (relay <-> direct): the host tells everybody
      rt.onRoute?.(() => { if (this.isHost) this._sync(); else this.cb.onRoom?.(); });
      rt.onPeerLeave((id) => {
         this.session?.transport._leave(id);
         if (!this.room) return;
         if (this.isHost) {
            const p = this.room.players.find(x => x.id === id);
            this._unseat(id, p);
            if (p) { this.room.players = this.room.players.filter(x => x.id !== id); this._say(null, `${p.name} hat das Spiel verlassen.`); this._sync(); }
         } else if (id === this.room.hostId) {
            // a running match may go on under a successor (game.js); otherwise session.onEnd drops
            if (this.session && this.room.state === 'running') this._orphan = true;
            else this._drop('hostleft', 'Der Host hat das Spiel verlassen.');
         }
      });
   }
   // host: player p (may be undefined) is gone, its seat reservation with it. A reservation made
   // after that player came in belongs to its next visit and stays: the goodbye of the earlier
   // visit may arrive after the new knock (or never, then the re-join itself ends the old visit).
   // What is kept here runs out by itself (SEAT_MS).
   _unseat(id, p) {
      const until = this._approved.get(id);
      if (until !== undefined && p && until - SEAT_MS <= p.at) this._approved.delete(id);
   }
   _hostMsg(m, from) {
      const r = this.room;
      if (!m || !r) return;
      let p = r.players.find(x => x.id === from);
      if (m.t === 'hello') {
         if (this._back.has(from) && this._approved.has(from) && !this._banned.has(from)) { this._rejoinSeat(from); return; }
         if (p) { this.rt.send('room', this._state(), from); return; }
         const why = this._banned.has(from) ? 'banned' : !this._approved.has(from) ? 'gone' : r.state !== 'lobby' ? 'running' : r.players.length >= r.max ? 'full' : null;
         if (why) { this.rt.send('room', { t: 'deny', why }, from); return; }
         p = { id: from, name: cleanName(m.name) || 'Kapitän', ship: allowedShips(r.mission).includes(m.ship) ? m.ship : null, ready: false, at: Date.now(),
            team: r.mode === 'pvp' ? this._freeTeam() : 0 };
         r.players.push(p);
         this._say(null, `${p.name} ist beigetreten.`);
         this._sync();
      } else if (!p) return;
      else if (m.t === 'set') {
         if (r.state !== 'lobby' && ('ship' in m || 'ready' in m)) return;
         if (typeof m.name === 'string' && cleanName(m.name)) p.name = cleanName(m.name);
         if ('ship' in m) { p.ship = allowedShips(r.mission).includes(m.ship) ? m.ship : null; if (!p.ship) p.ready = false; }
         if ('ready' in m) p.ready = !!m.ready && !!p.ship;
         if ('team' in m && this._teamOk(p, m.team, false)) p.team = m.team;
         this._sync();
      } else if (m.t === 'bye') {
         this._unseat(from, p);
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
            max: Number(m.room.max) || 1, locked: !!m.room.locked, teamsLocked: !!m.room.teamsLocked, state: m.room.state === 'running' ? 'running' : 'lobby',
            players: m.players.slice(0, 16).map(p => ({ id: String(p.id), name: cleanName(p.name) || '?', ship: SHIPS[p.ship] ? p.ship : null, ready: !!p.ready,
               via: p.via === 'direct' || p.via === 'relay' ? p.via : '', team: TEAMS.includes(p.team) ? p.team : 0 })),
         };
         const me = this.me;
         if (me && this._hello) this._hello('ok');
         if (me && !me.ship && this.room.state === 'lobby') this._fixOwnShip();
         // the match of this room is over: no way back into it any more
         if (this.room.state === 'lobby') { const s = loadSeat(); if (s && s.room === base.id && s.hostId === base.hostId) saveSeat(null); }
         if (cur) this.cb.onRoom?.();
      } else if (m.t === 'deny') this._hello?.(DENY[m.why] ? m.why : 'gone');
      else if (m.t === 'kick') { this._forgetSeat(); this._drop('kicked', 'Der Host hat dich aus dem Spiel entfernt.'); }
      else if (m.t === 'closed') {
         if (this.session && this.room?.state === 'running') { this._orphan = true; this.session.transport._leave(this.room.hostId); }
         else { this._forgetSeat(); this._drop('hostleft', 'Der Host hat das Spiel geschlossen.'); }
      }
      else if (m.t === 'seats' && Array.isArray(m.seats) && m.start && typeof m.start === 'object') {
         const str = (x, n) => String(x ?? '').slice(0, n);
         this._heir = { seats: m.seats.slice(0, 16).filter(Array.isArray).map(x => [str(x[0], 32), str(x[1], 64), str(x[2], 64), str(x[3], 64), cleanName(x[4]), str(x[5], 40)]),
            start: m.start, banned: Array.isArray(m.banned) ? m.banned.slice(0, 64).map(x => str(x, 64)) : [] };
      }
      else if (m.t === 'seat' && typeof m.seat === 'string' && typeof m.token === 'string') {
         const base = this.room || this._pendingRoom;
         if (base) saveSeat({ room: base.id, hostId: base.hostId, seat: m.seat.slice(0, 32), token: m.token.slice(0, 64), key: this._key,
            mission: this.room?.mission || '', name: this.room?.name || '', at: Date.now() });
      }
      else if (m.t === 'start' && this.room && Array.isArray(m.players) && m.players.some(p => p.id === this.selfId)) {
         if (this.rt) this._begin(m); else this._pendingStart = m;      // still joining: after the wiring
      }
   }
   _forgetSeat() { const s = loadSeat(); if (s && this.room && s.room === this.room.id) saveSeat(null); }
   _state() {
      const r = this.room;
      return { t: 'state', room: { name: r.name, mode: r.mode, mission: r.mission, difficulty: r.difficulty, max: r.max, locked: r.locked, teamsLocked: !!r.teamsLocked, state: r.state },
         players: r.players.map(p => ({ id: p.id, name: p.name, ship: p.ship, ready: p.ready, via: this.via(p.id), team: p.team || 0 })) };
   }
   // how a player is connected to the host: 'direct' | 'relay' | '' (the host itself, or unknown).
   // The host and the player concerned know it first-hand, the others from the room state.
   via(id) {
      const r = this.room;
      if (!r || id === r.hostId) return '';
      if (this.isHost) return this.rt?.link?.(id)?.via || '';
      if (id === this.selfId) return this.rt?.link?.(r.hostId)?.via || '';
      return r.players.find(p => p.id === id)?.via || '';
   }
   // host: push the room state to everybody and refresh the listing
   _sync() {
      this._assignRoles();
      this.rt?.send('room', this._state());
      this._announce();
      this.cb.onRoom?.();
   }
   // host, historical operation: the ships are prescribed by slot (player order), not chosen.
   // A running match keeps its assignment (a returning captain gets the seat's ship back).
   _assignRoles() {
      const r = this.room, roles = r && r.state === 'lobby' ? coopRoles(r.mission, r.difficulty) : [];
      if (roles.length) r.players.forEach((p, i) => { p.ship = roles[i]?.cls || null; if (!p.ship) p.ready = false; });
   }
   // my ship is no longer valid for the mission: fall back to an own ship that is
   _fixOwnShip() {
      if (coopRoles(this.room.mission, this.room.difficulty).length) return;   // prescribed: the host assigns
      const me = this.me, ship = pickShip(this.room.mission, this.getProfile(), this._ship);
      if (!me || !ship || me.ship === ship) return;
      if (this.isHost) me.ship = ship; else this.rt?.send('room', { t: 'set', ship }, this.room.hostId);
   }
   setShip(ship) {
      const r = this.room;
      if (!r || r.state !== 'lobby' || coopRoles(r.mission, r.difficulty).length || !ownShips(r.mission, this.getProfile()).includes(ship)) return;
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
      const players = m.players.map(p => ({ id: String(p.id), name: String(p.name), ship: String(p.ship), ...(TEAMS.includes(p.team) ? { team: p.team } : null) }));
      let done = false;
      const transport = sessionTransport(this.rt, players.map(p => p.id), () => this.leaveRoom());
      const session = {
         transport, mode: String(m.mode), mission: String(m.mission), difficulty: String(m.difficulty), seed: m.seed >>> 0, players,
         onEnd: (result) => {
            if (done) return;
            done = true; transport._close();
            if (this.session === session) this.session = null;
            this._succ = null; this._heir = null;
            if (result?.handover && this.isHost) {
               // the match goes on under the successor: this peer leaves the room (its seat stays)
               this._teardown(false);
               this.cb.onEnd?.(result);
               this.open().catch(() => { });
               return;
            }
            if (this._orphan && !this.isHost) {
               // the host is gone and nobody took over -- or this peer was the one cut off: the seat
               // stays (the list offers the way back while the game is listed as running)
               this._orphan = false;
               this._drop('hostleft', 'Der Host hat das Spiel verlassen.');
            }
            if (this.isHost) { this._forgetSeat(); this._seats.clear(); this._back.clear(); this._startMsg = null; }
            else if (result && !result.aborted) this._forgetSeat();          // over: nothing to go back to
            if (this.room && this.isHost && this.room.state === 'running') { this.room.state = 'lobby'; this._sync(); }
            this.cb.onEnd?.(result || { aborted: true, reason: '', victory: null });
         },
         // host migration (game.js): the host named its successor / somebody runs the match now
         onSuccessor: (id) => { if (this.session === session && this.isHost) { this._succ = id; this._sendSeats(); } },
         onHost: (id) => { if (this.session === session) this._newHost(id); },
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
      this._seats.clear(); this._back.clear(); this._startMsg = null; this._orphan = false; this._succ = null; this._heir = null;
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
