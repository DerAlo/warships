// game/daily.js — "Tägliche Herausforderung": one battle per calendar day, generated from a seed
// derived from the local date, so every player gets the same map, enemy waves and modifier.
// Everything that shapes the setup comes from makeRng(seedFor(date)) -- never Math.random.
// Plus the score formula and a local top-10 leaderboard per day (localStorage, fully guarded).
import { makeRng, TAU } from './utils.js';
import { survivalWave, SURV_POOL, SURV_POINTS } from './missions.js';

// ---------- date & seed ----------
const pad = (n) => String(n).padStart(2, '0');
// local calendar date as YYYY-MM-DD (the day rolls over at local midnight)
export function dateKey(d = new Date()) {
   return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// the key `days` away from `key` (negative = past)
export function shiftKey(key, days) {
   const [y, m, d] = key.split('-').map(Number);
   return dateKey(new Date(y, m - 1, d + days));
}
export function formatKey(key) {
   const [y, m, d] = key.split('-');
   return `${d}.${m}.${y}`;
}
// FNV-1a over the date string: stable across browsers and platforms
export function seedFor(key) {
   let h = 0x811c9dc5;
   const s = 'warships-daily:' + key;
   for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
   return h >>> 0;
}

// ---------- modifiers ----------
export const DAILY_MODS = [
   { id: 'fog', icon: '🌫', name: 'Dichter Nebel', text: 'Die Sichtweite ist fast halbiert — Gegner tauchen erst spät aus dem Dunst auf.', env: 'fog' },
   { id: 'storm', icon: '⛈', name: 'Sturm', text: 'Schwere See: Regenböen verdecken die Sicht, die Salven streuen stärker.', env: 'storm', squalls: 5 },
   { id: 'double', icon: '👥', name: 'Doppelte Gegner', text: 'Jede Welle ist doppelt so groß — dafür halten die Feinde nur gut die Hälfte aus.', double: true },
   { id: 'torps', icon: '🐟', name: 'Nur Torpedos', text: 'Die Hauptartillerie schweigt. Torpedos laden dreimal so schnell, es kommen nur leichte Schiffe.', noMain: true, torpCd: 0.33, light: true },
   { id: 'glass', icon: '💥', name: 'Glaskanonen', text: 'Alle Schiffe richten 60 % mehr Schaden an — kurze, harte Gefechte.', dmg: 1.6 },
];
const LIGHT = ['TB', 'DD', 'LC', 'ML'];

// ---------- generator ----------
const isl = (x, y, r) => ({ kind: 'island', c: { x, y }, r, irregular: true });
const reef = (x, y, r) => ({ kind: 'reef', c: { x, y }, r });

function genObstacles(rng) {
   const out = [];
   const n = 5 + Math.floor(rng() * 3);
   for (let tries = 0; out.length < n && tries < 200; tries++) {
      const a = rng() * TAU, d = 900 + rng() * 2300;
      const island = rng() < 0.65;
      const r = island ? 240 + rng() * 180 : 200 + rng() * 100;
      const x = Math.round(Math.cos(a) * d), y = Math.round(Math.sin(a) * d);
      if (Math.hypot(x, y) < r + 650) continue;                          // keep the start clear
      if (out.some(o => Math.hypot(o.c.x - x, o.c.y - y) < o.r + r + 380)) continue; // navigable gaps
      out.push(island ? isl(x, y, Math.round(r)) : reef(x, y, Math.round(r)));
   }
   return out;
}

// The day's mission (same shape as missions.js entries, run by the Director).
export function buildDaily(key = dateKey()) {
   const seed = seedFor(key);
   const rng = makeRng(seed);
   const mod = DAILY_MODS[Math.floor(rng() * DAILY_MODS.length)];
   const obstacles = genObstacles(rng);
   const heading = rng() * TAU - Math.PI;
   const pool = mod.light ? SURV_POOL.filter(p => LIGHT.includes(p.cls)) : SURV_POOL;
   const base = 2 + Math.floor(rng() * 2);
   const center = { x: 0, y: 0 };
   const waves = [0, 1, 2].map(i => {
      let specs = survivalWave(base + i * 2, center, (seed ^ ((i + 1) * 0x9e3779b1)) >>> 0, obstacles, pool);
      // at most one carrier per wave: two air wings at once is a wall, not a challenge
      let cv = 0;
      specs = specs.map(s => (s.cls === 'CV' && cv++ > 0 ? { ...s, cls: 'HC' } : s));
      if (mod.double) specs = specs.flatMap(s => [{ ...s, hpMult: 0.55 }, { ...s, hpMult: 0.55, pos: { x: s.pos.x + 160, y: s.pos.y + 160 } }]);
      return specs;
   });
   return {
      id: 'daily', num: 0, daily: true, dateKey: key, seed, mod,
      title: 'Tägliche Herausforderung', tag: formatKey(key),
      briefing: `Heute für alle Kapitäne gleich: dieselbe Karte, dieselben drei Angriffswellen. Tagesmodifikator ${mod.icon} ${mod.name} — ${mod.text}`,
      player: { cls: 'Bismarck', pos: { x: 0, y: 0 }, heading },
      obstacles,
      env: mod.env || 'clear',
      squalls: mod.squalls || 0,
      mods: { noMain: !!mod.noMain, torpCd: mod.torpCd || 1, dmg: mod.dmg || 1 },
      bots: waves[0],
      waves: [
         { when: 'cleared', msg: '⚠ Zweite Welle im Anmarsch!', bots: waves[1] },
         { when: 'cleared', msg: '⚠ Letzte Welle — alles oder nichts!', bots: waves[2] },
      ],
      objectives: [{ type: 'sinkAll', text: 'Alle drei Wellen versenken' }],
      stars: [],
      hints: [{ at: 1, text: `${mod.icon} Tagesmodifikator: ${mod.name}` }],
   };
}

// ---------- score ----------
// Sunk ships (survival point values) always count; a win adds a time bonus (faster = more), the
// remaining hull and main-battery accuracy.
export function dailyScore(world) {
   const p = world.player, won = world.phase === 'won';
   const kills = world.bots.filter(b => !b.alive && !b.escaped).reduce((a, b) => a + (SURV_POINTS[b.cls] || 100), 0);
   const time = won ? Math.max(0, Math.round((600 - world.time) * 3)) : 0;
   const hull = won ? Math.round(Math.max(0, p.hp / p.maxHP) * 1000) : 0;
   const acc = p.shotsFired ? Math.round(500 * p.shotsHit / p.shotsFired) : 0;
   return { kills, time, hull, acc, total: kills + time + hull + acc, won };
}

// ---------- local leaderboard ----------
const KEY = 'warships2d.daily.v1';
const KEEP_DAYS = 14;
export const DEFAULT_NAME = 'Kapitän';

function defaultStorage() {
   try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}
export function loadBoard(storage = defaultStorage()) {
   const b = { name: DEFAULT_NAME, days: {} };
   try {
      const raw = storage && storage.getItem(KEY);
      const d = raw ? JSON.parse(raw) : null;
      if (d && typeof d === 'object') {
         if (typeof d.name === 'string' && d.name.trim()) b.name = d.name.slice(0, 16);
         if (d.days && typeof d.days === 'object') {
            for (const [k, list] of Object.entries(d.days)) {
               if (Array.isArray(list)) b.days[k] = list.filter(e => e && typeof e.score === 'number').slice(0, 10);
            }
         }
      }
   } catch { /* corrupt or unavailable: empty board */ }
   return b;
}
export function saveBoard(b, storage = defaultStorage()) {
   try { if (storage) storage.setItem(KEY, JSON.stringify(b)); return true; } catch { return false; }
}
// Insert a result; keeps the day's top 10 and the last KEEP_DAYS days. Returns the 0-based rank
// (-1 if it did not make the list).
export function recordDaily(b, key, entry) {
   const list = (b.days[key] || []).slice();
   const e = { name: (entry.name || b.name || DEFAULT_NAME).slice(0, 16), score: entry.score | 0, won: !!entry.won, time: Math.round(entry.time || 0), id: entry.id ?? Date.now() };
   list.push(e);
   list.sort((x, y) => y.score - x.score || x.time - y.time);
   b.days[key] = list.slice(0, 10);
   const keys = Object.keys(b.days).sort();
   while (keys.length > KEEP_DAYS) delete b.days[keys.shift()];
   return b.days[key].indexOf(e);
}
export function renameEntry(b, key, id, name) {
   const n = (name || '').trim().slice(0, 16) || DEFAULT_NAME;
   b.name = n;
   const e = (b.days[key] || []).find(x => x.id === id);
   if (e) e.name = n;
}
export function dayList(b, key) { return b.days[key] || []; }
// the best entry of `name` on that day (the highlighted row)
export function bestOf(b, key, name = b.name) {
   return dayList(b, key).find(e => e.name === name) || null;
}
