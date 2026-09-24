// game/ocean.js — the sea. Pre-rendered tileable wave tile scrolled in world-space (parallax),
// plus a sun-glint band and distance fog at the arena edge. Cheap, and it looks alive.
import { PALETTE, TUNE } from './config.js';

const TILE = 512;

function buildTile() {
   const c = document.createElement('canvas');
   c.width = c.height = TILE;
   const g = c.getContext('2d');
   // base deep water -- vertically seamless gradient (first == last stop)
   const grad = g.createLinearGradient(0, 0, 0, TILE);
   grad.addColorStop(0, '#0e3350');
   grad.addColorStop(0.5, '#124062');
   grad.addColorStop(1, '#0e3350');
   g.fillStyle = grad;
   g.fillRect(0, 0, TILE, TILE);

   let seed = 1337;
   const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
   // every feature is drawn at its 3x3 wrapped copies so nothing is clipped at the tile border
   // (clipped blobs showed up as a faint square grid across the sea)
   const wrapped = (fn) => { for (const dx of [-TILE, 0, TILE]) for (const dy of [-TILE, 0, TILE]) fn(dx, dy); };
   // swell: broad soft light/dark bands, gives the water body
   for (let i = 0; i < 14; i++) {
      const x = rnd() * TILE, y = rnd() * TILE, r = 60 + rnd() * 110, dark = rnd() < 0.45;
      wrapped((dx, dy) => {
         const rg = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
         rg.addColorStop(0, dark ? 'rgba(4,20,36,0.16)' : 'rgba(120,190,240,0.07)');
         rg.addColorStop(1, 'rgba(0,0,0,0)');
         g.fillStyle = rg;
         g.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      });
   }
   // wave crests: short curved strokes, all roughly across the wind so the sea has a grain
   // instead of random scratches
   const WIND = -0.35;
   for (let i = 0; i < 150; i++) {
      const x = rnd() * TILE, y = rnd() * TILE;
      const big = rnd() < 0.25;
      const len = big ? 18 + rnd() * 22 : 7 + rnd() * 12;
      const a = WIND + (rnd() - 0.5) * 0.5, bend = (rnd() - 0.3) * len * 0.35;
      const ca = Math.cos(a), sa = Math.sin(a);
      const alpha = big ? 0.10 + rnd() * 0.08 : 0.05 + rnd() * 0.07;
      wrapped((dx, dy) => {
         const x0 = x + dx - ca * len / 2, y0 = y + dy - sa * len / 2;
         const x1 = x + dx + ca * len / 2, y1 = y + dy + sa * len / 2;
         g.strokeStyle = `rgba(205,235,255,${alpha.toFixed(3)})`;
         g.lineWidth = big ? 1.6 : 1;
         g.beginPath();
         g.moveTo(x0, y0);
         g.quadraticCurveTo(x + dx - sa * bend, y + dy + ca * bend, x1, y1);
         g.stroke();
      });
   }
   // caustic glints for a little shimmer
   for (let i = 0; i < 16; i++) {
      const x = rnd() * TILE, y = rnd() * TILE, r = 20 + rnd() * 45;
      wrapped((dx, dy) => {
         const rg = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
         rg.addColorStop(0, 'rgba(130,195,245,0.06)');
         rg.addColorStop(1, 'rgba(130,195,245,0)');
         g.fillStyle = rg;
         g.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      });
   }
   return c;
}

export class Ocean {
   constructor() {
      this.tile = buildTile();
      this.time = 0;
      this.sunAngle = -0.6; // direction the sun light comes from (world radians-ish, used for glint)
    }

   update(dt) { this.time += dt; }

    // render the sea into the main context, given camera (w,h, x,y, zoom, shake)
   render(ctx, cam) {
      const { w, h, zoom, x: cx, y: cy } = cam;
       // base fill (covers everything)
      ctx.fillStyle = PALETTE.seaDeep;
      ctx.fillRect(0, 0, w, h);

       // scroll the tile with the world: a camera move of d meters shifts it by d*zoom px. The
      // wrap modulus must be the pattern's own period (TILE px) -- wrapping at TILE*zoom made the
      // water jump sideways every few hundred meters.
      const ts = TILE;
       // Slow time-based "current" drift so the sea stays alive even when the ship holds
       // station. Must be defined in WORLD METERS/s and scaled by zoom like everything else --
       // this used to be raw SCREEN px/s (driftX = time*6), so at the default 0.42 zoom the
       // water visibly crept at ~14 m/s (faster than most ships!) independent of the world,
       // Now it is ~1.5 m/s of true current, always.
      const driftX = this.time * 1.5 * zoom, driftY = this.time * 0.9 * zoom;
       // pattern origin sits at screen (w/2 - offx); for the tile to be world-anchored
       // its phase must be (X - w/2 + offx)/ts == worldX/TILE  =>  offx = +cx*zoom
      let offx = (cx * zoom - driftX) % ts;
      let offy = (cy * zoom - driftY) % ts;
      offx = ((offx % ts) + ts) % ts;
      offy = ((offy % ts) + ts) % ts;
      if (!this._pattern) { try { this._pattern = ctx.createPattern(this.tile, 'repeat'); } catch (e) { return; } }
      const pattern = this._pattern;
      ctx.save();
      ctx.translate(w / 2 - offx, h / 2 - offy);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = pattern;
      ctx.fillRect(-w / 2 + offx - ts, -h / 2 + offy - ts, w + ts * 2, h + ts * 2);
      ctx.restore();
      ctx.globalAlpha = 1;

       // sun glint band along the sun direction on the water
      this._glint(ctx, cam);
       // distance fog / vignette at arena edge
      this._fog(ctx, cam);
   }

    _glint(ctx, cam) {
      const { w, h } = cam;
      const t = this.time;
       // the sun is infinitely far away: its screen anchor depends only on bearing,
       // so the light pool sits on one side of the view and shimmers gently
      const sa = this.sunAngle;
      const ax = w / 2 + Math.cos(sa) * Math.max(w, h);
      const ay = h / 2 + Math.sin(sa) * Math.max(w, h);
      const R = Math.max(w, h) * 1.15;
      const pulse = 0.75 + 0.25 * Math.sin(t * 0.7);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const rg = ctx.createRadialGradient(ax, ay, 0, ax, ay, R);
      rg.addColorStop(0, `rgba(255,220,150,${(0.22 * pulse).toFixed(3)})`);
      rg.addColorStop(0.45, `rgba(255,214,140,${(0.08 * pulse).toFixed(3)})`);
      rg.addColorStop(1, 'rgba(255,214,140,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, w, h);
      // sparse shimmering sparkles drifting through the lit side
      for (let i = 0; i < 26; i++) {
         const px = (((i * 97.3 + t * 14) % w) + w) % w;
         const py = (((i * 57.7 - t * 9) % h) + h) % h;
         if (Math.hypot(px - ax, py - ay) > R * 0.8) continue;
         const a = 0.04 + 0.09 * (0.5 + 0.5 * Math.sin(t * 3 + i * 2.1));
         ctx.fillStyle = `rgba(255,230,170,${a.toFixed(3)})`;
         ctx.fillRect(px, py, 2 + (i % 3), 1.5);
      }
      ctx.restore();
    }

    _fog(ctx, cam) {
      const { w, h } = cam;
       // radial vignette
      const rg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
      rg.addColorStop(0, 'rgba(4,10,20,0)');
      rg.addColorStop(1, 'rgba(4,10,20,0.42)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, w, h);
    }
}
