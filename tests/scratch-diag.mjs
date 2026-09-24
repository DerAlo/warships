// scratch: trace one bot's navigation state; deleted before commit
import { World } from '../game3d/state.js';
const [mid, seed, name, t0 = '300', t1 = '420', autoP = '1'] = process.argv.slice(2);
const w = new World('normal', { mission: mid, seed: +seed });
w.autoPlayer = autoP === '1';
const s = w.ships.find(x => x.name === name); if (!s) throw new Error("no ship");
console.log('arena', w.arena, 'islands', w.obstacles.filter(o => o.kind === 'island').map(o => `${Math.round(o.c.x)},${Math.round(o.c.y)} r${o.r} rMax${Math.round(o.rMax || 0)}`).join(' ; '));
let next = +t0;
while (w.phase === 'playing' && w.time < +t1) {
   w.update(1 / 60);
   if (w.time >= next) {
      next += +(process.env.STEP || 6);
      const a = s.ai || {};
      const tg = a.target;
      if (!s.alive) { console.log("dead"); break; } console.log(`t=${w.time.toFixed(0)} pos=${Math.round(s.pos.x)},${Math.round(s.pos.y)} hdg=${(s.heading * 57.3 % 360).toFixed(0)} spd=${s.speed.toFixed(1)} tel=${s.telegraph} rud=${s.rudder.toFixed(2)} want=${a.desired != null ? (a.desired * 57.3 % 360).toFixed(0) : '-'} lvl=${a.avoidLevel} tgt=${tg ? tg.name + '@' + Math.round(Math.hypot(tg.pos.x - s.pos.x, tg.pos.y - s.pos.y)) : '-'} rev=${(a.reverseT || 0).toFixed(1)} esc=${a.escortId ?? '-'} cap=${!!a.capId} brk=${!!a.breakOff} gr=${!!s.grounded} st=${(a.stuckT || 0).toFixed(1)} om=${s.omega.toFixed(3)}`);
   }
}
