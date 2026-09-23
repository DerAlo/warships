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
   const D = clamp(Number(h.deckH) || (type === 'TR' ? L * 0.06 : L * 0.042), 3, L * 0.08);
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
function turretSize(caliber, B) { return Math.min(B * 0.17, 1.3 + caliber * 0.0125); }

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
   const len = clamp(cal * 48, 3.5, 22);
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

// ---------------- superstructure by class ----------------
function superstructure(b, d, S, tur, col) {
   const { L, B, type } = d;
   const lv = 2.7;            // one deck level (m)
   const sup = col.sup, dark = col.dark, mast = col.mast, win = col.win, boat = col.boat;
   const fwd = tur.filter(t => t.x > 0).sort((a, b2) => a.x - b2.x);
   const aft = tur.filter(t => t.x <= 0).sort((a, b2) => b2.x - a.x);
   const rT = tur.length ? Math.max(...tur.map(t => t.r)) : B * 0.12;
   let xF = fwd.length ? fwd[0].x - fwd[0].r * 1.5 : L * 0.12;
   let xA = aft.length ? aft[0].x + aft[0].r * 1.5 : -L * 0.26;
   if (xF - xA < L * 0.16) { const c = (xF + xA) / 2; xF = c + L * 0.08; xA = c - L * 0.08; }
   const span = xF - xA;
   const deckMid = S.deckAt((xF + xA) / 2);
   const hw = (x) => S.halfDeckAt(x);
   const smoke = [];
   const box = (x0, x1, y0, h, halfW, c) => { b.band = 3; b.box(x1 - x0, h, halfW * 2, (x0 + x1) / 2, y0 + h / 2, 0, c); b.band = 0; };
   const windows = (x, y, halfW) => b.box(0.25, 0.7, halfW * 1.7, x + 0.02, y, 0, win);
   const funnel = (x, y0, h, rx, rz, rakeA) => {
      const g = new THREE.CylinderGeometry(1, 1.06, h, 16);
      g.translate(0, h / 2, 0);
      g.scale(rx, 1, rz);
      b.put(g, x, y0, 0, (px, py) => (py > y0 + h * 0.86 ? dark : sup), 0, 0, rakeA);
      const cap = new THREE.CylinderGeometry(1.05, 1.05, 0.5, 16); cap.scale(rx, 1, rz);
      const tx = x - Math.sin(rakeA) * h, ty = y0 + Math.cos(rakeA) * h;
      b.put(cap, tx, ty, 0, dark, 0, 0, rakeA);
      smoke.push(new THREE.Vector3(tx, ty + 0.5, 0));
   };
   const mastPole = (x, y0, h, r0, yard) => {
      b.cyl(r0 * 0.5, r0, h, x, y0, 0, mast, 6);
      if (yard) { const g = new THREE.CylinderGeometry(0.12, 0.12, yard, 5); g.rotateX(Math.PI / 2); b.put(g, x, y0 + h * 0.82, 0, mast); }
   };
   const rangefinder = (x, y, len) => {
      const g = new THREE.CylinderGeometry(0.4, 0.4, len, 8); g.rotateX(Math.PI / 2); b.put(g, x, y, 0, dark);
      b.box(1.6, 1.3, 1.8, x, y - 0.4, 0, sup);
   };
   const aaMount = (x, y, z) => { b.box(1.6, 0.9, 1.6, x, y + 0.45, z, sup); b.tubeX(0.08, 0.06, 2.4, x, y + 0.8, z + 0.3, dark, 4); b.tubeX(0.08, 0.06, 2.4, x, y + 0.8, z - 0.3, dark, 4); };
   const lifeboat = (x, y, z, len) => { const g = new THREE.SphereGeometry(1, 10, 6); b.put(g, x, y + 0.6, z, boat, 0, 0, 0, len / 2, 0.55, 1.0); };
   const secTurret = (x, y, z, r) => {
      b.cyl(r, r * 1.05, r * 0.7, x, y, z, shade(sup, 0.95), 10);
      const dir = z > 0 ? 1 : -1;
      const a = dir * 0.6;
      b.put(new THREE.CylinderGeometry(0.13, 0.16, r * 2.4, 6).rotateZ(-Math.PI / 2).translate(r * 1.2, 0, 0), x, y + r * 0.45, z + dir * 0.25, dark, 0, -a, 0);
      b.put(new THREE.CylinderGeometry(0.13, 0.16, r * 2.4, 6).rotateZ(-Math.PI / 2).translate(r * 1.2, 0, 0), x, y + r * 0.45, z - dir * 0.25, dark, 0, -a, 0);
   };

   if (type === 'BB') {
      const y0 = deckMid;
      const hwm = Math.min(hw((xF + xA) / 2) * 0.62, B * 0.32);
      box(xA, xF, y0, lv * 1.6, hwm, sup);                                  // main deckhouse
      box(xA + span * 0.12, xF - span * 0.05, y0 + lv * 1.6, lv, hwm * 0.72, sup);
      // forward tower: conning tower + stacked bridge levels + director
      const xt = xF - span * 0.16;
      b.cyl(B * 0.085, B * 0.09, lv * 2.2, xF - span * 0.035, y0 + lv * 1.6, 0, shade(sup, 0.85), 14);
      let yy = y0 + lv * 2.6;
      for (let i = 0; i < 4; i++) {
         const w = hwm * (0.8 - i * 0.11), l = span * (0.2 - i * 0.022);
         box(xt - l / 2, xt + l / 2, yy, lv * 0.95, w, sup);
         if (i === 1 || i === 3) windows(xt + l / 2, yy + lv * 0.55, w);
         yy += lv * 0.95;
      }
      rangefinder(xt, yy + 1.2, B * 0.34);
      b.cyl(1.6, 1.8, 2.2, xt - 1.5, yy + 1.8, 0, shade(sup, 0.9), 12);
      // tripod/pole mast behind the tower
      mastPole(xt - span * 0.12, yy - lv, lv * 5, 0.6, B * 0.5);
      // funnel
      const xfn = xA + span * 0.45;
      funnel(xfn, y0 + lv * 2.4, lv * 4.2, span * 0.075, B * 0.13, 0);
      // aft control position
      const xa = xA + span * 0.14;
      box(xa - span * 0.07, xa + span * 0.07, y0 + lv * 2.6, lv * 1.3, hwm * 0.5, sup);
      rangefinder(xa, y0 + lv * 4.5, B * 0.28);
      mastPole(xa + span * 0.06, y0 + lv * 3.9, lv * 3.4, 0.4, B * 0.3);
      // secondaries: three per side along the deckhouse
      const sr = Math.min(1.9, B * 0.055);
      for (let i = 0; i < 3; i++) {
         const x = xA + span * (0.22 + i * 0.25);
         const z = Math.min(hw(x) * 0.8, hwm + sr * 1.6);
         secTurret(x, S.deckAt(x), z, sr); secTurret(x, S.deckAt(x), -z, sr);
      }
      // AA + boats + cranes
      for (const s of [1, -1]) {
         aaMount(xfn + span * 0.12, y0 + lv * 1.6, s * hwm * 0.75);
         aaMount(xfn - span * 0.14, y0 + lv * 1.6, s * hwm * 0.75);
         lifeboat(xfn - span * 0.02, y0 + lv * 2.6, s * hwm * 0.55, 8);
         b.cyl(0.25, 0.35, lv * 3.2, xfn - span * 0.1, y0 + lv * 2.6, s * hwm * 0.5, mast, 5);
      }
   } else if (type === 'CA' || type === 'CL') {
      const y0 = deckMid;
      const hwm = Math.min(hw((xF + xA) / 2) * 0.6, B * 0.3);
      box(xA + span * 0.3, xF, y0, lv, hwm, sup);
      const xb = xF - span * 0.1;
      let yy = y0 + lv;
      for (let i = 0; i < 3; i++) {
         const w = hwm * (0.95 - i * 0.14), l = span * (0.18 - i * 0.03);
         box(xb - l / 2, xb + l / 2, yy, lv * 0.95, w, sup);
         if (i === 2) windows(xb + l / 2, yy + lv * 0.55, w);
         yy += lv * 0.95;
      }
      rangefinder(xb - 1, yy + 1, B * 0.3);
      // tripod mast
      const xm = xb - span * 0.12;
      for (const [dx, dz] of [[0, 0], [-4, 1.6], [-4, -1.6]]) {
         b.put(new THREE.CylinderGeometry(0.25, 0.35, lv * 6, 5).translate(0, lv * 3, 0), xm + dx * 0.4, y0 + lv, dz * 0.4, mast, dz * 0.03, 0, dx * -0.02);
      }
      b.put(new THREE.CylinderGeometry(0.12, 0.12, B * 0.55, 5).rotateX(Math.PI / 2), xm, y0 + lv * 6, 0, mast);
      // two raked funnels
      const f1 = xA + span * 0.6, f2 = xA + span * 0.42;
      funnel(f1, y0 + lv, lv * 3.3, span * 0.05, B * 0.1, 0.1);
      funnel(f2, y0 + lv * 0.6, lv * 3.3, span * 0.05, B * 0.1, 0.1);
      // catapult + crane amidships
      b.box(span * 0.03, 0.6, B * 0.7, xA + span * 0.27, S.deckAt(xA + span * 0.27) + 1.2, 0, dark, 0.6);
      b.cyl(0.3, 0.4, lv * 2.6, xA + span * 0.33, y0, hwm * 0.6, mast, 5);
      // aft superstructure
      box(xA, xA + span * 0.2, y0, lv * 1.4, hwm * 0.8, sup);
      rangefinder(xA + span * 0.1, y0 + lv * 1.9, B * 0.24);
      mastPole(xA + span * 0.16, y0 + lv * 1.4, lv * 3, 0.3, B * 0.28);
      for (const s of [1, -1]) {
         aaMount(f1 + span * 0.02, y0 + lv, s * hwm * 0.85);
         lifeboat((f1 + f2) / 2, y0 + lv * 0.6, s * hwm * 0.95, 7);
      }
      if (type === 'CA') {
         const sr = Math.min(1.5, B * 0.05);
         for (const s of [1, -1]) { secTurret(xA + span * 0.72, S.deckAt(xA + span * 0.72), s * hw(xA + span * 0.72) * 0.7, sr); }
      }
   } else if (type === 'DD') {
      const y0 = S.deckAt(xF);
      const hwm = Math.min(hw(xF) * 0.62, B * 0.3);
      const xb = xF - span * 0.08;
      box(xb - span * 0.1, xb + span * 0.07, y0, lv * 1.1, hwm, sup);
      box(xb - span * 0.07, xb + span * 0.05, y0 + lv * 1.1, lv * 0.95, hwm * 0.85, sup);
      windows(xb + span * 0.05, y0 + lv * 1.6, hwm * 0.85);
      rangefinder(xb - span * 0.02, y0 + lv * 2.4, B * 0.35);
      mastPole(xb - span * 0.12, y0 + lv, lv * 5, 0.25, B * 0.5);
      const ym = S.deckAt(0);
      funnel(xA + span * 0.63, ym, lv * 2.6, span * 0.045, B * 0.13, 0.12);
      funnel(xA + span * 0.46, ym, lv * 2.3, span * 0.045, B * 0.13, 0.12);
      // torpedo tube mounts on the centreline
      for (const tx of [xA + span * 0.3, xA + span * 0.14]) {
         const ty = S.deckAt(tx);
         b.cyl(1.3, 1.4, 0.7, tx, ty, 0, sup, 10);
         for (let k = -1; k <= 1; k++) b.tubeX(0.32, 0.32, 7, tx - 3.5, ty + 1.0, k * 0.75, dark, 8);
      }
      // depth-charge racks at the stern
      for (const s of [1, -1]) b.box(4, 0.8, 0.9, -L * 0.46, S.deckAt(-L * 0.46) + 0.4, s * hw(-L * 0.46) * 0.6, dark);
      for (const s of [1, -1]) aaMount(xA + span * 0.55, ym, s * hw(xA + span * 0.55) * 0.6);
   } else if (type === 'CV') {
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
      mastPole(xi + L * 0.02, yF + 0.5 + lv * 4.3, lv * 3, 0.3, B * 0.2);
   } else {   // TR: freighter / transport
      const xh = -L * 0.3;
      const y0 = S.deckAt(xh);
      const hwm = hw(xh) * 0.9;
      box(xh - L * 0.1, xh + L * 0.08, y0, lv * 2.2, hwm, col.boat);
      box(xh - L * 0.07, xh + L * 0.05, y0 + lv * 2.2, lv, hwm * 0.8, col.boat);
      windows(xh + L * 0.05, y0 + lv * 2.7, hwm * 0.8);
      funnel(xh - L * 0.03, y0 + lv * 3.2, lv * 2.4, L * 0.028, B * 0.16, 0.05);
      for (const hx of [L * 0.3, L * 0.14, -L * 0.02, -L * 0.42]) {
         b.box(L * 0.08, 1.2, hw(hx) * 1.1, hx, S.deckAt(hx) + 0.6, 0, dark);
      }
      for (const mx of [L * 0.22, -L * 0.1]) {
         mastPole(mx, S.deckAt(mx), lv * 6, 0.45, B * 0.6);
         for (const s of [1, -1]) b.put(new THREE.CylinderGeometry(0.15, 0.2, L * 0.1, 5).rotateZ(Math.PI / 2 - 0.5), mx + L * 0.04, S.deckAt(mx) + lv * 2, s * 1.2, mast);
      }
   }
   // jackstaff + ensign staff
   b.cyl(0.08, 0.12, 5, L * 0.5 + (HULL_PARAMS[type]?.rake || 0.03) * L * 0.9, S.deckAt(L * 0.49), 0, mast, 4);
   b.cyl(0.08, 0.12, 6, -L * 0.5 + 0.8, S.deckAt(-L * 0.49), 0, mast, 4);
   return { smoke, xF, xA };
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
         t.y = S.deckAt(t.x) + (outboard.length ? 2.9 : 0.25);
      }
      const hullKey = `${ship.cls}|${d.type}|${d.L}|${d.B}|${tint.join(',')}|${tl.map(t => t.x.toFixed(1) + ':' + t.r.toFixed(1)).join(',')}`;
      const cols = {
         sup: shade(tint, 1.12), dark: lin(0x2a2d31), mast: lin(0x3b3f44), win: lin(0x0b0d10), boat: lin(0xcfccc3),
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
         const res = superstructure(b, d, S, tl, cols);
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
