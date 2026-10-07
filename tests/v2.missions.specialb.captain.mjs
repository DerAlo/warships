// Bot captain of the special operations in gamev2/missions_special_b.js for the unit tests and the
// balance table: the sim's own AI sails and fights the captains' ships, the captain adds the orders
// the mission asks for (hijack: go alongside the tanker and match its speed).
//    captain(world, mode)   returns a function to call after every world.update
//       mode 'bot'      competent captain (in a co-op world every human captain is played)
//       mode 'passive'  the player does nothing (engines stopped, no orders)
//    play(id, o)            one seeded run to the end: o = { diff, seed, ship, n (captains), mode }
import { World } from '../gamev2/state.js';
import { getMission } from '../gamev2/missions.js';
import { BOARD } from '../gamev2/missions_special_b.js';
import { buildNetWorld } from '../gamev2/net/setup.js';
import { updateBots } from '../gamev2/ai.js';

const DT = 1 / 60;
const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const turn = (p, want) => {
   const e = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
   p.setRudder(Math.abs(e) < 0.03 ? 0 : e > 0 ? (Math.abs(e) > 0.3 ? 2 : 1) : (Math.abs(e) > 0.3 ? -2 : -1));
};

// hijack: the AI fights the boats with the guns; the helm is the captain's. He runs to a station
// 350 m abeam of the tanker on his own side and holds it at the tanker's speed.
function hijackHelm(w, p) {
   const S = w._script, t = w.shipById(S.tankId);
   if (!t || !t.alive || !p.alive) return false;
   const hx = Math.cos(t.heading), hy = Math.sin(t.heading);
   const side = (p.pos.x - t.pos.x) * -hy + (p.pos.y - t.pos.y) * hx >= 0 ? 1 : -1;      // left (+) or right of the tanker
   const st = { x: t.pos.x - hy * 350 * side, y: t.pos.y + hx * 350 * side };
   const d = hyp(p.pos, t.pos);
   if (d > 1600) {
      const k = t.speed * Math.min(90, d / 80);
      p.ai.route = [{ x: st.x + hx * k, y: st.y + hy * k }]; p.ai.routeIdx = 0;
      return false;
   }
   delete p.ai.route;
   return () => {
      const ex = st.x - p.pos.x, ey = st.y - p.pos.y;
      const along = ex * hx + ey * hy, cross = ex * -hy + ey * hx;
      turn(p, t.heading + Math.max(-0.7, Math.min(0.7, cross / 400)));
      p.setTelegraph(along > 300 ? 4 : along > 80 ? 3 : along < -150 ? 1 : 2);
   };
}

export function captain(w, mode = 'bot') {
   const p = w.player, S = w._script, id = w.mission.id;
   if (mode !== 'bot') { p.setTelegraph(0); return () => {}; }
   w.autoPlayer = true;
   p.ai = p.ai || {};
   p.setTelegraph(4);
   const extras = w.net && w.net.humans ? w.net.humans.slice(1) : [];
   for (const e of extras) e.ai = e.ai || {};
   // The AI thinks once per tick (ai.js updateBots). The captain lets it think for the coming tick, with
   // the human flag of the other captains lifted, and then overrides the helm where he steers himself.
   const think = (helm) => {
      for (const e of extras) e.human = false;
      w.tick++; updateBots(w, DT); w.tick--;
      for (const e of extras) e.human = true;
      if (helm) helm();
   };
   if (id === 'hijack') return () => {
      if (w.phase !== 'playing') return;
      // a second captain goes for the boats nearest to the tanker
      const t = w.shipById(S.tankId);
      for (const e of extras) {
         if (!e.alive || !t) continue;
         let best = null, bd = Infinity;
         for (const s of w.ships) { if (!s.alive || s.side !== 'enemy' || s === t) continue; const d = hyp(s.pos, t.pos); if (d < bd) { bd = d; best = s; } }
         e.ai.escortId = null; e.ai.huntId = best ? best.id : null; e.ai.press = true;
      }
      think(hijackHelm(w, p));
   };
   return () => {};
}

// One run of mission `id` to its end. o.n > 1: a co-op world with n captains (the host in the
// recommended ship, the others in the mission's allied ships as in a net game).
export function play(id, o = {}) {
   const def = getMission(id), ship = o.ship || def.recommendedShip, n = o.n || 1;
   let w;
   if (n > 1) {
      const other = def.playableShips.find(k => k !== ship) || ship, classes = [ship, ...Array(n - 1).fill(other)];
      w = buildNetWorld({ mission: id, difficulty: o.diff || 'normal', seed: o.seed ?? 4711, classes, loadouts: classes.map(() => null), self: 0 });
   } else w = new World(o.diff || 'normal', { mission: id, ship, seed: o.seed ?? 4711 });
   const cap = captain(w, o.mode || 'bot');
   for (let i = 0, m = Math.round((def.timeLimit + 10) / DT); i < m && w.phase === 'playing'; i++) { w.update(DT); cap(); if (o.each) o.each(w); }
   return w;
}
export { BOARD };
