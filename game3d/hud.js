// game3d/hud.js — DOM part of the WoWs-style 3D HUD: team rosters + score + timer (top),
// consumables + ship card (bottom-left), ribbons + weapon panel (bottom-centre), telegraph /
// rudder next to the minimap (bottom-right), kill feed (right), lock panel, messages,
// scoreboard (Tab) and help (H). The reticle, markers, binocular optics and tactical map are
// drawn on the #fx canvas by hud3d.js.
//
// main3d.js builds a plain `ui` snapshot every frame (see buildUi) and calls update(ui, dt).
// Everything here only reads sim state; DOM writes are throttled or diffed so the HUD costs
// next to nothing per frame.
import { clamp01 } from './utils.js';
import { shipType, TYPE_NAME, isAlly, isVisible } from './minimap3d.js';

const $ = (id) => document.getElementById(id);
const fmtInt = (n) => Math.round(n || 0).toLocaleString('de-DE');
const fmtKm = (m) => (m / 1000).toFixed(1).replace('.', ',') + ' km';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mmss = (t) => { t = Math.max(0, Math.floor(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

// Class glyphs (same shapes as the minimap icons) as inline SVG.
export function classSvg(type, size = 12) {
   let body;
   if (type === 'DD') body = '<path d="M6 .8 11.2 11 6 8.3.8 11Z"/>';
   else if (type === 'CV') body = '<rect x="1" y="3" width="10" height="6"/>';
   else if (type === 'TR') body = '<circle cx="6" cy="6" r="4.4"/>';
   else {
      body = '<path d="M6 .5 11.5 6 6 11.5.5 6Z"/>';
      if (type === 'CA') body += '<path d="M3 6h6" stroke="rgba(0,0,0,.55)" stroke-width="1.4"/>';
      if (type === 'BB') body += '<path d="M3 4.8h6M3 7.2h6" stroke="rgba(0,0,0,.55)" stroke-width="1.2"/>';
   }
   return `<svg class="cls" width="${size}" height="${size}" viewBox="0 0 12 12" fill="currentColor">${body}</svg>`;
}

// Consumable icons (24x24, stroke = currentColor).
const CONS_ICON = {
   damageControl: '<path d="M9 5h6v3H9zM10 8h4l1 12H9z"/><path d="M15 6.5h3l1.5 2"/>',
   repair: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v10M7 12h10" stroke-width="2.6"/>',
   smoke: '<path d="M6 16a3.5 3.5 0 0 1 .6-7A5 5 0 0 1 16 8a4 4 0 0 1 2 7.8"/><path d="M5 19h13M8 22h8"/>',
   boost: '<path d="M13 2 5 13h6l-1 9 8-11h-6z"/>',
   hydro: '<circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16"/>',
   radar: '<path d="M4 18 14 8M6 6a10 10 0 0 0 12 12"/><circle cx="14" cy="8" r="1.8"/><path d="M4 21h16"/>',
   spotter: '<path d="M2 12h20M12 4v16M8 20h8M8 8l4-4 4 4"/>',
   fighter: '<path d="M2 12h20M12 4v16M8 20h8M8 8l4-4 4 4"/>',
};
const consSvg = (key) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${CONS_ICON[key] || '<circle cx="12" cy="12" r="7"/>'}</svg>`;

const WEAPON_ICON = {
   HE: '<svg viewBox="0 0 24 24"><path d="M7 20V10a5 5 0 0 1 10 0v10z" fill="#ff8a3a"/><path d="M7 16h10" stroke="#3a1a00" stroke-width="1.5"/></svg>',
   AP: '<svg viewBox="0 0 24 24"><path d="M7 20V9l5-6 5 6v11z" fill="#9fd4ff"/><path d="M7 16h10" stroke="#07243a" stroke-width="1.5"/></svg>',
   TORP: '<svg viewBox="0 0 24 24"><path d="M3 12c0-2 1-3 3-3h11l4 3-4 3H6c-2 0-3-1-3-3z" fill="#b6f0c0"/><path d="M6 9 4 6M6 15l-2 3" stroke="#b6f0c0" stroke-width="1.5"/></svg>',
};

const TELE_ORDER = [4, 3, 2, 1, 0, -1];
const TELE_LABEL = { 4: 'Voll', 3: '3/4', 2: '1/2', 1: '1/4', 0: 'Stopp', '-1': 'Rück' };
const RIBBON_COLOR = {
   pen: '#e8eef5', citadel: '#ffd24a', overpen: '#b8c7d6', ricochet: '#8fa3b8', shatter: '#8fa3b8', he: '#ff9a4a',
   sec: '#ffc27a', torp: '#7fe0ff', fire: '#ff6a2d', flood: '#4aa8ff', kill: '#ff4a3d', spotted: '#9dff9a', cap: '#ffffff', defend: '#ffffff',
};

export class Hud {
   constructor() {
      this.root = $('hud');
      this.el = {
         rosterA: $('roster-ally'), rosterE: $('roster-enemy'), mission: $('mission-name'),
         scoreA: $('score-ally'), scoreE: $('score-enemy'), fillA: $('score-fill-ally'), fillE: $('score-fill-enemy'),
         timer: $('timer'), caps: $('caps-row'), objectives: $('objectives'),
         lock: $('lock-panel'), msgs: $('msgs'), feed: $('killfeed'), torp: $('torp-alert'), eye: $('spot-eye'),
         cons: $('cons'), shipName: $('ship-name'), shipType: $('ship-type'), sil: $('silhouette'),
         hpFill: $('hp-fill'), hpLag: $('hp-lag'), hpText: $('hp-text'), speed: $('speed-kn'),
         ribbons: $('ribbons'), dmg: $('dmg-counter'), weapons: $('weapons'),
         tele: $('telegraph'), rudderCmd: $('rudder-cmd'), rudderAct: $('rudder-act'), rudderName: $('rudder-name'), teleName: $('tele-name'),
         board: $('scoreboard'), help: $('help-panel'), free: $('free-look'), hint: $('hint-line'),
      };
      this._t = 0;
      this._sig = {};
      this._hpLag = 1;
      this._ribbonEls = new Map();
      this._feed = [];
      this._silKey = '';
      this._buildStatic();
   }

   _buildStatic() {
      const e = this.el;
      if (e.tele && !e.tele.children.length) {
         e.tele.innerHTML = TELE_ORDER.map(n => `<div class="tele-step" data-n="${n}">${TELE_LABEL[n]}</div>`).join('');
      }
      if (e.weapons && !e.weapons.children.length) {
         e.weapons.innerHTML = ['HE', 'AP', 'TORP'].map((k, i) => `
            <div class="wslot" data-w="${k}">
               <div class="wkey">${i + 1}</div>
               <div class="wicon">${WEAPON_ICON[k]}</div>
               <div class="wtxt"><div class="wname">${k === 'HE' ? 'Spreng' : k === 'AP' ? 'Panzer' : 'Torpedo'}</div><div class="wstat">—</div></div>
               <div class="wbar"><i></i></div>
            </div>`).join('');
      }
      this._wslots = e.weapons ? [...e.weapons.querySelectorAll('.wslot')] : [];
      this._teleSteps = e.tele ? [...e.tele.querySelectorAll('.tele-step')] : [];
   }

   show(on) { this.root?.classList.toggle('hidden', !on); }

   reset(world) {
      const e = this.el;
      this._sig = {}; this._t = 0; this._hpLag = 1; this._silKey = '';
      this._ribbonEls.clear();
      if (e.ribbons) e.ribbons.innerHTML = '';
      if (e.msgs) e.msgs.innerHTML = '';
      if (e.feed) e.feed.innerHTML = '';
      if (e.cons) e.cons.innerHTML = '';
      this._consEls = null;
      const p = world.player;
      if (e.shipName) e.shipName.textContent = (p?.name || 'Schiff').toUpperCase();
      if (e.shipType) e.shipType.textContent = TYPE_NAME[shipType(p)] || '';
      if (e.mission) e.mission.textContent = world.mission?.name || 'Gefecht';
      this.toggleHelp(false);
   }

   toggleHelp(on) { this.el.help?.classList.toggle('hidden', !on); }

   msg(text, cls = 'info') {
      const box = this.el.msgs;
      if (!box) return;
      // collapse repeats instead of stacking the same line
      const last = box.lastElementChild;
      if (last && last.dataset.text === text) { last.classList.remove('fade'); void last.offsetWidth; clearTimeout(last._t); last._t = setTimeout(() => this._fade(last), 2600); return; }
      const d = document.createElement('div');
      d.className = 'msg ' + cls; d.textContent = text; d.dataset.text = text;
      box.appendChild(d);
      while (box.children.length > 4) box.firstElementChild.remove();
      d._t = setTimeout(() => this._fade(d), 2600);
   }
   _fade(d) { d.classList.add('fade'); setTimeout(() => d.remove(), 500); }

   ribbon(kind, name, count) {
      const box = this.el.ribbons;
      if (!box) return;
      let r = this._ribbonEls.get(kind);
      if (!r) {
         r = document.createElement('div');
         r.className = 'ribbon';
         r.style.setProperty('--rc', RIBBON_COLOR[kind] || '#fff');
         r.innerHTML = `<span class="rname">${esc(name)}</span><span class="rcount"></span>`;
         box.appendChild(r);
         this._ribbonEls.set(kind, r);
      }
      r.querySelector('.rcount').textContent = count > 1 ? '×' + count : '';
      r.classList.remove('pop'); void r.offsetWidth; r.classList.add('pop');
   }

   killFeed(feed, world) {
      const box = this.el.feed;
      if (!box) return;
      const p = world.player;
      box.innerHTML = feed.map(f => {
         const kc = f.killer ? (isAlly(world, f.killer) ? 'ally' : 'enemy') : 'neutral';
         const vc = isAlly(world, f.victim) ? 'ally' : 'enemy';
         const kn = f.killer ? (f.killer === p ? '<b>' + esc(f.killer.name) + '</b>' : esc(f.killer.name)) : '';
         const vn = f.victim === p ? '<b>' + esc(f.victim.name) + '</b>' : esc(f.victim.name);
         return `<div class="kf" data-t="${f.t}"><span class="${kc}">${kn}</span>${f.killer ? '<span class="kx">⟶</span>' : ''}<span class="${vc}">${classSvg(shipType(f.victim), 11)} ${vn}</span><span class="kx">versenkt</span></div>`;
      }).join('');
   }

   update(ui, dt) {
      const { world, p } = ui;
      if (!world || !p) return;
      const e = this.el;
      this._t -= dt;
      const slow = this._t <= 0;
      if (slow) this._t = 0.2;

      if (slow) { this._rosters(world); this._score(world); this._objectives(world); this._board(ui); }
      if (e.timer) e.timer.textContent = world.timeLeft != null ? mmss(world.timeLeft) : mmss(world.time);

      // spotted eye
      e.eye?.classList.toggle('on', !!ui.spotted);

      // ship card
      const hpF = clamp01(p.hp / (p.maxHP || 1));
      this._hpLag = hpF > this._hpLag ? hpF : this._hpLag + (hpF - this._hpLag) * Math.min(1, dt * 1.6);
      if (e.hpFill) {
         e.hpFill.style.width = (hpF * 100).toFixed(1) + '%';
         e.hpFill.style.background = hpF > 0.6 ? '#7cf29a' : hpF > 0.3 ? '#ffc94a' : '#ff5a4d';
      }
      if (e.hpLag) e.hpLag.style.width = (this._hpLag * 100).toFixed(1) + '%';
      if (e.hpText) e.hpText.textContent = fmtInt(p.hp) + ' / ' + fmtInt(p.maxHP);
      if (e.speed) e.speed.textContent = Math.round(ui.speedKn) + ' kn';
      this._silhouette(ui);

      this._consumables(ui.cons || []);
      this._weapons(ui);
      if (e.dmg) e.dmg.innerHTML = `<span>Schaden</span> ${fmtInt(ui.dmg)}`;

      // telegraph + rudder
      for (const s of this._teleSteps) s.classList.toggle('on', +s.dataset.n === ui.telegraph);
      if (e.teleName) e.teleName.textContent = ui.teleName || '';
      if (e.rudderName) e.rudderName.textContent = ui.rudderName || '';
      if (e.rudderCmd) e.rudderCmd.style.left = (50 + ui.rudder * 25) + '%';
      if (e.rudderAct) e.rudderAct.style.left = (50 + clamp01((ui.rudderActual + 1) / 2) * 100 - 50) + '%';

      // lock panel
      this._lock(ui);

      // torpedo alert, free-look
      e.torp?.classList.toggle('hidden', !(ui.torpWarnCount > 0));
      e.free?.classList.toggle('hidden', !ui.freeLook);

      // kill feed fade
      if (slow && e.feed) {
         const now = performance.now() / 1000;
         for (const k of e.feed.children) k.classList.toggle('old', now - (+k.dataset.t) > 14);
      }
   }

   _rosters(world) {
      const p = world.player;
      const sig = world.ships.map(s => s.id + ':' + (s.alive ? 1 : 0) + (isVisible(world, s) ? 1 : 0)).join(',');
      if (sig === this._sig.roster) return;
      this._sig.roster = sig;
      const row = (s) => {
         const ally = isAlly(world, s);
         const vis = ally || isVisible(world, s);
         const cls = ['r', ally ? 'ally' : 'enemy', s.alive ? '' : 'dead', !s.alive || vis ? '' : 'hid', s === p ? 'me' : ''].join(' ');
         return `<div class="${cls}">${classSvg(shipType(s), 11)}<span>${esc(s.name || s.cls)}</span></div>`;
      };
      const allies = world.ships.filter(s => isAlly(world, s));
      const enemies = world.ships.filter(s => !isAlly(world, s));
      if (this.el.rosterA) this.el.rosterA.innerHTML = allies.map(row).join('');
      if (this.el.rosterE) this.el.rosterE.innerHTML = enemies.map(row).join('');
   }

   _score(world) {
      const e = this.el;
      let a, b, fa, fb;
      if (world.score && typeof world.score.player === 'number') {
         const tgt = world.score.target || 1000;
         a = world.score.player; b = world.score.enemy;
         fa = clamp01(a / tgt); fb = clamp01(b / tgt);
      } else {
         // no score system: ships still afloat per side
         const allies = world.ships.filter(s => isAlly(world, s)), enemies = world.ships.filter(s => !isAlly(world, s));
         a = allies.filter(s => s.alive).length; b = enemies.filter(s => s.alive).length;
         fa = allies.length ? a / allies.length : 0; fb = enemies.length ? b / enemies.length : 0;
      }
      if (e.scoreA) e.scoreA.textContent = String(a);
      if (e.scoreE) e.scoreE.textContent = String(b);
      if (e.fillA) e.fillA.style.width = (fa * 50).toFixed(1) + '%';
      if (e.fillE) e.fillE.style.width = (fb * 50).toFixed(1) + '%';
      // capture points
      if (e.caps) {
         const caps = world.caps || [];
         const sig = caps.map(c => c.id + c.owner + (c.capper || '') + Math.round((c.progress || 0) * 20)).join(',');
         if (sig !== this._sig.caps) {
            this._sig.caps = sig;
            const p = world.player;
            e.caps.innerHTML = caps.map(c => {
               const own = c.owner == null ? 'n' : c.owner === p.side ? 'a' : 'e';
               const cap = c.capper == null ? '' : c.capper === p.side ? 'a' : 'e';
               const prog = Math.round((c.progress || 0) * 100);
               return `<div class="cap own-${own} cap-${cap}" style="--prog:${prog}%">${esc(c.id)}</div>`;
            }).join('');
         }
      }
   }

   _objectives(world) {
      const box = this.el.objectives;
      if (!box) return;
      const obj = world.mission?.objectives;
      const sig = obj ? obj.map(o => o.id + o.state + o.text).join('|') : 'none';
      if (sig === this._sig.obj) return;
      this._sig.obj = sig;
      if (!obj || !obj.length) { box.innerHTML = '<div class="obj active">Versenke alle feindlichen Schiffe</div>'; return; }
      box.innerHTML = obj.map(o => `<div class="obj ${esc(o.state)}">${esc(o.text)}</div>`).join('');
   }

   _silhouette(ui) {
      const c = this.el.sil;
      if (!c) return;
      const p = ui.p;
      const fires = (p.fires || []).map(f => f.mod ?? 2);
      const floods = (p.floods || []).map(f => f.mod ?? 3);
      const turrets = (ui.turrets || []).map(t => t.state);
      const key = fires.join() + '|' + floods.join() + '|' + turrets.join() + '|' + Math.round(p.hp / (p.maxHP || 1) * 50) + '|' + (ui.cons || []).some(k => k.key === 'repair' && k.active);
      if (key === this._silKey) return;
      this._silKey = key;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = c.clientWidth || 240, h = c.clientHeight || 54;
      if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      // side profile, bow to the right
      const x0 = 8, x1 = w - 8, wl = h * 0.7, hull = h * 0.18;
      const X = (f) => x0 + (x1 - x0) * f;
      const hpF = clamp01(p.hp / (p.maxHP || 1));
      g.fillStyle = hpF > 0.3 ? 'rgba(220,232,245,0.55)' : 'rgba(255,120,100,0.6)';
      g.beginPath();
      g.moveTo(X(0.02), wl - hull * 0.9); g.lineTo(X(0.97), wl - hull * 1.3); g.lineTo(X(1), wl - hull * 1.35);
      g.lineTo(X(0.93), wl + hull * 0.5); g.lineTo(X(0.06), wl + hull * 0.5); g.closePath(); g.fill();
      // superstructure + funnel
      g.fillRect(X(0.36), wl - hull * 2.3, X(0.62) - X(0.36), hull * 1.4);
      g.fillRect(X(0.44), wl - hull * 3.3, X(0.54) - X(0.44), hull * 1.1);
      g.fillRect(X(0.475), wl - hull * 4.1, X(0.505) - X(0.475), hull * 0.9);
      // turrets: fore mounts right of midships, aft mounts left (state colours as on the reticle)
      const T = ui.turrets || [];
      const fwd = T.map((t, i) => [t, i]).filter(([t]) => t.offX >= 0), aft = T.map((t, i) => [t, i]).filter(([t]) => t.offX < 0);
      const col = { ready: '#6dff8e', traverse: '#ffd24a', reload: '#ff6a5a', blocked: '#ff6a5a', dead: '#555' };
      const place = (list, a, b) => list.forEach(([t], k) => {
         const f = list.length === 1 ? (a + b) / 2 : a + (b - a) * (k / (list.length - 1));
         g.fillStyle = col[t.state] || '#ccc';
         g.fillRect(X(f) - 5, wl - hull * 1.9, 10, hull * 0.9);
      });
      place(aft.sort((u, v) => u[0].offX - v[0].offX), 0.14, 0.3);
      place(fwd.sort((u, v) => u[0].offX - v[0].offX), 0.68, 0.84);
      // fire / flood markers at their module positions (mod 0..5 = stern..bow)
      const modX = (m) => X(0.1 + clamp01(m / 5) * 0.8);
      g.font = '600 12px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      fires.forEach((m, i) => {
         const x = modX(m) + (i % 2) * 6, y = wl - hull * 2.8;
         g.fillStyle = '#ff6a1a';
         g.beginPath(); g.moveTo(x, y - 8); g.quadraticCurveTo(x + 6, y - 1, x + 3, y + 4); g.quadraticCurveTo(x, y + 6, x - 3, y + 4);
         g.quadraticCurveTo(x - 6, y - 1, x, y - 8); g.fill();
         g.fillStyle = '#ffd24a'; g.beginPath(); g.arc(x, y + 1.5, 2, 0, Math.PI * 2); g.fill();
      });
      floods.forEach((m, i) => {
         const x = modX(m) + (i % 2) * 6, y = wl + hull * 1.6;
         g.fillStyle = '#4aa8ff';
         g.beginPath(); g.moveTo(x, y - 6); g.quadraticCurveTo(x + 5, y + 1, x, y + 4); g.quadraticCurveTo(x - 5, y + 1, x, y - 6); g.fill();
      });
      // waterline
      g.strokeStyle = 'rgba(120,180,230,0.5)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(2, wl + hull * 0.5); g.lineTo(w - 2, wl + hull * 0.5); g.stroke();
   }

   _consumables(list) {
      const box = this.el.cons;
      if (!box) return;
      const sig = list.map(c => c.slot + c.key).join(',');
      if (sig !== this._sig.consLayout) {
         this._sig.consLayout = sig;
         box.innerHTML = list.map(c => `
            <div class="cslot" data-slot="${c.slot}" title="${esc(c.name)}">
               <div class="cicon">${consSvg(c.key)}</div>
               <div class="ccd"></div>
               <div class="ckey">${c.slot}</div>
               <div class="cchg"></div>
               <div class="ctime"></div>
            </div>`).join('');
         this._consEls = [...box.querySelectorAll('.cslot')];
      }
      list.forEach((c, i) => {
         const el = this._consEls?.[i];
         if (!el) return;
         const empty = c.charges !== Infinity && c.charges <= 0 && !c.active;
         const cooling = !c.active && c.cd > 0;
         el.classList.toggle('active', !!c.active);
         el.classList.toggle('cooling', cooling);
         el.classList.toggle('empty', empty);
         const frac = c.active ? clamp01(c.t / (c.dur || 1)) : cooling ? clamp01(c.cd / (c.cdMax || 1)) : 0;
         el.style.setProperty('--cd', (frac * 100).toFixed(1) + '%');
         el.querySelector('.cchg').textContent = c.charges === Infinity ? '∞' : String(Math.max(0, c.charges));
         el.querySelector('.ctime').textContent = c.active ? Math.ceil(c.t) + 's' : cooling ? Math.ceil(c.cd) + 's' : '';
      });
   }

   _weapons(ui) {
      const [he, ap, tp] = this._wslots;
      if (!he) return;
      const r = ui.reload || {};
      const mainTxt = r.anyReady ? `bereit ${r.loaded}/${r.total}` : r.loaded > 0 ? `schwenkt ${r.loaded}/${r.total}` : (r.left || 0).toFixed(1) + ' s';
      for (const [el, type] of [[he, 'HE'], [ap, 'AP']]) {
         const sel = ui.mode === 'guns' && ui.ammo === type;
         el.classList.toggle('sel', sel);
         el.classList.toggle('loaded', sel && !!r.anyReady);
         el.querySelector('.wstat').textContent = sel ? mainTxt : '';
         el.querySelector('.wbar i').style.width = (sel ? (r.frac ?? 1) * 100 : 0).toFixed(1) + '%';
      }
      const ti = ui.torpInfo;
      tp.classList.toggle('sel', ui.mode === 'torp');
      tp.classList.toggle('none', !ti);
      if (ti) {
         const ready = ti.readyCount > 0;
         tp.classList.toggle('loaded', ready && ui.mode === 'torp');
         tp.querySelector('.wstat').textContent = (ready ? `bereit ${ti.readyCount}/${ti.total}` : ti.reload.toFixed(0) + ' s') + ' · ' + (ti.spread === 'wide' ? 'weit' : 'eng');
         tp.querySelector('.wbar i').style.width = ((ready ? 1 : 1 - clamp01(ti.reload / (ti.reloadMax || 1))) * 100).toFixed(1) + '%';
      } else {
         tp.querySelector('.wstat').textContent = 'keine';
         tp.querySelector('.wbar i').style.width = '0%';
      }
   }

   _lock(ui) {
      const el = this.el.lock;
      if (!el) return;
      const s = ui.lockShip;
      el.classList.toggle('hidden', !s);
      if (!s) return;
      const p = ui.p;
      const d = Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y);
      const kn = s.speedKn ?? s.speedKnots ?? Math.abs(s.speed || 0) * 1.94384;
      const hpF = clamp01(s.hp / (s.maxHP || 1));
      const sig = s.id + '|' + Math.round(hpF * 200) + '|' + Math.round(d / 50) + '|' + Math.round(kn);
      if (sig === this._sig.lock) return;
      this._sig.lock = sig;
      el.innerHTML = `
         <div class="lk-head">${classSvg(shipType(s), 14)}<span class="lk-name">${esc(s.name || s.cls)}</span><span class="lk-type">${esc(TYPE_NAME[shipType(s)] || '')}</span></div>
         <div class="lk-bar"><i style="width:${(hpF * 100).toFixed(1)}%"></i></div>
         <div class="lk-row"><span>${fmtInt(s.hp)} HP</span><span>${fmtKm(d)}</span><span>${Math.round(kn)} kn</span></div>`;
   }

   _board(ui) {
      const el = this.el.board;
      if (!el) return;
      el.classList.toggle('hidden', !ui.board);
      if (!ui.board) { this._sig.board = ''; return; }
      const world = ui.world, p = ui.p;
      const rows = (list) => list.map(s => {
         const ally = isAlly(world, s), vis = ally || isVisible(world, s);
         const hpF = clamp01(s.hp / (s.maxHP || 1));
         const hp = !s.alive ? 'versenkt' : vis ? fmtInt(s.hp) : '?';
         return `<tr class="${s.alive ? '' : 'dead'} ${s === p ? 'me' : ''}"><td class="ic ${ally ? 'ally' : 'enemy'}">${classSvg(shipType(s), 12)}</td>
            <td>${esc(s.name || s.cls)}</td><td class="ty">${esc(TYPE_NAME[shipType(s)] || '')}</td>
            <td class="hp"><div class="sb-bar"><i style="width:${s.alive && vis ? (hpF * 100).toFixed(0) : 0}%"></i></div>${hp}</td></tr>`;
      }).join('');
      const allies = world.ships.filter(s => isAlly(world, s)), enemies = world.ships.filter(s => !isAlly(world, s));
      const st = world.stats || {};
      const html = `
         <div class="sb-title">${esc(world.mission?.name || 'Gefecht')} <span>${world.timeLeft != null ? mmss(world.timeLeft) : mmss(world.time)}</span></div>
         <div class="sb-cols">
            <div><div class="sb-h ally">Verbündete</div><table>${rows(allies)}</table></div>
            <div><div class="sb-h enemy">Gegner</div><table>${rows(enemies)}</table></div>
         </div>
         <div class="sb-stats">
            <div><b>${fmtInt(ui.dmg)}</b><span>Schaden</span></div>
            <div><b>${st.kills ?? world.killCount ?? 0}</b><span>Versenkt</span></div>
            <div><b>${st.hits ?? p.shotsHit ?? 0} / ${st.shotsFired ?? p.shotsFired ?? 0}</b><span>Treffer / Schüsse</span></div>
            <div><b>${st.citadels ?? '—'}</b><span>Zitadellen</span></div>
         </div>`;
      if (html !== this._sig.board) { this._sig.board = html; el.innerHTML = html; }
   }
}
