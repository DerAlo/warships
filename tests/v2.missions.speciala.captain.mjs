// Bot captain of the special operations, set A (gamev2/missions_special_a.js), for the unit tests and
// the balance runner: the sim's own AI sails the player's ship (world.autoPlayer) plus the orders a mission
// asks for that the AI does not give by itself. captain(world, mode) returns a function to call after
// every world.update.
//    mode 'bot'      competent captain
//    mode 'passive'  the player does nothing (engines stopped, no orders)
// In a co-op world (play with n > 1: host + n-1 further captains as in a net game) the sim's AI sails the
// further captains' ships too; they keep station on the host and fight what comes for the group.
// Balance table:  node tests/v2.missions.speciala.captain.mjs [mission] [runs] [captains]   (prints wins per difficulty and the loss causes)
//    SHIP=Daring picks the host's ship (default: the mission's recommended one), DIFF=normal,hard the difficulties,
//    TUNE='{"rig":{"normal":{"boatDmg":1.2}}}' tries other values of the tune table
import { World } from '../gamev2/state.js';
import { getMission } from '../gamev2/missions.js';
import { buildNetWorld } from '../gamev2/net/setup.js';
import { updateBots } from '../gamev2/ai.js';
import { sendHelo, heloOf } from '../gamev2/helo.js';
import { CABLE, RIG, TOW, SPECIAL_A_TUNE } from '../gamev2/missions_special_a.js';

const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// The captain takes the helm of ship p while the ship's AI keeps fighting: the AI's own rudder and
// telegraph orders are replaced by the captain's. Returns steerTo(point, telegraph, soft): soft = never more than half rudder.
function takeHelm(p) {
   const rudder = p.setRudder.bind(p), telegraph = p.setTelegraph.bind(p);
   let r = 0, tel = 3;
   p.setRudder = () => rudder(r);
   p.setTelegraph = () => telegraph(tel);
   return (q, t, soft) => {
      const want = Math.atan2(q.y - p.pos.y, q.x - p.pos.x), e = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
      r = Math.abs(e) < 0.03 ? 0 : e > 0 ? (Math.abs(e) > 0.3 && !soft ? 2 : 1) : (Math.abs(e) > 0.3 && !soft ? -2 : -1);
      tel = t;
   };
}

export function captain(w, mode = 'bot') {
   const helm = hostCaptain(w, mode);
   const extras = mode === 'bot' && w.net && w.net.humans ? w.net.humans.slice(1) : [];
   if (!extras.length) return helm;
   // The sim's AI skips ships flagged human and thinks once per tick (ai.js updateBots): the flag is lifted
   // while it thinks for the coming tick, update() then finds the tick done.
   for (const e of extras) { e.ai = e.ai || {}; e.ai.escortId = w.player.id; }
   const S = w._script;
   let t = 0;
   return () => {
      helm();
      if (w.phase !== 'playing') return;
      // cable: the further captains clear other merchants than the host (from the end of the list), then close on the dragging one
      if (w.mission.id === 'cable' && (t -= 1 / 60) <= 0) {
         t = 2;
         const open = S.found ? [] : S.merch.filter((id, i) => S.look[i] >= 0 && w.shipById(id)?.alive);
         extras.forEach((e, k) => { e.ai.escortId = S.found ? S.susId : open.length ? open[open.length - 1 - k % open.length] : w.player.id; });
      }
      for (const e of extras) e.human = false;
      w.tick++; updateBots(w, 1 / 60); w.tick--;
      for (const e of extras) e.human = true;
   };
}
function hostCaptain(w, mode) {
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
   if (id === 'rig') {
      // Run in on the platform from the west, take the way off inside the launch circle and stay there: the boats
      // come out and the ship's AI fights them in open water (its guns hold while the fall of shot would lie at
      // the platform, world._script.noFire); the team goes over by itself once no boat is left at the platform.
      const steerTo = takeHelm(p);
      const hold = { x: RIG.x - RIG.launch * 0.8, y: RIG.y - 250 };
      return () => {
         if (!p.alive || w.phase !== 'playing') return;
         const d = Math.hypot(p.pos.x - RIG.x, p.pos.y - RIG.y);
         if (d > RIG.launch * 0.93) steerTo(hold, d > 3200 ? 4 : 2);
         else steerTo({ x: RIG.x, y: RIG.y }, d < 700 ? -1 : 0);
      };
   }
   if (id === 'rescue') {
      // Run in on a point just up-drift of the merchant's bow, take the way off there until the line is fast, then
      // tow toward the anchorage at quarter speed with half rudder at most and stop the engines when the load nears
      // its limit. The ship's AI keeps fighting the boats; the captain does not dodge them.
      const steerTo = takeHelm(p);
      return () => {
         if (!p.alive || w.phase !== 'playing') return;
         const m = w.shipById(S.merchId);
         if (!m || !m.alive) return;
         if (S.tugId === p.id) { steerTo(TOW.zone, S.crest > 0.9 ? 0 : 1, S.crest > 0.4); return; }
         const hl = m.cfg.hull.L / 2, bow = { x: m.pos.x + Math.cos(m.heading) * hl, y: m.pos.y + Math.sin(m.heading) * hl };
         const d = hyp(bow, p.pos), lead = Math.min(d / 60, 40), zd = hyp(bow, TOW.zone) || 1;
         // the point 250 m off the bow on the side of the anchorage, led by the drift seen so far
         const q = { x: bow.x + (TOW.zone.x - bow.x) / zd * 250 + m.vel.x * 0 + TOW.dx * 8 * lead, y: bow.y + (TOW.zone.y - bow.y) / zd * 250 + TOW.dy * 8 * lead };
         const v = Math.abs(p.speed) / p.maxSpeed;
         if (d > 1500) steerTo(q, 4);
         else if (d > 650) steerTo(q, v > 0.55 ? 0 : 2);
         else if (d > 320) steerTo(q, v > 0.28 ? 0 : 1);
         else steerTo(TOW.zone, v > 0.12 ? 0 : 1);
      };
   }
   return () => {};
}

// ---------------------------------------------------------------- balance runner
// n > 1: a co-op world with n captains (the host in `ship`, the others in the mission's other playable ship)
export function play(id, diff, seed, mode = 'bot', ship = null, n = 1) {
   let w;
   if (n > 1) {
      const def = getMission(id), own = ship || def.recommendedShip, other = def.playableShips.find(k => k !== own) || own;
      const classes = [own, ...Array(n - 1).fill(other)];
      w = buildNetWorld({ mission: id, difficulty: diff, seed, classes, loadouts: classes.map(() => null), self: 0 });
   } else w = new World(diff, { mission: id, ship, seed });
   const cap = captain(w, mode);
   for (let i = 0; i < 60 * 900 && w.phase === 'playing'; i++) { w.update(1 / 60); cap(); }
   return w;
}
if (process.argv[1] && process.argv[1].endsWith('v2.missions.speciala.captain.mjs')) {
   if (process.env.TUNE) { const o = JSON.parse(process.env.TUNE); for (const id in o) for (const d in o[id]) Object.assign(SPECIAL_A_TUNE[id][d], o[id][d]); }
   const ids = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : ['cable', 'rig', 'rescue'];
   const runs = Number(process.argv[3]) || 30, n = Number(process.argv[4]) || 1, ship = process.env.SHIP || null;
   const diffs = (process.env.DIFF || (Number(process.argv[4]) ? '' : process.argv[4]) || 'easy,normal,hard').split(',');
   for (const id of ids) for (const diff of diffs) {
      let wins = 0, t = 0; const why = {}, times = [];
      for (let k = 0; k < runs; k++) {
         const w = play(id, diff, 1000 + k * 7919, 'bot', ship, n);
         if (w.phase === 'won') { wins++; t += w.time; times.push(Math.round(w.time)); }
         else { const r = (w.result?.reason || 'no result').replace(/^(MV|MT|LNG) [^ ]+ [^ ]+ /, '<Schiff> ').slice(0, 44); why[r] = (why[r] || 0) + 1; }
      }
      console.log(`${id.padEnd(8)} ${diff.padEnd(6)} ${ship || 'default'} x${n} ${wins}/${runs} = ${Math.round(wins / runs * 100)} %  avg win ${wins ? Math.round(t / wins) : '-'} s  losses: ${JSON.stringify(why)}${process.env.TIMES ? '  win times: ' + times.sort((a, b) => a - b).join(' ') : ''}`);
   }
}
