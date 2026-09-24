// game/render.js — the whole visual layer: sea, obstacles, ships (2.5D), projectiles, FX, HUD canvases.
// Draw order: ocean -> obstacles -> wakes -> torpedoes -> shell shadows -> ships -> smoke ->
//             effects (explosions/splashes/fire) -> shells (in air) -> AA tracers -> damage numbers -> reticle.
import { add, sub, scale, fromAngle, angleOf, angleDelta, clamp, clamp01, dist, TAU, DEG } from './utils.js';
import { WORLD, PALETTE, VISION, HANDLING } from './config.js';
import { ENEMY_COL, ALLY_COL, ALLY_DECK, drawTurret, drawDetail, drawSub, drawBattery, drawZones, drawMines, drawDepthCharges,
   drawBombs, drawBarrages, drawSonar, drawFlares, drawAircraft, drawNight, drawStorm, drawMinimapExtras } from './render-campaign.js';

// hull footprint straight from the ship class (config.js L/beam)
const dimsOf = (s) => ({ L: s.cfg.L || 180, beam: s.cfg.beam || 20 });
// Enemies are drawn only while spotted; hidden ones leave a fading "last known position" ghost.
const shown = (s) => s.alive && (s.side !== 'enemy' || s.visible);
const ghostAge = (world, s) => (s.alive && s.side === 'enemy' && !s.visible && s.lastKnown) ? world.time - s.lastKnown.t : Infinity;
const HIT_COL = { CITADEL: '#ffd23a', PEN: '#ffffff', HE: '#ffae5a', RICOCHET: '#8fb0cc', OVERPEN: '#d0d6de', TORP: '#7fe0ff' };

export class Renderer {
   constructor(sceneCanvas, fxCanvas, cam, ocean) {
      this.scene = sceneCanvas.getContext('2d');
      this.fx = fxCanvas.getContext('2d');
      this.cam = cam;
      this.ocean = ocean;
      this.minimapCtx = null;
      this.compassCtx = null;
      this._smokeSprite = makeSmokeSprite();
      this._glowSprite = makeGlowSprite();
      this._overlay = {};   // night mask canvas cache (render-campaign.js)
   }

   setHudCanvases(minimap, compass) {
      this.minimapCtx = minimap ? minimap.getContext('2d') : null;
      this.compassCtx = compass ? compass.getContext('2d') : null;
   }

   // ================= MAIN FRAME =================
   render(world, dt) {
      const cam = this.cam, ctx = this.scene;
      cam.decayShake(dt);
      if (world._shake > 0) cam.addShake(world._shake);

      this.ocean.render(ctx, cam);
      this._obstacles(ctx, world);
      if (world.zones.length) drawZones(ctx, cam, world);
      this._wakes(ctx, world);
      if (world.mines.length) drawMines(ctx, cam, world);
      if (world.depthCharges.length) drawDepthCharges(ctx, cam, world);
      this._torpedoes(ctx, world);
      this._shellShadows(ctx, world);
      this._ghosts(ctx, world);
      for (const s of world.ships) if (shown(s) && cam.visible(s.pos, 400)) this._ship(ctx, world, s);
      if (world.sonarPings.length) drawSonar(ctx, cam, world);
      this._smoke(ctx, world);
      this._effects(ctx, world);
      if (world.env.storm) drawStorm(ctx, cam, world);
      if (world.env.night) drawNight(ctx, cam, world, this._overlay);
      // telegraphs and flares must read through darkness, smoke and rain
      if (world.bombs.length) drawBombs(ctx, cam, world);
      if (world.barrages.length) drawBarrages(ctx, cam, world);
      if (world.flares.length) drawFlares(ctx, cam, world, this._glowSprite);
      this._shells(ctx, world);
      this._aaTracers(ctx, world);
      if (world.aircraft.length) drawAircraft(ctx, cam, world);
      this._labels(ctx, world);
      this._damageNumbers(ctx, world);
      this._hitMarks(ctx, world, dt);
      this._torpFan(ctx, world);
      this._reticle(ctx, world);

      // fx layer: screen-space vignette pulse when under heavy fire
      // fx ctx carries the dpr transform — work in CSS pixels (cam.w/h), not device pixels
      const fxc = this.fx;
      fxc.clearRect(0, 0, cam.w, cam.h);
      const p = world.player;
      if (p && p.alive && p.hitFlash > 0.4) {
         fxc.fillStyle = `rgba(255,60,40,${(p.hitFlash - 0.4) * 0.25})`;
         fxc.fillRect(0, 0, cam.w, cam.h);
      }

      this._minimap(world);
      this._compass(world);
   }

   // ================= OBSTACLES =================
   _obstacles(ctx, world) {
      const cam = this.cam;
      for (const o of world.obstacles) {
         if (!cam.visible(o.c, o.r + 100)) continue;
         const c = cam.w2s(o.c);
         const r = o.r * cam.zoom;
         if (o.kind === 'reef') {
            // shallow water halo
            const g = ctx.createRadialGradient(c.x, c.y, r * 0.4, c.x, c.y, r * 1.5);
            g.addColorStop(0, 'rgba(90,190,170,0.30)');
            g.addColorStop(0.6, 'rgba(60,150,140,0.14)');
            g.addColorStop(1, 'rgba(60,150,140,0)');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(c.x, c.y, r * 1.5, 0, TAU); ctx.fill();
            // reef rocks
            ctx.fillStyle = '#2e4a44';
            for (let i = 0; i < 9; i++) {
               const a = (i / 9) * TAU + o.c.x * 0.01;
               const rr = r * (0.35 + 0.45 * ((i * 37) % 10) / 10);
               const x = c.x + Math.cos(a) * rr * 0.55, y = c.y + Math.sin(a) * rr * 0.55;
               ctx.beginPath(); ctx.arc(x, y, rr * 0.42, 0, TAU); ctx.fill();
            }
            // foam edge
            ctx.strokeStyle = 'rgba(220,245,255,0.5)';
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(c.x, c.y, r * 0.72, 0, TAU); ctx.stroke();
         } else {
            // island with irregular lobes
            ctx.save();
            ctx.translate(c.x, c.y);
            ctx.beginPath();
            const lobes = o.lobes || [];
            for (let i = 0; i < lobes.length; i++) {
               const x = Math.cos(lobes[i].a) * lobes[i].r * cam.zoom;
               const y = Math.sin(lobes[i].a) * lobes[i].r * cam.zoom;
               i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.closePath();
            const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r * 1.2);
            g.addColorStop(0, '#4a6b4a');
            g.addColorStop(0.7, '#33503a');
            g.addColorStop(1, '#22382c');
            ctx.fillStyle = g;
            ctx.fill();
            ctx.strokeStyle = 'rgba(220,245,255,0.35)';
            ctx.lineWidth = 2.5;
            ctx.stroke();
            // beach ring
            ctx.strokeStyle = 'rgba(210,190,140,0.35)';
            ctx.lineWidth = 5;
            ctx.stroke();
            ctx.restore();
         }
      }
   }

   // ================= WAKES =================
   _wakes(ctx, world) {
      const cam = this.cam;
      for (const s of world.ships) {
         if (!shown(s) || !cam.visible(s.pos, 500)) continue;
         const sp = Math.abs(s.speed);
         if (sp < 2) continue;
         const k = clamp01(sp / 20);
         const c = cam.w2s(s.pos);
         const back = s.heading + Math.PI;
         const len = (60 + sp * 14) * cam.zoom;
         ctx.save();
         ctx.translate(c.x, c.y);
         ctx.rotate(back);
         ctx.globalAlpha = 0.28 * k;
         ctx.strokeStyle = PALETTE.foam;
         ctx.lineWidth = 1.5;
         for (const side of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(0, side * 6 * cam.zoom);
            ctx.quadraticCurveTo(len * 0.5, side * (10 + 14 * k) * cam.zoom, len, side * (16 + 26 * k) * cam.zoom);
            ctx.stroke();
         }
         // churned water right behind the stern
         ctx.globalAlpha = 0.35 * k;
         ctx.fillStyle = PALETTE.foam;
         ctx.beginPath();
         ctx.ellipse(len * 0.15, 0, len * 0.2, 8 * cam.zoom, 0, 0, TAU);
         ctx.fill();
         ctx.restore();
         ctx.globalAlpha = 1;
      }
   }

   // ================= SHIPS =================
   _ship(ctx, world, s) {
      const cam = this.cam;
      const d = dimsOf(s);
      const z = cam.zoom;
      const c = cam.w2s(s.pos);
      const L = d.L * z, B = d.beam * z;
      const enemy = s.side === 'enemy';
      const ally = s.side === 'player' && !s.human;
      const kind = s.cfg.draw || '';
      const hullCol = enemy ? (ENEMY_COL[kind] || '#5a4a44') : ally ? ALLY_COL : s.color;
      const deckCol = enemy ? (kind === 'boss' ? '#5a3a34' : '#6e5a50') : ally ? ALLY_DECK : PALETTE.deck;

      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(s.heading);
      if (kind === 'cb' || kind === 'sub') {
         if (kind === 'cb') drawBattery(ctx, s, L, B, z, hullCol, world.time);
         else drawSub(ctx, s, L, B, z, hullCol, world.time);
         this._shipDamage(ctx, world, s, L * 0.6, B);
         ctx.restore();
         return;
      }

      // drop shadow (offset down-right in screen space => rotate back)
      ctx.save();
      ctx.rotate(-s.heading);
      ctx.translate(3, 4);
      ctx.rotate(s.heading);
      ctx.globalAlpha = 0.30;
      ctx.fillStyle = '#000';
      hullPath(ctx, L, B);
      ctx.fill();
      ctx.restore();

      // hull
      hullPath(ctx, L, B);
      const hg = ctx.createLinearGradient(0, -B / 2, 0, B / 2);
      hg.addColorStop(0, lighten(hullCol, 18));
      hg.addColorStop(0.5, hullCol);
      hg.addColorStop(1, darken(hullCol, 22));
      ctx.fillStyle = hg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // deck (inner, lighter)
      ctx.save();
      ctx.scale(0.86, 0.62);
      hullPath(ctx, L, B);
      ctx.fillStyle = deckCol;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.restore();

      // centerline
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L * 0.42, 0); ctx.lineTo(-L * 0.42, 0); ctx.stroke();

      if (kind) drawDetail(ctx, s, kind, L, B, z, hullCol, deckCol, world.time);
      else this._classicDeck(ctx, s, L, B, z, hullCol, deckCol);

      // hit flash
      if (s.hitFlash > 0) {
         ctx.globalAlpha = s.hitFlash * 0.55;
         ctx.fillStyle = '#fff';
         hullPath(ctx, L, B);
         ctx.fill();
         ctx.globalAlpha = 1;
      }
      this._shipDamage(ctx, world, s, L, B);
      ctx.restore();

      // boost flame (screen space)
      if (s.boost && s.boost.active) {
         ctx.save();
         ctx.translate(c.x, c.y);
         ctx.rotate(s.heading + Math.PI);
         ctx.translate(L * 0.5, 0);
         const fl = 14 + Math.random() * 10;
         const g = ctx.createLinearGradient(0, 0, fl, 0);
         g.addColorStop(0, 'rgba(120,200,255,0.9)');
         g.addColorStop(1, 'rgba(120,200,255,0)');
         ctx.fillStyle = g;
         ctx.beginPath();
         ctx.moveTo(0, -4); ctx.lineTo(fl, 0); ctx.lineTo(0, 4);
         ctx.closePath(); ctx.fill();
         ctx.restore();
      }
   }

   // the original generic warship deck: superstructure, bridge, funnel, gun houses
   _classicDeck(ctx, s, L, B, z, hullCol, deckCol) {
      // superstructure block (midships)
      const sw = L * 0.16, sh = B * 0.42;
      ctx.fillStyle = darken(deckCol, 14);
      ctx.fillRect(-sw * 0.4, -sh / 2, sw, sh);
      // bridge tower
      ctx.fillStyle = lighten(deckCol, 10);
      ctx.fillRect(sw * 0.15, -sh * 0.3, sw * 0.35, sh * 0.6);
      // funnel
      ctx.fillStyle = '#222a30';
      ctx.beginPath(); ctx.arc(-sw * 0.15, 0, Math.max(2, B * 0.10), 0, TAU); ctx.fill();

      for (const t of s.turrets) drawTurret(ctx, t, z, B, hullCol);
   }

   // fires & floods on deck (ship-local frame)
   _shipDamage(ctx, world, s, L, B) {
      for (let i = 0; i < s.fires.length; i++) {
         const f = s.fires[i];
         const fx = ((f.mod % 3) - 1) * L * 0.18, fy = (f.mod % 2 ? 1 : -1) * B * 0.18;
         drawFire(ctx, fx, fy, 4 + 3 * Math.sin(world.time * 11 + i * 2), world.time);
      }
      for (let i = 0; i < s.floods.length; i++) {
         const fo = s.floods[i];
         const fx = ((fo.mod % 3) - 1) * L * 0.2, fy = (fo.mod % 2 ? 1 : -1) * B * 0.2;
         ctx.fillStyle = 'rgba(90,170,255,0.5)';
         ctx.beginPath(); ctx.ellipse(fx, fy, 5, 3.5, 0, 0, TAU); ctx.fill();
      }
   }

   // Name + HP bar over every AI ship, drawn after the night/storm overlays so they stay legible.
   // Enemies red, allies green; mission targets (tagged) get a gold marker.
   _labels(ctx, world) {
      const cam = this.cam, z = cam.zoom;
      ctx.font = '10px "SF Mono", monospace';
      ctx.textAlign = 'center';
      for (const s of world.ships) {
         if (s.human || !shown(s) || !cam.visible(s.pos, 200)) continue;
         const enemy = s.side === 'enemy';
         const d = dimsOf(s);
         const c = cam.w2s(s.pos);
         const boss = s.cfg.draw === 'boss';
         const span = Math.max(d.L, d.beam * 1.3) * z;
         const bw = boss ? Math.max(110, span * 0.8) : Math.max(46, span * 0.7);
         const bx = c.x - bw / 2, by = c.y - span * 0.5 - 14;
         const target = !!s.tag;
         ctx.fillStyle = enemy ? (target ? 'rgba(255,214,121,0.95)' : 'rgba(255,180,160,0.9)') : 'rgba(170,255,190,0.92)';
         ctx.fillText((target && enemy ? '◆ ' : '') + s.name, c.x, by - 3);
         ctx.fillStyle = 'rgba(0,0,0,0.55)';
         ctx.fillRect(bx, by, bw, boss ? 6 : 4);
         ctx.fillStyle = enemy ? '#ff5a4d' : '#5ad07a';
         ctx.fillRect(bx, by, bw * clamp01(s.hp / s.maxHP), boss ? 6 : 4);
      }
   }

   // ================= GHOSTS (last known position of hidden enemies) =================
   _ghosts(ctx, world) {
      const cam = this.cam;
      for (const s of world.ships) {
         const age = ghostAge(world, s);
         if (age > VISION.ghostTime) continue;
         const lk = s.lastKnown;
         if (!cam.visible(lk.pos, 300)) continue;
         const d = dimsOf(s);
         const c = cam.w2s(lk.pos);
         const L = d.L * cam.zoom, B = d.beam * cam.zoom;
         const a = 0.55 * (1 - age / VISION.ghostTime) + 0.1;
         ctx.save();
         ctx.translate(c.x, c.y);
         ctx.rotate(lk.heading);
         ctx.globalAlpha = a;
         ctx.setLineDash([4, 4]);
         ctx.strokeStyle = '#ff9a8a';
         ctx.lineWidth = 1.5;
         hullPath(ctx, L, B);
         ctx.stroke();
         ctx.setLineDash([]);
         // course arrow: where it was heading when it vanished
         ctx.beginPath(); ctx.moveTo(L * 0.55, 0); ctx.lineTo(L * 0.9, 0); ctx.stroke();
         ctx.restore();
         ctx.globalAlpha = a;
         ctx.font = '10px "SF Mono", monospace';
         ctx.textAlign = 'center';
         ctx.fillStyle = '#ffb4a8';
         ctx.fillText(`? ${s.name} · ${Math.round(age)} s`, c.x, c.y - L * 0.5 - 8);
         ctx.globalAlpha = 1;
      }
      // secondary focus marker (RMB)
      const p = world.player;
      const f = p && p.secFocus;
      if (f && f.alive && f.visible) {
         const c = cam.w2s(f.pos);
         const r = dimsOf(f).L * cam.zoom * 0.62 + 6;
         ctx.strokeStyle = 'rgba(255,212,121,0.8)';
         ctx.lineWidth = 1.5;
         ctx.setLineDash([6, 5]);
         ctx.beginPath(); ctx.arc(c.x, c.y, r, world.time * 0.8, world.time * 0.8 + TAU); ctx.stroke();
         ctx.setLineDash([]);
      }
   }

   // ================= HIT MARKERS (player hits, fed by hud.onEvents) =================
   _hitMarks(ctx, world, dt) {
      const marks = world._hitMarks;
      if (!marks || !marks.length) return;
      const cam = this.cam;
      for (let i = marks.length - 1; i >= 0; i--) {
         const m = marks[i];
         m.age += dt;
         if (m.age > 0.7) { marks.splice(i, 1); continue; }
         const c = cam.w2s(m.pos);
         const t = m.age / 0.7;
         const r = (m.big ? 14 : 9) * (1 + t * 0.6);
         ctx.globalAlpha = 1 - t;
         ctx.strokeStyle = HIT_COL[m.outcome] || '#fff';
         ctx.lineWidth = m.big ? 3 : 2;
         ctx.beginPath();
         ctx.moveTo(c.x - r, c.y - r); ctx.lineTo(c.x - r * 0.35, c.y - r * 0.35);
         ctx.moveTo(c.x + r, c.y - r); ctx.lineTo(c.x + r * 0.35, c.y - r * 0.35);
         ctx.moveTo(c.x - r, c.y + r); ctx.lineTo(c.x - r * 0.35, c.y + r * 0.35);
         ctx.moveTo(c.x + r, c.y + r); ctx.lineTo(c.x + r * 0.35, c.y + r * 0.35);
         ctx.stroke();
      }
      ctx.globalAlpha = 1;
   }

   // ================= TORPEDO FAN PREVIEW (hold T) =================
   _torpFan(ctx, world) {
      const p = world.player;
      if (!world._torpPreview || !p || !p.alive || !p.cfg.torp) return;
      const cam = this.cam;
      const bearing = angleOf(p.aim);
      const l = p.launcherFor(bearing);
      const T = p.cfg.torp;
      const origin = l ? p.launcherPos(l) : p.pos;
      const ready = l && l.cd <= 0;
      const col = !l ? 'rgba(255,90,80,0.55)' : ready ? 'rgba(124,255,154,0.75)' : 'rgba(170,190,210,0.5)';
      const o = cam.w2s(origin);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(ready ? [10, 6] : [3, 7]);
      for (const a of p.torpFan(bearing)) {
         const e = cam.w2s(add(origin, fromAngle(a, T.range)));
         ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(e.x, e.y); ctx.stroke();
      }
      ctx.setLineDash([]);
      const lbl = !l ? 'Kein Werfer — Breitseite zeigen' : ready ? `Torpedos ${l.label} · ${p.torpSpread === 'wide' ? 'weit' : 'eng'}` : `${l.label} lädt: ${Math.ceil(l.cd)} s`;
      const tip = cam.w2s(add(origin, fromAngle(bearing, Math.min(T.range, 700))));
      ctx.font = 'bold 11px "SF Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#000';
      ctx.fillText(lbl, tip.x + 1, tip.y - 11);
      ctx.fillStyle = col;
      ctx.fillText(lbl, tip.x, tip.y - 12);
   }

   // ================= SMOKE =================
   _smoke(ctx, world) {
      const cam = this.cam;
      // persistent clouds
      for (const cl of world.smokeClouds) {
         if (!cam.visible(cl.c, cl.r)) continue;
         const c = cam.w2s(cl.c);
         const r = cl.r * cam.zoom;
         const a = clamp01(Math.min(cl.age * 0.5, cl.life * 0.4)) * 0.55;
         ctx.globalAlpha = a;
         ctx.drawImage(this._smokeSprite, c.x - r, c.y - r, r * 2, r * 2);
      }
      // drifting puffs
      for (const p of world.particles) {
         if (p.kind !== 'smoke' || !cam.visible(p.pos, p.r)) continue;
         const c = cam.w2s(p.pos);
         const r = p.r * cam.zoom * (1 + p.age * 0.5);
         ctx.globalAlpha = clamp01(p.life / 3) * 0.4;
         ctx.drawImage(this._smokeSprite, c.x - r, c.y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
   }

   // ================= EFFECTS =================
   _effects(ctx, world) {
      const cam = this.cam;
      for (const e of world.effects) {
         if (!cam.visible(e.pos, 300)) continue;
         const c = cam.w2s(e.pos);
         const t = clamp01(e.age / e.life);
         if (e.kind === 'muzzle') {
            ctx.save();
            ctx.translate(c.x, c.y);
            ctx.rotate(e.bearing);
            const r = (e.big ? 26 : 14) * (1 - t * 0.5) * Math.max(0.6, cam.zoom * 2);
            ctx.globalCompositeOperation = 'lighter';
            const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
            g.addColorStop(0, 'rgba(255,240,180,0.95)');
            g.addColorStop(0.4, 'rgba(255,160,60,0.7)');
            g.addColorStop(1, 'rgba(255,120,40,0)');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(r * 0.4, 0, r, 0, TAU); ctx.fill();
            ctx.restore();
            ctx.globalCompositeOperation = 'source-over';
         } else if (e.kind === 'explosion') {
            const R = (e.big ? 90 : 40) * cam.zoom * (0.3 + t * 1.1);
            ctx.globalCompositeOperation = 'lighter';
            const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R);
            g.addColorStop(0, `rgba(255,230,160,${0.9 * (1 - t)})`);
            g.addColorStop(0.5, `rgba(255,120,40,${0.6 * (1 - t)})`);
            g.addColorStop(1, 'rgba(255,80,20,0)');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, TAU); ctx.fill();
            // shock ring
            ctx.strokeStyle = `rgba(255,220,180,${0.5 * (1 - t)})`;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(c.x, c.y, R * 1.25, 0, TAU); ctx.stroke();
            ctx.globalCompositeOperation = 'source-over';
         } else if (e.kind === 'splash') {
            const R = (e.big ? 46 : 26) * cam.zoom;
            // column
            const h = R * 2.2 * Math.sin(Math.min(1, t * 1.6) * Math.PI);
            const g = ctx.createLinearGradient(c.x, c.y, c.x, c.y - h);
            g.addColorStop(0, 'rgba(200,235,255,0.75)');
            g.addColorStop(1, 'rgba(200,235,255,0)');
            ctx.fillStyle = g;
            ctx.fillRect(c.x - R * 0.25, c.y - h, R * 0.5, h);
            // rings
            ctx.strokeStyle = `rgba(220,245,255,${0.6 * (1 - t)})`;
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.ellipse(c.x, c.y, R * t * 1.6, R * t * 0.7, 0, 0, TAU); ctx.stroke();
         } else if (e.kind === 'fire') {
            drawFire(ctx, c.x, c.y, (e.big ? 16 : 9) * (0.8 + 0.3 * Math.sin(world.time * 13)), world.time);
         }
      }
      // spark / water particles
      for (const p of world.particles) {
         if (p.kind === 'smoke' || !cam.visible(p.pos, 20)) continue;
         const c = cam.w2s(p.pos);
         const a = clamp01(p.life / 0.6);
         ctx.globalAlpha = a;
         ctx.fillStyle = p.color || '#ffd24a';
         const r = Math.max(1, p.r * cam.zoom * 0.6);
         ctx.fillRect(c.x - r / 2, c.y - r / 2, r, r);
      }
      ctx.globalAlpha = 1;
   }

   // ================= SHELLS =================
   _shellShadows(ctx, world) {
      const cam = this.cam;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      for (const s of world.shells) {
         if (!cam.visible(s.pos, 50)) continue;
         const c = cam.w2s(s.pos);
         const h = Math.sin(s.arc * Math.PI);
         const r = Math.max(1.2, 2.2 * cam.zoom * 3) * (1 - h * 0.4);
         ctx.beginPath(); ctx.ellipse(c.x, c.y, r, r * 0.5, 0, 0, TAU); ctx.fill();
      }
   }

   _shells(ctx, world) {
      const cam = this.cam;
      for (const s of world.shells) {
         if (!cam.visible(s.pos, 60)) continue;
         const c = cam.w2s(s.pos);
         const h = Math.sin(s.arc * Math.PI);
         const lift = h * 90 * cam.zoom;
         const r = Math.max(1.6, 3 * cam.zoom * 2.2);
         // tracer streak
         const v = cam.w2s(add(s.pos, scale(s.vel, 0.03)));
         ctx.strokeStyle = s.owner === 'player' ? 'rgba(255,220,140,0.8)' : 'rgba(255,140,120,0.8)';
         ctx.lineWidth = r * 0.8;
         ctx.beginPath(); ctx.moveTo(v.x, v.y - lift); ctx.lineTo(c.x, c.y - lift); ctx.stroke();
         // shell body
         ctx.fillStyle = s.owner === 'player' ? '#ffe9b0' : '#ffb0a0';
         ctx.beginPath(); ctx.arc(c.x, c.y - lift, r, 0, TAU); ctx.fill();
      }
   }

   _torpedoes(ctx, world) {
      const cam = this.cam;
      for (const t of world.torpedoes) {
         if (!cam.visible(t.pos, 150)) continue;
         const z = cam.zoom;
         const col = t.owner === 'player' ? '#dff2ff' : '#ffb8a8';
         // wake trail: was a flat 1.5px screen-space line regardless of zoom or how
         // dangerous the torpedo is -- against moving water at combat zoom it was nearly
         // invisible. Now a soft glow underlay + a brighter core, both zoom-scaled and
         // widening with speed, so a running torpedo actually reads as a threat.
         if (t.wake.length > 1) {
            ctx.beginPath();
            const p0 = cam.w2s(t.wake[0]);
            ctx.moveTo(p0.x, p0.y);
            for (let i = 1; i < t.wake.length; i++) {
               const p = cam.w2s(t.wake[i]);
               ctx.lineTo(p.x, p.y);
            }
            ctx.strokeStyle = hexA(col, 0.18);
            ctx.lineWidth = Math.max(3, 5 * z);
            ctx.lineCap = 'round';
            ctx.stroke();
            ctx.strokeStyle = hexA(col, 0.75);
            ctx.lineWidth = Math.max(1.5, 2 * z);
            ctx.stroke();
         }
         const c = cam.w2s(t.pos);
         ctx.save();
         ctx.translate(c.x, c.y);
         ctx.rotate(t.dir);
         // body: scale with zoom like every other object (this used to be a fixed 10x3
         // SCREEN px regardless of zoom -- the only projectile that didn't scale with the
         // world, which is why it vanished at any zoom level below default).
         const len = Math.max(9, 9 * z * 4), wid = Math.max(3, 2.6 * z * 4);
         ctx.fillStyle = col;
         ctx.fillRect(-len / 2, -wid / 2, len, wid);
         // small bright nose-tip highlight so direction reads at a glance
         ctx.fillStyle = 'rgba(255,255,255,0.9)';
         ctx.beginPath(); ctx.arc(len / 2, 0, wid * 0.35, 0, TAU); ctx.fill();
         ctx.restore();
      }
   }

   _aaTracers(ctx, world) {
      const cam = this.cam;
      ctx.lineWidth = 1.5;
      for (const a of world.aaTracers) {
         if (!cam.visible(a.pos, 50)) continue;
         const c = cam.w2s(a.pos);
         const e = cam.w2s(add(a.pos, fromAngle(a.dir, 26)));
         ctx.strokeStyle = `rgba(255,240,200,${clamp01(1 - a.age / a.life)})`;
         ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(e.x, e.y); ctx.stroke();
      }
   }

   _damageNumbers(ctx, world) {
      const cam = this.cam;
      ctx.textAlign = 'center';
      for (const d of world.damageNumbers) {
         if (!cam.visible(d.pos, 50)) continue;
         const c = cam.w2s(d.pos);
         const a = clamp01(d.life / 0.5);
         const col = d.type === 'fire' ? '#ffb24d' : d.type === 'torp' ? '#7fd8ff' : '#ffcf6b';
         ctx.font = 'bold 13px "SF Mono", monospace';
         ctx.globalAlpha = a;
         ctx.fillStyle = '#000';
         ctx.fillText(d.text, c.x + 1, c.y - 10 + 1);
         ctx.fillStyle = col;
         ctx.fillText(d.text, c.x, c.y - 10);
      }
      ctx.globalAlpha = 1;
   }

   // ================= RETICLE / RANGE =================
   _reticle(ctx, world) {
      const p = world.player;
      if (!p || !p.alive) return;
      const cam = this.cam;
      const c = cam.w2s(p.pos);
      // Range rings: main battery, secondary, torpedo (if any), and detection radius --
      // each a distinct color+dash so "can I shoot this?" / "am I spotted?" reads at a
      // glance instead of guessing. Previously only the main-gun ring existed, at 14%
      // opacity -- everything else (secondary reach, torpedo reach, own detectability)
      // was invisible, which is exactly what "ranges aren't clear" means in practice.
      const ring = (range, color, dash) => {
         const R = range * cam.zoom;
         if (R < 4 || R > Math.max(cam.w, cam.h) * 1.5) return; // skip degenerate/offscreen rings
         ctx.strokeStyle = color;
         ctx.lineWidth = 1.5;
         if (dash) ctx.setLineDash(dash);
         ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, TAU); ctx.stroke();
         ctx.setLineDash([]);
      };
      ring(p.cfg.detect, 'rgba(255,90,90,0.16)', [3, 5]);           // spotting radius: enemies inside this see you
      if (p.cfg.torp) ring(p.cfg.torp.range, 'rgba(120,255,180,0.20)', [2, 10]); // torpedo reach
      if (p.cfg.sec) ring(p.cfg.sec.range, 'rgba(255,190,110,0.20)', [4, 6]);    // secondary reach
      ring(p.cfg.main.range, 'rgba(120,200,255,0.26)', [8, 6]);     // main battery reach
      // aim point (mouse)
      if (world._aimPoint) {
         const a = cam.w2s(world._aimPoint);
         const range = dist(p.pos, world._aimPoint);
         const outOfRange = range > p.cfg.main.range;
         ctx.strokeStyle = outOfRange ? 'rgba(255,90,80,0.9)' : 'rgba(255,212,121,0.9)';
         ctx.lineWidth = 1.5;
         const r = 10;
         ctx.beginPath();
         ctx.moveTo(a.x - r, a.y); ctx.lineTo(a.x - 3, a.y);
         ctx.moveTo(a.x + 3, a.y); ctx.lineTo(a.x + r, a.y);
         ctx.moveTo(a.x, a.y - r); ctx.lineTo(a.x, a.y - 3);
         ctx.moveTo(a.x, a.y + 3); ctx.lineTo(a.x, a.y + r);
         ctx.stroke();
         // lead line from ship to aim
         ctx.strokeStyle = 'rgba(255,212,121,0.25)';
         ctx.setLineDash([3, 6]);
         ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(a.x, a.y); ctx.stroke();
         ctx.setLineDash([]);
         // loaded ammo + range + one pip per turret (green: loaded & on target, amber: loaded
         // but still training / out of arc, grey: reloading)
         const ap = p.ammo === 'AP';
         ctx.font = 'bold 11px "SF Mono", monospace';
         ctx.textAlign = 'left';
         ctx.fillStyle = '#000';
         ctx.fillText(p.ammo || '', a.x + 15, a.y - 3);
         ctx.fillStyle = ap ? '#8fc8ff' : '#ffae5a';
         ctx.fillText(p.ammo || '', a.x + 14, a.y - 4);
         ctx.font = '10px "SF Mono", monospace';
         ctx.fillStyle = outOfRange ? '#ff6a5a' : 'rgba(207,232,255,0.85)';
         ctx.fillText((range / 1000).toFixed(1) + ' km' + (outOfRange ? ' ✕' : ''), a.x + 14, a.y + 9);
         const n = p.turrets.length;
         for (let i = 0; i < n; i++) {
            const t = p.turrets[i];
            const x = a.x - (n - 1) * 5 + i * 10, y = a.y + 18;
            ctx.fillStyle = t.cd > 0 ? 'rgba(140,150,160,0.6)' : t.aligned ? '#7CFF9A' : '#ffd479';
            if (t.cd > 0) {
               // reload progress as a pie
               ctx.beginPath(); ctx.moveTo(x, y);
               ctx.arc(x, y, 3.5, -Math.PI / 2, -Math.PI / 2 + TAU * clamp01(1 - t.cd / (t.cdMax || 1)));
               ctx.closePath(); ctx.fill();
               ctx.strokeStyle = 'rgba(140,150,160,0.6)'; ctx.lineWidth = 1;
               ctx.beginPath(); ctx.arc(x, y, 3.5, 0, TAU); ctx.stroke();
            } else { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, TAU); ctx.fill(); }
         }
      }
   }

   // ================= MINIMAP =================
   _minimap(world) {
      const g = this.minimapCtx;
      if (!g) return;
      // fixed CSS size (index.html: #minimap 180×180); backing store is dpr-scaled in main.resize()
      const W = 180, H = 180;
      const sc = W / (WORLD.ARENA * 2);
      const mx = (x) => W / 2 + x * sc;
      const my = (y) => H / 2 + y * sc;
      g.clearRect(0, 0, W, H);
      g.fillStyle = 'rgba(8,24,40,0.9)';
      g.fillRect(0, 0, W, H);
      // arena border
      g.strokeStyle = 'rgba(120,170,220,0.4)';
      g.strokeRect(mx(-WORLD.ARENA), my(-WORLD.ARENA), WORLD.ARENA * 2 * sc, WORLD.ARENA * 2 * sc);
      // obstacles
      for (const o of world.obstacles) {
         g.fillStyle = o.kind === 'reef' ? 'rgba(90,190,170,0.5)' : 'rgba(90,140,90,0.6)';
         g.beginPath(); g.arc(mx(o.c.x), my(o.c.y), Math.max(2, o.r * sc), 0, TAU); g.fill();
      }
      // smoke
      for (const cl of world.smokeClouds) {
         g.fillStyle = 'rgba(180,180,180,0.35)';
         g.beginPath(); g.arc(mx(cl.c.x), my(cl.c.y), Math.max(2, cl.r * sc), 0, TAU); g.fill();
      }
      drawMinimapExtras(g, world, mx, my, sc);
      // torpedoes
      for (const t of world.torpedoes) {
         g.fillStyle = t.owner === 'player' ? '#8fdcff' : '#ff9a8a';
         g.fillRect(mx(t.pos.x) - 1, my(t.pos.y) - 1, 2, 2);
      }
      // ships
      for (const s of world.ships) {
         const age = ghostAge(world, s);
         if (age <= VISION.ghostTime) {
            g.strokeStyle = `rgba(255,110,90,${0.25 + 0.5 * (1 - age / VISION.ghostTime)})`;
            g.lineWidth = 1;
            g.beginPath(); g.arc(mx(s.lastKnown.pos.x), my(s.lastKnown.pos.y), 3.5, 0, TAU); g.stroke();
            continue;
         }
         if (!shown(s)) continue;
         const x = mx(s.pos.x), y = my(s.pos.y);
         g.save();
         g.translate(x, y);
         g.rotate(s.heading);
         g.fillStyle = s.human ? '#ffffff' : s.side === 'player' ? '#7CFF9A' : '#ff5a4d';
         g.beginPath();
         g.moveTo(5, 0); g.lineTo(-3.5, -3); g.lineTo(-3.5, 3);
         g.closePath(); g.fill();
         g.restore();
      }
      // player view cone
      const p = world.player;
      if (p && p.alive) {
         g.strokeStyle = 'rgba(255,255,255,0.55)';
         g.beginPath(); g.arc(mx(p.pos.x), my(p.pos.y), 7, 0, TAU); g.stroke();
      }
   }

   // ================= COMPASS =================
   _compass(world) {
      const g = this.compassCtx;
      if (!g) return;
      // fixed CSS size (index.html: #compass 220×42); backing store is dpr-scaled in main.resize().
      // A heading tape: own course in the middle, ±90° either side, nautical bearings (N = 0°).
      const W = 220, H = 42, cx = W / 2, PX = W / 180;
      g.clearRect(0, 0, W, H);
      const p = world.player;
      const hdg = ((p ? p.heading : 0) / DEG + 90 + 360) % 360;   // world 0 = east -> nautical 90
      const rel = (b) => ((b - hdg + 540) % 360) - 180;            // -180..180 from own course
      const NAMES = { 0: 'N', 45: 'NO', 90: 'O', 135: 'SO', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
      g.textAlign = 'center';
      for (let b = 0; b < 360; b += 15) {
         const d = rel(b);
         if (Math.abs(d) > 92) continue;
         const x = cx + d * PX, major = b % 45 === 0;
         g.globalAlpha = 1 - Math.abs(d) / 110;
         g.strokeStyle = major ? 'rgba(207,232,255,0.9)' : 'rgba(207,232,255,0.4)';
         g.lineWidth = major ? 1.6 : 1;
         g.beginPath(); g.moveTo(x, H - 4); g.lineTo(x, H - (major ? 13 : 8)); g.stroke();
         if (major) {
            g.fillStyle = b % 90 === 0 ? '#e6f3ff' : 'rgba(207,232,255,0.7)';
            g.font = (b % 90 === 0 ? 'bold 12px' : '10px') + ' "SF Mono", Consolas, monospace';
            g.fillText(NAMES[b], x, H - 16);
         }
      }
      g.globalAlpha = 1;
      // own course: marker + readout
      g.fillStyle = '#ffd479';
      g.beginPath(); g.moveTo(cx, H - 2); g.lineTo(cx - 4, H - 9); g.lineTo(cx + 4, H - 9); g.closePath(); g.fill();
      g.font = 'bold 10px "SF Mono", Consolas, monospace';
      g.fillText(String(Math.round(hdg) % 360).padStart(3, '0') + '°', cx, 10);
      // enemy bearings: dots on the tape, edge arrows for contacts behind the beam
      for (const s of world.ships) {
         if (!shown(s) || s.side === 'player' || !p) continue;
         const d = rel((angleOf(sub(s.pos, p.pos)) / DEG + 90 + 360) % 360);
         g.fillStyle = '#ff5a4d';
         if (Math.abs(d) <= 90) { g.beginPath(); g.arc(cx + d * PX, 17, 3, 0, TAU); g.fill(); }
         else {
            const x = d > 0 ? W - 5 : 5, k = d > 0 ? -1 : 1;
            g.beginPath(); g.moveTo(x, 17); g.lineTo(x + k * 6, 13); g.lineTo(x + k * 6, 21); g.closePath(); g.fill();
         }
      }
   }
}

// ---------- helpers ----------
function hullPath(ctx, L, B) {
   ctx.beginPath();
   ctx.moveTo(L * 0.5, 0);                       // bow tip
   ctx.quadraticCurveTo(L * 0.42, B * 0.30, L * 0.30, B * 0.5);
   ctx.lineTo(-L * 0.38, B * 0.5);
   ctx.quadraticCurveTo(-L * 0.5, B * 0.42, -L * 0.5, B * 0.18);
   ctx.lineTo(-L * 0.5, -B * 0.18);
   ctx.quadraticCurveTo(-L * 0.5, -B * 0.42, -L * 0.38, -B * 0.5);
   ctx.lineTo(L * 0.30, -B * 0.5);
   ctx.quadraticCurveTo(L * 0.42, -B * 0.30, L * 0.5, 0);
   ctx.closePath();
}

function drawFire(ctx, x, y, r, time) {
   ctx.save();
   ctx.globalCompositeOperation = 'lighter';
   const flick = 0.8 + 0.2 * Math.sin(time * 17 + x);
   const g = ctx.createRadialGradient(x, y, 0, x, y, r * flick);
   g.addColorStop(0, 'rgba(255,240,160,0.95)');
   g.addColorStop(0.4, 'rgba(255,140,50,0.8)');
   g.addColorStop(1, 'rgba(255,80,20,0)');
   ctx.fillStyle = g;
   ctx.beginPath(); ctx.arc(x, y, r * flick, 0, TAU); ctx.fill();
   ctx.restore();
}

function makeSmokeSprite() {
   const c = document.createElement('canvas');
   c.width = c.height = 128;
   const g = c.getContext('2d');
   const rg = g.createRadialGradient(64, 64, 8, 64, 64, 64);
   rg.addColorStop(0, 'rgba(190,195,200,0.85)');
   rg.addColorStop(0.6, 'rgba(160,165,172,0.45)');
   rg.addColorStop(1, 'rgba(150,155,162,0)');
   g.fillStyle = rg;
   g.fillRect(0, 0, 128, 128);
   return c;
}

function makeGlowSprite() {
   const c = document.createElement('canvas');
   c.width = c.height = 64;
   const g = c.getContext('2d');
   const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
   rg.addColorStop(0, 'rgba(255,255,255,1)');
   rg.addColorStop(1, 'rgba(255,255,255,0)');
   g.fillStyle = rg;
   g.fillRect(0, 0, 64, 64);
   return c;
}

function lighten(hex, amt) { return shade(hex, amt); }
function darken(hex, amt) { return shade(hex, -amt); }
function hexA(hex, alpha) {
   const n = parseInt(hex.slice(1), 16);
   return `rgba(${n >> 16},${(n >> 8) & 0xff},${n & 0xff},${alpha})`;
}
function shade(hex, amt) {
   const n = parseInt(hex.slice(1), 16);
   let r = (n >> 16) + amt, g = ((n >> 8) & 0xff) + amt, b = (n & 0xff) + amt;
   r = clamp(r, 0, 255); g = clamp(g, 0, 255); b = clamp(b, 0, 255);
   return `rgb(${r},${g},${b})`;
}
