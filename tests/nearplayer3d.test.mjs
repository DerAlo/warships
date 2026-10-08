// WW2 3D (game3d): routed and escorted AI ships with the player ship sailing close to them.
// The bot captains never do that, so these runs put a nuisance captain on the player ship: abeam and
// sheering off, across the bow, stopped on the track, close astern, closing from the quarter
// (tests/nearplayer.mjs). No ship of the group may circle, stall, keep backing off or fall behind
// the same seed with the player keeping clear.
//
//    NEAR_SEEDS=6 node --test tests/nearplayer3d.test.mjs       wider sweep: 6 seeds, all modes, more missions
//    NEAR_ONLY=convoy,pedestal ...                               only these missions
//    node tests/nearplayer.mjs game3d convoy - all 3 600         the numbers behind one mission
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../game3d/state.js';
import { nearSuite } from './nearplayer.mjs';

const freighter = (s) => s.type === 'TR';
const side = (name) => (s) => s.side === name;

nearSuite(test, assert, World, [
   // own convoys and escorted ships
   { mission: 'convoy', ship: 'Hipper', pick: freighter, tMax: 620 },
   { mission: 'pedestal', ship: 'Fiji', pick: freighter, tMax: 560 },
   { mission: 'barents', ship: 'Fiji', pick: freighter, tMax: 600, modes: ['beside', 'block', 'tail'] },
   { mission: 'samar', ship: 'Fletcher', pick: side('player'), tMax: 560, modes: ['cross', 'block', 'ram'] },
   { mission: 'rearguard', ship: 'Hipper', pick: side('player'), target: 0, tMax: 400, modes: ['beside', 'cross', 'ram'] },
   // enemy convoys and columns the player closes with
   { mission: 'raid', ship: 'Hipper', pick: freighter, tMax: 600, modes: ['cross', 'block'] },
   { mission: 'wolfpack', ship: 'U96', pick: freighter, tMax: 600, modes: ['beside', 'block'] },
   { mission: 'wahoo', ship: 'Gato', pick: freighter, tMax: 600, modes: ['cross', 'ram'] },
   { mission: 'dakar', ship: 'Richelieu', pick: freighter, tMax: 320, modes: ['beside', 'block'] },
   { mission: 'juno', ship: 'Scharnhorst', pick: (s) => s.type === 'CV', target: 0, tMax: 450, modes: ['beside', 'cross'] },
   { mission: 'vian', ship: 'Jervis', pick: side('enemy'), target: 0, tMax: 500, modes: ['cross', 'block', 'ram'] },
   { mission: 'surigao', ship: 'Fletcher', pick: side('enemy'), tMax: 460, modes: ['cross', 'block'] },
   // fast warships on a short run-in: the nuisance captain can hardly hold on to them (wide sweep only)
   { mission: 'matapan', ship: 'Warspite', pick: side('enemy'), tMax: 200, wide: true, lim: { near: 1500 } },
   { mission: 'strait', ship: 'Hipper', pick: side('enemy'), tMax: 300, wide: true, lim: { near: 1500 } },
   { mission: 'nordkap', ship: 'DukeOfYork', pick: side('enemy'), target: 0, tMax: 360, wide: true, lim: { near: 1500 } },
   { mission: 'guadalcanal', ship: 'Washington', pick: side('enemy'), target: 0, warm: 70, tMax: 300, wide: true, lim: { near: 1500 } },
], 'ww2');
