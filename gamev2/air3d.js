// game3d/air3d.js — carrier aircraft in the 3D view: every plane of every visible squadron is one
// instance of a single merged low-poly mesh (one draw call for all of them), falling bombs a second
// instanced mesh and shot-down planes a third (smoke trail, splash on impact). No shadows: the
// planes fly hundreds of metres up, their shadows would land outside the shadow box anyway.
// From detail 2 up that one mesh holds three models (torpedo bomber, dive bomber, fighter) and the
// vertex shader clips away the two an instance is not, so it stays a single draw call.
// Reads world.squadrons / world.bombs / 'planeDown' effects; squads carry render positions
// sq.rx / ry / ralt / rh set by main3d's interpolation (falls back to the sim position).
import * as THREE from '../vendor/three/three.module.min.js';
import { patchAtmosphere } from './gfxcommon3d.js';
import { GFX } from './gfxquality.js';

const MAX_PLANES = 360, MAX_WRECKS = 32, MAX_BOMBS = 48;
const SCALE = 2.2;            // planes are drawn larger than life so a flight reads at 3-5 km
// formation slots (local: x ahead, z right) for up to 8 planes: a V, then a second V behind
const SLOT = [[0, 0], [-26, -22], [-26, 22], [-52, -44], [-52, 44], [-78, -66], [-78, 66], [-104, 0]];
const NATION_COL = { de: 0x5f6b55, jp: 0x8f9580, uk: 0x6c6a52, us: 0x4f6275, fr: 0x667066, it: 0x7a7458, su: 0x5d6b4c };

function box(w, h, d, x, y, z) {
   const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
   g.translate(x, y, z);
   return g;
}
// merge non-indexed geometries (vendor/three has no BufferGeometryUtils)
function merge(parts) {
   let n = 0;
   for (const g of parts) n += g.attributes.position.count;
   const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
   let o = 0;
   for (const g of parts) {
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      o += g.attributes.position.count;
      g.dispose();
   }
   const m = new THREE.BufferGeometry();
   m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
   m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
   return m;
}
// single-engine monoplane, nose toward +x, ~11 m long / 13 m span (before SCALE)
function planeGeometry() {
   const g = merge([
      box(10.5, 1.3, 1.3, 0, 0, 0),           // fuselage
      box(1.2, 1.5, 1.5, 5.2, 0, 0),          // engine cowling
      box(2.2, 0.22, 13, 1.2, -0.35, 0),      // wing
      box(1.1, 0.16, 4.6, -4.6, 0.1, 0),      // tailplane
      box(1.3, 1.7, 0.18, -4.7, 0.9, 0),      // fin
      box(2.4, 0.6, 0.8, 1.0, 0.85, 0),       // canopy
   ]);
   g.scale(SCALE, SCALE, SCALE);
   return g;
}


// ---- detail >= 2: one model per squadron type, painted by the vertex shader ----
// part: 0 airframe, 2 canopy, 3 cowling / gear, 4 / 5 roundel ring / centre, 6 propeller disc,
// 7 / 8 port / starboard light, 9 torpedo or bomb (gone once dropped)
const TYPE_IDX = { tb: 0, db: 1, ft: 2 };
const NATION_IDX = { us: 0, jp: 1, uk: 2, de: 3, it: 4, fr: 5, su: 6 };
function flat(g, part) {
   const n = g.index ? g.toNonIndexed() : g;
   if (n !== g) g.dispose();
   n.userData.part = part;
   return n;
}
// tube along +x from x to x + len, radius r0 aft and r1 forward; sy flattens / deepens it
function tube(r0, r1, len, x, y, part = 0, seg = 6, sy = 1, z = 0) {
   const g = new THREE.CylinderGeometry(r1, r0, len, seg);
   g.translate(0, len / 2, 0); g.rotateZ(-Math.PI / 2); g.scale(1, sy, 1); g.translate(x, y, z);
   return flat(g, part);
}
// tapered, swept wing with dihedral, centred on (x, y)
function wing(chord, t, span, x, y, taper, sweep, dih, part = 0) {
   const g = new THREE.BoxGeometry(chord, t, span, 1, 1, 2).toNonIndexed();
   const p = g.attributes.position;
   for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i), f = Math.abs(z) / (span / 2);
      p.setXYZ(i, p.getX(i) * (1 - taper * f) + sweep * f, p.getY(i) * (1 - 0.5 * f) + Math.abs(z) * dih, z);
   }
   g.computeVertexNormals();
   g.translate(x, y, 0);
   return flat(g, part);
}
function disc(r, x, y, z, rx, ry, part, seg = 10) {
   const g = new THREE.CircleGeometry(r, seg);
   g.rotateX(rx); g.rotateY(ry); g.translate(x, y, z);
   return flat(g, part);
}
function pbox(w, h, d, x, y, z, part) { return flat(box(w, h, d, x, y, z), part); }
// wing + fuselage markings and the tip lights for a wing at height wy with dihedral dih
function markings(wx, wy, dih, zr, zt, r, fxs, fy, fz) {
   const out = [];
   for (const s of [1, -1]) {
      const y = wy + 0.14 + zr * dih;
      out.push(disc(r, wx, y, s * zr, -Math.PI / 2, 0, 4), disc(r * 0.5, wx, y + 0.03, s * zr, -Math.PI / 2, 0, 5));
      out.push(disc(r * 0.8, fxs, fy, s * fz, 0, s > 0 ? 0 : Math.PI, 4, 8), disc(r * 0.4, fxs, fy, s * (fz + 0.03), 0, s > 0 ? 0 : Math.PI, 5, 8));
      out.push(pbox(0.26, 0.12, 0.2, wx, wy + zt * dih, s * zt, s > 0 ? 8 : 7));
   }
   return out;
}
function propDisc(r, x, y) { return [disc(r, x, y, 0, 0, Math.PI / 2, 6, 12), disc(r, x, y, 0, 0, -Math.PI / 2, 6, 12)]; }
function fineGeometry() {
   const models = [
      // torpedo bomber: big and deep-bellied, long greenhouse, torpedo slung underneath
      [tube(0.25, 0.85, 6.5, -5.8, 0.1, 0, 6, 1.25), tube(0.85, 0.85, 3.6, 0.7, 0.1, 0, 6, 1.25), tube(0.9, 0.68, 1.0, 4.3, 0.1, 3, 8, 1.2),
         ...propDisc(1.85, 5.36, 0.1), wing(3.0, 0.26, 15.5, 1.4, -0.5, 0.4, -0.3, 0.05), wing(1.5, 0.14, 5.6, -5.0, 0.3, 0.4, -0.2, 0),
         pbox(1.8, 2.0, 0.16, -5.1, 1.3, 0, 0), tube(0.3, 0.42, 3.8, -1.5, 1.05, 2, 6, 1.1), tube(0.12, 0.26, 5.2, -1.8, -1.3, 9, 6),
         ...markings(1.4, -0.5, 0.05, 5.4, 7.6, 1.0, -2.4, 0.15, 0.62)],
      // dive bomber: cranked-up wing, fixed spatted undercarriage, bomb on the centreline
      [tube(0.2, 0.72, 5.8, -5.1, 0.05, 0, 6, 1.2), tube(0.72, 0.74, 3.3, 0.7, 0.05, 0, 6, 1.2), tube(0.78, 0.56, 0.95, 4.0, 0.05, 3, 8, 1.15),
         ...propDisc(1.65, 5.0, 0.05), wing(2.8, 0.24, 13.5, 1.2, -0.55, 0.5, -0.2, 0.11), wing(1.3, 0.13, 4.8, -4.5, 0.25, 0.4, -0.2, 0),
         pbox(1.5, 1.7, 0.15, -4.6, 1.1, 0, 0), tube(0.26, 0.38, 3.0, -1.0, 0.9, 2, 6, 1.1),
         pbox(1.6, 1.2, 0.42, 1.3, -0.95, 2.0, 3), pbox(1.6, 1.2, 0.42, 1.3, -0.95, -2.0, 3),
         tube(0.1, 0.38, 1.2, -0.5, -1.15, 9, 6), tube(0.38, 0.12, 1.0, 0.7, -1.15, 9, 6),
         ...markings(1.2, -0.55, 0.11, 4.7, 6.6, 0.9, -2.1, 0.1, 0.52)],
      // fighter: small, clean, bubble canopy
      [tube(0.18, 0.62, 5.2, -4.6, 0.05, 0, 6, 1.15), tube(0.62, 0.66, 3.2, 0.6, 0.05, 0, 6, 1.15), tube(0.68, 0.48, 0.9, 3.8, 0.05, 3, 8, 1.1),
         ...propDisc(1.55, 4.75, 0.05), wing(2.3, 0.2, 11, 1.3, -0.35, 0.45, -0.25, 0.07), wing(1.2, 0.12, 4, -4.0, 0.15, 0.4, -0.15, 0),
         pbox(1.4, 1.5, 0.14, -4.1, 0.95, 0, 0), tube(0.2, 0.36, 1.7, 0.1, 0.78, 2, 6, 1.1),
         ...markings(1.3, -0.35, 0.07, 3.8, 5.4, 0.8, -1.9, 0.1, 0.44)],
   ];
   let n = 0;
   for (const parts of models) for (const g of parts) n += g.attributes.position.count;
   const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), part = new Float32Array(n), type = new Float32Array(n);
   let o = 0;
   models.forEach((parts, t) => {
      for (const g of parts) {
         const c = g.attributes.position.count;
         pos.set(g.attributes.position.array, o * 3);
         nor.set(g.attributes.normal.array, o * 3);
         part.fill(g.userData.part, o, o + c); type.fill(t, o, o + c);
         o += c;
         g.dispose();
      }
   });
   const m = new THREE.BufferGeometry();
   m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
   m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
   m.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
   m.setAttribute('aType', new THREE.BufferAttribute(type, 1));
   m.scale(SCALE, SCALE, SCALE);
   return m;
}
const FINE_SHADER = {
   key: 'air-fine',
   vertexPars: 'attribute float aPart;\nattribute float aType;\nattribute vec3 aInst;\nvarying float vPart;',
   vertexMain: `
      vPart = aPart;
      // an instance draws only its own model; ordnance goes once it has been dropped
      if (abs(aType - aInst.x) > 0.5 || (aPart > 8.5 && aInst.z < 0.5)) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vec3 pc = vColor;
      if (aPart < 0.5) pc = mix(pc, vec3(0.5, 0.56, 0.6), smoothstep(0.35, 0.8, -objectNormal.y) * 0.8);   // pale underside
      else if (aPart < 2.5) pc = vec3(0.1, 0.15, 0.19);
      else if (aPart < 3.5) pc *= 0.35;
      else if (aPart < 5.5) {
         bool inner = aPart > 4.5;
         vec3 W = vec3(0.75), R = vec3(0.45, 0.02, 0.02), Bl = vec3(0.02, 0.045, 0.16);
         float nt = aInst.y;
         if (nt < 0.5) pc = inner ? W : Bl;
         else if (nt < 1.5) pc = R;
         else if (nt < 2.5) pc = inner ? R : Bl;
         else if (nt < 3.5) pc = inner ? vec3(0.02) : W;
         else if (nt < 4.5) pc = inner ? vec3(0.08, 0.18, 0.07) : W;
         else if (nt < 5.5) pc = inner ? Bl : R;
         else pc = R;
      }
      else if (aPart < 6.5) pc = vec3(0.16);
      else if (aPart < 7.5) pc = vec3(0.7, 0.02, 0.02);
      else if (aPart < 8.5) pc = vec3(0.02, 0.6, 0.1);
      else pc = vec3(0.07, 0.075, 0.07);
      vColor = pc;`,
   fragmentPars: 'varying float vPart;\nfloat airHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
   fragmentReplace: [
      // the spinning propeller is a dithered blur disc
      ['#include <color_fragment>', '#include <color_fragment>\nif (vPart > 5.5 && vPart < 6.5 && airHash(gl_FragCoord.xy) > 0.26) discard;'],
      ['#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nif (vPart > 6.5 && vPart < 8.5) totalEmissiveRadiance += diffuseColor.rgb * 2.5;'],
   ],
};

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YZX');
const _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _c = new THREE.Color();

export class AirModels {
   constructor(scene, fx) {
      this.fx = fx;
      this.fine = GFX.detail >= 2;
      const mat = patchAtmosphere(new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.25 }), this.fine ? FINE_SHADER : { key: 'air' });
      this.planes = new THREE.InstancedMesh(this.fine ? fineGeometry() : planeGeometry(), mat, MAX_PLANES);
      if (this.fine) {
         this.inst = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PLANES * 3), 3);   // type, nation, armed
         this.inst.setUsage(THREE.DynamicDrawUsage);
         this.planes.geometry.setAttribute('aInst', this.inst);
      }
      this.planes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.planes.setColorAt(0, _c.set(0xffffff));
      this.planes.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.planes.count = 0;
      this.planes.frustumCulled = false;
      const wmat = patchAtmosphere(new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.9, metalness: 0.1 }), { key: 'air' });
      this.wreckMesh = new THREE.InstancedMesh(planeGeometry(), wmat, MAX_WRECKS);
      this.wreckMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.wreckMesh.count = 0;
      this.wreckMesh.frustumCulled = false;
      const bg = new THREE.CylinderGeometry(0.35, 0.35, 3.2, 6).rotateZ(Math.PI / 2);
      bg.scale(SCALE, SCALE, SCALE);
      this.bombMesh = new THREE.InstancedMesh(bg, patchAtmosphere(new THREE.MeshStandardMaterial({ color: 0x33352f, roughness: 0.6 }), { key: 'air' }), MAX_BOMBS);
      this.bombMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.bombMesh.count = 0;
      this.bombMesh.frustumCulled = false;
      scene.add(this.planes, this.wreckMesh, this.bombMesh);
      // shot-down planes: fixed pool, no per-frame allocation
      this.wrecks = Array.from({ length: MAX_WRECKS }, () => ({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, h: 0, roll: 0, spin: 0, smokeT: 0 }));
      this._seen = new WeakSet();
      this.drawn = 0;   // planes drawn last frame (perf hook)
   }

   clear() {
      for (const w of this.wrecks) w.on = false;
      this._seen = new WeakSet();
      this.planes.count = this.wreckMesh.count = this.bombMesh.count = 0;
   }

   update(world, dt, time) {
      this._planes(world, time);
      this._bombs(world);
      this._wrecks(world, dt);
   }

   _planes(world, time) {
      const sqs = world.squadrons || [];
      const M = this.planes;
      let k = 0;
      for (let i = 0; i < sqs.length && k < MAX_PLANES; i++) {
         const sq = sqs[i];
         if (sq.n <= 0 || !sq.visible) continue;
         if (sq._col == null) {
            const c = world.shipById?.(sq.ownerId);
            sq._col = NATION_COL[c?.cfg?.hull?.nation] ?? 0x5d6560;
            sq._nat = NATION_IDX[c?.cfg?.hull?.nation] ?? 7;
         }
         const ti = TYPE_IDX[sq.type] ?? 2, armed = sq.type !== 'ft' && sq.armed > 0 ? 1 : 0;
         _c.set(sq._col);
         const x = sq.rx ?? sq.pos.x, y = sq.ry ?? sq.pos.y, alt = sq.ralt ?? sq.alt, h = sq.rh ?? sq.heading;
         const dh = sq.want != null ? Math.atan2(Math.sin(sq.want - sq.heading), Math.cos(sq.want - sq.heading)) : 0;
         const bank = Math.max(-0.75, Math.min(0.75, dh * 1.6));
         // pitch from the climb rate (dive bombers tip over into their dive)
         const climb = sq.prev ? (sq.alt - sq.prev.alt) * 60 : 0;
         const pitch = Math.max(-1.2, Math.min(0.35, Math.atan2(climb, Math.max(40, sq.speed))));
         const c = Math.cos(h), s = Math.sin(h);
         const n = Math.min(sq.n, SLOT.length);
         for (let j = 0; j < n && k < MAX_PLANES; j++) {
            const [fx, fz] = SLOT[j];
            const bob = Math.sin(time * 1.3 + j * 1.7 + sq.id) * 2.5;
            // formation offset in sim (x ahead, z right of the heading) -> world
            _p.set(x + fx * c - fz * s, alt + bob - Math.abs(fz) * 0.08, y + fx * s + fz * c);
            _e.set(bank, -h, pitch, 'YZX');
            _q.setFromEuler(_e);
            _m.compose(_p, _q, _s);
            M.setMatrixAt(k, _m);
            M.setColorAt(k, _c);
            if (this.inst) this.inst.setXYZ(k, ti, sq._nat, armed);
            k++;
         }
      }
      M.count = k;
      this.drawn = k;
      if (k) {
         M.instanceMatrix.needsUpdate = true; M.instanceColor.needsUpdate = true;
         if (this.inst) this.inst.needsUpdate = true;
      }
   }

   _bombs(world) {
      const bs = world.bombs || [];
      const M = this.bombMesh;
      let k = 0;
      for (let i = 0; i < bs.length && k < MAX_BOMBS; i++) {
         const b = bs[i];
         if (!b.alive || b.t < 0) continue;
         const f = Math.min(1, b.t / b.fall);
         _p.set(b.sx + (b.x - b.sx) * f, b.salt * (1 - f * f) + 2, b.sy + (b.y - b.sy) * f);
         _e.set(0, -b.heading, -0.4 - f * 0.9, 'YZX');
         _q.setFromEuler(_e);
         _m.compose(_p, _q, _s);
         M.setMatrixAt(k++, _m);
      }
      M.count = k;
      if (k) M.instanceMatrix.needsUpdate = true;
   }

   _wrecks(world, dt) {
      const fxs = world.effects;
      if (Array.isArray(fxs)) {
         for (let i = fxs.length - 1; i >= 0; i--) {
            const e = fxs[i];
            if (e.kind !== 'planeDown') continue;
            if (this._seen.has(e)) break;   // effects are appended: everything older was handled
            this._seen.add(e);
            let w = null;
            for (const o of this.wrecks) if (!o.on) { w = o; break; }
            if (!w) continue;
            const sp = Number(e.speed) || 80, h = Number(e.heading) || 0;
            w.on = true; w.x = e.pos.x; w.z = e.pos.y; w.y = Number(e.alt) || 200;
            w.vx = Math.cos(h) * sp; w.vz = Math.sin(h) * sp; w.vy = -5; w.h = h;
            w.roll = 0; w.spin = (Math.floor(e.pos.x) & 1 ? 1 : -1) * (1.5 + (w.y % 7) * 0.3); w.smokeT = 0;
            this._burst(w.x, w.y, w.z);
         }
      }
      const M = this.wreckMesh;
      let k = 0;
      for (const w of this.wrecks) {
         if (!w.on) continue;
         w.vy -= 9.8 * dt; w.vx *= 1 - 0.25 * dt; w.vz *= 1 - 0.25 * dt;
         w.x += w.vx * dt; w.y += w.vy * dt; w.z += w.vz * dt; w.roll += w.spin * dt;
         if ((w.smokeT -= dt) <= 0) { w.smokeT = 0.07; this._trail(w.x, w.y, w.z); }
         if (w.y <= 0) {
            w.on = false;
            this.fx._splash?.(w.x, w.z, 150, false);
            continue;
         }
         const pitch = Math.atan2(w.vy, Math.hypot(w.vx, w.vz));
         _p.set(w.x, w.y, w.z);
         _e.set(w.roll, -w.h, pitch, 'YZX');
         _q.setFromEuler(_e);
         _m.compose(_p, _q, _s);
         M.setMatrixAt(k++, _m);
      }
      M.count = k;
      if (k) M.instanceMatrix.needsUpdate = true;
   }

   _burst(x, y, z) {
      const G = this.fx?.glow;
      if (!G) return;
      const p = G.t();
      p.x = x; p.y = y; p.z = z; p.life = 0.35; p.s0 = 8; p.s1 = 22; p.grow = 3;
      p.r = 45; p.g = 20; p.b = 5; p.r1 = 8; p.g1 = 2; p.b1 = 0.2; p.fin = 0; p.fout = 0.3; p.shape = 0;
      G.emit();
   }
   _trail(x, y, z) {
      const P = this.fx?.puff, G = this.fx?.glow;
      if (!P) return;
      let p = P.t();
      p.x = x; p.y = y; p.z = z; p.vx = 0; p.vy = 1; p.vz = 0; p.drag = 0.5; p.grav = 0;
      p.life = 3.2; p.s0 = 3; p.s1 = 12; p.grow = 2.5;
      p.r = 0.04; p.g = 0.038; p.b = 0.035; p.r1 = 0.16; p.g1 = 0.155; p.b1 = 0.15;
      p.a = 0.75; p.fin = 0.05; p.fout = 0.5; p.shape = 1; p.lit = 0.6; p.wind = 1; p.rot = 0; p.spin = 0.2;
      P.emit();
      if (G) {
         p = G.t();
         p.x = x; p.y = y; p.z = z; p.life = 0.25; p.s0 = 3; p.s1 = 1.5; p.grow = 1;
         p.r = 30; p.g = 12; p.b = 3; p.r1 = 8; p.g1 = 2; p.b1 = 0.3; p.fin = 0; p.fout = 0.4; p.shape = 0;
         G.emit();
      }
   }
}
