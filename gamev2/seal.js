// gamev2/seal.js — special-forces teams of the submarines (cfg.sub.seal) and the task points they
// work on. Plain data in world.teams[] and world.taskPoints[]; World.update calls updateTeams.
//
// TaskPoint: { id, x, y, pos {x, y}, kind (free string of the mission: 'sabotage' | 'recon' | 'rescue' | ...),
//              label, workTime (s), side (who may work on it), siteId | null, state 'open' | 'busy' | 'done', teamId }
//    addTaskPoint(world, { x, y, kind, label, workTime, side = 'player', siteId, id }) -> task point
//    A 'sabotage' point with siteId destroys that land position when the work is done. Missions react
//    to the event teamDone or to world._script.onTaskDone(world, task, team).
// Team: { id, side, ownerId (boat), taskId, x, y, pos {x, y}, heading, speed, n (men), state, t (s in the
//         state), workT (s left), workTime, seenT (s under enemy eyes), reason (when lost) }
//    state  'out' (boat to the point) -> 'working' -> 'returning' -> 'recovered'   |   'lost'
//    launchTeam(world, sub): the boat is at the surface or periscope depth, slower than SEAL.maxSpeed,
//       has a team on board and an open task point of its side inside SEAL.range.   Command ['S'].
//    The boat has to wait: the team comes back to where the boat is and is taken aboard inside
//       SEAL.pickup when the boat is not deep and nearly stopped. It is lost when an enemy surface ship
//       stays inside SEAL.spot for SEAL.spotT seconds, when the boat is sunk, or when it is not picked
//       up within SEAL.endurance seconds after the work.
//    Teams stay in world.teams after 'recovered' / 'lost' (the debriefing reads them).
// Events: teamOut { srcId, teamId, taskId, pos }, teamWork { srcId, teamId, taskId, pos, workTime },
//    teamDone { srcId, teamId, taskId, kind, siteId, pos }, teamRecovered { srcId, teamId, taskId },
//    teamLost { srcId, teamId, taskId, reason 'spotted' | 'stranded' | 'boat' | 'blast', pos }.
import { damageSite, siteById } from './sites.js';

export const SEAL = { range: 2600, speed: 9, maxSpeed: 3, pickup: 110, pickupSpeed: 4, spot: 650, spotT: 5, endurance: 240, workTime: 40, men: 6 };

const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function addTaskPoint(world, o = {}) {
   const p = {
      id: o.id ?? world._nextId++, x: +o.x || 0, y: +o.y || 0, pos: null, kind: o.kind || 'sabotage', label: o.label || 'Einsatzpunkt',
      workTime: o.workTime ?? SEAL.workTime, side: o.side || 'player', siteId: o.siteId ?? null, state: 'open', teamId: null,
   };
   p.pos = { x: p.x, y: p.y };
   world.taskPoints.push(p);
   return p;
}
export function taskPointById(world, id) {
   for (const p of world.taskPoints) if (p.id === id) return p;
   return null;
}
export function teamById(world, id) {
   for (const t of world.teams) if (t.id === id) return t;
   return null;
}
export function teamOf(world, sub) { return sub && sub.teamOut != null ? teamById(world, sub.teamOut) : null; }

function nearestTask(world, sub) {
   let best = null, bd = Infinity;
   for (const p of world.taskPoints) {
      if (p.state !== 'open' || p.side !== sub.side) continue;
      const d = hyp(p, sub.pos);
      if (d < bd) { bd = d; best = p; }
   }
   return best ? { task: best, dist: bd } : null;
}
const teamsLeft = (sub) => sub.teamsLeft ?? (sub.teamsLeft = sub.cfg.sub && sub.cfg.sub.seal ? (sub.cfg.sub.seal === true ? 1 : +sub.cfg.sub.seal || 0) : 0);

// HUD: { can, why (German reason | null), team (the one that is out | null), task (nearest open point | null), dist, left }
export function teamStatus(world, sub) {
   const r = { can: false, why: null, team: null, task: null, dist: Infinity, left: 0 };
   if (!sub || !sub.alive || !sub.sub || !sub.cfg.sub.seal) { r.why = 'Kein Kommandotrupp an Bord'; return r; }
   r.left = teamsLeft(sub);
   r.team = teamOf(world, sub);
   const n = nearestTask(world, sub);
   if (n) { r.task = n.task; r.dist = n.dist; }
   if (r.team) r.why = 'Trupp ist im Einsatz';
   else if (r.left <= 0) r.why = 'Kein Kommandotrupp an Bord';
   else if (sub.depth > 1) r.why = 'Zu tief: auf Sehrohrtiefe gehen';
   else if (Math.abs(sub.speed) > SEAL.maxSpeed) r.why = 'Zu schnell: Fahrt herausnehmen';
   else if (!n) r.why = 'Kein Einsatzpunkt';
   else if (n.dist > SEAL.range) r.why = 'Einsatzpunkt zu weit entfernt';
   else r.can = true;
   return r;
}

export function launchTeam(world, sub) {
   const st = teamStatus(world, sub);
   if (!st.can) return null;
   const p = st.task;
   const t = {
      id: world._nextId++, side: sub.side, ownerId: sub.id, taskId: p.id, x: sub.pos.x, y: sub.pos.y, pos: null,
      heading: Math.atan2(p.y - sub.pos.y, p.x - sub.pos.x), speed: SEAL.speed, n: SEAL.men,
      state: 'out', t: 0, workT: 0, workTime: p.workTime, seenT: 0, reason: null,
   };
   t.pos = { x: t.x, y: t.y };
   world.teams.push(t);
   sub.teamOut = t.id; sub.teamsLeft--;
   p.state = 'busy'; p.teamId = t.id;
   world.pushEvent('teamOut', { srcId: sub.id, teamId: t.id, taskId: p.id, pos: { x: t.x, y: t.y }, text: 'Kommandotrupp ausgesetzt: ' + p.label });
   return t;
}

export function loseTeam(world, t, reason) { if (t.state !== 'lost' && t.state !== 'recovered') lose(world, t, reason); }
function lose(world, t, reason) {
   t.state = 'lost'; t.reason = reason; t.t = 0;
   const sub = world.shipById(t.ownerId), p = taskPointById(world, t.taskId);
   if (sub && sub.teamOut === t.id) sub.teamOut = null;
   if (p && p.state === 'busy') { p.state = 'open'; p.teamId = null; }
   world.pushEvent('teamLost', { srcId: t.ownerId, teamId: t.id, taskId: t.taskId, reason, pos: { x: t.x, y: t.y }, text: 'Kommandotrupp verloren' });
   if (world._script && world._script.onTeamLost) world._script.onTeamLost(world, t, reason);
}
function move(t, to, dt) {
   const d = hyp(to, t);
   if (d < 1) return d;
   const step = Math.min(d, t.speed * dt);
   t.heading = Math.atan2(to.y - t.y, to.x - t.x);
   t.x += (to.x - t.x) / d * step; t.y += (to.y - t.y) / d * step;
   t.pos.x = t.x; t.pos.y = t.y;
   return d - step;
}

export function updateTeams(world, dt) {
   for (const t of world.teams) {
      if (t.state === 'recovered' || t.state === 'lost') continue;
      t.t += dt;
      const sub = world.shipById(t.ownerId), p = taskPointById(world, t.taskId);
      if (!sub || !sub.alive) { lose(world, t, 'boat'); continue; }
      // enemy eyes: a surface ship close by for a few seconds
      let near = false;
      for (const O of world.ships) {
         if (!O.alive || O.side === t.side || O.depth > 0) continue;
         if (hyp(O.pos, t) < SEAL.spot) { near = true; break; }
      }
      t.seenT = near ? t.seenT + dt : Math.max(0, t.seenT - dt * 0.5);
      if (t.seenT >= SEAL.spotT) { lose(world, t, 'spotted'); continue; }
      if (t.state === 'out') {
         if (!p) { t.state = 'returning'; t.t = 0; continue; }
         if (move(t, p, dt) < 20) {
            t.state = 'working'; t.t = 0; t.workT = t.workTime;
            world.pushEvent('teamWork', { srcId: sub.id, teamId: t.id, taskId: p.id, workTime: t.workTime, pos: { x: t.x, y: t.y }, text: 'Kommandotrupp am Ziel' });
         }
      } else if (t.state === 'working') {
         t.workT -= dt;
         if (t.workT > 0) continue;
         t.workT = 0; t.state = 'returning'; t.t = 0;
         if (p) {
            p.state = 'done';
            const site = p.siteId != null ? siteById(world, p.siteId) : null;
            if (site && site.alive && p.kind === 'sabotage') damageSite(world, site, site.hp + 1, sub, 'team');
            world.pushEvent('teamDone', { srcId: sub.id, teamId: t.id, taskId: p.id, kind: p.kind, siteId: p.siteId, pos: { x: t.x, y: t.y }, text: 'Auftrag ausgeführt: ' + p.label });
            if (world._script && world._script.onTaskDone) world._script.onTaskDone(world, p, t);
         }
      } else {   // returning: to where the boat is now
         if (t.t > SEAL.endurance) { lose(world, t, 'stranded'); continue; }
         const d = move(t, sub.pos, dt);
         if (d < SEAL.pickup && sub.depth <= 1 && Math.abs(sub.speed) <= SEAL.pickupSpeed) {
            t.state = 'recovered'; t.t = 0;
            sub.teamOut = null;
            world.pushEvent('teamRecovered', { srcId: sub.id, teamId: t.id, taskId: t.taskId, pos: { x: t.x, y: t.y }, text: 'Kommandotrupp wieder an Bord' });
            if (world._script && world._script.onTeamRecovered) world._script.onTeamRecovered(world, t);
         }
      }
   }
}
