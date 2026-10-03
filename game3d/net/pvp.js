// game3d/net/pvp.js — PvP: two teams of humans, the free places of both filled with bots.
// Owned by the netcode side (see CONTRACT.md); matchmaking only calls pvpMissions / pvpSlots.
//
// The host's World is the same as in co-op: its own team sails as side 'player', the other team
// as side 'enemy' (every human of that team takes the place of an enemy bot, setup.js). Missions
// write their texts from the host's point of view; mirror() turns them round for the other team.
import { MISSIONS } from '../missions.js';

export const PVP_MAX = 4;                       // humans in all, both teams
export const TEAM_MAX = PVP_MAX - 1;            // one team may hold all but one of them
// battles with two symmetric 7-ship fleets and a script that does not care who is human
export const PVP_MISSIONS = ['standard', 'domination'];

export const pvpMissions = () => MISSIONS.filter(m => PVP_MISSIONS.includes(m.id));
// max humans for a PvP match of the mission; 0 = not playable in PvP
export const pvpSlots = (missionId) => PVP_MISSIONS.includes(missionId) ? PVP_MAX : 0;

// end of a PvP match decided by the captains (setup.js net.check), host's point of view
export const PVP_WIN = 'Alle feindlichen Kapitäne wurden versenkt.';
export const PVP_LOSS = 'Alle Kapitäne Ihres Teams wurden versenkt.';

// host-perspective text <-> the same for the other team
const PAIRS = [
   ['Alle feindlichen Schiffe wurden versenkt.', 'Ihr Verband wurde vernichtet.'],
   ['Zeit abgelaufen – Ihr Verband hat die Oberhand behalten.', 'Zeit abgelaufen – der Gegner hat die Oberhand behalten.'],
   ['Ihr Team hat 1000 Punkte erreicht.', 'Der Gegner hat 1000 Punkte erreicht.'],
   ['Zeit abgelaufen – Ihr Team führt nach Punkten.', 'Zeit abgelaufen – der Gegner führt nach Punkten.'],
   [PVP_WIN, PVP_LOSS],
];
const MIRROR = new Map();
for (const [a, b] of PAIRS) { MIRROR.set(a, b); MIRROR.set(b, a); }
export const mirrorReason = (t) => MIRROR.get(t) ?? t;

// A log line of the host's World as the other team reads it: [text, type]. prev: the former
// owner of a point that was just taken (cap lines only).
export function mirrorLog(text, type, prev) {
   let m;
   const K = '🎯 Versenkt: ', L = '💀 Verlust: ';
   if (text.startsWith(K)) return [L + text.slice(K.length), 'warn'];
   if (text.startsWith(L)) return [K + text.slice(L.length), 'kill'];
   if ((m = /^🚩 Punkt (\S+) eingenommen$/.exec(text))) return ['⚑ Punkt ' + m[1] + (prev === 'enemy' ? ' verloren' : ' vom Feind eingenommen'), 'warn'];
   if ((m = /^⚑ Punkt (\S+) (verloren|vom Feind eingenommen)$/.exec(text))) return ['🚩 Punkt ' + m[1] + ' eingenommen', 'kill'];
   const W = '🏆 ', X = '💀 ';
   if (text.startsWith(W)) return [X + mirrorReason(text.slice(W.length)), 'warn'];
   if (text.startsWith(X) && MIRROR.has(text.slice(X.length))) return [W + mirrorReason(text.slice(X.length)), 'kill'];
   return [text, type];
}

// An event of the host's World for the other team: the same object, a mirrored copy or null.
export function mirrorEvent(type, d) {
   if (type === 'cap') return ['capLost', { ...d, text: 'Punkt ' + d.capId + (d.prev === 'enemy' ? ' verloren' : ' vom Feind eingenommen') }];
   if (type === 'capLost') return ['cap', { ...d, text: 'Punkt ' + d.capId + ' eingenommen' }];
   if (type === 'objective' && d.end) {
      const win = d.level !== 'win', reason = String(d.text || '').replace(/^(SIEG|NIEDERLAGE) — /, '');
      return [type, { ...d, level: win ? 'win' : 'lose', text: (win ? 'SIEG — ' : 'NIEDERLAGE — ') + mirrorReason(reason) }];
   }
   return [type, d];
}
