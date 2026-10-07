// gamev2/ops3d.js — the small things of the special operations in 3D: the ship-borne helicopter
// (sim: helo.js; the airframe itself is drawn by air3d.js from world.helos), the lightweight ASW
// torpedo entering the water, the task-point markers and the boats of the swimmer teams (seal.js).
// Presentation only: reads world.helos / world.taskPoints / world.teams / world.events and never
// writes sim fields (only render scratch: rx, ry, ralt, rh, rbob on helicopters and teams).
// Works from replicated data: every field is read with a fallback (a replicated helicopter has no
// `goal`, maybe no `prev`).
//
// Cost: nothing is drawn or computed while the lists are empty. Markers are two instanced draw
// calls (ring + beam) and the boats one, each only while present; effects go through the shared
// pools of fx3d.js. On the low tier the rotor downwash is skipped.
import * as THREE from '../vendor/three/three.module.min.js';
import { GFX } from './gfxquality.js';

const MAX_MARK = 12, MAX_BOAT = 8;
const TAU = Math.PI * 2;
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _c = new THREE.Color();
const _Y = new THREE.Vector3(0, 1, 0);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// marker colours (linear, additive): open amber, team at work white-hot pulse, done green
const COL_OPEN = [1.5, 0.95, 0.25], COL_BUSY = [1.7, 1.5, 1.0], COL_DONE = [0.25, 1.0, 0.45];
const TOW_PTS = 13;               // points of the tow line

export class OpsFX {
   constructor(scene, fx, terrain) {
      this.scene = scene; this.fx = fx; this.terrain = terrain;
      this.alpha = 1;                  // sim interpolation factor (renderer sets it every frame)
      this.side = 'player';            // whose task points / teams are shown (main3d sets it)
      this.lastSeq = -1;
      this.marks = 0; this.boats = 0; this.helos = 0;   // drawn this frame (tests)
      this.dips = 0; this.splashes = 0;                 // effects started since clear() (tests)
      // ---- task point marker: a flat ring on the ground and a thin beam of light above it
      const ring = new THREE.RingGeometry(0.84, 1, 40);
      ring.rotateX(-Math.PI / 2);
      const beam = new THREE.CylinderGeometry(0.035, 0.05, 1, 6, 1, true);
      beam.translate(0, 0.5, 0);
      // the beam fades out toward the top: additive, so a darker vertex colour is a thinner beam
      const n = beam.attributes.position.count, col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const k = 1 - beam.attributes.position.getY(i); col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k * k; }
      beam.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const mk = (geo, vc) => {
         const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: vc, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
         const M = new THREE.InstancedMesh(geo, mat, MAX_MARK);
         M.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
         M.setColorAt(0, _c.setRGB(1, 1, 1)); M.instanceColor.setUsage(THREE.DynamicDrawUsage);
         M.frustumCulled = false; M.count = 0; M.visible = false; M.renderOrder = 21;
         scene.add(M);
         return M;
      };
      this.ring = mk(ring, false); this.beam = mk(beam, true);
      // ---- inflatable boat of a team: a dark wedge, big enough to find but not to notice
      const hull = new THREE.BoxGeometry(6.5, 0.9, 2.3);
      hull.translate(0, 0.45, 0);
      this.boat = new THREE.InstancedMesh(hull, new THREE.MeshStandardMaterial({ color: 0x1b1f22, roughness: 0.85, metalness: 0 }), MAX_BOAT);
      this.boat.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.boat.frustumCulled = false; this.boat.count = 0; this.boat.visible = false;
      scene.add(this.boat);
   }

   clear() {
      this.lastSeq = -1; this.dips = 0; this.splashes = 0;
      this.ring.count = this.beam.count = this.boat.count = 0;
      this.ring.visible = this.beam.visible = this.boat.visible = false;
      if (this.tow) this.tow.visible = false;
   }

   update(world, dt, time, camera) {
      this._events(world);
      this._helos(world, dt, time);
      this._markers(world, time, camera);
      this._teams(world, dt, time);
      const z = world.mission && world.mission.zones && world.mission.zones[0];
      if (z && z.tow) this._tow(world, z.tow);
      else if (this.tow) this.tow.visible = false;
   }

   // A tow line (mission.zones[0].tow = [tug id, towed id, length m]): one thin line from the tug's stern to the
   // bow of the towed ship that sags while slack. Built on first use, so no other mission pays for it.
   _tow(world, tow) {
      const a = world.shipById(tow[0]), b = world.shipById(tow[1]);
      if (!a || !b || !a.alive || !b.alive) { if (this.tow) this.tow.visible = false; return; }
      if (!this.tow) {
         const g = new THREE.BufferGeometry();
         g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TOW_PTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
         this.tow = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xd9d2bd }));
         this.tow.frustumCulled = false;
         this.scene.add(this.tow);
      }
      const la = a.cfg.hull.L * 0.45, lb = b.cfg.hull.L * 0.5;
      const ax = a.pos.x - Math.cos(a.heading) * la, az = a.pos.y - Math.sin(a.heading) * la;
      const bx = b.pos.x + Math.cos(b.heading) * lb, bz = b.pos.y + Math.sin(b.heading) * lb;
      const d = Math.hypot(bx - ax, bz - az), sag = Math.max(1.5, Math.sqrt(0.375 * d * Math.max(0, tow[2] - d)));
      const p = this.tow.geometry.attributes.position;
      for (let i = 0; i < TOW_PTS; i++) {
         const t = i / (TOW_PTS - 1);
         p.setXYZ(i, ax + (bx - ax) * t, Math.max(0.3, 3.5 + 5 * t - sag * 4 * t * (1 - t)), az + (bz - az) * t);
      }
      p.needsUpdate = true;
      this.tow.visible = true;
   }

   _events(world) {
      const ev = world.events;
      if (!ev || !ev.length) return;
      // joined a running battle: do not replay the backlog
      if (this.lastSeq < 0 && ev[ev.length - 1].seq > 40 && world.time > 3) { this.lastSeq = ev[ev.length - 1].seq; return; }
      const fx = this.fx;
      for (let i = 0; i < ev.length; i++) {
         const e = ev[i];
         if (!(e.seq > this.lastSeq)) continue;
         this.lastSeq = e.seq;
         const pos = e.pos;
         if (!pos) continue;
         if (e.type === 'heloDip') {
            // the sonar body breaks the surface: a short foam ring under the hovering helicopter
            fx.decals.add(0, pos.x, pos.y, (e.seq * 1.7) % TAU, 5, 46, 3.2, 0.85, 1.6);
            fx.decals.add(1, pos.x, pos.y, 0, 12, 85, 1.6, 0.5);
            this.dips++;
         } else if (e.type === 'aswTorp') {
            // parachute-retarded drop or tube launch: a slim column where the torpedo goes in
            fx._splash(pos.x, pos.y, 203, false);
            fx.decals.add(0, pos.x, pos.y, (e.seq * 2.3) % TAU, 4, 30, 4, 0.8, 1.6);
            this.splashes++;
         } else if (e.type === 'heloLost' && e.reason !== 'fuel') {
            // air3d draws the falling wreck (effect 'planeDown'); this is the hit itself
            fx._flak(pos.x, Math.max(8, +e.alt || 60), pos.y, 1.6);
         }
      }
   }

   // render pose of every helicopter (air3d reads rx / ry / ralt / rh / rbob) + rotor downwash
   _helos(world, dt, time) {
      const hs = world.helos;
      this.helos = 0;
      if (!hs || !hs.length) return;
      const a = this.alpha, wash = GFX.effects >= 1;
      for (let i = 0; i < hs.length; i++) {
         const h = hs[i];
         if (!h || !h.pos) continue;
         const r = h.prev, alt = +h.alt || 0, hd = +h.heading || 0;
         if (r && r.x != null && (r.x !== 0 || r.y !== 0 || r.alt !== 0)) {
            h.rx = r.x + (h.pos.x - r.x) * a; h.ry = r.y + (h.pos.y - r.y) * a;
            h.ralt = (r.alt ?? alt) + (alt - (r.alt ?? alt)) * a;
            h.rh = (r.h ?? hd) + wrap(hd - (r.h ?? hd)) * a;
         } else { h.rx = h.pos.x; h.ry = h.pos.y; h.ralt = alt; h.rh = hd; }
         // steady over the deck and in the dip, loose in transit
         h.rbob = Math.min(1, Math.max(0, (h.ralt - 16) / 40));
         if (h.visible === false || h.alive === false) continue;
         this.helos++;
         if (!wash || h.ralt > 48) continue;
         // rotor downwash on the water: a faint ring every half second while it hovers low
         h._washT = (h._washT || 0) - dt;
         if (h._washT > 0) continue;
         h._washT = 0.5;
         if (this.terrain && this.terrain.heightAt(h.rx, h.ry) > 0.5) continue;
         const owner = world.shipById?.(h.ownerId);
         if (owner && owner.pos && Math.hypot(owner.pos.x - h.rx, owner.pos.y - h.ry) < (owner.cfg?.hull?.L || 150) * 0.6) continue;   // over its own deck
         const k = 1 - h.ralt / 48;
         this.fx.decals.add(1, h.rx, h.ry, time % TAU, 9, 38 + 20 * k, 1.5, 0.22 + 0.3 * k);
      }
   }

   _markers(world, time, camera) {
      const tps = world.taskPoints;
      let k = 0;
      if (tps && tps.length) {
         const cp = camera.position;
         for (let i = 0; i < tps.length && k < MAX_MARK; i++) {
            const t = tps[i];
            if (!t || (t.side && t.side !== this.side)) continue;
            const x = t.pos ? t.pos.x : t.x, z = t.pos ? t.pos.y : t.y;
            if (x == null) continue;
            const y = Math.max(0, this.terrain ? this.terrain.heightAt(x, z) : 0) + 1.2;
            const d = Math.hypot(x - cp.x, z - cp.z, y - cp.y);
            // constant apparent size beyond 1.5 km so the point can be found from the boat
            const sc = 55 * Math.min(9, Math.max(1, d / 1500));
            const busy = t.state === 'busy', done = t.state === 'done';
            const c = done ? COL_DONE : busy ? COL_BUSY : COL_OPEN;
            const pulse = done ? 0.55 : busy ? 0.75 + 0.25 * Math.sin(time * 6) : 0.8 + 0.2 * Math.sin(time * 2.2 + i);
            _q.identity();
            _m.compose(_p.set(x, y, z), _q, _s.set(sc, 1, sc));
            this.ring.setMatrixAt(k, _m); this.ring.setColorAt(k, _c.setRGB(c[0] * pulse, c[1] * pulse, c[2] * pulse));
            _m.compose(_p, _q, _s.set(sc, done ? sc * 1.2 : sc * 4.5, sc));
            const b = pulse * (done ? 0.3 : 0.6);
            this.beam.setMatrixAt(k, _m); this.beam.setColorAt(k, _c.setRGB(c[0] * b, c[1] * b, c[2] * b));
            k++;
         }
      }
      this.marks = k;
      this._show(this.ring, k); this._show(this.beam, k);
   }
   _show(M, k) {
      if (!k) { if (M.visible) { M.visible = false; M.count = 0; } return; }
      M.count = k; M.visible = true; M.instanceMatrix.needsUpdate = true; M.instanceColor.needsUpdate = true;
   }

   _teams(world, dt, time) {
      const ts = world.teams, M = this.boat;
      let k = 0;
      if (ts && ts.length) {
         const e = 1 - Math.exp(-dt / 0.12);
         for (let i = 0; i < ts.length && k < MAX_BOAT; i++) {
            const t = ts[i];
            if (!t || !t.pos || (t.side && t.side !== this.side)) continue;
            if (t.state !== 'out' && t.state !== 'returning') { t.rx = undefined; continue; }   // ashore, aboard or gone
            // the sim steps the team without `prev`: ease toward the sim position instead
            if (t.rx == null || Math.hypot(t.pos.x - t.rx, t.pos.y - t.ry) > 60) { t.rx = t.pos.x; t.ry = t.pos.y; }
            else { t.rx += (t.pos.x - t.rx) * e; t.ry += (t.pos.y - t.ry) * e; }
            if (this.terrain && this.terrain.heightAt(t.rx, t.ry) > 0.6) continue;               // beached
            const hd = +t.heading || 0;
            _q.setFromAxisAngle(_Y, -hd);
            _m.compose(_p.set(t.rx, 0.15 + 0.25 * Math.sin(time * 1.9 + i), t.ry), _q, _s.set(1, 1, 1));
            M.setMatrixAt(k++, _m);
            if (GFX.effects >= 1) this.fx.wakes.feed(t, 1, t.rx - Math.cos(hd) * 3, t.ry - Math.sin(hd) * 3, +t.speed || 9, 1.4, 0.5, time);
         }
      }
      this.boats = k;
      if (!k) { if (M.visible) { M.visible = false; M.count = 0; } return; }
      M.count = k; M.visible = true; M.instanceMatrix.needsUpdate = true;
   }
}
