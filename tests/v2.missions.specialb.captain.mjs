// Bot captain of the special operations in gamev2/missions_special_b.js for the unit tests and the
// balance table: the sim's own AI sails and fights the captains' ships, the captain adds the orders
// the mission asks for (hijack: go alongside the tanker and match its speed).
//    captain(world, mode)   returns a function to call after every world.update
//       mode 'bot'      competent captain (in a co-op world every human captain is played)
//       mode 'passive'  the player does nothing (engines stopped, no orders)
//    play(id, o)            one seeded run to the end: o = { diff, seed, ship, n (captains), mode }
import { World } from '../gamev2/state.js';
import { getMission } from '../gamev2/missions.js';
import { BOARD, TRAIL } from '../gamev2/missions_special_b.js';
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

// bastion: no AI at the helm (it would shoot). The captain stays deep, lets the missile boat pass at a distance,
// falls in astern and holds the middle of the band; he stops for every check astern, creeps while a frigate is
// near, and leaves for the exit once the trail is recorded. `k` shifts a second boat within the band.
function bastionHelm(w, b, k = 0) {
   const S = w._script, t = w.shipById(S.tgtId);
   if (!b.alive || !t || !t.alive) return;
   if (b.depthTarget !== 2) b.depthTarget = 2;
   const kn = (tel) => b.maxSpeedKn * b.sub.deepSpeed * [0, 0.25, 0.5, 0.75, 1][tel];
   const foe = Math.min(...w.ships.filter(o => o.alive && o.side === 'enemy' && o !== t).map(o => hyp(o.pos, b.pos)), 1e9);
   const cap = (tel) => { while (tel > 1 && foe < TRAIL.near + 300 && kn(tel) > TRAIL.loudKn) tel--; while (tel > 0 && foe < 3600 && kn(tel) > 6) tel--; return tel; };
   // a hunter coming close: step off its track at a right angle, quietly
   const near = w.ships.filter(o => o.alive && o.side === 'enemy' && o !== t && hyp(o.pos, b.pos) < 5200 && !(S.released && o.id === S.guardId)).sort((a, c) => hyp(a.pos, b.pos) - hyp(c.pos, b.pos))[0];
   if (near) {
      const fx = Math.cos(near.heading), fy = Math.sin(near.heading), rx = b.pos.x - near.pos.x, ry = b.pos.y - near.pos.y;
      const side = rx * -fy + ry * fx >= 0 ? 1 : -1, closing = rx * fx + ry * fy > -400;
      const dn = hyp(near.pos, b.pos), lat = Math.abs(rx * -fy + ry * fx);
      const hear = near.cfg.sonar ? TRAIL.frig : TRAIL.sub;
      if (closing && lat < hear * 0.8) { turn(b, Math.atan2(fx * side, -fy * side)); b.setTelegraph(dn < hear * 0.625 + 150 ? 0 : dn < hear * 0.75 + 150 ? 1 : 2); return; }
   }
   if (S.stage >= 2) { turn(b, Math.atan2(S.exit.y - b.pos.y, S.exit.x - b.pos.x)); b.setTelegraph(hyp(b.pos, S.exit) < 600 ? 0 : cap(4)); return; }
   const hx = Math.cos(t.heading), hy = Math.sin(t.heading), d = hyp(b.pos, t.pos);
   const want = (TRAIL.min + TRAIL.max) / 2 - 250 + k * 500;
   const ahead = ((b.pos.x - t.pos.x) * hx + (b.pos.y - t.pos.y) * hy) / Math.max(1, d) > -Math.cos(TRAIL.arc);
   const st = { x: t.pos.x - hx * want, y: t.pos.y - hy * want }, ds = hyp(b.pos, st);
   const listen = S.stage === 1 && (S.listening || (S.warnedListen && w.time < S.listenEnd));
   if (listen && d < TRAIL.bow + 400) { b.setTelegraph(0); return; }
   const loud = (tel) => 0.5 + 0.5 * [0, 0.25, 0.5, 0.75, 1][tel];
   if (ahead) {
      // before its beam: lie 1.9 km off its track (the side we are on) and let it pass; the station then comes to us
      const lat = (b.pos.x - t.pos.x) * -hy + (b.pos.y - t.pos.y) * hx, side = lat >= 0 ? 1 : -1, off = 2500;
      const al = (b.pos.x - t.pos.x) * hx + (b.pos.y - t.pos.y) * hy;
      const fw = Math.max(0, Math.min(al - 600, al * 0.3));
      const wp = { x: t.pos.x + hx * fw - hy * side * off, y: t.pos.y + hy * fw + hx * side * off };
      turn(b, Math.atan2(wp.y - b.pos.y, wp.x - b.pos.x));
      let tel = cap(hyp(b.pos, wp) > 2500 ? 4 : hyp(b.pos, wp) > 500 ? 2 : hyp(b.pos, wp) > 150 ? 1 : 0);
      while (tel > 0 && d < TRAIL.bow * loud(tel) + 150) tel--;
      if (Math.abs(lat) < off - 250 && d < 4200) { turn(b, Math.atan2(hx * side, -hy * side)); tel = d > TRAIL.bow * loud(2) + 150 ? 2 : 1; }
      b.setTelegraph(tel); return;
   }
   // abaft its beam: meet the station where it will be
   let tau = 0; for (let i = 0; i < 4; i++) tau = Math.min(240, hyp(b.pos, { x: st.x + hx * t.speed * tau, y: st.y + hy * t.speed * tau }) / Math.max(1, kn(2) * 2.6));
   const m = { x: st.x + hx * t.speed * tau, y: st.y + hy * t.speed * tau };
   turn(b, ds < 250 ? t.heading : Math.atan2(m.y - b.pos.y, m.x - b.pos.x));
   const along = (st.x - b.pos.x) * hx + (st.y - b.pos.y) * hy;      // + = the station is ahead of us
   b.setTelegraph(cap(ds > 400 ? 2 : along > 150 ? 2 : along > -250 ? 1 : 0));
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
