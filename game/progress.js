// game/progress.js — campaign progress (stars per mission, survival highscores, last difficulty)
// in localStorage. Every access is guarded: private mode / blocked storage just means nothing is
// remembered, the game itself keeps working. The storage object is injectable for tests.
import { MISSIONS } from './missions.js';

const KEY = 'warships2d.progress.v1';

function defaultStorage() {
   try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

function blank() { return { stars: {}, survivalBest: {}, difficulty: 'normal' }; }

export function loadProgress(storage = defaultStorage()) {
   const p = blank();
   try {
      const raw = storage && storage.getItem(KEY);
      if (!raw) return p;
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') {
         if (d.stars && typeof d.stars === 'object') for (const [k, v] of Object.entries(d.stars)) p.stars[k] = Math.max(0, Math.min(3, v | 0));
         if (d.survivalBest && typeof d.survivalBest === 'object') p.survivalBest = { ...d.survivalBest };
         if (typeof d.difficulty === 'string') p.difficulty = d.difficulty;
      }
   } catch { /* corrupt or unavailable: start fresh */ }
   return p;
}

export function saveProgress(p, storage = defaultStorage()) {
   try { if (storage) storage.setItem(KEY, JSON.stringify(p)); return true; } catch { return false; }
}

// Mission i is open once the one before it has been won (any star count). The first is always open.
export function isUnlocked(p, idx) {
   if (idx <= 0) return true;
   const prev = MISSIONS[idx - 1];
   return !!prev && (p.stars[prev.id] || 0) > 0;
}

// Keep the best result. Returns true when it improved on the stored one.
export function recordStars(p, id, stars) {
   if (stars <= (p.stars[id] || 0)) return false;
   p.stars[id] = stars;
   return true;
}
export function recordSurvival(p, difficulty, wave, score) {
   const best = p.survivalBest[difficulty];
   if (best && best.score >= score) return false;
   p.survivalBest[difficulty] = { wave, score };
   return true;
}
export function totalStars(p) {
   return MISSIONS.reduce((a, m) => a + (p.stars[m.id] || 0), 0);
}
