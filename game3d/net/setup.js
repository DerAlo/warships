// game3d/net/setup.js — builds the World of a net game. Host and clients run the same code with
// the same `start` data (seed, mission, difficulty, ship class + loadout per slot), so islands,
// roster and ship ids come out identical on every peer.
import { World, makeStats } from '../state.js';
import { Ship } from '../ship.js';
import { SHIPS, PLAYABLE } from '../config.js';
import { getMission } from '../missions.js';
import { applyLoadout } from '../progress3d.js';
import { PVP_WIN, PVP_LOSS } from './pvp.js';

export const MAX_HUMANS = 4;

// Bots of `side` a human may take over (co-op: allied ones; PvP: the other team's too): fighting
// ships that no mission script holds on to.
export function replaceableBots(world, side = 'player') {
   const held = new Set();
   const S = world._script;
   if (S) for (const k in S) {
      const v = S[k];
      if (v instanceof Ship) held.add(v);
      else if (Array.isArray(v)) for (const x of v) if (x instanceof Ship) held.add(x);
   }
   return world.bots.filter(b => b.side === side && b.alive && b.type !== 'TR' && !(b.ai && (b.ai.passive || b.ai.route)) && !held.has(b));
}

// The host cannot trust the ship a client claims: unknown or not allowed -> the mission's choice.
export function validClass(missionId, cls) {
   const def = getMission(missionId) || getMission('standard');
   const allowed = def.playableShips || PLAYABLE;
   return typeof cls === 'string' && SHIPS[cls] && allowed.includes(cls) ? cls : (def.recommendedShip || allowed[0]);
}

// Career loadouts arrive over the network too: keep only the shape applyLoadout() reads.
export function cleanLoadout(lo) {
   if (!lo || typeof lo !== 'object') return null;
   const modules = {}, skills = [];
   if (lo.modules && typeof lo.modules === 'object') {
      let n = 0;
      for (const k in lo.modules) { const t = lo.modules[k] | 0; if (t > 0 && t < 10 && k.length < 24 && n++ < 16) modules[k] = t; }
   }
   if (Array.isArray(lo.skills)) for (const s of lo.skills) if (typeof s === 'string' && s.length < 32 && skills.length < 12 && !skills.includes(s)) skills.push(s);
   return { modules, skills };
}

// Historical operations (missions that prescribe their ships): the host commands the mission's
// own ship, the flagship; every further captain takes one of the allied ships the mission brings,
// the biggest first (battleship, cruisers, destroyers, boats), equal ones in spawn order. Scripted
// ships (convoys, routes) and transports stay with the mission.
const RANK = { BB: 0, CA: 1, CL: 2, DD: 3, SS: 4 };
export function historicShips(world) {
   return world.bots.map((b, i) => [b, i])
      .filter(([b]) => b.side === 'player' && b.alive && RANK[b.type] !== undefined && !(b.ai && (b.ai.passive || b.ai.route)))
      .sort((a, b) => RANK[a[0].type] - RANK[b[0].type] || a[1] - b[1]).map(x => x[0]);
}

// o: { mission, difficulty, seed, classes[], loadouts[], names[], self, teams? }  (index = slot, 0 = host).
// Slot 0 is the World's own player ship; every other human replaces an allied bot (spawn order).
// PvP (teams given, one lobby team number per slot): a human of the host's team replaces an
// allied bot, one of the other team an enemy bot, so both fleets keep their size.
// In a historical operation the other humans take the mission's allied ships as they are (see
// historicShips; their class comes from the mission, classes[i] and loadouts[i] do not count).
// `self` is the local slot: world.player becomes that ship, so renderer, HUD, camera and audio
// read the world exactly as in a singleplayer match.
export function buildNetWorld(o) {
   const w = new World(o.difficulty, { mission: o.mission, ship: o.classes[0], seed: o.seed >>> 0, loadout: o.loadouts[0] || null });
   const pvp = Array.isArray(o.teams);
   const fixed = !pvp && !!getMission(o.mission)?.fixedShips;
   const host = w.player;
   const sideOf = (i) => pvp && o.teams[i] !== o.teams[0] ? 'enemy' : 'player';
   const label = (ship, i) => { const n = o.names && o.names[i]; if (n) { ship.captain = n; ship.name = ship.name + ' (' + n + ')'; } };
   host.slot = 0;
   label(host, 0);
   const humans = [host];
   const bots = { player: fixed ? historicShips(w) : replaceableBots(w, 'player'), enemy: pvp ? replaceableBots(w, 'enemy') : [] };
   for (let i = 1; i < o.classes.length; i++) {
      const cls = o.classes[i], lo = o.loadouts[i], side = sideOf(i);
      const cfg = lo ? applyLoadout(SHIPS[cls], lo) : SHIPS[cls];
      const old = bots[side].shift();
      let ship;
      // historical: the very ship the mission script knows. Missions cut the damage of allied bots
      // so they do not fight the player's battle for him; a captain fights at full strength.
      if (old && fixed) { ship = old; ship.dmgMult = 1; }
      else if (old) ship = w.replaceShip(old, cls, { cfg, ai: old.ai });
      // no bot left to replace (fleet roll smaller than expected): an extra ship abeam of the host
      else {
         const a = side === 'player' ? host : (w.ships.find(s => s.side === side) || host);
         ship = w.spawn(cls, side, { x: a.pos.x - Math.sin(a.heading) * 450 * i, y: a.pos.y + Math.cos(a.heading) * 450 * i }, a.heading, { cfg, telegraph: 2 });
      }
      ship.human = true; ship.slot = i; ship.stats = makeStats();
      label(ship, i);
      humans.push(ship);
   }
   // flag: in a historical operation the battle is lost with the flagship, as in singleplayer
   w.net = { humans, flag: fixed ? host : null, pvp };
   if (pvp) {
      // bots aim at every captain alike (single player: a little worse at the player)
      w.difficulty = { ...w.difficulty, vsPlayer: 1 };
      // a team whose captains are all sunk has lost; a captain who left is no reason (the AI
      // sails the ship, the captain may come back)
      w.net.check = () => {
         for (const side of ['player', 'enemy']) {
            if (humans.some(h => h.side === side && h.alive)) continue;
            w.end(side === 'enemy', side === 'enemy' ? PVP_WIN : PVP_LOSS);
            return;
         }
      };
   }
   const me = humans[o.self | 0];
   if (me && me !== host) {
      host.isPlayer = false;
      me.isPlayer = true; me.human = false;
      w.player = me; w.stats = me.stats;
   }
   return w;
}

// PvP, a client of the other team: its World shows the battle from its own side, so the HUD,
// renderer and minimap work unchanged (its own ships are 'player'). Everything later decoded
// from the host goes through codec.localSide(side, true).
export function flipSides(w) {
   const sw = (x) => x === 'player' ? 'enemy' : x === 'enemy' ? 'player' : x;
   for (const s of new Set([...w.ships, ...w.roster, ...w.bots])) s.side = sw(s.side);
   for (const c of w.caps) { c.owner = sw(c.owner); c.capper = sw(c.capper); }
   if (w.score) { const p = w.score.player; w.score.player = w.score.enemy; w.score.enemy = p; }
}

// Human captains a mission can take in co-op (host included): the host's ship plus one per
// replaceable allied bot (historical operations: per allied ship of the mission). The fleet roll
// depends on the seed, so the smallest of a few rolls counts. Missions in NO_COOP stay out.
export const NO_COOP = {
   training: 'Schießübung für einen Kapitän, ohne verbündete Schiffe',
   laststand: 'Die Bismarck kämpft allein – kein verbündetes Schiff zu übernehmen',
};
const slotCache = new Map();
export function missionSlots(missionId) {
   const def = getMission(missionId);
   if (!def || NO_COOP[def.id]) return 0;
   let n = slotCache.get(def.id);
   if (n === undefined) {
      n = MAX_HUMANS;
      try {
         for (const seed of [11, 4242, 987654321]) {
            const w = new World('normal', { mission: def.id, ship: validClass(def.id, null), seed });
            n = Math.min(n, 1 + (def.fixedShips ? historicShips(w) : replaceableBots(w)).length);
         }
      } catch (e) { n = 0; }
      if (n < 2) n = 0;
      slotCache.set(def.id, n);
   }
   return n;
}

// Historical operations: who commands which ship, by slot ({ cls, name }); [] for a mission with
// free ship choice. Allied rosters may depend on the difficulty, so it is part of the key.
const roleCache = new Map();
export function missionRoles(missionId, difficulty = 'normal') {
   const def = getMission(missionId), n = missionSlots(missionId);
   if (!def || !def.fixedShips || !n) return [];
   const key = def.id + '/' + difficulty;
   let roles = roleCache.get(key);
   if (!roles) {
      try {
         const w = new World(difficulty, { mission: def.id, ship: validClass(def.id, null), seed: 11 });
         roles = [w.player, ...historicShips(w)].slice(0, n).map(s => ({ cls: s.cls, name: s.name }));
      } catch (e) { roles = []; }
      roleCache.set(key, roles);
   }
   return roles;
}
