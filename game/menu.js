// game/menu.js — mission select: a card grid with procedural map thumbnails, the briefing panel
// (objectives, star criteria, forces), difficulty chips and the star total. Pure DOM; main.js
// passes callbacks and owns the game flow.
import { MISSIONS, SURVIVAL } from './missions.js';
import { SHIPS, WORLD, ENCOUNTER, OBSTACLES } from './config.js';
import { isUnlocked, totalStars } from './progress.js';

const $ = (id) => document.getElementById(id);
const fmtTime = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

// the legacy one-shot battle stays available as a mode card
export const SKIRMISH = {
   id: 'skirmish', num: 0, title: 'Freies Gefecht', tag: 'Klassisch',
   briefing: 'Das klassische Duell: ein feindliches Linienschiff mit Kreuzern und Zerstörern auf dem Spawn-Ring. Nach 60 s laufen Verstärkungen ein. Keine Sterne — nur Ruhm.',
   player: { pos: { x: 0, y: 0 } }, bots: ENCOUNTER.bots, obstacles: OBSTACLES, skirmish: true,
};
const ENTRIES = [...MISSIONS, SURVIVAL, SKIRMISH];

const ENV_LABEL = { night: '🌙 Nacht — Sicht halbiert', storm: '⛈ Sturm — Regenböen, Streuung' };

export function starCriterionText(c) {
   switch (c.type) {
      case 'hp': return c.text || `Rumpf mindestens ${Math.round(c.min * 100)} %`;
      case 'time': return c.text || `Sieg in unter ${fmtTime(c.max)} min`;
      case 'alliesAlive': return c.text || 'Alle Verbündeten überleben';
      default: return c.text || '';
   }
}

// every enemy the mission will field, initial plus waves, as "n× Klasse"
function forces(m, key) {
   const count = new Map();
   const addSpec = (s) => {
      const name = key === 'allies' ? (s.name || SHIPS[s.cls].name) : SHIPS[s.cls].name;
      count.set(name, (count.get(name) || 0) + 1);
   };
   for (const s of m[key] || []) addSpec(s);
   for (const wv of m.waves || []) for (const s of wv[key] || []) addSpec(s);
   return [...count].map(([n, c]) => (c > 1 ? `${c}× ` : '') + n);
}

export class Menu {
   // cb: { onPlay(id), onDifficulty(key), onClick() }
   constructor(progress, cb) {
      this.progress = progress;
      this.cb = cb;
      this.sel = null;
      this.grid = $('mission-grid');
      this._build();
      document.querySelectorAll('.chip[data-diff]').forEach(ch => {
         ch.addEventListener('click', () => {
            this.setDifficulty(ch.dataset.diff);
            cb.onDifficulty(ch.dataset.diff);
            cb.onClick();
         });
      });
      this.setDifficulty(progress.difficulty || 'normal');
   }

   setDifficulty(key) {
      document.querySelectorAll('.chip[data-diff]').forEach(c => c.classList.toggle('sel', c.dataset.diff === key));
   }

   _build() {
      this.grid.innerHTML = '';
      this.cards = new Map();
      ENTRIES.forEach((m) => {
         const el = document.createElement('div');
         el.className = 'mcard' + (m.survival || m.skirmish ? ' mode' : '') + (m.id === 'm9' ? ' boss' : '');
         el.dataset.id = m.id;
         const cv = document.createElement('canvas');
         cv.width = 240; cv.height = 90;
         drawThumb(cv, m);
         el.appendChild(cv);
         el.insertAdjacentHTML('beforeend',
            `<div class="mc-num">${m.num ? String(m.num).padStart(2, '0') : m.survival ? '∞' : '⚔'}</div>` +
            '<div class="mc-stars"></div>' +
            `<div class="mc-body"><div class="mc-title"></div><div class="mc-tag"></div></div>`);
         el.querySelector('.mc-title').textContent = m.title;
         el.querySelector('.mc-tag').textContent = m.tag;
         el.addEventListener('click', () => {
            if (el.classList.contains('locked')) return;
            this.select(m.id);
            this.cb.onClick();
         });
         el.addEventListener('dblclick', () => { if (!el.classList.contains('locked')) this.cb.onPlay(m.id); });
         this.grid.appendChild(el);
         this.cards.set(m.id, el);
      });
   }

   // refresh lock/star state (after a finished mission) and pick a sensible default selection
   refresh(prefer = null) {
      const p = this.progress;
      let firstOpen = null, lastOpen = MISSIONS[0].id;
      MISSIONS.forEach((m, i) => {
         const el = this.cards.get(m.id);
         const open = isUnlocked(p, i);
         const st = p.stars[m.id] || 0;
         el.classList.toggle('locked', !open);
         el.querySelector('.mc-stars').innerHTML = [0, 1, 2].map(k => `<span class="${k < st ? 'on' : ''}">★</span>`).join('');
         if (open) { lastOpen = m.id; if (!st && !firstOpen) firstOpen = m.id; }
      });
      // survival card shows the best wave on this difficulty
      const best = p.survivalBest[p.difficulty];
      this.cards.get('survival').querySelector('.mc-stars').textContent = best ? `W${best.wave}` : '';
      $('star-total').textContent = `${totalStars(p)} / ${MISSIONS.length * 3}`;
      const want = prefer && this.cards.has(prefer) && !this.cards.get(prefer).classList.contains('locked') ? prefer : (this.sel && !this.cards.get(this.sel).classList.contains('locked') ? this.sel : firstOpen || lastOpen);
      this.select(want);
   }

   select(id) {
      this.sel = id;
      for (const [k, el] of this.cards) el.classList.toggle('sel', k === id);
      const m = ENTRIES.find(e => e.id === id);
      const p = this.progress;
      $('brief-tag').textContent = m.num ? `Einsatz ${m.num} · ${m.tag}` : m.tag;
      $('brief-title').textContent = m.title;
      $('brief-text').textContent = m.briefing;
      const objs = m.skirmish ? ['Alle Feindschiffe versenken'] : m.survival ? ['So viele Wellen wie möglich überstehen', 'Punkte für jedes versenkte Schiff und jede Welle']
         : (m.objectives || []).map(o => o.text);
      $('brief-obj').innerHTML = '';
      for (const t of objs) { const li = document.createElement('li'); li.textContent = '▸ ' + t; $('brief-obj').appendChild(li); }
      const starsUl = $('brief-stars');
      starsUl.innerHTML = '';
      const hdr = $('brief-stars-h');
      if (m.survival) {
         const best = p.survivalBest[p.difficulty];
         hdr.textContent = 'Rekord';
         const li = document.createElement('li');
         li.className = best ? 'ok' : '';
         li.textContent = best ? `🏅 Welle ${best.wave} · ${best.score} Punkte` : 'Noch kein Rekord auf dieser Stufe';
         starsUl.appendChild(li);
      } else if (m.skirmish) {
         hdr.textContent = 'Sterne';
         const li = document.createElement('li'); li.textContent = 'Keine Wertung'; starsUl.appendChild(li);
      } else {
         const st = p.stars[m.id] || 0;
         hdr.textContent = `Sterne · Bestwert ${'★'.repeat(st)}${'☆'.repeat(3 - st)}`;
         const crit = ['Mission gewinnen', ...(m.stars || []).map(starCriterionText)];
         crit.forEach((t) => { const li = document.createElement('li'); li.textContent = '★ ' + t; starsUl.appendChild(li); });
      }
      const chips = $('brief-forces');
      chips.innerHTML = '';
      const chip = (t, cls = '') => { const s = document.createElement('span'); s.className = 'echip ' + cls; s.textContent = t; chips.appendChild(s); };
      if (m.survival) chip('Endlose Wellen · alle Klassen');
      else for (const t of forces(m, 'bots')) chip(t);
      for (const t of forces(m, 'allies')) chip('⚓ ' + t, 'ally');
      if (ENV_LABEL[m.env]) chip(ENV_LABEL[m.env], 'env');
      if ((m.minefields && m.minefields.length) || (m.mines && m.mines.length)) chip('💣 Minenfelder', 'env');
      $('btn-play').textContent = m.survival ? '🌊 WELLEN STARTEN' : '⚓ AUSLAUFEN';
   }
}

// ---------- procedural map thumbnail ----------
function drawThumb(cv, m) {
   const g = cv.getContext('2d');
   const W = cv.width, H = cv.height, A = WORLD.ARENA;
   const night = m.env === 'night', storm = m.env === 'storm';
   const grd = g.createLinearGradient(0, 0, 0, H);
   grd.addColorStop(0, night ? '#0a1628' : storm ? '#2c3a44' : '#164a6e');
   grd.addColorStop(1, night ? '#050b16' : storm ? '#1b262e' : '#0c3050');
   g.fillStyle = grd; g.fillRect(0, 0, W, H);
   // show the full map width; centre vertically on the action (player + enemies)
   const sc = W / (2 * A);
   const pts = [m.player && m.player.pos, ...(m.bots || []).map(b => b.pos)].filter(Boolean);
   const cy = pts.length ? pts.reduce((a, p) => a + p.y, 0) / pts.length : 0;
   const oy = Math.max(-A + H / 2 / sc, Math.min(A - H / 2 / sc, cy));
   const X = (x) => W / 2 + x * sc, Y = (y) => H / 2 + (y - oy) * sc;
   // subtle grid
   g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 1;
   for (let k = -A; k <= A; k += 1000) { g.beginPath(); g.moveTo(X(k), 0); g.lineTo(X(k), H); g.stroke(); g.beginPath(); g.moveTo(0, Y(k)); g.lineTo(W, Y(k)); g.stroke(); }
   for (const o of m.obstacles || []) {
      if (o.kind === 'reef') {
         g.fillStyle = 'rgba(120,200,210,0.28)';
         g.beginPath(); g.arc(X(o.c.x), Y(o.c.y), o.r * sc, 0, Math.PI * 2); g.fill();
      } else {
         g.fillStyle = night ? '#3a4030' : '#6b7a4a';
         g.beginPath(); g.arc(X(o.c.x), Y(o.c.y), o.r * sc, 0, Math.PI * 2); g.fill();
         g.fillStyle = night ? '#4a4a38' : '#8a8a5a';
         g.beginPath(); g.arc(X(o.c.x) - o.r * sc * 0.2, Y(o.c.y) - o.r * sc * 0.2, o.r * sc * 0.55, 0, Math.PI * 2); g.fill();
      }
   }
   for (const z of m.zones || []) {
      g.setLineDash([3, 3]);
      g.strokeStyle = z.kind === 'goal' ? '#7cff9a' : '#ff8a6a'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(X(z.c.x), Y(z.c.y), Math.max(4, z.r * sc), 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
   }
   for (const f of m.minefields || []) {
      g.fillStyle = 'rgba(255,80,60,0.18)';
      g.beginPath(); g.arc(X(f.c.x), Y(f.c.y), f.r * sc, 0, Math.PI * 2); g.fill();
   }
   const dot = (s, col, r = 2.4) => {
      if (!s.pos && s.bearing != null) s = { pos: { x: Math.cos(s.bearing) * ENCOUNTER.ring, y: Math.sin(s.bearing) * ENCOUNTER.ring } };
      if (!s.pos) return; g.fillStyle = col; g.beginPath(); g.arc(X(s.pos.x), Y(s.pos.y), r, 0, Math.PI * 2); g.fill(); };
   for (const b of m.bots || []) dot(b, b.cls === 'BOSS' ? '#ff5040' : b.cls === 'CB' ? '#ffb070' : '#ff7a6a', b.cls === 'BOSS' ? 4.5 : 2.4);
   for (const a of m.allies || []) dot(a, '#7cff9a');
   if (m.player && m.player.pos) {
      const px = X(m.player.pos.x), py = Y(m.player.pos.y);
      g.fillStyle = '#ffd479'; g.strokeStyle = '#000'; g.lineWidth = 1;
      g.beginPath(); g.arc(px, py, 3.6, 0, Math.PI * 2); g.fill(); g.stroke();
   }
   if (night) {
      g.fillStyle = 'rgba(255,255,255,0.6)';
      for (let i = 0; i < 14; i++) g.fillRect((i * 97) % W, (i * 53) % (H * 0.5), 1, 1);
   }
   if (storm) {
      g.strokeStyle = 'rgba(200,220,235,0.18)'; g.lineWidth = 1;
      for (let i = 0; i < 40; i++) { const x = (i * 37) % (W + 20), y = (i * 23) % H; g.beginPath(); g.moveTo(x, y); g.lineTo(x - 6, y + 12); g.stroke(); }
   }
   if (m.survival) {
      g.strokeStyle = 'rgba(255,120,100,0.35)'; g.lineWidth = 1; g.setLineDash([4, 4]);
      for (const r of [0.55, 0.85]) { g.beginPath(); g.arc(W / 2, H / 2, A * r * sc, 0, Math.PI * 2); g.stroke(); }
      g.setLineDash([]);
   }
}
