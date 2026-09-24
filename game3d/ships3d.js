// game3d/ships3d.js — procedural warship models + their animation.
// Every ship is ONE merged, vertex-coloured hull/superstructure mesh plus one mesh per turret
// house and one per barrel set (so turrets really train with `bearing` and guns elevate with
// `elev`). The hull is lofted: superellipse bilge amidships that fines into a raked,
// flared bow, sheer line, transom stern; the waterline stripes (antifouling red / black
// boot-top) and teak planking are drawn per pixel so they stay crisp at any distance.
// Silhouettes are driven by cfg.hull.type (DD/CL/CA/BB/CV/TR). Ships ride the same Gerstner
// swell the ocean draws (heave/pitch/roll), heel in turns, list and go down when sunk, and
// fade out when the enemy is no longer spotted.
import * as THREE from '../vendor/three/three.module.min.js';
import { patchAtmosphere, GeoBuilder, clamp, lerp, smoothstep, lin, shade, mulberry32 } from './gfxcommon3d.js';

const LEGACY_DIMS = {
   DD: { L: 118, beam: 11.5, type: 'DD' }, LC: { L: 175, beam: 17.5, type: 'CL' },
   HC: { L: 205, beam: 21, type: 'CA' }, EB: { L: 230, beam: 32, type: 'BB' },
   Bismarck: { L: 251, beam: 36, type: 'BB' },
};
const TYPE_ALIAS = { BB: 'BB', CA: 'CA', CL: 'CL', DD: 'DD', CV: 'CV', TR: 'TR', AP: 'TR', CC: 'CA', BC: 'BB' };

export function shipDims(ship) {
   const h = ship.cfg?.hull || {};
   const leg = LEGACY_DIMS[ship.cls] || {};
   let type = TYPE_ALIAS[h.type] || leg.type;
   let L = Number(h.L) || leg.L || 180;
   if (!type) type = L > 220 ? 'BB' : L > 180 ? 'CA' : L > 140 ? 'CL' : 'DD';
   const B = Number(h.beam) || leg.beam || L * 0.12;
   const T = clamp(Number(h.draft) || L * 0.034, 2.5, 11);
   // cfg.hull.deckH is the sim's hit-box deck height; the visible freeboard is lower (WoWs
   // hulls sit ~0.55-0.6 of that), otherwise battleships look like barges
   const dh = Number(h.deckH);
   const D = dh > 0 ? clamp(dh * 0.58, L * 0.028, L * 0.055) : clamp(type === 'TR' ? L * 0.045 : L * 0.034, 3, L * 0.06);
   return { L, B, T, D, type };
}

function hullTint(ship) {
   const hc = ship.cfg?.hull?.color;
   if (hc !== undefined && hc !== null && hc !== '') { try { return lin(hc); } catch (e) { /* fall through */ } }
   if (ship.isPlayer || ship === ship.world?.player) return lin(0x5c6670);
   return ship.side === 'enemy' ? lin(0x4e5256) : lin(0x68717a);
}

// ---------------- hull loft ----------------
const HULL_PARAMS = {
   BB: { pb: 2.0, tr: 0.46, sheer: 0.38, flare: 1.10, rake: 0.030, nMid: 7, tumble: 0.97 },
   CA: { pb: 2.3, tr: 0.36, sheer: 0.55, flare: 1.14, rake: 0.036, nMid: 5, tumble: 1.0 },
   CL: { pb: 2.3, tr: 0.36, sheer: 0.55, flare: 1.14, rake: 0.036, nMid: 5, tumble: 1.0 },
   DD: { pb: 2.5, tr: 0.55, sheer: 0.55, flare: 1.18, rake: 0.030, nMid: 4, tumble: 1.0, fc: true },
   CV: { pb: 2.2, tr: 0.55, sheer: 0.30, flare: 1.15, rake: 0.030, nMid: 5, tumble: 1.0 },
   TR: { pb: 1.5, tr: 0.72, sheer: 0.25, flare: 1.03, rake: 0.018, nMid: 9, tumble: 1.0 },
};

function makeHullShape(d) {
   const P = HULL_PARAMS[d.type] || HULL_PARAMS.CA;
   const { L, B, T, D } = d;
   const hb = B / 2;
   const wl = (u) => u >= 0 ? Math.pow(Math.max(0, 1 - Math.pow(u, P.pb)), 0.62)
      : P.tr + (1 - P.tr) * Math.sqrt(Math.max(0, 1 - Math.pow(-u, 3.2)));
   const wd = (u) => u >= 0 ? Math.min(1, P.flare * Math.pow(Math.max(0, 1 - Math.pow(u, P.pb * 0.85)), 0.5))
      : Math.min(1, (P.tr + 0.08) + (0.92 - P.tr) * Math.sqrt(Math.max(0, 1 - Math.pow(-u, 3.6))));
   const deckY = (u) => {
      let y = D + (u > 0 ? D * P.sheer * u * u : D * 0.08 * u * u);
      if (P.fc) y += D * 0.38 * smoothstep(0.2, 0.28, u);   // raised forecastle
      return y;
   };
   const keel = (u) => -T * (u > 0 ? 1 - 0.92 * smoothstep(0.84, 1.0, u) : 1 - 0.8 * smoothstep(0.72, 1.0, -u));
   const rake = (u, t) => (u > 0 ? P.rake * L * smoothstep(0.7, 1.0, u) * t * t : -0.012 * L * smoothstep(0.9, 1.0, -u) * t);
   return {
      P, hb, wl, wd, deckY, keel, rake,
      halfDeckAt(x) { const u = clamp(x / (L / 2), -1, 1); return hb * wd(u) * P.tumble; },
      deckAt(x) { return deckY(clamp(x / (L / 2), -1, 1)); },
   };
}

function loftHull(b, d, S, hullCol, deckCol) {
   const { L } = d;
   const NS = 64, NB = 9, NT = 5;
   const NR = NB + NT + 1;
   const stations = [];
   for (let i = 0; i < NS; i++) {
      const s = -1 + 2 * i / (NS - 1);
      stations.push(Math.sin(s * Math.PI / 2) * 0.35 + s * 0.65);
   }
   const ring = (u) => {
      const w = S.hb * S.wl(u), wdk = S.hb * S.wd(u) * S.P.tumble;
      const k = S.keel(u), dy = S.deckY(u);
      const mid = 1 - Math.pow(Math.abs(u), 2.2);
      const n = lerp(2.2, S.P.nMid, mid);
      const pts = [];
      for (let j = 0; j <= NB; j++) {
         const phi = (j / NB) * Math.PI / 2;
         const cz = Math.pow(Math.sin(phi), 2 / n), cy = Math.pow(Math.cos(phi), 2 / n);
         pts.push([w * cz, k * cy]);
      }
      for (let j = 1; j <= NT; j++) {
         const t = j / NT;
         pts.push([lerp(w, wdk, Math.pow(t, 1.3)), t * dy]);
      }
      return pts.map(([z, y]) => {
         const t = clamp((y - k) / (dy - k), 0, 1);
         return [u * L / 2 + S.rake(u, t), y, z];
      });
   };
   const rings = stations.map(ring);
   for (const side of [1, -1]) {
      const pos = [], idx = [];
      for (let i = 0; i < NS; i++) for (let j = 0; j < NR; j++) { const p = rings[i][j]; pos.push(p[0], p[1], p[2] * side); }
      for (let i = 0; i < NS - 1; i++) {
         for (let j = 0; j < NR - 1; j++) {
            const a = i * NR + j, bb = (i + 1) * NR + j, c = a + 1, dd = bb + 1;
            if (side > 0) idx.push(a, bb, c, bb, dd, c); else idx.push(a, c, bb, bb, c, dd);
         }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      b.band = 1;
      b.raw(pos, g.attributes.normal.array, idx, hullCol);
      g.dispose();
   }
   // transom
   {
      const r = rings[0];
      const arr = [];
      for (let j = 0; j < NR - 1; j++) {
         const p0 = r[j], p1 = r[j + 1];
         arr.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p1[0], p1[1], -p1[2]);
         arr.push(p0[0], p0[1], p0[2], p1[0], p1[1], -p1[2], p0[0], p0[1], -p0[2]);
      }
      b.band = 1;
      b.tris(arr, hullCol);
   }
   // deck with camber; plank shading happens in the shader (band 2)
   {
      const pos = [], nrm = [], idx = [];
      const NW = 6;
      for (let i = 0; i < NS; i++) {
         const r = rings[i][NR - 1];
         for (let k = 0; k <= NW; k++) {
            const t = k / NW * 2 - 1;
            pos.push(r[0], r[1] + (1 - t * t) * d.B * 0.012 - 0.05, r[2] * t);
            nrm.push(0, 1, 0);
         }
      }
      for (let i = 0; i < NS - 1; i++) for (let k = 0; k < NW; k++) {
         const a = i * (NW + 1) + k, bb = a + NW + 1;
         idx.push(a, a + 1, bb, bb, a + 1, bb + 1);
      }
      b.band = 2;
      b.raw(pos, nrm, idx, deckCol);
   }
   // bulwark lip along the deck edge (reads as a crisp sheer line from afar)
   {
      const arr = [];
      const hgt = Math.max(0.5, d.D * 0.08);
      for (let i = 0; i < NS - 1; i++) {
         const p = rings[i][NR - 1], q = rings[i + 1][NR - 1];
         for (const s of [1, -1]) {
            const a = [p[0], p[1], p[2] * s], c = [q[0], q[1], q[2] * s];
            const a2 = [p[0], p[1] + hgt, p[2] * s], c2 = [q[0], q[1] + hgt, q[2] * s];
            if (s > 0) arr.push(...a, ...c, ...a2, ...c, ...c2, ...a2);
            else arr.push(...a, ...a2, ...c, ...c, ...a2, ...c2);
         }
      }
      b.band = 0;
      b.tris(arr, shade(hullCol, 0.92));
   }
   b.band = 0;
}

// ---------------- turret models ----------------
function turretSize(caliber, B) { return Math.min(B * 0.185, 1.4 + caliber * 0.0135); }

function buildTurretHouse(r, caliber, guns, col, big) {
   const b = new GeoBuilder();
   const h = Math.max(1.6, r * 0.55);
   const shape = new THREE.Shape();
   shape.moveTo(r * 1.0, -r * 0.6);
   shape.lineTo(r * 1.0, r * 0.6);
   shape.lineTo(r * 0.25, r * 0.86);
   shape.lineTo(-r * 0.7, r * 0.84);
   shape.quadraticCurveTo(-r * 1.08, r * 0.8, -r * 1.08, 0);
   shape.quadraticCurveTo(-r * 1.08, -r * 0.8, -r * 0.7, -r * 0.84);
   shape.lineTo(r * 0.25, -r * 0.86);
   shape.closePath();
   const ex = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: true, bevelThickness: h * 0.12, bevelSize: r * 0.06, bevelSegments: 1, curveSegments: 5 });
   ex.rotateX(-Math.PI / 2);   // extrusion now runs +Y
   b.put(ex, 0, 0, 0, (x, y) => shade(col, y > h * 0.95 ? 1.08 : 0.97));
   // barbette ring
   b.cyl(r * 0.92, r * 0.95, 1.2, 0, -1.1, 0, shade(col, 0.8), 16);
   // sighting hoods and rangefinder "ears" on heavy turrets
   b.box(r * 0.3, 0.5, r * 0.25, r * 0.55, h + 0.2, r * 0.55, shade(col, 0.85));
   b.box(r * 0.3, 0.5, r * 0.25, r * 0.55, h + 0.2, -r * 0.55, shade(col, 0.85));
   if (big) {
      const rl = r * 2.1;
      const g = new THREE.CylinderGeometry(0.42, 0.42, rl, 8); g.rotateX(Math.PI / 2);
      b.put(g, -r * 0.55, h + 0.55, 0, shade(col, 0.7));
      b.cyl(0.8, 0.8, 0.6, -r * 0.55, h, r * 0.95, shade(col, 0.7), 8);
      b.cyl(0.8, 0.8, 0.6, -r * 0.55, h, -r * 0.95, shade(col, 0.7), 8);
   }
   return { geo: b.build(), h };
}

function gunOffsets(guns, r) {
   if (guns <= 1) return [0];
   if (guns === 2) return [-0.3 * r, 0.3 * r];
   if (guns === 3) return [-0.5 * r, 0, 0.5 * r];
   return [-0.6 * r, -0.2 * r, 0.2 * r, 0.6 * r];
}

function buildBarrels(r, caliber, guns, col) {
   const b = new GeoBuilder();
   const cal = caliber / 1000;
   const len = clamp(cal * 50, 3.5, 23);
   const rb = Math.max(0.16, cal * 0.95), rm = Math.max(0.11, cal * 0.55);
   const offs = gunOffsets(guns, r);
   const dark = shade(col, 0.55);
   // mantlet
   b.box(r * 0.28, r * 0.5, r * 1.25 * Math.min(1, 0.45 + guns * 0.22), r * 0.08, 0, 0, shade(col, 0.8));
   for (const z of offs) {
      b.tubeX(rb * 1.25, rb, len * 0.22, r * 0.18, 0, z, shade(col, 0.75), 10);   // blast bag / breech sleeve
      b.tubeX(rb, rm, len * 0.8, r * 0.18 + len * 0.2, 0, z, dark, 10);
      b.tubeX(rm * 1.25, rm * 1.25, len * 0.04, r * 0.18 + len * 0.97, 0, z, dark, 10);   // muzzle swell
   }
   return { geo: b.build(), len, offs, tip: r * 0.18 + len * 1.01 };
}

// ---------------- superstructure ----------------
// Layout follows cfg.hull.sup {x, len, w, h} (the sim's hit box, h = height above the deck)
// and cfg.hull.funnels [{x, r, h}]; cfg.hull.nation picks the style. German ('de'): rounded
// bridge levels ahead of a tower mast with a foretop director, capped funnels ringed by
// searchlight platforms, heavy cranes, catapult + seaplane, shielded twin AA and AA director
// domes. British ('uk'): square block bridges, tripod masts, upright black-topped funnels,
// pom-poms. Without that data (legacy sim) the layout is derived from the turret positions.
const SUP_LEN = { BB: 0.3, CA: 0.26, CL: 0.24, DD: 0.16, CV: 0.2, TR: 0.18 };
const SUP_H = { BB: 24, CA: 18, CL: 16, DD: 10, CV: 14, TR: 13 };
const FUN_DEF = {   // fallback funnels: [distance aft of the sup front / sup length, r / B, h]
   BB: [[0.62, 0.18, 16]], CA: [[0.5, 0.16, 13], [0.72, 0.16, 13]], CL: [[0.45, 0.2, 11], [0.7, 0.2, 11]],
   DD: [[1.25, 0.23, 8], [2.0, 0.23, 8]], TR: [[0.5, 0.18, 10]],
};
const _up = new THREE.Vector3(0, 1, 0), _dir = new THREE.Vector3(), _qd = new THREE.Quaternion();

// plan-view outline (x fore-aft, y = athwartships) with rounded front/back corners
function planShape(x0, x1, hw, rf = 0, ra = 0) {
   const s = new THREE.Shape();
   const lim = (x1 - x0) * 0.49;
   const cf = Math.min(hw * Math.min(rf, 0.95), lim), ca = Math.min(hw * Math.min(ra, 0.95), lim);
   s.moveTo(x0 + ca, -hw);
   s.lineTo(x1 - cf, -hw);
   if (cf > 0.01) s.quadraticCurveTo(x1, -hw, x1, -hw + cf);
   s.lineTo(x1, hw - cf);
   if (cf > 0.01) s.quadraticCurveTo(x1, hw, x1 - cf, hw);
   s.lineTo(x0 + ca, hw);
   if (ca > 0.01) { s.quadraticCurveTo(x0, hw, x0, hw - ca); s.lineTo(x0, -hw + ca); s.quadraticCurveTo(x0, -hw, x0 + ca, -hw); }
   return s;
}

function superstructure(b, d, S, tl, col, ship) {
   const { L, B, type } = d;
   const hull = ship.cfg?.hull || {};
   const nat = hull.nation === 'uk' ? 'uk' : 'de';
   const lv = 2.6;            // one deck level (m)
   const { sup, dark, mast, win, plat } = col;
   const hw = (x) => S.halfDeckAt(x);
   const yD = (x) => S.deckAt(x);
   const smoke = [];
   // (dx, dz) turned by a (0 = ahead, +PI/2 = starboard) around (x, z); matches put(..., ry = -a)
   const rot = (x, z, a, dx, dz) => [x + dx * Math.cos(a) - dz * Math.sin(a), z + dx * Math.sin(a) + dz * Math.cos(a)];

   // ---- primitives ----
   const prism = (shape, y0, h, c, band = 0) => {
      const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 3 });
      g.rotateX(-Math.PI / 2);   // plan (x, y) -> (x, -z), extrusion -> +y
      b.band = band; b.put(g, 0, y0, 0, c); b.band = 0;
   };
   const house = (x0, x1, y0, h, w, rf = 0, ra = 0, c = sup) => prism(planShape(x0, x1, w, rf, ra), y0, h, c, 3);
   // overhanging deck edge: the dark lip between levels is what makes a bridge read as stacked
   const slab = (x0, x1, y, w, rf = 0, ra = 0, t = 0.32) => prism(planShape(x0, x1, w, rf, ra), y - t, t, plat);
   const winBand = (x0, x1, y, w, rf) => prism(planShape(lerp(x0, x1, 0.4), x1, w + 0.05, rf, 0), y, 0.8, win);
   const strut = (ax, ay, az, bx, by, bz, r, c = mast) => {
      _dir.set(bx - ax, by - ay, bz - az);
      const l = _dir.length();
      const g = new THREE.CylinderGeometry(r * 0.8, r, l, 6);
      g.translate(0, l / 2, 0);
      g.applyQuaternion(_qd.setFromUnitVectors(_up, _dir.normalize()));
      b.put(g, ax, ay, az, c);
   };
   const pole = (x, y0, h, r0, z = 0) => b.cyl(r0 * 0.45, r0, h, x, y0, z, mast, 6);
   const yard = (x, y, span, r = 0.13) => b.put(new THREE.CylinderGeometry(r, r, span, 5).rotateX(Math.PI / 2), x, y, 0, mast);
   const tripod = (x, y0, h, spread) => {
      strut(x, y0, 0, x, y0 + h, 0, 0.55);
      for (const s of [1, -1]) strut(x - spread, y0, s * spread * 0.7, x, y0 + h * 0.92, 0, 0.42);
   };
   const rfArms = (x, y, rl, r = 0.4) => {
      b.put(new THREE.CylinderGeometry(r, r, rl, 8).rotateX(Math.PI / 2), x, y, 0, dark);
      for (const s of [1, -1]) b.box(r * 2.4, r * 2.4, 0.6, x, y, s * rl / 2, sup);
   };
   // rotating director / control tower with rangefinder arms; returns its top
   const director = (x, y, r, rl) => {
      b.cyl(r * 0.85, r, r * 0.8, x, y, 0, shade(sup, 0.94), 12);
      const g = new THREE.CylinderGeometry(r * 0.95, r * 1.05, r * 1.2, 12); g.translate(0, r * 0.6, 0);
      b.band = 3; b.put(g, x, y + r * 0.8, 0, sup, 0, 0, 0, 1.25, 1, 1); b.band = 0;
      rfArms(x - r * 0.15, y + r * 1.55, rl, clamp(r * 0.2, 0.25, 0.45));
      return y + r * 2.0;
   };
   const searchlight = (x, y, z, s = 1) => {
      b.cyl(0.35 * s, 0.45 * s, 0.7 * s, x, y, z, dark, 6);
      b.tubeX(0.6 * s, 0.6 * s, 1.1 * s, x - 0.55 * s, y + 1.0 * s, z, sup, 10);
      b.tubeX(0.52 * s, 0.52 * s, 0.06, x + 0.56 * s, y + 1.0 * s, z, col.lamp, 10);
   };
   const boat = (x, y, z, l, cabin) => {
      const g = new THREE.SphereGeometry(1, 10, 4, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);   // lower half-shell
      b.put(g, x, y + l * 0.16, z, col.boat, 0, 0, 0, l / 2, l * 0.1, l * 0.13);
      b.box(l * 0.84, 0.12, l * 0.22, x, y + l * 0.16, z, shade(col.boat, 0.78));
      if (cabin) b.box(l * 0.3, l * 0.08, l * 0.17, x + l * 0.06, y + l * 0.2, z, col.boat);
      for (const o of [-0.28, 0.28]) b.box(0.35, l * 0.08, l * 0.2, x + o * l, y + l * 0.04, z, dark);
   };
   // fixed secondary turret training toward a (0 = ahead, +PI/2 = starboard)
   const secTurret = (x, y, z, r, a, guns = 2) => {
      const g = new THREE.CylinderGeometry(r * 0.88, r, r * 0.72, 10); g.translate(0, r * 0.36, 0);
      b.put(g, x, y, z, shade(sup, 0.97), 0, -a, 0, 1.3, 1, 1);
      for (const o of (guns === 1 ? [0] : [-0.3, 0.3])) {
         const bg = new THREE.CylinderGeometry(0.11 * r, 0.15 * r, r * 2.5, 6).rotateZ(-Math.PI / 2 + 0.08).translate(r * 2.4, 0, o * r);
         b.put(bg, x, y + r * 0.42, z, dark, 0, -a, 0);
      }
   };
   const aaTwin = (x, y, z, r, a) => {   // shielded twin HA mount, barrels raised
      b.cyl(r * 0.8, r * 0.9, 0.5, x, y, z, dark, 8);
      b.put(new THREE.SphereGeometry(r, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2), x, y + 0.45, z, shade(sup, 0.98), 0, -a, 0, 1.2, 0.85, 1);
      for (const o of [-0.32, 0.32]) {
         const bg = new THREE.CylinderGeometry(0.07 * r, 0.1 * r, r * 2.4, 5).translate(0, r * 1.2, 0).rotateZ(-Math.PI / 2 + 0.6).translate(r * 0.4, 0, o * r);
         b.put(bg, x, y + r * 0.7, z, dark, 0, -a, 0);
      }
   };
   const aaDome = (x, y, z) => {   // stabilised AA director ("Wackeltopp")
      b.cyl(0.5, 0.7, 1.4, x, y, z, sup, 8);
      b.put(new THREE.SphereGeometry(1.45, 12, 8), x, y + 2.3, z, sup);
   };
   const pompom = (x, y, z, a) => {
      b.box(2.2, 1.2, 2.4, x, y + 0.6, z, shade(sup, 0.95), -a);
      for (let row = 0; row < 2; row++) for (let i = 0; i < 4; i++) {
         const [px, pz] = rot(x, z, a, 1.1, (i - 1.5) * 0.48);
         b.put(new THREE.CylinderGeometry(0.06, 0.08, 1.7, 4).rotateZ(-Math.PI / 2 + 0.35).translate(0.8, 0, 0), px, y + 1.0 + row * 0.34, pz, dark, 0, -a, 0);
      }
   };
   const tubes = (x, z, n, a) => {   // trainable torpedo tube bank
      const y = yD(x);
      b.cyl(0.9 + n * 0.12, 1.0 + n * 0.12, 0.55, x, y, z, sup, 10);
      for (let k = 0; k < n; k++) {
         const [px, pz] = rot(x, z, a, 0.4, (k - (n - 1) / 2) * 0.7);
         b.put(new THREE.CylinderGeometry(0.3, 0.3, 7.2, 8).rotateZ(-Math.PI / 2), px, y + 1.0, pz, dark, 0, -a, 0);
      }
      const [sx, sz] = rot(x, z, a, -2.6, 0);
      b.box(1.6, 1.3, n * 0.72 + 0.4, sx, y + 1.0, sz, sup, -a);
   };
   const funnel = (f, style) => {
      const fx = f.x, fy = yD(fx), h = f.h;
      // sim radii are hit-box sized; small-ship funnels read oversized at full r
      const small = type === 'DD' || type === 'TR';
      const rx = f.r * (small ? 0.78 : 1), rz = rx * (style === 'uk' ? 0.72 : 0.64);
      const rake = type === 'DD' || type === 'TR' ? 0.09 : style === 'uk' ? 0.03 : 0;
      // body + black top band as separate rings (one height segment would smear the band
      // colour down the whole funnel)
      const hb = h * (style === 'uk' ? 0.86 : 0.95);
      const g = new THREE.CylinderGeometry(1.004, 1.04, hb, 20); g.translate(0, hb / 2, 0); g.scale(rx, 1, rz);
      b.put(g, fx, fy, 0, sup, 0, 0, rake);
      const gt = new THREE.CylinderGeometry(1, 1.004, h - hb, 20); gt.translate(0, hb + (h - hb) / 2, 0); gt.scale(rx, 1, rz);
      b.put(gt, fx, fy, 0, col.cap, 0, 0, rake);
      const tx = fx - Math.sin(rake) * h, ty = fy + Math.cos(rake) * h;
      if (style === 'de') {
         const cap = new THREE.CylinderGeometry(1.1, 1.0, 1.4, 20); cap.translate(0, 0.7, 0); cap.scale(rx, 1, rz);
         b.put(cap, tx, ty - 0.5, 0, col.capMetal, 0, 0, rake);
         if (type !== 'DD' && type !== 'TR') {   // searchlight platform ring
            const yp = fy + h * 0.58;
            slab(fx - rx * 1.5, fx + rx * 1.5, yp, rz * 1.85, 0.9, 0.9);
            for (const s of [1, -1]) { searchlight(fx + rx * 0.3, yp, s * rz * 1.42); searchlight(fx - rx * 1.0, yp, s * rz * 1.2); }
         }
      } else {
         const rim = new THREE.CylinderGeometry(1.06, 1.06, 0.6, 20); rim.scale(rx, 1, rz);
         b.put(rim, tx, ty, 0, col.cap, 0, 0, rake);
         for (const s of [1, -1]) b.cyl(0.16, 0.16, h * 1.03, fx - rx * 0.98, fy, s * rz * 0.35, mast, 5, rake);
      }
      smoke.push(new THREE.Vector3(tx, ty + 1, 0));
   };
   const seaplane = (x, y, z, a) => {
      const P = (g, dx, dy, dz, c = col.plane) => { const [px, pz] = rot(x, z, a, dx, dz); b.put(g, px, y + dy, pz, c, 0, -a, 0); };
      P(new THREE.CylinderGeometry(0.22, 0.58, 10.5, 8).rotateZ(Math.PI / 2), 0, 1.5, 0);   // fuselage, tail aft
      P(new THREE.BoxGeometry(1.9, 0.16, 12.4), 0.9, 1.85, 0);
      P(new THREE.BoxGeometry(1.1, 0.1, 4.2), -4.7, 1.65, 0);
      P(new THREE.BoxGeometry(1.4, 1.5, 0.1), -4.8, 2.3, 0);
      P(new THREE.CylinderGeometry(0.62, 0.62, 0.18, 10).rotateZ(Math.PI / 2), 5.3, 1.5, 0, dark);
      for (const s of [1, -1]) {
         P(new THREE.CylinderGeometry(0.26, 0.4, 6.6, 6).rotateZ(Math.PI / 2), 0.9, 0.25, s * 1.7);
         P(new THREE.BoxGeometry(0.14, 1.35, 0.14), 1.1, 0.95, s * 1.7, dark);
      }
   };
   const catapult = (x, y, l, a, withPlane) => {
      b.cyl(1.0, 1.2, 0.9, x, y, 0, dark, 10);
      b.put(new THREE.BoxGeometry(l, 0.55, 1.2), x, y + 1.2, 0, mast, 0, -a, 0);
      b.put(new THREE.BoxGeometry(l * 0.92, 0.35, 0.6), x, y + 0.85, 0, dark, 0, -a, 0);
      if (withPlane) seaplane(x, y + 1.5, 0, a);
   };
   const crane = (x, y0, z, h, jib, dir) => {
      b.cyl(0.55, 0.8, h, x, y0, z, mast, 8);
      b.box(2.0, 1.6, 1.8, x, y0 + h - 0.4, z, sup);
      strut(x, y0 + h * 0.55, z, x + dir * jib * 0.94, y0 + h * 0.55 + jib * 0.34, z, 0.32);
   };
   const breakwater = (x) => {
      const w = hw(x) * 0.78, dx = w * 0.6, l = Math.hypot(dx, w);
      for (const s of [1, -1]) b.box(0.3, 1.4, l, x - dx / 2, yD(x) + 0.55, s * w / 2, sup, -s * Math.atan2(dx, w));
   };
   const bowFittings = () => {
      const xa = L * 0.4;
      for (const s of [1, -1]) {
         b.cyl(0.55, 0.65, 0.7, xa - L * 0.02, yD(xa - L * 0.02), s * B * 0.1, dark, 8);      // capstans
         b.box(L * 0.05, 0.08, 0.35, xa + L * 0.012, yD(xa) + 0.05, s * B * 0.11, dark, s * 0.25);   // cable runs
         const xh = L * 0.445;
         b.box(Math.max(1, B * 0.045), Math.max(1.3, B * 0.06), 0.35, xh, yD(xh) - Math.max(1.4, d.D * 0.2), s * (hw(xh) + 0.08), dark);   // anchors
      }
   };

   // ---- towers ----
   // German: armoured conning tower, rounded bridge levels, tower mast with foretop director
   const deTower = (xf, yb, top, w, n, lenT, heavy) => {
      const ctR = clamp(w * 0.3, 1.0, 3.3);
      const xc = xf - ctR * 1.25;
      b.put(new THREE.CylinderGeometry(ctR, ctR * 1.03, lv * 1.8, 14).translate(0, lv * 0.9, 0), xc, yb, 0, shade(sup, 0.88), 0, 0, 0, 1.25, 1, 1);
      b.cyl(ctR * 0.4, ctR * 0.45, 0.9, xc - ctR * 0.3, yb + lv * 1.8, 0, shade(sup, 0.9), 8);
      rfArms(xc - ctR * 0.3, yb + lv * 1.8 + 0.5, ctR * 2.6, 0.3);
      const xb = xc - ctR * 1.3, xr0 = xb - lenT;
      let y = yb, xrTop = xr0, xfTop = xb;
      for (let i = 0; i < n; i++) {
         const xr = xr0 + i * lenT * 0.07, xfr = xb - i * 0.8, wi = w * (1 - i * 0.1);
         house(xr, xfr, y, lv, wi, 0.95, 0.35);
         if (i === 1 || i === n - 1) winBand(xr, xfr, y + lv * 0.42, wi, 0.95);
         slab(xr - 0.3, xfr + 0.5, y + lv + 0.02, wi + 0.45, 0.95, 0.35);
         if (i === Math.min(2, n - 1)) slab(xfr - 3.2, xfr - 0.4, y + lv + 0.02, Math.min(w * 1.55, hw(xfr) * 0.96));   // bridge wings
         y += lv; xrTop = xr; xfTop = xfr;
      }
      const dR = clamp(w * 0.28, 0.9, 2.5), rT = clamp(w * 0.25, 0.8, 2.5);
      const xd = xfTop - dR * 1.4;
      director(xd, y, dR, w * 1.25);
      const xt = Math.max(xrTop + rT * 1.3, xd - dR * 1.3 - rT * 1.25);
      const yT = Math.max(y + lv * 1.5, top - rT * 2.4);
      b.put(new THREE.CylinderGeometry(rT, rT * 1.1, yT - y, 12).translate(0, (yT - y) / 2, 0), xt, y, 0, sup, 0, 0, 0, 1.2, 1, 1);
      const yp = lerp(y, yT, 0.45);
      slab(xt - rT * 2.3, xt + rT * 2.3, yp, rT * 2.3, 0.9, 0.9);
      for (const s of [1, -1]) searchlight(xt, yp, s * rT * 1.7, 0.8);
      const ft = director(xt, yT, rT * 1.25, w * 1.35);
      if (heavy) b.box(0.3, rT * 1.1, rT * 2.2, xt + rT * 1.6, yT + rT * 1.9, 0, dark);   // radar mattress
      const mh = (top - yb) * 0.42;
      pole(xt - rT * 0.4, ft, mh, 0.42);
      yard(xt - rT * 0.4, ft + mh * 0.55, w * 2.4);
      yard(xt - rT * 0.4, ft + mh * 0.8, w * 1.3, 0.1);
      return { xr: xr0, top: ft + mh };
   };
   // British: tall square block bridge, DCT on the compass platform, tripod foremast abaft
   const ukTower = (xf, yb, top, w, n, lenT) => {
      let y = yb, xfTop = xf;
      const xr0 = xf - lenT;
      for (let i = 0; i < n; i++) {
         const xr = xr0 + i * lenT * 0.05, xfr = xf - i * 0.6, wi = w * (1 - i * 0.06);
         house(xr, xfr, y, lv * 1.05, wi, 0.3, 0.1);
         slab(xr - 0.3, xfr + 0.4, y + lv * 1.05 + 0.02, wi + 0.4, 0.3, 0.1);
         if (i === n - 1) winBand(xr, xfr, y + lv * 0.5, wi, 0.3);
         if (i === n - 2) slab(xfr - 3, xfr - 0.3, y + lv * 1.05 + 0.02, Math.min(w * 1.5, hw(xfr) * 0.96));
         y += lv * 1.05; xfTop = xfr;
      }
      const dR = clamp(w * 0.3, 0.9, 2.5);
      const dTop = director(xfTop - dR * 1.5, y, dR, w * 1.3);
      const xm = xr0 - 1.2, ym = Math.max(dTop + 2, top);
      tripod(xm, yb, ym - yb, Math.max(3, (ym - yb) * 0.2));
      house(xm - 2.4, xm + 2.4, ym, 2.4, 2.1, 0.6, 0.6);   // spotting top
      slab(xm - 2.9, xm + 2.9, ym + 0.05, 2.6, 0.6, 0.6);
      const ft = director(xm, ym + 2.4, 1.2, w * 0.9);
      const mh = (top - yb) * 0.4;
      pole(xm, ft, mh, 0.38);
      yard(xm, ft + mh * 0.6, w * 2.2);
      return { xr: xr0 - 3.5, top: ft + mh };
   };

   // ---- layout ----
   const fwd = tl.filter(t => t.x > 0).sort((a, c) => a.x - c.x);
   const aft = tl.filter(t => t.x <= 0).sort((a, c) => c.x - a.x);
   const limF = fwd.length ? fwd[0].x - fwd[0].r * 1.3 : L * 0.3;
   const limA = aft.length ? aft[0].x + aft[0].r * 1.3 : -L * 0.4;
   const hs = hull.sup && Number.isFinite(hull.sup.len) ? hull.sup : null;
   let x0, x1, W, H;
   if (hs) { x0 = (hs.x || 0) - hs.len / 2; x1 = (hs.x || 0) + hs.len / 2; W = hs.w || B * 0.55; H = hs.h || SUP_H[type] || 16; }
   else {
      const len = L * (SUP_LEN[type] || 0.25);
      if (type === 'DD') { x1 = limF - L * 0.03; x0 = x1 - len; }
      else if (type === 'TR') { x1 = -L * 0.12; x0 = x1 - len; }
      else { const c = (limF + limA) / 2 + L * 0.02; x0 = c - len / 2; x1 = c + len / 2; }
      W = B * 0.6; H = SUP_H[type] || 16;
   }
   x1 = Math.min(x1, limF); x0 = Math.max(x0, limA);
   if (x1 - x0 < L * 0.08) { const c = (x0 + x1) / 2; x0 = c - L * 0.04; x1 = c + L * 0.04; }
   const capital = type === 'BB' || type === 'CA' || type === 'CL';
   // warships: the deckhouse fills the free deck toward the inner turrets
   const bx1 = capital ? Math.max(x1, Math.min(limF, x1 + L * 0.1)) : Math.min(limF, x1 + L * 0.04);
   const bx0 = capital ? Math.min(x0, Math.max(limA, x0 - L * 0.04)) : x0;
   const blen = bx1 - bx0, xm = (bx0 + bx1) / 2;
   const y0 = yD(xm);
   const hwA = Math.max(1.5, Math.min(W / 2, hw(xm) * (capital ? 0.7 : 0.66)));
   const funnels = (Array.isArray(hull.funnels) && hull.funnels.length ? hull.funnels
      : (FUN_DEF[type] || []).map(([f, r, h]) => ({ x: x1 - f * (x1 - x0), r: r * B, h })))
      .map(f => ({ x: Number(f.x) || 0, r: Math.max(0.8, Number(f.r) || B * 0.15), h: Math.max(3, Number(f.h) || 10) }))
      .sort((a, c) => c.x - a.x);
   const fFront = funnels.length ? funnels[0].x + funnels[0].r + 2.5 : x0 + (x1 - x0) * 0.4;
   const fBack = funnels.length ? funnels[funnels.length - 1].x - funnels[funnels.length - 1].r - 1 : fFront - 4;
   const torpL = Array.isArray(ship.cfg?.torp?.launchers) ? ship.cfg.torp.launchers : null;
   const launchers = () => {
      for (const l of torpL) {
         const x = Number(l.off?.x ?? l.x) || 0, n = clamp(l.tubes || 3, 1, 5);
         if (l.side === 'port' || l.side === 'stbd') { const s = l.side === 'stbd' ? 1 : -1; tubes(x, s * Math.max(0, hw(x) - 3.2), n, s * 1.35); }
         else tubes(x, 0, n, 0.25);
      }
   };

   if (type === 'CV') {
      const yF = S.deckAt(0) + lv * 2.4;
      b.box(L * 0.96, 1.0, B * 1.25, -L * 0.01, yF, 0, shade(col.deck, 0.9));
      b.band = 2;
      b.box(L * 0.95, 0.1, B * 1.2, -L * 0.01, yF + 0.55, 0, col.deck);
      b.band = 0;
      for (let x = -L * 0.4; x < L * 0.4; x += L / 10) b.box(L / 22, lv * 2.4, B * 0.5, x, S.deckAt(x), 0, sup);
      const xi = L * 0.05, zi = B * 0.52;
      b.box(L * 0.18, lv * 3, B * 0.12, xi, yF + 0.5, zi, sup);
      b.box(L * 0.08, lv * 1.3, B * 0.1, xi + L * 0.03, yF + 0.5 + lv * 3, zi, sup);
      const g = new THREE.CylinderGeometry(1, 1, lv * 2.6, 12); g.translate(0, lv * 1.3, 0); g.scale(L * 0.025, 1, B * 0.05);
      b.put(g, xi - L * 0.04, yF + 0.5 + lv * 3, zi, dark);
      smoke.push(new THREE.Vector3(xi - L * 0.04, yF + 0.5 + lv * 5.6, zi));
      pole(xi + L * 0.02, yF + 0.5 + lv * 4.3, lv * 3, 0.3);
   } else if (type === 'TR') {
      // freighter: cream midships/aft house with bridge, cargo hatches, masts with derricks
      const hwT = Math.max(2, Math.min(W / 2, hw((x0 + x1) / 2) * 0.92)), len = x1 - x0;
      const yb = yD((x0 + x1) / 2), cream = col.boat;
      house(x0, x1, yb, lv * 1.3, hwT, 0.25, 0.1, cream);
      slab(x0 - 0.3, x1 + 0.3, yb + lv * 1.3 + 0.02, hwT + 0.3, 0.25, 0.1);
      house(x0 + len * 0.1, x1 - len * 0.06, yb + lv * 1.3, lv, hwT * 0.86, 0.25, 0.1, cream);
      const yBr = yb + lv * 2.3;
      house(x1 - len * 0.4, x1 - len * 0.1, yBr, lv, hwT * 0.7, 0.3, 0, cream);
      winBand(x1 - len * 0.4, x1 - len * 0.1, yBr + lv * 0.45, hwT * 0.7, 0.3);
      slab(x1 - len * 0.3, x1 - len * 0.1, yBr + lv + 0.02, Math.min(hwT * 1.15, hw(x1) * 0.98));
      for (const f of funnels) funnel(f, 'uk');
      for (const s of [1, -1]) boat(x0 + len * 0.3, yb + lv * 1.3, s * hwT * 0.9, 7, false);
      const aftGun = aft.length ? aft[aft.length - 1].x + aft[aft.length - 1].r * 1.6 : -L * 0.44;
      for (const hx of [L * 0.34, L * 0.19, L * 0.04, x0 - L * 0.1, x0 - L * 0.22]) {
         if (hx > x0 - 4 && hx < x1 + 4) continue;
         if (hx < aftGun + L * 0.03) continue;
         b.box(L * 0.08, 1.2, hw(hx) * 1.1, hx, yD(hx) + 0.6, 0, dark);
      }
      for (const mx of [L * 0.27, L * 0.115, x0 - L * 0.16]) {
         if (mx < aftGun) continue;
         pole(mx, yD(mx), lv * 6, 0.45);
         yard(mx, yD(mx) + lv * 4.6, B * 0.6);
         for (const s of [1, -1]) b.put(new THREE.CylinderGeometry(0.15, 0.2, L * 0.1, 5).rotateZ(Math.PI / 2 - 0.5), mx - L * 0.04, yD(mx) + lv * 2, s * 1.2, mast);
      }
   } else if (type === 'DD') {
      const xf = bx1, hwD = Math.max(1.5, Math.min(W / 2, hw(xf) * 0.66));
      const lenB = clamp((x1 - x0) * 0.8, 6, L * 0.14);
      const yb = yD(xf - 3);
      house(xf - lenB, xf, yb, lv * 1.1, hwD, 0.6, 0.2);
      slab(xf - lenB - 0.3, xf + 0.4, yb + lv * 1.1 + 0.02, hwD + 0.35, 0.6, 0.2);
      let y = yb + lv * 1.1;
      if (H >= 10) {   // flag deck under the bridge on fleet destroyers
         house(xf - lenB * 0.8, xf - 0.5, y, lv * 0.9, hwD * 0.92, 0.8, 0.25);
         slab(xf - lenB * 0.82, xf - 0.2, y + lv * 0.9 + 0.02, hwD * 0.92 + 0.3, 0.8, 0.25);
         y += lv * 0.9;
      }
      house(xf - lenB * 0.7, xf - 0.8, y, lv, hwD * 0.86, 0.9, 0.3);
      winBand(xf - lenB * 0.7, xf - 0.8, y + lv * 0.4, hwD * 0.86, 0.9);
      slab(xf - lenB * 0.72, xf - 0.3, y + lv + 0.02, Math.min(hwD * 1.45, hw(xf) * 0.95), 0.6, 0.3);   // open bridge + wings
      y += lv;
      director(xf - lenB * 0.42, y, clamp(hwD * 0.4, 0.8, 1.6), hwD * 1.4);
      const xmF = xf - lenB * 0.85, yM = yb + lv * 1.1, topM = yD(xf) + H * 1.35;
      if (nat === 'uk') tripod(xmF, yM, topM - yM, 2.2); else pole(xmF, yM, topM - yM, 0.4);
      yard(xmF, topM - (topM - yM) * 0.25, hwD * 3);
      for (const f of funnels) funnel(f, nat);
      if (nat === 'de' && funnels.length >= 2) {   // searchlight tower between the funnels
         const xs = (funnels[0].x + funnels[1].x) / 2, ys = yD(xs);
         b.cyl(0.9, 1.1, lv * 1.4, xs, ys, 0, sup, 10);
         slab(xs - 1.8, xs + 1.8, ys + lv * 1.4 + 0.02, 1.8, 0.9, 0.9);
         searchlight(xs, ys + lv * 1.4, 0, 1);
      }
      if (torpL) launchers();
      else for (const tx of [fBack - 5, fBack - 16]) if (tx > limA + 4) tubes(tx, 0, 4, 0.25);
      // aft deckhouse with AA platform and a short mainmast
      const xha = aft.length ? aft[0].x + aft[0].r * 1.2 : -L * 0.28;
      const xh1 = Math.min(xha + L * 0.08, fBack - 1), xh0 = xha;
      if (xh1 - xh0 > 3) {
         const yh = yD((xh0 + xh1) / 2), hwh = Math.min(hwD * 0.9, hw(xh0) * 0.6);
         house(xh0, xh1, yh, lv, hwh, 0.4, 0.4);
         slab(xh0 - 0.3, xh1 + 0.3, yh + lv + 0.02, hwh + 0.3, 0.4, 0.4);
         if (nat === 'uk') pompom((xh0 + xh1) / 2, yh + lv, 0, 0);
         else for (const s of [1, -1]) aaTwin((xh0 + xh1) / 2, yh + lv, s * hwh * 0.55, 0.9, s * 1.2);
         pole(xh1 - 1, yh + lv, H * 0.9, 0.3);
      }
      for (const s of [1, -1]) b.box(4, 0.8, 0.9, -L * 0.46, yD(-L * 0.46) + 0.4, s * hw(-L * 0.46) * 0.6, dark);   // depth charges
   } else {
      // ---- BB / CA / CL ----
      const isBB = type === 'BB';
      const hA = lv * (isBB ? 1.2 : 1.0);
      house(bx0, bx1, y0, hA, hwA, 0.55, 0.35);
      slab(bx0 - 0.3, bx1 + 0.3, y0 + hA + 0.02, hwA + 0.35, 0.55, 0.35);
      const yA = y0 + hA;
      const tw = hwA * 0.8, xf = bx1 - 0.5;
      const lenT = clamp(Math.min(blen * 0.24, xf - fFront - 3), 6, L * 0.12);
      const nLev = clamp(Math.floor(H * 0.5 / lv), 3, 6);
      const top = y0 + H;
      const T = nat === 'uk' ? ukTower(xf, yA, top, tw, nLev, lenT) : deTower(xf, yA, top, tw, nLev, lenT, isBB);
      const acL = Math.max(4, blen * 0.055);
      const xAC = bx0 + Math.max(acL + 1, blen * 0.08);
      const hAC = lv * (isBB ? 2 : 1.5);
      // level B from the tower back to the aft control position
      const hwB = hwA * 0.62, bB0 = xAC + acL - 1, bB1 = T.xr + 1;
      const hasB = bB1 - bB0 > 4;
      if (hasB) {
         house(bB0, bB1, yA, lv, hwB, 0.3, 0.3);
         slab(bB0 - 0.3, bB1 + 0.3, yA + lv + 0.02, hwB + 0.3, 0.3, 0.3);
      }
      const yB = yA + lv;
      for (const f of funnels) funnel(f, nat);
      // aft control position + mainmast
      house(xAC - acL, xAC + acL, yA, hAC, hwA * 0.5, 0.7, 0.7);
      slab(xAC - acL - 0.3, xAC + acL + 0.3, yA + hAC + 0.02, hwA * 0.5 + 0.35, 0.7, 0.7);
      const acTop = director(xAC - acL * 0.2, yA + hAC, clamp(tw * 0.28, 1, 2.4), tw * (isBB ? 1.15 : 0.95));
      const xMM = xAC + acL * 0.65, yMM = yA + hAC;
      const mmTop = Math.max(acTop + 4, y0 + H * (isBB ? 1.12 : 1.0));
      if (nat === 'uk' && isBB) tripod(xMM, yMM, mmTop - yMM, 2.5); else pole(xMM, yMM, mmTop - yMM, 0.45);
      yard(xMM, mmTop - (mmTop - yA) * 0.2, tw * 2);
      // aircraft between the aft funnel and the aft control position
      const room = fBack - (xAC + acL), catX = (fBack + xAC + acL) / 2;
      if (room > 5 && (nat === 'de' || type !== 'BB' || funnels.length >= 2)) {
         const across = isBB || nat === 'uk';
         const cl = across ? Math.min(W * 1.15, hw(catX) * 1.7) : Math.min(room * 0.9, 16);
         catapult(catX, hasB ? yB : yA, cl, across ? Math.PI / 2 : 0.3, room > 12);
      }
      if (nat === 'de' || isBB) {
         const ch = isBB ? lv * 3.2 : lv * 2.4, jib = isBB ? 15 : 10, fm = funnels.length ? funnels[funnels.length - 1] : null;
         for (const s of [1, -1]) crane(fm ? fm.x : catX, yA, s * hwA * 0.86, ch, jib, -1);
      }
      // boats alongside the funnels on the level-B roof
      const bl = clamp(L * 0.04, 6, 10);
      for (const f of funnels) {
         const onB = hasB && f.x > bB0 && f.x < bB1;
         for (const s of [1, -1]) boat(f.x - f.r * 0.2, onB ? yB : yA, s * (f.r * (nat === 'uk' ? 0.72 : 0.64) + bl * 0.13 + 0.25), bl, s > 0);
      }
      // secondaries and AA
      if (isBB) {
         const r = clamp(B * 0.065, 1.4, 2.4);
         [T.xr + lenT * 0.45, (fFront + fBack) / 2, xAC + acL * 1.3].forEach((x, i) => {
            for (const s of [1, -1]) secTurret(x, yD(x), s * Math.min(hwA + r * 1.4, hw(x) - r * 1.2), r, s * [0.9, Math.PI / 2, 2.25][i]);
         });
      }
      const zRoof = (hwA + hwB) / 2;
      if (nat === 'de') {
         if (isBB && hwA - hwB > 2.4) {
            for (const x of [T.xr - 2.5, (T.xr + fFront) / 2, fFront + 1, xAC + acL + 1.8]) {
               for (const s of [1, -1]) aaTwin(x, yA, s * zRoof, 1.5, s * 1.3);
            }
            for (const x of [T.xr - 1.5, (T.xr + fFront) / 2 + 3]) for (const s of [1, -1]) aaDome(x, yB, s * hwB * 0.55);
         } else {
            const r = clamp(B * 0.05, 0.9, 1.4);
            for (const x of [T.xr + 2, (fFront + fBack) / 2, fBack - 3]) {
               for (const s of [1, -1]) aaTwin(x, yD(x), s * Math.min(hwA + r * 1.3, hw(x) - r * 1.1), r, s * 1.4);
            }
            for (const s of [1, -1]) aaDome(T.xr - 1.5, yB, s * hwB * 0.5);
         }
      } else {
         for (const x of [fFront + 1, fBack - 2]) for (const s of [1, -1]) pompom(x, yA, s * Math.min(zRoof + 0.3, hwA - 1.2), s * 0.3);
      }
      if (torpL && !isBB) launchers();
   }

   if (type !== 'CV') {
      if (fwd.length && type !== 'TR') { const t = fwd[fwd.length - 1]; const x = t.x + t.r * 2.1; if (x < L * 0.4) breakwater(x); }
      bowFittings();
   }
   // jackstaff + ensign staff
   b.cyl(0.08, 0.12, 5, L * 0.5 + (HULL_PARAMS[type]?.rake || 0.03) * L * 0.9, S.deckAt(L * 0.49), 0, mast, 4);
   b.cyl(0.08, 0.12, 6, -L * 0.5 + 0.8, S.deckAt(-L * 0.49), 0, mast, 4);
   return { smoke };
}

// ---------------- materials ----------------
const SHIP_FRAG_PARS = /* glsl */`
varying float vBand;
varying vec3 vLocal;
varying vec3 vLN;
uniform vec2 uBoot;
uniform float uDeck;
float sHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;
function makeShipMaterial(deckH) {
   const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.18, envMapIntensity: 0.85, alphaHash: true });
   const uBoot = { value: new THREE.Vector2(-0.9, 0.55) };
   const uDeck = { value: deckH || 8 };
   patchAtmosphere(mat, {
      key: 'ship',
      uniforms: { uBoot, uDeck },
      vertexPars: 'attribute float aBand;\nvarying float vBand;\nvarying vec3 vLocal;\nvarying vec3 vLN;\n',
      vertexMain: 'vBand = aBand; vLocal = position; vLN = normal;',
      fragmentPars: SHIP_FRAG_PARS,
      fragmentReplace: [['#include <color_fragment>', `#include <color_fragment>
         float vert = 1.0 - smoothstep(0.25, 0.6, abs(vLN.y));
         // horizontal coordinate along a vertical face (z on end faces, x on side faces)
         float hc = abs(vLN.x) > abs(vLN.z) ? vLocal.z : vLocal.x;
         if (vBand > 0.5 && vBand < 1.5) {
            float y = vLocal.y;
            float aw = fwidth(y);
            vec3 red = vec3(0.20, 0.035, 0.03), blk = vec3(0.016, 0.016, 0.018);
            vec3 c = mix(red, blk, smoothstep(uBoot.x - aw, uBoot.x + aw, y));
            c = mix(c, diffuseColor.rgb, smoothstep(uBoot.y - aw, uBoot.y + aw, y));
            // weathering: faint vertical rust/salt streaks below scuppers, grime toward the waterline
            float st = sHash(vec2(floor(vLocal.x * 0.7), 3.0));
            c *= 1.0 - 0.1 * step(0.8, st) * smoothstep(0.5, 4.0, y);
            c *= mix(0.84, 1.0, smoothstep(uBoot.y, uBoot.y + uDeck * 0.5, y));
            // plating seams + a porthole row, faded out once they get sub-pixel
            float fx = fwidth(vLocal.x);
            float near = clamp(1.3 - fx * 3.0, 0.0, 1.0);
            float seam = 1.0 - smoothstep(0.04, 0.04 + fx, abs(fract(vLocal.x / 9.0) - 0.5) * 9.0 - 4.4);
            c *= 1.0 - 0.07 * seam * step(uBoot.y, y) * near;
            vec2 pc = vec2(fract(vLocal.x / 3.2) - 0.5, (y - uDeck * 0.62) / 3.2) * 3.2;
            float ph = 1.0 - smoothstep(0.22, 0.22 + max(fx, 0.02) * 1.5, length(pc));
            ph *= near * step(abs(vLocal.x), 70.0) * step(4.0, uDeck);
            c = mix(c, vec3(0.012), ph * 0.85);
            diffuseColor.rgb = c;
         } else if (vBand > 2.5) {
            // deckhouse: deck-level lines, window rows, stains; all fade to their mean when tiny
            float y = vLocal.y;
            float fy = fwidth(y) / 2.7, fh = fwidth(hc) / 1.6;
            float lvl = floor(y / 2.7);
            float ly = fract(y / 2.7);
            float line = 1.0 - smoothstep(0.04, 0.04 + fy * 1.5, ly);
            float wr = step(0.45, sHash(vec2(lvl, sign(vLN.x + vLN.z * 1.7) + 9.0)));
            float wy = smoothstep(0.5, 0.5 + fy, ly) * (1.0 - smoothstep(0.74, 0.74 + fy, ly));
            float wxm = 1.0 - smoothstep(0.26, 0.26 + fh, abs(fract(hc / 1.6) - 0.5));
            float win = wy * wxm * wr;
            float far = clamp(max(fy, fh) * 3.0 - 0.15, 0.0, 1.0);
            float ao = 1.0 - 0.14 * (1.0 - smoothstep(0.0, 0.35, ly));
            float s0 = (1.0 - 0.3 * line - 0.8 * win) * ao;
            diffuseColor.rgb *= mix(1.0, mix(s0, 0.9, far), vert);
            diffuseColor.rgb *= 1.0 - 0.08 * vert * step(0.86, sHash(vec2(floor(hc * 1.3), lvl)));
         } else if (vBand > 1.5) {
            float pz = vLocal.z / 0.42;
            float row = floor(pz);
            float seg = floor(vLocal.x / 7.0 + sHash(vec2(row, 1.0)) * 7.0);
            float tone = 0.86 + 0.24 * sHash(vec2(row, seg));
            float gap = smoothstep(0.0, 0.1, fract(pz)) * smoothstep(1.0, 0.9, fract(pz));
            float fw = fwidth(pz);
            gap = mix(gap, 0.9, clamp(fw * 2.0, 0.0, 1.0));
            diffuseColor.rgb *= tone * (0.62 + 0.38 * gap);
         }`],
         // readability cheat as in WoWs: spotted ships keep a darker silhouette through the haze
         // than the islands and sea around them (overcast/rain made 10+ km targets vanish)
         ['gl_FragColor.rgb = atmApply(gl_FragColor.rgb, vAtmWP);', `{
            vec3 aV = vAtmWP - cameraPosition;
            float aF = atmFogAmount(length(aV), cameraPosition.y, vAtmWP.y);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, atmFogColor(aV), aF * 0.7);
         }`]],
   });
   mat.userData.uBoot = uBoot;
   mat.userData.uDeck = uDeck;
   return mat;
}

// ---------------- the manager ----------------
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();

export class ShipModels {
   constructor(scene, ocean, fx) {
      this.scene = scene;
      this.ocean = ocean;
      this.fx = fx;
      this.recs = new Map();
      this.geoCache = new Map();
      this.group = new THREE.Group();
      scene.add(this.group);
      this.hulls = [];        // for ocean hull damping
      this._hullPool = [];
      this.list = [];         // live records this frame (for fx / wakes)
   }

   _geo(key, fn) {
      let g = this.geoCache.get(key);
      if (!g) { g = fn(); this.geoCache.set(key, g); }
      return g;
   }

   _build(ship) {
      const d = shipDims(ship);
      const tint = hullTint(ship);
      const S = makeHullShape(d);
      const cfgCal = ship.cfg?.main?.caliber || ship.cfg?.guns?.caliber || (d.type === 'BB' ? 380 : d.type === 'CA' ? 203 : d.type === 'CL' ? 152 : 127);
      // turret layout (with legacy remap for the compressed old-sim offsets)
      const turrets = Array.isArray(ship.turrets) ? ship.turrets : [];
      let sx = 1;
      if (turrets.length) {
         const xs = turrets.map(t => t.off?.x || 0);
         const maxAbs = Math.max(...xs.map(Math.abs));
         const spanX = Math.max(...xs) - Math.min(...xs);
         if (maxAbs > 0 && (maxAbs < d.L * 0.25 || (turrets.length > 1 && spanX / d.L < 0.4))) sx = (d.L * 0.36) / maxAbs;
      }
      const tl = turrets.map((t, i) => {
         const cal = t.caliber || cfgCal;
         const r = turretSize(cal, d.B);
         let x = (t.off?.x || 0) * sx;
         let z = (t.off?.y || 0);
         const hwAt = S.halfDeckAt(x);
         z = clamp(z, -Math.max(0, hwAt - r * 1.05), Math.max(0, hwAt - r * 1.05));
         return { i, x, z, r, cal, guns: t.guns || 2 };
      });
      // superfiring: a turret with another one further outboard (toward bow/stern) within reach is raised
      for (const t of tl) {
         const outboard = tl.filter(o => o !== t && Math.sign(o.x) === Math.sign(t.x) && Math.abs(o.x) > Math.abs(t.x) && Math.abs(o.x - t.x) < t.r * 4.5);
         t.y = S.deckAt(t.x) + (outboard.length ? Math.max(2.6, t.r * 0.78) : 0.25);
      }
      const hullKey = `${ship.cls}|${d.type}|${d.L}|${d.B}|${tint.join(',')}|${tl.map(t => t.x.toFixed(1) + ':' + t.r.toFixed(1)).join(',')}`;
      const cols = {
         sup: shade(tint, 1.12), plat: shade(tint, 0.86), dark: lin(0x2a2d31), mast: lin(0x3b3f44), win: lin(0x0b0d10), boat: lin(0xcfccc3),
         cap: lin(0x17181a), capMetal: lin(0x45494e), plane: lin(0x6d7768), lamp: lin(0xe6eadc),
         deck: d.type === 'DD' || d.type === 'TR' ? lin(0x6b665e) : lin(0xa88a64),
      };
      let smoke = [];
      const hullGeo = this._geo(hullKey, () => {
         const b = new GeoBuilder();
         loftHull(b, d, S, tint, cols.deck);
         // barbettes under raised turrets
         for (const t of tl) {
            const base = S.deckAt(t.x);
            if (t.y - base > 1) b.cyl(t.r * 0.9, t.r * 0.95, t.y - base, t.x, base, t.z, shade(tint, 1.02), 16);
         }
         const res = superstructure(b, d, S, tl, cols, ship);
         const g = b.build();
         g.userData.smoke = res.smoke;
         return g;
      });
      smoke = hullGeo.userData.smoke || [];
      const mat = makeShipMaterial(d.D);
      const root = new THREE.Group();
      const body = new THREE.Group();   // pitch/roll/heave/sink
      root.add(body);
      const hull = new THREE.Mesh(hullGeo, mat);
      hull.castShadow = true; hull.receiveShadow = true;
      body.add(hull);
      const trs = tl.map((t) => {
         const big = t.cal >= 250;
         const house = this._geo(`th|${t.r.toFixed(2)}|${t.guns}|${big}|${tint.join(',')}`, () => buildTurretHouse(t.r, t.cal, t.guns, shade(tint, 1.04), big));
         const brl = this._geo(`tb|${t.r.toFixed(2)}|${t.cal}|${t.guns}`, () => { const o = buildBarrels(t.r, t.cal, t.guns, shade(tint, 1.04)); o.geo.userData = o; return o.geo; });
         const yaw = new THREE.Group();
         yaw.position.set(t.x, t.y, t.z);
         yaw.rotation.y = t.x < 0 ? -Math.PI : 0;
         const hm = new THREE.Mesh(house.geo, mat); hm.castShadow = true; hm.receiveShadow = true;
         yaw.add(hm);
         const pitch = new THREE.Group();
         pitch.position.set(t.r * 0.62, house.h * 0.45, 0);
         const bm = new THREE.Mesh(brl, mat); bm.castShadow = true; bm.receiveShadow = true;
         pitch.add(bm);
         yaw.add(pitch);
         body.add(yaw);
         const info = brl.userData;
         return { idx: t.i, yaw, pitch, cal: t.cal, guns: t.guns, tip: info.tip, offs: info.offs, lastReload: null, elev: 0.05 };
      });
      this.group.add(root);
      const seed = (typeof ship.id === 'number' ? ship.id : String(ship.id).split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) >>> 0;
      const rnd = mulberry32(seed + 17);
      return {
         ship, d, S, root, body, hull, mat, turrets: trs, smoke,
         heave: 0, pitch: 0, roll: 0, heel: 0, lastHeading: ship.heading || 0,
         opacity: ship.spotted === false ? 0 : 1, deadT: 0, sinkStarted: false,
         sinkRoll: (rnd() < 0.5 ? -1 : 1) * (0.25 + rnd() * 0.35), sinkPitch: (rnd() < 0.5 ? -1 : 1) * (0.06 + rnd() * 0.16),
         lastAmmo: ship.ammo, gone: false, rnd,
         fireSpots: Array.from({ length: 8 }, () => ({ x: (rnd() - 0.5) * d.L * 0.75, z: (rnd() - 0.5) * d.B * 0.5 })),
      };
   }

   sync(world, dt, time, camera) {
      const seen = this._seen || (this._seen = new Set());
      seen.clear();
      this.list.length = 0;
      this.hulls.length = 0;
      const ships = Array.isArray(world.ships) ? world.ships : [];
      for (const s of ships) {
         if (!s || !s.pos) continue;
         seen.add(s);
         let r = this.recs.get(s);
         if (!r) { r = this._build(s); this.recs.set(s, r); }
         this._update(r, s, world, dt, time, camera);
         if (!r.gone) this.list.push(r);
      }
      for (const [s, r] of this.recs) if (!seen.has(s)) this._remove(s, r);
   }

   _remove(s, r) {
      this.group.remove(r.root);
      r.mat.dispose();
      this.recs.delete(s);
   }

   _update(r, s, world, dt, time, camera) {
      const d = r.d;
      const alive = s.alive !== false;
      // ---- sinking progress ----
      let sinkT = 0;
      if (!alive) {
         r.deadT += dt;
         sinkT = Number.isFinite(s.sinkT) ? clamp(s.sinkT, 0, 1) : clamp(r.deadT / 18, 0, 1);
         if (!r.sinkStarted) {
            r.sinkStarted = true;
            this.fx?.sinkBurst(s.pos.x, s.pos.y, d.L, d.B, s.heading || 0);
         }
      }
      r.sinkT = sinkT;
      if (!alive && sinkT >= 0.999) { r.gone = true; r.root.visible = false; return; }
      r.gone = false;

      // ---- spotted fade ----
      const friendly = s.side !== 'enemy';
      const target = friendly || s.spotted !== false ? 1 : 0;
      r.opacity += clamp(target - r.opacity, -dt * 1.6, dt * 1.6);
      r.root.visible = r.opacity > 0.01;
      r.mat.opacity = r.opacity;
      r.mat.transparent = false;
      const cast = r.opacity > 0.5;
      if (r.hull.castShadow !== cast) { r.hull.castShadow = cast; for (const t of r.turrets) { t.yaw.children[0].castShadow = cast; t.pitch.children[0].castShadow = cast; } }

      // ---- pose on the swell ----
      const hd = s.heading || 0;
      const ch = Math.cos(hd), sh = Math.sin(hd);
      const x = s.pos.x, z = s.pos.y;
      const cp = camera.position;
      const hl = d.L * 0.4, hb = d.B * 0.5;
      const hB = this.ocean.heightAt(x + ch * hl, z + sh * hl, cp), hS = this.ocean.heightAt(x - ch * hl, z - sh * hl, cp);
      const hP = this.ocean.heightAt(x + sh * hb, z - ch * hb, cp), hSt = this.ocean.heightAt(x - sh * hb, z + ch * hb, cp);
      const hC = this.ocean.heightAt(x, z, cp);
      // big hulls average out short waves: damp response with length
      const resp = clamp(90 / d.L, 0.35, 1);
      const tHeave = (hB + hS + hP + hSt + hC * 2) / 6 * lerp(0.6, 1, resp);
      const tPitch = Math.atan2(hB - hS, hl * 2) * resp;
      const tRoll = Math.atan2(hP - hSt, hb * 2) * 0.5 * resp;
      let dh = hd - r.lastHeading; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      r.lastHeading = hd;
      const yawRate = dt > 0 ? dh / dt : 0;
      const spd = Math.abs(s.speed || 0);
      const kn = Number.isFinite(s.speedKn) ? s.speedKn : spd / 2.6;
      const tHeel = clamp(yawRate * kn * 0.012, -0.09, 0.09);
      const k = 1 - Math.exp(-dt * 2.5);
      r.heave += (tHeave - r.heave) * k;
      r.pitch += (tPitch - r.pitch) * k;
      r.roll += (tRoll - r.roll) * k;
      r.heel += (tHeel - r.heel) * (1 - Math.exp(-dt * 1.2));
      // squat: bow rises slightly at speed
      const trim = -clamp(kn / 35, 0, 1) * 0.006;
      let py = r.heave, rz = r.pitch - trim, rx = r.roll + r.heel;
      if (sinkT > 0) {
         const e = sinkT * sinkT;
         py -= e * (d.D + d.T + d.L * 0.12) + sinkT * 2;
         rx += r.sinkRoll * smoothstep(0, 0.6, sinkT);
         rz += r.sinkPitch * smoothstep(0.1, 1, sinkT);
      }
      r.root.position.set(x, 0, z);
      r.root.rotation.set(0, -hd, 0);
      r.body.position.y = py;
      r.body.rotation.set(rx, 0, rz, 'YXZ');

      // ---- hit flash ----
      // only a rising edge flashes: fire/flood DoT re-arms sim hitFlash every frame and a
      // permanently glowing hull reads as a lighting bug
      const hf = clamp(s.hitFlash || 0, 0, 1);
      if (hf > (r.lastHF || 0) + 0.3) r.flashT = 0.22;
      r.lastHF = hf;
      r.flashT = Math.max(0, (r.flashT || 0) - dt);
      const fl = r.flashT / 0.22;
      r.mat.emissive.setRGB(1.0, 0.42, 0.15);
      r.mat.emissiveIntensity = fl * fl * 0.35;
      // wrecks char quickly: a sinking hull in parade paint looks untouched
      const burnt = 1 - 0.62 * smoothstep(0, 0.3, sinkT);
      if (r.mat.color.r !== burnt) r.mat.color.setScalar(burnt);

      // ---- turrets ----
      const ammoChanged = s.ammo !== r.lastAmmo;
      r.lastAmmo = s.ammo;
      const turrets = Array.isArray(s.turrets) ? s.turrets : [];
      let rootDirty = true;
      const maxRange = s.cfg?.main?.range || 20000;
      const aim = s.aimPoint || s.target?.pos || null;
      const aimDist = aim ? Math.hypot(aim.x - x, aim.y - z) : maxRange * 0.4;
      for (const tr of r.turrets) {
         const t = turrets[tr.idx];
         if (!t) continue;
         const dead = t.alive === false || !alive;
         if (!dead && Number.isFinite(t.bearing)) tr.yaw.rotation.y = -t.bearing;
         let el = Number.isFinite(t.elev) ? t.elev : lerp(0.02, 0.3, clamp(aimDist / maxRange, 0, 1));
         if (dead) el = -0.04;
         tr.elev += (el - tr.elev) * (1 - Math.exp(-dt * 4));
         tr.pitch.rotation.z = tr.elev;
         // firing detection: reload timer jumps up (and it wasn't an ammo swap)
         const rl = Number.isFinite(t.reload) ? t.reload : (Number.isFinite(t.cd) ? t.cd : null);
         if (rl !== null && tr.lastReload !== null && rl > tr.lastReload + 0.3 && !ammoChanged && alive && r.opacity > 0.05) {
            if (rootDirty) { r.root.updateMatrixWorld(true); rootDirty = false; }
            this._muzzle(r, tr, s);
         }
         tr.lastReload = rl;
      }
      if (sinkT === 0 && alive) this.hulls.push(this._hullRec(x, z, hd, d));
      r.x = x; r.z = z; r.hd = hd; r.kn = kn; r.spd = spd; r.alive = alive; r.visible = r.root.visible;
   }

   _hullRec(x, z, heading, d) {
      return { x, z, heading, halfL: d.L * 0.52, halfB: d.B * 0.6 };
   }

   _muzzle(r, tr, s) {
      r.lastMuzzleT = performance.now();
      const n = tr.offs.length;
      for (let i = 0; i < n; i++) {
         _v.set(tr.tip, 0, tr.offs[i]);
         tr.pitch.localToWorld(_v);
         _v2.set(1, 0, 0).applyQuaternion(tr.pitch.getWorldQuaternion(_q));
         this.fx?.muzzle(_v, _v2, tr.cal, i / n * 0.03);
      }
   }

   // world-space funnel tops of a record (for smoke); writes into out[] (reused vectors)
   funnelTops(r, out) {
      let n = 0;
      for (const p of r.smoke) {
         const o = out[n] || (out[n] = new THREE.Vector3());
         o.copy(p);
         r.body.localToWorld(o);
         n++;
      }
      return n;
   }

   worldPoint(r, lx, ly, lz, out) {
      out.set(lx, ly, lz);
      return r.body.localToWorld(out);
   }

   // nearest ship record to a world point (used to attach fallback muzzle effects)
   nearest(x, z, maxD) {
      let best = null, bd = maxD;
      for (const r of this.list) { const dd = Math.hypot(r.x - x, r.z - z); if (dd < bd) { bd = dd; best = r; } }
      return best;
   }

   clear() {
      for (const [s, r] of this.recs) this._remove(s, r);
      for (const g of this.geoCache.values()) (g.isBufferGeometry ? g : g.geo).dispose();   // turret houses cache {geo, h}
      this.geoCache.clear();
   }

   dispose() {
      this.clear();
      this.scene.remove(this.group);
   }
}
