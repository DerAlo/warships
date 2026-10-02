// game3d/net/coop.js — which missions can be played in co-op and with how many humans.
// Owned by the netcode side (see CONTRACT.md); matchmaking only calls coopSlots().
import { getMission } from '../missions.js';

// max human players incl. the host; 0 = not playable in co-op
export function coopSlots(missionId) {
   const m = getMission(missionId);
   if (!m || m.fixedShips) return 0;
   return 4;
}
