// game/input.js — keyboard + mouse state, edge detection, and a command bus.
// Keystrokes are polled each tick; edge-triggered actions are queued as "pressed" flags.
import { clamp } from './utils.js';

export class Input {
   constructor(canvas) {
      this.canvas = canvas;
      this.gameActive = false;   // set by main.js while playing — gates preventDefault so menu buttons stay keyboard-reachable
      this.keys = new Set();
      this.pressed = new Set();       // edge: went down since last poll
      this.released = new Set();      // edge: went up since last poll (T = release to launch)
      this.mouse = { x: 0, y: 0, down: false, right: false, leftPressed: false, rightPressed: false, moved: false };
      this._bind();
      this._poll = false;
   }

   _bind() {
      const onKey = (e, down) => {
         const k = this._norm(e.key, e.code);
         if (down) {
            if (!this.keys.has(k)) this.pressed.add(k);
            this.keys.add(k);
         } else {
            if (this.keys.has(k)) this.released.add(k);
            this.keys.delete(k);
         }
         // prevent page scroll / context menu during play only — in menus, keys must still activate buttons
         if (this.gameActive && [' ', 'w','a','s','d','q','e','r','t','f','p','1','2','c','g','escape','shift'].includes((e.key||'').toLowerCase()))
            e.preventDefault();
      };
      window.addEventListener('keydown', (e) => onKey(e, true));
      window.addEventListener('keyup', (e) => onKey(e, false));
      window.addEventListener('blur', () => { this.keys.clear(); this.mouse.down = false; this.mouse.right = false; });

      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      const toXY = (e) => {
         const r = this.canvas.getBoundingClientRect();
         // CSS pixels — cam.s2w() expects them. Scaling by canvas.width/r.width
         // would multiply by devicePixelRatio and shift the aim point on HiDPI.
         this.mouse.x = e.clientX - r.left;
         this.mouse.y = e.clientY - r.top;
         this.mouse.moved = true;
      };
      this.canvas.addEventListener('mousemove', toXY);
      this.canvas.addEventListener('mousedown', (e) => {
         toXY(e);
         if (e.button === 0) { this.mouse.down = true; this.mouse.leftPressed = true; }
         if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
      });
      window.addEventListener('mouseup', (e) => {
         if (e.button === 0) this.mouse.down = false;
         if (e.button === 2) this.mouse.right = false;
      });
      // Touch: tap to fire toward tap point
      this.canvas.addEventListener('touchstart', (e) => {
         const t = e.touches[0]; const r = this.canvas.getBoundingClientRect();
         this.mouse.x = t.clientX - r.left;
         this.mouse.y = t.clientY - r.top;
         this.mouse.down = true; this.mouse.leftPressed = true;
      }, { passive: true });
      this.canvas.addEventListener('touchend', () => { this.mouse.down = false; });
   }

   _norm(key, code) {
      // Map a few keys to canonical tokens used by the controller.
      if (code) {
         if (code === 'KeyW') return 'W';
         if (code === 'KeyA') return 'A';
         if (code === 'KeyD') return 'D';
         if (code === 'KeyS') return 'S';
         if (code === 'KeyQ') return 'Q';
         if (code === 'KeyE') return 'E';
         if (code === 'KeyF') return 'F';
         if (code === 'KeyT') return 'T';
         if (code === 'KeyR') return 'R';
         if (code === 'KeyC') return 'C';
         if (code === 'KeyG') return 'G';
         if (code === 'Digit1' || code === 'Numpad1') return '1';
         if (code === 'Digit2' || code === 'Numpad2') return '2';
         if (code === 'KeyP' || code === 'Escape') return 'P';
         if (code === 'ShiftLeft' || code === 'ShiftRight') return 'SHIFT';
         if (code === 'Space') return 'SPACE';
         if (code === 'ArrowUp') return 'W';
         if (code === 'ArrowDown') return 'S';
         if (code === 'ArrowLeft') return 'A';
         if (code === 'ArrowRight') return 'D';
      }
      return key.toUpperCase();
   }

   // Called once per tick BEFORE reading; consumes edges.
   endFrame() { this.pressed.clear(); this.released.clear(); this.mouse.leftPressed = false; this.mouse.rightPressed = false; this.mouse.moved = false; }

   down(k) { return this.keys.has(k); }
   tapped(k) { return this.pressed.has(k); }
   releasedKey(k) { return this.released.has(k); }
   // helm: A = port, D = starboard (Q/E are weapon/consumable keys now)
   helmAxis() {
      let h = 0;
      if (this.down('A')) h -= 1;
      if (this.down('D')) h += 1;
      return h;
   }
   // throttle: W = ahead(+1), S = astern(-1)
   throttleAxis() {
      let t = 0;
      if (this.down('W')) t += 1;
      if (this.down('S')) t -= 1;
      return t;
   }
}
