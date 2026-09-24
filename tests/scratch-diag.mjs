// scratch: trace one bot's navigation state; deleted before commit
import { World } from '../game3d/state.js';
const [mid, seed, name, t0 = '300', t1 = '420', autoP = '1'] = process.argv.slice(2);
const w = new World('normal', { mission: mid, seed: +seed });
w.autoPlayer = autoP === '1';
console.log('arena', w.arena, 'islands', w.obstacles.filter(o => o.kind === 'island').map(o => `${Math.round(o.c.x)},${Math.round(o.c.y)} r${o.r} rMax${Math.round(o.rMax || 0)}`).join(' ; '));
let next = +t0, s = null;
while (w.phase === 'playing' && w.time < +t1) {
   w.update(1 / 60);
   if (!s) s = w.ships.find(x => x.name === name);
   if (s && w.time >= next) {
      next += +(process.env.STEP || 6);
      const a = s.ai || {};
      const tg = a.target;
      if (!s.alive) { console.log('dead'); break; }
      const wp = a.navWp ? `${Math.round(a.navWp.x)},${Math.round(a.navWp.y)}` : '-';
      let nn = null, nd = 1e9; for (const o of w.ships) { if (o === s || !o.alive) continue; const d = Math.hypot(o.pos.x - s.pos.x, o.pos.y - s.pos.y); if (d < nd) { nd = d; nn = o; } }
      console.log(`near=${nn ? nn.name + "@" + Math.round(nd) : "-"} t=${w.time.toFixed(0)} pos=${Math.round(s.pos.x)},${Math.round(s.pos.y)} hdg=${(s.heading * 57.3 % 360).toFixed(0)} spd=${s.speed.toFixed(1)} tel=${s.telegraph} rud=${s.rudder.toFixed(2)} want=${a.desired != null ? (((a.desired * 57.3 % 360) + 360) % 360).toFixed(0) : '-'} lvl=${a.avoidLevel} wp=${wp} gp=${a.navGoal ? Math.round(a.navGoal.x) + ',' + Math.round(a.navGoal.y) : '-'} tgt=${tg ? tg.name + '@' + Math.round(Math.hypot(tg.pos.x - s.pos.x, tg.pos.y - s.pos.y)) : '-'} rev=${(a.reverseT || 0).toFixed(1)} gr=${!!s.grounded} wall=${!!s.atWall} st=${(a.stuckT || 0).toFixed(1)}`);
   }
}
