// The solver page in a real browser, on a throwaway planner (tests/serve_temp.py):
// every kind of input goes in, is saved, reloaded and saved again unchanged;
// then the outputs — results bar, build cost, graph, analysis — and a power plant.
// Needs Playwright; skips without it.
//   node tests/sidebar.e2e.mjs            (NPM_ROOT=… if Playwright isn't global)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire((process.env.NPM_ROOT || process.cwd()) + '/');
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('skip: Playwright not installed'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5000 + Math.floor(Math.random() * 900) + 80;
const B = `http://127.0.0.1:${PORT}`;
const srv = spawn('python', ['-m', 'tests.serve_temp', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const stop = code => { srv.kill(); process.exit(code); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (p, body) => fetch(B + p, body === undefined ? {} : {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

async function solveAndSave(key, sc) {
  await api(`/api/scenarios/${key}`, sc);
  const { job_id } = await api('/api/solve', { ...sc, solve_styles: [], base_scenario: sc });
  for (;;) {
    const r = await api(`/api/solve/${job_id}`);
    if (r.status !== 'pending') return r.result;
    await sleep(150);
  }
}

let failed = 0;
const step = async (name, fn) => {
  try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
};

try {
  for (let i = 0; ; i++) { try { await fetch(B + '/api/progress'); break; } catch { if (i > 100) throw new Error('server did not start'); await sleep(100); } }
  const base = { enabled_machines: [], alternate_recipes_enabled: [], unlimited_resources: [] };
  await solveAndSave('iron', { ...base, name: 'iron', resource_nodes: [{ resource: 'Iron_Ore', extractor: 'fixed', rate: 480 }],
    objective: { Iron_Plate: 1 } });
  await solveAndSave('plant', { ...base, name: 'Plant', resource_nodes: [
    { resource: 'Coal', extractor: 'fixed', rate: 60 }, { resource: 'Water', extractor: 'fixed', rate: 1000 }],
    unlimited_resources: ['Water'], objective: { Power: 1 } });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => d.accept());
  const saves = [];
  page.on('request', r => { if (r.method() === 'POST' && /\/api\/scenarios\/round_trip$/.test(r.url())) saves.push(JSON.parse(r.postData())); });
  await page.goto(B + '/');
  await page.waitForFunction(() => document.querySelector('#bsolve'));
  await sleep(800);
  const open = async (sec, field) => { if (!(await page.locator(field).isVisible())) await page.click(`#tog-${sec}`); };
  const pick = async (text) => { await page.keyboard.type(text); await sleep(300); await page.keyboard.press('Enter'); await sleep(250); };

  await step('every input goes in', async () => {
    await page.fill('#sc-name', 'Round Trip'); await page.dispatchEvent('#sc-name', 'change');
    await page.fill('#sc-desc', 'All the inputs');
    // a typed miner row, a fixed rate
    await page.click('#add-res'); await sleep(150); await pick('Iron Ore');
    const r0 = page.locator('#kv-res .nrow').last();
    await r0.locator('.n-pu').selectOption('pure'); await r0.locator('.n-ct').fill('2');
    await r0.locator('.n-sh-sel').selectOption('1');
    await page.click('#add-res'); await sleep(150); await pick('Limestone');
    await page.locator('#kv-res .nrow').last().locator('.n-ex').selectOption('fixed'); await sleep(150);
    await page.locator('#kv-res .nrow').last().locator('.n-rate-in').fill('120');
    await page.locator('#kv-res .nrow').last().locator('.n-rate-in').blur();
    // on the map: a coal node, a water pin (geysers belong to the grid, not here)
    await page.click('#btn-map-pick'); await page.waitForSelector('#mp-map [data-id]');
    await page.click('.mp-f[data-r="Coal"]'); await sleep(200);
    await page.locator('#mp-map [data-id]').first().dispatchEvent('click');
    assert.equal(await page.locator('.mp-f[data-r="Geyser"]').count(), 0, 'no geysers in a factory');
    await page.click('#mp-pin');
    const box = await page.locator('#mp-map').boundingBox();
    await page.mouse.click(box.x + 20, box.y + 20); await sleep(200);
    await page.locator('#mp-list .mp-u select').first().selectOption('2');
    await page.click('#mp-apply'); await sleep(300);
    await page.locator('#kv-res .nrow', { hasText: 'Water' }).locator('.binf').click();   // water unlimited
    // an import from iron
    await page.click('#add-from'); await sleep(150); await pick('Iron Plate');
    await page.locator('#kv-from .f-rate').last().fill('20'); await page.locator('#kv-from .f-rate').last().blur();
    // goals
    await open('goals', '#add-obj');
    for (const [btn, item, v] of [['obj', 'Reinforced Iron Plate', '1'], ['must', 'Screw', '10'], ['min', 'Iron Rod', '5'], ['max', 'Iron Plate', '100']]) {
      await page.click(`#add-${btn}`); await sleep(120); await pick(item);
      await page.keyboard.type(v); await page.keyboard.press('Tab'); await sleep(100);
    }
    // shards, sloops, power cap, modes
    await open('oc', '#sc-sh');
    await page.fill('#sc-sh', '10'); await page.fill('#sc-sl', '2'); await page.fill('#sc-mp', '500');
    await page.click('#ssc-min-new-alts'); await page.click('#ssc-machines-first');
    await page.click('#sl-mode button[data-mode="exact"]');
    await open('nt', '#sc-nt'); await page.fill('#sc-nt', 'Notes stay.');
  });

  await step('it solves, and the bar shows its share of the ceiling', async () => {
    await page.keyboard.press('Control+r');
    await page.waitForFunction(() => !document.getElementById('bsolve').disabled, null, { timeout: 120000 }); await sleep(400);
    await page.evaluate(() => document.getElementById('wo')?.classList.remove('show'));
    const bar = await page.locator('#rb').innerText();
    assert.match(bar, /OF CEILING/i, bar);
    assert.match(bar, /POWER/i);
  });

  await step('storage takes part of what it makes', async () => {
    await page.click('#add-sto'); await sleep(150); await pick('Reinforced Iron Plate');
    const v = +(await page.locator('#kv-sto .f-rate').last().inputValue());
    assert.ok(v > 0, `storage defaults to what it makes (${v})`);
    await page.locator('#kv-sto .f-rate').last().fill('0.5'); await page.locator('#kv-sto .f-rate').last().blur();
  });

  await step('saved, reloaded and saved again: the same scenario', async () => {
    await page.click('#bsave'); await sleep(900);
    await page.reload(); await page.waitForFunction(() => document.querySelector('#bsolve')); await sleep(800);
    await page.keyboard.press('Control+o'); await page.waitForSelector('#fac-drawer.show .sv-row'); await sleep(200);
    await page.locator('.sv-row', { hasText: 'Round Trip' }).locator('button').first().click(); await sleep(1200);
    assert.equal(await page.locator('#fac-drawer.show').count(), 0, 'the drawer goes once one is open');
    await page.click('#bsave'); await sleep(900);
    assert.equal(saves.length, 2, `${saves.length} saves`);
    const [a, b] = saves.map(x => JSON.parse(JSON.stringify(x, Object.keys(x).sort())));
    for (const k of new Set([...Object.keys(saves[0]), ...Object.keys(saves[1])]))
      assert.deepEqual(saves[1][k], saves[0][k], `"${k}" changed on the round trip`);
    // and what went in is there
    const s = saves[1];
    assert.equal(s.name, 'Round Trip'); assert.equal(s.description, 'All the inputs'); assert.equal(s.notes, 'Notes stay.');
    assert.deepEqual(s.objective, { Reinforced_Iron_Plate: 1 }); assert.deepEqual(s.must_produce, { Screw: 10 });
    assert.deepEqual(s.min_produce, { Iron_Rod: 5 }); assert.deepEqual(s.max_produce, { Iron_Plate: 100 });
    assert.equal(s.power_shards_available, 10); assert.equal(s.somersloops_available, 2); assert.equal(s.max_power_mw, 500);
    assert.equal(s.minimize_new_alts, true); assert.equal(s.machines_first, true); assert.equal(s.sloop_search, 'exact');
    assert.deepEqual(s.from_factories, [{ item: 'Iron_Plate', factory: 'iron', rate: 20 }]);
    assert.deepEqual(s.to_storage, [{ item: 'Reinforced_Iron_Plate', rate: 0.5 }]);
    const kinds = s.resource_nodes.map(n => n.extractor).sort();
    assert.deepEqual(kinds, ['Miner', 'Miner', 'Water_Extractor', 'fixed']);
    assert.ok(s.resource_nodes.find(n => n.extractor === 'Water_Extractor').at, 'the pin keeps its place');
    assert.deepEqual(s.unlimited_resources, ['Water']);
    assert.ok(s.available_resources.Iron_Ore > 0 && s.available_resources.Limestone === 120 && s.available_resources.Iron_Plate === 20);
  });

  await step('the build cost counts the extractors', async () => {
    await page.keyboard.press('Control+r');
    await page.waitForFunction(() => !document.getElementById('bsolve').disabled, null, { timeout: 120000 }); await sleep(400);
    await page.click('#dk-rail [data-dk="build"]'); await sleep(200);
    const bc = await page.locator('#bcb').innerText();
    assert.match(bc, /Miner Mk\.3/); assert.match(bc, /Water Extractor/);
  });

  await step('the analysis opens', async () => {
    await page.click('#dk-rail [data-dk="analysis"]');
    await page.waitForFunction(() => (document.getElementById('analysis-body')?.innerText || '').length > 200, null, { timeout: 60000 });
    await page.click('#dk-close'); await sleep(150);
    assert.equal(await page.locator('#app.dk-open').count(), 0);
  });

  await step('history keeps only changes, says what they were, and can be confirmed', async () => {
    await page.keyboard.press('Control+o'); await page.waitForSelector('#fac-drawer.show .sv-row'); await sleep(200);
    const row = () => page.locator('.sv-row', { hasText: 'Round Trip' });
    await row().locator('.sv-h').click(); await sleep(400);
    assert.match(await row().locator('.sv-hist').innerText(), /No earlier versions/);   // saved twice, the same
    await page.keyboard.press('Escape'); await sleep(150);
    await open('nt', '#sc-nt'); await page.fill('#sc-nt', 'Notes changed.'); await page.dispatchEvent('#sc-nt', 'change');
    await page.click('#bsave'); await sleep(900);
    await page.keyboard.press('Control+o'); await page.waitForSelector('#fac-drawer.show .sv-row'); await sleep(200);
    await row().locator('.sv-h').click(); await sleep(400);
    const h = await row().locator('.sv-hist').innerText();
    assert.match(h, /notes differ/, h); assert.match(h, /0\/5 confirmed/);
    await row().locator('.sv-hist [data-c]:not([data-c="current"])').first().click(); await sleep(400);
    assert.match(await row().locator('.sv-hist').innerText(), /1\/5 confirmed/);
    assert.equal(await row().locator('.sv-conf').count(), 1);
  });

  await step('a backup is made and listed', async () => {
    await page.click('#bk-make'); await sleep(600);
    const b = await page.locator('.sv-bk').innerText();
    assert.match(b, /3 factories/, b);
    assert.equal(await page.locator('.sv-bk [data-f]').count(), 1);
  });

  await step('a power plant reads in MW', async () => {
    await page.locator('.sv-row', { hasText: 'Plant' }).locator('button').first().click(); await sleep(1200);
    const bar = await page.locator('#rb').innerText();
    assert.match(bar, /MW\s+POWER/, bar);
    assert.doesNotMatch(bar, /\/m\s+POWER/, bar);
  });

  if (errors.length) { failed++; console.log('FAIL page errors:\n     ' + errors.join('\n     ')); }
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  stop(failed ? 1 : 0);
} catch (e) {
  console.log('FAIL', e.stack || e);
  stop(1);
}
