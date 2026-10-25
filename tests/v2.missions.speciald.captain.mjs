// Bot captain of the special operations in gamev2/missions_special_d.js for the unit tests and the
// balance table: the sim's own AI sails and fights the player's ship, the captain adds the orders the
// mission asks for (mayday: helicopter or ship to the raft; gunline: station off the target and fire the
// guns at it; airbase: hold station west of the island and add cruise-missile volleys at the airfield).
//    captain(world, mode)   returns a function to call after every world.update
//       mode 'bot'      competent captain
//       mode 'passive'  the player does nothing (engines stopped, no orders)
//    play(id, o)            one seeded run to the end: o = { diff, seed, ship, mode }
import { World } from '../gamev2/state.js';
import { getMission } from '../gamev2/missions.js';
import { SPECIAL_D_TUNE, MAYDAY, GUNLINE } from '../gamev2/missions_special_d.js';
import { updateBots } from '../gamev2/ai.js';
import { sendHelo, heloOf } from '../gamev2/helo.js';
import { cruiseBlock, launchCruise } from '../gamev2/missile.js';

const DT = 1 / 60;
const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const turn = (p, want) => {
   const e = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
   p.setRudder(Math.abs(e) < 0.03 ? 0 : e > 0 ? (Math.abs(e) > 0.3 ? 2 : 1) : (Math.abs(e) > 0.3 ? -2 : -1));
};
const siteOf = (w, id) => w.sites.find(s => s.id === id) || null;
const nearestFoe = (w, pos) => {
   let d = Infinity;
   for (const s of w.ships) if (s.alive && s.side === 'enemy') d = Math.min(d, hyp(s.pos, pos));
   return d;
};
const goTo = (p, at) => { p.ai.route = [{ x: at.x, y: at.y }]; p.ai.routeIdx = 0; };

// mayday: run for the raft. The helicopter goes once the ship is close enough for the round trip and no frigate
// covers the raft with its missiles; else the ship goes alongside at a crawl.
function maydayHelm(w, p) {
   const S = w._script, R = S.raft;
   w.autoPlayer = true;
   if (S.crew !== 'raft') { delete p.ai.route; return () => p.setTelegraph(1); }
   const f = S.frigId != null ? w.shipById(S.frigId) : null;
   const frigNear = f && f.alive && hyp(f.pos, R) < 17000;
   const d = hyp(p.pos, R);
   if (p.cfg.helo && !heloOf(w, p) && d < 7500 && !frigNear && !S.heloTried) { S.heloTried = true; sendHelo(w, p, R); }
   // a boat lying at the raft comes first: the captain takes the guns and lays them on it himself
   let grab = null;
   for (const id of S.grabbers) { const b = w.shipById(id); if (b && b.alive && hyp(b.pos, R) < 600 && hyp(b.pos, p.pos) < p.cfg.main.range * 0.95) { grab = b; break; } }
   const helm = () => {
      turn(p, Math.atan2(R.y - p.pos.y, R.x - p.pos.x));
      p.setTelegraph(d > 2200 ? 4 : d > 1200 ? 3 : d > 600 ? 2 : d > MAYDAY.pickR * 0.8 ? 1 : 0);
   };
   if (grab) {
      w.autoPlayer = false;
      return () => { helm(); p.aimPoint = { x: grab.pos.x, y: grab.pos.y }; p.fireMain(w, p.aimPoint); };
   }
   if (d > 2200) { goTo(p, R); return false; }
   delete p.ai.route;
   return helm;
}

// gunline: wait off the middle of the coast; with a fire mission open run to a station off the target and shoot
// at it whenever no boat is close (the AI fights the boats).
function gunlineHelm(w, p) {
   const S = w._script, isl = w.obstacles[0], R = p.cfg.main.range;
   const s = S.open ? siteOf(w, S.targets[S.k]) : null;
   if (!s || !s.alive) { goTo(p, { x: 0, y: isl.c.y + 10000 }); return false; }
   const st = { x: s.x, y: s.y + R * 0.72 }, d = hyp(p.pos, s);
   goTo(p, st);
   w.autoPlayer = true;
   if (d > R * 0.97 || (nearestFoe(w, p.pos) < 3000 && S.closeT - w.time > 35)) return false;
   // shelling: the AI would turn the guns on the boats, so the captain takes ship and guns himself
   w.autoPlayer = false;
   return () => {
      const ds = hyp(p.pos, st);
      if (ds < 600) { turn(p, Math.atan2(s.y - p.pos.y, s.x - p.pos.x) + Math.PI / 2); p.setTelegraph(1); }
      else { turn(p, Math.atan2(st.y - p.pos.y, st.x - p.pos.x)); p.setTelegraph(ds > 1500 ? 4 : 2); }
      p.aimPoint = { x: s.x, y: s.y };
      p.fireMain(w, p.aimPoint);
   };
}

// airbase: stay west of the island with the group; the AI fires at the sites it knows, the captain adds a
// volley at the airfield every 20 s once the known SAM sites are down.
function airbaseHelm(w, p) {
   const S = w._script;
   goTo(p, { x: -3000, y: 2500 });
   if (w.time < (S.capT || 0)) return false;
   S.capT = w.time + 20;
   const known = S.sams.map(id => siteOf(w, id)).filter(s => s.alive && s.detected);
   const tgt = known.length ? known[0] : siteOf(w, S.fieldId);
   for (let i = 0; i < 2; i++) if (!cruiseBlock(w, p, { siteId: tgt.id })) launchCruise(w, p, { siteId: tgt.id });
   return false;
}

export function captain(w, mode = 'bot') {
   const p = w.player, id = w.mission.id;
   if (mode !== 'bot') { p.setTelegraph(0); return () => {}; }
   w.autoPlayer = true;
   p.ai = p.ai || {};
   p.setTelegraph(4);
   // The AI thinks once per tick (ai.js updateBots). The captain lets it think for the coming tick and then
   // overrides the helm (and the guns) where he acts himself.
   const think = (helm) => { w.tick++; updateBots(w, DT); w.tick--; if (helm) helm(); };
   const H = { mayday: maydayHelm, gunline: gunlineHelm, airbase: airbaseHelm }[id];
   return () => { if (w.phase === 'playing' && p.alive && H) think(H(w, p)); };
}

export function play(id, o = {}) {
   const def = getMission(id), ship = o.ship || def.recommendedShip;
   const w = new World(o.diff || 'normal', { mission: id, ship, seed: o.seed ?? 4711 });
   const cap = captain(w, o.mode || 'bot');
   for (let i = 0, m = Math.round((def.timeLimit + 10) / DT); i < m && w.phase === 'playing'; i++) { w.update(DT); cap(); if (o.each) o.each(w); }
   return w;
}
export { GUNLINE };

// Balance table:   node tests/v2.missions.speciald.captain.mjs <id> [runs = 30] [n = 1] [ship] [difficulties]
//    ship           the player's ship (default: the recommended one), '-' for the default
//    difficulties   comma-separated (default easy,normal,hard)
//    TUNE (env)     JSON merged over the tune table for a trial, e.g. TUNE='{"mayday":{"normal":{"grab":30}}}'
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()) && process.argv[2]) {
   const id = process.argv[2], runs = +process.argv[3] || 30, ship = process.argv[5] && process.argv[5] !== '-' ? process.argv[5] : undefined;
   const diffs = (process.argv[6] || 'easy,normal,hard').split(',');
   if (process.env.TUNE) {
      const over = JSON.parse(process.env.TUNE);
      for (const m in over) for (const d in over[m]) Object.assign(SPECIAL_D_TUNE[m][d], over[m][d]);
   }
   for (const diff of diffs) {
      let wins = 0, t = 0; const why = {};
      for (let i = 0; i < runs; i++) {
         const w = play(id, { diff, seed: 1000 + i * 7919, ship });
         t += w.time;
         if (w.phase === 'won') wins++; else { const r = (w.result ? w.result.reason : 'no end').slice(0, 50); why[r] = (why[r] || 0) + 1; }
      }
      console.log(`${id.padEnd(8)} ${diff.padEnd(6)} ${ship || 'default'} ${wins}/${runs} = ${Math.round(wins / runs * 100)} %  avg ${Math.round(t / runs)} s  ${JSON.stringify(why)}${process.env.TUNE ? '  ' + process.env.TUNE : ''}`);
   }
}
