// game3d/air3d.js — carrier aircraft in the 3D view: every plane of every visible squadron is one
// instance of a single merged low-poly mesh (one draw call for all of them), falling bombs a second
// instanced mesh and shot-down planes a third (smoke trail, splash on impact). No shadows: the
// planes fly hundreds of metres up, their shadows would land outside the shadow box anyway.
// Reads world.squadrons / world.bombs / 'planeDown' effects; squads carry render positions
// sq.rx / ry / ralt / rh set by main3d's interpolation (falls back to the sim position).
import * as THREE from '../vendor/three/three.module.min.js';
import { patchAtmosphere } from './gfxcommon3d.js';

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

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YZX');
const _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _c = new THREE.Color();

export class AirModels {
   constructor(scene, fx) {
      this.fx = fx;
      const mat = patchAtmosphere(new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.25 }), { key: 'air' });
      this.planes = new THREE.InstancedMesh(planeGeometry(), mat, MAX_PLANES);
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
         }
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
            k++;
         }
      }
      M.count = k;
      this.drawn = k;
      if (k) { M.instanceMatrix.needsUpdate = true; M.instanceColor.needsUpdate = true; }
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
