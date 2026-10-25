// tests/savegame.test.mjs -- save file export/import (game3d/savegame.js == gamev2/savegame.js) and
// the port cheat maxOutProfile (progress3d.js, V1 and V2).
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as SG from '../game3d/savegame.js';
import * as P1 from '../game3d/progress3d.js';
import * as P2 from '../gamev2/progress3d.js';

function memStore(init = {}) {
   const m = new Map(Object.entries(init));
   return {
      get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
      getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m,
   };
}

test('savegame: V1 and V2 copies are identical', () => {
   assert.strictEqual(readFileSync('gamev2/savegame.js', 'utf8'), readFileSync('game3d/savegame.js', 'utf8'));
});

test('savegame: export carries both variants, nothing else', () => {
   const st = memStore({ 'warships3d.profile.v1': '{"xp":5}', 'warshipsv2.progress.v1': '{"missions":{}}', 'ks3d.gfx': 'high', other: '1' });
   const j = JSON.parse(SG.exportSave(st, new Date('2026-10-25T10:00:00Z')));
   assert.strictEqual(j.app, SG.SAVE_APP);
   assert.deepStrictEqual(Object.keys(j.data).sort(), ['warships3d.profile.v1', 'warshipsv2.progress.v1']);
   assert.strictEqual(SG.saveFileName(new Date(2026, 9, 5)), 'kriegsschiffe-speicherstand-2026-10-05.json');
});

test('savegame: import replaces the career, keeps foreign keys, round-trips', () => {
   const src = memStore({ 'warships3d.profile.v1': '{"xp":5}', 'warshipsv2.settings.v1': '{"a":1}' });
   const text = SG.exportSave(src);
   const dst = memStore({ 'warships3d.profile.v1': '{"xp":999}', 'warships3d.progress.v1': '{}', 'ks3d.gfx': 'low' });
   const r = SG.importSave(text, dst);
   assert.ok(r.ok && r.count === 2, JSON.stringify(r));
   assert.strictEqual(dst.getItem('warships3d.profile.v1'), '{"xp":5}');
   assert.strictEqual(dst.getItem('warships3d.progress.v1'), null, 'entries missing from the file are removed');
   assert.strictEqual(dst.getItem('ks3d.gfx'), 'low', 'graphics preset stays');
   assert.strictEqual(dst.getItem('warshipsv2.settings.v1'), '{"a":1}');
});

test('savegame: bad files are refused and change nothing', () => {
   const dst = memStore({ 'warships3d.profile.v1': '{"xp":7}' });
   for (const bad of ['', 'nope', '[]', '{"app":"x","data":{}}', JSON.stringify({ app: SG.SAVE_APP, data: { evil: '{}', 'warships3d.x': 'not json' } })]) {
      const r = SG.importSave(bad, dst);
      assert.ok(!r.ok && typeof r.error === 'string', bad);
   }
   assert.strictEqual(dst.getItem('warships3d.profile.v1'), '{"xp":7}');
   assert.ok(!SG.importSave(SG.exportSave(memStore({ 'warships3d.a': '1' })), null).ok, 'no storage');
});

for (const [name, P] of [['V1', P1], ['V2', P2]]) {
   test(`maxOutProfile ${name}: everything researched, maxed, courses learned, survives a reload`, () => {
      const p = P.maxOutProfile(P.defaultProfile(), ['Extra']);
      const q = P.sanitizeProfile(JSON.parse(JSON.stringify(p)));
      for (const r of P.TECH_TREE) assert.ok(P.isUnlocked(q, r[0]), r[0]);
      for (const r of P.TECH_TREE) for (const d of P.MODULES) assert.strictEqual(P.moduleTier(q, r[0], d.key), d.tiers.length);
      assert.strictEqual(P.moduleTier(q, 'Extra', 'main'), 3);
      assert.deepStrictEqual([...q.skills].sort(), P.SKILLS.filter(s => !s.top).map(s => s.key).sort());
      const topSkill = P.SKILLS.find(s => s.top);
      assert.strictEqual(P.skillPointsFree(q), topSkill.cost, 'the top course stays one click away');
      assert.ok(P.learnSkill(q, topSkill.key) && P.skillPointsFree(q) === 0);
      assert.ok(q.cheat === true && P.captainLevel(q.totalXp).next === null);
      // idempotent, never lowers a richer profile
      const rich = { ...P.defaultProfile(), xp: 5e6, credits: 9e7 };
      P.maxOutProfile(rich); P.maxOutProfile(rich);
      assert.ok(rich.xp === 5e6 && rich.credits === 9e7 && rich.skills.length === P.SKILLS.length - 1);
   });
}
