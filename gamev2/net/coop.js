// game3d/net/coop.js — which missions can be played in co-op and with how many humans.
// Owned by the netcode side (see CONTRACT.md); matchmaking only calls these.
import { missionSlots, missionRoles, NO_COOP } from './setup.js';

// max human players incl. the host; 0 = not playable in co-op. Every human but the host takes
// the place of an allied bot, so the limit is 1 + the mission's replaceable allied bots (at most
// 4); in a historical operation (prescribed ships) 1 + the allied ships the mission brings.
// Unknown missions, missions without such a ship and the ones in coopExcluded() return 0.
export function coopSlots(missionId) {
   return missionSlots(missionId);
}

// Historical operations: the ship of every slot, [{ cls, name }] (slot 0 = host = flagship).
// Empty for missions with free ship choice: there every player picks an own ship.
export function coopRoles(missionId, difficulty) {
   return missionRoles(missionId, difficulty);
}

// missions kept out of co-op on purpose: { id: German reason }
export function coopExcluded() {
   return { ...NO_COOP };
}
