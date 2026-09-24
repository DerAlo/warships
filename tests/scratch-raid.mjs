// scratch: raid mission timeline (freighters, raiders) with the autopilot; deleted before commit
import { World } from '../game3d/state.js';
const [diff = 'normal', seed = 0] = process.argv.slice(2);
const w = new World(diff, { mission: 'raid', seed: 1000 + +seed * 7919 });
w.autoPlayer = true;
const S = w._script;
if (process.env.HUNT) w.player.ai.huntId = S.transports[2].id;
const gn = w.ships.find(s => s.name === 'Gneisenau');
let tm = 60;
const f = v => Math.round(v);
while (w.phase === 'playing' && w.time < 1800) {
   w.update(1 / 60);
   if (w.time < tm) continue;
   tm += 60;
   const tr = S.transports.map(t => t.alive ? `${f(t.pos.x / 100)},${f(t.pos.y / 100)}:${f(100 * t.hp / t.maxHP)}%` : 'x').join(' ');
   const sh = s => s && s.alive ? `${s.name}@${f(s.pos.x / 100)},${f(s.pos.y / 100)} ${f(100 * s.hp / s.maxHP)}% tgt=${s.ai?.target?.name || '-'}` : (s ? s.name + ' dead' : '-');
   console.log(`${(w.time / 60).toFixed(0).padStart(2)}m sunk=${S.sunk} esc=${S.escaped} | ${sh(w.player)} | ${sh(gn)} | ${tr}`);
}
console.log(w.phase, w.result?.reason);
