// game3d/hud.js — DOM part of the 3D battle HUD ("Kartenhaus" instrument plates): orders
// (top-left), situation board with score, timer and points flanked by the own and the enemy order
// of battle (top-centre), key hint + loss reports (top-right), equipment gauges + ship card
// (bottom-left), hit tally above the ammunition selector (bottom-centre), chart table with
// telegraph, rudder and minimap (bottom-right), lock panel, messages, scoreboard (Tab) and help
// (H). On touch screens touch3d.js rearranges the same plates around its controls. Colours come from the design tokens (theme.js).
// The reticle, markers, binocular optics and tactical map are drawn on the #fx canvas by
// hud3d.js.
//
// main3d.js builds a plain `ui` snapshot every frame (see buildUi) and calls update(ui, dt).
// Everything here only reads sim state; DOM writes are throttled or diffed so the HUD costs
// next to nothing per frame.
import { clamp01 } from './utils.js';
import { shipType, TYPE_NAME, isAlly, isVisible, displayKn } from './minimap3d.js';
import { T as TH, rgba, FONT } from './theme.js';

const $ = (id) => document.getElementById(id);
const fmtInt = (n) => Math.round(n || 0).toLocaleString('de-DE');
const fmtKm = (m) => (m / 1000).toFixed(1).replace('.', ',') + ' km';
// ships taken out of the battle by a mission script (world.removeShip) are not sunk
const LEFT_LABEL = { arrived: 'angekommen', retreated: 'abgedreht', escaped: 'entkommen' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mmss = (t) => { t = Math.max(0, Math.floor(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
// Per-frame writes go through these: assigning textContent / an inline style dirties style and
// layout even when the value is unchanged, so only real changes reach the DOM.
const setText = (el, s) => { if (el && el._txt !== s) { el._txt = s; el.textContent = s; } };
const setStyle = (el, k, v) => { if (el && el['_st' + k] !== v) { el['_st' + k] = v; el.style[k] = v; } };
const setVar = (el, k, v) => { if (el && el['_st' + k] !== v) { el['_st' + k] = v; el.style.setProperty(k, v); } };

// Class glyphs as inline SVG, the same shapes the minimap draws (minimap3d.drawClassIcon):
// capital ships are discs with one bar per weight class (CL 1, CA 2, BB 3), destroyers an
// upward triangle, submarines a dome, carriers a flat deck, transports a hollow square.
// bars and deck stripe are cut out in --cls-bar (dark on the HUD, paper colour in the menus)
const KO = 'style="stroke:var(--cls-bar,rgba(0,0,0,.62))"';
const BAR = `<path d="M2.6 #h6.8" ${KO} stroke-width="1.1"/>`;
export function classSvg(type, size = 12) {
   let body;
   if (type === 'DD') body = '<path d="M6 1 11.2 10.6H.8Z"/>';
   else if (type === 'SS') body = '<path d="M.8 9.8a5.2 5.2 0 0 1 10.4 0Z"/><path d="M5.3 1.6h1.4v3.4H5.3z"/>';
   else if (type === 'CV') body = `<rect x=".5" y="3.4" width="11" height="5.2"/><path d="M1.8 6h8.4" ${KO} stroke-width="1" stroke-dasharray="1.6 1"/>`;
   else if (type === 'TR') body = '<rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.8"/>';
   else {
      body = '<circle cx="6" cy="6" r="5.4"/>';
      const ys = type === 'BB' ? [3.9, 6, 8.1] : type === 'CA' ? [4.9, 7.1] : [6];
      body += ys.map(y => BAR.replace('#', y)).join('');
   }
   return `<svg class="cls" width="${size}" height="${size}" viewBox="0 0 12 12" fill="currentColor">${body}</svg>`;
}

// Equipment icons, "engraved" line style: 24 grid, 1.6 stroke, round caps, currentColor.
const CONS_ICON = {
   // chaff / flare burst (Täuschkörper)
   decoy: '<path d="M12 20v-7"/><path d="M12 13l-5-6M12 13l5-6M12 13l-7-1.5M12 13l7-1.5M12 13V4.5"/><circle cx="7" cy="6.5" r=".9"/><circle cx="17" cy="6.5" r=".9"/><circle cx="12" cy="4" r=".9"/><circle cx="4.6" cy="11.3" r=".9"/><circle cx="19.4" cy="11.3" r=".9"/>',
   // jammer: emitter with broken waves (Störsender)
   jammer: '<path d="M12 21v-9"/><circle cx="12" cy="10" r="1.8"/><path d="M7.5 14.5a6.4 6.4 0 0 1 0-9M16.5 5.5a6.4 6.4 0 0 1 0 9M4.6 17a10.4 10.4 0 0 1 0-14M19.4 3a10.4 10.4 0 0 1 0 14" stroke-dasharray="3 2.2"/>',
   // helicopter (Bordhubschrauber)
   helo: '<path d="M3 6h16M11 6v3"/><path d="M6 9h8a4 4 0 0 1 4 4v1H9a3 3 0 0 1-3-3z"/><path d="M6 11H2.5M8 18h10M11 14v4M15 14v4"/>',
   // fire bucket with a drop (Leckwehr)
   damageControl: '<path d="M6 9h12l-1.6 11H7.6z"/><path d="M8 9a4 4 0 0 1 8 0"/><path d="M12 12.6c-1.3 1.7-1.8 2.6-1.8 3.3a1.8 1.8 0 0 0 3.6 0c0-.7-.5-1.6-1.8-3.3z"/>',
   // spanner + plus (Notreparatur)
   repair: '<path d="M14.6 3.8a4.2 4.2 0 0 0-5 5.4L3.8 15l2.6 2.6 5.8-5.8a4.2 4.2 0 0 0 5.4-5l-2.5 2.5-2.3-.6-.6-2.3z"/><path d="M18 15v6M15 18h6"/>',
   // funnel puffing smoke (Nebelanlage)
   smoke: '<path d="M6 21l1-7h4l1 7"/><circle cx="9.6" cy="9.4" r="2.6"/><circle cx="14.6" cy="6.6" r="3.1"/><circle cx="18.6" cy="10.6" r="2.3"/>',
   // telegraph dial at full ahead (Äußerste Kraft)
   boost: '<path d="M3.5 16.5a8.5 8.5 0 0 1 17 0"/><path d="M12 16.5l5.2-5.2"/><circle cx="12" cy="16.5" r="1.3"/><path d="M3.5 20h17M6.2 10.3l1 1M12 8v1.4"/>',
   // headphones (Horchgerät)
   hydro: '<path d="M5 14v-2a7 7 0 0 1 14 0v2"/><rect x="3.5" y="13.5" width="4" height="6.5" rx="1"/><rect x="16.5" y="13.5" width="4" height="6.5" rx="1"/>',
   // mattress antenna on a mast (Funkmessgerät)
   radar: '<path d="M5 3.5h14v8H5zM5 7.5h14M9.7 3.5v8M14.3 3.5v8"/><path d="M12 11.5v8.5M8 20h8"/>',
   // floatplane from above
   spotter: '<path d="M12 3.5v17M3.5 10.5h17M8.5 19.5h7"/><path d="M6 13.5h2.5M15.5 13.5H18"/>',
   // swept-wing fighter from above
   fighter: '<path d="M12 3.5v17M4 12.5l8-3 8 3M9 19.5h6"/>',
};
const consSvg = (key) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">${CONS_ICON[key] || '<circle cx="12" cy="12" r="7"/>'}</svg>`;

// Ammunition, same line style; colour from the --he / --ap / --torp tokens.
const ammoSvg = (tok, body) => `<svg viewBox="0 0 24 24" fill="none" stroke="var(--${tok})" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
const WEAPON_ICON = {
   GUN: ammoSvg('he', '<path d="M9 21V11.5a3 3 0 0 1 6 0V21z" fill="var(--he)" fill-opacity=".22"/><path d="M9 16.5h6M12 2.5V5M7.6 4.4l1.3 1.9M16.4 4.4l-1.3 1.9"/>'),
   // anti-ship missile: slim body, cruciform wings, sea line
   SSM: ammoSvg('ap', '<path d="M3 11.2h13l4.5 1.8-4.5 1.8H3z" fill="var(--ap)" fill-opacity=".22"/><path d="M9 11.2l-2-3.4M9 14.8l-2 3.4M3 11.2L1.8 9.4M3 14.8l-1.2 1.8M3 21h18"/>'),
   // cruise missile: long body with straight wings, flying over land
   CRUISE: ammoSvg('gold', '<path d="M2.5 8.6h14l5 1.6-5 1.6h-14z" fill="var(--gold)" fill-opacity=".22"/><path d="M11 8.6L8.6 4.4M11 11.8l-2.4 4.2M2.5 8.6L1.6 7M3 21l5-4 4 3 4-5 5 6"/>'),
   // rocket launcher: three tubes, salvo
   ROCKET: ammoSvg('he', '<path d="M4 19l9-9M8 21l9-9M12 22l8-8" /><path d="M15 8l4-4M19 4h-3M19 4v3"/>'),
   TORP: ammoSvg('torp', '<rect x="2.5" y="9.5" width="14.5" height="5" rx="2.5" fill="var(--torp)" fill-opacity=".22"/><path d="M17 12h2.2M19.2 9.4v5.2M21.4 10.4v3.2"/>'),
};

// ship-card silhouette colours (turret states as on the reticle schematic)
const SIL = {
   hull: rgba(TH.hud, 0.55), hullLow: rgba(TH.bad, 0.6), water: rgba(TH.ap, 0.5),
   turret: { ready: TH.ok, traverse: TH.warn, reload: TH.bad, blocked: TH.bad, dead: TH.dead },
};

const TELE_ORDER = [4, 3, 2, 1, 0, -1];
const TELE_LABEL = { 4: 'Voll', 3: '3/4', 2: '1/2', 1: '1/4', 0: 'Stopp', '-1': 'Rück' };
// colour of each hit slip in the tally (left edge + count)
const RIBBON_COLOR = {
   pen: TH.hud, citadel: TH.gold, overpen: TH['hud-dim'], ricochet: '#8f8875', shatter: '#8f8875', he: TH.he,
   sec: TH.warn, torp: TH.torp, fire: TH.fire, flood: TH.flood, kill: TH.bad, spotted: TH.ally, cap: TH.neutral, defend: TH.neutral,
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
      this._wslots = [];
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

   msg(text, cls = 'info', secs = 2.6) {
      const box = this.el.msgs;
      if (!box) return;
      const ms = secs * 1000;
      // collapse repeats instead of stacking the same line
      const last = box.lastElementChild;
      if (last && last.dataset.text === text) { last.classList.remove('fade'); void last.offsetWidth; clearTimeout(last._t); last._t = setTimeout(() => this._fade(last), ms); return; }
      const d = document.createElement('div');
      d.className = 'msg ' + cls; d.textContent = text; d.dataset.text = text;
      box.appendChild(d);
      while (box.children.length > 4) box.firstElementChild.remove();
      d._t = setTimeout(() => this._fade(d), ms);
   }
   _fade(d) { d.classList.add('fade'); setTimeout(() => d.remove(), 500); }
   // Takes the notices of one class off the screen at once (guide.js: a tip gives way to the chart).
   clear(cls) {
      const box = this.el.msgs;
      if (!box) return;
      for (const d of [...box.children]) if (d.classList.contains(cls)) { clearTimeout(d._t); d.remove(); }
   }

   ribbon(kind, name, count) {
      const box = this.el.ribbons;
      if (!box) return;
      let r = this._ribbonEls.get(kind);
      if (!r) {
         r = document.createElement('div');
         r.className = 'ribbon';
         r.style.setProperty('--rc', RIBBON_COLOR[kind] || TH.hud);
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
      setText(e.timer, world.timeLeft != null ? mmss(world.timeLeft) : mmss(world.time));

      // spotted eye
      e.eye?.classList.toggle('on', !!ui.spotted);

      // ship card
      const hpF = clamp01(p.hp / (p.maxHP || 1));
      this._hpLag = hpF > this._hpLag ? hpF : this._hpLag + (hpF - this._hpLag) * Math.min(1, dt * 1.6);
      setStyle(e.hpFill, 'width', (hpF * 100).toFixed(1) + '%');
      setStyle(e.hpFill, 'background', hpF > 0.6 ? TH.ok : hpF > 0.3 ? TH.warn : TH.bad);
      setStyle(e.hpLag, 'width', (this._hpLag * 100).toFixed(1) + '%');
      setText(e.hpText, fmtInt(p.hp) + ' / ' + fmtInt(p.maxHP));
      setText(e.speed, Math.round(ui.speedKn) + ' kn');
      this._silhouette(ui);

      this._consumables(ui.cons || []);
      this._weapons(ui);
      if (e.dmg && e.dmg._v !== Math.round(ui.dmg || 0)) { e.dmg._v = Math.round(ui.dmg || 0); e.dmg.innerHTML = `<span>Schaden</span> ${fmtInt(ui.dmg)}`; }

      // telegraph + rudder
      for (const s of this._teleSteps) s.classList.toggle('on', +s.dataset.n === ui.telegraph);
      setText(e.teleName, ui.teleName || '');
      setText(e.rudderName, ui.rudderName || '');
      setStyle(e.rudderCmd, 'left', (50 + ui.rudder * 25) + '%');
      setStyle(e.rudderAct, 'left', (clamp01((ui.rudderActual + 1) / 2) * 100).toFixed(1) + '%');

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
      // world.roster keeps sunk ships (struck through) and ships that left the battle (dimmed):
      // world.ships drops them once the sinking animation is over and the line-up would shrink
      const all = world.roster || world.ships;
      const sig = all.map(s => s.id + ':' + (s.alive ? 1 : 0) + (s.alive && isVisible(world, s) ? 1 : 0)).join(',');
      if (sig === this._sig.roster) return;
      this._sig.roster = sig;
      const row = (s) => {
         const ally = isAlly(world, s);
         const vis = ally || isVisible(world, s);
         const left = !s.alive && s.escaped;
         const cls = ['r', ally ? 'ally' : 'enemy', s.alive || left ? '' : 'dead', left || (s.alive && !vis) ? 'hid' : '', s === p ? 'me' : ''].join(' ');
         return `<div class="${cls}"${left ? ` title="${LEFT_LABEL[s.escaped] || ''}"` : ''}>${classSvg(shipType(s), 11)}<span>${esc(s.name || s.cls)}</span></div>`;
      };
      const allies = all.filter(s => isAlly(world, s));
      const enemies = all.filter(s => !isAlly(world, s));
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
      setText(e.scoreA, String(a));
      setText(e.scoreE, String(b));
      setStyle(e.fillA, 'width', (fa * 50).toFixed(1) + '%');
      setStyle(e.fillE, 'width', (fb * 50).toFixed(1) + '%');
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
      g.fillStyle = hpF > 0.3 ? SIL.hull : SIL.hullLow;
      g.beginPath();
      g.moveTo(X(0.02), wl - hull * 0.9); g.lineTo(X(0.97), wl - hull * 1.3); g.lineTo(X(1), wl - hull * 1.35);
      g.lineTo(X(0.93), wl + hull * 0.5); g.lineTo(X(0.06), wl + hull * 0.5); g.closePath(); g.fill();
      // superstructure + funnel
      g.fillRect(X(0.36), wl - hull * 2.3, X(0.62) - X(0.36), hull * 1.4);
      g.fillRect(X(0.44), wl - hull * 3.3, X(0.54) - X(0.44), hull * 1.1);
      g.fillRect(X(0.475), wl - hull * 4.1, X(0.505) - X(0.475), hull * 0.9);
      // turrets: fore mounts right of midships, aft mounts left (state colours as on the reticle)
      const TU = ui.turrets || [];
      const fwd = TU.map((t, i) => [t, i]).filter(([t]) => t.offX >= 0), aft = TU.map((t, i) => [t, i]).filter(([t]) => t.offX < 0);
      const place = (list, a, b) => list.forEach(([t], k) => {
         const f = list.length === 1 ? (a + b) / 2 : a + (b - a) * (k / (list.length - 1));
         g.fillStyle = SIL.turret[t.state] || TH.neutral;
         g.fillRect(X(f) - 5, wl - hull * 1.9, 10, hull * 0.9);
      });
      place(aft.sort((u, v) => u[0].offX - v[0].offX), 0.14, 0.3);
      place(fwd.sort((u, v) => u[0].offX - v[0].offX), 0.68, 0.84);
      // fire / flood markers at their module positions (mod 0..5 = stern..bow)
      const modX = (m) => X(0.1 + clamp01(m / 5) * 0.8);
      g.font = FONT(12, 600); g.textAlign = 'center'; g.textBaseline = 'middle';
      fires.forEach((m, i) => {
         const x = modX(m) + (i % 2) * 6, y = wl - hull * 2.8;
         g.fillStyle = TH.fire;
         g.beginPath(); g.moveTo(x, y - 8); g.quadraticCurveTo(x + 6, y - 1, x + 3, y + 4); g.quadraticCurveTo(x, y + 6, x - 3, y + 4);
         g.quadraticCurveTo(x - 6, y - 1, x, y - 8); g.fill();
         g.fillStyle = TH.warn; g.beginPath(); g.arc(x, y + 1.5, 2, 0, Math.PI * 2); g.fill();
      });
      floods.forEach((m, i) => {
         const x = modX(m) + (i % 2) * 6, y = wl + hull * 1.6;
         g.fillStyle = TH.flood;
         g.beginPath(); g.moveTo(x, y - 6); g.quadraticCurveTo(x + 5, y + 1, x, y + 4); g.quadraticCurveTo(x - 5, y + 1, x, y - 6); g.fill();
      });
      // waterline
      g.strokeStyle = SIL.water; g.lineWidth = 1;
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
         this._consEls = [...box.querySelectorAll('.cslot')].map(el => ({ el, chg: el.querySelector('.cchg'), time: el.querySelector('.ctime') }));
      }
      list.forEach((c, i) => {
         const ce = this._consEls?.[i];
         if (!ce) return;
         const el = ce.el;
         const empty = c.charges !== Infinity && c.charges <= 0 && !c.active;
         const cooling = !c.active && c.cd > 0;
         el.classList.toggle('active', !!c.active);
         el.classList.toggle('cooling', cooling);
         el.classList.toggle('empty', empty);
         const frac = c.active ? clamp01(c.t / (c.dur || 1)) : cooling ? clamp01(c.cd / (c.cdMax || 1)) : 0;
         setVar(el, '--cd', (frac * 100).toFixed(1) + '%');
         setText(ce.chg, c.charges === Infinity ? '∞' : String(Math.max(0, c.charges)));
         setText(ce.time, c.active ? Math.ceil(c.t) + 's' : cooling ? Math.ceil(c.cd) + 's' : '');
      });
   }

   // Weapon bar from ui.weapons (missileui.js fill): [{ id, key, icon, name, count, sel, ready, none, frac, stat, tip }]
   _weapons(ui) {
      const box = this.el.weapons, list = ui.weapons || [];
      if (!box) return;
      const sig = list.map(w => w.id).join(',');
      if (sig !== this._sig.weapons) {
         this._sig.weapons = sig;
         box.innerHTML = list.map(w => `
            <div class="wslot" data-w="${w.id}" data-key="${w.key}">
               <div class="wkey">${w.key}</div>
               <div class="wicon">${WEAPON_ICON[w.icon] || ''}</div>
               <div class="wtxt"><div class="wname"></div><div class="wstat">—</div></div>
               <div class="wcnt"></div>
               <div class="wbar"><i></i></div>
            </div>`).join('');
         this._wslots = [...box.querySelectorAll('.wslot')].map(el => ({ el, name: el.querySelector('.wname'), stat: el.querySelector('.wstat'), cnt: el.querySelector('.wcnt'), bar: el.querySelector('.wbar i') }));
         box.classList.toggle('hidden', !list.length);
      }
      list.forEach((w, i) => {
         const s = this._wslots[i];
         if (!s) return;
         s.el.classList.toggle('sel', !!w.sel);
         s.el.classList.toggle('loaded', !!w.ready);
         s.el.classList.toggle('none', !!w.none);
         if (s.el._tip !== w.tip) { s.el._tip = w.tip; s.el.title = w.tip || ''; }
         setText(s.name, w.name);
         setText(s.stat, w.stat);
         setText(s.cnt, w.count);
         setStyle(s.bar, 'width', (clamp01(w.frac ?? 1) * 100).toFixed(1) + '%');
      });
   }

   _lock(ui) {
      const el = this.el.lock;
      if (!el) return;
      const s = ui.lockShip;
      el.classList.toggle('hidden', !s);
      if (!s) return;
      const p = ui.p;
      const d = Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y);
      const kn = displayKn(s);
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
         const hp = !s.alive ? (LEFT_LABEL[s.escaped] || 'versenkt') : vis ? fmtInt(s.hp) : '?';
         return `<tr class="${s.alive ? '' : 'dead'} ${s === p ? 'me' : ''}"><td class="ic ${ally ? 'ally' : 'enemy'}">${classSvg(shipType(s), 12)}</td>
            <td>${esc(s.name || s.cls)}</td><td class="ty">${esc(TYPE_NAME[shipType(s)] || '')}</td>
            <td class="hp"><div class="sb-bar"><i style="width:${s.alive && vis ? (hpF * 100).toFixed(0) : 0}%"></i></div>${hp}</td></tr>`;
      }).join('');
      const all = world.roster || world.ships;   // the roster keeps sunk ships and those that left
      const allies = all.filter(s => isAlly(world, s)), enemies = all.filter(s => !isAlly(world, s));
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
