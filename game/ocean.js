// game/ocean.js — the sea. Pre-rendered tileable wave tile scrolled in world-space (parallax),
// plus a sun-glint band and distance fog at the arena edge. Cheap, and it looks alive.
import { PALETTE, TUNE } from './config.js';

const TILE = 512;

function buildTile() {
   const c = document.createElement('canvas');
   c.width = c.height = TILE;
   const g = c.getContext('2d');
    // base deep water — gradient must be vertically seamless (first == last stop)
    // or every tile row shows a hard seam line. Brighter + more saturated than before
    // so the sea reads as living water, not a flat dark field.
   const grad = g.createLinearGradient(0, 0, 0, TILE);
   grad.addColorStop(0, '#0e3350');
   grad.addColorStop(0.5, '#124062');
   grad.addColorStop(1, '#0e3350');
   g.fillStyle = grad;
   g.fillRect(0, 0, TILE, TILE);

    // layered sine wave ripples (foam highlights) — deterministic so the tile is seamless
   let seed = 1337;
   const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
   for (let pass = 0; pass < 3; pass++) {
      const scale = pass === 0 ? 64 : pass === 1 ? 32 : 16;
      const amp = pass === 0 ? 0.5 : pass === 1 ? 0.35 : 0.2;
      for (let y = 0; y < TILE; y += scale) {
         for (let x = 0; x < TILE; x += scale) {
            const phase = Math.sin((x / TILE) * Math.PI * 2 * (pass + 1) + y * 0.05) * 0.5 + 0.5;
            const n = rnd();
            if (n > 0.80) {
                // a short foam crest — denser + brighter than before
               const len = scale * (0.5 + n * 0.6);
               g.strokeStyle = `rgba(200,235,255,${(0.09 + phase * amp * 0.35).toFixed(3)})`;
               g.lineWidth = 1 + pass * 0.5;
               g.beginPath();
               const ox = x + (rnd() - 0.5) * scale, oy = y + (rnd() - 0.5) * scale;
               g.moveTo(ox, oy);
               g.lineTo(ox + Math.cos(phase * 6) * len, oy + Math.sin(phase * 6) * len * 0.5);
               g.stroke();
             }
         }
       }
    }
    // subtle caustic glow blobs — a touch stronger for depth shimmer
   for (let i = 0; i < 16; i++) {
      const x = rnd() * TILE, y = rnd() * TILE, r = 20 + rnd() * 50;
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, `rgba(130,195,245,${0.07})`);
      rg.addColorStop(1, 'rgba(130,195,245,0)');
      g.fillStyle = rg;
      g.fillRect(x - r, y - r, r * 2, r * 2);
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

       // parallax-scroll the tile in world space. zoom is px/meter; the tile represents TILE meters.
      const ts = TILE * zoom;
       // add a slow time-based "current" drift so the sea stays alive even when the ship holds station
      const driftX = this.time * 6, driftY = this.time * 3.5;
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
