// game3d/lead3d.js — pure logic of the lead marker (Vorhaltemarker): where a target will be when
// a salvo fired now lands, which enemy the marker belongs to, and where the marker sits on screen
// when the lead point is outside the view. No DOM / THREE; every function writes into a caller-owned
// `out` object so main3d.js can run it each frame without allocating.

// Lead point for a shell: fixed-point iteration on the flight time (which depends on the range to
// the lead point). flightTime(range m) -> s. out: { x, y, t }.
export function solveLead(sx, sy, tx, ty, vx, vy, flightTime, out) {
   let px = tx, py = ty, t = 0;
   for (let i = 0; i < 4; i++) {
      t = flightTime(Math.hypot(px - sx, py - sy));
      px = tx + vx * t; py = ty + vy * t;
   }
   out.x = px; out.y = py; out.t = t;
   return out;
}

// Lead point for a constant-speed weapon (torpedo): closed-form intercept. Returns false (out
// untouched) when the target cannot be caught.
export function solveIntercept(sx, sy, tx, ty, vx, vy, speed, out) {
   const rx = tx - sx, ry = ty - sy;
   const a = vx * vx + vy * vy - speed * speed, b = 2 * (rx * vx + ry * vy), c = rx * rx + ry * ry;
   let t = -1;
   if (Math.abs(a) < 1e-6) { if (Math.abs(b) > 1e-9) t = -c / b; }
   else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
         const q = Math.sqrt(disc), r1 = (-b - q) / (2 * a), r2 = (-b + q) / (2 * a);
         t = r1 > 0 && r2 > 0 ? Math.min(r1, r2) : Math.max(r1, r2);
      }
   }
   if (!(t > 0) || !Number.isFinite(t)) return false;
   out.x = tx + vx * t; out.y = ty + vy * t; out.t = t;
   return true;
}

// Marker state: 'lost' (target not in sight, dead-reckoned), 'range' (lead point beyond weapon
// range), else 'ok'.
export function leadState(visible, dist, range) {
   return !visible ? 'lost' : dist > range ? 'range' : 'ok';
}

// Screen placement. (x, y) = projected lead point in CSS px, `behind` = the point is behind the
// camera (then x/y are meaningless and `side` < 0 / >= 0 says whether it lies to the left / right).
// frame: { l, t, r, b } insets (px) of the area the marker may use (clear of the HUD panels).
// Inside the frame the point is kept; otherwise it is pushed onto the frame border along the ray
// from the screen centre, with out.off = true and out.ang = arrow direction (rad, canvas: 0 = right,
// +90° = down). out: { x, y, off, ang }.
export function edgeClamp(x, y, behind, side, W, H, frame, out) {
   const x0 = frame.l, y0 = frame.t, x1 = Math.max(x0 + 1, W - frame.r), y1 = Math.max(y0 + 1, H - frame.b);
   if (!behind && x >= x0 && x <= x1 && y >= y0 && y <= y1 && Number.isFinite(x) && Number.isFinite(y)) {
      out.x = x; out.y = y; out.off = false; out.ang = 0;
      return out;
   }
   // ray origin: the screen centre, moved into the frame if the HUD insets are lopsided
   const cx = Math.min(x1, Math.max(x0, W / 2)), cy = Math.min(y1, Math.max(y0, H / 2));
   let dx, dy;
   if (behind || !Number.isFinite(x) || !Number.isFinite(y)) { dx = side < 0 ? -1 : 1; dy = 0; }
   else { dx = x - cx; dy = y - cy; if (dx === 0 && dy === 0) dx = 1; }
   // largest k with centre + k * d inside the frame
   let k = Infinity;
   if (dx > 0) k = Math.min(k, (x1 - cx) / dx); else if (dx < 0) k = Math.min(k, (x0 - cx) / dx);
   if (dy > 0) k = Math.min(k, (y1 - cy) / dy); else if (dy < 0) k = Math.min(k, (y0 - cy) / dy);
   out.x = cx + dx * k; out.y = cy + dy * k; out.off = true; out.ang = Math.atan2(dy, dx);
   return out;
}

// Which enemy the marker follows when nothing is locked: the candidate with the smallest score
// (screen distance of its marker or lead point to the crosshair, px). The previous target keeps a
// bonus so the marker does not flip between two ships that are about equally close.
// cands: [{ id, score }] (first n entries used). Returns the index or -1.
export function pickTarget(cands, n, prevId, sticky = 0.6) {
   let best = -1, bs = Infinity;
   for (let i = 0; i < n; i++) {
      const c = cands[i];
      const s = c.id === prevId ? c.score * sticky : c.score;
      if (s < bs) { bs = s; best = i; }
   }
   return best;
}
