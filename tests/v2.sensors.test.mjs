// V2 sensors: radar, EMCON, stealth, island masking, ESM, detected vs targetable, data link.
import { test } from 'node:test';
import assert from 'node:assert';
import { emptySea, put, island } from './v2.util.mjs';
import { SHIPS, SENSOR } from '../gamev2/config.js';
import { setRadar, contactLevel, emitting } from '../gamev2/sensors.js';

const still = { ai: { passive: true } };

test('radar on: a ship is detected far beyond visual range; radar off: only by eye', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const foe = put(w, 'Slawa', 'enemy', 18000, 0, Math.PI, still);
   setRadar(w, foe, false);
   w._updateSpotting();
   assert.ok(w.player.radarOn);
   assert.ok(foe.detected, 'radar holds the cruiser at 18 km');
   setRadar(w, w.player, false);
   w._updateSpotting();
   assert.ok(!foe.detected, 'silent ship is blind at 18 km');
   foe.pos.x = 5000;
   w._updateSpotting();
   assert.ok(foe.detected && foe.targetable, 'eyes see it at 5 km');
});

test('stealth shortens the radar range against a ship', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const r = SHIPS.Sachsen.radar.range;
   const big = put(w, 'Slawa', 'enemy', r * 0.9, 0, 0, still);
   const small = put(w, 'Typ022', 'enemy', r * 0.9, 3000, 0, still);
   w._updateSpotting();
   assert.ok(big.detected);
   assert.ok(!small.detected, 'the catamaran hides at a range where the cruiser shows');
   small.pos.x = r * SHIPS.Typ022.stealth * 0.9;
   w._updateSpotting();
   assert.ok(small.detected);
});

test('detected is not targetable: fire-control quality needs the inner part of the radar range', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const foe = put(w, 'Slawa', 'enemy', 0, 0, 0, still);
   const r = SHIPS.Sachsen.radar.range * SHIPS.Slawa.stealth;
   foe.pos.x = r * (SENSOR.FC + 0.1);
   w._updateSpotting();
   assert.ok(foe.detected && !foe.targetable);
   assert.strictEqual(contactLevel(w, 'player', foe), 2);
   foe.pos.x = r * (SENSOR.FC - 0.1);
   w._updateSpotting();
   assert.ok(foe.detected && foe.targetable);
   assert.strictEqual(contactLevel(w, 'player', foe), 3);
});

test('islands mask radar', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const foe = put(w, 'Slawa', 'enemy', 12000, 0, 0, still);
   setRadar(w, foe, false);
   island(w, 6000, 0, 1500, 220);
   w._updateSpotting();
   assert.ok(!foe.detected, 'hidden behind the island');
   foe.pos.y = 9000;
   w._updateSpotting();
   assert.ok(foe.detected, 'clear line of sight again');
});

test('ESM: an emitter is heard at 1.5x its radar range, with a rough fix; a silent ship is not', () => {
   const w = emptySea({ ship: 'Sachsen' });
   setRadar(w, w.player, false);
   const R = SHIPS.Slawa.radar.range;
   const foe = put(w, 'Slawa', 'enemy', R * 1.3, 0, Math.PI, still);
   w._updateSpotting();
   assert.ok(foe.radarOn && emitting(foe));
   assert.ok(!foe.detected, 'beyond every sensor of the silent frigate');
   assert.ok(foe.esmSeen, 'but its radar is heard');
   assert.strictEqual(contactLevel(w, 'player', foe), 1);
   assert.ok(Math.abs(foe.esmSeen.brg) < 0.01, 'bearing is exact');
   const off = Math.hypot(foe.esmSeen.x - foe.pos.x, foe.esmSeen.y - foe.pos.y);
   assert.ok(off <= foe.esmSeen.err * 1.05 && foe.esmSeen.err > 1500, 'the range is a guess: ' + off.toFixed(0));
   assert.ok(!w.player.esmSeen && !w.player.detected, 'the silent frigate stays unseen: the Slawa radar does not reach it');
   // beyond 1.5x: nothing
   foe.pos.x = R * 1.6; foe.esmSeen = null;
   w._updateSpotting();
   assert.ok(!foe.esmSeen);
   // emitter goes silent: the contact fades after ESM_KEEP
   foe.pos.x = R * 1.3;
   w._updateSpotting();
   setRadar(w, foe, false);
   w.time += SENSOR.ESM_KEEP + 1;
   w._updateSpotting();
   assert.ok(!foe.esmSeen);
});

test('ESM: two listeners on a wide baseline give a much better fix', () => {
   const w = emptySea({ ship: 'Sachsen' });
   setRadar(w, w.player, false);
   const foe = put(w, 'Slawa', 'enemy', 30000, 0, Math.PI, still);
   w._updateSpotting();
   const one = foe.esmSeen.err;
   const mate = put(w, 'Braunschweig', 'player', 8000, 22000, 0, still);
   setRadar(w, mate, false);
   w._updateSpotting();
   assert.ok(foe.esmSeen.err < one * 0.5, one + ' -> ' + foe.esmSeen.err);
});

test('data link: a track held by one ship is targetable for the whole side', () => {
   const w = emptySea({ ship: 'Sachsen' });
   setRadar(w, w.player, false);
   const foe = put(w, 'Typ054A', 'enemy', 30000, 0, Math.PI, still);
   setRadar(w, foe, false);
   const picket = put(w, 'Braunschweig', 'player', 24000, 0, 0, still);
   w._updateSpotting();
   assert.ok(foe.detected && foe.targetable, 'the picket holds it, the silent frigate may shoot');
   assert.ok(picket.radarOn && picket.esmSeen, 'the radiating picket pays for it: the foe hears its radar');
   assert.ok(!w.player.esmSeen && !w.player.detected, 'the silent shooter stays hidden');
   picket.pos.x = 2000; picket.pos.y = 0;
   w._updateSpotting();
   assert.ok(!foe.detected, 'out of the picket radar range the track is lost');
});

test('EMCON trade: the radiating ship is heard by a silent one that it cannot see', () => {
   const w = emptySea({ ship: 'Daring' });           // very stealthy
   setRadar(w, w.player, false);
   const foe = put(w, 'Typ052D', 'enemy', 22000, 0, Math.PI, still);
   w._updateSpotting();
   assert.ok(foe.esmSeen && !w.player.detected && !w.player.esmSeen);
   setRadar(w, w.player, true);
   w._updateSpotting();
   assert.ok(w.player.esmSeen, 'switching the radar on gives the ship away');
});

test('jammer: shortens enemy radar range but radiates', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const foe = put(w, 'Typ052D', 'enemy', 0, 0, Math.PI, still);
   setRadar(w, w.player, false);
   const r = SHIPS.Typ052D.radar.range * SHIPS.Sachsen.stealth;
   foe.pos.x = r * 0.8;
   w._updateSpotting();
   assert.ok(w.player.detected && !w.player.esmSeen);
   assert.ok(w.player.useConsumable(w, 'jammer'));
   w.update(1 / 60);
   w._updateSpotting();
   assert.ok(w.player.jamming);
   assert.ok(!w.player.detected, 'inside the jammed range');
   assert.ok(w.player.esmSeen, 'the jammer is an emitter');
});

test('submarines: no radar contact below the surface', () => {
   const w = emptySea({ ship: 'Sachsen' });
   const sub = put(w, 'Kilo', 'enemy', 6000, 0, 0, { ...still, depth: 1 });
   w._updateSpotting();
   assert.ok(!sub.detected);
   assert.ok(!sub.radarOn, 'boats start silent');
});
