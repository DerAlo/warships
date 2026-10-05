// Squadron fixtures for the V2 aircraft preview / tests: one of every airframe, in a line along x
// at 150 m, flying toward +x (so a camera on +z sees them from starboard).
const mk = (i, o) => ({ id: i + 1, n: 1, visible: true, pos: { x: i * 22, y: 0 }, alt: 150, heading: 0, speed: 0, armed: 1, ...o });
export function airFixtures() {
   return [
      mk(0, { kind: 'strike', nation: 'us' }),          // F/A-18E
      mk(1, { kind: 'fighter', nation: 'us' }),         // F-35C
      mk(2, { kind: 'fighter', nation: 'ru' }),         // Su-33
      mk(3, { kind: 'strike', nation: 'ru' }),          // MiG-29K
      mk(4, { kind: 'strike', nation: 'cn' }),          // J-15
      mk(5, { kind: 'helo', nation: 'de' }),            // ship helicopter
   ];
}
