// game/render3d.js — Three.js scene: real 3D hulls, turrets that visibly slew, ballistic
// shells with a genuine Y-axis arc. Reads the SAME World/Ship objects as the 2D renderer
// (game/state.js, game/ship.js) — this module only turns simulation state into pixels.
// World convention: X+ = east, Y+ = south (2D sim). Here: worldX -> 3D X, worldY -> 3D Z,
// height -> 3D Y. So a sim point {x,y} maps to Three.Vector3(x, 0, y).
import * as THREE from '../vendor/three/three.module.min.js';

const DIMS = {
   DD: { L: 120, beam: 13, deckH: 10 }, LC: { L: 170, beam: 18, deckH: 13 },
   HC: { L: 205, beam: 22, deckH: 16 }, EB: { L: 251, beam: 36, deckH: 22 },
   Bismarck: { L: 251, beam: 36, deckH: 22 },
};
const dimsOf = (cls) => DIMS[cls] || { L: 180, beam: 20, deckH: 14 };
const HULL_COLORS = { player: 0x3a4a55, enemy: 0x5a4a44 };

function v3(p, y = 0) { return new THREE.Vector3(p.x, y, p.y); }

export class Renderer3D {
   constructor(canvas) {
      this.canvas = canvas;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x0a1830);
      this.scene.fog = new THREE.FogExp2(0x18314a, 0.00028);

      // far=12000 was massive overkill: the whole arena is only 3800m half-extent, and fog
      // already hides anything past ~6-7km, so the camera was depth-testing/rendering a
      // sky sphere and sea plane sized for a view distance nothing in the game reaches.
      this.camera = new THREE.PerspectiveCamera(58, 1, 4, 7000);
      this.camYaw = 0;      // world-space camera bearing (free-look, set by main3d) -- NOT tied to ship heading
      this.camPitch = 0.42; // radians above horizon
      this.camDist = 420;   // camera distance from the ship (wheel zoom, set by main3d)

      this._buildLights();
      this._buildSea();
      this._buildSky();

      this.shipMeshes = new Map();   // ship.id -> {group, turrets:[{mesh, turretRef}], hull}
      this.shellMeshes = new Map();  // shell.id -> mesh
      this.torpMeshes = new Map();   // torpedo.id -> mesh
      this.splashPool = [];
      this._explosions = [];

      this.minimapCtx = null;
      this.compassCtx = null;

      this._shakeT = 0;
      this._shakeMag = 0;
   }

   setHudCanvases(minimap, compass) {
      this.minimapCtx = minimap ? minimap.getContext('2d') : null;
      this.compassCtx = compass ? compass.getContext('2d') : null;
   }

   resize(w, h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
   }

   _buildLights() {
      const sun = new THREE.DirectionalLight(0xfff3d6, 2.2);
      sun.position.set(-1200, 900, -600);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.left = -1200; sun.shadow.camera.right = 1200;
      sun.shadow.camera.top = 1200; sun.shadow.camera.bottom = -1200;
      sun.shadow.camera.near = 100; sun.shadow.camera.far = 4000;
      sun.shadow.bias = -0.0015;
      this.scene.add(sun);
      this.sun = sun;
      this.scene.add(new THREE.AmbientLight(0x8fb0d0, 0.65));
      const hemi = new THREE.HemisphereLight(0xbcd8ff, 0x0e3350, 0.5);
      this.scene.add(hemi);
   }

   _buildSea() {
      // Waves are displaced on the GPU (vertex shader), not by walking ~20k vertices and
      // calling computeVertexNormals() on the CPU every frame -- that first approach cost
      // enough to drop the whole game to ~12 FPS. A small onBeforeCompile patch onto the
      // standard material keeps normal PBR lighting/shadows and just perturbs position.y +
      // recomputes the normal analytically from the height-field's spatial derivative,
      // which is what computeVertexNormals() was doing per-frame on the CPU anyway.
      const geo = new THREE.PlaneGeometry(20000, 20000, 60, 60);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshStandardMaterial({ color: 0x0f3a5c, roughness: 0.35, metalness: 0.15 });
      mat.onBeforeCompile = (shader) => {
         shader.uniforms.uTime = this._seaTimeUniform = { value: 0 };
         shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader;
         // <beginnormal_vertex> is where three.js itself declares `vec3 objectNormal =
         // vec3( normal );` -- redeclaring it later in <begin_vertex> is a GLSL redefinition
         // error (that's what silently broke the sea and tanked FPS: the shader failed to
         // compile, so three.js was falling back / erroring every draw call). Replace the
         // normal there instead of declaring a second one downstream.
         shader.vertexShader = shader.vertexShader.replace(
            '#include <beginnormal_vertex>',
            `
            float dhdx = cos(position.x * 0.012 + uTime * 0.9) * 3.5 * 0.012;
            float dhdz = sin(position.z * 0.015 - uTime * 0.7) * 2.5 * 0.015;
            vec3 objectNormal = normalize(vec3(-dhdx, 1.0, dhdz));
            `
         );
         shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            `
            float h = sin(position.x * 0.012 + uTime * 0.9) * 3.5 + cos(position.z * 0.015 - uTime * 0.7) * 2.5;
            vec3 transformed = vec3(position.x, h, position.z);
            `
         );
      };
      this.sea = new THREE.Mesh(geo, mat);
      this.sea.receiveShadow = true;
      this.scene.add(this.sea);
      this._seaTime = 0;
   }

   _buildSky() {
      const geo = new THREE.SphereGeometry(9000, 24, 16);
      const mat = new THREE.MeshBasicMaterial({ color: 0x0a1830, side: THREE.BackSide, fog: false });
      this.sky = new THREE.Mesh(geo, mat);
      this.scene.add(this.sky);
   }

   _updateSea(dt) {
      this._seaTime += dt;
      // Displacement + normals happen in the vertex shader (see _buildSea) -- this is now
      // just a uniform update, no per-vertex CPU work at all.
      if (this._seaTimeUniform) this._seaTimeUniform.value = this._seaTime;
   }

   // ================= OBSTACLES =================
   buildObstacles(world) {
      this.obstacleGroup = new THREE.Group();
      this.scene.add(this.obstacleGroup);
      for (const o of world.obstacles) {
         if (o.kind === 'island') {
            const lobes = o.lobes || [];
            const shape = new THREE.Shape();
            for (let i = 0; i < lobes.length; i++) {
               const x = Math.cos(lobes[i].a) * lobes[i].r, z = Math.sin(lobes[i].a) * lobes[i].r;
               i === 0 ? shape.moveTo(x, z) : shape.lineTo(x, z);
            }
            shape.closePath();
            const geo = new THREE.ExtrudeGeometry(shape, { depth: 60, bevelEnabled: true, bevelThickness: 8, bevelSize: 6, bevelSegments: 2 });
            // rotateX(-PI/2) makes the extrusion run UPWARD (+Y): the solid then spans
            // y in [-8, +68] around its origin. (The old +PI/2 rotated it DOWNWARD, so with
            // the mesh parked at y=-6 only ~2m poked above water -- below the ~6m wave
            // amplitude -- which is why islands read as flat slivers that vanished in swells.)
            geo.rotateX(-Math.PI / 2);
            const mat = new THREE.MeshStandardMaterial({ color: 0x3a5a3a, roughness: 0.95 });
            const mesh = new THREE.Mesh(geo, mat);
            // Top lands at ~+58m above the sea, base sinks to ~-18m (hidden under the water).
            mesh.position.set(o.c.x, -10, o.c.y);
            mesh.castShadow = true; mesh.receiveShadow = true;
            this.obstacleGroup.add(mesh);
         } else {
            // reef: a flat translucent shallow-water disc, no solid geometry
            const geo = new THREE.CircleGeometry(o.r, 32);
            geo.rotateX(-Math.PI / 2);
            const mat = new THREE.MeshBasicMaterial({ color: 0x5ac6aa, transparent: true, opacity: 0.28 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(o.c.x, 0.5, o.c.y);
            this.obstacleGroup.add(mesh);
         }
      }
   }

   // ================= SHIPS =================
   _buildShip(ship) {
      const dim = dimsOf(ship.cls);
      const group = new THREE.Group();
      const hullColor = ship.side === 'player' ? HULL_COLORS.player : HULL_COLORS.enemy;
      const L = dim.L, B = dim.beam;

      // Hull: built from simple boxes (a tapered ExtrudeGeometry hull turned into an
      // invisible/degenerate mesh in testing -- boxes are trivially robust and still read
      // fine as a warship silhouette at gameplay camera distance). Local +X = bow, +Y = up,
      // +Z = starboard (sim +Y). A single long box would be a brick; three tapered
      // sections (bow/mid/stern) fake a hull taper cheaply.
      const hullMat = new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.65, metalness: 0.25 });
      const hull = new THREE.Group();
      const midGeo = new THREE.BoxGeometry(L * 0.62, dim.deckH, B);
      const mid = new THREE.Mesh(midGeo, hullMat);
      mid.position.set(-L * 0.02, 0, 0);
      hull.add(mid);
      // Bow: a cone laid on its side so the apex points forward (+X). More radial segments
      // than a boat needs, but a low-poly 4-gon cone put its FACE (not a vertex) forward,
      // which read as a lopsided/crooked bow instead of a clean point.
      const bowGeo = new THREE.ConeGeometry(B * 0.52, L * 0.4, 12);
      bowGeo.rotateZ(-Math.PI / 2); // cone's apex (+Y) now points to +X
      bowGeo.scale(1, 1, 0.55); // flatten so the bow reads as a hull, not a torpedo nose
      const bow = new THREE.Mesh(bowGeo, hullMat);
      bow.position.set(L * 0.29 + L * 0.02, 0, 0);
      hull.add(bow);
      const sternGeo = new THREE.BoxGeometry(L * 0.36, dim.deckH * 0.85, B * 0.82);
      const stern = new THREE.Mesh(sternGeo, hullMat);
      stern.position.set(-L * 0.33 - L * 0.02, -dim.deckH * 0.05, 0);
      hull.add(stern);
      for (const m of hull.children) { m.castShadow = true; m.receiveShadow = true; }
      hull.position.y = dim.deckH * 0.5;
      group.add(hull);

      // superstructure block (midships, simple readable silhouette)
      const supGeo = new THREE.BoxGeometry(L * 0.16, dim.deckH * 1.3, B * 0.5);
      const supMat = new THREE.MeshStandardMaterial({ color: 0x6e5a50, roughness: 0.7 });
      const sup = new THREE.Mesh(supGeo, supMat);
      sup.position.set(-L * 0.05, dim.deckH * 0.6, 0);
      sup.castShadow = true;
      group.add(sup);
      const bridgeGeo = new THREE.BoxGeometry(L * 0.06, dim.deckH * 0.8, B * 0.22);
      const bridge = new THREE.Mesh(bridgeGeo, supMat);
      bridge.position.set(L * 0.02, dim.deckH * 1.5, 0);
      bridge.castShadow = true;
      group.add(bridge);

      // turrets: real child objects that ROTATE to track bearing -- this is the whole point
      // of the 3D mode. Each turret gets a base + twin barrels; barrel length hints caliber.
      const turrets = [];
      for (const t of ship.turrets) {
         const turretGroup = new THREE.Group();
         turretGroup.position.set(t.off.x, dim.deckH * 0.55, -t.off.y); // sim +Y=starboard -> 3D -Z
         const baseGeo = new THREE.CylinderGeometry(B * 0.14, B * 0.16, dim.deckH * 0.5, 10);
         const baseMat = new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.5, metalness: 0.35 });
         const base = new THREE.Mesh(baseGeo, baseMat);
         base.castShadow = true;
         turretGroup.add(base);
         const barrelLen = Math.max(10, L * 0.16);
         const barrelGeo = new THREE.CylinderGeometry(0.9, 1.1, barrelLen, 6);
         barrelGeo.rotateZ(Math.PI / 2);
         for (const side of [-1, 1]) {
            const barrel = new THREE.Mesh(barrelGeo, baseMat);
            barrel.position.set(barrelLen / 2, dim.deckH * 0.15, side * B * 0.045);
            barrel.castShadow = true;
            turretGroup.add(barrel);
         }
         group.add(turretGroup);
         turrets.push({ mesh: turretGroup, ref: t });
      }

      // funnel
      const funnelGeo = new THREE.CylinderGeometry(B * 0.09, B * 0.11, dim.deckH * 1.1, 10);
      const funnelMat = new THREE.MeshStandardMaterial({ color: 0x222a30, roughness: 0.8 });
      const funnel = new THREE.Mesh(funnelGeo, funnelMat);
      funnel.position.set(-L * 0.12, dim.deckH * 1.1, 0);
      funnel.castShadow = true;
      group.add(funnel);

      group.castShadow = true;
      this.scene.add(group);
      return { group, hullMat, turrets };
   }

   // ================= MAIN FRAME =================
   render(world, dt, camState) {
      this._updateSea(dt);
      this._syncShips(world);
      this._syncShells(world);
      this._syncTorpedoes(world);
      this._syncCamera(world, dt, camState);
      this.renderer.render(this.scene, this.camera);
      this._minimap(world);
      this._compass(world);
   }

   _syncShips(world) {
      const seen = new Set();
      for (const s of world.ships) {
         if (!s.alive) { const rec = this.shipMeshes.get(s.id); if (rec) { this.scene.remove(rec.group); this.shipMeshes.delete(s.id); } continue; }
         seen.add(s.id);
         let rec = this.shipMeshes.get(s.id);
         if (!rec) { rec = this._buildShip(s); this.shipMeshes.set(s.id, rec); }
         rec.group.position.set(s.pos.x, 0, s.pos.y);
         // sim heading: 0 = +X (east). 3D: rotate group so local +X (bow) points to world heading.
         // Three.js Y-rotation is measured from +Z toward +X in a LH-looking sense for our
         // mapping (worldY -> 3D Z); negate to match sim's CCW-positive convention.
         rec.group.rotation.y = -s.heading;
         for (const t of rec.turrets) t.mesh.rotation.y = -t.ref.bearing; // relative to hull, sim bearing is hull-relative too
         rec.hullMat.emissive = new THREE.Color(s.hitFlash > 0 ? 0xffffff : 0x000000);
         rec.hullMat.emissiveIntensity = Math.max(0, s.hitFlash) * 0.6;
      }
      for (const [id, rec] of this.shipMeshes) if (!seen.has(id)) { this.scene.remove(rec.group); this.shipMeshes.delete(id); }
   }

   _syncShells(world) {
      const seen = new Set();
      for (const s of world.shells) {
         seen.add(s.id);
         let mesh = this.shellMeshes.get(s.id);
         if (!mesh) {
            const geo = new THREE.SphereGeometry(2.2, 6, 6);
            const mat = new THREE.MeshBasicMaterial({ color: s.owner === 'player' ? 0xffe9b0 : 0xffb0a0 });
            mesh = new THREE.Mesh(geo, mat);
            this.scene.add(mesh);
            this.shellMeshes.set(s.id, mesh);
         }
         // Genuine ballistic parabola (rendering-only -- the sim stays flat 2D): h(t) = 4·H·t·(1−t)
         // crests at the flight midpoint and lands exactly on the target, like real plunging fire.
         // The old sin() hop peaked at only ~5% of range (a 1800m shot topped out at ~99m --
         // nearly invisible from the chase cam), which is why shells read as flat lasers.
         // Now the crest scales with the gun's range (a 1800m shot arcs ~180m up), and a short
         // ramp from muzzle height (~deck level) makes the shell visibly LEAVE the gun instead
         // of popping out of the waterline.
         const t = Math.min(1, s.arc);
         const H = Math.max(40, (s.gun.range || 1400) * 0.10);
         const height = 4 * H * t * (1 - t) + 18 * (1 - t);
         mesh.position.set(s.pos.x, height, s.pos.y);
      }
      for (const [id, mesh] of this.shellMeshes) if (!seen.has(id)) { this.scene.remove(mesh); this.shellMeshes.delete(id); }
   }

   _syncTorpedoes(world) {
      const seen = new Set();
      for (const t of world.torpedoes) {
         seen.add(t.id);
         let mesh = this.torpMeshes.get(t.id);
         if (!mesh) {
            const geo = new THREE.CapsuleGeometry(1.3, 9, 4, 8);
            geo.rotateZ(Math.PI / 2);
            const mat = new THREE.MeshBasicMaterial({ color: t.owner === 'player' ? 0xdff2ff : 0xffd8d0 });
            mesh = new THREE.Mesh(geo, mat);
            this.scene.add(mesh);
            this.torpMeshes.set(t.id, mesh);
         }
         mesh.position.set(t.pos.x, -3.5, t.pos.y);
         mesh.rotation.y = -t.dir;
      }
      for (const [id, mesh] of this.torpMeshes) if (!seen.has(id)) { this.scene.remove(mesh); this.torpMeshes.delete(id); }
   }

   // Set by main3d.js each frame with the resolved chase-camera pose (base over-the-shoulder
   // pose + free-look offsets + wheel zoom). Stored here so _syncCamera can consume it and so
   // screenToWorld() raycasts against the exact camera the player is looking through.
   setCameraPose(yaw, pitch, dist) {
      this.camYaw = yaw;
      this.camPitch = pitch;
      this.camDist = dist;
   }

   // Third-person orbit camera: follows the player ship's POSITION at a fixed offset
   // (camYaw/camPitch/camDist set via setCameraPose), always looking at the ship. The
   // orientation is a WORLD-SPACE pose owned entirely by the player (right-mouse drag in
   // main3d.js) -- it deliberately does NOT track the ship's heading, so steering with
   // A/D moves the ship under a stable view instead of spinning the whole screen.
   _syncCamera(world, dt, camState) {
      const p = world.player;
      // world._shake is set by combat.js on hits/explosions (same convention the 2D
      // renderer's camera consumes) -- pick it up directly instead of a separate API.
      this._shakeMag = Math.max(this._shakeMag * Math.exp(-dt / 0.15), world._shake || 0);
      if (!p || !p.alive) {
         this.camera.position.set(0, 900, 1400);
         this.camera.lookAt(0, 0, 0);
         return;
      }
      const dist = this.camDist || 420;
      // Height scales with distance so the framing stays roughly constant as you zoom out --
      // a fixed height would make the ship shrink to a dot in overview range.
      const height = 60 + dist * 0.4;
      // World-space bearing -- deliberately NOT derived from p.heading, so rudder input
      // never rotates the view. The ship turns under a stable camera instead.
      const yaw = this.camYaw;
      const cx = p.pos.x - Math.cos(yaw) * dist * Math.cos(this.camPitch);
      const cz = p.pos.y - Math.sin(yaw) * dist * Math.cos(this.camPitch);
      const cy = height + Math.sin(this.camPitch) * dist;
      const shakeX = (Math.random() - 0.5) * this._shakeMag, shakeY = (Math.random() - 0.5) * this._shakeMag;
      this.camera.position.set(cx + shakeX, Math.max(35, cy), cz + shakeY);
      this.camera.lookAt(p.pos.x, 20, p.pos.y);
      this.sun.target.position.set(p.pos.x, 0, p.pos.y);
      this.sun.target.updateMatrixWorld();
   }

   // raycast helper for input3d.js: screen (nx,ny in [-1,1]) -> world point on sea plane
   screenToWorld(nx, ny) {
      const ray = new THREE.Raycaster();
      ray.setFromCamera({ x: nx, y: ny }, this.camera);
      const planeY = 0;
      const dirY = ray.ray.direction.y;
      if (Math.abs(dirY) < 1e-6) return null;
      const t = (planeY - ray.ray.origin.y) / dirY;
      if (t < 0) return null;
      const p = ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
      return { x: p.x, y: p.z };
   }

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
