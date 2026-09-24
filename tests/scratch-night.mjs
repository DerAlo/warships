// scratch: per-ship timeline of one mission run (deleted before commit)
import { World } from '../game3d/state.js';
const [mid = 'night', diff = 'normal', seed = '1000', ship = ''] = process.argv.slice(2);
const w = new World(diff, { mission: mid, ship: ship || undefined, seed: +seed });
w.autoPlayer = true;
const alive = new Set(w.ships.filter(s => s.alive));
let nextLog = 60;
while (w.phase === 'playing' && w.time < 1800) {
   w.update(1 / 60);
   for (const s of [...alive]) if (!s.alive) { alive.delete(s); console.log(`t=${(w.time / 60).toFixed(1)}m sunk ${s.side} ${s.name} (${s.cls || s.type})`); }
   if (w.time > nextLog) {
      nextLog += 60;
      const p = w.player;
      const sp = w.ships.filter(s => s.side === 'enemy' && s.alive && s.spotted).length;
      console.log(`t=${(w.time / 60).toFixed(0)}m player hp=${Math.round(p.hp)}/${p.maxHP} pos=${Math.round(p.pos.x)},${Math.round(p.pos.y)} spottedEnemies=${sp} dmg=${Math.round(w.stats.dmg)}`);
   }
}
console.log(w.phase, w.result?.reason, (w.time / 60).toFixed(1) + 'm', 'stats', JSON.stringify({ dmg: Math.round(w.stats.dmg), kills: w.stats.kills, cit: w.stats.citadels }));
