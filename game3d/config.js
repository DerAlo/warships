// game3d/config.js — WoWs-scale tuning for the 3D mode: world constants, ship classes,
// consumables, difficulty. 1 unit = 1 m. Speeds are data in knots; the sim moves ships at
// kn * WORLD.KN_TO_MS m/s (~5x real time, WoWs-style compression).
import { DEG } from './utils.js';

export const WORLD = {
   KN_TO_MS: 2.6,            // sim m/s per knot (real is 0.514 -> ~5x time compression)
   SIM_DT: 1 / 60,
   ARENA: 12000,             // default half-extent (m); missions set their own
   DRAG_K: 0.9,              // ballistic drag: t(R) = (e^(K*R/Rmax) - 1) / (K/Rmax * v)
   FUSE_TRAVEL: 14,          // m an armed AP shell travels before detonating (overpen if the hull is thinner)
   FUSE_DIV: 6,              // AP fuse arms on plates >= caliber / 6
   OVERMATCH: 14.3,          // caliber > 14.3 x plate -> no ricochet
   BLOOM_TIME: 20,           // s of raised detectability after firing the main battery
   PROXIMITY: 2000,          // m: always spotted this close (through smoke and islands)
   SPOT_DT: 0.25,            // spotting recompute interval
   SMOKE_RADIUS: 450,        // m per smoke puff
   SMOKE_LIFE: 60,           // s a puff lingers once laid
   SMOKE_DURATION: 20,       // legacy (old main3d F key): emission time
   SMOKE_CD: 120,            // legacy
   FIRE_MAX: 4,              // fire zones (bow, fore-mid, aft-mid, stern)
   FIRE_DPS: 0.003,          // fraction of max HP per second per fire
   FLOOD_MAX: 2,
   FLOOD_DPS: 0.005,
   SINK_TIME: 16,            // s the sinking animation lasts before the wreck is removed
   MIN_THROTTLE: 0.35,       // legacy throttle floor (old main3d)
   ALIGN_TOL: 1.5 * DEG,     // turret counts as aligned within this
   FIRE_TOL: 2.5 * DEG,      // fireMain accepts a turret this close to its firing solution
   AMMO_SWITCH: 0.5,         // switching AP/HE: guns reload with max(current, 50% of reload)
   HIT_POOL: { pen: 0.5, citadel: 0.1, he: 0.5, sec: 0.5, fire: 1, flood: 1, torp: 0.33, overpen: 0.5 }, // repair-party regen share
   // throttle fraction per telegraph position (-1 reverse .. 4 full ahead)
   TELEGRAPH: { '-1': -0.3, 0: 0, 1: 0.25, 2: 0.5, 3: 0.75, 4: 1 },
};

// Consumable catalogue: display name/icon; per-ship charges/durations live in SHIPS[].consumables.
export const CONSUMABLES = {
   damageControl: { name: 'Schadensbekämpfung', short: 'DC', icon: '🧯' },
   repair: { name: 'Reparaturtrupp', short: 'Rep', icon: '🔧' },
   smoke: { name: 'Nebelwand', short: 'Nebel', icon: '🌫️' },
   boost: { name: 'Maschinenüberlast', short: 'Boost', icon: '⚡' },
   hydro: { name: 'Hydrophon', short: 'Hydro', icon: '👂' },
   radar: { name: 'Funkmessortung', short: 'Radar', icon: '📡' },
};

export const CLASS_NAMES = { BB: 'Schlachtschiff', CA: 'Schwerer Kreuzer', CL: 'Leichter Kreuzer', DD: 'Zerstörer', TR: 'Transporter', CV: 'Flugzeugträger' };
export const NATION_NAMES = { de: 'Kriegsmarine', uk: 'Royal Navy' };
const NATION_COLOR = { de: 0x6c7781, uk: 0x8b939b, tr: 0x5d5348 };

// ---- builders (keep the ship table readable) ----
// Turret at x metres from midships (+ = bow). Fore turrets sweep +-arcW around the bow,
// aft turrets around the stern; the dead zone is the superstructure behind them.
const T = (x, guns, aft = false, arcW = 150) => ({ off: { x, y: 0 }, guns, arcC: aft ? Math.PI : 0, arcW: arcW * DEG });
const L = (x, side, tubes) => ({ off: { x, y: 0 }, side, tubes });
const C = (key, o = {}) => ({ key, ...o });

function ship(def) {
   const h = def.hull;
   h.color = h.color ?? NATION_COLOR[h.type === 'TR' ? 'tr' : h.nation];
   const m = def.main;
   if (m) {
      // Game muzzle velocity derived from the max-range flight time, so tMax is the tunable.
      const K = WORLD.DRAG_K;
      m.vShell = m.range * (Math.exp(K) - 1) / (K * m.tMax);
      m.guns = m.turrets.reduce((a, t) => a + t.guns, 0);
      m.traverseRad = m.traverse * DEG;
      m.fallMaxRad = (m.fallMax || 28) * DEG;
      m.vRatio = m.vRatio ?? 0.55;
      if (m.ap) { m.ap.ricochet = m.ap.ricochet || [45, 60]; m.ap.fuse = m.ap.fuse ?? WORLD.FUSE_TRAVEL; }
      // legacy aliases (old HUD / main3d read these)
      m.dmg = (m.he || m.ap).dmg; m.type = m.he ? 'HE' : 'AP'; m.ap_ = m.ap;
   }
   if (def.sec) {
      const s = def.sec, K = WORLD.DRAG_K;
      s.vShell = s.range * (Math.exp(K) - 1) / (K * (s.tMax || 3.5));
      s.fallMaxRad = (s.fallMax || 14) * DEG;
      s.vRatio = s.vRatio ?? 0.6;
      s.dmg = s.he.dmg; s.type = 'HE';
   }
   if (def.torp) {
      const t = def.torp;
      t.speed = t.speedKn * WORLD.KN_TO_MS;
      t.tubes = t.launchers.reduce((a, l) => a + l.tubes, 0);
      t.cd = t.reload;            // legacy HUD alias
      t.detect = t.detect || 1300;
   }
   def.consumables = def.consumables || [];
   const boost = def.consumables.find(c => c.key === 'boost');
   if (boost) def.boost = { mult: boost.mult, dur: boost.dur, cd: boost.cd }; // legacy HUD "Turbo"
   def.maxSpeed = def.speedKn * WORLD.KN_TO_MS;   // legacy (m/s)
   def.detect = def.detect;
   def.color = h.color;
   return def;
}

// ---- ship classes ----
// Values follow WoWs where it has them (HP, reload, ranges, detectability, consumables),
// real ship data otherwise (dimensions, turret layout, calibre, speed). dispH = max horizontal
// dispersion (m) at max range; tMax = shell flight time (s) at max range.
export const SHIPS = {
   // ============ Kriegsmarine (playable) ============
   Bismarck: ship({
      key: 'Bismarck', name: 'Bismarck', className: 'Bismarck-Klasse', playable: true,
      hull: { type: 'BB', L: 251, beam: 36, draft: 9.3, deckH: 15, nation: 'de',
         sup: { x: -8, len: 70, w: 22, h: 26 }, funnels: [{ x: -14, r: 6.5, h: 18 }] },
      hp: 69600, speedKn: 30.8, accel: 26, turnR: 880, rudderShift: 14.6,
      detect: { surface: 15800, fire: 19500, smokeFire: 13300, torp: 1200 },
      armor: { belt: 320, deck: 50, ends: 32, sup: 20, cit: 110, citLen: 0.56, tds: 0.36 },
      main: {
         caliber: 380, turrets: [T(82, 2), T(60, 2), T(-57, 2, true), T(-79, 2, true)],
         traverse: 5, reload: 26, range: 21200, tMax: 10.5, fallMax: 30, dispH: 250, vRatio: 0.6, sigma: 1.8,
         ap: { dmg: 11600, pen: 740 }, he: { dmg: 5700, pen: 63, fire: 0.36 },
      },
      sec: { caliber: 150, guns: 12, range: 7600, reload: 7.5, tMax: 3.6, dispH: 140, sigma: 1.0, he: { dmg: 1700, pen: 38, fire: 0.08 } },
      aa: { range: 5000, reload: 0.5 },
      torp: null,
      consumables: [
         C('damageControl', { charges: Infinity, dur: 15, cd: 80 }),
         C('repair', { charges: 4, dur: 28, cd: 80, heal: 0.005 }),
         C('hydro', { charges: 3, dur: 100, cd: 120, range: 6000, torpRange: 3500 }),
         C('boost', { charges: 3, dur: 60, cd: 120, mult: 1.08 }),
      ],
      ai: { prefRange: [11500, 16000], role: 'bb', value: 60 },
   }),
   Hipper: ship({
      key: 'Hipper', name: 'Admiral Hipper', className: 'Admiral-Hipper-Klasse', playable: true,
      hull: { type: 'CA', L: 203, beam: 21.3, draft: 7.2, deckH: 10, nation: 'de',
         sup: { x: 4, len: 52, w: 14, h: 20 }, funnels: [{ x: -6, r: 5, h: 14 }] },
      hp: 40400, speedKn: 32.5, accel: 18, turnR: 770, rudderShift: 8.8,
      detect: { surface: 12400, fire: 15300, smokeFire: 7500, torp: 1300 },
      armor: { belt: 80, deck: 30, ends: 25, sup: 16, cit: 30, citLen: 0.52, tds: 0.2 },
      main: {
         caliber: 203, turrets: [T(62, 2), T(46, 2), T(-44, 2, true), T(-60, 2, true)],
         traverse: 8, reload: 10.5, range: 15900, tMax: 8.5, fallMax: 26, dispH: 150, vRatio: 0.5, sigma: 2.05,
         ap: { dmg: 5000, pen: 350 }, he: { dmg: 2500, pen: 51, fire: 0.17 },
      },
      sec: { caliber: 105, guns: 12, range: 6000, reload: 3.4, tMax: 3.2, dispH: 130, sigma: 1.0, he: { dmg: 1200, pen: 26, fire: 0.05 } },
      aa: { range: 4500, reload: 0.5 },
      torp: { launchers: [L(-8, 'port', 3), L(-8, 'stbd', 3), L(-20, 'port', 3), L(-20, 'stbd', 3)], range: 6000, speedKn: 76, dmg: 13700, flood: 0.2, reload: 90 },
      consumables: [
         C('damageControl', { charges: Infinity, dur: 10, cd: 60 }),
         C('repair', { charges: 3, dur: 20, cd: 80, heal: 0.005 }),
         C('hydro', { charges: 3, dur: 100, cd: 120, range: 5000, torpRange: 3500 }),
      ],
      ai: { prefRange: [9500, 13500], role: 'ca', value: 45 },
   }),
   Nuernberg: ship({
      key: 'Nuernberg', name: 'Nürnberg', className: 'Leipzig-Klasse', playable: true,
      hull: { type: 'CL', L: 181, beam: 16.4, draft: 5.8, deckH: 9, nation: 'de',
         sup: { x: 10, len: 40, w: 11, h: 17 }, funnels: [{ x: -4, r: 4.2, h: 12 }] },
      hp: 30000, speedKn: 32, accel: 15, turnR: 640, rudderShift: 7.6,
      detect: { surface: 10800, fire: 13600, smokeFire: 6200, torp: 1300 },
      armor: { belt: 50, deck: 20, ends: 16, sup: 10, cit: 20, citLen: 0.5, tds: 0.1 },
      main: {
         caliber: 150, turrets: [T(52, 3), T(-38, 3, true), T(-54, 3, true)],
         traverse: 10, reload: 7.5, range: 14300, tMax: 7.5, fallMax: 24, dispH: 135, vRatio: 0.45, sigma: 2.0,
         ap: { dmg: 3300, pen: 190 }, he: { dmg: 2200, pen: 38, fire: 0.09 },
      },
      sec: { caliber: 88, guns: 8, range: 5000, reload: 3, tMax: 3, dispH: 120, sigma: 1.0, he: { dmg: 900, pen: 22, fire: 0.04 } },
      aa: { range: 4000, reload: 0.5 },
      torp: { launchers: [L(-2, 'port', 3), L(-2, 'stbd', 3)], range: 8000, speedKn: 64, dmg: 12000, flood: 0.2, reload: 70 },
      consumables: [
         C('damageControl', { charges: Infinity, dur: 10, cd: 60 }),
         C('repair', { charges: 2, dur: 20, cd: 80, heal: 0.005 }),
         C('hydro', { charges: 3, dur: 100, cd: 120, range: 5000, torpRange: 3500 }),
         C('radar', { charges: 2, dur: 25, cd: 120, range: 9000 }),
      ],
      ai: { prefRange: [8500, 12000], role: 'cl', value: 40 },
   }),
   Z23: ship({
      key: 'Z23', name: 'Z 23', className: 'Zerstörer 1936A (Narvik)', playable: true,
      hull: { type: 'DD', L: 127, beam: 12, draft: 4.6, deckH: 6.5, nation: 'de',
         sup: { x: 20, len: 20, w: 8, h: 12 }, funnels: [{ x: 4, r: 2.8, h: 9 }, { x: -12, r: 2.8, h: 9 }] },
      hp: 17500, speedKn: 36.5, accel: 10, turnR: 640, rudderShift: 4.9,
      detect: { surface: 7500, fire: 9800, smokeFire: 2800, torp: 1500 },
      armor: { belt: 15, deck: 15, ends: 13, sup: 10, cit: 0, citLen: 0, tds: 0 },
      main: {
         caliber: 150, turrets: [T(45, 2), T(-30, 1, true), T(-42, 1, true), T(-52, 1, true)],
         traverse: 18, reload: 7.5, range: 12000, tMax: 6.5, fallMax: 20, dispH: 110, vRatio: 0.45, sigma: 2.0,
         ap: { dmg: 3200, pen: 190 }, he: { dmg: 2100, pen: 38, fire: 0.09 },
      },
      sec: null,
      aa: { range: 3500, reload: 0.5 },
      torp: { launchers: [L(-4, 'both', 4), L(-24, 'both', 4)], range: 10000, speedKn: 64, dmg: 14400, flood: 0.28, reload: 80 },
      consumables: [
         C('damageControl', { charges: Infinity, dur: 10, cd: 40 }),
         C('smoke', { charges: 3, dur: 20, cd: 160, radius: 450, life: 60 }),
         C('boost', { charges: 3, dur: 120, cd: 180, mult: 1.08 }),
         C('hydro', { charges: 2, dur: 100, cd: 120, range: 4200, torpRange: 2700 }),
      ],
      ai: { prefRange: [6500, 9500], role: 'dd', value: 35 },
   }),
   // ============ Kriegsmarine (AI-only) ============
   Scharnhorst: ship({
      key: 'Scharnhorst', name: 'Scharnhorst', className: 'Scharnhorst-Klasse', playable: false,
      hull: { type: 'BB', L: 235, beam: 30, draft: 9.7, deckH: 13, nation: 'de',
         sup: { x: 0, len: 62, w: 18, h: 24 }, funnels: [{ x: -8, r: 6, h: 16 }] },
      hp: 58000, speedKn: 32, accel: 22, turnR: 740, rudderShift: 12.6,
      detect: { surface: 14800, fire: 17600, smokeFire: 11500, torp: 1300 },
      armor: { belt: 350, deck: 50, ends: 32, sup: 20, cit: 105, citLen: 0.55, tds: 0.3 },
      main: {
         caliber: 283, turrets: [T(72, 3), T(52, 3), T(-62, 3, true)],
         traverse: 7.5, reload: 17, range: 17500, tMax: 9, fallMax: 28, dispH: 220, vRatio: 0.6, sigma: 1.8,
         ap: { dmg: 7950, pen: 540 }, he: { dmg: 3500, pen: 47, fire: 0.22 },
      },
      sec: { caliber: 150, guns: 12, range: 7000, reload: 7.5, tMax: 3.6, dispH: 140, sigma: 1.0, he: { dmg: 1700, pen: 38, fire: 0.08 } },
      aa: { range: 4500, reload: 0.5 },
      torp: null,
      consumables: [
         C('damageControl', { charges: Infinity, dur: 15, cd: 80 }),
         C('repair', { charges: 4, dur: 28, cd: 80, heal: 0.005 }),
         C('boost', { charges: 3, dur: 60, cd: 120, mult: 1.08 }),
      ],
      ai: { prefRange: [10500, 14500], role: 'bb', value: 55 },
   }),
   // ============ Royal Navy ============
   Hood: ship({
      key: 'Hood', name: 'HMS Hood', className: 'Admiral-Klasse (Schlachtkreuzer)', playable: false,
      hull: { type: 'BB', L: 262, beam: 31.8, draft: 9.8, deckH: 14, nation: 'uk',
         sup: { x: 6, len: 72, w: 18, h: 26 }, funnels: [{ x: 10, r: 5.5, h: 16 }, { x: -12, r: 5.5, h: 16 }] },
      hp: 67000, speedKn: 31, accel: 26, turnR: 950, rudderShift: 15,
      detect: { surface: 16400, fire: 18700, smokeFire: 13000, torp: 1300 },
      armor: { belt: 305, deck: 38, ends: 25, sup: 19, cit: 0, citLen: 0.6, tds: 0.25 },
      main: {
         caliber: 381, turrets: [T(80, 2), T(62, 2), T(-62, 2, true), T(-82, 2, true)],
         traverse: 5, reload: 28, range: 18700, tMax: 10, fallMax: 32, dispH: 230, vRatio: 0.6, sigma: 1.8,
         ap: { dmg: 12000, pen: 700 }, he: { dmg: 4800, pen: 64, fire: 0.33 },
      },
      sec: { caliber: 102, guns: 14, range: 5500, reload: 3.5, tMax: 3, dispH: 130, sigma: 1.0, he: { dmg: 1500, pen: 17, fire: 0.06 } },
      aa: { range: 5000, reload: 0.5 },
      torp: null,
      consumables: [
         C('damageControl', { charges: Infinity, dur: 15, cd: 80 }),
         C('repair', { charges: 4, dur: 28, cd: 80, heal: 0.005 }),
      ],
      ai: { prefRange: [11000, 15500], role: 'bb', value: 60 },
   }),
   KGV: ship({
      key: 'KGV', name: 'King George V', className: 'King-George-V-Klasse', playable: false,
      hull: { type: 'BB', L: 227, beam: 31.4, draft: 9.9, deckH: 13, nation: 'uk',
         sup: { x: 2, len: 64, w: 18, h: 25 }, funnels: [{ x: 8, r: 5, h: 14 }, { x: -12, r: 5, h: 14 }] },
      hp: 63700, speedKn: 28, accel: 25, turnR: 800, rudderShift: 13.9,
      detect: { surface: 14800, fire: 17800, smokeFire: 11000, torp: 1300 },
      armor: { belt: 374, deck: 127, ends: 25, sup: 19, cit: 0, citLen: 0.55, tds: 0.34 },
      main: {
         caliber: 356, turrets: [T(66, 4), T(48, 2), T(-66, 4, true)],
         traverse: 4.5, reload: 26, range: 17800, tMax: 10, fallMax: 30, dispH: 230, vRatio: 0.6, sigma: 1.8,
         ap: { dmg: 10500, pen: 590 }, he: { dmg: 5000, pen: 58, fire: 0.33 },
      },
      sec: { caliber: 133, guns: 16, range: 5800, reload: 6, tMax: 3.2, dispH: 130, sigma: 1.0, he: { dmg: 1900, pen: 22, fire: 0.08 } },
      aa: { range: 5000, reload: 0.5 },
      torp: null,
      consumables: [
         C('damageControl', { charges: Infinity, dur: 15, cd: 80 }),
         C('repair', { charges: 4, dur: 28, cd: 80, heal: 0.006 }),
      ],
      ai: { prefRange: [10500, 15000], role: 'bb', value: 60 },
   }),
   Rodney: ship({
      key: 'Rodney', name: 'HMS Rodney', className: 'Nelson-Klasse', playable: false,
      hull: { type: 'BB', L: 216, beam: 32.3, draft: 9.6, deckH: 14, nation: 'uk',
         sup: { x: -22, len: 50, w: 20, h: 30 }, funnels: [{ x: -40, r: 5.5, h: 14 }] },
      hp: 70000, speedKn: 23.8, accel: 28, turnR: 780, rudderShift: 15.3,
      detect: { surface: 15600, fire: 18000, smokeFire: 12500, torp: 1300 },
      armor: { belt: 356, deck: 152, ends: 25, sup: 19, cit: 0, citLen: 0.5, tds: 0.3 },
      // all three triple turrets forward of the bridge -- X turret cannot fire aft past it
      main: {
         caliber: 406, turrets: [T(72, 3, false, 150), T(54, 3, false, 150), T(34, 3, false, 138)],
         traverse: 4, reload: 30, range: 19100, tMax: 10.5, fallMax: 30, dispH: 260, vRatio: 0.55, sigma: 1.9,
         ap: { dmg: 13500, pen: 800 }, he: { dmg: 5850, pen: 68, fire: 0.35 },
      },
      sec: { caliber: 152, guns: 12, range: 6000, reload: 7.5, tMax: 3.4, dispH: 140, sigma: 1.0, he: { dmg: 2100, pen: 25, fire: 0.09 } },
      aa: { range: 5000, reload: 0.5 },
      torp: null,
      consumables: [
         C('damageControl', { charges: Infinity, dur: 15, cd: 80 }),
         C('repair', { charges: 4, dur: 28, cd: 80, heal: 0.005 }),
      ],
      ai: { prefRange: [11000, 16000], role: 'bb', value: 60 },
   }),
   Norfolk: ship({
      key: 'Norfolk', name: 'HMS Norfolk', className: 'County-Klasse', playable: false,
      hull: { type: 'CA', L: 193, beam: 20, draft: 6.2, deckH: 10, nation: 'uk',
         sup: { x: 12, len: 50, w: 13, h: 18 }, funnels: [{ x: 16, r: 3.6, h: 14 }, { x: 2, r: 3.6, h: 14 }, { x: -12, r: 3.6, h: 14 }] },
      hp: 38000, speedKn: 32.3, accel: 18, turnR: 800, rudderShift: 9.8,
      detect: { surface: 12200, fire: 15000, smokeFire: 7000, torp: 1300 },
      armor: { belt: 25, deck: 25, ends: 25, sup: 13, cit: 114, citLen: 0.45, tds: 0.08 },
      main: {
         caliber: 203, turrets: [T(56, 2), T(42, 2), T(-46, 2, true), T(-60, 2, true)],
         traverse: 6, reload: 12, range: 15300, tMax: 8.5, fallMax: 26, dispH: 160, vRatio: 0.5, sigma: 2.0,
         ap: { dmg: 4800, pen: 320 }, he: { dmg: 2800, pen: 34, fire: 0.15 },
      },
      sec: { caliber: 102, guns: 8, range: 5000, reload: 3.5, tMax: 3, dispH: 130, sigma: 1.0, he: { dmg: 1500, pen: 17, fire: 0.06 } },
      aa: { range: 4500, reload: 0.5 },
      torp: { launchers: [L(-10, 'port', 4), L(-10, 'stbd', 4)], range: 10000, speedKn: 62, dmg: 13000, flood: 0.24, reload: 80 },
      consumables: [
         C('damageControl', { charges: Infinity, dur: 10, cd: 60 }),
         C('repair', { charges: 2, dur: 20, cd: 80, heal: 0.005 }),
         C('radar', { charges: 2, dur: 30, cd: 120, range: 10000 }),
      ],
      ai: { prefRange: [10000, 13500], role: 'ca', value: 45 },
   }),
   Fiji: ship({
      key: 'Fiji', name: 'HMS Fiji', className: 'Crown-Colony-Klasse', playable: false,
      hull: { type: 'CL', L: 169, beam: 18.9, draft: 5, deckH: 9, nation: 'uk',
         sup: { x: 12, len: 38, w: 12, h: 17 }, funnels: [{ x: 8, r: 3.8, h: 11 }, { x: -12, r: 3.8, h: 11 }] },
      hp: 31000, speedKn: 32.3, accel: 15, turnR: 680, rudderShift: 8.3,
      detect: { surface: 10300, fire: 13900, smokeFire: 5300, torp: 1300 },
      armor: { belt: 83, deck: 51, ends: 16, sup: 10, cit: 0, citLen: 0.45, tds: 0.1 },
      // Royal Navy light cruisers: AP only, short fuse (few overpens), smoke + big heal
      main: {
         caliber: 152, turrets: [T(46, 3), T(32, 3), T(-40, 3, true), T(-54, 3, true)],
         traverse: 8, reload: 7.5, range: 13900, tMax: 7.5, fallMax: 24, dispH: 140, vRatio: 0.45, sigma: 2.0,
         ap: { dmg: 3100, pen: 190, fuse: 7 }, he: null,
      },
      sec: { caliber: 102, guns: 8, range: 5000, reload: 3.5, tMax: 3, dispH: 130, sigma: 1.0, he: { dmg: 1500, pen: 17, fire: 0.06 } },
      aa: { range: 4500, reload: 0.5 },
      torp: { launchers: [L(-6, 'port', 3), L(-6, 'stbd', 3)], range: 10000, speedKn: 62, dmg: 13000, flood: 0.24, reload: 70 },
      consumables: [
         C('damageControl', { charges: Infinity, dur: 10, cd: 60 }),
         C('smoke', { charges: 3, dur: 12, cd: 120, radius: 420, life: 25 }),
         C('repair', { charges: 3, dur: 20, cd: 80, heal: 0.0099 }),
         C('radar', { charges: 2, dur: 25, cd: 120, range: 9000 }),
      ],
      ai: { prefRange: [8000, 11500], role: 'cl', value: 40 },
   }),
   Jervis: ship({
      key: 'Jervis', name: 'HMS Jervis', className: 'J-Klasse', playable: false,
      hull: { type: 'DD', L: 108, beam: 10.9, draft: 3.7, deckH: 5.5, nation: 'uk',
         sup: { x: 18, len: 16, w: 7, h: 10 }, funnels: [{ x: 0, r: 2.8, h: 8 }] },
      hp: 15000, speedKn: 36, accel: 9, turnR: 590, rudderShift: 4.3,
      detect: { surface: 6800, fire: 8900, smokeFire: 2300, torp: 1400 },
      armor: { belt: 13, deck: 13, ends: 13, sup: 10, cit: 0, citLen: 0, tds: 0 },
      main: {
         caliber: 120, turrets: [T(36, 2), T(26, 2), T(-36, 2, true)],
         traverse: 20, reload: 4.8, range: 11000, tMax: 6, fallMax: 18, dispH: 110, vRatio: 0.45, sigma: 2.0,
         ap: { dmg: 2100, pen: 140 }, he: { dmg: 1700, pen: 20, fire: 0.07 },
      },
      sec: null,
      aa: { range: 3500, reload: 0.5 },
      torp: { launchers: [L(-2, 'both', 5), L(-22, 'both', 5)], range: 10000, speedKn: 62, dmg: 13000, flood: 0.25, reload: 72 },
      consumables: [
         C('damageControl', { charges: Infinity, dur: 10, cd: 40 }),
         C('smoke', { charges: 3, dur: 20, cd: 160, radius: 450, life: 60 }),
         C('boost', { charges: 2, dur: 120, cd: 180, mult: 1.08 }),
      ],
      ai: { prefRange: [6000, 9000], role: 'dd', value: 35 },
   }),
   Transport: ship({
      key: 'Transport', name: 'Frachter', className: 'Geleitzug-Frachter', playable: false,
      hull: { type: 'TR', L: 135, beam: 18, draft: 7.5, deckH: 9, nation: 'uk',
         sup: { x: -30, len: 24, w: 14, h: 14 }, funnels: [{ x: -34, r: 3.2, h: 10 }] },
      hp: 16000, speedKn: 11, accel: 30, turnR: 700, rudderShift: 12,
      detect: { surface: 9500, fire: 9500, smokeFire: 5000, torp: 1000 },
      armor: { belt: 10, deck: 10, ends: 10, sup: 6, cit: 0, citLen: 0, tds: 0 },
      main: {
         caliber: 102, turrets: [T(-58, 1, true, 160)],
         traverse: 12, reload: 8, range: 7000, tMax: 5, fallMax: 16, dispH: 140, vRatio: 0.5, sigma: 1.6,
         ap: { dmg: 1500, pen: 60 }, he: { dmg: 1500, pen: 17, fire: 0.05 },
      },
      sec: null, aa: null, torp: null,
      consumables: [],
      ai: { prefRange: [0, 0], role: 'tr', value: 30 },
   }),
};

// Player-selectable classes, in menu order.
export const PLAYABLE = ['Bismarck', 'Hipper', 'Nuernberg', 'Z23'];

export const DIFFICULTY = {
   easy: { key: 'easy', label: 'Leicht', botHP: 0.8, botDmg: 0.7, aimErr: 0.022, lead: 0.62, reaction: 2.6, dodge: 0.25, smarts: 0.5, rewardMult: 0.8 },
   normal: { key: 'normal', label: 'Normal', botHP: 1, botDmg: 1, aimErr: 0.013, lead: 0.82, reaction: 1.5, dodge: 0.55, smarts: 0.8, rewardMult: 1 },
   hard: { key: 'hard', label: 'Schwer', botHP: 1.15, botDmg: 1.2, aimErr: 0.007, lead: 0.93, reaction: 0.8, dodge: 0.85, smarts: 1, rewardMult: 1.3 },
};

export const TUNE = { maxShells: 900, maxEffects: 500, maxEvents: 256, maxLog: 60 };

// Per-class display stats for the ship picker (menu3d.js). Ratings are 0..100 relative to the
// playable line-up so the menu can draw bars without knowing the raw numbers.
export function shipStats(key) {
   const c = SHIPS[key];
   if (!c) return null;
   const m = c.main, t = c.torp;
   const layout = {};
   for (const tr of m.turrets) layout[tr.guns] = (layout[tr.guns] || 0) + 1;
   const salvo = m.guns * (m.ap || m.he).dmg;
   const rate = (x, lo, hi) => Math.round(Math.max(0, Math.min(1, (x - lo) / (hi - lo))) * 100);
   return {
      key, name: c.name, className: c.className, type: c.hull.type, typeName: CLASS_NAMES[c.hull.type],
      nation: c.hull.nation, nationName: NATION_NAMES[c.hull.nation] || '',
      hp: c.hp, speedKn: c.speedKn, lengthM: c.hull.L, beamM: c.hull.beam,
      main: Object.entries(layout).map(([g, n]) => n + '×' + g).join(' + ') + ' · ' + m.caliber + ' mm',
      mainGuns: m.guns, caliber: m.caliber, reload: m.reload, rangeKm: +(m.range / 1000).toFixed(1),
      traverse180: Math.round(180 / m.traverse), apDmg: m.ap ? m.ap.dmg : 0, heDmg: m.he ? m.he.dmg : 0,
      secRangeKm: c.sec ? +(c.sec.range / 1000).toFixed(1) : 0,
      torp: t ? { tubes: t.tubes, launchers: t.launchers.length, rangeKm: +(t.range / 1000).toFixed(1), speedKn: t.speedKn, dmg: t.dmg, reload: t.reload } : null,
      detectKm: +(c.detect.surface / 1000).toFixed(1), belt: c.armor.belt,
      consumables: c.consumables.map(k => CONSUMABLES[k.key].name),
      ratings: {
         firepower: Math.round((rate(salvo * 60 / m.reload, 20000, 280000) + rate(salvo, 5000, 95000)) / 2),
         survivability: rate(c.hp * (1 + c.armor.belt / 400), 15000, 110000),
         mobility: rate(c.speedKn * 1000 / c.turnR, 25, 60),
         concealment: rate(-c.detect.surface, -16500, -7000),
         torpedoes: t ? rate(t.tubes * t.dmg * 60 / t.reload, 0, 100000) : 0,
      },
   };
}
export const SHIP_STATS = Object.fromEntries(Object.keys(SHIPS).map(k => [k, shipStats(k)]));
