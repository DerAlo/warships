// Modern mode (gamev2): routed and escorted AI ships with the flagship sailing close to them.
// The bot captains never do that, so these runs put a nuisance captain on the player ship: abeam and
// sheering off, across the bow, stopped on the track, close astern, closing from the quarter
// (tests/nearplayer.mjs). No ship of the group may circle, stall, keep backing off or fall behind
// the same seed with the player keeping clear.
//
//    NEAR_SEEDS=6 node --test tests/v2.nearplayer.test.mjs      wider sweep: 6 seeds, all modes, more missions
//    NEAR_ONLY=redsea,giuk ...                                   only these missions
//    node tests/nearplayer.mjs gamev2 redsea - all 3 600         the numbers behind one mission
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../gamev2/state.js';
import { nearSuite } from './nearplayer.mjs';

const freighter = (s) => s.type === 'TR';
// evac: the ferry lies at anchor until the last boat transport is in; cast her off as the mission does
const castOff = (w) => {
   const S = w._script, f = w.shipById(S.ferryId);
   f.ai.anchored = false; f.ai.convoy = true; f.ai.route = S.route.map(p => ({ x: p.x, y: p.y })); f.ai.routeIdx = 0; f.setTelegraph(4);
   S.stage = 2;
};

nearSuite(test, assert, World, [
   { mission: 'redsea', ship: 'Burke', pick: freighter, tMax: 620 },
   { mission: 'hormus', ship: 'Sachsen', pick: freighter, tMax: 620, modes: ['beside', 'block', 'ram'] },
   { mission: 'giuk', ship: 'Sachsen', pick: freighter, tMax: 620 },
   { mission: 'strait', ship: 'Sachsen', pick: freighter, tMax: 620, modes: ['beside', 'cross', 'ram'] },
   { mission: 'evac', ship: 'Sachsen', pick: freighter, target: 0, tMax: 400, prepare: castOff },
   { mission: 'hijack', ship: 'Sachsen', pick: freighter, target: 0, tMax: 500, modes: ['cross', 'block'] },
   { mission: 'cable', ship: 'Sachsen', pick: freighter, tMax: 450, modes: ['beside', 'block'] },
], 'v2');
