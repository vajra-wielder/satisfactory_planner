// Solving by itself, a machine cap, a save's machines on the build sheet,
// alternates ranked across factories, heavy routes, growing every goal and a
// stacked floor plan — in a real browser on a throwaway planner.
// Needs Playwright; skips without it.   node tests/improve.e2e.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

const require = createRequire((process.env.NPM_ROOT || process.cwd()) + '/');
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('skip: Playwright not installed'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5000 + Math.floor(Math.random() * 900) + 50;
const B = `http://127.0.0.1:${PORT}`;
const srv = spawn('python', ['-m', 'tests.serve_temp', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const stop = code => { srv.kill(); process.exit(code); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (p, body) => fetch(B + p, body === undefined ? {} : {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

let failed = 0;
const step = async (name, fn) => {
  try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
};

// A save with `n` iron smelters standing at (x, y) m: one level, its object table and data
function save(n, x, y) {
  const i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
  const str = t => Buffer.concat([i32(Buffer.byteLength(t) + 1), Buffer.from(t + '\0')]);
  const f32 = vs => { const b = Buffer.alloc(4 * vs.length); vs.forEach((v, i) => b.writeFloatLE(v, 4 * i)); return b; };
  const heads = [], bodies = [];
  for (let i = 0; i < n; i++) {
    heads.push(Buffer.concat([i32(1), str('/Game/FactoryGame/Buildable/Factory/SmelterMk1/Build_SmelterMk1.Build_SmelterMk1_C'),
      str('Persistent_Level'), str(`Persistent_Level:PersistentLevel.Build_SmelterMk1_C_${i}`), i32(0), i32(1),
      f32([0, 0, 0, 1, x * 100 + i * 600, y * 100, 0, 1, 1, 1]), i32(0)]));
    bodies.push(Buffer.concat([Buffer.alloc(8), Buffer.from('mCurrentRecipe\0'), Buffer.alloc(12),
      Buffer.from('/Game/FactoryGame/Recipes/Smelter/Recipe_IngotIron.Recipe_IngotIron_C\0')]));
  }
  const toc = Buffer.concat([i32(n), ...heads]);
  const data = Buffer.concat([i32(n), ...bodies.map(b => Buffer.concat([i32(46), i32(0), i32(b.length), b]))]);
  const level = Buffer.concat([i32(toc.length), i32(0), toc, i32(data.length), i32(0), data]);
  const tag = Buffer.alloc(4); tag.writeUInt32LE(0x9E2A83C1);
  return Buffer.concat([tag, Buffer.alloc(44), deflateSync(Buffer.concat([Buffer.alloc(30), level, Buffer.alloc(30)]))]);
}

try {
  for (let i = 0; ; i++) { try { await fetch(B + '/api/progress'); break; } catch { if (i > 100) throw new Error('server did not start'); await sleep(100); } }
  const all = (await api('/api/map-nodes')).nodes;
  const iron = all.filter(n => n.r === 'Iron_Ore' && !n.w).slice(0, 2);
  await api('/api/scenarios/plates', { name: 'Plates', resource_nodes: [{ resource: 'Iron_Ore', extractor: 'Miner', nodes: iron.map(n => n.id) }],
    objective: { Iron_Plate: 1 } });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(B + '/');
  await page.waitForFunction(() => document.querySelector('#bsolve'));
  await sleep(800);
  await page.keyboard.press('Control+k'); await page.keyboard.type('plates'); await sleep(200); await page.keyboard.press('Enter'); await sleep(1000);
  await page.click('#bsolve');
  await page.waitForFunction(() => /plate/i.test(document.getElementById('rb')?.innerText || ''), null, { timeout: 60000 });
  const machines = () => page.evaluate(() => [...document.querySelectorAll('#rb .rbs')].find(s => /machines/i.test(s.querySelector('.rbl')?.textContent || ''))?.querySelector('.rbv')?.textContent);

  await step('a change solves by itself: a machine cap of 6, and the plan fits in 6', async () => {
    assert.match(await page.locator('#bauto').innerText(), /Auto ✓/);
    const before = Number(await machines());
    assert.ok(before > 6, `${before} machines before`);
    if (!(await page.locator('#sc-mm').isVisible())) await page.click('#tog-oc');
    await page.fill('#sc-mm', '6');
    await page.waitForFunction(() => {
      const s = [...document.querySelectorAll('#rb .rbs')].find(x => /machines/i.test(x.querySelector('.rbl')?.textContent || ''));
      return s && Number(s.querySelector('.rbv').textContent) <= 6;
    }, null, { timeout: 30000 });
    assert.equal(await page.locator('#bsolve').innerText(), '▶ Solve');
    await page.fill('#sc-mm', ''); await sleep(100);
    await page.waitForFunction(b => {
      const s = [...document.querySelectorAll('#rb .rbs')].find(x => /machines/i.test(x.querySelector('.rbl')?.textContent || ''));
      return s && Number(s.querySelector('.rbv').textContent) === b;
    }, before, { timeout: 30000 });
    await page.keyboard.press('Control+s'); await sleep(800);
  });

  await step('the save\'s machines on the build sheet: built, and what\'s left everywhere', async () => {
    const plan = (await api('/api/scenarios/plates'));
    const r = await fetch(B + '/api/save-file', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'test.sav' }, body: save(3, iron[0].x, iron[0].y) }).then(r => r.json());
    assert.equal(r.built, 3, JSON.stringify(r).slice(0, 200));
    await page.evaluate(d => document.dispatchEvent(new CustomEvent('save-read', { detail: d })), r);
    await page.click('#dk-rail [data-dk="build"]'); await page.waitForSelector('.bs-l .bs-b');
    const badge = await page.locator('.bs-l').first().locator('.bs-b').innerText();
    assert.match(badge, /^3\/\d+$/, badge);
    assert.match(await page.locator('#bcb').innerText(), /left/);
    await page.click('#bc-left'); await page.waitForSelector('#sp-full.show');
    const t = await page.locator('#sp-full-b').innerText();
    assert.match(t, /Plates[\s\S]*Iron Ingot[\s\S]*3 of \d+ built/);
    assert.match(t, /Iron Rod/);          // machines are built from rods: needed, and none in storage
    await page.keyboard.press('Escape');
    assert.ok(plan.name);
  });

  await step('the floor plan stacks floors past a footprint, with lifts between', async () => {
    await page.click('#bs-plan'); await page.waitForSelector('#fp-d');
    await page.fill('#fp-w', '4'); await page.fill('#fp-d', '3');
    await page.waitForFunction(() => /\d+ floors/.test(document.getElementById('sp-full-b').innerText), null, { timeout: 5000 }).catch(() => {});
    const t = await page.locator('#sp-full-b').innerText();
    assert.match(t, /\d+ floors \(\d+ m tall\), \d+ belt lifts?/);
    assert.ok(await page.locator('#sp-full-b .fp-lift').count() > 0);
    await page.fill('#fp-w', ''); await page.fill('#fp-d', '');
    assert.match(await page.locator('#fp-body').innerText(), /one floor/);
    await page.keyboard.press('Escape');
  });

  await step('alternates you haven\'t unlocked, ranked across every saved factory', async () => {
    await page.click('#dk-rail [data-dk="alts"]');
    await page.waitForFunction(() => /Across all factories/.test(document.getElementById('alts-all')?.textContent || ''), null, { timeout: 20000 });
    const d = await api('/api/alts-everywhere');
    const t = await page.locator('#alts-all').textContent();
    if (d.alts.length) assert.match(t, /Plates/, t); else assert.match(t, /None you haven't unlocked/, t);
    assert.equal(await page.locator('#alts-all .na-row').count(), Math.min(6, d.alts.length));
  });

  await step('heavy routes are flagged; grow all goals raises each together', async () => {
    const cu = all.filter(n => n.r === 'Copper_Ore' && !n.w).slice(-2).map(n => n.id);
    await api('/api/scenarios/wires', { name: 'Wires', resource_nodes: [{ resource: 'Copper_Ore', extractor: 'Miner', nodes: cu }],
      from_factories: [{ item: 'Iron_Plate', factory: 'plates', rate: 60 }], objective: { Wire: 1 } });
    // 60 plates/min by drone on a 200 min round trip: 60·200 / (9 stacks × 200) ≈ 7 drones — more than 4
    await api('/api/blackboard', { positions: {}, routes: [{ a: 'plates', b: 'wires', mode: 'drone', trip_min: 200 }] });
    await page.click('#btn-blackboard'); await sleep(900);
    await page.waitForSelector('.bb-route-load');
    assert.match(await page.locator('.bb-route-load').innerText(), /⚠ \d+ drones/);
    assert.match(await page.locator('.bb-route-load').getAttribute('title'), /Heavy: \d+ drones busy — mostly Iron Plate/);
    await page.click('#bb-grow');
    await page.waitForFunction(() => /Every goal/.test(document.getElementById('bb-net')?.innerText || ''), null, { timeout: 30000 });
    assert.match(await page.locator('#bb-net').innerText(), /Every goal × [\d.]+/);
    await page.keyboard.press('Escape');
  });

  if (errors.length) { failed++; console.log('FAIL page errors:\n     ' + errors.join('\n     ')); }
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  stop(failed ? 1 : 0);
} catch (e) {
  console.log('FAIL', e.stack || e);
  stop(1);
}
