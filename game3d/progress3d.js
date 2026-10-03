// Career progression for the 3D mode (WoWs-style): XP + credits per battle, ship unlocks,
// per-ship module upgrades and captain skills. Pure data + functions, no DOM; the only side
// effects are loadProfile/saveProfile (localStorage, wrapped in try/catch so the game runs
// without storage). Everything the sim needs is baked into a class config ONCE at ship
// creation (applyLoadout) -- nothing here runs per frame.

export const PROFILE_KEY = 'warships3d.profile.v1';
const LEGACY_KEY = 'warships3d.progress.v1';     // menu3d mission records (held xp/credits before)

// ---------------------------------------------------------------- ship unlocks (tech tree)
// Bismarck (start ship, forced in "Letztes Gefecht") and Hipper stay free. Every other ship is
// researched with XP, bought with credits and may need its predecessor in the tree.
// A ship without a row here (op-only ships such as Washington / Duke of York) is never locked.
// Rows: [ship, XP, credits, predecessor | null]. Nürnberg and Z 23 keep their old XP-only price,
// so profiles saved before the fleet expansion behave exactly as they did.
export const TECH_TREE = [
   // Kriegsmarine
   ['Bismarck', 0, 0, null], ['Hipper', 0, 0, null], ['Nuernberg', 7500, 0, null], ['Z23', 11000, 0, null],
   ['Scharnhorst', 9000, 140000, null], ['Gneisenau', 10500, 150000, 'Scharnhorst'],
   // Royal Navy
   ['Norfolk', 5500, 80000, null], ['Fiji', 8500, 130000, 'Norfolk'], ['Jervis', 8000, 120000, null],
   ['Warspite', 6500, 90000, null], ['Hood', 9500, 140000, 'Warspite'], ['Rodney', 10000, 150000, 'Warspite'], ['KGV', 11500, 160000, 'Rodney'],
   // US Navy
   ['Benham', 5500, 80000, null], ['Fletcher', 24000, 350000, 'Benham'], ['Cleveland', 14000, 220000, null], ['Iowa', 26000, 380000, 'Cleveland'],
   // Kaiserliche Marine
   ['Kirishima', 4500, 60000, null], ['Yamato', 38000, 550000, 'Kirishima'], ['Takao', 14500, 220000, null],
   ['Fubuki', 5500, 80000, null], ['Shimakaze', 34000, 500000, 'Fubuki'],
   // Marine nationale
   ['Algerie', 9000, 130000, null], ['Richelieu', 16000, 240000, 'Algerie'], ['LeFantasque', 13000, 200000, null],
   // Regia Marina
   ['Zara', 9000, 130000, null], ['Littorio', 15500, 230000, 'Zara'],
   // Sowjetische Marine
   ['Gnevny', 5500, 80000, null], ['Kirov', 6500, 90000, null],
   // U-Boote
   ['U96', 7000, 100000, null], ['U505', 15000, 230000, 'U96'], ['Triton', 7000, 100000, null],
   ['Gato', 15000, 230000, null], ['I19', 11000, 170000, null], ['S13', 11000, 170000, null],
   // Flugzeugträger
   ['GrafZeppelin', 16000, 240000, null], ['ArkRoyal', 9000, 130000, null], ['Illustrious', 14000, 210000, 'ArkRoyal'],
   ['Enterprise', 15000, 220000, null], ['Essex', 27000, 400000, 'Enterprise'],
   ['Akagi', 15000, 220000, null], ['Shokaku', 22000, 320000, 'Akagi'], ['Bearn', 6000, 90000, null],
];
export const UNLOCK_XP = Object.fromEntries(TECH_TREE.map(r => [r[0], r[1]]));
export const UNLOCK_CREDITS = Object.fromEntries(TECH_TREE.map(r => [r[0], r[2]]));
export const UNLOCK_REQ = Object.fromEntries(TECH_TREE.map(r => [r[0], r[3]]));

// ---------------------------------------------------------------- modules (credits)
// Each module has 3 tiers bought in order; values are fractional changes of the stock stat.
export const MODULES = [
   { key: 'main', name: 'Hauptbatterie', tiers: [{ reload: -0.03, disp: -0.02 }, { reload: -0.05, disp: -0.04 }, { reload: -0.08, disp: -0.06 }] },
   { key: 'engine', name: 'Antrieb', tiers: [{ speed: 0.02, accel: 0.04 }, { speed: 0.03, accel: 0.07 }, { speed: 0.05, accel: 0.10 }] },
   { key: 'rudder', name: 'Ruderanlage', tiers: [{ rudder: -0.04 }, { rudder: -0.07 }, { rudder: -0.10 }] },
   { key: 'hull', name: 'Rumpf', tiers: [{ hp: 0.03 }, { hp: 0.06 }, { hp: 0.09 }] },
   { key: 'fcs', name: 'Feuerleitung', tiers: [{ range: 0.02 }, { range: 0.04 }, { range: 0.06 }] },
];
export const MODULE_COST = [40000, 90000, 180000];      // credits for tier 1..3

// ---------------------------------------------------------------- captain skills (points)
export const SKILLS = [
   { key: 'prep', name: 'Eingespielte Trupps', cost: 1, desc: 'Sonderausrüstung −10 % Bereitschaftszeit', fx: { consCd: -0.10 } },
   { key: 'vigil', name: 'Ausguck', cost: 1, desc: 'Torpedos +15 % früher erkannt', fx: { torpSpot: 0.15 } },
   { key: 'fireprot', name: 'Feuerwache', cost: 1, desc: 'Brände −10 % Dauer', fx: { fireDur: -0.10 } },
   { key: 'sniper', name: 'Zielschießen', cost: 2, desc: 'Hauptbatterie −5 % Streuung', fx: { disp: -0.05 } },
   { key: 'adren', name: 'Letzte Reserven', cost: 2, desc: 'Bis −10 % Nachladezeit bei schwerem Schaden', fx: { adrenaline: 0.10 } },
   { key: 'survive', name: 'Verstärkte Schotten', cost: 2, desc: '+5 % Trefferpunkte', fx: { hp: 0.05 } },
   { key: 'gunner', name: 'Geübte Turmbesatzung', cost: 2, desc: 'Türme drehen 10 % schneller', fx: { traverse: 0.10 } },
   { key: 'pyro', name: 'Zünderkunde', cost: 3, desc: 'Brandchance +10 % (relativ)', fx: { fireChance: 0.10 } },
   { key: 'torpx', name: 'Flinke Torpedomixer', cost: 3, desc: 'Torpedos −8 % Nachladezeit', fx: { torpReload: -0.08 } },
   { key: 'conceal', name: 'Tarnanstrich', cost: 3, desc: 'Entdeckungsreichweite −8 %', fx: { detect: -0.08 } },
   // top tier (WoWs: 4 points): a trade-off, not a flat buff -- the secondaries only engage the
   // Ctrl+click target (none set = silent), but shoot much tighter (MANUAL_SEC_DISP per class)
   { key: 'manualSec', name: 'Einzelzielfeuer der Mittelartillerie', cost: 4, top: true,
      desc: 'Mittelartillerie feuert nur auf das Strg+Klick-Ziel, dafür bis −55 % Streuung', fx: { manualSec: 1 } },
];
// Secondary dispersion cut of the top skill "Einzelzielfeuer der Mittelartillerie" (key manualSec) by hull class.
export const MANUAL_SEC_DISP = { BB: 0.55, CA: 0.35, CL: 0.30, DD: 0.15 };
// Captain level L needs CAPTAIN_XP[L] lifetime XP and grants L skill points (max 11 of 24 total cost).
export const CAPTAIN_XP = [0, 1500, 4000, 7500, 12000, 17500, 24000, 32000, 41000, 52000, 65000, 80000];

// ---------------------------------------------------------------- profile
export function defaultProfile() {
   return { v: 1, xp: 0, totalXp: 0, credits: 0, battles: 0, unlocked: {}, modules: {}, skills: [] };
}
const num = (x) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);

// Accepts anything (parsed JSON, garbage, older shapes) and returns a valid profile.
export function sanitizeProfile(raw) {
   const p = defaultProfile();
   if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return p;
   p.xp = num(raw.xp); p.credits = num(raw.credits); p.battles = num(raw.battles);
   p.totalXp = Math.max(num(raw.totalXp), p.xp);
   if (raw.unlocked && typeof raw.unlocked === 'object') for (const k in raw.unlocked) if (raw.unlocked[k] === true && k in UNLOCK_XP) p.unlocked[k] = true;
   if (raw.modules && typeof raw.modules === 'object') {
      for (const ship in raw.modules) {
         const m = raw.modules[ship];
         if (!m || typeof m !== 'object') continue;
         const out = {};
         for (const d of MODULES) { const t = Math.min(num(m[d.key]), d.tiers.length); if (t) out[d.key] = t; }
         if (Object.keys(out).length) p.modules[ship] = out;
      }
   }
   if (Array.isArray(raw.skills)) {
      let pts = captainLevel(p.totalXp).level;
      for (const k of raw.skills) {
         const s = SKILLS.find(x => x.key === k);
         if (s && !p.skills.includes(k) && s.cost <= pts) { p.skills.push(k); pts -= s.cost; }
      }
   }
   return p;
}

function store(storage) {
   try { return storage !== undefined ? storage : globalThis.localStorage || null; } catch (e) { return null; }
}
export function loadProfile(storage) {
   const s = store(storage);
   if (!s) return defaultProfile();
   try {
      const raw = s.getItem(PROFILE_KEY);
      if (raw) return sanitizeProfile(JSON.parse(raw));
      // first run with this version: carry over XP/credits the older menu kept in its mission record
      const old = JSON.parse(s.getItem(LEGACY_KEY) || 'null');
      if (old && typeof old === 'object') return sanitizeProfile({ xp: old.xp, totalXp: old.xp, credits: old.credits });
   } catch (e) { /* broken JSON / blocked storage: start fresh */ }
   return defaultProfile();
}
export function saveProfile(p, storage) {
   const s = store(storage);
   try { if (s) s.setItem(PROFILE_KEY, JSON.stringify(p)); return !!s; } catch (e) { return false; }
}

// ---------------------------------------------------------------- rules
export function captainLevel(totalXp) {
   let level = 0;
   while (level + 1 < CAPTAIN_XP.length && totalXp >= CAPTAIN_XP[level + 1]) level++;
   const max = level === CAPTAIN_XP.length - 1;
   return { level, points: level, cur: CAPTAIN_XP[level], next: max ? null : CAPTAIN_XP[level + 1] };
}
export function skillPointsUsed(p) { return p.skills.reduce((a, k) => a + (SKILLS.find(s => s.key === k)?.cost || 0), 0); }
export function skillPointsFree(p) { return captainLevel(p.totalXp).points - skillPointsUsed(p); }

export function isUnlocked(p, ship) { return !UNLOCK_XP[ship] || !!p.unlocked[ship]; }
// Why a locked ship cannot be researched yet: { req: missing predecessor | null, xp, credits: shortfall }.
export function unlockNeeds(p, ship) {
   const req = UNLOCK_REQ[ship];
   return {
      req: req && !isUnlocked(p, req) ? req : null,
      xp: Math.max(0, (UNLOCK_XP[ship] || 0) - p.xp), credits: Math.max(0, (UNLOCK_CREDITS[ship] || 0) - p.credits),
   };
}
export function canUnlock(p, ship) {
   if (isUnlocked(p, ship)) return false;
   const n = unlockNeeds(p, ship);
   return !n.req && !n.xp && !n.credits;
}
export function unlockShip(p, ship) {
   if (!canUnlock(p, ship)) return false;
   p.xp -= UNLOCK_XP[ship]; p.credits -= UNLOCK_CREDITS[ship] || 0; p.unlocked[ship] = true;
   return true;
}

export function moduleTier(p, ship, mod) { return p.modules[ship]?.[mod] || 0; }
// Next purchasable tier's price, or 0 when the module is maxed.
export function moduleCost(p, ship, mod) {
   const t = moduleTier(p, ship, mod), d = MODULES.find(m => m.key === mod);
   return d && t < d.tiers.length ? MODULE_COST[t] : 0;
}
export function buyModule(p, ship, mod) {
   const cost = moduleCost(p, ship, mod);
   if (!cost || p.credits < cost || !isUnlocked(p, ship)) return false;
   p.credits -= cost;
   (p.modules[ship] = p.modules[ship] || {})[mod] = moduleTier(p, ship, mod) + 1;
   return true;
}

export function learnSkill(p, key) {
   const s = SKILLS.find(x => x.key === key);
   if (!s || p.skills.includes(key) || s.cost > skillPointsFree(p)) return false;
   p.skills.push(key);
   return true;
}
export function respecSkills(p) { const n = p.skills.length; p.skills = []; return n > 0; }

// ---------------------------------------------------------------- rewards
// in: { victory, stats (World.stats), rewardMult, alive, objectives }
// out: { xp, credits, lines: [{ label, xp, credits }] } -- lines already include the difficulty factor.
export function calcRewards({ victory, stats = {}, rewardMult = 1, alive = false, objectives = [] }) {
   const st = stats, raw = [];
   const add = (label, xp, cr = 0) => { if (xp > 0 || cr > 0) raw.push({ label, xp, cr: xp * 40 + cr }); };
   add('Grundwert', 450);
   if (victory) add('Siegbonus', 650);
   add('Schaden', (st.dmg || 0) * 0.018 + (st.citadels || 0) * 12, (st.dmg || 0) * 1.0);
   add('Versenkt', (st.kills || 0) * 160, (st.kills || 0) * 6000);
   add('Aufklärung & Tanken', (st.spottingDmg || 0) * 0.008 + (st.potential || 0) * 0.0015);
   let obj = (st.caps || 0) * 120;
   for (const o of objectives) if (o.state === 'done') obj += o.optional ? 250 : 100;
   add('Missionsziele', obj);
   if (alive) add('Überlebt', 150);
   const k = Number.isFinite(rewardMult) && rewardMult > 0 ? rewardMult : 1;
   const lines = raw.map(l => ({ label: l.label, xp: Math.round(l.xp * k), credits: Math.round(l.cr * k) }));
   return {
      xp: lines.reduce((a, l) => a + l.xp, 0), credits: lines.reduce((a, l) => a + l.credits, 0), mult: k, lines,
   };
}
export function grantRewards(p, r) {
   const xp = num(r?.xp), cr = num(r?.credits);
   p.xp += xp; p.totalXp += xp; p.credits += cr; p.battles++;
   return p;
}

// ---------------------------------------------------------------- stat pipeline
// Snapshot handed to the World: { modules: { main: 2, ... }, skills: ['sniper', ...] }.
export function loadoutFor(p, ship) {
   return { modules: { ...(p?.modules?.[ship] || {}) }, skills: [...(p?.skills || [])] };
}
// Summed fractional modifiers of a loadout.
export function loadoutMods(lo) {
   const f = {};
   const addAll = (o) => { for (const k in o) f[k] = (f[k] || 0) + o[k]; };
   for (const d of MODULES) { const t = lo?.modules?.[d.key] || 0; if (t > 0) addAll(d.tiers[Math.min(t, d.tiers.length) - 1]); }
   for (const k of lo?.skills || []) { const s = SKILLS.find(x => x.key === k); if (s) addAll(s.fx); }
   return f;
}
// Returns a modified deep copy of a (normalised) class config, or the config itself when the
// loadout changes nothing. Ballistics: the shell velocity is kept, so a longer range only
// extends the trajectory instead of making the guns faster.
export function applyLoadout(cfg, lo) {
   const f = loadoutMods(lo);
   if (!Object.keys(f).length) return cfg;
   const c = structuredClone(cfg);
   const mul = (x) => 1 + (f[x] || 0);
   c.hp = Math.round(c.hp * mul('hp'));
   c.speedKn = +(c.speedKn * mul('speed')).toFixed(2);
   c.maxSpeed = cfg.maxSpeed * mul('speed');
   c.accel = c.accel / mul('accel');                // accel = seconds to full speed
   c.rudderShift = c.rudderShift * mul('rudder');
   c.detect = { ...c.detect, surface: Math.round(c.detect.surface * mul('detect')) };
   const m = c.main;
   if (m) {
      m.reload = +(m.reload * mul('reload')).toFixed(2);
      m.dispH = m.dispH * mul('disp');
      m.traverse = m.traverse * mul('traverse'); m.traverseRad = cfg.main.traverseRad * mul('traverse');
      if (f.range) {
         const K = mul('range');
         m.range = Math.round(m.range * K);
         m.tMax = m.tMax * K;                        // first-order: same muzzle velocity (vShell kept)
      }
      if (m.he && f.fireChance) m.he.fire = m.he.fire * mul('fireChance');
   }
   if (c.sec && c.sec.he && f.fireChance) c.sec.he.fire = c.sec.he.fire * mul('fireChance');
   if (f.manualSec) {
      c.manualSec = true;
      if (c.sec) c.sec.dispH = c.sec.dispH * (1 - (MANUAL_SEC_DISP[c.hull.type] || 0));
   }
   if (c.torp && f.torpReload) { c.torp.reload = +(c.torp.reload * mul('torpReload')).toFixed(1); c.torp.cd = c.torp.reload; }
   if (f.consCd) c.consumables = c.consumables.map(k => ({ ...k, cd: Math.round(k.cd * mul('consCd')) }));
   if (f.fireDur) c.fireDur = mul('fireDur');
   if (f.torpSpot) c.torpSpot = mul('torpSpot');
   if (f.adrenaline) c.adrenaline = f.adrenaline;
   return c;
}
