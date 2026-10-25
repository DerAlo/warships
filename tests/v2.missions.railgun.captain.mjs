// Bot captain of the railgun operation (gamev2/missions_special_c.js) for the unit tests and the balance
// runner: the sim's own AI fights the Donar (world.autoPlayer: defence, guns at ships, missiles), the captain
// holds the ship off the island beyond the batteries' reach and, while the AI has no ship to shoot at, lays the
// railgun on the land positions it knows (detected), ramps first.
//    mode 'bot'      competent captain
//    mode 'passive'  the player does nothing (engines stopped, no orders)
// Balance table:  node tests/v2.missions.railgun.captain.mjs [runs]   (DIFF=easy,normal,hard; TUNE='{"normal":{"gap":50}}')
import { World } from '../gamev2/state.js';
import { RAIL_TUNE } from '../gamev2/missions_special_c.js';

const ORDER = { launcher: 0, battery: 1, radar: 2, airfield: 3, sam: 4, bunker: 5 };
const HOLD = { x: -20500, y: 2500 };
const REACT = 8;      // s a human needs to see a newly located position and lay the guns on it

export function captain(w, mode = 'bot') {
   const p = w.player;
   if (mode !== 'bot') { p.setTelegraph(0); return () => {}; }
   w.autoPlayer = true;
   // helm: the captain's rudder and telegraph replace the AI's
   const rudder = p.setRudder.bind(p), telegraph = p.setTelegraph.bind(p);
   let r = 0, tel = 2;
   p.setRudder = () => rudder(r);
   p.setTelegraph = () => telegraph(tel);
   // gun laying: the AI's aim point wins while it has one, else the forced one
   let aiAim = null, forced = null;
   Object.defineProperty(p, 'aimPoint', { configurable: true, get: () => aiAim || forced, set: (v) => { aiAim = v; } });
   let t = 0;
   const seen = new Map();
   return () => {
      if (w.phase !== 'playing' || !p.alive) return;
      if ((t -= 1 / 60) > 0) { if (!aiAim && forced) p.fireMain(w, forced); return; }
      t = 0.5;
      // station: back to the hold point when more than 2 km off, else slow circles
      const dx = HOLD.x - p.pos.x, dy = HOLD.y - p.pos.y, d = Math.hypot(dx, dy);
      if (d > 2000) {
         const e = Math.atan2(Math.sin(Math.atan2(dy, dx) - p.heading), Math.cos(Math.atan2(dy, dx) - p.heading));
         r = Math.abs(e) < 0.05 ? 0 : e > 0 ? (Math.abs(e) > 0.3 ? 2 : 1) : (Math.abs(e) > 0.3 ? -2 : -1);
         tel = 3;
      } else { r = 1; tel = 2; }
      // target: the known land position of most value within gun range
      let best = null, bk = 1e9;
      for (const s of w.sites) {
         if (!s.alive || s.side === p.side || !s.detected) { seen.delete(s.id); continue; }
         if (!seen.has(s.id)) seen.set(s.id, w.time);
         if (w.time - seen.get(s.id) < REACT) continue;
         const dd = Math.hypot(s.x - p.pos.x, s.y - p.pos.y);
         if (dd > p.cfg.main.range * 0.98) continue;
         const k = ORDER[s.kind] * 1e5 + dd;
         if (k < bk) { bk = k; best = s; }
      }
      forced = best ? { x: best.x, y: best.y } : null;
      if (!aiAim && forced) p.fireMain(w, forced);
   };
}

// One run: { win, reason, t, hp, sites, tf }
export function runOnce(diff, seed, mode = 'bot', maxT = 17 * 60) {
   const w = new World(diff, { mission: 'railgun', ship: 'Donar', seed });
   const cap = captain(w, mode);
   while (w.phase === 'playing' && w.time < maxT) { w.update(1 / 60); cap(); }
   return { win: w.phase === 'won', phase: w.phase, reason: w.result ? w.result.reason : 'time', t: Math.round(w.time),
      hp: w.player.alive ? +(w.player.hp / w.player.maxHP).toFixed(2) : 0, sites: w.sites.filter(s => !s.alive).length,
      objs: w.mission.objectives.map(o => o.id + ':' + (o.state || '-')).join(' ') };
}

if (process.argv[1] && process.argv[1].endsWith('railgun.captain.mjs')) {
   const runs = Number(process.argv[2] || 10);
   if (process.env.TUNE) { const t = JSON.parse(process.env.TUNE); for (const k in t) Object.assign(RAIL_TUNE.railgun[k], t[k]); }
   for (const diff of (process.env.DIFF || 'easy,normal,hard').split(',')) {
      let wins = 0; const out = [];
      for (let i = 0; i < runs; i++) { const r = runOnce(diff, 1000 + i, process.env.MODE || 'bot'); if (r.win) wins++; out.push(r); }
      console.log(diff, `${wins}/${runs}`);
      for (const r of out) console.log('  ', r.win ? 'WIN ' : 'LOSS', r.t + 's', 'hp', r.hp, 'sites', r.sites, r.objs, '|', r.reason);
   }
}
