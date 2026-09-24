// scratch: find bots that sit still with the engine on (stuck on land / walls); deleted before commit
import { World } from '../game3d/state.js';
import { MISSIONS } from '../game3d/missions.js';
const seeds = +(process.argv[2] || 2);
for (const m of MISSIONS) for (let s = 0; s < seeds; s++) {
   const w = new World('normal', { mission: m.id, seed: 2000 + s * 977 });
   w.autoPlayer = true;
   const hist = new Map();
   const stuck = new Map();
   let tNext = 30;
   while (w.phase === 'playing' && w.time < 1500) {
      w.update(1 / 60);
      if (w.time < tNext) continue;
      tNext += 30;
      for (const sh of w.ships) {
         if (!sh.alive) continue;
         const h = hist.get(sh) || [];
         h.push({ x: sh.pos.x, y: sh.pos.y, tel: sh.telegraph });
         if (h.length > 4) h.shift();
         hist.set(sh, h);
         if (h.length === 4 && h.every(q => Math.abs(q.tel) > 0)) {
            const mv = Math.hypot(h[3].x - h[0].x, h[3].y - h[0].y);
            if (mv < 250) stuck.set(sh, (stuck.get(sh) || 0) + 1);
         }
      }
   }
   const bad = [...stuck].filter(([, n]) => n >= 2).map(([sh, n]) => `${sh.side}:${sh.name}@${Math.round(sh.pos.x)},${Math.round(sh.pos.y)} x${n} tel=${sh.telegraph} spd=${sh.speed.toFixed(1)}`);
   console.log(m.id.padEnd(12), s, w.phase, (w.time / 60).toFixed(1) + 'm', bad.length ? 'STUCK: ' + bad.join(' | ') : 'ok');
}
