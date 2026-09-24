// scratch: who deals the player's damage (and when) in a mission with the autopilot; deleted before commit
import { World } from '../game3d/state.js';
const [mid = 'laststand', diff = 'normal', seeds = 4] = process.argv.slice(2);
for (let s = 0; s < +seeds; s++) {
   const w = new World(diff, { mission: mid, seed: 1000 + s * 7919 });
   w.autoPlayer = true;
   if (process.env.KITE) w.player.ai.retreatBelow = 1.01;   // proxy for a human who runs and angles
   if (process.env.NOHUNT) delete w.player.ai.huntId;
   const p = w.player;
   const by = {};
   const orig = p.takeDamage.bind(p);
   p.takeDamage = (dmg, src, type, pool) => {
      const k = (src ? src.name : '?') + ':' + type;
      by[k] = (by[k] || 0) + dmg;
      return orig(dmg, src, type, pool);
   };
   const marks = [];
   let tm = 60, rudderFree = null;
   while (w.phase === 'playing' && w.time < 1800) {
      w.update(1 / 60);
      if (rudderFree == null && p.modules.rudder <= 0) rudderFree = w.time;
      if (w.time >= tm) { tm += 60; marks.push(Math.round(100 * p.hp / p.maxHP)); }
   }
   const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${Math.round(v)}`).join(' ');
   console.log(`seed ${s} ${w.phase} t=${(w.time / 60).toFixed(1)}m rudderFree=${rudderFree?.toFixed(0)}s hp%/min [${marks.join(',')}] fires=${w.stats.firesTaken ?? '-'}`);
   console.log('   ', top);
}
