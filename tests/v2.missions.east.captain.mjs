// Bot captain of the east operations (6-10) for the unit tests and the balance runner: the sim's own
// AI sails the player's ship (world.autoPlayer) plus the few orders a mission asks for that the AI
// does not give by itself. captain(world, mode) returns a function to call after every world.update.
//    mode 'bot'      competent captain
//    mode 'passive'  the player does nothing (engines stopped, no orders)
import { setRadar } from '../gamev2/sensors.js';
import { launchCruise, cruiseBlock } from '../gamev2/missile.js';
import { canLaunch, launchSquadron } from '../gamev2/air.js';
import { SEAL, launchTeam } from '../gamev2/seal.js';
import { orderDepth } from '../gamev2/submarine.js';

// Cruise missiles of ship p in the order of the briefing instead of the AI's own choice (reefs, countdown;
// null for the other missions). Every captain of a co-op group fires by it: the missiles already on the
// way to a site count whoever launched them. Returns a per-step function.
export function cruiseOrders(w, p) {
   const S = w._script, id = w.mission.id;
   const site = (sid) => w.sites.find(s => s.id === sid && s.alive);
   const strike = (order) => {
      if (!p.alive) return;
      (p.ai || (p.ai = {})).crT = 1e9;
      const cw = p.cfg.weapons.cruise;
      if (!cw || !(p.mag[cw.type] > 0)) return;
      const tgt = order.map(site).find(Boolean);
      if (!tgt) return;
      let on = 0;
      for (const m of w.missiles) if (m.alive && m.kind === 'cruise' && m.side === 'player' && m.target === tgt.id) on += m.dmg;
      if (on >= tgt.hp * 2.5) return;
      if (!cruiseBlock(w, p, { siteId: tgt.id })) launchCruise(w, p, { siteId: tgt.id });
   };
   if (id === 'reefs') return () => strike([S.radarId, ...S.bat, ...S.sam]);
   if (id === 'countdown') return () => { if (w.time > 20) strike([S.radarId, ...S.sam, ...(site(S.launcherId)?.targetable ? [S.launcherId] : [])]); };
   return null;
}

export function captain(w, mode = 'bot') {
   const p = w.player, S = w._script, id = w.mission.id;
   if (mode !== 'bot') { p.setTelegraph(0); return () => {}; }
   w.autoPlayer = true;
   p.ai = p.ai || {};
   p.setTelegraph(3);
   const strike = cruiseOrders(w, p);
   if (id === 'reefs') return strike;
   if (id === 'countdown' && p.sub && p.cfg.sub.seal) {
      // the boat goes in deep, slows down and stops while a surface ship is near, comes up to periscope
      // depth short of the task point and puts the team ashore
      const tp = w.taskPoints[0];
      const d0 = Math.hypot(tp.x - p.pos.x, tp.y - p.pos.y);
      const stop = { x: tp.x + (p.pos.x - tp.x) / d0 * 1500, y: tp.y + (p.pos.y - tp.y) / d0 * 1500 };
      w.autoPlayer = false;
      const surf = () => w.ships.filter(s => s.alive && s.side === 'enemy' && s.depth === 0 && s.type !== 'SS');
      let last = Infinity, lastT = 0, rising = false, parked = false;
      return () => {
         if (!p.alive) return;
         const near = surf().reduce((m, s) => Math.min(m, Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y) * (s.cls === 'Typ054A' ? 1 : 1.9)), Infinity);
         if (w.time - lastT >= 3) { rising = near > last + 20; last = near; lastT = w.time; }
         const closing = near < 3400 || (near < 4400 && !rising);
         const d = Math.hypot(tp.x - p.pos.x, tp.y - p.pos.y), ds = Math.hypot(stop.x - p.pos.x, stop.y - p.pos.y);
         // held by a sonar: break contact at full speed, away from the nearest frigate
         if (!p.teamOut && p.sonarSeen && w.time - p.sonarSeen.t < 20) {
            const f = surf().reduce((m, x) => (!m || Math.hypot(x.pos.x - p.pos.x, x.pos.y - p.pos.y) < Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y) ? x : m), null);
            if (f) {
               const want = Math.atan2(p.pos.y - f.pos.y, p.pos.x - f.pos.x), e = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
               p.setRudder(Math.abs(e) < 0.05 ? 0 : e > 0 ? 2 : -2); p.setTelegraph(4); orderDepth(p, 2, w); parked = false; return;
            }
         }
         if (p.teamOut != null || (p.teamsLeft ?? 1) <= 0) { orderDepth(p, near < 4000 ? 2 : 1, w); p.setTelegraph(0); return; }
         if (!parked) {
            orderDepth(p, 2, w);
            const want = Math.atan2(stop.y - p.pos.y, stop.x - p.pos.x);
            const e = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
            p.setRudder(Math.abs(e) < 0.03 ? 0 : e > 0 ? (Math.abs(e) > 0.3 ? 2 : 1) : (Math.abs(e) > 0.3 ? -2 : -1));
            p.setTelegraph(closing ? 0 : ds < 600 ? 1 : near < 4300 ? 2 : near < 5400 ? 3 : 4);
            if (ds < 160) parked = true;
         } else {
            p.setTelegraph(0); p.setRudder(0);
            if (near > 2600) { orderDepth(p, 1, w); if (p.depth <= 1 && d < 1800) launchTeam(w, p); } else orderDepth(p, 2, w);
         }
      };
   }
   if (id === 'countdown') return () => {
      strike();
      // the launcher's strike at the group: straight out of the danger zone at full speed, then back to the fight
      const b = S.strikeId && w.blasts.find(x => x.id === S.strikeId && x.state === 'armed');
      if (b && Math.hypot(p.pos.x - b.x, p.pos.y - b.y) < b.r.shock + 900) {
         if (!p.ai.route) {
            const d = Math.hypot(p.pos.x - b.x, p.pos.y - b.y), a = d > 300 ? Math.atan2(p.pos.y - b.y, p.pos.x - b.x) : p.heading;
            p.ai.route = [{ x: b.x + Math.cos(a) * (b.r.shock + 3000), y: b.y + Math.sin(a) * (b.r.shock + 3000) }]; p.ai.routeIdx = 0;
         }
      } else if (p.ai.route) { delete p.ai.route; p.ai.routeIdx = 0; }
   };
   if (id === 'strait') return () => { const f = S.conv.map(x => w.shipById(x)).find(s => s && s.alive); if (f) p.ai.escortId = f.id; };
   if (id === 'barents') { return () => { if (p.id !== S.fordId) p.ai.escortId = S.fordId; }; }
   if (id === 'philsea') return () => {
      // an escort stays with the carrier until the enemy is found, then goes for the Shandong with the group
      if (p.id !== S.fordId) { if (S.found) { delete p.ai.escortId; p.ai.huntId = S.sdId; p.ai.press = true; } else p.ai.escortId = S.fordId; }
      if (S.found || S.hot) return;
      if (p.radarOn) setRadar(w, p, false);
      // a carrier sends a fighter flight to the bearing the patrol aircraft reported
      if (S.hint && p.air && canLaunch(w, p, 'ft') && !w.squadrons.some(q => q.ownerId === p.id && q.type === 'ft' && q.state !== 'land' && q.state !== 'return')) {
         launchSquadron(w, p, 'ft', { kind: 'patrol', pos: { x: S.hint.x, y: S.hint.y } });
      }
   };
   return () => {};
}
