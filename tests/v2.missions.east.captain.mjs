// Bot captain of the east operations (6-10) for the unit tests and the balance runner: the sim's own
// AI sails the player's ship (world.autoPlayer) plus the few orders a mission asks for that the AI
// does not give by itself. captain(world, mode) returns a function to call after every world.update.
//    mode 'bot'      competent captain
//    mode 'passive'  the player does nothing (engines stopped, no orders)
import { setRadar } from '../gamev2/sensors.js';
import { launchCruise, cruiseBlock } from '../gamev2/missile.js';
import { canLaunch, launchSquadron } from '../gamev2/air.js';
import { SEAL, launchTeam } from '../gamev2/seal.js';

export function captain(w, mode = 'bot') {
   const p = w.player, S = w._script, id = w.mission.id;
   if (mode !== 'bot') { p.setTelegraph(0); return () => {}; }
   w.autoPlayer = true;
   p.ai = p.ai || {};
   p.setTelegraph(3);
   const site = (sid) => w.sites.find(s => s.id === sid && s.alive);
   // cruise missiles in the order of the briefing instead of the AI's own choice
   const strike = (order) => {
      p.ai.crT = 1e9;
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
   if (id === 'countdown' && p.sub && p.cfg.sub.seal) {
      // the boat creeps to the task point at periscope depth, stops and puts the team ashore
      const tp = w.taskPoints[0];
      const d0 = Math.hypot(tp.x - p.pos.x, tp.y - p.pos.y);
      const stop = { x: tp.x + (p.pos.x - tp.x) / d0 * 1500, y: tp.y + (p.pos.y - tp.y) / d0 * 1500 };
      p.ai.passive = true; p.ai.route = [stop];
      return () => {
         const d = Math.hypot(tp.x - p.pos.x, tp.y - p.pos.y);
         if (d < 1700 && p.teamOut == null && (p.teamsLeft ?? 1) > 0) { p.ai.anchored = true; p.setTelegraph(0); p.depthTarget = 1; launchTeam(w, p); }
      };
   }
   if (id === 'countdown') return () => { if (w.time > 20) strike([S.radarId, ...S.sam, ...(site(S.launcherId)?.targetable ? [S.launcherId] : [])]); };
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
