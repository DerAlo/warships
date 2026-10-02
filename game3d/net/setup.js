// game3d/net/setup.js — builds the World of a net game. Host and clients run the same code with
// the same `start` data (seed, mission, difficulty, ship class + loadout per slot), so islands,
// roster and ship ids come out identical on every peer.
import { World, makeStats } from '../state.js';
import { Ship } from '../ship.js';
import { SHIPS, PLAYABLE } from '../config.js';
import { getMission } from '../missions.js';
import { applyLoadout } from '../progress3d.js';

export const MAX_HUMANS = 4;

// Allied bots a human may take over: fighting ships that no mission script holds on to.
export function replaceableBots(world) {
   const held = new Set();
   const S = world._script;
   if (S) for (const k in S) {
      const v = S[k];
      if (v instanceof Ship) held.add(v);
      else if (Array.isArray(v)) for (const x of v) if (x instanceof Ship) held.add(x);
   }
   return world.bots.filter(b => b.side === 'player' && b.alive && b.type !== 'TR' && !(b.ai && (b.ai.passive || b.ai.route)) && !held.has(b));
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

// o: { mission, difficulty, seed, classes[], loadouts[], names[], self }  (index = slot, 0 = host).
// Slot 0 is the World's own player ship; every other human replaces an allied bot (spawn order).
// `self` is the local slot: world.player becomes that ship, so renderer, HUD, camera and audio
// read the world exactly as in a singleplayer match.
export function buildNetWorld(o) {
   const w = new World(o.difficulty, { mission: o.mission, ship: o.classes[0], seed: o.seed >>> 0, loadout: o.loadouts[0] || null });
   const host = w.player;
   const label = (ship, i) => { const n = o.names && o.names[i]; if (n) { ship.captain = n; ship.name = ship.cfg.name + ' (' + n + ')'; } };
   host.slot = 0;
   label(host, 0);
   const humans = [host];
   const bots = replaceableBots(w);
   for (let i = 1; i < o.classes.length; i++) {
      const cls = o.classes[i], lo = o.loadouts[i];
      const cfg = lo ? applyLoadout(SHIPS[cls], lo) : SHIPS[cls];
      const old = bots.shift();
      // no bot left to replace (fleet roll smaller than expected): an extra ship abeam of the host
      const ship = old ? w.replaceShip(old, cls, { cfg, ai: old.ai })
         : w.spawn(cls, 'player', { x: host.pos.x - Math.sin(host.heading) * 450 * i, y: host.pos.y + Math.cos(host.heading) * 450 * i }, host.heading, { cfg, telegraph: 2 });
      ship.human = true; ship.slot = i; ship.stats = makeStats();
      label(ship, i);
      humans.push(ship);
   }
   w.net = { humans };
   const me = humans[o.self | 0];
   if (me && me !== host) {
      host.isPlayer = false;
      me.isPlayer = true; me.human = false;
      w.player = me; w.stats = me.stats;
   }
   return w;
}

// Human captains a mission can take in co-op (host included): the host's ship plus one per
// replaceable allied bot. The fleet roll depends on the seed, so the smallest of a few rolls counts.
const slotCache = new Map();
export function missionSlots(missionId) {
   const def = getMission(missionId);
   if (!def || def.fixedShips) return 0;
   let n = slotCache.get(def.id);
   if (n === undefined) {
      n = MAX_HUMANS;
      try {
         for (const seed of [11, 4242, 987654321]) {
            const w = new World('normal', { mission: def.id, ship: validClass(def.id, null), seed });
            n = Math.min(n, 1 + replaceableBots(w).length);
         }
      } catch (e) { n = 0; }
      if (n < 2) n = 0;
      slotCache.set(def.id, n);
   }
   return n;
}
