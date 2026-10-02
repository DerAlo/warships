// game3d/net/coop.js — which missions can be played in co-op and with how many humans.
// Owned by the netcode side (see CONTRACT.md); matchmaking only calls coopSlots().
import { missionSlots } from './setup.js';

// max human players incl. the host; 0 = not playable in co-op. Every human but the host takes
// the place of an allied bot, so the limit is 1 + the mission's replaceable allied bots (at most
// 4). Missions with prescribed ships, unknown missions and missions without such a bot return 0.
export function coopSlots(missionId) {
   return missionSlots(missionId);
}
