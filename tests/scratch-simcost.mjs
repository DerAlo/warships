// scratch: sim CPU cost per fixed step (ms) per mission after 1 min of battle; deleted before commit
import { World } from '../game3d/state.js';
for (const m of (process.argv[2] || 'standard,domination,convoy,laststand,raid').split(',')) {
   const w = new World('normal', { mission: m, seed: 4242 });
   w.autoPlayer = true;
   for (let i = 0; i < 60 * 60 && w.phase === 'playing'; i++) w.update(1 / 60);
   const t0 = performance.now();
   let n = 0, worst = 0;
   for (; n < 60 * 120 && w.phase === 'playing'; n++) {
      const a = performance.now();
      w.update(1 / 60);
      const el = performance.now() - a; worst = Math.max(worst, el);
      if (el > 6 && process.env.SLOW) console.log("  slow step", n, "t", w.time.toFixed(1), el.toFixed(1), "ms");
   }
   const ms = (performance.now() - t0) / n;
   console.log(m.padEnd(12), 'steps', n, 'avg ms/step', ms.toFixed(3), 'worst', worst.toFixed(2), 'ships', w.ships.length, 'shells', w.shells.length);
}
