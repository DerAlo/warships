// Co-op balance of the ten operations: N human captains (host + N-1 allied ships taken over as in a net
// game), all sailed by the bot captain, seeded runs per mission, win rate and end reasons. Not a test.
//    RUNS=30 N=2 DIFF=normal ONLY=strait,giuk WHY=1 SLOTS=1 node tests/v2.coop.balance.mjs
//    DIFF may be a comma-separated list. The seeds are a fixed sequence (run i: 101 + 37 i east, 1000 + 37 i west),
//    so a longer table extends a shorter one (FROM=60 RUNS=60: runs 60 to 119 only). TUNE (env): JSON merged over the tune tables for a trial without
//    editing them, e.g. TUNE='{"reefs":{"hard":{"coopFrig":0}},"redsea":{"hard":{"coopFrom":5}}}'
import { getMission } from '../gamev2/missions.js';
import { buildNetWorld, missionSlots } from '../gamev2/net/setup.js';
import { updateBots } from '../gamev2/ai.js';
import { orderDepth } from '../gamev2/submarine.js';
import { launchTeam, teamStatus } from '../gamev2/seal.js';
import { sendHelo } from '../gamev2/helo.js';
import { captain, cruiseOrders } from './v2.missions.east.captain.mjs';
import { EAST_TUNE } from '../gamev2/missions_east.js';
import { WEST_TUNE } from '../gamev2/missions_west.js';

const EAST = ['barents', 'reefs', 'strait', 'philsea', 'countdown'];
const WEST = ['hormus', 'redsea', 'pipeline', 'blacksea', 'giuk'];
const RUNS = +process.env.RUNS || 30, N = +process.env.N || 2, DIFFS = (process.env.DIFF || 'normal').split(',');
let DIFF = DIFFS[0];
const FROM = +process.env.FROM || 0;
if (process.env.TUNE) {
   const over = JSON.parse(process.env.TUNE);
   for (const m in over) {
      const T = EAST_TUNE[m] || WEST_TUNE[m];
      if (!T) throw new Error('TUNE: no tune table for ' + m);
      for (const d in over[m]) Object.assign(T[d] || (T[d] = {}), over[m][d]);
   }
}
const only = process.env.ONLY ? process.env.ONLY.split(',') : [...EAST, ...WEST];

const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function steerTo(p, to, tel) {
   const want = Math.atan2(to.y - p.pos.y, to.x - p.pos.x);
   const d = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
   p.setRudder(Math.abs(d) < 0.03 ? 0 : d > 0 ? (Math.abs(d) > 0.3 ? 2 : 1) : (Math.abs(d) > 0.3 ? -2 : -1));
   p.setTelegraph(tel);
}

// Host orders of the west missions (copied from tests/v2.missions.west.test.mjs): the single-player hint.
const HINT = {
   hormus(w) { w.player.ai = { escortId: w._script.convoy[1].id }; },
   redsea(w) { w.player.ai = { escortId: w._script.convoy[1].id }; },
   giuk(w) {
      const p = w.player;
      p.ai = { escortId: w._script.convoy[0].id };
      return helo(w, p);
   },
   blacksea(w) { w.player.ai = { huntId: w._script.cruiser.id }; },
};
// A captain who also flies the helicopter: to the datum of the nearest reported boat (giuk).
function helo(w, p) {
   const S = w._script;
   let t = 0, at = null, fix = null;
   return () => {
      if (w.time < t || !p.alive || !p.cfg.helo) return;
      t = w.time + 2;
      let best = null, bd = Infinity;
      for (const s of S.subs) if (s.alive && hyp(s.pos, p.pos) < bd) { bd = hyp(s.pos, p.pos); best = s; }
      if (best && at !== best.id && sendHelo(w, p, best.detected ? best.pos : best._datum)) at = best.id;
      if (best && best.detected && fix !== best.id && sendHelo(w, p, best.pos)) fix = best.id;
   };
}

// Orders an extra captain gets: what the host's captain gives the host's ship, but only on ship.ai
// (the AI keeps its own role and state). Returns a per-step function.
function extraOrders(w, id, e) {
   const S = w._script;
   e.ai = e.ai || {};
   // A captain's ship has the full load of its class (net/setup.js), so he fires his cruise missiles like
   // the host's captain: in the order of the briefing (reefs, countdown), elsewhere by the AI's own choice.
   const fire = cruiseOrders(w, e) || (() => {});
   switch (id) {
      case 'strait': return () => { const f = S.conv.map(x => w.shipById(x)).find(s => s && s.alive); if (f) e.ai.escortId = f.id; };
      case 'barents': return () => { if (e.id !== S.fordId) e.ai.escortId = S.fordId; };
      case 'philsea': return () => {
         if (e.id === S.fordId) return;
         if (S.found) { delete e.ai.escortId; e.ai.huntId = S.sdId; e.ai.press = true; } else e.ai.escortId = S.fordId;
      };
      case 'hormus': case 'redsea': return () => { e.ai.escortId = S.convoy[1].id; };
      case 'giuk': { e.ai.escortId = S.convoy[0].id; return helo(w, e); }
      case 'blacksea': return () => { e.ai.huntId = S.cruiser.id; };
      case 'pipeline': {
         // the second boat lies deep and still; once the team is aboard the host it follows to the exit zone
         return () => {
            if (!e.alive) return;
            orderDepth(e, 2, w);
            if (S.recovered && hyp(e.pos, S.exit) > 300) steerTo(e, S.exit, 3);
            else { e.setTelegraph(0); e.setRudder(0); }
         };
      }
      case 'countdown': return () => {
         fire();
         // out of the danger zone of the launcher's strike, like the host's captain
         const b = S.strikeId && w.blasts.find(x => x.id === S.strikeId && x.state === 'armed');
         if (b && hyp(e.pos, b) < b.r.shock + 900) {
            if (!e.ai.route) {
               const a = hyp(e.pos, b) > 300 ? Math.atan2(e.pos.y - b.y, e.pos.x - b.x) : e.heading;
               e.ai.route = [{ x: b.x + Math.cos(a) * (b.r.shock + 3000), y: b.y + Math.sin(a) * (b.r.shock + 3000) }]; e.ai.routeIdx = 0;
            }
         } else if (e.ai.route) { delete e.ai.route; e.ai.routeIdx = 0; }
      };
      case 'reefs': return fire;
      default: return () => {};
   }
}

function play(id, n, diff, seed) {
   const def = getMission(id), east = EAST.includes(id);
   const rec = def.recommendedShip, other = def.playableShips.find(k => k !== rec) || rec;
   const classes = [rec, ...Array(n - 1).fill(other)];
   const w = buildNetWorld({ mission: id, difficulty: diff, seed, classes, loadouts: classes.map(() => null), self: 0 });
   const extras = w.net.humans.slice(1), DT = east ? 1 / 60 : 1 / 30;
   const orders = extras.map(e => extraOrders(w, id, e));
   let step = null, cap = null;
   if (east) cap = captain(w, 'bot');
   else if (id === 'pipeline') step = w._script.def.testRoute(w, { steerTo, orderDepth, launchTeam, teamStatus, hyp });
   else { w.autoPlayer = true; if (HINT[id]) step = HINT[id](w) || null; }
   // the sim's AI skips ships flagged human; for the AI-driven extras the flag is lifted while the AI
   // runs (it thinks for every ship once per tick, update() then finds the tick done) and set again
   const drive = id !== 'pipeline' ? extras : [];
   const track = w.net.humans.map(h => ({ path: 0, last: { x: h.pos.x, y: h.pos.y } }));
   const nSteps = east ? Math.round((def.timeLimit + 5) / DT) : Math.round((def.timeLimit + 20) / DT);
   for (let i = 0; i < nSteps && w.phase === 'playing'; i++) {
      if (step) step(w);
      for (const o of orders) o();
      if (drive.length) {
         for (const e of drive) e.human = false;
         w.tick++; updateBots(w, DT); w.tick--;
         for (const e of drive) e.human = true;
      }
      w.update(DT);
      if (cap) cap();
      if (i % 30 === 0) w.net.humans.forEach((h, k) => { track[k].path += hyp(h.pos, track[k].last); track[k].last = { x: h.pos.x, y: h.pos.y }; });
   }
   w.track = track;
   return w;
}

if (process.env.SLOTS) {
   for (const id of only) {
      const def = getMission(id), rec = def.recommendedShip, other = def.playableShips.find(k => k !== rec) || rec;
      const out = [];
      for (const n of [2, 4]) {
         const res = [];
         for (const seed of [11, 4242, 987654321]) {
            try {
               const classes = [rec, ...Array(n - 1).fill(other)];
               const w = buildNetWorld({ mission: id, difficulty: DIFF, seed, classes, loadouts: classes.map(() => null), self: 0 });
               res.push(w.net.humans.length + ':' + w.net.humans.map(h => h.cls).join('/'));
            } catch (e) { res.push('ERR ' + e.message); }
         }
         out.push(`N=${n} -> ${res.join('  ')}`);
      }
      console.log(id.padEnd(10) + out.join('   |   '));
   }
   process.exit(0);
}

for (const id of only) for (DIFF of DIFFS) {
   const def = getMission(id), east = EAST.includes(id);
   // the lobby admits missionSlots captains; beyond that buildNetWorld would add ships the mission does not
   // have (giuk with four captains: two extra destroyers with helicopters), which no game can reach
   // (FORCE=1 measures it anyway)
   if (N > missionSlots(id) && !process.env.FORCE) { console.log(`${id.padEnd(10)} ${String(N).padStart(2)}  ${DIFF.padEnd(6)} skipped: the mission takes ${missionSlots(id) || 'no'} captains in co-op`); continue; }
   let wins = 0, tSum = 0, tMax = 0, slotsMin = 99, slotsMax = 0;
   const why = {}, per = [];
   for (let i = 0; i < RUNS; i++) {
      const w = play(id, N, DIFF, (east ? 101 : 1000) + (FROM + i) * 37);
      if (w.phase === 'won') wins++;
      tSum += w.time; tMax = Math.max(tMax, w.time);
      const hs = w.net.humans;
      slotsMin = Math.min(slotsMin, hs.length); slotsMax = Math.max(slotsMax, hs.length);
      hs.forEach((h, k) => {
         const a = per[k] || (per[k] = { ssm: 0, dmg: 0, path: 0, alive: 0, human: 0, n: 0 });
         const st = h.stats || (h === w.player ? w.stats : {});
         a.ssm += st.ssmFired || 0; a.dmg += st.dmg || 0; a.path += w.track[k].path; a.alive += h.alive ? 1 : 0; a.human += (h.human || h.isPlayer) ? 1 : 0; a.n++;
      });
      const r = (w.phase === 'won' ? 'W ' : w.phase === 'lost' ? 'L ' : '? ') + (w.result?.reason || '');
      why[r] = (why[r] || 0) + 1;
   }
   console.log(`${id.padEnd(10)} ${String(N).padStart(2)}  ${DIFF.padEnd(6)} wins ${String(Math.round(100 * wins / RUNS)).padStart(3)} % (${wins}/${RUNS})   t ${Math.round(tSum / RUNS)} (${Math.round(tMax)}) / ${def.timeLimit}   slots ${slotsMin === slotsMax ? slotsMin : slotsMin + '-' + slotsMax}${process.env.TUNE ? '   ' + process.env.TUNE : ''}`);
   if (process.env.WHY) {
      for (const k in why) console.log('      ' + String(why[k]).padStart(3) + ' x ' + k);
      per.forEach((a, k) => console.log(`      captain ${k}: ssmFired ${(a.ssm / a.n).toFixed(1)}  dmg ${Math.round(a.dmg / a.n)}  path ${Math.round(a.path / a.n)} m  alive at end ${a.alive}/${a.n}  human ${a.human}/${a.n}`));
   }
}
