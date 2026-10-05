// gamev2/ships3d_modern_defs.js — the model definitions for ships3d_modern.js.
// Each entry: nominal size (L, B, T draught, D freeboard amidships, metres), kind
// ('ship' lofted hull | 'cv' lofted hull + flight deck | 'merchant' | 'sub' | 'cat' | 'boat'),
// hull form P (see makeHullShape), default nation / pennant, gunSlots (trainable mounts, in
// sim turret order) and build(k), which draws the rest with the Kit (x forward, y up, z starboard).
const PI = Math.PI;
const WARSHIP = { pb: 2.25, tr: 0.66, sheer: 0.6, flare: 1.2, rake: 0.05, nMid: 4.5, tumble: 1 };
const P = (o) => ({ ...WARSHIP, ...o });
const CARRIER = { pb: 2.5, tr: 0.78, sheer: 0, flare: 1.0, rake: 0.035, nMid: 5, tumble: 1 };
const MERCHANT = { pb: 1.35, tr: 0.8, sheer: 0.1, flare: 1.0, rake: 0.02, nMid: 9, tumble: 1, fc: true, fcH: 0.3, fcU: 0.8 };
const both = (fn) => { fn(1); fn(-1); };

// shared pieces ------------------------------------------------------------------------------
// enclosed pyramid mast on y0; returns its top
function pyramid(k, x0, x1, hw, y0, h, o = {}) {
   return k.hs(x0, x1, hw, y0, h, { s: hw * (o.taper ?? 0.6), rf: (x1 - x0) * 0.22, ra: (x1 - x0) * 0.22, cf: hw * 0.5, ca: hw * 0.5, col: k.c.sup, ...o });
}
function yards(k, x, y0, h, half) {
   k.yard(x, y0 + h * 0.45, half); k.yard(x, y0 + h * 0.7, half * 0.65);
   both(s => k.whip(x, y0 + h * 0.45, s * half, 4));
}
function hangarDoor(k, x, y0, y1, hw) { if (k.det >= 1) k.bx(x - 0.12, x + 0.05, y0 + 0.3, y1 - 0.8, -hw, hw, k.c.dark); }

// submarine fittings: fin with masts, planes, rudders, screw
function subFit(k, o) {
   const c = k.c, b = k.b, D = k.def.D, R = k.def.B / 2, yc = D - R, h = k.h;
   const hw = o.sailW, y0 = D - 0.5, yT = D + o.sailH;
   k.hs(o.sail[0], o.sail[1], hw, y0, o.sailH + 0.5, { band: 0, col: c.hull, top: c.hull, cf: hw * 0.95, ca: hw * (o.sailAft ?? 0.85), s: o.sailS ?? hw * 0.12, rf: o.sailRf ?? 0.4, ra: o.sailRa ?? 0.2 });
   const xm = (o.sail[0] + o.sail[1]) / 2, len = o.sail[1] - o.sail[0];
   k.anchor('sail', { x: xm, y: yT, z: 0 });
   const pTop = k.periTop && k.periTop > yT + 1 ? k.periTop : yT + (o.peri ?? 4.5);
   k.mast(xm + len * 0.16, yT - 0.5, pTop - yT + 0.5, 0.2, 0.16, { col: c.dark, seg: 5 });              // attack periscope
   k.mast(xm - len * 0.02, yT - 0.5, (pTop - yT) * 0.75 + 0.5, 0.26, 0.22, { col: c.dark, seg: 5 });    // search periscope / optronic mast
   if (k.det >= 1) k.mast(xm - len * 0.24, yT - 0.5, (pTop - yT) * 0.55 + 0.5, 0.4, 0.34, { col: c.dark, seg: 6 });   // snorkel / radar
   k.mastTop(xm + len * 0.16, pTop, 0);
   // free-flooding casing: a low, tapered walkway blended into the pressure hull
   if (o.casing) k.hs(o.casing[0], o.casing[1], o.casing[2], D - 1.0, 1.12, { band: 0, col: c.hull, top: c.hull, cf: o.casing[2] * 0.95, ca: o.casing[2] * 0.95, s: o.casing[2] * 0.3 });
   if (o.sailPlanes) k.bx(xm - 0.9 + (o.planeX || 0), xm + 0.9 + (o.planeX || 0), D + o.sailH * 0.5, D + o.sailH * 0.5 + 0.22, -o.sailPlanes, o.sailPlanes, c.hull);
   if (o.bowPlanes) k.bx(o.bowPlanes[0] - 1, o.bowPlanes[0] + 1, yc + R * 0.35, yc + R * 0.35 + 0.22, -o.bowPlanes[1], o.bowPlanes[1], c.hull);
   const xr = -h * 0.8, sp = o.rudder ?? R * 0.95;
   b.band = 0;
   if (o.x) { b.box(R * 0.7, sp * 2, 0.3, xr, yc, 0, c.hull, 0, 0, PI / 4); b.box(R * 0.7, sp * 2, 0.3, xr, yc, 0, c.hull, 0, 0, -PI / 4); }
   else { b.box(R * 0.7, sp * 2, 0.3, xr, yc, 0, c.hull); b.box(R * 0.7, 0.3, sp * 2, xr, yc, 0, c.hull); }
   if (k.det >= 1) b.cyl(R * 0.42, R * 0.42, 0.25, -h * 0.985, yc, 0, c.dark, 7, PI / 2);                // screw disc
}

// carrier pieces
function deckStripes(k, yF, strip, cats) {
   // strip: [x0, z0, x1, z1, halfWidth] of the angled landing area; cats: [[x0, z0, x1, z1], ...]
   const c = k.c, y = (x) => k.dk(x) + 0.09;
   const [x0, z0, x1, z1, hw] = strip, len = Math.hypot(x1 - x0, z1 - z0), nx = -(z1 - z0) / len, nz = (x1 - x0) / len;
   both(s => k.line(x0 + nx * hw * s, z0 + nz * hw * s, x1 + nx * hw * s, z1 + nz * hw * s, 0.6, yF + 0.09, c.mark));
   const n = k.det >= 2 ? 9 : k.det >= 1 ? 5 : 0;
   for (let i = 0; i < n; i++) { const a = (i + 0.15) / n, e = (i + 0.7) / n; k.line(x0 + (x1 - x0) * a, z0 + (z1 - z0) * a, x0 + (x1 - x0) * e, z0 + (z1 - z0) * e, 0.7, yF + 0.09, c.yellow); }
   for (const t of cats) {
      if (k.det >= 1) k.line(t[0], t[1], t[2], t[3], 0.7, (y(t[0]) + y(t[2])) / 2, t[4] ? c.mark : c.black);
      k.anchor('cat', { x: t[0], y: k.dk(t[0]), z: t[1], dir: Math.atan2(t[3] - t[1], t[2] - t[0]) });
   }
   k.anchor('flightDeck', { x: (x0 + x1) / 2, y: yF, z: (z0 + z1) / 2, l: len, w: hw * 2, dir: Math.atan2(z1 - z0, x1 - x0) });
}
function deckPark(k, spots) {
   if (k.det < 2) return;
   const n = k.det >= 3 ? spots.length : Math.ceil(spots.length / 2);
   for (let i = 0; i < n; i++) k.jet(spots[i][0], spots[i][1], spots[i][2]);
}

// merchant pieces
function merchantHouse(k, x0, x1, hw, h, fx0, fx1) {
   const c = k.c, y0 = k.dk(x0) - 0.2;
   k.hs(x0, x1, hw, y0, h, { s: 0, col: c.white, top: k.c.white });
   k.hs(x1 - 5, x1 + 0.6, hw + 4, y0 + h - 3, 3, { s: 0, col: c.white, win: [0.35, 0.8], winEdges: [1, 7, 3] });   // bridge with wings
   k.mast((x0 + x1) / 2, y0 + h, 9, 0.5, 0.25, { col: c.white });
   k.yard((x0 + x1) / 2, y0 + h + 6, 5);
   k.spin('bar', (x0 + x1) / 2 + 1.5, y0 + h, 0, 4, 2.2);
   k.mastTop((x0 + x1) / 2, y0 + h + 9);
   k.funnel(fx0, fx1, 3.6, k.dk(fx0) - 0.2, h + 5, { col: c.white, rf: 0.6, ra: 0.3 });
   k.mast(k.h * 0.9, k.dk(k.h * 0.9), 11, 0.45, 0.2, { col: c.white });
}

export const MODELS = {
   // ================= West =================
   burke: {
      L: 155, B: 20, T: 6.3, D: 6.6, kind: 'ship', nation: 'us', pennant: '51', P: P({ sheer: 0.7, rake: 0.055 }),
      gunSlots: [{ style: 'mk45', x: 55 }],
      build(k) {
         const c = k.c;
         k.vls('vlsFore', 37, 46, 3.4, null, 32);
         const y1 = k.hs(2, 34, 8.8, null, 7.2, { cf: 4.6, ca: 3.6, rf: 1.5 });
         both(s => { k.arr(s > 0 ? 0 : 2, 0.6, 2.2); k.arr(s > 0 ? 6 : 4, 0.6, 2.2); });
         const y2 = k.hs(8, 30.5, 7.2, y1, 5, { cf: 4, ca: 3, rf: 1.6, s: 0.8, win: [0.52, 0.78] });
         k.ciws('phalanx', 31.5, y1, 0, 0);
         k.mast(15.5, y2, 19, 0.95, 0.3, { rake: 4.5 });
         k.mast(11.5, y2, 12, 0.5, 0.3, { rake: -1.5 });
         yards(k, 13, y2, 19, 5);
         k.spin('bar', 16.5, y2 + 1.2, 0, 3.4, 2.4);
         k.ball(13.5, y2 + 13.5, 0, 0.9, c.sup);
         k.mastTop(11, y2 + 19);
         const ym = k.hs(-16, 3, 8.4, null, 6.4, { ra: 1 });
         k.funnel(-10, 0, 3.7, ym, 9.5, { rf: 2.6, ra: 0.6 });
         both(s => k.ssm(-19.5, k.dk(-19.5) + 1.7, s * 2.6, s * 1.15, 0.42, 4, { rows: 2, len: 4.6, r: 0.36 }));
         const ya = k.hs(-53, -23, 8.4, null, 6.6, { ra: 0.8, rf: 1 });
         hangarDoor(k, -53 + 0.8 * 0.5, k.dk(-53), ya, 6);
         k.funnel(-33.5, -24.5, 3.7, ya, 8.2, { rf: 2.2, ra: 1.2 });
         k.vls('vlsAft', -45, -36, 3.4, ya - 0.1, 64);
         k.ciws('phalanx', -49.5, ya, 0, PI);
         both(s => k.decoy(5, k.dk(5), s * 9.2, s * 1.2));
         k.helo(-75, -54);
         k.num('51');
      },
   },
   tico: {
      L: 173, B: 16.8, T: 6.6, D: 7, kind: 'ship', nation: 'us', pennant: '62', P: P({ sheer: 0.8, rake: 0.05, tr: 0.6 }),
      gunSlots: [{ style: 'mk45', x: 69 }, { style: 'mk45', x: -72, aft: true }],
      build(k) {
         const c = k.c;
         k.vls('vlsFore', 49, 60, 3.2, null, 61);
         const y1 = k.hs(16, 45, 7.6, null, 12.5, { s: 0.5, cf: 1.2, ca: 1 });
         k.arr(1, 0.68, 2.3, 8, null, 0.68); k.arr(7, 0.68, 2.3, 8, null, 0.7);
         const y2 = k.hs(22, 44, 7.4, y1, 3.2, { s: 0.3, cf: 1, win: [0.35, 0.8] });
         k.mast(30, y2, 15, 0.8, 0.3, { rake: 1.5 }); yards(k, 29.5, y2, 15, 5);
         k.spin('bar', 33, y2 + 0.2, 0, 4, 2.2);
         k.mastTop(28.5, y2 + 15);
         const ym = k.hs(-26, 16, 7.4, null, 7.2, { s: 0.4 });
         k.funnel(1, 11, 3.6, ym, 9, { rf: 1.4, ra: 0.6 });
         k.funnel(-21, -11, 3.6, ym, 9, { rf: 1.4, ra: 0.6 });
         both(s => k.ciws('phalanx', -4, ym, s * 5.6, s * PI / 2));
         k.mast(-7, ym, 20, 0.8, 0.3, { rake: 1 }); yards(k, -7.5, ym, 20, 4.5);
         k.spin('slab', -30, ym + 5.3, 0, 6.5, 1.3);
         const ya = k.hs(-46, -26, 7.4, null, 12.3, { s: 0.5, cf: 1, ca: 1.2 });
         k.arr(5, 0.7, 2.3, 8, null, 0.32); k.arr(3, 0.7, 2.3, 8, null, 0.3);
         hangarDoor(k, -46.1, k.dk(-46), k.dk(-46) + 6.5, 5.5);
         both(s => k.decoy(20, y1, s * 6.4, s * 1.2));
         k.helo(-59, -46.5);
         k.vls('vlsAft', -67, -60, 3.2, null, 61);
         both(s => k.ssm(-82, k.dk(-82) + 1.6, s * 2.6, s * 2.1, 0.42, 4, { rows: 2, len: 4.6, r: 0.36 }));
         k.num('62');
      },
   },
   type45: {
      L: 152, B: 21.2, T: 6, D: 7.4, kind: 'ship', nation: 'uk', pennant: '32', P: P({ sheer: 0.45, flare: 1.16, tr: 0.7 }),
      gunSlots: [{ style: 'mk8', x: 53 }],
      build(k) {
         const c = k.c;
         const yv = k.hs(31, 46, 6.2, null, 2.4, { s: 0.5, cf: 2 });
         k.vls('vlsFore', 33.5, 44, 4.4, yv - 0.2, 48);
         const y1 = k.hs(6, 31, 9.6, null, 8, { cf: 4.5, ca: 2, rf: 1.5, s: 1.6 });
         const y2 = k.hs(11, 29, 7.4, y1, 4, { cf: 3.6, ca: 2, rf: 1.2, s: 1, win: [0.4, 0.78] });
         const yt = pyramid(k, 10, 23, 5.2, y2, 17, { taper: 0.62 });
         k.ball(16.5, yt + 2.3, 0, 2.9, c.sup);                     // Sampson
         k.mastTop(16.5, yt + 5.2);
         both(s => k.ciws('phalanx', 8, y1 - 2.5, s * 8.6, s * PI / 2));
         const ym = k.hs(-18, 6, 8.4, null, 6, { s: 1.2 });
         pyramid(k, -4, 3, 2.6, ym, 15, { taper: 0.55 });
         yards(k, -0.5, ym + 6, 9, 3.2);
         k.funnel(-15, -7, 3.4, ym, 10, { rf: 2.4, ra: 1.2, s: 1.2 });
         both(s => k.ssm(-21.5, k.dk(-21.5) + 1.8, s * 2.4, s * 1.25, 0.4, 4, { rows: 2, len: 4.6, r: 0.36 }));
         const ya = k.hs(-44, -25, 9, null, 8, { s: 1.5, rf: 1, ra: 0.5 });
         hangarDoor(k, -43.8, k.dk(-44), ya - 0.5, 6.5);
         pyramid(k, -36, -29, 3, ya, 5, { taper: 0.4 });
         k.spin('slab', -32.5, ya + 5, 0, 8.2, 1.25);              // S1850M
         both(s => k.decoy(-20, ym, s * 6.6, s * 1.3));
         k.helo(-73, -45);
         k.num('32');
      },
   },
   f124: {
      L: 143, B: 17.4, T: 5.6, D: 6.1, kind: 'ship', nation: 'de', pennant: '219', P: P({ sheer: 0.5, tr: 0.7 }),
      gunSlots: [{ style: 'oto76', x: 51 }],
      build(k) {
         const c = k.c;
         const yv = k.hs(32, 44, 5.4, null, 2.3, { s: 0.4, cf: 1.6 });
         k.vls('vlsFore', 34, 42, 3.6, yv - 0.2, 32);
         k.ciws('ram', 45.2, yv - 2.2 + 0.3, 0, 0);
         const y1 = k.hs(8, 32, 8, null, 7.4, { cf: 3.6, ca: 1.5, rf: 1.4, s: 1.3 });
         const y2 = k.hs(13, 30, 6.4, y1, 3.4, { cf: 3, rf: 1, s: 0.8, win: [0.4, 0.78] });
         const yt = k.hs(15, 22.5, 3.3, y2, 12.5, { s: 0.7, cf: 1.5, ca: 1.5 });      // APAR mast
         for (const i of [0, 2, 4, 6]) k.arr(i, 0.83, 1.45, 4, c.radar);
         k.mast(18.7, yt, 5, 0.4, 0.2); k.yard(18.7, yt + 2.2, 2.6);
         k.mastTop(18.7, yt + 5);
         both(s => k.ssm(1.5, k.dk(1.5) + 1.7, s * 1.9, s * PI / 2, 0.36, 4, { rows: 2, len: 4.6, r: 0.36 }));
         const ym = k.hs(-16, -3, 7.2, null, 6, { s: 1.1 });
         both(s => k.funnel(-13.5, -6.5, 1.9, ym, 7.5, { z: s * 3.6, rf: 1.6, ra: 0.4 }));
         both(s => k.decoy(-17.5, k.dk(-17.5), s * 6.6, s * 1.3));
         const ya = k.hs(-44, -19, 7.8, null, 7.4, { s: 1.3, rf: 1, ra: 0.4 });
         hangarDoor(k, -43.8, k.dk(-44), ya - 0.5, 5.6);
         pyramid(k, -27, -21, 2.6, ya, 5.5, { taper: 0.4 });
         k.spin('slab', -24, ya + 5.5, 0, 8.4, 1.25);              // SMART-L
         k.ciws('ram', -38, ya, 0, PI);
         k.helo(-69, -45);
         k.num('219');
      },
   },
   k130: {
      L: 89, B: 13.3, T: 3.6, D: 4.5, kind: 'ship', nation: 'de', pennant: '260', P: P({ sheer: 0.5, tr: 0.74, rake: 0.045 }),
      gunSlots: [{ style: 'oto76', x: 31 }],
      build(k) {
         const c = k.c;
         const ys = k.hs(21, 27, 3.6, null, 1.9, { s: 0.4, cf: 1.2 });
         k.ciws('ram', 24, ys, 0, 0);
         const y1 = k.hs(1, 21, 5.9, null, 6.6, { cf: 2.8, ca: 1.2, rf: 1.4, s: 1.2, win: [0.62, 0.84] });
         const yt = pyramid(k, 6, 13, 2.6, y1, 9.5, { taper: 0.6 });
         k.spin('slab', 9.5, yt, 0, 4.2, 1.8);                      // TRS-3D
         k.mast(11.5, yt, 4.5, 0.3, 0.15);
         k.mastTop(11.5, yt + 4.5);
         both(s => k.ssm(-6, k.dk(-6) + 1.6, s * 1.5, s * PI / 2, 0.3, 2, { len: 5, r: 0.45 }));   // RBS15
         const ym = k.hs(-23, -10, 5.2, null, 4.4, { s: 0.9, rf: 0.8, ra: 0.6 });
         pyramid(k, -19, -14, 1.6, ym, 6, { taper: 0.5 });
         k.ciws('ram', -21, ym, 0, PI);
         both(s => k.decoy(-12, ym, s * 3.6, s * 1.3));
         k.helo(-43.5, -25);
         k.num('260');
      },
   },
   ford: {
      L: 337, B: 41, T: 11, D: 18.6, kind: 'cv', nation: 'us', pennant: '78', P: CARRIER,
      build(k) {
         const c = k.c, yF = 19.6;
         k.flightDeck([[-168, -16, 18], [-152, -22, 30], [-112, -25, 37], [-62, -31, 39], [-22, -40, 38], [42, -40, 37], [72, -30, 31], [98, -21, 23], [142, -17.5, 17.5], [160, -14, 14], [167, -8, 8]], yF);
         deckStripes(k, yF, [-160, 4, 62, -28, 13], [[30, 8, 158, 8], [30, -8, 158, -8], [-60, -16, 56, -34], [-88, -6, 30, -26]]);
         const y1 = k.hs(-78, -58, 5.4, yF, 8, { z: 30, cf: 2, ca: 2, s: 0.8 });
         for (const i of [0, 2, 4, 6]) k.arr(i, 0.6, 1.9, 4);
         const y2 = k.hs(-76, -60, 4.6, y1, 5, { z: 30, cf: 2, ca: 1.5, s: 0.6, win: [0.3, 0.75], winEdges: [0, 1, 2, 3, 7] });
         const yt = k.mast(-68, y2, 18, 0.9, 0.4, { z: 30 });
         k.yard(-68, y2 + 9, 5); k.yard(-68, y2 + 13, 3.4);
         k.ball(-71.5, y2 + 2, 30, 1.7, c.sup);
         k.spin('bar', -64, y2, 30, 5, 2);
         k.mastTop(-68, yt, 30);
         k.ciws('phalanx', -160, yF - 4.8, -19.5, PI); k.ciws('phalanx', 120, yF - 4.8, 20.5, 0.6);
         k.ciws('ram', -150, yF - 4.8, 24, PI - 0.6); k.ciws('ram', 108, yF - 4.8, -21.5, -0.6);
         deckPark(k, [[70, 26, -2.4], [52, 31, -2.4], [34, 32, -2.4], [-104, 31, -0.9], [16, 32, -2.4], [-122, 30, -0.9], [-2, 32, -2.4], [-30, 33, -2.4], [100, 17, -2.6], [-140, 26, -0.9], [116, -12, 2.7], [132, -12, 2.7]]);
         k.deckNum('78', 138, 0, 9, yF + 0.1);
      },
   },
   u212: {
      L: 56, B: 7, T: 5.4, D: 1.5, kind: 'sub', nation: 'de', hullCol: 0x1b1d20, nose: 0.66, tail: -0.2,
      build(k) { subFit(k, { sail: [1, 10.5], sailW: 1.25, sailH: 5.4, sailPlanes: 3.6, x: true, casing: [-16, 20, 1.5], sailRf: 1.2 }); },
   },
   virginia: {
      L: 115, B: 10.4, T: 8.6, D: 2.1, kind: 'sub', nation: 'us', hullCol: 0x17191c, nose: 0.8, tail: -0.35,
      build(k) {
         subFit(k, { sail: [22, 30.5], sailW: 1.5, sailH: 5.6, rudder: 6.4, sailRf: 0.6 });
         k.anchor('vlsFore', { x: 38, y: 2.1, z: 0, l: 7, w: 5, cells: 12 });
         if (k.det >= 2) for (let i = 0; i < 6; i++) both(s => k.bx(35.4 + (i % 3) * 2.4, 37 + (i % 3) * 2.4, 2.0, 2.14, s * 0.5, s * 2.0, k.c.dark));
      },
   },

   // ================= East: Russia =================
   buyan: {
      L: 75, B: 11, T: 2.6, D: 3.9, kind: 'ship', nation: 'ru', pennant: '602', P: P({ sheer: 0.5, tr: 0.8, pb: 2.4 }),
      gunSlots: [{ style: 'a190', x: 24 }],
      build(k) {
         const c = k.c;
         const y1 = k.hs(-3, 16, 4.9, null, 5.2, { cf: 2.2, ca: 0.8, rf: 1.4, s: 1 });
         const y2 = k.hs(1, 14, 4, y1, 3, { cf: 1.8, rf: 1, s: 0.6, win: [0.38, 0.8] });
         const yt = pyramid(k, 3, 8.5, 2, y2, 7.5, { taper: 0.55 });
         k.spin('fregat', 5.7, yt, 0, 3.4, 1.9);
         k.ball(10.5, y2 + 1.1, 0, 1.2, c.sup);
         k.mastTop(5.7, yt + 3);
         const yv = k.hs(-14, -4, 4.2, null, 6.6, { s: 0.7, rf: 0.6, ra: 0.6 });      // UKSK block
         k.vls('vlsAft', -12.5, -5.5, 2.6, yv - 0.2, 8);
         both(s => k.decoy(-16, k.dk(-16), s * 3.4, s * 1.3));
         const ys = k.hs(-27, -20, 3.2, null, 2.2, { s: 0.4 });
         k.ciws('ak630', -23.5, ys, 0, PI);
         both(s => k.funnel(-19, -15, 0.9, k.dk(-17), 2.6, { z: s * 3.6, rf: 0.2, ra: 0.2 }));
         k.num('602');
      },
   },
   gorshkov: {
      L: 135, B: 16.4, T: 4.5, D: 6, kind: 'ship', nation: 'ru', pennant: '454', P: P({ sheer: 0.6, tr: 0.7 }),
      gunSlots: [{ style: 'a192', x: 49 }],
      build(k) {
         const c = k.c;
         const yv = k.hs(27, 43, 5.6, null, 2.6, { s: 0.5, cf: 1.6 });
         k.vls('vlsFore', 36.5, 42, 3.6, yv - 0.2, 32);            // Redut
         k.vls('vlsFore', 28.5, 35.5, 3.6, yv - 0.2, 16);          // UKSK
         const y1 = k.hs(2, 27, 7.6, null, 7.6, { cf: 3.4, ca: 1.5, rf: 1.4, s: 1.3 });
         const y2 = k.hs(6, 25, 6, y1, 3.3, { cf: 2.8, rf: 1, s: 0.8, win: [0.4, 0.78] });
         const yt = k.hs(8, 17, 4, y2, 12.5, { s: 1.6, cf: 2, ca: 2, rf: 0.8, ra: 0.8 });
         for (const i of [0, 2, 4, 6]) k.arr(i, 0.62, 1.5, 4, c.radar);          // Poliment
         k.spin('fregat', 12.5, yt, 0, 4.4, 1.7);
         k.mastTop(12.5, yt + 3.5);
         both(s => k.ciws('kashtan', -3, k.dk(-3) + 3, s * 6.2, s * PI / 2));    // Palash
         const ym = k.hs(-21, -1, 6.6, null, 6, { s: 1.1 });
         k.funnel(-17, -6, 3.6, ym, 9, { rf: 2, ra: 1, s: 1 });
         pyramid(k, -4.5, -0.5, 1.6, ym, 9, { taper: 0.5 });
         both(s => k.decoy(-22, k.dk(-22), s * 6.4, s * 1.3));
         const ya = k.hs(-41, -22, 7.4, null, 6.8, { s: 1.2, rf: 0.8, ra: 0.4 });
         hangarDoor(k, -40.8, k.dk(-41), ya - 0.5, 5.2);
         k.ball(-27, ya + 1.2, 0, 1.3, c.sup);
         k.helo(-65, -42);
         k.num('454');
      },
   },
   slava: {
      L: 186, B: 20.8, T: 7.6, D: 7, kind: 'ship', nation: 'ru', pennant: '121', P: P({ sheer: 0.85, rake: 0.06, tr: 0.62, flare: 1.25 }),
      gunSlots: [{ style: 'ak130', x: 73 }],
      build(k) {
         const c = k.c;
         const ys = k.hs(57, 66, 4.6, null, 2.4, { s: 0.4, cf: 1.4 });
         both(s => k.ciws('ak630', 62, ys, s * 2.4, s * 0.5));
         // sixteen P-1000 tubes: four pairs each side of the forward superstructure
         for (let i = 0; i < 4; i++) both(s => k.ssm(52 - i * 10.5, k.dk(52 - i * 10.5) + 3.4 + (i % 2) * 0.0, s * 7.4, s * 0.06, 0.2, 2, { len: 11.5, r: 1.0, col: shade3(c.hull, 0.86), base: k.dk(52 - i * 10.5) }));
         const y1 = k.hs(8, 50, 4.6, null, 9.5, { s: 0.5, cf: 1.6, ca: 1 });
         const y2 = k.hs(26, 46, 4.2, y1, 3.4, { s: 0.4, cf: 1.4, win: [0.35, 0.8] });
         const yt = pyramid(k, 14, 30, 4.4, y1, 17, { taper: 0.6 });
         k.spin('toppair', 22, yt, 0, 9, 1.0);
         k.ball(38, y2 + 1.6, 0, 1.7, c.sup);
         k.mastTop(22, yt + 4.5);
         const ym = k.hs(-42, 8, 8.2, null, 5.6, { s: 0.6 });
         both(s => k.ciws('ak630', -1, ym, s * 6.8, s * PI / 2));
         both(s => k.ciws('ak630', -6, ym, s * 6.8, s * PI / 2));
         const yt2 = pyramid(k, -18, -8, 3.2, ym, 15, { taper: 0.6 });
         k.spin('fregat', -13, yt2, 0, 6, 1.5);
         both(s => k.funnel(-36, -24, 2.9, ym, 9, { z: s * 3.6, rf: 2.2, ra: 0.8 }));
         both(s => k.decoy(4, ym, s * 6.6, s * 1.2));
         // S-300F rotary launchers
         const yv = Math.min(k.dk(-60), k.dk(-44)) + 0.25;
         k.vls('vlsAft', -60, -44, 5.2, null, 64);
         if (k.det >= 1) for (let i = 0; i < 4; i++) both(s => k.ring(-58 + i * 4, yv + 0.42, s * 2.6, 1.5, 0.3, c.mark));
         const ya = k.hs(-78, -62, 7.2, null, 7, { s: 0.8, rf: 0.6, ra: 0.4 });
         hangarDoor(k, -77.9, k.dk(-78), ya - 0.5, 4.6);
         k.hs(-71, -66, 2.2, ya, 3.6, { s: 0.3 });
         k.ball(-68.5, ya + 5.2, 0, 2.9, c.sup);                    // Top Dome
         k.helo(-92.5, -78.5);
         k.num('121', 0.8);
      },
   },
   kirovn: {
      L: 252, B: 28.5, T: 9.1, D: 9.2, kind: 'ship', nation: 'ru', pennant: '099', P: P({ sheer: 0.75, rake: 0.06, tr: 0.7, flare: 1.22, nMid: 5.5, qd: [-0.62, 0.3] }),
      gunSlots: [{ style: 'ak130', x: -92, aft: true }],
      build(k) {
         const c = k.c;
         k.vls('vlsFore', 84, 100, 5.4, null, 96);                 // S-300F
         k.vls('vlsFore', 56, 80, 7.4, null, 20);                  // Granit
         if (k.det >= 1) for (let i = 0; i < 5; i++) both(s => k.line(58.5 + i * 4.6, s * 1, 60.5 + i * 4.6, s * 6.4, 0.5, k.dk(68) + k.B * 0.006 + 0.42, c.mark));
         both(s => k.ciws('kashtan', 104, k.dk(104) + 0.2, s * 3.4, s * 0.4));
         const y1 = k.hs(-34, 46, 11.4, null, 8.6, { s: 1.4, cf: 4, ca: 2, rf: 1 });
         k.ball(42, y1 + 2.4, 0, 3.0, c.sup);                       // forward Top Dome
         const y2 = k.hs(12, 38, 8.4, y1, 7.5, { s: 1.2, cf: 3, ca: 2, rf: 1, win: [0.55, 0.8] });
         const yt = pyramid(k, 14, 31, 5.6, y2, 17, { taper: 0.62 });
         k.spin('toppair', 22.5, yt, 0, 11, 0.9);
         k.mastTop(22.5, yt + 5.5);
         k.funnel(-20, -2, 6.2, y1, 19, { rf: 5, ra: 2, s: 2.2 });  // mack
         both(s => k.ciws('ak630', 6, y1, s * 9.6, s * PI / 2));
         const yt2 = pyramid(k, -33, -23, 3.6, y1, 13, { taper: 0.6 });
         k.spin('fregat', -28, yt2, 0, 6.5, 1.4);
         const ya = k.hs(-72, -34, 10, null, 7, { s: 1.2, ra: 1 });
         k.ball(-44, ya + 2.4, 0, 3.0, c.sup);                      // aft Top Dome
         both(s => k.ciws('kashtan', -62, ya, s * 6.4, s * PI / 2));
         both(s => k.decoy(-52, ya, s * 7.6, s * 1.4));
         k.helo(-123, -102);
         k.num('099', 0.8);
      },
   },
   kuznetsov: {
      L: 305, B: 35, T: 10, D: 16.2, kind: 'cv', nation: 'ru', pennant: '063', P: { ...CARRIER, rake: 0.05 },
      build(k) {
         const c = k.c, yF = 17.2;
         const ramp = (x) => x > 92 ? (x - 92) * (x - 92) * 0.0023 : 0;
         k.flightDeck([[-151, -17, 17], [-140, -24, 30], [-100, -28, 34], [-42, -36, 35], [22, -36, 34], [46, -28, 33], [70, -22, 25], [92, -18.5, 19], [108, -18, 18], [122, -17.5, 17.5], [136, -16.5, 16.5], [148, -13, 13]], yF, ramp);
         deckStripes(k, yF, [-146, 5, 42, -24, 12], [[-20, 9, 146, 6, 1], [-20, -6, 146, -6, 1], [-110, -2, 146, 0, 1]]);
         k.vls('vlsFore', 62, 84, 6, yF - 0.22, 12);               // Granit silos in the deck
         const y1 = k.hs(-36, 8, 6, yF, 9, { z: 27.5, s: 0.8, cf: 2.5, ca: 2 });
         for (const i of [0, 2, 4, 6]) k.arr(i, 0.62, 2.1, 4, c.radar);
         const y2 = k.hs(-30, 4, 5, y1, 5.5, { z: 27.5, s: 0.6, cf: 2, ca: 1.5, win: [0.3, 0.72], winEdges: [0, 1, 2, 3, 7] });
         k.funnel(-27, -15, 3.6, y2, 7, { z: 27.5, rf: 3, ra: 1 });
         const yt = k.hs(-10, -1, 3, y2, 10, { z: 27.5, s: 1.4, cf: 1.5, ca: 1.5 });
         k.spin('fregat', -5.5, yt, 27.5, 7, 1.3);
         k.ball(-5.5, yt + 5.5, 27.5, 1.6, c.sup);
         k.mastTop(-5.5, yt + 7.2, 27.5);
         k.ciws('kashtan', -138, yF - 5, -21, PI - 0.7); k.ciws('kashtan', -138, yF - 5, 26, PI + 0.7);
         k.ciws('kashtan', 78, yF - 5, -21.5, -0.7); k.ciws('kashtan', 60, yF - 5, 29, 0.7);
         k.ciws('ak630', -120, yF - 5, -25.5, -PI / 2); k.ciws('ak630', 20, yF - 5, 34.5, PI / 2);
         deckPark(k, [[30, 28, -2.5], [-60, 29, -1.0], [46, 27, -2.5], [-78, 28, -1.0], [-96, 27, -1.0], [-112, 25, -1.0], [14, -30, 2.4], [-4, -31, 2.4]]);
         k.deckNum('063', 30, -12, 7, yF + 0.1);
      },
   },
   kilo: {
      L: 73.8, B: 9.9, T: 6.6, D: 2.0, kind: 'sub', nation: 'ru', hullCol: 0x1a1c1e, nose: 0.74, tail: -0.1,
      build(k) { subFit(k, { sail: [-3, 12], sailW: 1.7, sailH: 5.0, sailAft: 0.6, sailS: 0.1, sailRf: 0.2, bowPlanes: [22, 4.6], casing: [-26, 30, 2.2], rudder: 4.4 }); },
   },

   // ================= East: China =================
   type022: {
      L: 42.6, B: 12.2, T: 1.5, D: 3.4, kind: 'cat', nation: 'cn', pennant: '2208', camo: 5, hullCol: 0x9fb2c2,
      gunSlots: [{ style: 'ak630', x: 9.5, y: 3.5 }],
      build(k) {
         const c = k.c, b = k.b;
         // two slender wave-piercing hulls and the bridging deck
         for (const s of [1, -1]) {
            const z = s * 4.5;
            k.prism([[21, z], [12, z - 1.5], [-21.3, z - 1.5], [-21.3, z + 1.5], [12, z + 1.5]].map(p => [p[0] - (p[0] > 20 ? 3 : 0), z + (p[1] - z) * 0.55]),
               [[21, z], [12, z - 1.6], [-21.3, z - 1.6], [-21.3, z + 1.6], [12, z + 1.6]], -1.5, 1.7, c.hull, { band: 1, bottom: true });
         }
         k.prism([[16, 0], [8, -6.1], [-21.3, -6.1], [-21.3, 6.1], [8, 6.1]], [[13, 0], [7, -5.6], [-21.3, -5.6], [-21.3, 5.6], [7, 5.6]], 1.6, 3.4, c.hull, { band: 1, top: c.deck, bottom: true });
         const y1 = k.hs(-7, 7.5, 4.6, 3.3, 3.4, { cf: 2.4, ca: 1, rf: 1.6, s: 1.1, win: [0.5, 0.8] });
         const yt = pyramid(k, -4, 1, 1.5, y1, 5.5, { taper: 0.6 });
         k.spin('bar', -1.5, yt, 0, 2.4, 2.4);
         k.mastTop(-1.5, yt + 1.5);
         both(s => { k.hs(-20, -8, 2.3, 3.3, 3.4, { z: s * 3, s: 0.5, rf: 0.6, col: c.sup }); k.anchor('ssm', { x: -9, y: 5.4, z: s * 3, dir: 0, elev: 0.25, n: 4 }); });
         if (k.det >= 1) both(s => k.bx(-8.05, -7.9, 3.8, 6.2, s * 3 - 1.6, s * 3 + 1.6, c.dark));
         both(s => k.decoy(-5, y1, s * 3, s * 1.2));
      },
   },
   type054: {
      L: 134, B: 16, T: 5, D: 5.7, kind: 'ship', nation: 'cn', pennant: '530', P: P({ sheer: 0.55, tr: 0.7 }),
      gunSlots: [{ style: 'pj26', x: 49 }],
      build(k) {
         const c = k.c;
         k.vls('vlsFore', 34, 42, 3.6, null, 32);
         const ys = k.hs(27.5, 32.5, 3.6, null, 3.2, { s: 0.5, cf: 1.2 });
         k.ciws('t730', 30, ys, 0, 0);
         const y1 = k.hs(5, 27.5, 7.2, null, 7, { cf: 3.2, ca: 1.4, rf: 1.4, s: 1.2 });
         const y2 = k.hs(9, 25.5, 5.8, y1, 3.2, { cf: 2.6, rf: 1, s: 0.8, win: [0.4, 0.78] });
         const yt = pyramid(k, 10, 18, 2.8, y2, 12, { taper: 0.6 });
         k.spin('fregat', 14, yt, 0, 4.6, 1.6);                    // Type 382
         k.ball(21.5, y2 + 1.3, 0, 1.4, c.sup);
         k.mastTop(14, yt + 3.6);
         both(s => k.ssm(-3, k.dk(-3) + 1.7, s * 1.9, s * PI / 2, 0.34, 4, { rows: 2, len: 5.2, r: 0.38 }));   // YJ-83
         const ym = k.hs(-20, -7, 6.6, null, 5.6, { s: 1 });
         k.funnel(-17.5, -9.5, 3.2, ym, 8.5, { rf: 2, ra: 0.8, s: 1 });
         both(s => k.decoy(-21.5, k.dk(-21.5), s * 6, s * 1.3));
         const ya = k.hs(-43, -23, 7.2, null, 7, { s: 1.2, rf: 0.8, ra: 0.4 });
         hangarDoor(k, -42.8, k.dk(-43), ya - 0.5, 5);
         k.spin('slab', -27, ya, 0, 4.6, 1.4);
         k.ciws('t730', -37, ya, 0, PI);
         k.helo(-64.5, -44);
         k.num('530');
      },
   },
   type052d: {
      L: 157, B: 17, T: 6, D: 6.6, kind: 'ship', nation: 'cn', pennant: '172', P: P({ sheer: 0.6, tr: 0.7 }),
      gunSlots: [{ style: 'pj38', x: 59 }],
      build(k) {
         const c = k.c;
         k.vls('vlsFore', 40, 51, 3.6, null, 32);
         const ys = k.hs(33, 38, 3.8, null, 3.4, { s: 0.5, cf: 1.2 });
         k.ciws('t730', 35.5, ys, 0, 0);
         const y1 = k.hs(6, 33, 8, null, 8.4, { cf: 4.6, ca: 4, rf: 1.6, s: 1.3 });
         for (const i of [0, 2, 4, 6]) k.arr(i, 0.58, 2.7, 4, shade3(c.sup, 0.8));   // Type 346A
         const y2 = k.hs(12, 29, 6.2, y1, 3.6, { cf: 3.4, ca: 2, rf: 1.2, s: 0.8, win: [0.4, 0.78] });
         const yt = pyramid(k, 13, 21, 3, y2, 12.5, { taper: 0.62 });
         k.ball(17, yt + 1.2, 0, 1.5, c.sup);
         yards(k, 17, y2 + 4, 9, 3.6);
         k.mastTop(17, yt + 2.8);
         const ym = k.hs(-20, 6, 7.2, null, 6, { s: 1.1 });
         k.funnel(-10, 1, 3.6, ym, 10, { rf: 2.6, ra: 1.2, s: 1.1 });
         k.spin('slab', -16, ym, 0, 7.5, 1.1);                     // Type 517
         both(s => k.decoy(-19, ym, s * 5.4, s * 1.3));
         k.vls('vlsAft', -32.5, -22, 3.6, null, 32);
         const ya = k.hs(-54, -34, 7.6, null, 7.2, { s: 1.2, rf: 0.8, ra: 0.4 });
         hangarDoor(k, -53.8, k.dk(-54), ya - 0.5, 5.4);
         k.ciws('hq10', -48, ya, 0, PI);
         k.helo(-77, -55);
         k.num('172');
      },
   },
   type055: {
      L: 180, B: 20, T: 6.6, D: 7.2, kind: 'ship', nation: 'cn', pennant: '101', P: P({ sheer: 0.55, tr: 0.72, flare: 1.16 }),
      gunSlots: [{ style: 'pj38', x: 69 }],
      build(k) {
         const c = k.c;
         k.vls('vlsFore', 46, 61, 4.6, null, 64);
         const ys = k.hs(39, 44, 4, null, 3.6, { s: 0.5, cf: 1.2 });
         k.ciws('t730', 41.5, ys, 0, 0);
         const y1 = k.hs(4, 39, 9.6, null, 9.2, { cf: 5.4, ca: 4.6, rf: 1.8, s: 1.6 });
         for (const i of [0, 2, 4, 6]) k.arr(i, 0.58, 3.1, 4, shade3(c.sup, 0.8));   // Type 346B
         const y2 = k.hs(10, 34, 7.4, y1, 4.4, { cf: 4, ca: 2.4, rf: 1.4, s: 1, win: [0.42, 0.76] });
         const yt = k.hs(13, 23, 3.6, y2, 15, { s: 1.5, cf: 1.8, ca: 1.8, rf: 1.2, ra: 1.2 });   // integrated mast
         for (const i of [0, 2, 4, 6]) k.arr(i, 0.55, 1.2, 4, c.radar);
         k.mast(18, yt, 3.5, 0.5, 0.25);
         k.mastTop(18, yt + 3.5);
         const ym = k.hs(-28, 4, 8.8, null, 7, { s: 1.4 });
         k.funnel(-24, -8, 5.6, ym, 9.5, { rf: 4, ra: 2, s: 1.8 });
         both(s => k.decoy(-2, ym, s * 6.6, s * 1.3));
         k.vls('vlsAft', -41, -29.5, 4.6, null, 48);
         const ya = k.hs(-64, -42.5, 8.8, null, 7.8, { s: 1.4, rf: 0.8, ra: 0.4 });
         hangarDoor(k, -63.8, k.dk(-64), ya - 0.5, 6.6);
         k.ciws('hq10', -56, ya, 0, PI);
         k.helo(-89, -65);
         k.num('101');
      },
   },
   shandong: {
      L: 305, B: 37.5, T: 10, D: 16.5, kind: 'cv', nation: 'cn', pennant: '17', P: { ...CARRIER, rake: 0.05 },
      build(k) {
         const c = k.c, yF = 17.5;
         const ramp = (x) => x > 94 ? (x - 94) * (x - 94) * 0.0021 : 0;
         k.flightDeck([[-151, -18, 18], [-140, -25, 31], [-100, -29, 36], [-42, -37.5, 37], [22, -37.5, 36], [46, -29, 34], [70, -23, 26], [94, -19, 19.5], [110, -18.5, 18.5], [124, -18, 18], [138, -17, 17], [149, -13, 13]], yF, ramp);
         deckStripes(k, yF, [-146, 5, 42, -25, 12.5], [[-16, 9, 147, 6, 1], [-16, -6, 147, -6, 1], [-110, -2, 147, 0, 1]]);
         const y1 = k.hs(-24, 6, 5.6, yF, 8.5, { z: 29, s: 0.8, cf: 2.4, ca: 2 });
         const y2 = k.hs(-20, 3, 4.8, y1, 6.5, { z: 29, s: 0.7, cf: 2.4, ca: 2.4, win: [0.15, 0.45], winEdges: [0, 1, 2, 3, 7] });
         for (const i of [0, 2, 4, 6]) k.arr(i, 0.72, 1.9, 4, shade3(c.sup, 0.8));   // Type 346
         k.funnel(-17, -9, 2.8, y2, 5.5, { z: 29, rf: 2, ra: 0.6 });
         const yt = pyramid(k, -6, 1, 2.2, y2, 9, { z: 29, taper: 0.6 });
         k.spin('fregat', -2.5, yt, 29, 5.6, 1.4);
         k.mastTop(-2.5, yt + 3.6, 29);
         k.ciws('t730', -140, yF - 5, -22, PI - 0.7); k.ciws('t730', -140, yF - 5, 27, PI + 0.7); k.ciws('t730', 70, yF - 5, -21.5, -0.7);
         k.ciws('hq10', 62, yF - 5, 29.5, 0.7); k.ciws('hq10', -124, yF - 5, -26.5, PI - 0.8);
         deckPark(k, [[32, 29, -2.5], [-52, 30, -1.0], [48, 28, -2.5], [-70, 29, -1.0], [-88, 28, -1.0], [-106, 26, -1.0], [14, -31, 2.4], [-4, -32, 2.4]]);
         k.deckNum('17', 30, -12, 7, yF + 0.1);
      },
   },
   yuan: {
      L: 77.6, B: 8.4, T: 6.3, D: 1.9, kind: 'sub', nation: 'cn', hullCol: 0x191b1e, nose: 0.76, tail: -0.2,
      build(k) {
         subFit(k, { sail: [4, 16], sailW: 1.5, sailH: 5.6, sailPlanes: 4.2, planeX: 1.5, rudder: 5.0, sailRf: 0.8 });
         k.hs(14.5, 21, 1.3, 1.4, 2.4, { band: 0, col: k.c.hull, top: k.c.hull, cf: 1.2, s: 0.6, rf: 4 });   // fairing at the foot of the fin
      },
   },

   // ================= East: Iran =================
   fac: {
      L: 13, B: 2.9, T: 0.6, D: 1.0, kind: 'boat', nation: 'ir', hullCol: 0x6f7a78,
      gunSlots: [{ style: 'mg', x: 3.4, y: 1.0 }],
      build(k) {
         const c = k.c;
         k.prism([[6.5, 0], [2.5, -1.0], [-6.5, -1.0], [-6.5, 1.0], [2.5, 1.0]], [[6.5, 0], [2, -1.45], [-6.5, -1.4], [-6.5, 1.4], [2, 1.45]], -0.55, 1.0, c.hull, { band: 1, top: c.deck, bottom: true });
         k.hs(-1.6, 0.8, 0.95, 0.95, 1.25, { s: 0.15, rf: 0.5, col: c.sup, win: [0.5, 0.95] });        // console + windscreen
         k.b.band = 0;
         k.b.put(k.boxGeo(2.4, 0.9, 1.5), -3.6, 1.9, 0, c.dark, 0, 0, 0.3);                           // 107 mm rocket launcher
         k.bx(-3.9, -3.3, 1.0, 1.6, -0.2, 0.2, c.dark);
         k.anchor('ssm', { x: -3.6, y: 2.0, z: 0, dir: 0, elev: 0.3, n: 12 });
         both(s => k.bx(-7.0, -6.4, 0.2, 1.5, s * 0.75 - 0.25, s * 0.75 + 0.25, c.black));               // outboards
         k.mast(-1.2, 2.2, 1.6, 0.05, 0.04, { col: c.dark, seg: 4 });
         k.mastTop(-1.2, 3.8);
      },
   },
   moudge: {
      L: 95, B: 11.1, T: 3.3, D: 4.4, kind: 'ship', nation: 'ir', pennant: '76', P: P({ sheer: 0.75, tr: 0.6, flare: 1.22, fc: true, fcH: 0.3, fcU: -0.25 }),
      gunSlots: [{ style: 'oto76', x: 33 }],
      build(k) {
         const c = k.c;
         const y1 = k.hs(6, 24, 4.6, null, 5.2, { s: 0.3, cf: 1.4, ca: 0.6, rf: 0.6 });
         const y2 = k.hs(12, 23, 4.2, y1, 2.8, { s: 0.3, cf: 1.2, rf: 0.6, win: [0.38, 0.8] });
         k.ball(17, y2 + 1.2, 0, 1.3, c.white);
         const yt = k.mast(10, y1, 13, 0.7, 0.25, { rake: 1 }); yards(k, 9.6, y1, 13, 3.4);
         k.spin('bar', 12.5, y2, 0, 3, 2.2);
         k.mastTop(9, yt);
         const ym = k.hs(-14, 6, 4.4, null, 3.2, { s: 0.3 });
         k.funnel(-8, -1, 2.4, ym, 6.5, { rf: 1.2, ra: 0.4 });
         both(s => k.ssm(-18.5, k.dk(-18.5) + 1.6, s * 1.6, s * PI / 2, 0.3, 2, { len: 5.6, r: 0.42 }));   // Noor
         const ya = k.hs(-31, -22, 4.2, null, 3.2, { s: 0.3 });
         k.ciws('ak630', -27, ya, 0, PI);
         both(s => k.decoy(-15, k.dk(-15), s * 4, s * 1.3));
         k.helo(-46, -32.5);
         k.num('76');
      },
   },
   ghadir: {
      L: 29, B: 3, T: 2.6, D: 0.8, kind: 'sub', nation: 'ir', hullCol: 0x2c3438, nose: 0.7, tail: -0.1,
      build(k) { subFit(k, { sail: [0.5, 5], sailW: 0.62, sailH: 2.8, peri: 2.6, sailRf: 0.3, rudder: 1.9, casing: [-9, 10, 0.7] }); },
   },

   // ================= neutral merchants =================
   tanker: {
      L: 250, B: 44, T: 12, D: 7, kind: 'merchant', hullCol: 0x1b1c1f, deckCol: 0x7a3a2b, P: MERCHANT,
      build(k) {
         const c = k.c, y = k.dk(0) + 0.5;
         k.bx(-84, 100, y + 1.2, y + 2.4, -1.6, 1.6, c.mark);        // pipe rack along the centreline
         if (k.det >= 1) for (let i = 0; i < 9; i++) k.bx(-80 + i * 22, -79 + i * 22, y, y + 1.3, -2, 2, c.dark);
         k.bx(2, 8, y + 0.6, y + 2.8, -15, 15, c.mark);              // cargo manifold
         both(s => { k.mast(5, y, 13, 0.6, 0.4, { z: s * 6, col: c.yellow }); k.mast(5, y + 12.5, 12, 0.3, 0.2, { z: s * 6, rake: -9, col: c.yellow }); });
         if (k.det >= 1) for (let i = 0; i < 6; i++) both(s => k.bx(-70 + i * 30, -68.5 + i * 30, y - 0.3, y + 0.9, s * 11 - 0.8, s * 11 + 0.8, c.mark));   // tank hatches
         merchantHouse(k, -113, -92, 17, 17, -122, -114);
      },
   },
   container: {
      L: 300, B: 40, T: 12, D: 9, kind: 'merchant', hullCol: 0x1d2a3d, deckCol: 0x5a5f63, P: { ...MERCHANT, pb: 1.7, flare: 1.08, rake: 0.035 },
      build(k) {
         const c = k.c;
         const COLS = [0x8a2a22, 0x1f4f7a, 0x2f6b3e, 0xb5622a, 0x8c8f92, 0x6b1f2a, 0xc2beb1, 0x23364d].map(k.lin);
         const pick = () => COLS[Math.floor(k.rnd() * COLS.length)];
         const bay = (x0) => {
            const xm = x0 + 6.2, hw = Math.min(k.hw(x0), k.hw(x0 + 12.4)) - 1.2, tiers = 4 + Math.floor(k.rnd() * 4);
            const n = k.det >= 2 ? 4 : k.det >= 1 ? 2 : 1;
            for (let i = 0; i < n; i++) {
               const z0 = -hw + (2 * hw) * i / n, z1 = -hw + (2 * hw) * (i + 1) / n, t = Math.max(2, tiers - Math.floor(k.rnd() * 2.2));
               k.bx(x0, x0 + 12.4, k.dk(xm) - 0.1, k.dk(xm) + t * 2.6, z0 + 0.1, z1 - 0.1, pick());
            }
         };
         for (let x = -86; x < 124; x += 13.6) bay(x);
         for (let x = -146; x < -124; x += 13.6) bay(x);
         merchantHouse(k, -104, -91, 18, 31, -121, -113);
      },
   },
   lng: {
      L: 290, B: 46, T: 11.5, D: 8.5, kind: 'merchant', hullCol: 0x7a2a22, deckCol: 0x6a6f72, P: MERCHANT,
      build(k) {
         const c = k.c, y = k.dk(0);
         for (let i = 0; i < 4; i++) {
            const x = -72 + i * 44;
            k.ball(x, y, 0, 19, c.white, true);
            k.bx(x - 2, x + 2, y + 18, y + 20.6, -2, 2, c.mark);
         }
         k.bx(-92, 82, y + 18.8, y + 19.5, -1, 1, c.mark);             // catwalk over the tank domes
         merchantHouse(k, -129, -110, 19, 21, -138, -130);
      },
   },
};

function shade3(rgb, f) { return [rgb[0] * f, rgb[1] * f, rgb[2] * f]; }
