// scratch: water gap between each island and the arena wall (pockets trap bots); deleted before commit
import { World } from '../game3d/state.js';
import { MISSIONS } from '../game3d/missions.js';
import { obstacleRadiusAt } from '../game3d/utils.js';
for (const m of MISSIONS) {
   const w = new World('normal', { mission: m.id, seed: 2000 });
   const A = w.arena - 60;
   const out = [];
   for (const o of w.obstacles) {
      if (o.kind !== 'island') continue;
      let gx = Infinity, gy = Infinity;
      for (let i = 0; i < 360; i++) {
         const a = i * Math.PI / 180, r = obstacleRadiusAt(o, a);
         const x = o.c.x + Math.cos(a) * r, y = o.c.y + Math.sin(a) * r;
         gx = Math.min(gx, A - Math.abs(x)); gy = Math.min(gy, A - Math.abs(y));
      }
      const g = Math.min(gx, gy);
      if (g < 2000) out.push(`${Math.round(o.c.x)},${Math.round(o.c.y)} r${o.r} gap=${Math.round(g)}`);
   }
   console.log(m.id.padEnd(12), 'arena', w.arena, out.join(' ; ') || 'ok');
}
