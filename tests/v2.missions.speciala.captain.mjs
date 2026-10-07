// Bot captain of the special operations, set A (gamev2/missions_special_a.js), for the unit tests and
// the balance runner: the sim's own AI sails the player's ship (world.autoPlayer) plus the orders a mission
// asks for that the AI does not give by itself. captain(world, mode) returns a function to call after
// every world.update.
//    mode 'bot'      competent captain
//    mode 'passive'  the player does nothing (engines stopped, no orders)
// Balance table:  node tests/v2.missions.speciala.captain.mjs [mission] [runs]   (prints wins per difficulty and the loss causes)
import { World } from '../gamev2/state.js';
import { sendHelo, heloOf } from '../gamev2/helo.js';
import { CABLE } from '../gamev2/missions_special_a.js';

const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// The captain takes the helm of ship p while the ship's AI keeps fighting: the AI's own rudder and
// telegraph orders are replaced by the captain's. Returns steerTo(point, telegraph).
function takeHelm(p) {
   const rudder = p.setRudder.bind(p), telegraph = p.setTelegraph.bind(p);
   let r = 0, tel = 3;
   p.setRudder = () => rudder(r);
   p.setTelegraph = () => telegraph(tel);
   return (q, t) => {
      const want = Math.atan2(q.y - p.pos.y, q.x - p.pos.x), e = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
      r = Math.abs(e) < 0.03 ? 0 : e > 0 ? (Math.abs(e) > 0.3 ? 2 : 1) : (Math.abs(e) > 0.3 ? -2 : -1);
      tel = t;
   };
}

export function captain(w, mode = 'bot') {
   const p = w.player, S = w._script, id = w.mission.id;
   if (mode !== 'bot') { p.setTelegraph(0); return () => {}; }
   w.autoPlayer = true;
   p.ai = p.ai || {};
   p.setTelegraph(3);
   if (id === 'cable') {
      // What a careful captain does: the slowest merchant first (the one that drags its anchor is slower),
      // the helicopter ahead to the next candidate, then alongside the identified ship at its own speed.
      // The ship's AI keeps fighting (guns on the boats, missile defence) while the helm follows these orders.
      let heloT = 0;
      const steerTo = takeHelm(p);
      const next = (skip) => {
         let best = null, bv = Infinity;
         for (let i = 0; i < S.merch.length; i++) {
            if (S.look[i] < 0) continue;
            const m = w.shipById(S.merch[i]);
            if (!m || !m.alive || m === skip) continue;
            const v = w.time < 20 ? hyp(m.pos, p.pos) / 1000 : Math.abs(m.speed);      // under way for a while: by speed
            if (v < bv) { bv = v; best = m; }
         }
         return best;
      };
      return () => {
         if (!p.alive || w.phase !== 'playing') return;
         const sus = S.found ? w.shipById(S.susId) : null;
         const goal = sus || next(null);
         if (!goal) return;
         if (!sus && (heloT -= 1 / 60) <= 0) {
            heloT = 6;
            const second = next(goal);
            if (second && p.cfg.helo && (heloOf(w, p) || w.time > 5)) sendHelo(w, p, { x: second.pos.x + second.vel.x * 20, y: second.pos.y + second.vel.y * 20 });
         }
         // helm: run in on a point abeam of the merchant, then keep pace inside the boarding distance
         const d = hyp(goal.pos, p.pos), c = Math.cos(goal.heading), s = Math.sin(goal.heading);
         const side = (p.pos.x - goal.pos.x) * -s + (p.pos.y - goal.pos.y) * c >= 0 ? 1 : -1;
         const lead = Math.min(d / 90, 60);
         const q = { x: goal.pos.x + goal.vel.x * lead - s * side * 260, y: goal.pos.y + goal.vel.y * lead + c * side * 260 };
         if (d > 2600) steerTo(q, 4);
         else if (d > CABLE.boardDist * 0.8) steerTo(q, Math.abs(p.speed) > p.maxSpeed * 0.6 && d < 1500 ? 1 : 2);
         else steerTo({ x: p.pos.x + c * 800 - s * side * (260 - hyp(goal.pos, p.pos)), y: p.pos.y + s * 800 + c * side * (260 - hyp(goal.pos, p.pos)) }, Math.abs(p.speed) > Math.abs(goal.speed) + 3 ? 1 : 2);
      };
   }
   return () => {};
}

// ---------------------------------------------------------------- balance runner
export function play(id, diff, seed, mode = 'bot', ship = null) {
   const w = new World(diff, { mission: id, ship, seed });
   const cap = captain(w, mode);
   for (let i = 0; i < 60 * 900 && w.phase === 'playing'; i++) { w.update(1 / 60); cap(); }
   return w;
}
if (process.argv[1] && process.argv[1].endsWith('v2.missions.speciala.captain.mjs')) {
   const ids = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : ['cable'];
   const runs = Number(process.argv[3]) || 30, diffs = (process.argv[4] || 'easy,normal,hard').split(',');
   for (const id of ids) for (const diff of diffs) {
      let wins = 0, t = 0; const why = {}, times = [];
      for (let k = 0; k < runs; k++) {
         const w = play(id, diff, 1000 + k * 7919);
         if (w.phase === 'won') { wins++; t += w.time; times.push(Math.round(w.time)); }
         else { const r = (w.result?.reason || 'no result').replace(/^(MV|MT|LNG) [^ ]+ [^ ]+ /, '<Schiff> ').slice(0, 60); why[r] = (why[r] || 0) + 1; }
      }
      console.log(`${id.padEnd(8)} ${diff.padEnd(6)} ${wins}/${runs} = ${Math.round(wins / runs * 100)} %  avg win ${wins ? Math.round(t / wins) : '-'} s  losses: ${JSON.stringify(why)}${process.env.TIMES ? '  win times: ' + times.sort((a, b) => a - b).join(' ') : ''}`);
   }
}
