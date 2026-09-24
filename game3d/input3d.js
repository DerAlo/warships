// game3d/input3d.js — raw keyboard/mouse state for the WoWs-style 3D controls.
// This module only REPORTS input (held keys, edge taps, mouse deltas, wheel notches); every
// gameplay decision (telegraph stepping, hold-repeat, zoom levels, firing) lives in main3d.js.
//
// Key names are normalised to short ids ('W', 'SHIFT', 'TAB', '1', ...). Letters are read from
// e.key (layout-aware) so a German QWERTZ keyboard's printed "Y" really is the Y action --
// by physical code it would be KeyZ. Digits and special keys use e.code (Shift+1 = '!').
const GAME_KEYS = new Set(['W', 'A', 'S', 'D', 'Q', 'E', 'C', 'X', 'L', 'M', 'R', 'T', 'Y', 'U', 'H',
   '1', '2', '3', '4', 'P', 'SHIFT', 'TAB', 'SPACE', 'CTRL']);

export class Input3D {
   constructor(canvas) {
      this.canvas = canvas;
      this._active = false;      // gameActive (accessor below): main3d sets it; gates preventDefault,
                                 // pointer lock requests and the battle wheel listener
      this.wheelGate = null;     // optional (event) => bool from main3d: may the wheel zoom now?
      this.keys = new Set();     // currently held
      this.pressed = new Map();  // key -> press count since the last consumeTaps()/endFrame()
                                 // (counted: at low frame rates several taps land in one frame)
      // dx/dy: raw movementX/Y summed since endFrame(). down: LMB (fire). right: RMB (free look).
      // wheel: notches (+ = scroll toward the user = zoom out), fractional for touchpads.
      this.mouse = { dx: 0, dy: 0, down: false, right: false, wheel: 0, clicked: false };
      this.locked = false;
      this._hadLock = false;
      this.onLockLost = null;    // callback: pointer lock dropped (Esc / alt-tab) while playing
      this._bind();
   }

   _bind() {
      const onKey = (e, down) => {
         const k = this._norm(e);
         if (!k) return;
         if (down) { if (!this.keys.has(k)) this.pressed.set(k, (this.pressed.get(k) || 0) + 1); this.keys.add(k); }
         else this.keys.delete(k);
         // Tab would move focus away from the canvas; Space/arrows would scroll the page.
         if ((this.gameActive && GAME_KEYS.has(k)) || k === 'TAB') e.preventDefault();
      };
      window.addEventListener('keydown', (e) => onKey(e, true));
      window.addEventListener('keyup', (e) => onKey(e, false));
      window.addEventListener('blur', () => {
         this.keys.clear(); this.pressed.clear(); this.mouse.down = false; this.mouse.right = false;
      });

      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      document.addEventListener('pointerlockchange', () => {
         const now = document.pointerLockElement === this.canvas;
         if (this.locked && !now && this._hadLock && this.gameActive && this.onLockLost) this.onLockLost();
         this.locked = now;
         if (now) this._hadLock = true;
      });
      // Rejections (no user gesture, headless runners) are expected: deltas still arrive.
      document.addEventListener('pointerlockerror', () => {});

      this.canvas.addEventListener('mousedown', (e) => {
         if (e.button === 0) { this.mouse.down = true; this.mouse.clicked = true; }
         if (e.button === 2) this.mouse.right = true;
         this.requestLock();
      });
      window.addEventListener('mouseup', (e) => {
         if (e.button === 0) this.mouse.down = false;
         if (e.button === 2) this.mouse.right = false;
      });
      window.addEventListener('mousemove', (e) => {
         const mx = e.movementX || 0, my = e.movementY || 0;
         // Some browsers emit one garbage delta of thousands of px when pointer lock engages;
         // drop it rather than spin the camera. Real coalesced moves stay far below this.
         if (Math.abs(mx) > 1500 || Math.abs(my) > 1500) return;
         this.mouse.dx += mx;
         this.mouse.dy += my;
      });
      // Wheel = zoom ladder. On window (not the canvas) so it also works over HUD panels and
      // without pointer lock, but only attached while a battle runs (see gameActive): menus keep
      // compositor-fast native scrolling. wheelGate (main3d) vetoes map/overlays -> no preventDefault.
      this._onWheel = (e) => {
         if (this.wheelGate && !this.wheelGate(e)) return;
         e.preventDefault();          // also stops Ctrl+wheel / pinch page zoom mid-battle
         // Normalise the three deltaModes to "notches": a classic wheel click is ~100px or 3 lines.
         let d = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaMode === 2 ? e.deltaY : e.deltaY / 100;
         // A detented click reads 100-133 px depending on OS scaling (and Chrome coalesces clicks
         // on slow frames): snap to whole clicks so one click is one zoom step. Touchpad deltas
         // stay fractional.
         if (Math.abs(d) >= 0.5) d = Math.sign(d) * Math.max(1, Math.round(Math.abs(d) - 0.1));
         this.mouse.wheel += Math.max(-4, Math.min(4, d));
      };
   }

   get gameActive() { return this._active; }
   set gameActive(on) {
      on = !!on;
      if (on === this._active) return;
      this._active = on;
      if (on) window.addEventListener('wheel', this._onWheel, { passive: false });
      else { window.removeEventListener('wheel', this._onWheel); this.mouse.wheel = 0; }
   }

   requestLock() {
      if (!this.gameActive || document.pointerLockElement === this.canvas) return;
      try {
         const ret = this.canvas.requestPointerLock({ unadjustedMovement: true });
         if (ret && typeof ret.catch === 'function') {
            // unadjustedMovement is unsupported on some platforms -- retry without it.
            ret.catch(() => {
               try {
                  const r2 = this.canvas.requestPointerLock();
                  if (r2 && typeof r2.catch === 'function') r2.catch(() => {});
               } catch (err) { /* ignore */ }
            });
         }
      } catch (err) { /* older browsers throw synchronously */ }
   }

   releaseLock() {
      this._hadLock = false; // an intentional release must not trigger the pause callback
      if (document.pointerLockElement === this.canvas) {
         try { document.exitPointerLock(); } catch (err) { /* ignore */ }
      }
   }

   _norm(e) {
      const code = e.code || '', key = e.key || '';
      switch (code) {
         case 'ShiftLeft': case 'ShiftRight': return 'SHIFT';
         case 'ControlLeft': case 'ControlRight': return 'CTRL';
         case 'Tab': return 'TAB';
         case 'Space': return 'SPACE';
         case 'Escape': return 'P';
         case 'ArrowUp': return 'W';
         case 'ArrowDown': return 'S';
         case 'ArrowLeft': return 'A';
         case 'ArrowRight': return 'D';
         case 'Digit1': case 'Numpad1': return '1';
         case 'Digit2': case 'Numpad2': return '2';
         case 'Digit3': case 'Numpad3': return '3';
         case 'Digit4': case 'Numpad4': return '4';
         default: break;
      }
      if (key.length === 1) {
         const k = key.toUpperCase();
         if (k >= 'A' && k <= 'Z') return k;
      }
      // Fallback for synthetic events without e.key: physical code.
      if (code.startsWith('Key')) return code.slice(3);
      return key ? key.toUpperCase() : null;
   }

   // Edge taps are consumed once per fixed sim step so a key fires exactly once even on a
   // multi-step frame; endFrame() additionally clears the per-frame mouse accumulators.
   consumeTaps() { this.pressed.clear(); this.mouse.clicked = false; }
   endFrame() { this.consumeTaps(); this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0; }

   down(k) { return this.keys.has(k); }
   tapped(k) { return this.pressed.get(k) || 0; }   // count (0 = not tapped)
}
