// gamev2/config.js — tuning for the modern mode (V2): world constants, the missile / SAM / CIWS
// catalogue, the ship roster, consumables, difficulty. 1 unit = 1 m. Speeds are data in knots; the
// sim moves ships at kn * WORLD.KN_TO_MS m/s (~5x real time). Ranges are scaled to the arena, not
// to reality; only the ratios are kept:  gun < point SAM < area SAM < SSM < cruise missile.
//
// What a renderer / HUD / net agent reads from a class config (SHIPS[key], ship.cfg):
//    hull.type   'FAC' | 'CO' | 'FF' | 'DD' | 'CG' | 'CV' | 'SS' | 'TR'      (CLASS_NAMES)
//    model       key of the 3D model (ships3d.js dispatches on it)
//    bloc        'west' | 'east' | 'neutral'
//    stealth     radar cross-section factor: an enemy radar reaches radar.range * stealth
//    radar       { range, horizon, air } m: surface search / sea-skimmer horizon / air search
//    weapons     { ssm: [{type, n}], cruise: {type, n}|null, sam: [{type, n, ch}], ciws: {type, n}|null,
//                  rockets: {...}|null, asw: {...}|null, cells }     (types are keys of MISSILES / CIWS)
//    helo        { name, ... } | null   (consumable 'helo');   sonar { hull, towed } m
//    sub.seal    the boat carries a SEAL team (seal.js)
// The live counts are on the ship: ship.mag[type] (missile.js).
import { DEG } from './utils.js';

export const WORLD = {
   KN_TO_MS: 2.6,            // sim m/s per knot (real is 0.514 -> ~5x time compression)
   SIM_DT: 1 / 60,
   ARENA: 12000,             // default half-extent (m); missions set their own
   DRAG_K: 0.9,              // ballistic drag: t(R) = (e^(K*R/Rmax) - 1) / (K/Rmax * v)
   FUSE_TRAVEL: 14,          // m an armed AP shell travels before detonating (overpen if the hull is thinner)
   FUSE_DIV: 6,              // AP fuse arms on plates >= caliber / 6
   OVERMATCH: 14.3,          // caliber > 14.3 x plate -> no ricochet
   BLOOM_TIME: 12,           // s of raised detectability after firing guns or launching missiles
   PROXIMITY: 1500,          // m: always spotted this close (through smoke and islands)
   SPOT_DT: 0.25,            // spotting recompute interval
   SMOKE_RADIUS: 450,        // m per smoke puff
   SMOKE_LIFE: 60,           // s a puff lingers once laid
   SMOKE_DURATION: 20,       // legacy
   SMOKE_CD: 120,            // legacy
   FIRE_MAX: 4,              // fire zones (bow, fore-mid, aft-mid, stern)
   FIRE_DPS: 0.003,          // fraction of max HP per second per fire
   FLOOD_MAX: 2,
   FLOOD_DPS: 0.005,
   SINK_TIME: 16,            // s the sinking animation lasts before the wreck is removed
   MIN_THROTTLE: 0.35,       // legacy throttle floor
   ALIGN_TOL: 1.5 * DEG,     // turret counts as aligned within this
   FIRE_TOL: 2.5 * DEG,      // fireMain accepts a turret this close to its firing solution
   AMMO_SWITCH: 0.5,         // switching AP/HE: guns reload with max(current, 50% of reload)
   HIT_POOL: { pen: 0.5, citadel: 0.1, he: 0.5, sec: 0.5, fire: 1, flood: 1, torp: 0.33, overpen: 0.5, ssm: 0.3, cruise: 0.3, rocket: 0.5 }, // repair regen share
   // throttle fraction per telegraph position (-1 reverse .. 4 full ahead)
   TELEGRAPH: { '-1': -0.3, 0: 0, 1: 0.25, 2: 0.5, 3: 0.75, 4: 1 },
};

// ---------------------------------------------------------------- sensors (sensors.js)
export const SENSOR = {
   ESM: 1.5,                 // an emitter is heard at this multiple of its own radar range
   ESM_ERR: 0.09,            // position error of a single ESM bearing fix, as a share of the distance
   ESM_KEEP: 12,             // s an ESM contact stays on the plot after the emitter went silent
   FC: 0.8,                  // inside this share of the radar detection range a track is fire-control quality
   VISUAL_MISSILE: 2500,     // m: a missile is seen by eye (and by a silent ship's optics) this close
   JAM_RADAR: 0.6,           // an active jammer shortens enemy radar ranges against ships near it ...
   JAM_SEEKER: 0.5,          // ... and enemy seeker ranges
   JAM_R: 3500,              // m around the jamming ship that is covered
   DECOY_LIFE: 14,           // s a chaff cloud is a valid seeker target
   SEEKER_ESM: 9000,         // m: an active radar seeker is heard by ESM this far (warning, bearing)
};

// ---------------------------------------------------------------- missiles (missile.js)
//  ssm     speed m/s, range m, dmg, seeker m (lock-on range of the terminal seeker), cone (half angle),
//          evade: factor on every defender's kill probability (supersonic and stealthy missiles are
//          hard to stop), skim: sea-skimmer (seen only inside the radar horizon, cannot cross land),
//          sprint: { at, speed } terminal sprint, passive: IR seeker (silent, harder to seduce)
//  cruise  land attack: flies over islands at alt, targets a map point (site or anchored ship)
//  sam     cls 'area' | 'point', range m against missiles, air m against aircraft, pk per shot at
//          mid range, passive: IR homing (may fire with the radar off at what the eye sees)
//  aam     fighters against aircraft
export const MISSILES = {
   // --- anti-ship, subsonic
   harpoon: { kind: 'ssm', name: 'Harpoon', speed: 560, range: 24000, dmg: 5200, seeker: 4500, cone: 22 * DEG, evade: 1, skim: true },
   rbs15: { kind: 'ssm', name: 'RBS15 Mk3', speed: 550, range: 26000, dmg: 4800, seeker: 4500, cone: 24 * DEG, evade: 0.92, skim: true },
   nsm: { kind: 'ssm', name: 'NSM', speed: 560, range: 22000, dmg: 3600, seeker: 4200, cone: 26 * DEG, evade: 0.8, skim: true, passive: true },
   yj83: { kind: 'ssm', name: 'YJ-83', speed: 550, range: 21000, dmg: 4300, seeker: 4200, cone: 22 * DEG, evade: 1, skim: true },
   noor: { kind: 'ssm', name: 'Noor', speed: 520, range: 18000, dmg: 4000, seeker: 3800, cone: 20 * DEG, evade: 1.05, skim: true },
   kh35: { kind: 'ssm', name: 'Ch-35', speed: 540, range: 20000, dmg: 4200, seeker: 4000, cone: 22 * DEG, evade: 1, skim: true },
   kowsar: { kind: 'ssm', name: 'Kowsar', speed: 480, range: 7500, dmg: 1500, seeker: 2600, cone: 20 * DEG, evade: 1.05, skim: true },
   // --- anti-ship, supersonic
   oniks: { kind: 'ssm', name: 'P-800 Oniks', speed: 940, range: 26000, dmg: 6800, seeker: 5500, cone: 20 * DEG, evade: 0.7, skim: true, supersonic: true },
   vulkan: { kind: 'ssm', name: 'P-1000 Wulkan', speed: 980, range: 30000, dmg: 9800, seeker: 6500, cone: 22 * DEG, evade: 0.7, skim: false, alt: 400, supersonic: true },
   granit: { kind: 'ssm', name: 'P-700 Granit', speed: 960, range: 30000, dmg: 10500, seeker: 6500, cone: 22 * DEG, evade: 0.7, skim: false, alt: 400, supersonic: true },
   yj18: { kind: 'ssm', name: 'YJ-18', speed: 560, range: 26000, dmg: 6000, seeker: 5200, cone: 22 * DEG, evade: 0.75, skim: true, supersonic: true, sprint: { at: 5500, speed: 980 } },
   kalibr: { kind: 'ssm', name: '3M-54 Kalibr', speed: 560, range: 26000, dmg: 5600, seeker: 5000, cone: 22 * DEG, evade: 0.76, skim: true, supersonic: true, sprint: { at: 5000, speed: 940 } },
   // --- land attack
   tomahawk: { kind: 'cruise', name: 'Tomahawk', speed: 520, range: 70000, dmg: 5200, alt: 60, evade: 1.1 },
   kalibrLA: { kind: 'cruise', name: 'Kalibr-NK', speed: 520, range: 70000, dmg: 5200, alt: 60, evade: 1.1 },
   cj10: { kind: 'cruise', name: 'CJ-10', speed: 500, range: 70000, dmg: 5000, alt: 60, evade: 1.1 },
   // --- surface to air, area
   sm2: { kind: 'sam', cls: 'area', name: 'SM-2', speed: 1400, range: 17000, air: 22000, pk: 0.68 },
   aster30: { kind: 'sam', cls: 'area', name: 'Aster 30', speed: 1500, range: 18000, air: 23000, pk: 0.76 },
   s300f: { kind: 'sam', cls: 'area', name: 'S-300F', speed: 1500, range: 18000, air: 23000, pk: 0.62 },
   hq9: { kind: 'sam', cls: 'area', name: 'HQ-9', speed: 1450, range: 17500, air: 22000, pk: 0.65 },
   redut: { kind: 'sam', cls: 'area', name: 'Poliment-Redut', speed: 1450, range: 15000, air: 19000, pk: 0.68 },
   hq16: { kind: 'sam', cls: 'area', name: 'HQ-16', speed: 1300, range: 12500, air: 15000, pk: 0.6 },
   // --- surface to air, point
   essm: { kind: 'sam', cls: 'point', name: 'ESSM', speed: 1300, range: 9500, air: 11000, pk: 0.66 },
   ram: { kind: 'sam', cls: 'point', name: 'RAM', speed: 1100, range: 7000, air: 7000, pk: 0.7, passive: true },
   camm: { kind: 'sam', cls: 'point', name: 'CAMM', speed: 1250, range: 9500, air: 11000, pk: 0.7 },
   hq10: { kind: 'sam', cls: 'point', name: 'HQ-10', speed: 1050, range: 6500, air: 6500, pk: 0.64, passive: true },
   kinzhal: { kind: 'sam', cls: 'point', name: 'Kinschal', speed: 1150, range: 8000, air: 9000, pk: 0.58 },
   osa: { kind: 'sam', cls: 'point', name: 'Osa-MA', speed: 950, range: 7000, air: 8000, pk: 0.45 },
   igla: { kind: 'sam', cls: 'point', name: 'Gibka', speed: 900, range: 4500, air: 4500, pk: 0.4, passive: true },
   sayyad: { kind: 'sam', cls: 'point', name: 'Sayyad-2', speed: 1100, range: 9000, air: 11000, pk: 0.48 },
   // --- air to air
   amraam: { kind: 'aam', name: 'AIM-120', speed: 1300, range: 9000, pk: 0.6 },
   r77: { kind: 'aam', name: 'R-77', speed: 1300, range: 8500, pk: 0.55 },
   pl12: { kind: 'aam', name: 'PL-12', speed: 1300, range: 8500, pk: 0.55 },
};
// Close-in weapon systems: one target at a time per mount. kps = kill chance per second against a
// subsonic missile inside range (supersonic: * CIWS_SUPER); air = dps against aircraft.
export const CIWS = {
   phalanx: { name: 'Phalanx', range: 1800, kps: 0.18 },
   goalkeeper: { name: 'Goalkeeper', range: 2000, kps: 0.20 },
   ak630: { name: 'AK-630', range: 1600, kps: 0.15 },
   kashtan: { name: 'Kaschtan', range: 2400, kps: 0.20 },
   type730: { name: 'Typ 730', range: 2000, kps: 0.19 },
   type1130: { name: 'Typ 1130', range: 2200, kps: 0.23 },
   gun40: { name: '40-mm-Flak', range: 1500, kps: 0.08 },
};
export const CIWS_SUPER = 0.5;
// Defence tuning shared by ships and SAM sites (missile.js).
export const DEFENCE = {
   react: 2.5,               // s from detection of a threat to the first SAM leaving the rail
   relook: 1.5,              // s between an intercept result and the next shot of that channel (shoot-look-shoot)
   minRange: 900,            // m: SAMs cannot engage closer than this (the CIWS layer)
   farPk: 0.75,              // pk factor at maximum range (1 at half range and closer)
   aircraftPk: 0.85,         // pk factor against aircraft (they manoeuvre and use flares)
   decoyPk: 0.6,             // chance a fresh decoy cloud seduces a subsonic radar seeker locked on the ship
   decoyPkSuper: 0.42,       // ... a supersonic one
   decoyPkPassive: 0.3,      // ... an IR seeker (NSM)
   launchGap: 1.1,           // s between two SSMs leaving the same ship
   samGap: 8,                // s between two SAMs leaving the same platform, for one with two channels:
                             // interval = samGap * 4 / (2 + channels) (missile.samInterval) ...
   samGapUrgent: 0.25,       // ... times this against a supersonic threat
   salvo: 1,                 // interceptors in flight per threat (shoot-look-shoot) ...
   salvoClose: 2,            // ... and against a supersonic threat or one closer than panicT seconds
   panicT: 7,
   aamGap: 3,                // s between two air-to-air missiles of a fighter squadron
   armDist: 2500,            // m a bearing-only SSM flies before its seeker switches on
   turnCruise: 0.7,          // rad/s turn rate of an anti-ship / cruise missile in mid-course ...
   turnTerminal: 1.5,        // ... and with the seeker on
   friendlySeek: true,       // a seeker that finds nothing else takes a ship of its own side
   friendlyDmg: 0.5,         // damage factor of such a hit
   hitFire: 0.55,            // chance an SSM hit starts a fire / knocks out a module
   hitModule: 0.3,
   cruiseBlast: 150,         // m blast radius of a cruise missile against land positions
   rocketBlast: 25,          // m of an unguided rocket
};

// Consumable catalogue: display name/icon; per-ship charges/durations live in SHIPS[].consumables.
export const CONSUMABLES = {
   damageControl: { name: 'Schadensabwehr', short: 'Leck', icon: '🧯' },
   repair: { name: 'Notreparatur', short: 'Rep', icon: '🔧' },
   decoy: { name: 'Täuschkörper', short: 'Düppel', icon: '✨' },
   jammer: { name: 'Störsender', short: 'EloKa', icon: '📶' },
   helo: { name: 'Bordhubschrauber', short: 'Heli', icon: '🚁' },
   boost: { name: 'Äußerste Kraft', short: 'AK', icon: '⚡' },
   hydro: { name: 'Aktivsonar', short: 'Sonar', icon: '👂' },
   // legacy keys of the WW2 base (unused by the V2 roster, kept so old profiles / HUD tables resolve)
   smoke: { name: 'Nebelanlage', short: 'Nebel', icon: '🌫️' },
   radar: { name: 'Radar', short: 'Radar', icon: '📡' },
};

export const CLASS_NAMES = { FAC: 'Schnellboot', CO: 'Korvette', FF: 'Fregatte', DD: 'Zerstörer', CG: 'Kreuzer', CV: 'Flugzeugträger', SS: 'U-Boot', TR: 'Handelsschiff' };
export const NATION_NAMES = { de: 'Deutsche Marine', us: 'US Navy', uk: 'Royal Navy', ru: 'Russische Marine', cn: 'Marine der VBA', ir: 'Iranische Marine', nt: 'Handelsschifffahrt' };
// Port order of the nations and their tab labels.
export const NATIONS = ['de', 'us', 'uk', 'ru', 'cn', 'ir'];
export const NATION_SHORT = { de: 'Deutschland', us: 'USA', uk: 'Großbritannien', ru: 'Russland', cn: 'China', ir: 'Iran', nt: 'Neutral' };
export const NATION_BLOC = { de: 'west', us: 'west', uk: 'west', ru: 'east', cn: 'east', ir: 'east', nt: 'neutral' };
export const BLOCS = ['west', 'east'];
const NATION_COLOR = { de: 0x7b858c, us: 0x7f8990, uk: 0x868e94, ru: 0x6f7a80, cn: 0x8a9298, ir: 0x7d8384, nt: 0x5d5348 };
export const TIER_ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

// ---- builders (keep the ship table readable) ----
// Turret at x metres from midships (+ = bow). Fore turrets sweep +-arcW around the bow,
// aft turrets around the stern; the dead zone is the superstructure behind them.
const T = (x, guns, aft = false, arcW = 150) => ({ off: { x, y: 0 }, guns, arcC: aft ? Math.PI : 0, arcW: arcW * DEG });
const L = (x, side, tubes) => ({ off: { x, y: 0 }, side, tubes });
const C = (key, o = {}) => ({ key, ...o });

// Modern guns: fast, short-ranged, HE only. dispH = max horizontal dispersion (m) at max range;
// tMax = shell flight time (s) at max range.
const GUNS = {
   13: { traverse: 60, reload: 0.35, range: 1800, tMax: 2.2, fallMax: 6, dispH: 40, sigma: 1.6, he: { dmg: 16, pen: 2, fire: 0 } },
   30: { traverse: 60, reload: 0.4, range: 3200, tMax: 3.2, fallMax: 8, dispH: 45, sigma: 1.8, he: { dmg: 55, pen: 5, fire: 0.002 } },
   76: { traverse: 45, reload: 1.0, range: 7500, tMax: 6.0, fallMax: 16, dispH: 55, sigma: 2.0, he: { dmg: 340, pen: 13, fire: 0.012 } },
   100: { traverse: 40, reload: 1.2, range: 8000, tMax: 6.2, fallMax: 16, dispH: 60, sigma: 2.0, he: { dmg: 470, pen: 17, fire: 0.016 } },
   114: { traverse: 35, reload: 2.4, range: 8800, tMax: 6.6, fallMax: 18, dispH: 62, sigma: 2.0, he: { dmg: 800, pen: 19, fire: 0.025 } },
   127: { traverse: 32, reload: 3.0, range: 9500, tMax: 7.0, fallMax: 18, dispH: 65, sigma: 2.0, he: { dmg: 920, pen: 21, fire: 0.03 } },
   130: { traverse: 32, reload: 2.4, range: 9500, tMax: 7.0, fallMax: 18, dispH: 68, sigma: 2.0, he: { dmg: 900, pen: 21, fire: 0.03 } },
};
const gun = (caliber, turrets, o = {}) => ({ caliber, turrets, vRatio: 0.5, ...structuredClone(GUNS[caliber]), ...o });
// ships without a gun (carriers, boats): an empty battery, so nothing has to test for cfg.main
const noGun = () => ({ caliber: 0, turrets: [], traverse: 30, reload: 9, range: 100, tMax: 1, fallMax: 10, dispH: 10, vRatio: 0.5, sigma: 2, he: { dmg: 0, pen: 0, fire: 0 } });
// Modern hulls are unarmoured: every shell from 76 mm up penetrates.
const ARMOR = { belt: 8, deck: 8, ends: 6, sup: 5, cit: 0, citLen: 0, tds: 0 };
const BOAT_ARMOR = { belt: 1, deck: 1, ends: 1, sup: 1, cit: 0, citLen: 0, tds: 0 };
const det = (surface) => ({ surface, fire: surface + 2500, smokeFire: Math.round(surface * 0.5), torp: 1400 });
const RADAR = (range, horizon) => ({ range, horizon, air: Math.round(range * 1.3) });
// consumable sets
const DC = (cd = 60) => C('damageControl', { charges: Infinity, dur: 10, cd });
const REP = (charges = 2) => C('repair', { charges, dur: 20, cd: 80, heal: 0.005 });
const DECOY = (charges = 4, cd = 28) => C('decoy', { charges, dur: 6, cd });
const JAM = (charges = 2) => C('jammer', { charges, dur: 30, cd: 75 });
const HELO = (charges = 2) => C('helo', { charges, dur: 1, cd: 70 });
const SONAR = (range = 5000) => C('hydro', { charges: 3, dur: 60, cd: 90, range, torpRange: 3200 });
const ASW = (o = {}) => ({ n: 6, reload: 16, range: 4500, speedKn: 46, dmg: 3600, ...o });
// Submarines (submarine.js): battery seconds at full speed, speed factors, detectability.
const SUB = (o = {}) => ({ diveT: 6, battery: { peri: 900, deep: 600, charge: 90 }, periSpeed: 1, deepSpeed: 0.85,
   periDetect: 1500, torpBloom: 3800, hydrophone: 7000, seal: false, ...o });
const SUB_ARMOR = { belt: 19, deck: 8, ends: 10, sup: 8, cit: 0, citLen: 0, tds: 0 };
// Air wing (air.js). The three hangars of the WW2 base are kept as types:
//    tb  Angriffsstaffel (Seeziel): stand-off anti-ship missiles (weapon.missile, weapon.per plane)
//    db  Angriffsstaffel (Bomben): guided bombs against ships and land positions (weapon.site = damage to a site)
//    ft  Jagdstaffel: air-to-air missiles (aam: { type, per }) and guns (dps)
const AIRW = (tb, db, ft, o = {}) => ({
   tb: { squad: 4, flight: 2, hp: 1700, speed: 400, restock: 60, hangar: 8, ...tb,
      weapon: { missile: 'harpoon', per: 2, standoff: 13000, speedKn: 0, range: 0, flood: 0, dmg: 5200, ...tb.weapon } },
   db: { squad: 4, flight: 2, hp: 1700, speed: 400, restock: 60, hangar: 8, ...db,
      weapon: { dmg: 3400, pen: 80, fire: 0.3, ap: false, site: 2600, ...db.weapon } },
   ft: { squad: 4, flight: 4, hp: 1900, speed: 460, restock: 55, hangar: 8, dps: 120, ammo: 18, ...ft, aam: { type: 'amraam', per: 2, ...ft.aam } },
   service: 22, fuel: 170, jets: true, ...o,
});

function ship(def) {
   const h = def.hull;
   h.color = h.color ?? NATION_COLOR[h.type === 'TR' ? 'nt' : h.nation] ?? NATION_COLOR.nt;
   def.bloc = NATION_BLOC[h.nation] || 'neutral';
   def.tier = def.tier ?? 8;
   def.stealth = def.stealth ?? 1;
   def.radar = def.radar || null;
   def.sonar = def.sonar || { hull: 0, towed: 0 };
   def.helo = def.helo || null;
   const w = def.weapons = { ssm: [], cruise: null, sam: [], ciws: null, rockets: null, asw: null, cells: 0, ...(def.weapons || {}) };
   // magazine at the start of a battle: missile type -> rounds
   def.mag = {};
   for (const s of w.ssm) def.mag[s.type] = s.n;
   if (w.cruise) def.mag[w.cruise.type] = w.cruise.n;
   for (const s of w.sam) def.mag[s.type] = s.n;
   for (const k in def.mag) if (!MISSILES[k]) throw new Error(def.key + ': unknown missile ' + k);
   if (w.ciws && !CIWS[w.ciws.type]) throw new Error(def.key + ': unknown CIWS ' + w.ciws.type);
   const m = def.main = def.main || noGun();
   {
      // Game muzzle velocity derived from the max-range flight time, so tMax is the tunable.
      const K = WORLD.DRAG_K;
      m.vShell = m.range * (Math.exp(K) - 1) / (K * m.tMax);
      m.guns = m.turrets.reduce((a, t) => a + t.guns, 0);
      m.traverseRad = m.traverse * DEG;
      m.fallMaxRad = (m.fallMax || 28) * DEG;
      m.vRatio = m.vRatio ?? 0.55;
      if (m.ap) { m.ap.ricochet = m.ap.ricochet || [45, 60]; m.ap.fuse = m.ap.fuse ?? WORLD.FUSE_TRAVEL; }
      // legacy aliases (old HUD / main3d read these)
      m.dmg = (m.he || m.ap).dmg; m.type = m.he ? 'HE' : 'AP'; m.ap_ = m.ap || null;
   }
   def.sec = def.sec || null;
   def.torp = def.torp || null;
   if (def.torp) {
      const t = def.torp;
      t.speed = t.speedKn * WORLD.KN_TO_MS;
      t.tubes = t.launchers.reduce((a, l) => a + l.tubes, 0);
      t.cd = t.reload;            // legacy HUD alias
      t.detect = t.detect || 1300;
   }
   def.aa = def.aa || { range: 0, reload: 0.5 };
   def.armor = def.armor || { ...ARMOR };
   def.consumables = def.consumables || [];
   const boost = def.consumables.find(c => c.key === 'boost');
   if (boost) def.boost = { mult: boost.mult, dur: boost.dur, cd: boost.cd }; // legacy HUD "Turbo"
   def.maxSpeed = def.speedKn * WORLD.KN_TO_MS;   // legacy (m/s)
   def.color = h.color;
   return def;
}

// ---- ship classes ----
// Real dimensions and speeds; HP, magazines and channels are game values (see tests/v2.balance.mjs).
export const SHIPS = {
   // =================================================================== West
   Braunschweig: ship({
      key: 'Braunschweig', name: 'Braunschweig', className: 'Korvette K130', model: 'k130', playable: true, tier: 5,
      desc: 'Flugkörperkorvette für die Randmeere: vier RBS15 mit großer Reichweite, kleine Radarsignatur, zur Abwehr nur RAM und Täuschkörper.',
      sisters: ['Braunschweig', 'Magdeburg', 'Erfurt', 'Oldenburg', 'Ludwigshafen am Rhein'],
      hull: { type: 'CO', L: 89.1, beam: 13.3, draft: 3.4, deckH: 5.5, nation: 'de', sup: { x: 6, len: 26, w: 9, h: 10 }, funnels: [] },
      hp: 6500, speedKn: 26, accel: 9, turnR: 330, rudderShift: 3.6, stealth: 0.55,
      detect: det(5800), radar: RADAR(19000, 8500),
      main: gun(76, [T(30, 1)]),
      aa: { range: 2200, dps: 14 },
      weapons: { ssm: [{ type: 'rbs15', n: 4 }], sam: [{ type: 'ram', n: 24, ch: 2 }] },
      consumables: [DC(50), DECOY(4), JAM(2)],
      ai: { prefRange: [5000, 7000], role: 'dd', v2: 'strike', value: 22 },
   }),
   Sachsen: ship({
      key: 'Sachsen', name: 'Sachsen', className: 'Fregatte F124', model: 'f124', playable: true, tier: 8,
      desc: 'Luftverteidigungsfregatte: SM-2 für den Verbandsschutz, ESSM und RAM für den Nahbereich, dazu acht Harpoon.',
      sisters: ['Sachsen', 'Hamburg', 'Hessen'],
      hull: { type: 'FF', L: 143, beam: 17.4, draft: 5, deckH: 7.5, nation: 'de', sup: { x: 8, len: 46, w: 12, h: 15 }, funnels: [{ x: -14, r: 3, h: 7 }] },
      hp: 13000, speedKn: 29, accel: 12, turnR: 470, rudderShift: 5, stealth: 0.8,
      detect: det(7000), radar: RADAR(23000, 10500), sonar: { hull: 3200, towed: 0 },
      main: gun(76, [T(52, 1)]),
      aa: { range: 2500, dps: 20 },
      weapons: { cells: 32, ssm: [{ type: 'harpoon', n: 8 }], sam: [{ type: 'sm2', n: 24, ch: 3 }, { type: 'essm', n: 32, ch: 2 }, { type: 'ram', n: 24, ch: 1 }], asw: ASW() },
      helo: { name: 'Sea Lynx' },
      consumables: [DC(), REP(2), DECOY(4), JAM(2), HELO(2)],
      ai: { prefRange: [5500, 7200], role: 'cl', v2: 'ad', value: 42 },
   }),
   Burke: ship({
      key: 'Burke', name: 'USS Arleigh Burke', className: 'Arleigh-Burke-Klasse', model: 'burke', playable: true, tier: 9,
      desc: 'Der Alleskönner: Aegis mit großem Senkrechtstartmagazin, Tomahawk gegen Landziele, Harpoon, Hubschrauber und Schleppsonar.',
      sisters: ['USS Arleigh Burke', 'USS Carney', 'USS Mason', 'USS Gravely', 'USS Laboon', 'USS Thomas Hudner', 'USS Roosevelt'],
      hull: { type: 'DD', L: 155, beam: 20, draft: 6.6, deckH: 8, nation: 'us', sup: { x: 14, len: 44, w: 14, h: 16 }, funnels: [{ x: 2, r: 3.4, h: 9 }, { x: -22, r: 3.4, h: 9 }] },
      hp: 16000, speedKn: 31, accel: 12, turnR: 500, rudderShift: 5.4, stealth: 0.85,
      detect: det(7600), radar: RADAR(25000, 11000), sonar: { hull: 3400, towed: 6500 },
      main: gun(127, [T(58, 1)]),
      aa: { range: 2500, dps: 22 },
      weapons: { cells: 96, ssm: [{ type: 'harpoon', n: 8 }], cruise: { type: 'tomahawk', n: 24 }, sam: [{ type: 'sm2', n: 48, ch: 3 }, { type: 'essm', n: 32, ch: 2 }], ciws: { type: 'phalanx', n: 1 }, asw: ASW() },
      helo: { name: 'MH-60R' },
      consumables: [DC(), REP(2), DECOY(4), JAM(2), HELO(2)],
      ai: { prefRange: [6500, 8500], role: 'cl', v2: 'ad', value: 52 },
   }),
   Ticonderoga: ship({
      key: 'Ticonderoga', name: 'USS Ticonderoga', className: 'Ticonderoga-Klasse', model: 'tico', playable: true, tier: 10,
      desc: 'Lenkwaffenkreuzer mit dem größten Magazin des Westens: 122 Zellen, zwei 127-mm-Geschütze, vier Feuerleitkanäle.',
      sisters: ['USS Bunker Hill', 'USS Mobile Bay', 'USS Lake Erie', 'USS Shiloh', 'USS Gettysburg', 'USS Cape St. George'],
      hull: { type: 'CG', L: 173, beam: 16.8, draft: 7.5, deckH: 8.5, nation: 'us', sup: { x: 10, len: 70, w: 14, h: 18 }, funnels: [{ x: 6, r: 3.6, h: 9 }, { x: -22, r: 3.6, h: 9 }] },
      hp: 18500, speedKn: 32.5, accel: 13, turnR: 540, rudderShift: 5.8, stealth: 1,
      detect: det(8400), radar: RADAR(26000, 11500), sonar: { hull: 3400, towed: 6500 },
      main: gun(127, [T(66, 1), T(-70, 1, true)]),
      aa: { range: 2500, dps: 28 },
      weapons: { cells: 122, ssm: [{ type: 'harpoon', n: 8 }], cruise: { type: 'tomahawk', n: 32 }, sam: [{ type: 'sm2', n: 64, ch: 4 }, { type: 'essm', n: 32, ch: 2 }], ciws: { type: 'phalanx', n: 2 }, asw: ASW() },
      helo: { name: 'MH-60R' },
      consumables: [DC(), REP(3), DECOY(4), JAM(2), HELO(2)],
      ai: { prefRange: [6500, 8500], role: 'ca', v2: 'ad', value: 62 },
   }),
   Daring: ship({
      key: 'Daring', name: 'HMS Daring', className: 'Type 45', model: 'type45', playable: true, tier: 9,
      desc: 'Die beste Luftverteidigung der Flotte: Sea Viper mit fünf Kanälen und sehr treffsicheren Aster-Flugkörpern – dafür nur vier Seezielflugkörper.',
      sisters: ['HMS Daring', 'HMS Dauntless', 'HMS Diamond', 'HMS Dragon', 'HMS Defender', 'HMS Duncan'],
      hull: { type: 'DD', L: 152.4, beam: 21.2, draft: 5.3, deckH: 8, nation: 'uk', sup: { x: 12, len: 50, w: 15, h: 20 }, funnels: [{ x: -4, r: 3.6, h: 10 }] },
      hp: 15000, speedKn: 30, accel: 12, turnR: 490, rudderShift: 5.2, stealth: 0.6,
      detect: det(7200), radar: RADAR(26000, 12000), sonar: { hull: 3200, towed: 0 },
      main: gun(114, [T(56, 1)]),
      aa: { range: 2500, dps: 24 },
      weapons: { cells: 48, ssm: [{ type: 'nsm', n: 4 }], sam: [{ type: 'aster30', n: 32, ch: 5 }, { type: 'camm', n: 24, ch: 2 }], ciws: { type: 'phalanx', n: 2 } },
      helo: { name: 'Wildcat' },
      consumables: [DC(), REP(2), DECOY(4), JAM(2), HELO(2)],
      ai: { prefRange: [6000, 8000], role: 'cl', v2: 'ad', value: 50 },
   }),
   Ford: ship({
      key: 'Ford', name: 'USS Gerald R. Ford', className: 'Gerald-R.-Ford-Klasse', model: 'ford', playable: true, tier: 10,
      desc: 'Flugzeugträger: F-35C sichern den Luftraum, F/A-18E tragen Harpoon und Lenkbomben weit über jede Schiffswaffe hinaus. Zur Selbstverteidigung nur ESSM, RAM und Phalanx.',
      sisters: ['USS Gerald R. Ford', 'USS John F. Kennedy', 'USS Enterprise'],
      hull: { type: 'CV', L: 337, beam: 41, draft: 12, deckH: 20, nation: 'us', sup: { x: -60, len: 22, w: 9, h: 28 }, funnels: [] },
      hp: 70000, speedKn: 30, accel: 30, turnR: 1050, rudderShift: 14, stealth: 1.25,
      detect: det(11500), radar: RADAR(26000, 13000),
      armor: { belt: 40, deck: 30, ends: 20, sup: 10, cit: 30, citLen: 0.5, tds: 0.3 },
      aa: { range: 2500, dps: 30 },
      weapons: { sam: [{ type: 'essm', n: 16, ch: 2 }, { type: 'ram', n: 24, ch: 2 }], ciws: { type: 'phalanx', n: 3 } },
      air: AIRW({ name: 'F/A-18E (Harpoon)', hangar: 10 }, { name: 'F/A-18E (Lenkbomben)', hangar: 8 }, { name: 'F-35C', hangar: 10 }),
      consumables: [DC(70), REP(3), DECOY(4), JAM(2)],
      ai: { prefRange: [12000, 16000], role: 'cv', v2: 'cv', value: 90 },
   }),
   U212: ship({
      key: 'U212', name: 'U 31', className: 'U-Boot 212A', model: 'u212', playable: true, tier: 7,
      desc: 'Brennstoffzellen-U-Boot: fast lautlos, ausdauernd unter Wasser, sechs Rohre für Schwergewichtstorpedos – und ein Kampfschwimmertrupp.',
      sisters: ['U 31', 'U 32', 'U 33', 'U 34', 'U 35', 'U 36'],
      hull: { type: 'SS', L: 57.2, beam: 7, draft: 6, deckH: 3, nation: 'de', sup: { x: 4, len: 9, w: 2.6, h: 5.5 }, funnels: [] },
      hp: 6000, speedKn: 20, accel: 9, turnR: 300, rudderShift: 3.4, stealth: 0.25,
      detect: det(3800), radar: RADAR(8000, 4000),
      armor: { ...SUB_ARMOR },
      torp: { launchers: [L(24, 'bow', 6)], range: 9000, speedKn: 55, dmg: 9000, flood: 0.3, reload: 60 },
      sub: SUB({ diveT: 5, battery: { peri: 1500, deep: 900, charge: 120 }, periDetect: 1100, torpBloom: 3200, hydrophone: 8000, seal: true, quiet: 0.6 }),
      consumables: [DC(50)],
      ai: { prefRange: [2500, 5000], role: 'ss', v2: 'ss', value: 30 },
   }),
   Virginia: ship({
      key: 'Virginia', name: 'USS Virginia', className: 'Virginia-Klasse', model: 'virginia', playable: true, tier: 9,
      desc: 'Atomares Jagd-U-Boot: unbegrenzte Ausdauer, schnelle Torpedos, zwölf Tomahawk aus Senkrechtstartrohren und ein Kampfschwimmertrupp.',
      sisters: ['USS Virginia', 'USS Texas', 'USS Hawaii', 'USS North Carolina', 'USS New Mexico'],
      hull: { type: 'SS', L: 115, beam: 10.4, draft: 9.3, deckH: 4, nation: 'us', sup: { x: 20, len: 12, w: 3, h: 6.5 }, funnels: [] },
      hp: 9500, speedKn: 26, accel: 14, turnR: 480, rudderShift: 5, stealth: 0.3,
      detect: det(4400), radar: RADAR(8000, 4000),
      armor: { ...SUB_ARMOR },
      torp: { launchers: [L(48, 'bow', 4)], range: 10000, speedKn: 60, dmg: 9500, flood: 0.3, reload: 55 },
      weapons: { cells: 12, cruise: { type: 'tomahawk', n: 12 } },
      sub: SUB({ diveT: 7, battery: { peri: Infinity, deep: Infinity, charge: 1 }, periDetect: 1500, torpBloom: 3800, hydrophone: 9000, seal: true, quiet: 0.8, nuclear: true }),
      consumables: [DC(50), REP(1)],
      ai: { prefRange: [3000, 6000], role: 'ss', v2: 'ss', value: 42 },
   }),

   // =================================================================== East: Russia
   BuyanM: ship({
      key: 'BuyanM', name: 'Grad Swijaschsk', className: 'Bujan-M (Projekt 21631)', model: 'buyan', tier: 5,
      desc: 'Kleine Flugkörperkorvette mit acht Kalibr-Zellen: große Schlagkraft, kaum Abwehr.',
      sisters: ['Grad Swijaschsk', 'Uglitsch', 'Weliki Ustjug', 'Seljony Dol', 'Serpuchow', 'Wyschni Wolotschok'],
      hull: { type: 'CO', L: 75, beam: 11, draft: 2.6, deckH: 5, nation: 'ru', sup: { x: 4, len: 24, w: 8, h: 9 }, funnels: [] },
      hp: 5500, speedKn: 25, accel: 9, turnR: 310, rudderShift: 3.4, stealth: 0.7,
      detect: det(5600), radar: RADAR(17000, 8000),
      main: gun(100, [T(24, 1)]),
      aa: { range: 2000, dps: 12 },
      weapons: { cells: 8, ssm: [{ type: 'kalibr', n: 4 }], cruise: { type: 'kalibrLA', n: 4 }, sam: [{ type: 'igla', n: 8, ch: 1 }], ciws: { type: 'ak630', n: 1 } },
      consumables: [DC(50), DECOY(3)],
      ai: { prefRange: [5000, 7200], role: 'dd', v2: 'strike', value: 20 },
   }),
   Gorschkow: ship({
      key: 'Gorschkow', name: 'Admiral Gorschkow', className: 'Projekt 22350', model: 'gorshkov', tier: 8,
      desc: 'Moderne Mehrzweckfregatte: Überschall-Seezielflugkörper Oniks, Poliment-Redut zur Luftverteidigung.',
      sisters: ['Admiral Gorschkow', 'Admiral Kassatonow', 'Admiral Golowko'],
      hull: { type: 'FF', L: 135, beam: 16, draft: 4.5, deckH: 7.5, nation: 'ru', sup: { x: 10, len: 44, w: 12, h: 16 }, funnels: [{ x: -10, r: 3.2, h: 8 }] },
      hp: 12500, speedKn: 29.5, accel: 12, turnR: 460, rudderShift: 5, stealth: 0.65,
      detect: det(6900), radar: RADAR(23000, 10500), sonar: { hull: 3200, towed: 6000 },
      main: gun(130, [T(50, 1)]),
      aa: { range: 2500, dps: 22 },
      weapons: { cells: 48, ssm: [{ type: 'oniks', n: 8 }], cruise: { type: 'kalibrLA', n: 8 }, sam: [{ type: 'redut', n: 32, ch: 3 }], ciws: { type: 'kashtan', n: 2 }, asw: ASW() },
      helo: { name: 'Ka-27' },
      consumables: [DC(), REP(2), DECOY(4), JAM(2), HELO(1)],
      ai: { prefRange: [6000, 8200], role: 'cl', v2: 'strike', value: 46 },
   }),
   Slawa: ship({
      key: 'Slawa', name: 'Marschall Ustinow', className: 'Slawa-Klasse (Projekt 1164)', model: 'slava', tier: 9,
      desc: 'Flugkörperkreuzer aus dem Kalten Krieg: sechzehn schwere Überschallflugkörper Wulkan, S-300F – aber nur zwei Feuerleitkanäle.',
      sisters: ['Marschall Ustinow', 'Warjag', 'Moskwa'],
      hull: { type: 'CG', L: 186.4, beam: 20.8, draft: 8.4, deckH: 9, nation: 'ru', sup: { x: 14, len: 60, w: 15, h: 20 }, funnels: [{ x: -14, r: 4.5, h: 10 }] },
      hp: 19000, speedKn: 32, accel: 14, turnR: 580, rudderShift: 6.2, stealth: 1.05,
      detect: det(8800), radar: RADAR(26000, 11500), sonar: { hull: 3000, towed: 5500 },
      main: gun(130, [T(74, 2)], { reload: 2.2 }),
      aa: { range: 2500, dps: 30 },
      weapons: { cells: 64, ssm: [{ type: 'vulkan', n: 16 }], sam: [{ type: 's300f', n: 48, ch: 2 }, { type: 'osa', n: 20, ch: 1 }], ciws: { type: 'ak630', n: 3 }, asw: ASW() },
      helo: { name: 'Ka-27' },
      consumables: [DC(), REP(3), DECOY(4), JAM(2), HELO(1)],
      ai: { prefRange: [6500, 8500], role: 'ca', v2: 'strike', value: 64 },
   }),
   PjotrWeliki: ship({
      key: 'PjotrWeliki', name: 'Pjotr Weliki', className: 'Kirow-Klasse (Projekt 1144)', model: 'kirovn', tier: 10,
      desc: 'Atomgetriebener Schlachtkreuzer: zwanzig Granit, das größte Flugabwehrmagazin der See und sechs Nahbereichssysteme. Ein Gegner für einen ganzen Verband.',
      hull: { type: 'CG', L: 252, beam: 28.5, draft: 9.1, deckH: 11, nation: 'ru', sup: { x: 4, len: 90, w: 20, h: 26 }, funnels: [{ x: -6, r: 5, h: 12 }] },
      hp: 42000, speedKn: 32, accel: 20, turnR: 760, rudderShift: 9, stealth: 1.25,
      detect: det(10000), radar: RADAR(27000, 12500), sonar: { hull: 3400, towed: 6500 },
      armor: { belt: 76, deck: 50, ends: 20, sup: 10, cit: 40, citLen: 0.45, tds: 0.15 },
      main: gun(130, [T(-96, 2, true)], { reload: 2.2 }),
      aa: { range: 3000, dps: 40 },
      weapons: { cells: 116, ssm: [{ type: 'granit', n: 20 }], sam: [{ type: 's300f', n: 72, ch: 4 }, { type: 'kinzhal', n: 48, ch: 3 }], ciws: { type: 'kashtan', n: 4 }, asw: ASW({ n: 10 }) },
      helo: { name: 'Ka-27' },
      consumables: [DC(), REP(4), DECOY(5), JAM(3), HELO(2)],
      ai: { prefRange: [7000, 9000], role: 'bb', v2: 'boss', value: 110 },
   }),
   Kusnezow: ship({
      key: 'Kusnezow', name: 'Admiral Kusnezow', className: 'Projekt 1143.5', model: 'kuznetsov', tier: 9,
      desc: 'Flugdeckkreuzer mit Sprungschanze: Su-33 und MiG-29K, dazu zwölf Granit unter dem Flugdeck.',
      hull: { type: 'CV', L: 305, beam: 35, draft: 10, deckH: 18, nation: 'ru', sup: { x: -20, len: 34, w: 10, h: 30 }, funnels: [{ x: -24, r: 5, h: 8 }] },
      hp: 58000, speedKn: 29, accel: 30, turnR: 1000, rudderShift: 14, stealth: 1.25,
      detect: det(11000), radar: RADAR(25000, 12500),
      armor: { belt: 40, deck: 30, ends: 20, sup: 10, cit: 30, citLen: 0.5, tds: 0.25 },
      aa: { range: 3000, dps: 36 },
      weapons: { ssm: [{ type: 'granit', n: 12 }], sam: [{ type: 'kinzhal', n: 48, ch: 3 }], ciws: { type: 'kashtan', n: 4 } },
      air: AIRW({ name: 'MiG-29K (Ch-35)', hangar: 6, weapon: { missile: 'kh35', dmg: 4200 } }, { name: 'MiG-29K (Bomben)', hangar: 6 },
         { name: 'Su-33', hangar: 8, aam: { type: 'r77' } }, { service: 28 }),
      consumables: [DC(70), REP(3), DECOY(4), JAM(2)],
      ai: { prefRange: [12000, 16000], role: 'cv', v2: 'cv', value: 85 },
   }),
   Kilo: ship({
      key: 'Kilo', name: 'Noworossijsk', className: 'Kilo-Klasse (Projekt 636.3)', model: 'kilo', tier: 7,
      desc: 'Dieselelektrisches U-Boot, das „schwarze Loch“: leise, sechs Rohre, Kalibr aus den Torpedorohren.',
      sisters: ['Noworossijsk', 'Rostow am Don', 'Stary Oskol', 'Krasnodar', 'Weliki Nowgorod', 'Kolpino'],
      hull: { type: 'SS', L: 73.8, beam: 9.9, draft: 6.2, deckH: 3.5, nation: 'ru', sup: { x: 6, len: 12, w: 3, h: 5.5 }, funnels: [] },
      hp: 7000, speedKn: 20, accel: 10, turnR: 340, rudderShift: 3.8, stealth: 0.28,
      detect: det(4000), radar: RADAR(8000, 4000),
      armor: { ...SUB_ARMOR },
      torp: { launchers: [L(32, 'bow', 6)], range: 8500, speedKn: 52, dmg: 9000, flood: 0.3, reload: 65 },
      weapons: { ssm: [{ type: 'kalibr', n: 4 }] },
      sub: SUB({ diveT: 6, battery: { peri: 600, deep: 380, charge: 85 }, periDetect: 1400, quiet: 0.7 }),
      consumables: [DC(50)],
      ai: { prefRange: [2500, 5000], role: 'ss', v2: 'ss', value: 32 },
   }),

   // =================================================================== East: China
   Typ022: ship({
      key: 'Typ022', name: 'Typ 022', className: 'Houbei-Klasse', model: 'type022', tier: 4,
      desc: 'Flugkörperschnellboot in Katamaranbauweise: acht YJ-83, sehr schnell, sehr kleine Signatur – und keinerlei Flugabwehr.',
      sisters: ['Typ 022 Nr. 2208', 'Typ 022 Nr. 2209', 'Typ 022 Nr. 2210', 'Typ 022 Nr. 2211', 'Typ 022 Nr. 2212', 'Typ 022 Nr. 2213', 'Typ 022 Nr. 2214', 'Typ 022 Nr. 2215'],
      hull: { type: 'FAC', L: 42.6, beam: 12.2, draft: 1.5, deckH: 3.5, nation: 'cn', sup: { x: 2, len: 12, w: 7, h: 5 }, funnels: [] },
      hp: 2200, speedKn: 36, accel: 6, turnR: 220, rudderShift: 2.2, stealth: 0.45,
      detect: det(4400), radar: RADAR(13000, 6500),
      armor: { ...BOAT_ARMOR, belt: 3, deck: 3 },
      main: gun(30, [T(12, 1)]),
      aa: { range: 1500, dps: 8 },
      weapons: { ssm: [{ type: 'yj83', n: 8 }] },
      consumables: [DC(40), DECOY(2)],
      ai: { prefRange: [2000, 3000], role: 'dd', v2: 'fac', value: 12 },
   }),
   Typ054A: ship({
      key: 'Typ054A', name: 'Xuzhou', className: 'Typ 054A (Jiangkai II)', model: 'type054', tier: 7,
      desc: 'Geleitfregatte: HQ-16 mittlerer Reichweite, acht YJ-83, Schleppsonar und Hubschrauber.',
      sisters: ['Xuzhou', 'Zhoushan', 'Chaohu', 'Yantai', 'Yuncheng', 'Hengyang', 'Linyi', 'Weifang', 'Binzhou'],
      hull: { type: 'FF', L: 134, beam: 16, draft: 5, deckH: 7, nation: 'cn', sup: { x: 8, len: 40, w: 12, h: 14 }, funnels: [{ x: -12, r: 3, h: 7 }] },
      hp: 12000, speedKn: 27, accel: 12, turnR: 450, rudderShift: 5, stealth: 0.75,
      detect: det(6900), radar: RADAR(22000, 10000), sonar: { hull: 3000, towed: 6000 },
      main: gun(76, [T(48, 1)]),
      aa: { range: 2500, dps: 20 },
      weapons: { cells: 32, ssm: [{ type: 'yj83', n: 8 }], sam: [{ type: 'hq16', n: 32, ch: 2 }], ciws: { type: 'type730', n: 2 }, asw: ASW() },
      helo: { name: 'Z-9' },
      consumables: [DC(), REP(2), DECOY(4), JAM(1), HELO(1)],
      ai: { prefRange: [5500, 7200], role: 'cl', v2: 'escort', value: 38 },
   }),
   Typ052D: ship({
      key: 'Typ052D', name: 'Kunming', className: 'Typ 052D (Luyang III)', model: 'type052d', tier: 9,
      desc: 'Lenkwaffenzerstörer: HQ-9 für die Verbandsflugabwehr, YJ-18 mit Überschall-Endanflug, CJ-10 gegen Landziele.',
      sisters: ['Kunming', 'Changsha', 'Hefei', 'Yinchuan', 'Xining', 'Xiamen', 'Ürümqi', 'Guiyang', 'Nanjing'],
      hull: { type: 'DD', L: 157, beam: 17, draft: 6, deckH: 8, nation: 'cn', sup: { x: 14, len: 42, w: 13, h: 17 }, funnels: [{ x: -8, r: 3.4, h: 9 }] },
      hp: 16000, speedKn: 30, accel: 12, turnR: 500, rudderShift: 5.4, stealth: 0.8,
      detect: det(7500), radar: RADAR(25000, 11000), sonar: { hull: 3200, towed: 6000 },
      main: gun(130, [T(58, 1)]),
      aa: { range: 2500, dps: 22 },
      weapons: { cells: 64, ssm: [{ type: 'yj18', n: 8 }], cruise: { type: 'cj10', n: 8 }, sam: [{ type: 'hq9', n: 40, ch: 3 }, { type: 'hq10', n: 24, ch: 1 }], ciws: { type: 'type730', n: 1 }, asw: ASW() },
      helo: { name: 'Z-9' },
      consumables: [DC(), REP(2), DECOY(4), JAM(2), HELO(1)],
      ai: { prefRange: [6500, 8500], role: 'cl', v2: 'ad', value: 52 },
   }),
   Typ055: ship({
      key: 'Typ055', name: 'Nanchang', className: 'Typ 055 (Renhai)', model: 'type055', tier: 10,
      desc: 'Der größte Überwasserkämpfer des Ostens: 112 Zellen, vier Feuerleitkanäle, kleine Radarsignatur.',
      sisters: ['Nanchang', 'Lhasa', 'Dalian', 'Anshan', 'Wuxi', 'Yan’an', 'Zunyi', 'Xianyang'],
      hull: { type: 'CG', L: 180, beam: 20, draft: 6.6, deckH: 9, nation: 'cn', sup: { x: 12, len: 62, w: 16, h: 20 }, funnels: [{ x: -10, r: 3.8, h: 9 }] },
      hp: 20000, speedKn: 30, accel: 13, turnR: 550, rudderShift: 5.8, stealth: 0.65,
      detect: det(8000), radar: RADAR(27000, 12000), sonar: { hull: 3400, towed: 6500 },
      main: gun(130, [T(66, 1)]),
      aa: { range: 2500, dps: 28 },
      weapons: { cells: 112, ssm: [{ type: 'yj18', n: 12 }], cruise: { type: 'cj10', n: 16 }, sam: [{ type: 'hq9', n: 64, ch: 4 }, { type: 'hq10', n: 24, ch: 1 }], ciws: { type: 'type1130', n: 1 }, asw: ASW() },
      helo: { name: 'Z-9' },
      consumables: [DC(), REP(3), DECOY(4), JAM(2), HELO(2)],
      ai: { prefRange: [6500, 8500], role: 'ca', v2: 'ad', value: 68 },
   }),
   Shandong: ship({
      key: 'Shandong', name: 'Shandong', className: 'Typ 002', model: 'shandong', tier: 9,
      desc: 'Flugzeugträger mit Sprungschanze: J-15 als Jäger und als Träger der YJ-83K.',
      hull: { type: 'CV', L: 305, beam: 38, draft: 10.5, deckH: 18, nation: 'cn', sup: { x: -24, len: 28, w: 10, h: 30 }, funnels: [{ x: -28, r: 5, h: 8 }] },
      hp: 60000, speedKn: 31, accel: 30, turnR: 1000, rudderShift: 14, stealth: 1.25,
      detect: det(11000), radar: RADAR(25000, 12500),
      armor: { belt: 40, deck: 30, ends: 20, sup: 10, cit: 30, citLen: 0.5, tds: 0.25 },
      aa: { range: 2500, dps: 30 },
      weapons: { sam: [{ type: 'hq10', n: 36, ch: 2 }], ciws: { type: 'type1130', n: 3 } },
      air: AIRW({ name: 'J-15 (YJ-83K)', hangar: 8, weapon: { missile: 'yj83', dmg: 4300 } }, { name: 'J-15 (Bomben)', hangar: 6 },
         { name: 'J-15', hangar: 8, aam: { type: 'pl12' } }, { service: 26 }),
      consumables: [DC(70), REP(3), DECOY(4), JAM(2)],
      ai: { prefRange: [12000, 16000], role: 'cv', v2: 'cv', value: 85 },
   }),
   Yuan: ship({
      key: 'Yuan', name: 'Changcheng 330', className: 'Typ 039A (Yuan)', model: 'yuan', tier: 7,
      desc: 'U-Boot mit außenluftunabhängigem Antrieb: ausdauernd, leise, YJ-18 aus den Torpedorohren.',
      sisters: ['Changcheng 330', 'Changcheng 331', 'Changcheng 332', 'Changcheng 333', 'Changcheng 334'],
      hull: { type: 'SS', L: 77.6, beam: 8.4, draft: 6.7, deckH: 3.5, nation: 'cn', sup: { x: 8, len: 12, w: 3, h: 5.5 }, funnels: [] },
      hp: 7000, speedKn: 20, accel: 10, turnR: 340, rudderShift: 3.8, stealth: 0.28,
      detect: det(4000), radar: RADAR(8000, 4000),
      armor: { ...SUB_ARMOR },
      torp: { launchers: [L(34, 'bow', 6)], range: 8500, speedKn: 52, dmg: 9000, flood: 0.3, reload: 65 },
      weapons: { ssm: [{ type: 'yj18', n: 4 }] },
      sub: SUB({ diveT: 6, battery: { peri: 1200, deep: 700, charge: 110 }, periDetect: 1300, quiet: 0.65 }),
      consumables: [DC(50)],
      ai: { prefRange: [2500, 5000], role: 'ss', v2: 'ss', value: 32 },
   }),

   // =================================================================== East: Iran
   Boghammar: ship({
      key: 'Boghammar', name: 'Schnellboot', className: 'Boghammar', model: 'fac', tier: 2,
      desc: 'Bewaffnetes Schnellboot der Revolutionsgarden: Raketenwerfer, Maschinengewehr und ein leichter Flugkörper. Einzeln harmlos, im Schwarm gefährlich.',
      sisters: ['Schnellboot 1', 'Schnellboot 2', 'Schnellboot 3', 'Schnellboot 4', 'Schnellboot 5', 'Schnellboot 6', 'Schnellboot 7', 'Schnellboot 8',
         'Schnellboot 9', 'Schnellboot 10', 'Schnellboot 11', 'Schnellboot 12', 'Schnellboot 13', 'Schnellboot 14', 'Schnellboot 15', 'Schnellboot 16'],
      hull: { type: 'FAC', L: 13, beam: 2.9, draft: 0.7, deckH: 1.4, nation: 'ir', sup: { x: -1, len: 3, w: 1.8, h: 1.6 }, funnels: [] },
      hp: 450, speedKn: 45, accel: 3.5, turnR: 110, rudderShift: 1.2, stealth: 0.3,
      detect: det(3200), radar: RADAR(7000, 4000),
      armor: { ...BOAT_ARMOR },
      main: gun(13, [T(3, 1, false, 170)]),
      weapons: { ssm: [{ type: 'kowsar', n: 1 }], rockets: { n: 12, salvo: 12, range: 3200, speed: 420, dmg: 230, disp: 110, reload: 45 } },
      consumables: [],
      ai: { prefRange: [900, 1500], role: 'dd', v2: 'fac', value: 4 },
   }),
   Mowdsch: ship({
      key: 'Mowdsch', name: 'Dschamaran', className: 'Moudge-Klasse', model: 'moudge', tier: 5,
      desc: 'Leichte Fregatte: vier Noor-Seezielflugkörper, schwache Flugabwehr, Torpedos gegen U-Boote.',
      sisters: ['Dschamaran', 'Sahand', 'Dena', 'Damawand'],
      hull: { type: 'FF', L: 95, beam: 11.1, draft: 3.3, deckH: 5.5, nation: 'ir', sup: { x: 6, len: 30, w: 8, h: 11 }, funnels: [{ x: -8, r: 2.6, h: 6 }] },
      hp: 7500, speedKn: 30, accel: 10, turnR: 380, rudderShift: 4, stealth: 0.95,
      detect: det(6200), radar: RADAR(19000, 9000), sonar: { hull: 2600, towed: 0 },
      main: gun(76, [T(34, 1)]),
      aa: { range: 2200, dps: 14 },
      weapons: { ssm: [{ type: 'noor', n: 4 }], sam: [{ type: 'sayyad', n: 4, ch: 1 }], ciws: { type: 'gun40', n: 1 }, asw: ASW({ n: 4 }) },
      consumables: [DC(), REP(1), DECOY(3)],
      ai: { prefRange: [5000, 7000], role: 'cl', v2: 'strike', value: 24 },
   }),
   Ghadir: ship({
      key: 'Ghadir', name: 'Ghadir', className: 'Ghadir-Klasse', model: 'ghadir', tier: 3,
      desc: 'Kleinst-U-Boot für flache Küstengewässer: zwei Torpedorohre, kaum zu orten.',
      sisters: ['Ghadir 942', 'Ghadir 943', 'Ghadir 944', 'Ghadir 945', 'Ghadir 946', 'Ghadir 947'],
      hull: { type: 'SS', L: 29, beam: 2.75, draft: 2.5, deckH: 1.6, nation: 'ir', sup: { x: 2, len: 4, w: 1.4, h: 2.6 }, funnels: [] },
      hp: 2500, speedKn: 11, accel: 6, turnR: 160, rudderShift: 2.2, stealth: 0.15,
      detect: det(2400),
      armor: { ...SUB_ARMOR, belt: 10 },
      torp: { launchers: [L(12, 'bow', 2)], range: 6000, speedKn: 45, dmg: 8000, flood: 0.3, reload: 80 },
      sub: SUB({ diveT: 4, battery: { peri: 500, deep: 300, charge: 80 }, periDetect: 800, torpBloom: 2600, hydrophone: 4500, quiet: 0.5 }),
      consumables: [DC(60)],
      ai: { prefRange: [1500, 3500], role: 'ss', v2: 'ss', value: 14 },
   }),

   // =================================================================== neutral / mission ships
   Tanker: ship({
      key: 'Tanker', name: 'Tanker', className: 'Rohöltanker (Suezmax)', model: 'tanker', tier: 1,
      sisters: ['MT Nordic Aurora', 'MT Hafnia Pride', 'MT Stena Polaris', 'MT Minerva Kalypso', 'MT Front Altair', 'MT Eagle Vancouver'],
      hull: { type: 'TR', L: 250, beam: 44, draft: 15, deckH: 8, nation: 'nt', sup: { x: -100, len: 26, w: 34, h: 26 }, funnels: [{ x: -108, r: 3.5, h: 10 }] },
      hp: 30000, speedKn: 15, accel: 40, turnR: 900, rudderShift: 14, stealth: 1.4,
      detect: det(11000), radar: RADAR(10000, 8000),
      armor: { belt: 18, deck: 12, ends: 12, sup: 6, cit: 0, citLen: 0, tds: 0.2 },
      ai: { prefRange: [9000, 12000], role: 'tr', v2: 'tr', value: 30 },
   }),
   Container: ship({
      key: 'Container', name: 'Containerschiff', className: 'Containerschiff (Post-Panamax)', model: 'container', tier: 1,
      sisters: ['MV Maersk Tampa', 'MV MSC Aurelia', 'MV Hamburg Express', 'MV CMA CGM Tage', 'MV Ever Fortune', 'MV ONE Hanoi'],
      hull: { type: 'TR', L: 300, beam: 45, draft: 13, deckH: 10, nation: 'nt', sup: { x: -70, len: 20, w: 40, h: 34 }, funnels: [{ x: -82, r: 3.5, h: 12 }] },
      hp: 30000, speedKn: 20, accel: 40, turnR: 950, rudderShift: 14, stealth: 1.5,
      detect: det(12000), radar: RADAR(10000, 8000),
      armor: { belt: 16, deck: 10, ends: 10, sup: 6, cit: 0, citLen: 0, tds: 0.1 },
      ai: { prefRange: [9000, 12000], role: 'tr', v2: 'tr', value: 30 },
   }),
   LNG: ship({
      key: 'LNG', name: 'Gastanker', className: 'Flüssiggastanker', model: 'lng', tier: 1,
      sisters: ['LNG Al Dafna', 'LNG Arctic Voyager', 'LNG Gaslog Salem', 'LNG Maran Gas Delphi'],
      hull: { type: 'TR', L: 290, beam: 46, draft: 11.5, deckH: 12, nation: 'nt', sup: { x: -115, len: 22, w: 36, h: 28 }, funnels: [{ x: -124, r: 3.5, h: 10 }] },
      hp: 26000, speedKn: 19, accel: 40, turnR: 950, rudderShift: 14, stealth: 1.5,
      detect: det(12000), radar: RADAR(10000, 8000),
      armor: { belt: 16, deck: 10, ends: 10, sup: 6, cit: 0, citLen: 0, tds: 0.1 },
      ai: { prefRange: [9000, 12000], role: 'tr', v2: 'tr', value: 34 },
   }),
};

export const isCarrier = (cfgOrKey) => (typeof cfgOrKey === 'string' ? SHIPS[cfgOrKey] : cfgOrKey)?.hull?.type === 'CV';
// Player-selectable classes in port order: the west bloc. PLAYABLE_EAST joins it in PvP skirmishes.
export const PLAYABLE = ['Braunschweig', 'Sachsen', 'Burke', 'Ticonderoga', 'Daring', 'Ford', 'U212', 'Virginia'];
export const PLAYABLE_EAST = ['BuyanM', 'Gorschkow', 'Slawa', 'PjotrWeliki', 'Kusnezow', 'Kilo', 'Typ022', 'Typ054A', 'Typ052D', 'Typ055', 'Shandong', 'Yuan', 'Mowdsch', 'Ghadir'];
for (const k of PLAYABLE) SHIPS[k].playable = true;
export const NEUTRAL_SHIPS = ['Tanker', 'Container', 'LNG'];
// Skirmish line-ups (missions.js spawnTeam): [slot pool, x, y] relative to the team anchor, facing +x.
// Every slot draws one class from its pool (seeded), the pools of both blocs are index-aligned by weight.
export const BOT_POOLS = {
   west: [[['Ticonderoga'], 0, 0], [['Burke', 'Daring'], 900, -1900], [['Sachsen', 'Burke'], 900, 1900], [['Sachsen', 'Daring'], -600, -3600],
      [['Braunschweig'], 2200, -900], [['Braunschweig'], 2200, 900]],
   east: [[['Slawa', 'Typ055'], 0, 0], [['Typ052D', 'Gorschkow'], 900, -1900], [['Gorschkow', 'Typ054A'], 900, 1900], [['Typ054A', 'Mowdsch'], -600, -3600],
      [['BuyanM', 'Typ022'], 2200, -900], [['Typ022', 'BuyanM'], 2200, 900]],
};
export const BOT_SUBS = { west: ['U212', 'Virginia'], east: ['Kilo', 'Yuan'] };
export const BOT_CVS = { west: ['Ford'], east: ['Kusnezow', 'Shandong'] };
export const BOT_MIRROR = {};        // legacy export (WW2 slot mirroring), unused in V2

export const DIFFICULTY = {
   easy: { key: 'easy', label: 'Leicht', botHP: 0.8, botDmg: 0.7, aimErr: 0.022, lead: 0.62, reaction: 2.6, dodge: 0.25, smarts: 0.5, rewardMult: 0.8, vsPlayer: 1.5 },
   normal: { key: 'normal', label: 'Normal', botHP: 1, botDmg: 1, aimErr: 0.013, lead: 0.82, reaction: 1.5, dodge: 0.55, smarts: 0.8, rewardMult: 1, vsPlayer: 1.25 },
   hard: { key: 'hard', label: 'Schwer', botHP: 1.15, botDmg: 1.2, aimErr: 0.007, lead: 0.93, reaction: 0.8, dodge: 0.85, smarts: 1, rewardMult: 1.3, vsPlayer: 1 },
};

export const TUNE = { maxShells: 900, maxEffects: 500, maxEvents: 256, maxLog: 60, maxMissiles: 260 };

// ---- gun anti-aircraft fire (air.js) ----
// The barrels and CIWS of a ship against aircraft that come close (cfg.aa = { range, dps });
// the long arm against aircraft are the SAMs (missile.js). Three nested bands as in the WW2 base.
export function aaProfile(c) {
   const range = c.aa?.range || 0;
   const dps = c.aa?.dps ?? 0;
   if (!range || !(dps > 0)) return { range: 0, dps: 0, bands: [] };
   return {
      range, dps,
      bands: [
         { r: range, dps: dps * 0.6 },
         { r: range * 0.6, dps: dps * 0.7 },
         { r: Math.min(1500, range * 0.35), dps: dps * 0.9 },
      ],
   };
}

// Per-class display stats for the ship picker (menu3d.js). Ratings are 0..100 relative to the
// roster so the menu can draw bars without knowing the raw numbers.
// cfgIn: optional modified copy (career modules/skills, progress3d.applyLoadout).
export function shipStats(key, cfgIn) {
   const c = cfgIn || SHIPS[key];
   if (!c) return null;
   const m = c.main, t = c.torp, w = c.weapons;
   const layout = {};
   for (const tr of m.turrets) layout[tr.guns] = (layout[tr.guns] || 0) + 1;
   const salvo = m.guns * (m.ap || m.he).dmg;
   const rate = (x, lo, hi) => Math.round(Math.max(0, Math.min(1, (x - lo) / (hi - lo))) * 100);
   const a = c.air, aa = aaProfile(c);
   const strike = a ? a.tb.flight * a.tb.weapon.per * a.tb.weapon.dmg + a.db.flight * a.db.weapon.dmg : 0;
   const ssmPunch = w.ssm.reduce((s, x) => s + x.n * MISSILES[x.type].dmg / MISSILES[x.type].evade, 0);
   const samPower = w.sam.reduce((s, x) => s + x.ch * MISSILES[x.type].pk * (MISSILES[x.type].cls === 'area' ? 1.6 : 1), 0) + (w.ciws ? w.ciws.n * 0.6 : 0);
   const missileText = (x) => x.n + '× ' + MISSILES[x.type].name;
   return {
      key, name: c.name, className: c.className, type: c.hull.type, typeName: CLASS_NAMES[c.hull.type],
      tier: c.tier || 0, tierRoman: TIER_ROMAN[c.tier] || '', desc: c.desc || '',
      nation: c.hull.nation, nationName: NATION_NAMES[c.hull.nation] || '', bloc: c.bloc, model: c.model,
      hp: c.hp, speedKn: c.speedKn, lengthM: c.hull.L, beamM: c.hull.beam,
      main: m.guns ? Object.entries(layout).map(([g, n]) => n + '×' + g).join(' + ') + ' · ' + m.caliber + ' mm' : '–',
      mainGuns: m.guns, caliber: m.caliber, reload: m.reload, rangeKm: +(m.range / 1000).toFixed(1),
      traverse180: Math.round(180 / m.traverse), apDmg: m.ap ? m.ap.dmg : 0, heDmg: m.he ? m.he.dmg : 0,
      secRangeKm: c.sec ? +(c.sec.range / 1000).toFixed(1) : 0,
      torp: t ? { tubes: t.tubes, launchers: t.launchers.length, rangeKm: +(t.range / 1000).toFixed(1), speedKn: t.speedKn, dmg: t.dmg, reload: t.reload } : null,
      detectKm: +(c.detect.surface / 1000).toFixed(1), belt: c.armor.belt,
      consumables: c.consumables.map(k => CONSUMABLES[k.key].name),
      air: a ? Object.fromEntries(['tb', 'db', 'ft'].map(k => [k, { name: a[k].name, hangar: a[k].hangar, squad: a[k].squad, speed: a[k].speed }])) : null,
      aaKm: +(aa.range / 1000).toFixed(1), aaDps: Math.round(aa.dps),
      // V2: missile fit as display strings and numbers
      stealth: c.stealth, radarKm: c.radar ? +(c.radar.range / 1000).toFixed(1) : 0, cells: w.cells,
      ssm: w.ssm.map(missileText), cruise: w.cruise ? missileText(w.cruise) : '', sam: w.sam.map(x => missileText(x) + ' (' + x.ch + ' Kanäle)'),
      ciws: w.ciws ? w.ciws.n + '× ' + CIWS[w.ciws.type].name : '', helo: c.helo ? c.helo.name : '',
      ssmRangeKm: w.ssm.length ? +(Math.max(...w.ssm.map(x => MISSILES[x.type].range)) / 1000).toFixed(1) : 0,
      samRangeKm: w.sam.length ? +(Math.max(...w.sam.map(x => MISSILES[x.type].range)) / 1000).toFixed(1) : 0,
      ratings: {
         firepower: a ? rate(strike, 5000, 40000) : Math.max(c.hull.type === 'SS' ? 30 : 0, rate(ssmPunch + salvo * 60 / m.reload * 0.3, 0, 110000)),
         survivability: rate(c.hp, 0, 45000),
         mobility: rate(c.speedKn * 1000 / c.turnR, 25, 110),
         concealment: rate(-c.detect.surface * c.stealth, -11000, -1500),
         torpedoes: t ? rate(t.tubes * t.dmg * 60 / t.reload, 0, 60000) : a ? rate(a.tb.flight * a.tb.weapon.per * a.tb.weapon.dmg, 0, 30000) : w.asw ? 15 : 0,
         antiAir: rate(samPower, 0, 9),
      },
   };
}
export const SHIP_STATS = Object.fromEntries(Object.keys(SHIPS).map(k => [k, shipStats(k)]));
