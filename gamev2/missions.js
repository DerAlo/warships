// gamev2/missions.js — missions of the modern mode: maps (islands), environment, teams, objectives,
// scripted reinforcements and win/lose logic. MISSIONS is pure data for the menu; setupMission /
// updateMission are called by World. Mission text is German (UI), code English.
//
// Two base missions: 'training' (Gefechtsübung, a sandbox with target hulks and a late attack of
// missile boats) and 'standard' (Begegnungsgefecht, west against east). The player always sails on
// side 'player'; which bloc that is follows from the chosen ship (PLAYABLE = west, PLAYABLE_EAST for
// PvP and tests). Further missions: build a definition with missionHelpers and pass it to addMissions().
import { SHIPS, PLAYABLE, BOT_POOLS, BOT_SUBS, BOT_CVS } from './config.js';
import { TAU, dist2, obstacleT, obstacleRadiusAt } from './utils.js';
import { addSite } from './sites.js';
import { westMissions } from './missions_west.js';
import { eastMissions } from './missions_east.js';
import { specialMissionsA } from './missions_special_a.js';

// ---------------------------------------------------------------- names
function nextName(w, cls, side) {
   const S = w._script;
   const pool = SHIPS[cls].sisters || [SHIPS[cls].name];
   for (const n of pool) if (!S.used.has(n)) { S.used.add(n); return n; }
   const n = pool[0] + ' ' + (++S.dup + 1);
   S.used.add(n);
   return n;
}

// ---------------------------------------------------------------- helpers
const P = (x, y) => ({ x, y });
// Push a spawn / waypoint position out of any island (with margin).
function safePos(w, p, margin = 1.3) {
   const lim = w.arena - 600;
   const ok = q => Math.abs(q.x) <= lim && Math.abs(q.y) <= lim && w.obstacles.every(o => obstacleT(o, q) >= margin);
   const q = { x: p.x, y: p.y };
   for (let k = 0; k < 3; k++) {
      for (const o of w.obstacles) {
         if (obstacleT(o, q) >= margin) continue;
         const a = Math.atan2(q.y - o.c.y, q.x - o.c.x);
         const r = obstacleRadiusAt(o, a) * margin + 150;
         q.x = o.c.x + Math.cos(a) * r; q.y = o.c.y + Math.sin(a) * r;
      }
   }
   q.x = Math.max(-lim, Math.min(lim, q.x)); q.y = Math.max(-lim, Math.min(lim, q.y));
   if (ok(q)) return q;
   // the clamp put it back on land (a coast running into the arena wall, e.g. a reinforcement
   // slid into a corner): nearest open water on growing rings, map-centre side first
   for (let r = 300; r <= 9000; r += 300) {
      let best = null, bd = Infinity;
      for (let k = 0; k < 32; k++) {
         const a = k * TAU / 32, c = { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r };
         const d = c.x * c.x + c.y * c.y;
         if (d < bd && ok(c)) { bd = d; best = c; }
      }
      if (best) return best;
   }
   return q;
}
// Reinforcements (minDist): slide the spawn point away from the nearest opposing ship so nothing
// materialises inside torpedo range of the player.
function keepAway(w, side, pos, minDist) {
   const q = { x: pos.x, y: pos.y }, lim = w.arena - 700;
   for (let k = 0; k < 4; k++) {
      let near = null, nd = Infinity;
      for (const s of w.ships) {
         if (!s.alive || s.side === side) continue;
         const d = Math.hypot(s.pos.x - q.x, s.pos.y - q.y);
         if (d < nd) { nd = d; near = s; }
      }
      if (!near || nd >= minDist) break;
      let dx = q.x - near.pos.x, dy = q.y - near.pos.y;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      q.x = Math.max(-lim, Math.min(lim, near.pos.x + dx * minDist));
      q.y = Math.max(-lim, Math.min(lim, near.pos.y + dy * minDist));
      // squeezed against the border: swing sideways along it
      if (Math.hypot(q.x - near.pos.x, q.y - near.pos.y) < minDist * 0.9) { q.x = Math.max(-lim, Math.min(lim, q.x - dy * minDist * 0.6)); q.y = Math.max(-lim, Math.min(lim, q.y + dx * minDist * 0.6)); }
   }
   return q;
}
function add(w, cls, side, pos, heading, opts = {}) {
   const ai = { ...(opts.ai || {}) };
   if (opts.minDist) {
      pos = keepAway(w, side, pos, opts.minDist);
      // face the enemy centre of mass on arrival
      const foes = w.ships.filter(s => s.alive && s.side !== side);
      if (foes.length) {
         const cx = foes.reduce((a, s) => a + s.pos.x, 0) / foes.length, cy = foes.reduce((a, s) => a + s.pos.y, 0) / foes.length;
         heading = Math.atan2(cy - pos.y, cx - pos.x);
      }
   }
   const ship = w.spawn(cls, side, safePos(w, pos), heading, {
      telegraph: opts.isPlayer ? 2 : 3, ...opts, ai,
      name: opts.name || (opts.isPlayer ? SHIPS[cls].name : nextName(w, cls, side)),
   });
   w._script.used.add(ship.name);
   return ship;
}
function objective(w, id, text, opts = {}) {
   const o = { id, text, state: 'active', optional: !!opts.optional, progress: opts.progress || null };
   w.mission.objectives.push(o);
   return o;
}
function setObj(w, id, state, text) {
   const o = w.mission.objectives.find(x => x.id === id);
   if (!o || o.state === state) return;
   if (text) o.text = text;
   o.state = state;
   w.pushEvent('objective', { text: (state === 'done' ? '✔ ' : state === 'failed' ? '✘ ' : '') + o.text, objId: id, state });
}
function objText(w, id, text) {
   const o = w.mission.objectives.find(x => x.id === id);
   if (o) o.text = text;
}
const combatants = (w, side) => w.ships.filter(s => s.alive && s.side === side && s.type !== 'TR');
const later = (S, t, fn) => S.timers.push({ t, fn });
// Operations: radio traffic = mission message with the sender in front (HUD banner + radio chirp)
function radio(w, from, text, level = 'info') { w.message(`📻 ${from}: ${text}`, level); }
// Mission area drawn on the minimap ('goal' green, 'danger' red); returns the zone for checks.
function zone(w, x, y, r, label, kind = 'goal') {
   const z = { x, y, r, label, kind };
   w.mission.zones.push(z);
   return z;
}
const inZone = (s, z) => dist2(s.pos, z) < z.r * z.r;
function teamHPFrac(w, side) {
   let hp = 0, max = 0;
   for (const s of w.roster) if (s.side === side && s.type !== 'TR') { max += s.maxHP; hp += s.alive ? s.hp : 0; }
   return max ? hp / max : 0;
}

// ---------------------------------------------------------------- teams
// Seeded pick that leaves the sim's own rng stream untouched.
function pick(w, salt, list) {
   let h = (Math.imul((w.seed >>> 0) ^ 0x9e3779b9, 2654435761) + Math.imul(salt + 1, 40503)) >>> 0;
   h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
   return list[(h >>> 0) % list.length];
}
const PCT = [...Array(100).keys()];
const SUB_CHANCE = 0.35;      // share of the skirmishes with one submarine on each side
const CV_CHANCE = 0.25;       // ... with one carrier on each side (missions flagged `carriers`)
// Spawn the line-up of `bloc` ('west' | 'east', config.BOT_POOLS) at anchor facing `heading`.
// `playerCls` takes the slot whose pool holds its class (or the first slot of its hull type, or
// slot 0). A player in a submarine or a carrier brings that ship in addition, and the other side
// gets a counterpart; otherwise SUB_CHANCE / CV_CHANCE of the battles have them on both sides.
function spawnTeam(w, side, bloc, anchor, heading, playerCls, aiFor = () => ({})) {
   const S = w._script, pType = playerCls ? SHIPS[playerCls].hull.type : '';
   const slots = BOT_POOLS[bloc].map(([pool, fx, fy], i) => [pick(w, i, pool), fx, fy]);
   if (S.subs === undefined) S.subs = pType === 'SS' || pick(w, 91, PCT) < SUB_CHANCE * 100;
   if (S.cvs === undefined) S.cvs = !!S.def?.carriers && (pType === 'CV' || pick(w, 57, PCT) < CV_CHANCE * 100);
   let pIdx = -1;
   if (S.subs) { slots.push([pType === 'SS' ? playerCls : pick(w, 13, BOT_SUBS[bloc]), 4200, 2800]); if (pType === 'SS') pIdx = slots.length - 1; }
   if (S.cvs) { slots.push([pType === 'CV' ? playerCls : pick(w, 17, BOT_CVS[bloc]), -3400, 0]); if (pType === 'CV') pIdx = slots.length - 1; }
   if (playerCls && pIdx < 0) {
      pIdx = BOT_POOLS[bloc].findIndex(s => s[0].includes(playerCls));
      if (pIdx < 0) pIdx = slots.findIndex(s => SHIPS[s[0]].hull.type === pType);
      if (pIdx < 0) pIdx = 0;
   }
   const c = Math.cos(heading), s = Math.sin(heading);
   const out = [];
   slots.forEach(([cls, fx, fy], i) => {
      const pos = P(anchor.x + fx * c - fy * s, anchor.y + fx * s + fy * c);
      const isP = i === pIdx;
      out.push(add(w, isP ? playerCls : cls, side, pos, heading, isP ? { isPlayer: true } : { ai: aiFor(cls, i) }));
   });
   return out;
}
// Any class may be sailed where the mission does not prescribe its ships (the menu offers PLAYABLE).
function pickShip(def, shipKey) {
   if (def.playableShips) return def.playableShips.includes(shipKey) ? shipKey : (def.recommendedShip || def.playableShips[0]);
   return SHIPS[shipKey] && SHIPS[shipKey].hull.type !== 'TR' ? shipKey : (def.recommendedShip || PLAYABLE[0]);
}
function islands(w, list) {
   const A = w.arena - 60;
   for (const o of list) {
      const isl = w.addIsland(o);
      // a sub-1.3 km channel between a coast and the arena wall is a dead end the AI (and players)
      // wedge into: push such islands onto the wall so the coast closes the gap instead
      let gx = Infinity, gy = Infinity;
      for (const l of isl.lobes) {
         gx = Math.min(gx, A - Math.abs(isl.c.x + Math.cos(l.a) * l.r));
         gy = Math.min(gy, A - Math.abs(isl.c.y + Math.sin(l.a) * l.r));
      }
      if (gx > 0 && gx < 1300) isl.c.x += Math.sign(isl.c.x) * (gx + 300);
      if (gy > 0 && gy < 1300) isl.c.y += Math.sign(isl.c.y) * (gy + 300);
   }
}
// Deterministic archipelago filler: n islands in a box, keeping clear of `keepOut` circles.
function scatter(w, seed, n, box, rMin, rMax, keepOut = []) {
   let s = seed >>> 0;
   const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
   let placed = 0, guard = 0;
   while (placed < n && guard++ < n * 40) {
      const r = rMin + rnd() * (rMax - rMin);
      const c = P(box[0] + rnd() * (box[2] - box[0]), box[1] + rnd() * (box[3] - box[1]));
      if (keepOut.some(k => Math.hypot(c.x - k.x, c.y - k.y) < k.r + r * 1.6)) continue;
      if (w.obstacles.some(o => Math.hypot(c.x - o.c.x, c.y - o.c.y) < (o.rMax || o.r) + r * 1.8 + 500)) continue;
      w.addIsland({ c, r, height: 70 + rnd() * 260, seed: seed * 31 + placed, lobes: 3 + ((rnd() * 5) | 0),
         elong: 1 + rnd() * 1.4, rot: rnd() * TAU, rough: 0.35 + rnd() * 0.5 });
      placed++;
   }
}

// ---------------------------------------------------------------- mission definitions
const DEFS = [
   // ------------------------------------------------------------ 1. training sandbox
   {
      id: 'training', name: 'Gefechtsübung', subtitle: 'Schießgebiet Nordsee · freie Übung',
      briefing: 'Kommandant, willkommen an Bord. Im Schießgebiet liegen drei ausgemusterte Handelsschiffe als Ziele – ' +
         '10 bis 16 km östlich. Erproben Sie Radar, Seezielflugkörper und Geschütz: Mit eingeschaltetem Radar sehen Sie weit, ' +
         'werden aber noch weiter gehört. Hinter den Inseln sind Sie für jedes Radar unsichtbar. ' +
         'Die Übungsleitung hat für später einen Angriff von Flugkörperschnellbooten angekündigt.',
      env: { time: 'day', weather: 'clear' }, type: 'training', playableShips: null, recommendedShip: 'Sachsen',
      arena: 14000, timeLimit: 30 * 60, stars: 1,
      setup(w, shipKey) {
         islands(w, [
            { c: P(0, 12600), r: 2600, height: 180, seed: 5, lobes: 6, elong: 3, rot: 0, rough: 0.4, name: 'Sandbank Nord' },
            { c: P(1200, -3400), r: 900, height: 170, seed: 9, lobes: 4, rough: 0.6 },
            { c: P(-4200, -9800), r: 1300, height: 240, seed: 13, lobes: 5, elong: 1.6, rot: 0.8 },
            { c: P(8200, 5200), r: 1000, height: 200, seed: 17, lobes: 5, rough: 0.5 },
         ]);
         add(w, shipKey, 'player', P(-9500, 0), 0, { isPlayer: true });
         const tgt = { passive: true, patrolSpeed: 1 };
         add(w, 'Tanker', 'enemy', P(1500, 1800), Math.PI / 2, { telegraph: 1, name: 'Zielschiff Alfa', ai: { ...tgt, patrol: [P(1500, 1800), P(1800, 6500)] } });
         add(w, 'Container', 'enemy', P(4800, -600), -Math.PI / 2, { telegraph: 1, name: 'Zielschiff Bravo', ai: { ...tgt, patrol: [P(4800, -600), P(4400, -7000)] } });
         add(w, 'LNG', 'enemy', P(6500, 2200), 0, { telegraph: 1, name: 'Zielschiff Charlie', ai: { ...tgt, patrol: [P(6500, 2200), P(10500, 1500)] } });
         // V2: two land positions (sites.js): the radar station sees the player from afar, the bunker
         // is a hard target for cruise missiles and guns
         addSite(w, 'radar', 'enemy', P(8200, 5200), { name: 'Radarstation Ost' });
         addSite(w, 'bunker', 'enemy', P(1200, -3400), { name: 'Übungsbunker' });
         objective(w, 'sites', 'Zerstören Sie die Radarstation und den Bunker (0/2)', { optional: true });
         objective(w, 'targets', 'Versenken Sie die Zielschiffe (0/3)');
         w.score = { kind: 'count', player: 0, enemy: 0, target: 3 };
         w.message('Übung beginnt. Zielschiffe liegen östlich – Feuer frei!');
         w._script.phase = 1;
      },
      onSiteDestroyed(w) {
         const n = w.sites.filter(s => s.side === 'enemy' && !s.alive).length;
         objText(w, 'sites', `Zerstören Sie die Radarstation und den Bunker (${n}/2)`);
         if (n >= 2) setObj(w, 'sites', 'done');
      },
      onSink(w, ship, killer, S) {
         if (ship.side !== 'enemy') return;
         w.score.player++;
         const sunk = (tr) => w.roster.filter(s => s.side === 'enemy' && !s.alive && (s.type === 'TR') === tr).length;
         if (S.phase === 1) {
            const n = sunk(true);
            objText(w, 'targets', `Versenken Sie die Zielschiffe (${n}/3)`);
            if (n >= 3) {
               setObj(w, 'targets', 'done');
               S.phase = 2;
               later(S, w.time + 6, () => {
                  w.message('Alarm! Zwei Flugkörperschnellboote laufen von Osten an. Korvette Magdeburg unterstützt Sie.', 'warn');
                  add(w, 'Typ022', 'enemy', P(12500, -5200), Math.PI * 0.9, { minDist: 12000 });
                  add(w, 'Typ022', 'enemy', P(12500, 4800), -Math.PI * 0.9, { minDist: 12000 });
                  add(w, 'Braunschweig', 'player', P(-10500, 1800), 0, { name: 'Magdeburg' });
                  objective(w, 'boats', 'Wehren Sie den Schnellbootangriff ab (0/2)');
                  w.score = { kind: 'count', player: 0, enemy: 0, target: 2 };
               });
            }
         } else if (S.phase === 2 && ship.type !== 'TR') {
            const n = sunk(false);
            objText(w, 'boats', `Wehren Sie den Schnellbootangriff ab (${n}/2)`);
            if (n >= 2) { setObj(w, 'boats', 'done'); w.end(true, 'Übung erfolgreich abgeschlossen.'); }
         }
      },
      timeout(w) { w.end(false, 'Die Übungszeit ist abgelaufen.'); },
   },

   // ------------------------------------------------------------ 2. team skirmish
   {
      id: 'standard', name: 'Begegnungsgefecht', subtitle: 'Offene See mit Inselkette · West gegen Ost',
      briefing: 'Ein gegnerischer Verband steht jenseits der Inselkette. Beide Seiten führen Lenkwaffenkreuzer, Zerstörer, ' +
         'Fregatten und Flugkörperkorvetten. Wer zuerst strahlt, wird zuerst gehört – wer zuerst trifft, gewinnt. ' +
         'Einzelne Flugkörper fängt die Abwehr ab: Stimmen Sie Ihre Salven mit dem Verband ab und halten Sie sich im Schutz der Luftverteidiger.',
      env: { time: 'day', weather: 'overcast' }, type: 'annihilation', carriers: true, playableShips: null, recommendedShip: 'Sachsen',
      arena: 20000, timeLimit: 20 * 60, stars: 2,
      setup(w, shipKey) {
         islands(w, [
            { c: P(0, 0), r: 1700, height: 260, seed: 11, lobes: 6, rough: 0.6, peaks: [{ x: -250, y: 150, h: 340, r: 700 }] },
            { c: P(-1800, -7600), r: 1400, height: 200, seed: 23, lobes: 5, elong: 1.8, rot: 0.5 },
            { c: P(2200, 7400), r: 1500, height: 210, seed: 37, lobes: 5, elong: 1.6, rot: -0.4 },
            { c: P(6800, -3600), r: 800, height: 130, seed: 41, lobes: 4 },
            { c: P(-6800, 4000), r: 850, height: 150, seed: 53, lobes: 4 },
            { c: P(900, -16200), r: 2300, height: 380, seed: 61, lobes: 6, elong: 2.2, rot: 0.1, rough: 0.7 },
            { c: P(-1200, 16000), r: 2100, height: 300, seed: 71, lobes: 6, elong: 2, rot: -0.1, rough: 0.7 },
            { c: P(11500, 10200), r: 900, height: 160, seed: 83, lobes: 4 },
            { c: P(-11500, -10000), r: 950, height: 170, seed: 89, lobes: 4 },
         ]);
         const own = SHIPS[shipKey]?.bloc === 'east' ? 'east' : 'west';
         const mine = spawnTeam(w, 'player', own, P(-15500, 0), 0, shipKey);
         const foes = spawnTeam(w, 'enemy', own === 'west' ? 'east' : 'west', P(15500, 0), Math.PI, null);
         const n = foes.length;
         objective(w, 'kill', `Vernichten Sie alle feindlichen Schiffe (0/${n})`);
         w.score = { kind: 'kills', player: 0, enemy: 0, target: n };
         w._script.teams = { player: mine, enemy: foes };
      },
      onSink(w, ship) { annihilationSink(w, ship, 'kill', 'Vernichten Sie alle feindlichen Schiffe'); },
      timeout(w) { timeoutByHP(w); },
   },
];

// ---------------------------------------------------------------- shared win logic
function annihilationSink(w, ship, objId, base) {
   if (ship.side === 'enemy' && ship.type !== 'TR') w.score.player++;
   else if (ship.side === 'player' && ship.type !== 'TR') w.score.enemy++;
   objText(w, objId, `${base} (${w.score.player}/${w.score.target})`);
   if (!combatants(w, 'enemy').length) { setObj(w, objId, 'done'); w.end(true, 'Alle feindlichen Schiffe wurden versenkt.'); }
   else if (!combatants(w, 'player').length) w.end(false, 'Ihr Verband wurde vernichtet.');
}
function timeoutByHP(w) {
   const own = teamHPFrac(w, 'player'), foe = teamHPFrac(w, 'enemy');
   if (own > foe) w.end(true, 'Zeit abgelaufen – Ihr Verband hat die Oberhand behalten.');
   else w.end(false, 'Zeit abgelaufen – der Gegner hat die Oberhand behalten.');
}

// Building blocks for further mission modules: defs made with these go through addMissions().
export const missionHelpers = { P, add, objective, setObj, objText, later, radio, zone, inZone, islands, scatter, combatants, spawnTeam,
   teamHPFrac, annihilationSink, timeoutByHP, safePos, SHIPS };

// The ten operations: missions_west.js (1-5), missions_east.js (6-10)
DEFS.push(...westMissions(missionHelpers), ...eastMissions(missionHelpers));
DEFS.push(...specialMissionsA(missionHelpers));      // special operations, set A

// ---------------------------------------------------------------- public API
const BY_ID = Object.fromEntries(DEFS.map(d => [d.id, d]));
const menuData = (d) => ({
   id: d.id, name: d.name, subtitle: d.subtitle, briefing: d.briefing, env: { ...d.env }, type: d.type,
   playableShips: d.playableShips ? [...d.playableShips] : [...PLAYABLE], recommendedShip: d.recommendedShip,
   timeLimit: d.timeLimit, arena: d.arena, stars: d.stars || 2,   // stars = difficulty 1..3 for the menu
   group: d.group || 'battle', debrief: d.debrief || '',          // 'ops' = Historische Operationen
   fleet: d.fleet ? { ...d.fleet } : null,
   fixedShips: !!d.playableShips,                                 // the mission prescribes its ships
});
// Menu data only (no functions).
export const MISSIONS = DEFS.map(menuData);
export const MISSION_IDS = DEFS.map(d => d.id);
// Register further missions (same shape as DEFS entries) before the menu is built.
export function addMissions(defs) {
   for (const d of defs) {
      if (BY_ID[d.id]) continue;
      DEFS.push(d); BY_ID[d.id] = d; MISSIONS.push(menuData(d)); MISSION_IDS.push(d.id);
   }
}
export function getMission(id) { return MISSIONS.find(m => m.id === id) || null; }
// Medal stars of a finished operation: 1 = victory, 2 = + every optional objective, 3 = that on hard.
export function opStars(w) {
   if (!w || w.phase !== 'won' || !w.mission) return 0;
   const opt = w.mission.objectives.filter(o => o.optional && o.id !== 'break');
   const all = opt.every(o => o.state === 'done');
   return 1 + (all ? 1 : 0) + (all && w.difficultyKey === 'hard' ? 1 : 0);
}

export function setupMission(w, id, shipKey) {
   const def = BY_ID[id] || BY_ID.standard;
   w.arena = def.arena;
   w.setEnv(def.env);
   w.mission = { id: def.id, name: def.name, subtitle: def.subtitle, briefing: def.briefing, type: def.type, group: def.group || 'battle', objectives: [], zones: [] };
   w.timeLeft = def.timeLimit;
   w._script = { def, timers: [], used: new Set(), dup: 0, onSink: (ww, ship, killer) => def.onSink && def.onSink(ww, ship, killer, ww._script),
      onSiteDestroyed: (ww, site, by) => def.onSiteDestroyed && def.onSiteDestroyed(ww, site, by, ww._script) };
   def.setup.call(def, w, pickShip(def, shipKey));
   if (!w.player) throw new Error('mission ' + def.id + ' spawned no player');
}

export function updateMission(w, dt) {
   const S = w._script;
   if (!S) return;
   if (S.timers.length) {
      const due = S.timers.filter(t => w.time >= t.t);
      if (due.length) { S.timers = S.timers.filter(t => w.time < t.t); for (const t of due) t.fn(); }
   }
   if (S.def.update) S.def.update(w, dt, S);
   if (w.phase === 'playing' && w.timeLeft != null && w.timeLeft <= 0) S.def.timeout(w, S);
}
