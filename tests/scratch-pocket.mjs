// scratch: ASCII map of the AI nav grid (# blocked, p pocket, . narrow); deleted before commit
import { World } from '../game3d/state.js';
import { MISSIONS } from '../game3d/missions.js';
const only = process.argv[2];
for (const m of MISSIONS) {
   if (only && m.id !== only) continue;
   const w = new World('normal', { mission: m.id, seed: 2000 });
   w.autoPlayer = true;
   for (let i = 0; i < 120 && !w._nav; i++) w.update(1 / 60);
   const g = w._nav;
   if (!g) { console.log(m.id, 'no grid'); continue; }
   console.log(m.id, 'N', g.N, 'pockets', g.pocket.reduce((a, v) => a + v, 0));
   for (let j = 0; j < g.N; j += 2) {
      let row = '';
      for (let i = 0; i < g.N; i++) {
         const c = j * g.N + i;
         row += g.blocked[c] ? '#' : g.pocket[c] ? 'p' : g.clear[c] < 3 ? '.' : ' ';
      }
      console.log(row);
   }
}
