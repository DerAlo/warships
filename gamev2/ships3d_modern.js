// gamev2/ships3d_modern.js — procedural models of today's warships for the V2 mode.
//
// CONTRACT (sim / config side)
//   cfg.model          one of the keys of MODELS (ships3d_modern_defs.js): k130 f124 burke tico type45
//                      ford u212 virginia buyan gorshkov slava kirovn kuznetsov kilo type022 type054
//                      type052d type055 shandong yuan fac moudge ghadir tanker container lng.
//                      Unknown / missing key: the WW2 builder in ships3d.js runs unchanged.
//   cfg.hull.L, .beam  real size; every model is authored at a nominal size and scaled to these
//                      (x and y by L / L0, z by beam / B0). Missing values fall back to nominal.
//   cfg.hull.nation    de us uk ru cn ir -> paint (haze grey per navy, deck colour, markings).
//                      cfg.hull.color is NOT used for modern models; cfg.hull.modelColor (hex)
//                      overrides the hull grey if a mission needs a special livery.
//   cfg.hull.pennant   optional hull number string (digits only are drawn), else a class default.
//   cfg.hull.deckH, cfg.hull.sup.h   submarines only: periscope heads end 1.9 m above the water
//                      at periDepthM = deckH + sup.h + 1.5 (same rule as the WW2 boats).
//   ship.turrets[i]    turret i trains gun mount slot i of the model (bearing / elev / reload as
//                      before). Slots are fixed per model: modernGunSlots(model, L) returns
//                      [{ x, y (always 0), aft, style, caliber, guns }] in metres along the hull
//                      so the config can put turret offsets where the mounts really are. Sim
//                      turrets beyond the model's slots get no visual; mounts without a sim turret
//                      stay trained fore/aft.
//
// CONTRACT (renderer side): record fields added by ShipModels._buildModern
//   rec.modern   = model key
//   rec.anchors  = { name: [ { x, y, z, ... } ] } in body-local metres (x forward, y up from the
//                  waterline, z starboard); use ShipModels.anchorWorld(rec, name, i, out).
//        vlsFore / vlsAft  { x, y, z, l, w, cells }      centre of a vertical launcher field (launch +y)
//        ssm               { x, y, z, dir, elev, n }     canister group; dir = rad from the bow
//                                                        toward starboard, elev = rad above horizon
//        ciws              { x, y, z, dir, type }        gun CIWS (phalanx goalkeeper ak630 t730 kashtan)
//        pdms              { x, y, z, dir, type }        point-defence missile box (ram hq10)
//        decoy             { x, y, z, dir }              chaff / decoy launcher
//        heloDeck          { x, y, z, r }                helicopter spot (deck level)
//        flightDeck        { x, y, z, l, w, dir }        carriers: landing strip centre, dir of the strip
//        cat               { x, y, z, dir }              carriers: launch positions (catapult / ski-jump run)
//        mastTop           { x, y, z }                   top of the main mast (radar / ESM / flag)
//        sail              { x, y, z }                   submarines: top of the fin
//   rec.smoke    = funnel tops (as before; empty for nuclear ships and submarines)
//   rec.spinners = [{ obj, rate }] rotating radar antennas (separate meshes from detail 1 up;
//                  at detail 0 they are baked into the hull mesh and do not turn)
//   rec.turrets  = same shape as the WW2 records (yaw / pitch groups, tip, offs, cal, idx)
//   rec.d, rec.S = real-size dims and { deckAt(x), halfDeckAt(x) } like the WW2 records
//                  (carriers: flight deck; submarines: top of the hull)
//
// Bands (aBand) are the ship shader's: 0 plain, 1 hull side, 2 deck, 3 deckhouse, 4 rail, 5 wire.
import * as THREE from '../vendor/three/three.module.min.js';
import { GeoBuilder, clamp, lerp, smoothstep, lin, shade, mulberry32 } from './gfxcommon3d.js';
import { MODELS } from './ships3d_modern_defs.js';

export { MODELS };
export const isModernModel = (key) => !!(key && Object.prototype.hasOwnProperty.call(MODELS, key));

// ---------------- paint ----------------
const NAVY = {
   us: { hull: 0x7e878d, deck: 0x464b50 },
   de: { hull: 0x8b9397, deck: 0x53585b },
   uk: { hull: 0x8f969b, deck: 0x4d5357 },
   ru: { hull: 0x6c7880, deck: 0x6d3b2e },
   cn: { hull: 0x9aa2a7, deck: 0x52585d },
   ir: { hull: 0x7d8887, deck: 0x4e5557 },
};
export function modernPalette(nation, def, cfgHull) {
   const n = NAVY[nation] || NAVY[def.nation] || NAVY.us;
   let hull = lin(def.hullCol ?? n.hull);
   const mc = cfgHull?.modelColor;
   if (mc !== undefined && mc !== null && mc !== '') { try { hull = lin(mc); } catch (e) { /* keep */ } }
   const deck = lin(def.deckCol ?? n.deck);
   return {
      hull, deck, sup: def.supCol !== undefined ? lin(def.supCol) : shade(hull, 1.08), mast: shade(hull, 0.8),
      dark: lin(0x2a2d31), win: lin(0x0a0c0f), white: lin(0xd4d6d2), radar: lin(0x34373c), vls: shade(deck, 0.72),
      black: lin(0x101113), mark: lin(0xc9ccc8), yellow: lin(0xc9a227), red: lin(0x8a1f18), plane: lin(0x8a9399),
      tube: shade(hull, 0.9), fdeck: lin(0x3a3e42),
   };
}

// ---------------- low-level oriented faces ----------------
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();
// push triangle a,b,c so that its normal points away from `ref` (or along +y when ref is null)
function tri(arr, a, b, c, ref, off = 0) {
   _a.set(a[0], a[1], a[2]); _b.set(b[0], b[1], b[2]); _c.set(c[0], c[1], c[2]);
   _n.subVectors(_b, _a).cross(_c.sub(_a));
   if (_n.lengthSq() < 1e-7) return;
   _n.normalize();
   const out = ref ? (_a.x - ref[0]) * _n.x + (_a.y - ref[1]) * _n.y + (_a.z - ref[2]) * _n.z : _n.y;
   const s = out < 0 ? -1 : 1;
   const ox = _n.x * s * off, oy = _n.y * s * off, oz = _n.z * s * off;
   if (s > 0) arr.push(a[0] + ox, a[1] + oy, a[2] + oz, b[0] + ox, b[1] + oy, b[2] + oz, c[0] + ox, c[1] + oy, c[2] + oz);
   else arr.push(a[0] + ox, a[1] + oy, a[2] + oz, c[0] + ox, c[1] + oy, c[2] + oz, b[0] + ox, b[1] + oy, b[2] + oz);
}
function quad(arr, p0, p1, p2, p3, ref, off = 0) { tri(arr, p0, p1, p2, ref, off); tri(arr, p0, p2, p3, ref, off); }

// Prism between two plan polygons ([x,z] lists of equal length) at heights y0 / y1.
function prism(b, pb, pt, y0, y1, col, o = {}) {
   const n = pb.length;
   let cx = 0, cz = 0;
   for (const p of pb) { cx += p[0] / n; cz += p[1] / n; }
   const ref = [cx, (y0 + y1) / 2, cz];
   const arr = [];
   for (let i = 0; i < n; i++) {
      if (o.edges && !o.edges.includes(i)) continue;
      const j = (i + 1) % n;
      quad(arr, [pb[i][0], y0, pb[i][1]], [pb[j][0], y0, pb[j][1]], [pt[j][0], y1, pt[j][1]], [pt[i][0], y1, pt[i][1]], ref, o.off || 0);
   }
   b.band = o.band ?? 3;
   if (arr.length) b.tris(arr, col);
   if (o.cap !== false) {
      const top = [];
      let tx = 0, tz = 0;
      for (const p of pt) { tx += p[0] / n; tz += p[1] / n; }
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; tri(top, [tx, y1, tz], [pt[i][0], y1, pt[i][1]], [pt[j][0], y1, pt[j][1]], null); }
      b.band = o.capBand ?? 0;
      if (top.length) b.tris(top, o.top || shade(col, 0.82));
   }
   if (o.bottom) {
      const bot = [];
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; tri(bot, [cx, y0, cz], [pb[i][0], y0, pb[i][1]], [pb[j][0], y0, pb[j][1]], [cx, y0 + 1, cz]); }
      b.band = o.band ?? 3;
      if (bot.length) b.tris(bot, col);
   }
   b.band = 0;
}
// eight-point plan of a deckhouse: front corners cut by cf, aft corners by ca
function housePoly(xa, xb, w, cf, ca, z = 0) {
   cf = Math.min(cf, w); ca = Math.min(ca, w);
   return [[xb - cf, z + w], [xb, z + w - cf], [xb, z - (w - cf)], [xb - cf, z - w], [xa + ca, z - w], [xa, z - (w - ca)], [xa, z + w - ca], [xa + ca, z + w]];
}

// ---------------- seven-segment numerals (hull numbers, deck numbers) ----------------
const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgecd', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
function segRects(ch, w, h, t) {
   const s = SEG[ch]; if (!s) return [];
   const m = h / 2, R = { a: [0, h - t, w, h], b: [w - t, m, w, h], c: [w - t, 0, w, m], d: [0, 0, w, t], e: [0, 0, t, m], f: [0, m, t, h], g: [0, m - t / 2, w, m + t / 2] };
   return s.split('').map(k => R[k]);
}
// map(u, v) -> [x, y, z]; ref: point the faces look away from (null = up)
function drawNumber(b, str, hgt, map, ref, col) {
   const digits = String(str).replace(/[^0-9]/g, '').slice(0, 4);
   if (!digits) return;
   const w = hgt * 0.56, gap = hgt * 0.22, t = hgt * 0.17;
   const total = digits.length * w + (digits.length - 1) * gap;
   const arr = [];
   for (let i = 0; i < digits.length; i++) {
      const u0 = -total / 2 + i * (w + gap);
      for (const r of segRects(digits[i], w, hgt, t)) {
         quad(arr, map(u0 + r[0], r[1]), map(u0 + r[2], r[1]), map(u0 + r[2], r[3]), map(u0 + r[0], r[3]), ref ? ref(u0) : null);
      }
   }
   b.band = 0;
   if (arr.length) b.tris(arr, col);
}

// ---------------- gun mounts ----------------
export const GUN_STYLES = {
   mk45: { shape: 'facet', l: 5.2, w: 3.6, h: 2.7, cal: 127, bl: 6.6, br: 0.15 },
   oto127: { shape: 'facet', l: 5.6, w: 4.0, h: 3.0, cal: 127, bl: 7.4, br: 0.15 },
   mk8: { shape: 'facet', l: 4.8, w: 3.4, h: 2.6, cal: 114, bl: 5.6, br: 0.14 },
   oto76: { shape: 'dome', r: 1.7, h: 2.1, cal: 76, bl: 4.4, br: 0.1 },
   a190: { shape: 'facet', l: 4.4, w: 3.2, h: 2.4, cal: 100, bl: 5.6, br: 0.13 },
   a192: { shape: 'facet', l: 5.6, w: 4.0, h: 3.0, cal: 130, bl: 8.2, br: 0.16 },
   ak130: { shape: 'box', l: 6.2, w: 5.0, h: 3.2, cal: 130, bl: 8.4, br: 0.16, guns: 2 },
   pj38: { shape: 'facet', l: 5.6, w: 4.0, h: 3.0, cal: 130, bl: 8.2, br: 0.16 },
   pj26: { shape: 'facet', l: 4.2, w: 3.0, h: 2.4, cal: 76, bl: 4.6, br: 0.1 },
   ak630: { shape: 'dome', r: 0.95, h: 1.4, cal: 30, bl: 1.9, br: 0.12 },
   mg: { shape: 'mg', cal: 12.7, bl: 1.5, br: 0.05 },
};
// -> { house, barrel (BufferGeometry), pivot [x, y], tip, offs }
export function buildGunGeo(styleKey, col) {
   const st = GUN_STYLES[styleKey] || GUN_STYLES.mk45;
   const b = new GeoBuilder(), bb = new GeoBuilder();
   const dark = lin(0x26282b);
   let pivot;
   const guns = st.guns || 1;
   const offs = guns === 2 ? [-0.62, 0.62] : [0];
   if (st.shape === 'dome') {
      b.cyl(st.r * 0.92, st.r, 0.35, 0, 0, 0, shade(col, 0.85), 12);
      const g = new THREE.SphereGeometry(st.r * 0.9, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2);
      g.scale(1, (st.h - 0.35) / (st.r * 0.9), 1);
      b.put(g, 0, 0.35, 0, col);
      pivot = [st.r * 0.35, st.h * 0.52];
   } else if (st.shape === 'mg') {
      b.cyl(0.07, 0.09, 1.15, 0, 0, 0, dark, 5);
      b.box(0.5, 0.3, 0.3, 0, 1.2, 0, dark);
      pivot = [0, 1.2];
   } else {
      const hw = st.w / 2, xa = -st.l * 0.45, xb = st.l * 0.55;
      b.cyl(hw * 0.95, hw, 0.3, 0, 0, 0, shade(col, 0.85), 12);
      const box = st.shape === 'box';
      const pb = housePoly(xa, xb, hw, box ? hw * 0.25 : hw * 0.55, hw * 0.2);
      const pt = housePoly(xa + 0.25, xb - st.l * (box ? 0.16 : 0.3), hw * (box ? 0.82 : 0.6), hw * 0.2, hw * 0.12);
      prism(b, pb, pt, 0.3, st.h, col, { band: 0, top: shade(col, 0.9) });
      pivot = [st.l * (box ? 0.3 : 0.2), st.h * 0.56];
   }
   for (const z of offs) {
      bb.tubeX(st.br * 1.5, st.br, st.bl, 0, 0, z, dark, 6);
      if (st.shape !== 'mg') bb.box(st.br * 9, st.br * 5, st.br * 5, st.br * 4, 0, z, shade(col, 0.8));
   }
   return { house: b.build(), barrel: bb.build(), pivot, tip: st.bl, offs, cal: st.cal, guns };
}

// ---------------- rotating antennas ----------------
// built into `b` around (ox, oy, oz); `s` is the antenna width in metres
export function addSpinner(b, type, s, col, ox = 0, oy = 0, oz = 0) {
   const dark = lin(0x2c2f33);
   b.band = 0;
   b.cyl(0.18 + s * 0.03, 0.25 + s * 0.04, 0.9, ox, oy, oz, col, 6);
   const y = oy + 0.9;
   if (type === 'slab') {            // SMART-L / S1850M / Type 517: one big slab leaning back
      b.box(0.7, s * 0.52, s, ox - 0.2, y + s * 0.3, oz, dark, 0, 0.14);
      b.box(1.6, 0.5, s * 0.35, ox - 1.0, y + s * 0.2, oz, col);
   } else if (type === 'fregat') {   // Fregat / Top Plate / Type 382: two slabs back to back
      b.box(0.3, s * 0.42, s, ox + 0.35, y + s * 0.26, oz, dark, 0, -0.3);
      b.box(0.3, s * 0.42, s, ox - 0.35, y + s * 0.26, oz, dark, 0, 0.3);
   } else if (type === 'toppair') {  // Top Pair: a big lattice dish and a smaller one behind it
      b.box(0.5, s * 0.36, s, ox + 0.6, y + s * 0.2, oz, dark, 0, 0.1);
      b.box(0.4, s * 0.3, s * 0.6, ox - 1.1, y + s * 0.2, oz, dark, 0, -0.1);
      b.box(2.2, 0.6, 0.8, ox - 0.2, y + 0.3, oz, col);
   } else {                          // 'bar': navigation / surface search bar antenna
      b.box(0.35, Math.max(0.3, s * 0.12), s, ox, y + 0.15, oz, dark);
   }
}
export function buildSpinnerGeo(type, s, col) { const b = new GeoBuilder(); addSpinner(b, type, s, col); return b.build(); }

// ---------------- the kit the model definitions draw with (nominal metres) ----------------
class Kit {
   constructor(b, def, S, pal, detail, tools, opts) {
      this.b = b; this.def = def; this.S = S; this.c = pal; this.det = detail; this.tools = tools;
      this.L = def.L; this.B = def.B; this.h = def.L / 2;
      this.anchors = {}; this.smoke = []; this.guns = []; this.spinners = [];
      this.pennant = opts.pennant; this.rnd = mulberry32(opts.seed || 7); this.periTop = opts.periTop;
      this.last = null;
      this._dk = null; this._hw = null;
   }
   dk(x) { return this._dk ? this._dk(x) : this.S.deckAt(x); }
   hw(x) { return this._hw ? this._hw(x) : this.S.halfDeckAt(x); }
   anchor(name, o) { (this.anchors[name] || (this.anchors[name] = [])).push(o); return o; }

   prism(pb, pt, y0, y1, col, o) { prism(this.b, pb, pt, y0, y1, col, o); }
   lin(hex) { return lin(hex); }
   boxGeo(w, h, d) { return new THREE.BoxGeometry(w, h, d); }

   // --- solids ---
   bx(x0, x1, y0, y1, z0, z1, col, band = 0) { this.b.band = band; this.b.box(x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, col); this.b.band = 0; }
   // deckhouse from x0 (aft) to x1 (fore), half width hw, standing on y0 (null = on the deck), h high.
   // o: s side slope (m inset at the top), rf / ra top rake fore / aft, cf / ca plan corner cuts,
   //    z centre offset, col, band, top (cap colour), win [f0, f1] window band on the front faces
   hs(x0, x1, hw, y0, h, o = {}) {
      const z = o.z || 0;
      if (y0 === null || y0 === undefined) {
         y0 = Math.min(this.dk(x0), this.dk(x1)) - 0.15;
         if (!z && !this._hw) hw = Math.min(hw, Math.max(0.6, Math.min(this.hw(x0), this.hw(x1) + (o.cf || 0)) - 0.35));
      }
      const s = o.s ?? h * 0.13, rf = o.rf || 0, ra = o.ra || 0, cf = o.cf || 0, ca = o.ca || 0;
      const hwT = Math.max(0.15, hw - s), k = hwT / hw;
      const pb = housePoly(x0, x1, hw, cf, ca, z), pt = housePoly(x0 + ra, x1 - rf, hwT, cf * k, ca * k, z);
      const col = o.col || this.c.sup;
      prism(this.b, pb, pt, y0, y0 + h, col, { band: o.band ?? 3, top: o.top || shade(this.c.deck, 1.05), cap: o.cap });
      this.last = { pb, pt, y0, y1: y0 + h };
      if (o.win) this.winBand(o.win[0], o.win[1], o.winEdges || [0, 1, 2]);
      return y0 + h;
   }
   // dark window band on some faces of the last deckhouse, between height fractions f0..f1
   winBand(f0, f1, edges = [0, 1, 2]) {
      const l = this.last; if (!l) return;
      const at = (f) => l.pb.map((p, i) => [lerp(p[0], l.pt[i][0], f), lerp(p[1], l.pt[i][1], f)]);
      prism(this.b, at(f0), at(f1), lerp(l.y0, l.y1, f0), lerp(l.y0, l.y1, f1), this.c.win, { band: 0, cap: false, edges, off: 0.07 });
   }
   // centre / outward normal / lean of face i of the last deckhouse at height fraction fy
   face(i, fy = 0.5, fa = 0.5) {
      const l = this.last, n = l.pb.length, j = (i + 1) % n;
      const mb = [lerp(l.pb[i][0], l.pb[j][0], fa), lerp(l.pb[i][1], l.pb[j][1], fa)], mt = [lerp(l.pt[i][0], l.pt[j][0], fa), lerp(l.pt[i][1], l.pt[j][1], fa)];
      let nx = l.pb[j][1] - l.pb[i][1], nz = -(l.pb[j][0] - l.pb[i][0]);
      let cx = 0, cz = 0; for (const p of l.pb) { cx += p[0] / n; cz += p[1] / n; }
      if (nx * (mb[0] - cx) + nz * (mb[1] - cz) < 0) { nx = -nx; nz = -nz; }
      const len = Math.hypot(nx, nz) || 1; nx /= len; nz /= len;
      const inset = (mb[0] - mt[0]) * nx + (mb[1] - mt[1]) * nz;
      return { x: lerp(mb[0], mt[0], fy), y: lerp(l.y0, l.y1, fy), z: lerp(mb[1], mt[1], fy), nx, nz, tilt: Math.atan2(inset, l.y1 - l.y0), w: Math.hypot(l.pb[j][0] - l.pb[i][0], l.pb[j][1] - l.pb[i][1]) };
   }
   // phased-array face on face i of the last deckhouse: sides 8 = octagon (SPY-1), 4 = square
   arr(i, fy, r, sides = 8, col = null, fa = 0.5) {
      const f = this.face(i, fy, fa);
      const g = new THREE.CylinderGeometry(r, r, 0.3, sides);
      g.rotateY(Math.PI / sides);
      this.b.band = 0;
      this.b.put(g, f.x + f.nx * 0.12, f.y, f.z + f.nz * 0.12, col || shade(this.c.sup, 0.74), 0, Math.atan2(-f.nz, f.nx), -Math.PI / 2 + f.tilt);
   }
   ball(x, y, z, r, col, dome = false) {
      this.b.band = 0;
      const g = dome ? new THREE.SphereGeometry(r, this.det ? 12 : 8, this.det ? 5 : 3, 0, Math.PI * 2, 0, Math.PI / 2)
         : new THREE.SphereGeometry(r, this.det ? 10 : 7, this.det ? 7 : 5);
      this.b.put(g, x, y, z, col || this.c.white);
   }
   mast(x, y0, h, r0, r1, o = {}) {
      this.b.band = 0;
      this.b.cyl(r1, r0, h, x, y0, o.z || 0, o.col || this.c.mast, o.seg || 6, Math.atan2(o.rake || 0, h));
      return y0 + h;
   }
   yard(x, y, half, r = 0.14) { this.b.band = 0; this.b.cyl(r, r, half * 2, x, y, -half, this.c.mast, 4, 0, Math.PI / 2); }
   whip(x, y, z, h, lean = 0.6) { if (this.det >= 2) this.tools.wire(this.b, x, y, z, x - lean, y + h, z, this.c.dark, 0.12); }
   mastTop(x, y, z = 0) { this.anchor('mastTop', { x, y, z }); }
   // funnel: a raked deckhouse with a black cap; registers a smoke point (none for gas-turbine-free hulls)
   funnel(x0, x1, hw, y0, h, o = {}) {
      const y = this.hs(x0, x1, hw, y0, h, { s: h * 0.1, rf: 1, ra: 0.5, cf: hw * 0.5, ca: hw * 0.5, ...o, top: this.c.black });
      const l = this.last;
      prism(this.b, l.pt.map(p => [p[0], p[1]]), l.pt.map(p => [lerp(p[0], (x0 + x1) / 2, 0.12), lerp(p[1], o.z || 0, 0.12)]), y, y + 0.7, this.c.black, { band: 0, top: this.c.black });
      if (o.smoke !== false) this.smoke.push(new THREE.Vector3((x0 + x1) / 2 + ((o.ra || 0.5) - (o.rf ?? 1)) / 2, y + 0.9, o.z || 0));
      return y;
   }

   // --- weapons and fittings ---
   gun(style, x, o = {}) {
      const y = o.y ?? this.dk(x) + this.B * 0.012 - 0.1;
      this.guns.push({ style, x, y, z: o.z || 0, aft: o.aft ?? x < 0 });
   }
   spin(type, x, y, z, size, rate = 1.6) {
      if (this.det < 1) addSpinner(this.b, type, size, this.c.mast, x, y, z);
      else this.spinners.push({ type, x, y, z, size, rate });
   }
   vls(name, x0, x1, hw, y = null, cells = 32) {
      if (y === null) y = Math.min(this.dk(x0), this.dk(x1)) + this.B * 0.006;
      this.bx(x0, x1, y, y + 0.32, -hw, hw, this.c.vls);
      if (this.det >= 2) {
         const nx = Math.max(2, Math.round((x1 - x0) / 2.2)), nz = Math.max(2, Math.round(hw * 2 / 2.2));
         for (let i = 1; i < nx; i++) { const x = lerp(x0, x1, i / nx); this.bx(x - 0.09, x + 0.09, y + 0.3, y + 0.38, -hw, hw, this.c.mark); }
         for (let i = 1; i < nz; i++) { const z = lerp(-hw, hw, i / nz); this.bx(x0, x1, y + 0.3, y + 0.38, z - 0.09, z + 0.09, this.c.mark); }
      }
      this.anchor(name, { x: (x0 + x1) / 2, y: y + 0.35, z: 0, l: x1 - x0, w: hw * 2, cells });
   }
   // canister launcher group: n tubes side by side (o.rows stacks them), pointing `dir`, raised `elev`
   ssm(x, y, z, dir, elev, n, o = {}) {
      const len = o.len || 5, r = o.r || 0.4, rows = o.rows || 1, cols = Math.ceil(n / rows);
      const col = o.col || this.c.tube;
      this.b.band = 0;
      if (this.det < 1 || o.box) {
         this.b.put(new THREE.BoxGeometry(len, r * 2 * rows, r * 2.1 * cols), x, y, z, col, 0, -dir, elev);
      } else {
         const px = -Math.sin(dir), pz = Math.cos(dir);
         for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
            const o2 = (i - (cols - 1) / 2) * r * 2.15, up = (j - (rows - 1) / 2) * r * 2.1;
            this.b.put(new THREE.CylinderGeometry(r, r, len, 6), x + px * o2, y + up, z + pz * o2, col, 0, -dir, -Math.PI / 2 + elev);
         }
      }
      if (o.stand !== false) this.b.box(len * 0.5, Math.max(0.3, y - (o.base ?? y - 0.8)), r * 2 * cols, x, (y + (o.base ?? y - 0.8)) / 2 - r * 0.5, z, shade(col, 0.8), -dir);
      this.anchor('ssm', { x, y, z, dir, elev, n });
   }
   ciws(type, x, y, z, dir = 0) {
      const b = this.b, c = this.c;
      b.band = 0;
      const dx = Math.cos(dir), dz = Math.sin(dir);
      const barrel = (yy, len, r) => b.put(new THREE.CylinderGeometry(r, r, len, 5), x + dx * len * 0.5, y + yy, z + dz * len * 0.5, c.black, 0, -dir, -Math.PI / 2 + 0.12);
      if (type === 'ram' || type === 'hq10') {
         b.cyl(0.45, 0.6, 1.0, x, y, z, c.sup, 6);
         b.put(new THREE.BoxGeometry(2.2, 1.5, type === 'ram' ? 1.5 : 2.2), x + dx * 0.2, y + 1.7, z + dz * 0.2, shade(c.sup, 0.92), 0, -dir, 0.35);
         this.anchor('pdms', { x, y: y + 1.9, z, dir, type });
         return;
      }
      if (type === 'phalanx') {
         b.cyl(0.8, 0.95, 0.7, x, y, z, c.sup, 8);
         b.cyl(0.6, 0.6, 2.3, x, y + 0.7, z, c.white, 8);
         if (this.det) this.ball(x, y + 3.0, z, 0.6, c.white);
         barrel(1.3, 1.9, 0.14);
      } else if (type === 'ak630') {
         b.cyl(0.85, 1.0, 1.0, x, y, z, c.sup, 8);
         if (this.det) this.ball(x, y + 1.0, z, 0.8, c.sup);
         barrel(1.25, 1.9, 0.16);
      } else {   // goalkeeper, t730, kashtan: boxy mount, gun, tracker on top
         b.cyl(0.9, 1.1, 0.5, x, y, z, c.sup, 8);
         b.put(new THREE.BoxGeometry(2.2, 2.2, type === 'kashtan' ? 3.4 : 2.2), x, y + 1.6, z, type === 'goalkeeper' ? c.white : c.sup, 0, -dir, 0);
         barrel(1.5, 2.6, 0.2);
         if (this.det) b.put(new THREE.CylinderGeometry(0.7, 0.7, 0.25, 8), x - dx * 0.3, y + 3.3, z - dz * 0.3, c.radar, 0, -dir, -Math.PI / 2 + 0.3);
      }
      this.anchor('ciws', { x, y: y + 1.5, z, dir, type });
   }
   decoy(x, y, z, dir) {
      this.b.band = 0;
      this.b.put(new THREE.BoxGeometry(1.5, 1.0, 1.3), x, y + 0.9, z, this.c.dark, 0, -dir, 0.7);
      this.anchor('decoy', { x, y: y + 1.2, z, dir });
   }

   // --- markings ---
   ring(x, y, z, r, w, col) { this.b.band = 0; this.b.put(new THREE.RingGeometry(r - w, r, this.det >= 2 ? 24 : 12), x, y, z, col, -Math.PI / 2); }
   line(x0, z0, x1, z1, w, y, col) {
      const dx = x1 - x0, dz = z1 - z0;
      this.b.band = 0;
      this.b.box(Math.hypot(dx, dz), 0.05, w, (x0 + x1) / 2, y, (z0 + z1) / 2, col, -Math.atan2(dz, dx));
   }
   helo(x0, x1, o = {}) {
      const xc = (x0 + x1) / 2, y = (o.y ?? this.dk(xc) + this.B * 0.012) + 0.07, hw = o.hw ?? Math.min(this.hw(x0), this.hw(x1)) - 0.8;
      const r = Math.min(hw * 0.62, (x1 - x0) * 0.36), c = this.c.mark, z = o.z || 0;
      this.ring(xc, y, z, r, 0.35, c);
      if (this.det >= 1) {
         this.line(x0 + 1, z, x1 - 1, z, 0.3, y, c);
         for (const s of [1, -1]) this.line(x0 + 1, z + s * hw, x1 - 1, z + s * hw, 0.3, y, c);
         this.line(x1 - 1, z - hw, x1 - 1, z + hw, 0.3, y, c);
      }
      if (this.det >= 3 && o.parked !== false) this.heli(xc, y, z, o.yaw || 0);
      this.anchor('heloDeck', { x: xc, y, z, r });
   }
   // parked helicopter (detail 3 only)
   heli(x, y, z, yaw) {
      const b = this.b, c = this.c.plane, cs = Math.cos(yaw), sn = Math.sin(yaw);
      b.band = 0;
      b.box(6.2, 2.1, 2.1, x + cs * 0.8, y + 1.9, z + sn * 0.8, c, -yaw);
      b.box(6.0, 0.6, 0.5, x - cs * 5, y + 2.4, z - sn * 5, c, -yaw);
      b.box(0.9, 1.9, 0.2, x - cs * 7.8, y + 3.2, z - sn * 7.8, c, -yaw);
      b.box(13, 0.08, 0.5, x + cs * 0.6, y + 3.5, z + sn * 0.6, this.c.dark, -yaw + 0.5);
      b.box(13, 0.08, 0.5, x + cs * 0.6, y + 3.5, z + sn * 0.6, this.c.dark, -yaw + 0.5 + Math.PI / 2);
   }
   // parked jet on a flight deck (detail >= 2)
   jet(x, z, yaw) {
      const b = this.b, c = this.c.plane, y = this.dk(x) + 0.2, cs = Math.cos(yaw), sn = Math.sin(yaw);
      const at = (lx, lz) => [x + cs * lx - sn * lz, z + sn * lx + cs * lz];
      b.band = 0;
      b.box(16, 1.5, 1.7, x, y + 2.0, z, c, -yaw);
      let p = at(-1.5, 0); b.box(5, 0.25, 10.5, p[0], y + 2.0, p[1], c, -yaw);
      p = at(-7, 0); b.box(2.6, 0.2, 6, p[0], y + 2.1, p[1], c, -yaw);
      for (const s of [1, -1]) { p = at(-6.4, s * 1.3); b.box(2.6, 2.6, 0.2, p[0], y + 3.6, p[1], c, -yaw, 0, s * 0.25); }
      p = at(3.6, 0); b.box(2.2, 0.6, 0.9, p[0], y + 2.9, p[1], this.c.win, -yaw);
   }
   // hull number on both bows (detail >= 2); u = position as a fraction of the half length
   num(def, u = 0.78) {
      if (this.det < 2) return;
      const str = this.pennant || def; if (!str) return;
      const S = this.S, L = this.L;
      const dyc = S.deckY(u), hgt = Math.min(3.4, dyc * 0.42), yb = dyc * 0.4;
      const surf = (x, y) => {
         const uu = clamp(x / (L / 2), -1, 1), dy = S.deckY(uu), k = S.keel(uu);
         const w = S.hb * S.wl(uu), wdk = S.hb * S.wd(uu) * S.P.tumble;
         return [x + S.rake(uu, clamp((y - k) / (dy - k), 0, 1)), y, lerp(w, wdk, Math.pow(clamp(y / dy, 0, 1), 1.3)) + 0.09];
      };
      const xc = u * L / 2;
      for (const s of [1, -1]) {
         drawNumber(this.b, str, hgt, (uu, v) => { const p = surf(xc + s * uu, yb + v); return [p[0], p[1], p[2] * s]; }, () => [xc, yb, 0], this.c.mark);
      }
   }
   deckNum(str, x, z, hgt, y) {
      if (this.det < 2 || !str) return;
      drawNumber(this.b, str, hgt, (u, v) => [x + v, y, z + u], null, this.c.mark);
   }

   // --- carrier flight deck: st = [[x, zPort, zStbd], ...] from stern to bow; ramp(x) = ski-jump rise ---
   flightDeck(st, yF, ramp = null) {
      const b = this.b, hullHW = (x) => this.S.halfDeckAt(x), col = this.c.fdeck, side = shade(this.c.hull, 0.95);
      const yAt = (x) => yF + (ramp ? ramp(x) : 0);
      const top = [], sk = [];
      for (let i = 0; i < st.length - 1; i++) {
         const a = st[i], c = st[i + 1], ya = yAt(a[0]), yc = yAt(c[0]);
         quad(top, [a[0], ya, a[1]], [a[0], ya, a[2]], [c[0], yc, c[2]], [c[0], yc, c[1]], null);
         for (const k of [1, 2]) {
            const sg = k === 1 ? -1 : 1;
            const lo = (p, y) => { const hh = hullHW(p[0]), over = Math.abs(p[k]) - hh; return [p[0], y - 1.3 - clamp(over, 0, 5) * 0.75, sg * Math.min(Math.abs(p[k]), hh + Math.max(0, over) * 0.25)]; };
            quad(sk, [a[0], ya, a[k]], [c[0], yc, c[k]], lo(c, yc), lo(a, ya), [(a[0] + c[0]) / 2, ya - 3, 0]);
         }
      }
      for (const e of [st[0], st[st.length - 1]]) { const y = yAt(e[0]); quad(sk, [e[0], y, e[1]], [e[0], y, e[2]], [e[0], y - 1.3, e[2]], [e[0], y - 1.3, e[1]], [0, y, 0]); }
      b.band = 2; b.tris(top, col);
      b.band = 3; b.tris(sk, side);
      b.band = 0;
      const edge = (x, k) => {
         for (let i = 0; i < st.length - 1; i++) if (x <= st[i + 1][0] || i === st.length - 2) { const t = clamp((x - st[i][0]) / (st[i + 1][0] - st[i][0]), 0, 1); return lerp(st[i][k], st[i + 1][k], t); }
         return 0;
      };
      this._dk = yAt;
      this._hw = (x) => Math.min(-edge(x, 1), edge(x, 2));
      this.deckEdge = edge;
      return yAt;
   }
}

// ---------------- hulls that are not lofted ship hulls ----------------
// body of revolution for submarines: axis at yc, radius R, parallel midbody between ut and un
function subHull(b, def, col) {
   const L = def.L, R = def.B / 2, yc = def.D - R, un = def.nose ?? 0.72, ut = def.tail ?? -0.25;
   const NS = 26, M = 14;
   const rad = (u) => u > un ? R * Math.pow(Math.max(0, 1 - Math.pow((u - un) / (1 - un), 2)), 0.5)
      : u < ut ? R * (0.07 + 0.93 * Math.pow(Math.max(0, 1 - Math.pow((ut - u) / (1 + ut), 1.5)), 0.9)) : R;
   const pos = [], idx = [];
   for (let i = 0; i < NS; i++) {
      const s = -1 + 2 * i / (NS - 1), u = Math.sin(s * Math.PI / 2) * 0.55 + s * 0.45, r = Math.max(0.02, rad(u));
      for (let j = 0; j < M; j++) { const a = j / M * Math.PI * 2; pos.push(u * L / 2, yc + Math.cos(a) * r, Math.sin(a) * r); }
   }
   for (let i = 0; i < NS - 1; i++) for (let j = 0; j < M; j++) {
      const a = i * M + j, a2 = i * M + (j + 1) % M, c = a + M, c2 = a2 + M;
      idx.push(a, a2, c, a2, c2, c);
   }
   const g = new THREE.BufferGeometry();
   g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
   g.setIndex(idx);
   g.computeVertexNormals();
   b.band = 0;
   b.raw(pos, g.attributes.normal.array, idx, col);
   g.dispose();
   return { rad, yc, R };
}

// ---------------- entry point ----------------
// tools: { makeHullShape, loftHull, wire } from ships3d.js (passed in: no circular import)
// -> { geo, d, S, smoke, anchors, guns, spinners, def, pal } in REAL metres
export function buildModernHull(ship, detail, tools) {
   const cfg = ship.cfg || {}, h = cfg.hull || {};
   const def = MODELS[cfg.model];
   const L = Number(h.L) > 0 ? Number(h.L) : def.L, B = Number(h.beam) > 0 ? Number(h.beam) : def.B;
   const sx = L / def.L, sz = B / def.B, sy = sx;
   const pal = modernPalette(h.nation, def, h);
   const b = new GeoBuilder();
   const d0 = { L: def.L, B: def.B, T: def.T, D: def.D, type: def.kind === 'cv' ? 'CV' : def.kind === 'sub' ? 'SS' : def.kind === 'merchant' ? 'TR' : 'DD', P: def.P };
   let S, sub = null;
   const lofted = def.kind === 'ship' || def.kind === 'cv' || def.kind === 'merchant';
   if (lofted) {
      S = tools.makeHullShape(d0);
      tools.loftHull(b, d0, S, pal.hull, pal.deck);
   } else if (def.kind === 'sub') {
      sub = subHull(b, def, pal.hull);
      const R = def.B / 2;
      S = { deckAt: () => def.D, halfDeckAt: (x) => Math.max(0.3, sub.rad(clamp(x / (def.L / 2), -1, 1)) * 0.45), hb: R };
   } else {
      const hb = def.B / 2;
      S = { deckAt: () => def.D, halfDeckAt: (x) => hb * clamp((def.L / 2 - x) / (def.L * 0.22), 0.15, 1), hb };
   }
   let periTop = null;
   if (def.kind === 'sub' && Number(h.deckH) > 0) periTop = (Number(h.deckH) + (Number(h.sup?.h) || 5) + 1.5 + 1.9) / sy;
   const seed = String(ship.cls || cfg.model).split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
   const k = new Kit(b, def, S, pal, detail, tools, { pennant: h.pennant, seed, periTop });
   k.sub = sub;
   def.build(k);
   for (const g of def.gunSlots || []) k.gun(g.style, g.x, g);
   // scale to the real size
   const P = b.pos;
   if (sx !== 1 || sz !== 1) for (let i = 0; i < P.length; i += 3) { P[i] *= sx; P[i + 1] *= sy; P[i + 2] *= sz; }
   const geo = b.build();
   const sc = (o) => { const r = { ...o, x: o.x * sx, y: o.y * sy, z: (o.z || 0) * sz }; if (r.l) r.l *= sx; if (r.w) r.w *= sz; if (r.r) r.r *= Math.min(sx, sz); return r; };
   const anchors = {};
   for (const n in k.anchors) anchors[n] = k.anchors[n].map(sc);
   const dk = (x) => k.dk(x), hwf = (x) => k.hw(x);
   return {
      geo, def, pal, scale: sx,
      d: { L, B, T: def.T * sy, D: def.D * sy, type: d0.type },
      S: { deckAt: (x) => dk(clamp(x / sx, -def.L / 2, def.L / 2)) * sy, halfDeckAt: (x) => hwf(clamp(x / sx, -def.L / 2, def.L / 2)) * sz },
      smoke: k.smoke.map(p => new THREE.Vector3(p.x * sx, p.y * sy, p.z * sz)),
      anchors,
      guns: k.guns.map(sc),
      spinners: k.spinners.map(sc),
      camo: def.camo || 0, merchant: def.kind === 'merchant',
   };
}

// gun mount positions of a model for the config: [{ x, y, aft, style, caliber, guns }] (x in metres
// along the hull for a ship of length L, y = 0: every mount is on the centreline)
export function modernGunSlots(model, L) {
   const def = MODELS[model]; if (!def) return [];
   const list = def.gunSlots || [];
   const s = (Number(L) > 0 ? Number(L) : def.L) / def.L;
   return list.map(g => { const st = GUN_STYLES[g.style] || GUN_STYLES.mk45; return { x: g.x * s, y: 0, aft: g.aft ?? g.x < 0, style: g.style, caliber: st.cal, guns: st.guns || 1 }; });
}

export { prism, housePoly, subHull, quad, tri };
