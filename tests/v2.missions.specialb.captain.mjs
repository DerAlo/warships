// Bot captain of the special operations in gamev2/missions_special_b.js for the unit tests and the
// balance table: the sim's own AI sails and fights the captains' ships, the captain adds the orders
// the mission asks for (hijack: go alongside the tanker and match its speed).
//    captain(world, mode)   returns a function to call after every world.update
//       mode 'bot'      competent captain (in a co-op world every human captain is played)
//       mode 'passive'  the player does nothing (engines stopped, no orders)
//    play(id, o)            one seeded run to the end: o = { diff, seed, ship, n (captains), mode }
import { World } from '../gamev2/state.js';
import { getMission } from '../gamev2/missions.js';
import { BOARD, TRAIL, SPECIAL_B_TUNE } from '../gamev2/missions_special_b.js';
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

// bastion: no AI at the helm (it would shoot). The captain stays deep and never runs louder than the listeners
// around him allow. He comes in from the quarter, enters the blind arc astern outside the reach of the missile
// boat's sonar, holds the middle of the band, goes to 1/4 for every check astern (after a reaction time drawn
// from the mission's own random listening times, up to REACT s: the bot is otherwise deterministic), falls back
// and leaves for the exit once the trail is recorded. `k` shifts a second boat within the band.
export const REACT = 12;
const FIRE = +process.env.BASTION_FIRE || 4500;      // m at which he turns on the hunter boat and fires
function bastionHelm(w, b, k = 0) {
   const S = w._script, t = w.shipById(S.tgtId);
   if (!b.alive || !t || !t.alive) return;
   // hard, weapons released against the hunter boat: up to periscope depth, bow on its lead, a spread, down again
   const g = S.released && S.guardId ? w.shipById(S.guardId) : null;
   if (g && g.alive && hyp(g.pos, b.pos) < FIRE &&b.torps.launchers.some(l => l.reload <= 0)) {
      const tt = hyp(g.pos, b.pos) / (b.cfg.torp.speedKn * 2.6);
      const brg = Math.atan2(g.pos.y + Math.sin(g.heading) * g.speed * tt - b.pos.y, g.pos.x + Math.cos(g.heading) * g.speed * tt - b.pos.x);
      b.depthTarget = 1; turn(b, brg); b.setTelegraph(1);
      if (b.depth === 1 && Math.abs(Math.atan2(Math.sin(brg - b.heading), Math.cos(brg - b.heading))) < 0.05) b.fireTorpedoes(w, brg);
      return;
   }
   b.depthTarget = g && g.alive ? 1 : 2;      // he waits for it at periscope depth (no launch from deep water)
   const frac = [0, 0.25, 0.5, 0.75, 1], kn = (tel) => b.maxSpeedKn * b.sub.deepSpeed * frac[tel], loud = (tel) => 0.5 + 0.5 * frac[tel];
   const foes = w.ships.filter(o => o.alive && o.side === 'enemy' && o !== t);
   const reach = (o) => o.id === S.guardId ? TRAIL.sub : TRAIL.frig;
   const hx = Math.cos(t.heading), hy = Math.sin(t.heading), d = hyp(b.pos, t.pos);
   const al = (b.pos.x - t.pos.x) * hx + (b.pos.y - t.pos.y) * hy, lat = (b.pos.x - t.pos.x) * -hy + (b.pos.y - t.pos.y) * hx;
   const astern = al / Math.max(1, d) < -Math.cos(TRAIL.arc - 0.06);
   // the highest telegraph up to `tel` at which neither an escort nor the missile boat hears the boat
   const quiet = (tel, inArc = astern) => {
      while (tel > 0 && foes.some(o => hyp(o.pos, b.pos) < reach(o) * loud(tel) + 250)) tel--;
      while (tel > 2 && foes.some(o => hyp(o.pos, b.pos) < TRAIL.near + 300)) tel--;
      while (tel > 0 && (inArc && tel <= 2 ? d < TRAIL.aft + 100 : d < TRAIL.bow * loud(tel) + 150)) tel--;
      return tel;
   };
   // an escort about to hear us: turn away from where it is going
   const near = foes.filter(o => !(S.released && o.id === S.guardId) && hyp(o.pos, b.pos) < reach(o) * 0.75 + 700).sort((p, q) => hyp(p.pos, b.pos) - hyp(q.pos, b.pos))[0];
   if (near) {
      const fx = near.pos.x + Math.cos(near.heading) * near.speed * 40, fy = near.pos.y + Math.sin(near.heading) * near.speed * 40;
      turn(b, Math.atan2(b.pos.y - fy, b.pos.x - fx)); b.setTelegraph(Math.max(1, quiet(2))); return;
   }
   if (S.stage >= 2) {
      const e = { x: S.exit.x + k * 500, y: S.exit.y + k * 300 };
      turn(b, Math.atan2(e.y - b.pos.y, e.x - b.pos.x)); b.setTelegraph(hyp(b.pos, e) < 500 ? 0 : quiet(4, false)); return;
   }
   // the check astern: 1/4 from the warning (plus the reaction time) until it is over
   if (S.stage === 1 && d < TRAIL.bow + 400) {
      const r = Math.abs(Math.sin(S.listenAt * 12.9898 + b.id * 78.233) * 43758.5453) % 1;
      const from = S.listenAt - SPECIAL_B_TUNE.bastion[w.difficultyKey].warn + r * REACT;
      if (w.time >= from && w.time < S.listenEnd) { turn(b, t.heading); b.setTelegraph(Math.min(1, quiet(1))); return; }
   }
   const side = lat >= 0 ? 1 : -1;
   const meet = (off, across, tel) => {      // where a point of her wake (off m astern, across m to our side) will be when we get there
      let tau = 0, m;
      for (let i = 0; i < 4; i++) { m = { x: t.pos.x + hx * (t.speed * tau - off) - hy * side * across, y: t.pos.y + hy * (t.speed * tau - off) + hx * side * across }; tau = Math.min(300, hyp(b.pos, m) / Math.max(1, kn(tel) * 2.6)); }
      return m;
   };
   if (!astern) {
      // outside the blind arc: make for its outer end, never inside the reach of her sonar
      const m = meet(2700, 1300, 2);
      turn(b, Math.atan2(m.y - b.pos.y, m.x - b.pos.x)); b.setTelegraph(quiet(4)); return;
   }
   const want = (TRAIL.min + TRAIL.max) / 2 - 150 + k * 450, m = meet(want, 0, 2);
   const st = { x: t.pos.x - hx * want, y: t.pos.y - hy * want }, ds = hyp(b.pos, st);
   turn(b, ds < 250 ? t.heading : Math.atan2(m.y - b.pos.y, m.x - b.pos.x));
   const along = (st.x - b.pos.x) * hx + (st.y - b.pos.y) * hy;      // + = the station is ahead of us
   b.setTelegraph(quiet(ds > 400 && along > 0 ? 2 : along > 150 ? 2 : along > -250 ? 1 : 0));
}

export function captain(w, mode = 'bot') {
   const p = w.player, S = w._script, id = w.mission.id;
   if (mode !== 'bot') { p.setTelegraph(0); return () => {}; }
   if (id === 'bastion') {
      const boats = [p, ...(w.net && w.net.humans ? w.net.humans.slice(1) : [])];
      return () => { if (w.phase === 'playing') boats.forEach((b, i) => bastionHelm(w, b, i)); };
   }
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
   // evac: the captain runs into the pickup zone and lies stopped there (the AI fights from where the ship
   // lies); a second captain keeps between the pier and the boats. Once the ferry sails both escort it.
   if (id === 'evac') return () => {
      if (w.phase !== 'playing') return;
      const f = w.shipById(S.ferryId), z = S.zone;
      if (S.stage >= 2) {
         delete p.ai.route; p.ai.escortId = f ? f.id : null;
         for (const e of extras) e.ai.escortId = p.ai.escortId;
         think();
         return;
      }
      for (const e of extras) { e.ai.escortId = null; e.ai.route = [{ x: z.x - 1300, y: z.y + 900 }]; e.ai.routeIdx = 0; }
      const d = hyp(p.pos, z);
      if (d > 1500) { p.ai.route = [{ x: z.x, y: z.y }]; p.ai.routeIdx = 0; think(); return; }
      delete p.ai.route;
      think(() => {
         if (d < 450) { p.setTelegraph(0); p.setRudder(0); return; }
         turn(p, Math.atan2(z.y - p.pos.y, z.x - p.pos.x));
         p.setTelegraph(d > 900 ? 2 : 1);
      });
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
export { BOARD, TRAIL };

// Balance table:   node tests/v2.missions.specialb.captain.mjs <id> [runs = 30] [captains = 1]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()) && process.argv[2]) {
   const id = process.argv[2], runs = +process.argv[3] || 30, n = +process.argv[4] || 1;
   for (const diff of ['easy', 'normal', 'hard']) {
      let wins = 0, t = 0; const why = {};
      for (let i = 0; i < runs; i++) {
         const w = play(id, { diff, seed: 1000 + i * 7919, n });
         t += w.time;
         if (w.phase === 'won') wins++; else { const r = (w.result ? w.result.reason : 'no end').slice(0, 44); why[r] = (why[r] || 0) + 1; }
      }
      console.log(`${id.padEnd(8)} ${diff.padEnd(6)} ${wins}/${runs} = ${Math.round(wins / runs * 100)} %  avg ${Math.round(t / runs)} s  ${JSON.stringify(why)}`);
   }
}
