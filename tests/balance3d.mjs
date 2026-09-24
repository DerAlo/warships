// tests/balance3d.mjs -- headless balance sweep for the 3D missions: the AI captains the player
// ship (world.autoPlayer) and every mission x difficulty x ship runs to the end.
// Usage: node tests/balance3d.mjs [missions|all] [diffs|all] [seeds] [ships: rec|allp|A,B]
import { World } from '../game3d/state.js';
import { MISSIONS } from '../game3d/missions.js';

const arg = (i, d) => process.argv[i] && process.argv[i] !== 'all' ? process.argv[i] : d;
const mids = arg(2, MISSIONS.map(m => m.id).join(',')).split(',');
const diffs = arg(3, 'easy,normal,hard').split(',');
const seeds = +arg(4, 3);
const shipsArg = arg(5, 'rec');
const DT = 1 / 60;
for (const mid of mids) {
   const m = MISSIONS.find(x => x.id === mid);
   const ships = shipsArg === 'rec' ? [m.recommendedShip] : shipsArg === 'allp' ? m.playableShips : shipsArg.split(',');
   for (const diff of diffs) for (const ship of ships) {
      let wins = 0, tSum = 0, dmg = 0, kills = 0, cit = 0, alive = 0;
      const reasons = {};
      const t0 = Date.now();
      for (let s = 0; s < seeds; s++) {
         const w = new World(diff, { mission: mid, ship, seed: 1000 + s * 7919 });
         w.autoPlayer = true;
         while (w.phase === 'playing' && w.time < 1800) w.update(DT);
         if (w.phase === 'won') wins++;
         tSum += w.time; dmg += w.stats.dmg; kills += w.stats.kills; cit += w.stats.citadels;
         if (w.player.alive) alive++;
         const r = (w.result?.reason || 'timeout?').slice(0, 44);
         reasons[r] = (reasons[r] || 0) + 1;
      }
      console.log(`${mid.padEnd(12)} ${diff.padEnd(6)} ${ship.padEnd(11)} win ${wins}/${seeds} alive ${alive} ` +
         `t=${(tSum / seeds / 60).toFixed(1)}min dmg=${Math.round(dmg / seeds)} k=${(kills / seeds).toFixed(1)} ` +
         `cit=${(cit / seeds).toFixed(1)} [${((Date.now() - t0) / 1000).toFixed(0)}s] ${JSON.stringify(reasons)}`);
   }
}
