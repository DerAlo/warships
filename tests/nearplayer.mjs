// tests/nearplayer.mjs -- "player-near" behaviour checks for routed AI ships, headless.
// The bot captains never sail next to a friendly freighter, so a convoy ship that circles or stalls
// with the flagship alongside went unnoticed. This helper drives the player ship through a mission
// in a nuisance mode relative to one routed ship and measures how every ship of that group keeps
// to its route. Shared by the WW2 3D and the V2 suites (the World class is handed in).
//
//    const r = runNear(World, { mission, ship, seed, mode });        // mode: see MODES
//    const base = runNear(World, { mission, ship, seed, mode: 'far' });      // the player keeps clear
//    const bad = judge(r, base);                                     // [] = fine
//
// CLI (diagnostics): node tests/nearplayer.mjs <game3d|gamev2> <mission> [ship] [modes|all] [seeds] [tMax]

export const MODES = ['beside', 'cross', 'block', 'tail', 'ram'];
const DT = 1 / 30;
const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const ang = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Every routed ship but the player; a scenario narrows it with `pick`.
const routed = (w, pick) => w.ships.filter(s => s !== w.player && s.alive && s.ai && s.ai.route && s.ai.route.length && (!pick || pick(s, w)));

// Metres of route left: to the current waypoint and on along the remaining legs.
function remaining(s) {
   const r = s.ai.route, i = Math.min(s.ai.routeIdx || 0, r.length - 1);
   let d = hyp(s.pos, r[i]);
   for (let k = i; k < r.length - 1; k++) d += hyp(r[k], r[k + 1]);
   return d;
}

// Distance between two keel lines (the same segments the game collides).
function keelGap(a, b) {
   const seg = (s) => {
      const h = s.cfg.hull.L * 0.46, c = Math.cos(s.heading), n = Math.sin(s.heading);
      return [{ x: s.pos.x + c * h, y: s.pos.y + n * h }, { x: s.pos.x - c * h, y: s.pos.y - n * h }];
   };
   const [a0, a1] = seg(a), [b0, b1] = seg(b);
   const pt = (p, q0, q1) => {
      const vx = q1.x - q0.x, vy = q1.y - q0.y;
      const t = Math.max(0, Math.min(1, ((p.x - q0.x) * vx + (p.y - q0.y) * vy) / (vx * vx + vy * vy || 1)));
      return Math.hypot(p.x - q0.x - vx * t, p.y - q0.y - vy * t);
   };
   return Math.min(pt(a0, b0, b1), pt(a1, b0, b1), pt(b0, a0, a1), pt(b1, a0, a1));
}

function steerTo(p, to) {
   const d = ang(Math.atan2(to.y - p.pos.y, to.x - p.pos.x) - p.heading);
   p.setRudder(Math.abs(d) < 0.03 ? 0 : d > 0 ? (Math.abs(d) > 0.3 ? 2 : 1) : (Math.abs(d) > 0.3 ? -2 : -1));
}
// Keep station on a point G that moves with the ship T (course f): run parallel, match its speed.
function station(p, T, G, f) {
   const along = (G.x - p.pos.x) * f.x + (G.y - p.pos.y) * f.y, back = Math.max(0, -along);
   steerTo(p, { x: G.x + f.x * (back + 350), y: G.y + f.y * (back + 350) });
   const frac = Math.abs(T.speed) / Math.max(1, p.maxSpeed || p.cfg.maxSpeed || 15);
   const lo = Math.max(0, Math.min(3, Math.floor(frac * 4)));
   p.setTelegraph(along > 500 ? 4 : along > 150 ? Math.min(4, lo + 2) : along > 20 ? lo + 1 : along > -150 ? lo : 0);
}

// One steering decision of the nuisance captain.
function drive(mode, w, p, T, st, seed) {
   if (mode === 'still' || !T || !T.alive) { p.setTelegraph(0); p.setRudder(0); return; }
   const h = T.heading, f = { x: Math.cos(h), y: Math.sin(h) };
   const k = seed % 2 ? 1 : -1, s = { x: Math.cos(h + k * Math.PI / 2), y: Math.sin(h + k * Math.PI / 2) };
   const at = (side, fwd) => ({ x: T.pos.x + s.x * side + f.x * fwd, y: T.pos.y + s.y * side + f.y * fwd });
   const t = w.time - st.t0;
   if (mode === 'far') {
      // the baseline: a well-behaved escort 1400 m abeam (many convoys wait for a flagship that lies stopped)
      station(p, T, at(1400, 0), f);
   } else if (mode === 'beside') {
      // abeam at 150-400 m, then sheer off hard, come back and do it again
      const off = 150 + (seed % 6) * 50, cyc = 150 + (seed % 5) * 12, veer = t % (cyc + 45) > cyc;
      if (veer) { steerTo(p, at(3000, 300)); p.setTelegraph(4); }
      else station(p, T, at(off, 0), f);
   } else if (mode === 'cross') {
      // back and forth across the bow
      const kk = Math.floor(t / 40) % 2 ? 1 : -1;
      steerTo(p, at(kk * 500, 350)); p.setTelegraph(4);
   } else if (mode === 'block') {
      // stop dead on its track ahead; once it is past, take the next spot ahead
      const r = T.ai.route, wp = r[Math.min(T.ai.routeIdx || 0, r.length - 1)];
      const c = Math.atan2(wp.y - T.pos.y, wp.x - T.pos.x), lead = 550 + Math.abs(T.speed) * 45;
      const past = st.B && ((st.B.x - T.pos.x) * f.x + (st.B.y - T.pos.y) * f.y < -250 || hyp(st.B, T.pos) > lead + 900);
      if (!st.B || past) st.B = hyp(T.pos, wp) > lead + 200 ? { x: T.pos.x + Math.cos(c) * lead, y: T.pos.y + Math.sin(c) * lead } : { x: wp.x, y: wp.y };
      const d = hyp(p.pos, st.B);
      if (d < 45 || st.stop === st.B) { st.stop = st.B; p.setTelegraph(0); p.setRudder(0); }
      else { steerTo(p, st.B); p.setTelegraph(d > 600 ? 4 : d > 300 ? 2 : 1); }
   } else if (mode === 'tail') {
      station(p, T, at(0, -(T.cfg.hull.L / 2 + p.cfg.hull.L / 2 + 120)), f);
   } else if (mode === 'ram') {
      // close in slowly from the quarter until the hulls touch, fall back and start over
      const cyc = 110, d = Math.max(0, 600 - (t % cyc) * 8);
      station(p, T, at(d, -d * 0.7), f);
   }
}

// Put the player abeam of a ship it would otherwise need minutes to reach.
function teleport(w, p, T, seed, dist) {
   const clear = (q) => Math.abs(q.x) < w.arena - 900 && Math.abs(q.y) < w.arena - 900 &&
      !w.obstacles.some(o => hyp(o.c, q) < (o.rMax || o.r * 1.6) + 500) &&
      !w.ships.some(o => o !== p && o.alive && hyp(o.pos, q) < 450);
   for (const [side, back] of [[1, 0], [-1, 0], [1, 500], [-1, 500], [1.6, 0], [-1.6, 0], [1.6, 900], [-1.6, 900]]) {
      const a = T.heading + (seed % 2 ? 1 : -1) * Math.sign(side) * Math.PI / 2, d = dist * Math.abs(side);
      const q = { x: T.pos.x + Math.cos(a) * d - Math.cos(T.heading) * back, y: T.pos.y + Math.sin(a) * d - Math.sin(T.heading) * back };
      if (!clear(q)) continue;
      p.pos.x = q.x; p.pos.y = q.y; p.heading = T.heading; p.speed = T.speed;
      return true;
   }
   return false;
}

// Run one mission with the player in `mode` around one ship of the routed group.
//    opts: mission, ship, seed, mode, vary (side, offset and rhythm of the nuisance; default: the seed), diff ('easy'), tMax (s of mission time after `warm`), warm (s the player
//    lies stopped before the group is read), pick(s, w) (narrows the group), target (index into the group),
//    prepare(w) (scenario setup, e.g. casting off an anchored ferry), protect (true: no damage to the
//    player and the group, so the run measures seamanship, not gunnery)
export function runNear(World, o) {
   const seed = o.seed ?? 1, vary = o.vary ?? seed, mode = o.mode || 'still', tMax = o.tMax || 300;
   const w = new World(o.diff || 'easy', { mission: o.mission, ship: o.ship, seed });
   const p = w.player;
   if (o.prepare) o.prepare(w);
   const keep = (list) => {
      if (o.protect === false) return;
      for (const s of list) {
         if (!s.alive) continue;
         s.hp = s.maxHP;
         if (s.fires) s.fires.length = 0;
         if (s.floods) s.floods.length = 0;
         if (s.modules) { s.modules.engine = 0; s.modules.rudder = 0; }
      }
   };
   while (o.warm && w.phase === 'playing' && w.time < o.warm) { p.setTelegraph(0); p.setRudder(0); w.update(DT); keep([p]); }
   const group = routed(w, o.pick);
   const res = { mission: o.mission, seed, mode, phase: w.phase, time: w.time, t0: w.time, minDist: Infinity, contactT: 0, contactMax: 0, contacts: 0, target: null, ships: [] };
   if (!group.length) return res;
   const T = group[Math.min(o.target ?? 1, group.length - 1)];
   res.target = T.name; res.friendly = T.side === p.side;
   if (mode !== 'still' && hyp(p.pos, T.pos) > (mode === 'far' ? 2500 : 1500)) res.teleported = teleport(w, p, T, vary, mode === 'far' ? 1400 : 700);
   const tr = group.map(m => ({
      m, name: m.name, route: m.ai.route, h: m.heading, acc: 0, lo: 0, hi: 0, turn: 0, rem0: remaining(m), rem: remaining(m), best: remaining(m), bestT: w.time,
      stall: 0, reverse: 0, reverses: 0, rev: false, stuck: 0, arrivedAt: null, done: false, log: [],
   }));
   const st = { t0: w.time, B: null }, tEnd = w.time + tMax;
   let n = 0, lastTouch = -99, touch0 = 0;
   while (w.phase === 'playing' && w.time < tEnd && tr.some(t => !t.done)) {
      drive(mode, w, p, T.alive && T.ai && T.ai.route ? T : null, st, vary);
      w.update(DT);
      keep([p, ...group]);
      n++;
      if (T.alive) {
         res.minDist = Math.min(res.minDist, hyp(p.pos, T.pos));
         for (const t of tr) {
            if (!t.m.alive || keelGap(p, t.m) > (p.cfg.hull.beam + t.m.cfg.hull.beam) / 2 + 3) continue;
            if (w.time - lastTouch > 5) { res.contacts++; touch0 = w.time; }
            lastTouch = w.time; res.contactT += DT; res.contactMax = Math.max(res.contactMax, w.time - touch0);
            break;
         }
      }
      for (const t of tr) {
         const m = t.m;
         if (t.done) continue;
         // sunk, removed by the mission or sent somewhere else by its script: stop measuring
         if (!m.alive || !m.ai || m.ai.route !== t.route || !w.ships.includes(m)) { t.done = true; t.gone = true; continue; }
         const dh = ang(m.heading - t.h); t.h = m.heading; t.acc += dh;
         t.lo = Math.min(t.lo, t.acc); t.hi = Math.max(t.hi, t.acc); t.turn = t.hi - t.lo;
         t.rem = remaining(m);
         if (t.rem < t.best - 1) { t.best = t.rem; t.bestT = w.time; }
         t.stall = Math.max(t.stall, w.time - t.bestT);
         const rev = m.ai.reverseT > 0;
         if (rev) t.reverse += DT;
         if (rev && !t.rev) t.reverses++;
         t.rev = rev;
         t.stuck = Math.max(t.stuck, m.ai.stuckT || 0);
         if (n % 300 === 0) t.log.push(t.rem);                       // every 10 s, for the comparison with the baseline
         if (t.rem < 900) { t.done = true; t.arrivedAt = w.time; }
      }
   }
   res.phase = w.phase; res.time = w.time;
   res.ships = tr.map(t => ({ name: t.name, turn: t.turn, stall: t.stall, reverse: t.reverse, reverses: t.reverses, stuck: t.stuck, rem0: t.rem0, rem: t.rem,
      arrivedAt: t.arrivedAt, gone: !!t.gone, log: t.log }));
   return res;
}

export const LIMITS = {
   turn: 4.5,        // rad between the extremes of the accumulated heading: a full circle
   stall: 60,        // s without the route getting shorter
   reverse: 25,      // s spent backing off (one bump costs 18 s)
   late: 1500,       // m of route a ship may fall behind the same seed with the player a well-behaved escort ('far') ...
   lateFrac: 0.2,    // ... or this share of what it made good there, whichever is more
   contact: 40,      // s of one unbroken hull-to-hull contact of an own ship with the player (all modes but 'ram', which seeks it)
   near: 700,        // m: the nuisance captain must really have been close, otherwise the run proves nothing
};

// Faults of a nuisance run, as texts ([] = every ship kept to its route). `base` is the same seed with
// the player keeping clear ('far').
export function judge(r, base, lim = {}) {
   const L = { ...LIMITS, ...lim }, bad = [], id = `${r.mission} seed ${r.seed} ${r.mode}`;
   if (!r.ships.length) return [`${id}: no routed ship found`];
   if (r.mode !== 'still' && r.mode !== 'far' && !(r.minDist < L.near)) bad.push(`${id}: the player never came near ${r.target} (${Math.round(r.minDist)} m)`);
   // (an enemy may well lay itself alongside or ram; only the own ships have to come clear of the player)
   if (r.mode !== 'ram' && r.friendly && r.contactMax > L.contact) bad.push(`${id}: ${r.contactMax.toFixed(0)} s hull to hull with the player without a break (${r.contacts} contacts, ${r.contactT.toFixed(0)} s in all)`);
   r.ships.forEach((s, i) => {
      const who = `${id}: ${s.name}`;
      if (s.turn > L.turn) bad.push(`${who} turned a circle (${s.turn.toFixed(2)} rad)`);
      if (s.stall > L.stall) bad.push(`${who} made no way along its route for ${s.stall.toFixed(0)} s`);
      if (s.reverse > L.reverse) bad.push(`${who} backed off ${s.reverses}x, ${s.reverse.toFixed(0)} s in all`);
      const b = base && base.ships[i];
      if (!b || b.name !== s.name) return;
      // the route made good at the last moment both runs measured this ship
      const k = Math.min(s.log.length, b.log.length) - 1;
      if (k < 0) return;
      const made = s.rem0 - s.log[k], madeB = b.rem0 - b.log[k];
      if (made < madeB - Math.max(L.late, L.lateFrac * madeB)) bad.push(`${who} fell ${Math.round(madeB - made)} m behind (made ${Math.round(made)} m, ${Math.round(madeB)} m with the player keeping clear, after ${(k + 1) * 10} s)`);
   });
   return bad;
}

// Register the node:test cases for a scenario table: one test per scenario, every mode on a few seeds.
// A scenario: { mission, ship, pick, target, tMax, warm, prepare, modes, lim, name }.
// Default: one world seed, the scenario's modes (all five unless it names fewer). NEAR_SEEDS=<n> widens the
// sweep to n seeds and all five modes and adds the scenarios marked `wide`; NEAR_ONLY=a,b narrows it to missions.
export function nearSuite(test, assert, World, scenarios, tag) {
   const wide = +process.env.NEAR_SEEDS || 0, only = process.env.NEAR_ONLY ? process.env.NEAR_ONLY.split(',') : null;
   for (const sc of scenarios) {
      if ((sc.wide && !wide) || (only && !only.includes(sc.mission))) continue;
      test(`${tag} near-player: ${sc.name || sc.mission} keeps its routed ships on course`, () => {
         const modes = wide ? MODES : sc.modes || MODES, bad = [];
         for (let k = 0; k < (wide || 1); k++) {
            const seed = (sc.seed || 2) + k * 7;
            const base = runNear(World, { ...sc, seed, mode: 'far' });
            bad.push(...judge(base, null, sc.lim));
            modes.forEach((mode) => bad.push(...judge(runNear(World, { ...sc, seed, mode, vary: seed + MODES.indexOf(mode) }), base, sc.lim)));
         }
         assert.deepEqual(bad, []);
      });
   }
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()) && process.argv[2]) {
   const [, , variant, mission, ship, modes = 'all', seeds = '3', tMax = '300', warm = '0'] = process.argv;
   // NEAR_ROOT=<dir>: run against another copy of the tree (e.g. an older commit)
   const root = process.env.NEAR_ROOT ? (await import('node:url')).pathToFileURL(process.env.NEAR_ROOT + '/').href : new URL('../', import.meta.url).href;
   const { World } = await import(`${root}${variant}/state.js`);
   const { MISSIONS } = await import(`${root}${variant}/missions.js`);
   const m = MISSIONS.find(x => x.id === mission);
   const shipKey = ship && ship !== '-' ? ship : m.recommendedShip;
   for (let seed = 1; seed <= +seeds; seed++) {
      const o = { mission, ship: shipKey, seed, tMax: +tMax, warm: +warm };
      const base = runNear(World, { ...o, mode: 'far' });
      for (const mode of ['far', ...(modes === 'all' ? MODES : modes.split(','))]) {
         const t0 = Date.now(), r = mode === 'far' ? base : runNear(World, { ...o, mode });
         console.log(`${mission} seed ${seed} ${mode.padEnd(6)} -> ${r.phase}@${r.time.toFixed(0)} target ${r.target} min ${Math.round(r.minDist)} m contact ${r.contactT.toFixed(0)}s/${r.contacts} longest ${r.contactMax.toFixed(0)}s${r.teleported ? ' tp' : ''} [${Date.now() - t0} ms]`);
         const mx = (k) => Math.max(...r.ships.map(s => s[k]));
         if (process.env.NEAR_BRIEF) console.log(`      turn ${mx('turn').toFixed(2)} stall ${mx('stall').toFixed(0)} rev ${mx('reverse').toFixed(0)} n=${r.ships.length} arrived ${r.ships.filter(s => s.arrivedAt).length}`);
         else for (const s of r.ships) console.log(`      ${s.name.padEnd(22)} turn ${s.turn.toFixed(2)} stall ${s.stall.toFixed(0)} rev ${s.reverse.toFixed(0)}/${s.reverses} stuck ${s.stuck.toFixed(1)} rem ${Math.round(s.rem0)}->${Math.round(s.rem)}${s.arrivedAt ? ' arr@' + s.arrivedAt.toFixed(0) : ''}${s.gone ? ' gone' : ''}`);
         for (const x of judge(r, mode === 'far' ? null : base)) console.log('   !! ' + x);
      }
   }
}
