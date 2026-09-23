// game3d/minimap3d.js — 2D canvas overlays for the 3D mode (minimap + compass strip).
// Extracted from render3d.js; Renderer3D calls drawMinimap/drawCompass each frame.

export class HudCanvases3D {
   constructor() { this.minimapCtx = null; this.compassCtx = null; }
   setCanvases(minimap, compass) {
      this.minimapCtx = minimap ? minimap.getContext('2d') : null;
      this.compassCtx = compass ? compass.getContext('2d') : null;
   }
   draw(world) { this._minimap(world); this._compass(world); }

   // ================= MINIMAP (2D canvas overlay, same convention as render.js) =================
   _minimap(world) {
      const g = this.minimapCtx;
      if (!g) return;
      const W = 180, H = 180;
      const ARENA = 3800;
      const sc = W / (ARENA * 2);
      const mx = (x) => W / 2 + x * sc;
      const my = (y) => H / 2 + y * sc;
      g.clearRect(0, 0, W, H);
      g.fillStyle = 'rgba(8,24,40,0.9)';
      g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(120,170,220,0.4)';
      g.strokeRect(mx(-ARENA), my(-ARENA), ARENA * 2 * sc, ARENA * 2 * sc);
      for (const o of world.obstacles) {
         g.fillStyle = o.kind === 'reef' ? 'rgba(90,190,170,0.5)' : 'rgba(90,140,90,0.6)';
         g.beginPath(); g.arc(mx(o.c.x), my(o.c.y), Math.max(2, o.r * sc), 0, Math.PI * 2); g.fill();
      }
      for (const cl of world.smokeClouds) {
         g.fillStyle = 'rgba(180,180,180,0.35)';
         g.beginPath(); g.arc(mx(cl.c.x), my(cl.c.y), Math.max(2, cl.r * sc), 0, Math.PI * 2); g.fill();
      }
      for (const t of world.torpedoes) {
         g.fillStyle = t.owner === 'player' ? '#8fdcff' : '#ff9a8a';
         g.fillRect(mx(t.pos.x) - 1, my(t.pos.y) - 1, 2, 2);
      }
      for (const s of world.ships) {
         if (!s.alive) continue;
         const x = mx(s.pos.x), y = my(s.pos.y);
         g.save(); g.translate(x, y); g.rotate(s.heading);
         g.fillStyle = s.side === 'player' ? '#7CFF9A' : '#ff5a4d';
         g.beginPath(); g.moveTo(5, 0); g.lineTo(-3.5, -3); g.lineTo(-3.5, 3); g.closePath(); g.fill();
         g.restore();
      }
   }

   _compass(world) {
      const g = this.compassCtx;
      if (!g) return;
      const p = world.player;
      const W = 220, H = 42;
      g.clearRect(0, 0, W, H);
      g.fillStyle = 'rgba(8,24,40,0.85)';
      g.fillRect(0, 0, W, H);
      if (!p) return;
      const heading = p.heading;
      const pxPerDeg = W / 90;
      g.strokeStyle = 'rgba(160,200,240,0.5)';
      g.fillStyle = '#cfe8ff';
      g.font = '10px monospace';
      g.textAlign = 'center';
      const labels = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
      const headingDeg = heading * 180 / Math.PI;
      for (const [label, deg] of labels) {
         let delta = ((deg - headingDeg + 540) % 360) - 180;
         const x = W / 2 + delta * pxPerDeg;
         if (x > -20 && x < W + 20) { g.fillText(label, x, H / 2 + 4); }
      }
      g.strokeStyle = '#ffd479';
      g.beginPath(); g.moveTo(W / 2, 2); g.lineTo(W / 2 - 5, 14); g.lineTo(W / 2 + 5, 14); g.closePath(); g.fillStyle = '#ffd479'; g.fill();
   }
}
