// The browser tests, in one run: each section on a planner of its own (a
// throwaway folder, its own port — SERVE below), all in one browser,
// a few at a time. Your scenarios, plans and unlocks are never touched.
// Needs Playwright; skips without it.
//   node tests/e2e.mjs              every section
//   node tests/e2e.mjs tree build   just those
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const require = createRequire((process.env.NPM_ROOT || process.cwd()) + '/');
let playwright;
try { playwright = require('playwright'); } catch { console.log('skip: Playwright not installed'); process.exit(0); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The planner on a throwaway folder: your scenarios, plans, board and unlocks are never touched
const SERVE = `
import shutil, sys, tempfile
from pathlib import Path
import server, solver, supply
d = Path(tempfile.mkdtemp(prefix="planner-test-")); (d / ".data").mkdir()
server.SCENARIOS_DIR = solver.SCENARIOS_DIR = d
server.RESULTS_DIR, server.HISTORY_DIR, server.BACKUP_DIR = d / ".results", d / ".history", d / ".backups"
server.BOARD_PATH, server.UNLOCKED_PATH = d / ".data" / "board.yaml", d / ".data" / "unlocked_alts.yaml"
server.SAVE_NODES_PATH, server.MAP_SETTINGS_PATH = d / ".data" / "save_nodes.json", d / ".data" / "map_image.json"
server.MAP_IMAGE_DIR, server.GAME_MAP_URL = d / ".data", None          # no map picture in the tests
supply.PROGRESS_PATH = d / ".data" / "progress.yaml"
supply.save_progress({"machines": ["Smelter", "Constructor", "Assembler", "Foundry", "Coal_Generator"]})
try:
    server.run(int(sys.argv[1]))
finally:
    shutil.rmtree(d, ignore_errors=True)
`;

// ── sidebar ──────────────────────────────────────────────
// The solver page in a real browser, on a throwaway planner:
// every kind of input goes in, is saved, reloaded and saved again unchanged;
// then the outputs — results bar, build cost, graph, analysis — and a power plant.
SUITES.sidebar = async ({ B, api, chromium, stop, log }) => {

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
    try { await fn(); log(`ok  ${name}`); } catch (e) { failed++; log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
  };

  try {
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
      assert.doesNotMatch(bc, /Extractors\n|Somersloops|Power Shards|Belts, pipes/i, 'one machines list; shards and sloops are on the bar');
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

    if (errors.length) { failed++; log('FAIL page errors:\n     ' + errors.join('\n     ')); }
    await browser.close();
    log(failed ? `\n${failed} failed` : '\nall passed');
    stop(failed ? 1 : 0);
  } catch (e) {
    log('FAIL', e.stack || e);
    stop(1);
  }
};

// ── blackboard ──────────────────────────────────────────────
// The Blackboard in a real browser, on a throwaway planner:
SUITES.blackboard = async ({ B, api, chromium, stop, log }) => {

  async function solveAndSave(key, sc) {
    await api(`/api/scenarios/${key}`, sc);
    const { job_id } = await api('/api/solve', { ...sc, solve_styles: [], base_scenario: sc });
    for (;;) {
      const r = await api(`/api/solve/${job_id}`);
      if (r.status !== 'pending') { assert.ok(String(r.result.status).startsWith('Optimal'), `${key}: ${r.result.status}`); return r.result; }
      await sleep(150);
    }
  }

  const checks = [];
  const check = (name, fn) => checks.push([name, fn]);

  try {
    const base = { enabled_machines: [], alternate_recipes_enabled: [], unlimited_resources: [] };
    // iron makes plates, screws and rods, sends three of them to frames and stores rods
    await solveAndSave('iron', { ...base, name: 'iron', resource_nodes: [{ resource: 'Iron_Ore', extractor: 'fixed', rate: 480 }],
      objective: { Iron_Plate: 1, Screw: 1 }, must_produce: { Iron_Rod: 30 }, to_storage: [{ item: 'Iron_Rod', rate: 10 }] });
    await solveAndSave('frames', { ...base, name: 'frames', resource_nodes: [],
      from_factories: [{ item: 'Iron_Plate', factory: 'iron', rate: 30 }, { item: 'Screw', factory: 'iron', rate: 60 },
                       { item: 'Iron_Rod', factory: 'iron', rate: 5 }], objective: { Reinforced_Iron_Plate: 1 } });
    await solveAndSave('wire', { ...base, name: 'wire', resource_nodes: [{ resource: 'Copper_Ore', extractor: 'fixed', rate: 120 }],
      objective: { Wire: 1 } });
    // iron now owes frames and storage: re-solve it so its plan is current
    await solveAndSave('iron', { ...base, name: 'iron', resource_nodes: [{ resource: 'Iron_Ore', extractor: 'fixed', rate: 480 }],
      objective: { Iron_Plate: 1, Screw: 1 }, must_produce: { Iron_Rod: 30 }, to_storage: [{ item: 'Iron_Rod', rate: 10 }] });

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(B + '/');
    await page.waitForFunction(() => document.querySelector('#bsolve'));
    await sleep(800);
    await page.click('#btn-blackboard');
    await page.waitForSelector('.bb-card');
    await sleep(500);

    check('a route joins iron and frames, drawn from frames\' imports', async () => {
      assert.equal(await page.locator('.bb-band').count(), 1);
    });
    check('one band, three stripes — one per item, as wide as its rate', async () => {
      const st = await page.$$eval('.bb-band .bb-stripe', ls => ls.map(l => ({ w: +l.getAttribute('stroke-width'), t: l.textContent })));
      assert.equal(st.length, 3);
      const rate = t => +t.match(/([\d.,]+)\/min/)[1].replace(/,/g, '');
      const k = st[0].w / rate(st[0].t);
      st.forEach(s => assert.ok(Math.abs(s.w - Math.max(2, rate(s.t) * k)) < 1e-6, s.t));
      assert.ok(st[0].w >= st[1].w && st[1].w >= st[2].w, 'widest first');
      assert.match(await page.locator('.bb-route-sum').innerText(), /3 items · 95\/min/);
    });
    check('the cards say who takes what', async () => {
      const t = await page.locator('.bb-card[data-key="iron"]').innerText();
      assert.match(t, /5 to frames, 10 stored/);
      assert.match(await page.locator('.bb-card[data-key="frames"]').innerText(), /from iron/);
    });
    check('flows: one band per pair, its stripes inside, one label each', async () => {
      await page.click('#bb-tabs button[data-tab="flows"]'); await sleep(300);
      assert.equal(await page.locator('#bb-sankey .sk-band').count(), 2);        // iron→frames, iron→storage
      assert.equal(await page.locator('#bb-sankey .sk-link').count(), 4);        // 3 + the stored rods
      const labels = await page.$$eval('#bb-sankey .sk-lab', ls => ls.map(l => l.textContent));
      assert.ok(labels.some(l => /3 items · 95\/min/.test(l)), labels.join(' | '));
    });
    check('items: with nothing typed, what is stored or moved', async () => {
      await page.click('#bb-tabs button[data-tab="items"]'); await sleep(200);
      assert.match(await page.locator('#bb-items-out').innerText(), /Iron Rod[\s\S]*10 stored/);
    });
    check('power and map render', async () => {
      await page.click('#bb-tabs button[data-tab="power"]'); await sleep(200);
      assert.match(await page.locator('#bb-power').innerText(), /Grid:/);
      await page.click('#bb-tabs button[data-tab="map"]'); await page.waitForSelector('#bb-map svg');
      assert.ok(await page.locator('#bb-map [data-id]').count() > 500);
    });
    check('geothermal goes on the grid: placed on the map, counted in power, built, kept', async () => {
      await page.click('#bb-tabs button[data-tab="map"]'); await page.waitForSelector('#bb-map svg');
      await page.click('#mp-geo'); await sleep(200);
      const gs = page.locator('#bb-map [data-id^="ResourceNodeGeyser"]');
      await gs.nth(0).dispatchEvent('click'); await gs.nth(1).dispatchEvent('click'); await sleep(300);
      assert.equal(await page.locator('#bb-map .mp-grid-g').count(), 2);
      assert.match(await page.locator('#bb-map .mp-legend').innerText(), /Geothermal × 2/);
      await page.click('#bb-tabs button[data-tab="power"]'); await sleep(400);
      const pw = await page.locator('#bb-power').innerText();
      assert.match(pw, /geothermal × 2/); assert.match(pw, /every geyser at its low/);
      const layout = await api('/api/blackboard');
      assert.equal(layout.layout.geysers.length, 2);
      assert.equal(layout.grid.count, 2);
    });
    check('one build cost, on the right panel: add saved factories and the grid to it', async () => {
      await page.keyboard.press('Escape'); await sleep(200);   // off the Blackboard
      assert.equal(await page.locator('#bb-tabs button[data-tab="build"]').count(), 0, 'no second build list');
      await page.mouse.click(700, 400); await page.keyboard.press('3');
      await page.waitForFunction(() => /Power grid/.test(document.querySelector('#bcb .bc-add')?.innerText || ''));   // read afresh
      for (const c of await page.locator('#bcb .bc-add input:not([disabled])').all()) { await c.check(); await sleep(100); }
      const t = await page.locator('#bcb').innerText();
      assert.match(t, /Smelter/, t); assert.match(t, /Geothermal Generator\s+×2/, t);
      await page.keyboard.press('3'); await page.click('#btn-blackboard'); await page.waitForSelector('#bb-modal.show'); await sleep(300);
    });
    check('items: Iron Rod — sent out, taken, stored and free; storage changed here is saved in its factory', async () => {
      await page.click('#bb-tabs button[data-tab="items"]');
      await page.fill('#bb-items-q', 'Iron Rod'); await sleep(200);
      const t = await page.locator('#bb-items-out').innerText();
      assert.match(t, /Iron Rod/); assert.match(t, /15\/min free/, t);
      const row = page.locator('#bb-items-out tr', { hasText: 'iron' }).first();
      assert.match(await row.innerText(), /30\s+frames 5\s+15/, await row.innerText());
      assert.equal(await row.locator('[data-sto]').inputValue(), '10');
      await row.locator('[data-sto]').fill('4'); await row.locator('[data-sto]').press('Enter');
      await page.waitForFunction(() => /21\/min free/.test(document.querySelector('#bb-items-out')?.innerText || ''));
      assert.deepEqual((await api('/api/scenarios/iron')).to_storage, [{ item: 'Iron_Rod', rate: 4 }]);
    });
    check('routes are vehicles, each with its round trip', async () => {
      await page.click('#bb-tabs button[data-tab="factories"]'); await sleep(200);
      assert.equal(await page.locator('#bb-belt, #bb-pipe').count(), 0, 'no belt or pipe between factories');
      const modes = await page.locator('.bb-mode').first().locator('option').allInnerTexts();
      assert.deepEqual(modes, ['Train', 'Truck', 'Tractor', 'Drone']);
      await page.locator('.bb-mode').first().selectOption('tractor'); await sleep(200);
      await page.locator('.bb-trip').first().fill('7'); await page.locator('.bb-trip').first().dispatchEvent('change'); await sleep(700);
      const r = (await api('/api/blackboard')).layout.routes[0];
      assert.equal(r.mode, 'tractor'); assert.equal(r.trip_min, 7);
    });
    check('planning the network redraws the band from the plan', async () => {
      await page.click('#bb-tabs button[data-tab="factories"]'); await sleep(200);
      await page.click('#bb-plan');
      await page.waitForFunction(() => /Network plan|can't/.test(document.getElementById('bb-net')?.innerText || ''), null, { timeout: 60000 });
      assert.match(await page.locator('#bb-net').innerText(), /Network plan/);
      assert.ok(await page.locator('.bb-band .bb-stripe').count() >= 1);
      assert.match(await page.locator('.bb-route-load').innerText(), /train|truck|tractor|drone/);   // what the route takes
    });
    check('before saving: a plan that leaves another factory short says so by Save', async () => {
      await page.keyboard.press('Escape'); await sleep(200);
      page.once('dialog', d => d.accept());
      await page.keyboard.press('Control+k'); await page.keyboard.type('iron'); await sleep(200); await page.keyboard.press('Enter'); await sleep(1200);
      assert.equal(await page.inputValue('#sc-name'), 'iron');
      const v = page.locator('#kv-must .kvr input').nth(1);
      await v.fill('1'); await v.press('Enter'); await sleep(300);
      await page.click('#bsolve');
      await page.waitForFunction(() => document.getElementById('save-impact')?.style.display === '', null, { timeout: 30000 });
      assert.match(await page.locator('#save-impact').innerText(), /frames[\s\S]*Iron Rod[\s\S]*Save and re-solve/);
    });

    let failed = 0;
    for (const [name, fn] of checks) {
      try { await fn(); log(`ok  ${name}`); } catch (e) { failed++; log(`FAIL ${name}\n     ${e.message}`); }
    }
    if (errors.length) { failed++; log('FAIL page errors:\n     ' + errors.join('\n     ')); }
    await browser.close();
    log(`\n${checks.length - Math.min(failed, checks.length)} of ${checks.length} passed${errors.length ? ', with page errors' : ''}`);
    stop(failed ? 1 : 0);
  } catch (e) {
    log('FAIL', e.stack || e);
    stop(1);
  }
};

// ── nav ──────────────────────────────────────────────
// Getting around, in a real browser on a throwaway planner: the Go-to palette,
// stepping through the systems with keys and the wheel, factories one after
// another, the shortcuts sheet, Esc, and the maps' keys and detail levels.
SUITES.nav = async ({ B, api, chromium, stop, log }) => {

  let failed = 0;
  const step = async (name, fn) => {
    try { await fn(); log(`ok  ${name}`); } catch (e) { failed++; log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
  };

  try {
    for (const n of ['Alpha', 'Bravo', 'Charlie'])
      await api(`/api/scenarios/${n.toLowerCase()}`, { name: n, resource_nodes: [{ resource: 'Iron_Ore', extractor: 'fixed', rate: 60 }], objective: { Iron_Plate: 1 } });

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(B + '/');
    await page.waitForFunction(() => document.querySelector('#bsolve'));
    await sleep(800);
    const bbOpen = () => page.evaluate(() => document.getElementById('bb-modal').classList.contains('show'));
    const bbTab = () => page.evaluate(() => document.querySelector('#bb-tabs button.on')?.dataset.tab);

    await step('Ctrl+K finds a system and goes there', async () => {
      await page.keyboard.press('Control+k');
      await page.waitForSelector('#nav-pal.show');
      await page.keyboard.type('power');
      await page.keyboard.press('Enter'); await sleep(500);
      assert.equal(await bbOpen(), true); assert.equal(await bbTab(), 'power');
    });
    await step('Alt+→ and Alt+← step through the systems, Alt+1 back to the planner', async () => {
      await page.keyboard.press('Alt+ArrowRight'); await sleep(300);
      assert.equal(await bbTab(), 'map');
      await page.keyboard.press('Alt+ArrowLeft'); await page.keyboard.press('Alt+ArrowLeft'); await sleep(300);
      assert.equal(await bbTab(), 'flows');
      assert.match(await page.locator('#nav-ring').innerText(), /Planner[\s\S]*Flows[\s\S]*Items/);
      await page.keyboard.press('Alt+1'); await sleep(300);
      assert.equal(await bbOpen(), false);
      await page.keyboard.press('Alt+ArrowLeft'); await sleep(300);              // round the ring
      assert.equal(await bbTab(), 'items');
    });
    await step('the wheel over the Blackboard\'s tabs moves along them', async () => {
      await page.keyboard.press('Alt+3'); await sleep(300);
      const b = await page.locator('#bb-tabs').boundingBox();
      await page.mouse.move(b.x + 20, b.y + b.height / 2);
      await page.mouse.wheel(0, 120); await sleep(300);
      assert.equal(await bbTab(), 'power');
      await page.mouse.wheel(0, -120); await sleep(300);
      assert.equal(await bbTab(), 'flows');
    });
    await step('Esc closes the Blackboard', async () => {
      await page.mouse.move(5, 500);
      await page.keyboard.press('Escape'); await sleep(200);
      assert.equal(await bbOpen(), false);
    });
    await step('Alt+↓ opens the saved factories one after another', async () => {
      await page.keyboard.press('Alt+ArrowDown'); await sleep(700);
      const a = await page.inputValue('#sc-name');
      await page.keyboard.press('Alt+ArrowDown'); await sleep(700);
      const b = await page.inputValue('#sc-name');
      assert.ok(['Alpha', 'Bravo', 'Charlie'].includes(a) && ['Alpha', 'Bravo', 'Charlie'].includes(b) && a !== b, `${a} then ${b}`);
    });
    await step('the palette opens a factory and an item across the factories', async () => {
      await page.keyboard.press('Control+k'); await page.keyboard.type('charlie'); await page.keyboard.press('Enter'); await sleep(700);
      assert.equal(await page.inputValue('#sc-name'), 'Charlie');
      await page.click('#btn-goto'); await page.keyboard.type('iron plate across'); await sleep(150);
      await page.keyboard.press('Enter'); await sleep(800);
      assert.equal(await bbTab(), 'items');
      assert.equal(await page.inputValue('#bb-items-q'), 'Iron Plate');
      await page.keyboard.press('Escape');
    });
    await step('Ctrl+Q: find a part on the tree — its recipes, a part to go to; sums; belts; Esc', async () => {
      await page.keyboard.press('Control+q'); await page.waitForSelector('#gt.show');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'gt-q');
      await page.keyboard.type('motor'); await sleep(150);
      assert.ok(await page.locator('#gt-hits .gt-hit').count() >= 2, 'every part with the word');
      await page.keyboard.press('Enter'); await page.waitForSelector('#gt-pop .gp-r');
      assert.match(await page.locator('#gt-pop .gp-h').innerText(), /^Motor/);
      const motor = page.locator('#gt-pop .gp-r').filter({ has: page.locator('.rl-n', { hasText: /^Motor$/ }) }).first();
      assert.match(await motor.innerText(), /5\/min[\s\S]*Rotor\s+10/, 'one machine each, no goal yet');
      await motor.locator('[data-go="Rotor"]').click(); await sleep(250);
      assert.match(await page.locator('#gt-pop .gp-h').innerText(), /^Rotor/, 'a part on a card goes to it');
      await page.click('#gt-q'); await page.keyboard.type('240*2/3'); await sleep(150);
      assert.match(await page.locator('#gt-hits').innerText(), /=\s*160/);
      await page.fill('#gt-q', '4 x 120 into 5 x 80 + 40 + 20 + 20'); await sleep(200);
      assert.ok(await page.locator('#gt-split svg .sp-n').count() > 0, 'the splitters and mergers, drawn');
      assert.match(await page.locator('#gt-split .sp-h').innerText(), /4 × 120 → 5 × 80 \+ 40 \+ 2 × 20[\s\S]*splitter/);
      await page.fill('#gt-q', '100 into 60 + 50'); await sleep(150);
      assert.match(await page.locator('#gt-split').innerText(), /only 100\/min in/);
      await page.keyboard.press('Escape'); await page.mouse.click(600, 500); await sleep(150);
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await sleep(150);
      assert.equal(await page.locator('#gt.show').count(), 0);
      await page.click('#tb-rl-open'); await page.waitForSelector('#gt.show');   // the top bar's box opens it too
      assert.equal(await page.evaluate(() => document.activeElement.id), 'gt-q');
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    });
    await step('? shows every shortcut, Esc closes it', async () => {
      await page.keyboard.press('Shift+Slash'); await sleep(200);
      assert.match(await page.locator('#nav-help').innerText(), /Go to anything[\s\S]*Solve[\s\S]*The whole map/);
      await page.keyboard.press('Escape'); await sleep(150);
      assert.equal(await page.locator('#nav-help.show').count(), 0);
    });
    await step('3 opens Build cost on the right, the wheel over its rail steps tabs, 3 again closes it', async () => {
      await page.mouse.click(700, 400); await page.keyboard.press('3'); await sleep(300);
      const head = () => page.locator('#dk-title').innerText();
      assert.match(await head(), /Build cost/i);
      const b = await page.locator('#dk-rail').boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + 80);
      await page.mouse.wheel(0, 120); await sleep(300);
      assert.match(await head(), /Issues/i);
      await page.keyboard.press('4'); await sleep(200);
      assert.equal(await page.locator('#app.dk-open').count(), 0);
    });
    await step('Ctrl+O factories and Ctrl+U unlocks open far off; Esc closes them', async () => {
      for (const [k, id] of [['Control+o', '#fac-drawer'], ['Control+u', '#unlocks-modal']]) {
        await page.keyboard.press(k); await page.waitForSelector(id + '.show');
        await page.keyboard.press('Escape'); await sleep(150);
        assert.equal(await page.locator(id + '.show').count(), 0, id);
      }
    });
    await step('the map: + zooms in to purity, then names; 0 the whole map; Esc closes the picker', async () => {
      await page.keyboard.press('Control+m'); await page.waitForSelector('#mp-map [data-id]'); await sleep(300);
      await page.mouse.move(5, 500);
      await page.click('#map-modal .mp-f[data-r="*"]'); await sleep(200);
      const lv = () => page.locator('#mp-map .mp-level').innerText();
      assert.match(await lv(), /Zoom in or pick one resource/);
      assert.equal(await page.locator('#mp-map .mp-pur').count(), 0);
      for (let i = 0; i < 3; i++) await page.keyboard.press('+');
      assert.match(await lv(), /names and owners/);
      assert.ok(await page.locator('#mp-map .mp-pur').count() > 0);
      for (let i = 0; i < 3; i++) await page.keyboard.press('+');
      assert.ok(await page.locator('#mp-map .mp-lbl').count() > 0, 'labels up close');
      await page.keyboard.press('0'); await sleep(100);
      assert.equal(await page.locator('#mp-map .mp-lbl').count(), 0);
      await page.click('#map-modal .mp-f[data-r="Coal"]'); await sleep(100);
      assert.ok(await page.locator('#mp-map .mp-pur').count() > 0, 'one resource picked: purity shows');
      await page.keyboard.press('Escape'); await sleep(200);
      assert.equal(await page.locator('#map-modal.show').count(), 0);
    });

    await step('picking nodes for a factory that has some: the map opens on them; the wheel zooms in any units', async () => {
      const all = (await api('/api/map-nodes')).nodes.filter(n => n.r === 'Coal' && !n.w);
      // two neighbours, as a factory would mine
      const pair = all.flatMap(a => all.filter(b => b.id > a.id).map(b => [a, b])).find(([a, b]) => Math.hypot(a.x - b.x, a.y - b.y) < 400 && Math.hypot(a.x - b.x, a.y - b.y) > 60);
      const ids = pair.map(n => n.id);
      await api('/api/scenarios/delta', { name: 'Delta', resource_nodes: [{ resource: 'Coal', extractor: 'Miner', nodes: ids }], objective: { Iron_Plate: 1 } });
      await page.keyboard.press('Control+k'); await page.keyboard.type('delta'); await page.keyboard.press('Enter'); await sleep(800);
      await page.keyboard.press('Control+m'); await page.waitForSelector('#mp-map [data-id]'); await sleep(400);
      const box = await page.locator('#mp-map').boundingBox();
      for (const id of ids) {                                   // both on screen, near the middle
        const b = await page.locator(`#mp-map [data-id="${id}"]`).boundingBox();
        assert.ok(b && b.x > box.x && b.x < box.x + box.width && b.y > box.y && b.y < box.y + box.height, `${id} on screen`);
      }
      assert.equal(await page.inputValue('#sc-name'), 'Delta');
      assert.doesNotMatch(await page.locator('#mp-map .mp-level').innerText(), /Zoom in or pick/, 'zoomed in on them');
      const apart = async () => {                               // the two nodes' distance on screen
        const [a, b] = await Promise.all(ids.map(id => page.locator(`#mp-map [data-id="${id}"]`).boundingBox()));
        return Math.hypot(a.x - b.x, a.y - b.y);
      };
      const fitted = await apart();
      await page.keyboard.press('0'); await sleep(100);                              // the whole map
      const r0 = await apart();
      assert.ok(fitted > r0 * 1.5, `opened zoomed in on them (${fitted.toFixed(0)} px apart vs ${r0.toFixed(0)} on the whole map)`);
      // a mouse that reports lines, not pixels (Windows), still zooms a step a notch
      await page.locator('#mp-map').dispatchEvent('wheel', { deltaY: -3, deltaMode: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
      await page.locator('#mp-map').dispatchEvent('wheel', { deltaY: -3, deltaMode: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
      await sleep(300);
      const k = (await apart()) / r0;
      assert.ok(k > 1.4 && k < 1.8, `two notches zoom about 1.6× (got ${k.toFixed(2)}×)`);
      await page.keyboard.press('Escape');
    });

    if (errors.length) { failed++; log('FAIL page errors:\n     ' + errors.join('\n     ')); }
    await browser.close();
    log(failed ? `\n${failed} failed` : '\nall passed');
    stop(failed ? 1 : 0);
  } catch (e) {
    log('FAIL', e.stack || e);
    stop(1);
  }
};

// ── spare ──────────────────────────────────────────────
// Unused node supply, in a real browser on a throwaway planner: a factory that
// mines more than its plan uses shows "+N unused" on its nodes; another factory
// picking nodes brings some of it over as an import, and leaves the rest.
SUITES.spare = async ({ B, api, chromium, stop, log }) => {
  async function solveAndSave(key, sc) {
    await api(`/api/scenarios/${key}`, sc);
    const { job_id } = await api('/api/solve', { ...sc, solve_styles: [], base_scenario: sc });
    for (;;) { const r = await api(`/api/solve/${job_id}`); if (r.status !== 'pending') return r.result; await sleep(150); }
  }

  let failed = 0;
  const step = async (name, fn) => {
    try { await fn(); log(`ok  ${name}`); } catch (e) { failed++; log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
  };

  try {
    const nodes = (await api('/api/map-nodes')).nodes.filter(n => n.r === 'Iron_Ore' && !n.w && n.p === 'pure').slice(0, 2);
    const sc = { name: 'Iron intermediate', enabled_machines: [], alternate_recipes_enabled: [], unlimited_resources: [],
      resource_nodes: [{ resource: 'Iron_Ore', extractor: 'Miner', nodes: nodes.map(n => n.id) }],
      objective: { Iron_Ingot: 1 }, max_produce: { Iron_Ingot: 30 } };
    await solveAndSave('iron_intermediate', sc);
    const out = await api('/api/factory-outputs');
    const spare = out.factories.find(f => f.key === 'iron_intermediate').spare.Iron_Ore;

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.stack || e)));
    await page.goto(B + '/');
    await page.waitForFunction(() => document.querySelector('#bsolve'));
    await sleep(900);

    await step('the factory leaves ore unused, and it\'s offered', async () => {
      assert.ok(spare > 1, `spare ${spare}`);
    });
    await step('picking nodes: a ring on its nodes; Leftover shows them all, and up close how much', async () => {
      await page.fill('#sc-name', 'Next door'); await page.dispatchEvent('#sc-name', 'change');
      await page.keyboard.press('Control+m'); await page.waitForSelector('#mp-map [data-id]'); await sleep(300);
      await page.click('.mp-f[data-r="Iron_Ore"]'); await sleep(200);
      assert.equal(await page.locator('#mp-map .mp-spare-r').count(), 2, 'a ring on each of its nodes');
      assert.equal(await page.locator('#mp-map .mp-spare').count(), 0, 'from afar, no tag');
      await page.click('#mp-filters [data-only="spare"]'); await sleep(300);
      assert.equal(await page.locator('#mp-map [data-id]').count(), 2, 'only the nodes with some left');
      const tag = page.locator('#mp-map .mp-spare');
      assert.equal(await tag.count(), 1);
      assert.match(await tag.textContent(), new RegExp(`\\+${Math.round(spare)}`));
      assert.match(await page.locator('#mp-spare').innerText(), /Iron Ore · Iron intermediate[\s\S]*unused/);
    });
    await step('click the tag: bring it all; type an amount: bring some', async () => {
      await page.locator('#mp-map .mp-spare').dispatchEvent('click'); await sleep(150);
      assert.equal(+(await page.inputValue('#mp-spare .mp-bring')), +spare.toFixed(3));
      await page.fill('#mp-spare .mp-bring', '20'); await page.locator('#mp-spare .mp-bring').dispatchEvent('change'); await sleep(150);
      assert.match(await page.locator('#mp-map .mp-spare').textContent(), /→ 20 of/);
      await page.click('#mp-apply'); await sleep(400);
      const row = page.locator('#kv-from .nrow').first();
      assert.equal(await row.locator('.f-rate').inputValue(), '20');
      assert.match(await row.innerText() + await row.locator('input').first().inputValue(), /Iron Ore/);
    });
    await step('saved: the import is held, and the source has the rest left', async () => {
      await page.click('#bsave'); await sleep(900);
      const sc2 = await api('/api/scenarios/next_door');
      assert.deepEqual(sc2.from_factories, [{ item: 'Iron_Ore', factory: 'iron_intermediate', rate: 20 }]);
      await page.keyboard.press('Control+m'); await page.waitForSelector('#mp-map [data-id]'); await sleep(300);
      await page.click('#mp-filters [data-only="spare"]'); await sleep(300);
      assert.match(await page.locator('#mp-map .mp-spare').textContent(), /→ 20 of/);         // its own share shows as brought
      await page.locator('#mp-spare button').first().click(); await sleep(100);             // leave it there
      await page.click('#mp-apply'); await sleep(300);
      assert.equal(await page.locator('#kv-from .f-rate').count(), 0);
    });
    await step('picking a region: drag a box and everything inside is picked; Shift+drag takes out; right-drag pans', async () => {
      await page.keyboard.press('Control+m'); await page.waitForSelector('#mp-map [data-id]'); await sleep(300);
      const picked = () => page.locator('#mp-map .mp-n.on').count();
      const before = await picked();
      const b = await page.locator('#mp-map').boundingBox();
      const box = async (shift, from, to) => {
        if (shift) await page.keyboard.down('Shift');
        await page.mouse.move(b.x + from[0], b.y + from[1]); await page.mouse.down();
        await page.mouse.move(b.x + to[0], b.y + to[1], { steps: 6 }); await page.mouse.up();
        if (shift) await page.keyboard.up('Shift');
        await sleep(250);
      };
      await box(false, [b.width * .3, b.height * .3], [b.width * .7, b.height * .7]);
      const after = await picked();
      assert.ok(after > before + 3, `a box picks every node in it (${before} → ${after})`);
      await box(true, [b.width * .3, b.height * .3], [b.width * .7, b.height * .7]);
      assert.ok(await picked() <= before, 'Shift+drag takes them out');
      const x0 = (await page.locator('#mp-map [data-id]').first().boundingBox()).x;
      await page.mouse.move(b.x + 200, b.y + 200); await page.mouse.down({ button: 'right' });
      await page.mouse.move(b.x + 320, b.y + 260, { steps: 5 }); await page.mouse.up({ button: 'right' }); await sleep(300);
      const x1 = (await page.locator('#mp-map [data-id]').first().boundingBox()).x;
      assert.ok(Math.abs(x1 - x0 - 120) < 15, `a right-drag pans (${x0} → ${x1})`);
      assert.ok(await picked() <= before, 'and picks nothing');
      await page.click('#mp-cancel'); await sleep(200);
    });
    await step('the Blackboard\'s map shows what\'s unused', async () => {
      await page.keyboard.press('Alt+5'); await page.waitForSelector('.mp-view [data-id]'); await sleep(400);
      await page.click('.mp-filters [data-only="spare"]'); await sleep(300);
      assert.match(await page.locator('.mp-view .mp-spare').textContent(), /unused/);
      assert.match(await page.locator('.mp-legend').innerText(), /Unused at factories[\s\S]*Iron intermediate/);
    });

    await step('nodes your save mines: In your save shows them, and adds the ones on screen', async () => {
      await page.keyboard.press('Escape'); await sleep(200);
      const mined = (await api('/api/map-nodes')).nodes.filter(n => n.r === 'Copper_Ore' && !n.w).slice(0, 3).map(n => n.id);
      await page.evaluate(ids => document.dispatchEvent(new CustomEvent('save-read', { detail: { nodes: ids, file: 'test.sav' } })), mined);
      await page.keyboard.press('Control+m'); await page.waitForSelector('#mp-map [data-id]'); await sleep(300);
      const chip = page.locator('#mp-filters [data-only="save"]');
      assert.match(await chip.innerText(), /In your save 3/);
      await chip.click(); await sleep(300);
      assert.equal(await page.locator('#mp-map [data-id]').count(), 3);
      assert.match(await page.locator('#mp-filters .mp-addview').innerText(), /Add the 3 on screen/);
      await page.click('#mp-filters .mp-addview'); await sleep(200);
      assert.match(await page.locator('#mp-filters .mp-addview').innerText(), /All on screen added/);
      await page.click('#mp-apply'); await sleep(400);
      const s = await page.evaluate(() => { const r = [...document.querySelectorAll('#kv-res .nrow')].map(x => x.innerText); return r.join('|'); });
      assert.match(s, /Copper Ore/, s);
      assert.equal((s.match(/\d(?=[PNI]\b)/g) || []).reduce((a, n) => a + +n, 0), 3, `three nodes: ${s}`);
    });

    if (errors.length) { failed++; log('FAIL page errors:\n     ' + errors.join('\n     ')); }
    await browser.close();
    log(failed ? `\n${failed} failed` : '\nall passed');
    stop(failed ? 1 : 0);
  } catch (e) {
    log('FAIL', e.stack || e);
    stop(1);
  }
};

// ── typing ──────────────────────────────────────────────
// Typing into the sidebar's boxes, in a real browser on a throwaway planner:
// an item typed (not picked from the list) stays when you click away, add a
// row or save, and is saved as the item; a misspelt one stays, marked; the
SUITES.typing = async ({ B, api, chromium, stop, log }) => {

  let failed = 0;
  const step = async (name, fn) => {
    try { await fn(); log(`ok  ${name}`); } catch (e) { failed++; log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
  };

  try {
    const src = { name: 'iron', enabled_machines: [], alternate_recipes_enabled: [], unlimited_resources: [],
      resource_nodes: [{ resource: 'Iron_Ore', extractor: 'fixed', rate: 480 }], objective: { Iron_Plate: 1 } };
    await api('/api/scenarios/iron', src);
    { const { job_id } = await api('/api/solve', { ...src, solve_styles: [], base_scenario: src });
      for (;;) { const r = await api(`/api/solve/${job_id}`); if (r.status !== 'pending') break; await sleep(150); } }

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(B + '/');
    await page.waitForFunction(() => document.querySelector('#bsolve'));
    await sleep(900);
    const away = () => page.mouse.click(900, 600);
    // type an item without picking it, then its rate (clicking into it), then click away
    async function fill(add, itemSel, rateSel, item, rate) {
      await page.click(add); await sleep(200);
      await page.locator(itemSel).last().click(); await page.keyboard.type(item, { delay: 10 }); await sleep(200);
      await page.locator(rateSel).last().click(); await page.keyboard.type(rate, { delay: 10 }); await sleep(150);
      await away(); await sleep(300);
    }
    await page.fill('#sc-name', 'Typed'); await page.dispatchEvent('#sc-name', 'change');

    await step('storage sits under the goals, not the resources', async () => {
      assert.equal(await page.locator('#sec-goals #kv-sto').count(), 1);
      assert.equal(await page.locator('#sec-res #kv-sto').count(), 0);
    });
    await step('a typed import and a typed storage row stay through another row and a save', async () => {
      await fill('#add-from', '#kv-from .f-item', '#kv-from .f-rate', 'Iron Plate', '5');
      await fill('#add-sto', '#kv-sto .f-item', '#kv-sto .f-rate', 'Iron Plate', '7');
      await page.click('#add-sto'); await page.click('#add-from'); await sleep(300);    // redraw both lists
      assert.equal(await page.locator('#kv-from .f-item').first().inputValue(), 'Iron Plate');
      assert.equal(await page.locator('#kv-sto .f-item').first().inputValue(), 'Iron Plate');
      await page.click('#bsave'); await sleep(1000);
      assert.equal(await page.locator('#kv-from .f-item').first().inputValue(), 'Iron Plate');
      assert.equal(await page.locator('#kv-sto .f-item').first().inputValue(), 'Iron Plate');
      const s = await api('/api/scenarios/typed');
      assert.deepEqual(s.from_factories, [{ item: 'Iron_Plate', factory: 'iron', rate: 5 }]);   // the rate typed, not "what's left"
      assert.deepEqual(s.to_storage, [{ item: 'Iron_Plate', rate: 7 }]);
    });
    await step('a misspelt item stays as typed, marked, and isn\'t saved', async () => {
      await page.locator('#kv-sto .f-item').last().click(); await page.keyboard.type('Iron Plat', { delay: 10 });
      await away(); await sleep(200);
      const box = page.locator('#kv-sto .f-item').last();
      assert.equal(await box.inputValue(), 'Iron Plat');
      assert.equal(await box.evaluate(e => e.classList.contains('ac-bad')), true);
      await page.click('#add-sto'); await sleep(200);
      assert.equal(await page.locator('#kv-sto .f-item').nth(-2).inputValue(), 'Iron Plat');
      await page.click('#bsave'); await sleep(1000);
      assert.equal((await api('/api/scenarios/typed')).to_storage.length, 1);
    });
    await step('goals: a typed item commits, a misspelt one is marked', async () => {
      await page.click('#add-obj'); await sleep(150);
      await page.locator('#kv-obj .kvr input').first().click(); await page.keyboard.type('reinforced iron plate', { delay: 10 });
      await page.locator('#kv-obj .kvr input[inputmode]').first().click(); await page.keyboard.type('1');
      await page.click('#add-min'); await sleep(150);
      await page.locator('#kv-min .kvr input').first().click(); await page.keyboard.type('Scre', { delay: 10 });
      await away(); await sleep(200);
      assert.equal(await page.locator('#kv-obj .kvr input').first().inputValue(), 'Reinforced Iron Plate');
      assert.equal(await page.locator('#kv-min .kvr input').first().evaluate(e => e.classList.contains('ac-bad')), true);
    });

    await step('Enter goes down the list: item, its amount, the next row — no mouse', async () => {
      page.once('dialog', d => d.accept());                    // the earlier steps' edits aren't saved: yes, drop them
      await page.click('#breset'); await sleep(400);
      const focused = () => page.evaluate(() => { const a = document.activeElement; return `${a.closest('[id^="kv-"]')?.id} ${a.className}`; });
      const pickTyped = async (txt) => { await page.keyboard.type(txt, { delay: 10 }); await sleep(250); await page.keyboard.press('Enter'); await sleep(250); };
      // storage
      await page.click('#add-sto'); await sleep(200);
      await pickTyped('Iron Plate');
      assert.match(await focused(), /kv-sto f-rate/, 'item → its amount');
      await page.keyboard.press('Control+a'); await page.keyboard.type('2*3'); await page.keyboard.press('Enter'); await sleep(250);
      assert.equal(await page.locator('#kv-sto .f-rate').first().inputValue(), '6', 'the amount is worked out');
      assert.match(await focused(), /kv-sto f-item/, 'a new row after the last');
      assert.equal(await page.locator('#kv-sto .nrow').count(), 2);
      await page.keyboard.press('Enter'); await sleep(200);
      assert.equal(await page.locator('#kv-sto .nrow').count(), 2, 'an empty row adds no more');
      // imports: item → amount (one factory makes it), Enter → a new row
      await page.click('#add-from'); await sleep(200);
      await pickTyped('Iron Plate');
      assert.match(await focused(), /kv-from f-rate/);
      await page.keyboard.press('Enter'); await sleep(250);
      assert.match(await focused(), /kv-from f-item/);
      // a fixed-rate resource: resource → its rate → a new row
      await page.click('#add-res'); await sleep(200);
      await page.locator('#kv-res .n-ex').last().selectOption('fixed'); await sleep(200);
      await page.locator('#kv-res .n-res').last().click();
      await pickTyped('Limestone');
      assert.match(await focused(), /kv-res n-rate-in/, 'resource → its rate');
      await page.keyboard.type('120'); await page.keyboard.press('Enter'); await sleep(250);
      assert.match(await focused(), /kv-res n-res/);
      assert.equal(await page.locator('#kv-res .n-rate-in').first().inputValue(), '120');
    });
    await step('Backspace in an empty row takes it away; Enter in the single boxes goes on', async () => {
      const focused = () => page.evaluate(() => { const a = document.activeElement; return `${a.closest('[id^="kv-"]')?.id || a.id} ${a.className}`; });
      const rows = await page.locator('#kv-res .nrow').count();
      await page.keyboard.press('Backspace'); await sleep(250);              // the new, empty resource row
      assert.equal(await page.locator('#kv-res .nrow').count(), rows - 1);
      assert.match(await focused(), /kv-res n-rate-in/, 'back to the rate above');
      // goals: an empty last row adds no more; Backspace removes it
      await page.click('#add-max'); await sleep(200);
      await page.keyboard.type('Wire', { delay: 10 }); await sleep(250); await page.keyboard.press('Enter'); await sleep(200);
      await page.keyboard.type('9'); await page.keyboard.press('Enter'); await sleep(250);
      assert.equal(await page.locator('#kv-max .kvr').count(), 2, 'Enter after the last: a new row');
      await page.locator('#kv-max .kvr input[inputmode]').last().click(); await page.keyboard.press('Enter'); await sleep(200);
      assert.equal(await page.locator('#kv-max .kvr').count(), 2, 'not from an empty one');
      await page.locator('#kv-max .kvr input:not([inputmode])').last().click(); await page.keyboard.press('Backspace'); await sleep(250);
      assert.equal(await page.locator('#kv-max .kvr').count(), 1);
      assert.match(await focused(), /kv-max/, 'back to the amount above');
      await page.fill('#sc-name', ''); await page.click('#sc-name'); await page.keyboard.type('Keys');
      await page.keyboard.press('Enter'); assert.match(await focused(), /sc-desc/);
      await page.click('#sc-sh'); await page.keyboard.type('4'); await page.keyboard.press('Enter');
      assert.match(await focused(), /sc-sl/);
      await page.keyboard.press('Enter'); assert.match(await focused(), /sc-mp/);
    });

    await step('unsaved changes: a dot on the name and Save; asked before another factory replaces them', async () => {
      const dirty = () => page.locator('#btn-factories.dirty').count();
      const yes = d => d.accept();                              // if anything's unsaved from before: drop it
      page.on('dialog', yes);
      await page.keyboard.press('Control+o'); await page.waitForSelector('#fac-drawer.show .sv-row');
      await page.locator('.sv-row', { hasText: /^\W*iron/ }).locator('button').first().click(); await sleep(1200);
      page.off('dialog', yes);
      assert.equal(await dirty(), 0, 'just opened');
      await page.fill('#sc-desc', 'changed'); await page.dispatchEvent('#sc-desc', 'change'); await sleep(300);
      assert.equal(await dirty(), 1);
      assert.equal(await page.locator('#bsave.dirty').count(), 1);
      let asked = 0;
      const no = d => { asked++; d.dismiss(); };
      page.on('dialog', no);
      await page.keyboard.press('Control+o'); await page.waitForSelector('#fac-drawer.show .sv-row');
      await page.locator('.sv-row', { hasText: 'Typed' }).locator('button').first().click(); await sleep(800);
      page.off('dialog', no);
      assert.equal(asked, 1, 'asked once');
      assert.equal(await page.inputValue('#sc-name'), 'iron', 'kept on No');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+s'); await sleep(1000);
      assert.equal(await dirty(), 0, 'saved');
      await page.fill('#sc-desc', ''); await page.dispatchEvent('#sc-desc', 'change'); await page.keyboard.press('Control+s'); await sleep(900);
    });

    await step('Ctrl+Z undoes this factory\'s edits, step by step; Ctrl+Shift+Z redoes', async () => {
      const rows = () => page.evaluate(() => [...document.querySelectorAll('#kv-obj .kvr input')].filter(i => /Screw/.test(i.value)).length);
      const n0 = 0;
      await page.click('#add-obj'); await sleep(200);
      await page.keyboard.type('Screw', { delay: 10 }); await sleep(250); await page.keyboard.press('Enter'); await sleep(600);
      assert.equal(await rows(), n0 + 1);
      await page.fill('#sc-desc', 'undo me'); await page.dispatchEvent('#sc-desc', 'change'); await sleep(400);
      await page.mouse.click(700, 500);
      await page.keyboard.press('Control+z'); await sleep(300);
      assert.equal(await page.inputValue('#sc-desc'), '', 'the description back');
      assert.equal(await rows(), n0 + 1, 'one step at a time');
      await page.keyboard.press('Control+z'); await sleep(300);
      assert.equal(await rows(), n0, 'the goal gone');
      await page.keyboard.press('Control+Shift+z'); await sleep(300);
      assert.equal(await rows(), n0 + 1, 'redone');
      assert.equal(await page.locator('#bsave.dirty').count(), 1, 'an undo is a change');
    });

    if (errors.length) { failed++; log('FAIL page errors:\n     ' + errors.join('\n     ')); }
    await browser.close();
    log(failed ? `\n${failed} failed` : '\nall passed');
    stop(failed ? 1 : 0);
  } catch (e) {
    log('FAIL', e.stack || e);
    stop(1);
  }
};

// ── infeasible ──────────────────────────────────────────────
// A factory whose goals can't all be met, in a real browser on a throwaway
// planner: the solve says why (what's short, how much each goal can be),
// offers fixes, and one click on a fix makes it work.
SUITES.infeasible = async ({ B, api, chromium, stop, log }) => {

  let failed = 0;
  const step = async (name, fn) => {
    try { await fn(); log(`ok  ${name}`); } catch (e) { failed++; log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
  };

  try {
    await api('/api/progress', { machines: ['Smelter', 'Constructor', 'Assembler', 'Manufacturer', 'Refinery'] });
    await api('/api/scenarios/connectors', { name: 'Connectors', alternate_recipes_enabled: [], unlimited_resources: [],
      resource_nodes: [{ resource: 'Caterium_Ore', extractor: 'fixed', rate: 300 }, { resource: 'Copper_Ore', extractor: 'fixed', rate: 600 },
                       { resource: 'Iron_Ore', extractor: 'fixed', rate: 600 }, { resource: 'Crude_Oil', extractor: 'fixed', rate: 600 }],
      min_produce: { High_Speed_Connector: 10, Circuit_Board: 10 }, objective: { Wire: 1 } });

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(B + '/');
    await page.waitForFunction(() => document.querySelector('#bsolve'));
    await sleep(800);
    const solved = () => page.waitForFunction(() => !document.getElementById('bsolve').disabled, null, { timeout: 120000 });

    await step('solving says why it can\'t, on its own', async () => {
      await page.keyboard.press('Control+o'); await page.waitForSelector('#fac-drawer.show .sv-row'); await sleep(200);
      await page.locator('.sv-row', { hasText: 'Connectors' }).locator('button').first().click(); await sleep(900);
      await page.keyboard.press('Control+r'); await solved(); await sleep(400);
      await page.waitForSelector('#app.dk-open #dk-issues .wm-fix');   // the right panel opens on Issues by itself
      const t = await page.locator('#dk-issues').innerText();
      assert.match(t, /Not enough Caterium Ore: the goals need about [\d.,]+\/min more than the 300\/min it has/, t);
      assert.match(t, /High-Speed Connector: at most [\d.]+\/min with the other goals met/, t);
      assert.match(t, /Any one of these makes it work[\s\S]*Lower High-Speed Connector to [\d.]+\/min/i, t);
    });
    await step('Apply: the goal is lowered and it solves', async () => {
      await page.locator('.wm-fix-r', { hasText: 'Lower' }).locator('button').click();
      await solved(); await sleep(400);
      const v = +(await page.locator('#kv-min .kvr input[inputmode]').first().inputValue());
      assert.ok(v > 0 && v < 10, `lowered to ${v}`);
      assert.doesNotMatch(await page.locator('#rb').innerText(), /infeasible/i);
      // what's left to say is ordinary: a byproduct, not a reason it can't be made
      assert.doesNotMatch(await page.locator('#dk-issues').innerText(), /Not enough|at most|can't/);
    });

    if (errors.length) { failed++; log('FAIL page errors:\n     ' + errors.join('\n     ')); }
    await browser.close();
    log(failed ? `\n${failed} failed` : '\nall passed');
    stop(failed ? 1 : 0);
  } catch (e) {
    log('FAIL', e.stack || e);
    stop(1);
  }
};

// ── newalts ──────────────────────────────────────────────
// New alternates, in a real browser on a throwaway planner: after a solve the
// sidebar lists the alternates you haven't unlocked that the best plan would
// use, in unlock order with what each adds; tick and solve, untick and solve.
SUITES.newalts = async ({ B, api, chromium, stop, log }) => {

  let failed = 0;
  const step = async (name, fn) => {
    try { await fn(); log(`ok  ${name}`); } catch (e) { failed++; log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
  };

  try {
    await api('/api/scenarios/plates', { name: 'Plates', alternate_recipes_enabled: [], unlimited_resources: [],
      resource_nodes: [{ resource: 'Iron_Ore', extractor: 'fixed', rate: 480 }, { resource: 'Copper_Ore', extractor: 'fixed', rate: 240 }],
      objective: { Iron_Plate: 1 } });
    // already unlocked (nothing to do with plates): unlocking more must keep these
    const HAD = ['Alt_Turbo_Diamonds', 'Alt_Turbo_Heavy_Fuel'];
    await api('/api/unlocked-alts', { unlocked: HAD });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(B + '/');
    await page.waitForFunction(() => document.querySelector('#bsolve'));
    await sleep(800);
    const solved = () => page.waitForFunction(() => !document.getElementById('bsolve').disabled, null, { timeout: 120000 });
    const goal = () => page.evaluate(() => document.getElementById('rb').innerText);
    let before;

    await step('after a solve: new alternates on the right panel, in unlock order, with what each adds', async () => {
      await page.keyboard.press('Control+o'); await page.waitForSelector('#fac-drawer.show .sv-row'); await sleep(200);
      await page.locator('.sv-row', { hasText: 'Plates' }).locator('button').first().click(); await sleep(900);
      await page.keyboard.press('Control+r'); await solved(); await sleep(300);
      before = await goal();
      await page.keyboard.press('2');
      await page.waitForFunction(() => document.querySelectorAll('#new-alts .na-row').length > 0, null, { timeout: 60000 });
      const t = await page.locator('#new-alts').innerText();
      assert.match(t, /With all \d+:\s+\+[\d.]+% output/, t);
      assert.match(await page.locator('#new-alts .na-row').first().innerText(), /\+[\d.]+% output/);
      assert.equal(await page.locator('#dk-alts #new-alts').count(), 1, 'on the right panel');
    });
    await step('the count is on the Alternates tab; the results bar leaves it there', async () => {
      assert.match(await page.locator('#dkb-alts').innerText(), /^\d+$/);
      const bar = await page.locator('#rb').innerText();
      assert.doesNotMatch(bar, /new alts|maxed/i, bar);
      assert.match(bar, /POWER USE/i, bar);
      await page.keyboard.press('2'); await sleep(200);   // closes it
      assert.equal(await page.locator('#new-alts .na-row').first().isVisible(), false);
      await page.keyboard.press('2'); await sleep(300);
      assert.equal(await page.locator('#new-alts .na-row').first().isVisible(), true);
    });
    await step('tick one, Solve with these: more output, and it is on for this factory; untick: back', async () => {
      const box = page.locator('#new-alts input[data-k]').first();
      const key = await box.getAttribute('data-k');
      await box.check(); await sleep(150);
      assert.equal(await page.locator('#na-solve').isEnabled(), true);
      await page.click('#na-solve'); await solved(); await sleep(400);
      assert.notEqual(await goal(), before, 'the plan changed');
      await page.waitForFunction(() => document.querySelector('#na-solve')?.disabled === true, null, { timeout: 60000 });
      await page.keyboard.press('Control+s'); await sleep(900);
      assert.ok((await api('/api/scenarios/plates')).alternate_recipes_enabled.includes(key), `${key} on for this factory`);
      await page.waitForFunction(k => document.querySelector(`#new-alts input[data-k="${k}"]`)?.checked, key, { timeout: 60000 });
      await page.locator(`#new-alts input[data-k="${key}"]`).uncheck();
      await page.click('#na-solve'); await solved(); await sleep(400);
      assert.equal(await goal(), before, 'back to the plan without it');
    });
    await step('the analysis has no alternate sections', async () => {
      await page.keyboard.press('Control+i'); await sleep(1500);
      assert.doesNotMatch(await page.locator('#analysis-body').innerText(), /Alternates (Worth Unlocking|This Plan Uses)|Alternate Recipe Value/i);
      assert.match(await page.locator('#dk-title').innerText(), /Analysis/i);
      assert.doesNotMatch(await page.locator('#analysis-body').innerText(), /Other limits|Solver pruning|Shards used|Sloops used/i);
    });
    await step('the Alternates tab: suggestions, then the solver\'s pruning; no list of every alternate', async () => {
      await page.keyboard.press('2'); await sleep(400);
      const tab = await page.locator('#dk-alts').innerText();
      assert.doesNotMatch(tab, /On in this factory|Enable all/i);
      assert.equal(await page.locator('#altspanel').count(), 0);
      const pr = await page.locator('#prune-box').innerText();
      assert.match(pr, /Every recipe in the game\s+\d+[\s\S]*Into the solver\s+\d+[\s\S]*In the plan\s+\d+/i, pr);
      assert.match(pr, /\d+% cut before solving · solved in [\d.]+ (ms|s)/i, pr);
      const n = pr.match(/Every recipe in the game\s+(\d+)[\s\S]*Allowed by your unlocks\s+(\d+)[\s\S]*Makeable from your resources\s+(\d+)[\s\S]*On a path to your goals\s+(\d+)[\s\S]*Into the solver\s+(\d+)/i).slice(1).map(Number);
      assert.deepEqual([...n].sort((a, b) => b - a), n, `each step keeps no more than the one before: ${n}`);
      // below the suggestions
      const [na, pb] = await Promise.all(['#new-alts', '#prune-box'].map(q => page.locator(q).boundingBox()));
      assert.ok(pb.y > na.y + na.height - 1);
    });
    let tried;
    await step('the Unlocks window: closing it without saving changes nothing', async () => {
      await page.keyboard.press('Control+u'); await page.click('#btn-hd-manage'); await page.waitForSelector('#unlocked-modal [data-k]');
      const row = page.locator('#unlocked-modal [data-k]').filter({ hasNotText: 'Turbo' }).first();
      tried = await row.getAttribute('data-k');
      await row.click(); await page.click('#unlocked-modal-x'); await sleep(200);
      await page.keyboard.press('Escape'); await sleep(200);
      assert.ok(!(await api('/api/unlocked-alts')).unlocked.includes(tried));
    });
    await step('Unlock ticked: unlocked for every factory, re-solved, no longer suggested', async () => {
      const box = page.locator('#new-alts input[data-k]').first();
      const key = await box.getAttribute('data-k');
      await box.check(); await sleep(150);
      assert.match(await page.locator('#na-unlock').innerText(), /Unlock ticked \(1\)/);
      await page.click('#na-unlock');
      await page.waitForFunction(() => document.getElementById('bsolve').disabled, null, { timeout: 5000 }).catch(() => {});
      await solved(); await sleep(300);
      const now = (await api('/api/unlocked-alts')).unlocked;
      assert.ok(now.includes(key), `${key} unlocked`);
      for (const k of HAD) assert.ok(now.includes(k), `${k} still unlocked — on top, not instead`);
      assert.ok(!now.includes(tried), `${tried} was ticked in the Unlocks window, not saved: not unlocked`);
      await page.waitForFunction(k => document.querySelectorAll('#new-alts .na-row').length > 0 || /None you haven't/.test(document.getElementById('new-alts').innerText), key, { timeout: 60000 });
      assert.equal(await page.locator(`#new-alts input[data-k="${key}"]`).count(), 0, 'not suggested once unlocked');
    });

    if (errors.length) { failed++; log('FAIL page errors:\n     ' + errors.join('\n     ')); }
    await browser.close();
    log(failed ? `\n${failed} failed` : '\nall passed');
    stop(failed ? 1 : 0);
  } catch (e) {
    log('FAIL', e.stack || e);
    stop(1);
  }
};

// ── tree ──────────────────────────────────────────────
// The goal tree, in a real browser on a throwaway planner: resources grow
// into columns of what they can become; a tile sets its goal and storage;
// what's next says what a part needs and takes a supply for it; the tier
SUITES.tree = async ({ B, api, chromium, stop, log }) => {

  let failed = 0;
  const step = async (name, fn) => {
    try { await fn(); log(`ok  ${name}`); } catch (e) {
      failed++; log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`);
      await globalThis.PAGE?.screenshot({ path: (process.env.TMPDIR || '/tmp') + `/tree-fail-${failed}.png` }).catch(() => {});
    }
  };

  try {
    const fixed = (resource, rate) => ({ resource, extractor: 'fixed', rate });
    await api('/api/scenarios/tree', { name: 'Tree', alternate_recipes_enabled: [], unlimited_resources: [],
      resource_nodes: [fixed('Iron_Ore', 480), fixed('Coal', 240), fixed('Caterium_Ore', 120), fixed('Sulfur', 120)] });

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    globalThis.PAGE = page;
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.stack || e)));
    await page.goto(B + '/');
    await page.waitForFunction(() => document.querySelector('#bsolve'));
    await sleep(800);
    const tile = i => page.locator(`#gt .gt-t[data-i="${i}"]`);
    const real = async i => (await tile(i).count()) && !(await tile(i).evaluate(e => e.classList.contains('gh')));
    const rows = id => page.evaluate(id => [...document.querySelectorAll(`#${id} .kvr`)].map(r => [...r.querySelectorAll('input')].map(i => i.value).join('=')), id);

    await step('a factory with no plan opens on its tree: resources, then what they make, column by column', async () => {
      await page.keyboard.press('Control+o'); await page.waitForSelector('#fac-drawer.show .sv-row');
      await page.locator('.sv-row', { hasText: 'Tree' }).locator('button').first().click(); await sleep(900);
      assert.equal(await page.locator('#gt.show').count(), 1, 'the Tree view');
      for (const i of ['Iron_Ore', 'Iron_Ingot', 'Steel_Ingot', 'Steel_Beam', 'Quickwire', 'Black_Powder']) assert.ok(await real(i), i);
      assert.equal(await tile('Computer').count(), 0, 'no plastic: no computers');
      const x = async i => (await tile(i).boundingBox()).x;
      assert.ok(await x('Iron_Ore') < await x('Iron_Ingot') && await x('Iron_Ingot') < await x('Steel_Beam'), 'deeper is further right');
      assert.match(await tile('Coal').innerText(), /240\/min/);
    });
    await step('a tile sets its goals and storage — several at once: maximize with a floor, a range', async () => {
      await tile('Steel_Beam').click(); await page.waitForSelector('#gt-pop .gp-g');
      await page.fill('#gt-pop [data-f="min"]', '10');                    // typing ticks it
      await page.fill('#gt-pop [data-f="sto"]', '2'); await page.click('#gt-pop [data-a="apply"]'); await sleep(300);
      assert.deepEqual(await rows('kv-min'), ['Steel Beam=10']);
      assert.match(await tile('Steel_Beam').innerText(), /≥10[\s\S]*📦2/);
      await tile('Steel_Pipe').click();
      await page.fill('#gt-pop [data-f="min"]', '5'); await page.fill('#gt-pop [data-f="max"]', '4*5'); await page.press('#gt-pop [data-f="max"]', 'Enter'); await sleep(300);
      assert.deepEqual(await rows('kv-max'), ['Steel Pipe=20']);
      assert.ok((await rows('kv-min')).includes('Steel Pipe=5'));
      assert.match(await tile('Steel_Pipe').innerText(), /5–20/);
      // maximize it, but never let the weights take it below 30
      await tile('Quickwire').click(); await page.check('#gt-pop [data-on="obj"]');
      await page.fill('#gt-pop [data-f="min"]', '30'); await page.click('#gt-pop [data-a="apply"]'); await sleep(300);
      assert.deepEqual(await rows('kv-obj'), ['Quickwire=1']);
      assert.ok((await rows('kv-min')).includes('Quickwire=30'));
      assert.match(await tile('Quickwire').innerText(), /max[\s\S]*≥30/);
      // exactly stands alone: ticking it clears the others
      await tile('Quickwire').click(); await page.check('#gt-pop [data-on="must"]');
      assert.equal(await page.isChecked('#gt-pop [data-on="obj"]'), false);
      assert.equal(await page.isChecked('#gt-pop [data-on="min"]'), false);
      await page.click('#gt-pop [data-a="close"]');
      const s = await page.evaluate(() => [...document.querySelectorAll('#kv-sto .f-item')].map(i => i.value));
      assert.deepEqual(s, ['Steel Beam']);
    });
    await step('what\'s next: faded, left out of the fit; a part says what it needs, and a supply brings it in reach', async () => {
      await page.check('#gt-next'); await sleep(300);
      assert.ok(await tile('Computer').count(), 'computers, faded');
      assert.equal(await tile('Computer').evaluate(e => e.classList.contains('gh')), true);
      await tile('Computer').click(); await sleep(250);
      const t = await page.locator('#gt-pop').innerText();
      assert.match(t, /Plastic/, t);
      await page.waitForSelector('#gt-pop .gn-list [data-bring="Plastic"]:not([data-fac])');   // the solver's answer
      await page.locator('#gt-pop .gn-list [data-bring="Plastic"]:not([data-fac])').first().click(); await sleep(400);
      assert.ok(await real('Plastic'), 'Plastic is a resource now');
      const res = await page.evaluate(() => [...document.querySelectorAll('#kv-res .n-res')].map(i => i.value));
      assert.ok(res.includes('Plastic'), res.join(','));
      await page.keyboard.press('Escape'); await sleep(150);
      assert.equal(await page.locator('#gt-pop').isVisible(), false);
    });
    await step('⟳ on a tile cycles its alternates, 1/N … N/N, then none; the pick is saved and offered to the solver', async () => {
      const c = tile('Iron_Ingot').locator('.gc');
      const n = +(await c.innerText()).replace('⟳', '');
      assert.ok(n >= 2, `${n} alternates`);
      await c.click(); await sleep(150);
      assert.equal(await tile('Iron_Ingot').locator('.gc').innerText(), `1/${n}`);
      for (let i = 1; i < n; i++) { await tile('Iron_Ingot').locator('.gc').click(); await sleep(100); }
      assert.equal(await tile('Iron_Ingot').locator('.gc').innerText(), `${n}/${n}`);
      await tile('Iron_Ingot').locator('.gc').click(); await sleep(150);
      assert.equal(await tile('Iron_Ingot').locator('.gc').innerText(), `⟳${n}`, 'past the last: none');
      // in the popover: every recipe, pick one there
      await tile('Iron_Ingot').click(); await page.waitForSelector('#gt-pop .gp-r');
      assert.equal(await page.locator('#gt-pop .gp-r').count(), n + 1);
      await page.locator('#gt-pop .gp-r').nth(2).locator('[data-pick]').check(); await sleep(200);
      assert.equal(await tile('Iron_Ingot').locator('.gc').innerText(), `2/${n}`);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+s'); await sleep(900);
      const picked = (await api('/api/scenarios/tree')).recipe_picks.Iron_Ingot;
      assert.ok(picked && picked.startsWith('Alt_'), picked);
    });
    await step('a faded part an alternate gets to from what you have: use it, and it\'s on the tree', async () => {
      assert.ok(!(await real('Wire')), 'no copper: no wire');
      await tile('Wire').click(); await page.waitForSelector('#gt-pop .gn-via');
      assert.match(await page.locator('#gt-pop .gn-via').innerText(), /Wire/);
      await page.click('#gt-pop [data-via]'); await sleep(300);
      assert.ok(await real('Wire'), 'made with an alternate now');
      assert.ok(await tile('Wire').locator('.gc.on').count(), 'picked on its tile');
      await page.keyboard.press('Escape');
    });
    await step('the solver says what to bring in for a faded part, for the amount in its goal', async () => {
      await tile('Computer').click(); await page.waitForFunction(() => !/Working/.test(document.querySelector('#gt-pop .gn-list')?.innerText || 'Working'));
      assert.match(await page.locator('#gt-pop .gn-list').innerText(), /Circuit Board|Plastic/);
      await page.fill('#gt-pop [data-f="must"]', '5'); await page.locator('#gt-pop [data-f="must"]').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelector('#gt-pop [data-need]')?.textContent === '5'
        && !/Working/.test(document.querySelector('#gt-pop .gn-list')?.innerText || 'Working'));
      assert.match(await page.locator('#gt-pop .gn-list').innerText(), /\d+\/min/);
      await page.keyboard.press('Escape');
    });
    await step('Unlocks: tier 2 — steel waits on Tier 3; the tree and the solver follow; All: back', async () => {
      await page.keyboard.press('Control+u'); await page.waitForSelector('.pg-t');
      await page.click('.pg-t[data-t="2"]'); await sleep(300);
      assert.match(await page.locator('.pg-sub').innerText(), /Assembler/, 'a sub-tier says what it gives');
      const p = await api('/api/progress');
      assert.ok(p.schematics.includes('Schematic_2-1') && !p.schematics.includes('Schematic_3-4'));
      assert.ok(!p.machines.includes('Foundry'), 'the Foundry is Tier 3');
      await page.keyboard.press('Escape'); await sleep(300);
      assert.ok(!(await real('Steel_Ingot')), 'no steel at tier 2');
      await page.keyboard.press('Control+u'); await page.click('.pg-t[data-t="none"]'); await sleep(300);
      assert.equal((await api('/api/progress')).schematics, null);
      assert.ok((await api('/api/progress')).machines.includes('Foundry'), 'All: every machine too');
      await page.keyboard.press('Escape'); await sleep(300);
      assert.ok(await real('Steel_Ingot'));
    });
    await step('solve: the plan shows; T goes back to the tree', async () => {
      await page.keyboard.press('Control+r');
      await page.waitForFunction(() => !document.getElementById('bsolve').disabled, null, { timeout: 120000 }); await sleep(500);
      assert.equal(await page.locator('#gt.show').count(), 0, 'the plan');
      await page.click('#btn-tree'); await sleep(300);
      assert.ok(await page.locator('#gt .gt-s.pl').count() > 0, 'rates from the plan on the tiles');
      assert.ok(await page.locator('#gt .gt-l.pl').count() > 0, 'the plan\'s links lit');
      await tile('Steel_Beam').click(); await page.waitForSelector('#gt-pop .gp-used');
      await page.keyboard.press('Escape'); await page.click('#gt-close'); await sleep(150);
      await page.mouse.click(800, 500); await page.keyboard.press('t'); await sleep(200);
      assert.equal(await page.locator('#gt.show').count(), 1);
      await page.click('#gt-close'); await sleep(150);
      assert.equal(await page.locator('#gt.show').count(), 0, '✕ Plan');
      await page.click('#btn-tree'); await sleep(150);
      assert.equal(await page.locator('#gt.show').count(), 1, 'the Goals section\'s button');
      assert.equal(await page.locator('#gv-seg').count(), 0, 'no switch in the plan space');
    });

    await step('miners: one built at Mk.2 stays Mk.2, says what Mk.3 gives, and upgrades when told', async () => {
      const ids = (await api('/api/map-nodes')).nodes.filter(n => n.r === 'Iron_Ore' && !n.w && n.p === 'pure').slice(0, 2).map(n => n.id);
      await api('/api/scenarios/old_mine', { name: 'Old mine', miner: 'Mk2', alternate_recipes_enabled: [], unlimited_resources: [],
        resource_nodes: [{ resource: 'Iron_Ore', extractor: 'Miner', nodes: ids }], objective: { Iron_Ingot: 1 } });
      page.once('dialog', d => d.accept());
      await page.keyboard.press('Control+o'); await page.waitForSelector('#fac-drawer.show .sv-row');
      assert.match(await page.locator('.sv-row', { hasText: 'Old mine' }).innerText(), /⛏ Mk\.2/, 'the drawer says so');
      await page.locator('.sv-row', { hasText: 'Old mine' }).locator('button').first().click(); await sleep(900);
      const note = page.locator('#kv-res .n-up');
      assert.match(await note.innerText(), /2 miners are Mk\.2[\s\S]*Mk\.3 gives \+480 Iron Ore/);
      assert.match(await page.locator('#kv-res .nrow-c').first().innerText(), /Iron Ore[\s\S]*2P[\s\S]*480\/min/, "one line: name, purity, rate");
      await note.locator('button').click(); await sleep(300);
      assert.equal(await page.locator('#kv-res .n-up').count(), 0);
      assert.match(await page.locator("#kv-res .nrow-c").first().innerText(), /960\/min/);
      await page.keyboard.press('Control+s'); await sleep(900);
      assert.equal((await api('/api/scenarios/old_mine')).miner, 'Mk3');
    });

    if (errors.length) { failed++; log('FAIL page errors:\n     ' + errors.join('\n     ')); }
    await browser.close();
    log(failed ? `\n${failed} failed` : '\nall passed');
    stop(failed ? 1 : 0);
  } catch (e) {
    log('FAIL', e.stack || e);
    stop(1);
  }
};

// ── build ──────────────────────────────────────────────
// From plan to building, in a real browser on a throwaway planner: the build
// sheet (lines in build order, clocks, belts, a split per input, large on a
// click), and Analysis's limit with the nearest free nodes — Add & solve.
SUITES.build = async ({ B, api, chromium, stop, log }) => {

  let failed = 0;
  const step = async (name, fn) => {
    try { await fn(); log(`ok  ${name}`); } catch (e) { failed++; log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
  };

  try {
    // two normal iron nodes side by side: ore is what limits plates
    const iron = (await api('/api/map-nodes')).nodes.filter(n => n.r === 'Iron_Ore' && !n.w).slice(0, 2).map(n => n.id);
    await api('/api/scenarios/plates', { name: 'Plates', resource_nodes: [{ resource: 'Iron_Ore', extractor: 'Miner', nodes: iron }],
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

    await step('build sheet: each line in build order, its clocks and belts', async () => {
      await page.click('#dk-rail [data-dk="build"]'); await page.waitForSelector('.bs-l');
      const lines = await page.locator('.bs-l .bs-n').allInnerTexts();
      assert.deepEqual(lines, ['Iron Ingot', 'Iron Plate'], 'smelting first');
      const ingot = await page.locator('.bs-l').first().innerText();
      assert.match(ingot, /× 100%/); assert.match(ingot, /Iron Ore\s+480\/min/); assert.match(ingot, /Mk\.4 belt/);
    });
    await step('⑂: how the belt feeds the machines, in words — a manifold, or a balancer as a repeating split; drawn on asking', async () => {
      await page.locator('.bs-sp').first().click(); await page.waitForSelector('.bs-d .fd-w');
      const t = await page.locator('.bs-d').first().innerText();
      assert.match(t, /Iron Ore 480\/min → 16 Smelters, 30\/min each/);
      assert.match(t, /manifold/);
      assert.match(t, /2 ways, four times over[\s\S]*1 → 2 → 4 → 8 → 16 belts of 30\/min — one per Smelter/);
      assert.match(t, /15 splitters/);
      assert.equal(await page.locator('.bs-d svg').count(), 0, 'no drawing in the side panel');
      await page.locator('.bs-d .fd-draw').first().click(); await page.waitForSelector('#sp-full.show svg');
      assert.match(await page.locator('#sp-full-t').innerText(), /Iron Ore 480\/min → 16 × Smelter/);
      await page.keyboard.press('Escape'); await sleep(200);
      assert.equal(await page.locator('#sp-full.show').count(), 0);
    });
    await step('Analysis: the limit lists the nearest free nodes; Add & solve takes one', async () => {
      await page.click('#dk-rail [data-dk="analysis"]'); await page.waitForSelector('.an-node', { timeout: 20000 });
      const first = await page.locator('.an-node').first().innerText();
      assert.match(first, /\d+ m · \+\d+\/min[\s\S]*Iron Plate/, first);
      await page.locator('.an-node [data-take]').first().click();
      await page.waitForFunction(() => /3N/.test(document.getElementById('kv-res')?.innerText || ''), null, { timeout: 30000 });
      await page.waitForFunction(() => /480/.test(document.getElementById('rb')?.innerText || ''), null, { timeout: 60000 });
    });

    await step('the network on the map: factories where their nodes are, routes between them', async () => {
      const cu = (await api('/api/map-nodes')).nodes.filter(n => n.r === 'Copper_Ore' && !n.w).slice(-2).map(n => n.id);
      await api('/api/scenarios/wires', { name: 'Wires', resource_nodes: [{ resource: 'Copper_Ore', extractor: 'Miner', nodes: cu }],
        from_factories: [{ item: 'Iron_Plate', factory: 'plates', rate: 60 }], objective: { Wire: 1 } });
      await api('/api/blackboard', { positions: {}, routes: [{ a: 'plates', b: 'wires', mode: 'drone', trip_min: 3 }] });
      await page.click('#btn-blackboard'); await sleep(900);
      await page.click('#bb-tabs [data-tab="map"]'); await page.waitForSelector('#bb-map .mp-hub');
      assert.equal(await page.locator('#bb-map .mp-hub').count(), 2);
      assert.equal(await page.locator('#bb-map .mp-rt.drone').count(), 1);
      assert.match(await page.locator('#bb-map .mp-rt-lbl').textContent(), /60\/min/);
      await page.keyboard.press('Escape');
    });

    await step('shards and sloops across the factories: where they do the most, then written in', async () => {
      await page.keyboard.press('Control+o'); await page.waitForSelector('#sv-spread');
      await page.click('#sv-spread'); await page.waitForSelector('#spr-sh');
      await page.fill('#spr-sh', '12'); await page.fill('#spr-sl', '4'); await page.click('#spr-go');
      await page.waitForFunction(() => /→/.test(document.getElementById('sp-full-b')?.innerText || ''));
      assert.match(await page.locator('#sp-full-b').innerText(), /Plates[\s\S]*\+\d/);
      await page.click('#spr-apply'); await page.waitForFunction(() => /Saved into/.test(document.getElementById('sp-full-b')?.innerText || ''));
      const p = await api('/api/scenarios/plates');
      assert.ok((p.somersloops_available || 0) + (p.power_shards_available || 0) > 0, 'written into the factory');
      await page.keyboard.press('Escape');
    });

    if (errors.length) { failed++; log('FAIL page errors:\n     ' + errors.join('\n     ')); }
    await browser.close();
    log(failed ? `\n${failed} failed` : '\nall passed');
    stop(failed ? 1 : 0);
  } catch (e) {
    log('FAIL', e.stack || e);
    stop(1);
  }
};

// ── improve ──────────────────────────────────────────────
// Solving by itself, a machine cap, a save's machines on the build sheet,
// alternates ranked across factories, heavy routes, growing every goal and a
// stacked floor plan — in a real browser on a throwaway planner.
SUITES.improve = async ({ B, api, chromium, stop, log }) => {

  let failed = 0;
  const step = async (name, fn) => {
    try { await fn(); log(`ok  ${name}`); } catch (e) { failed++; log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
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

    if (errors.length) { failed++; log('FAIL page errors:\n     ' + errors.join('\n     ')); }
    await browser.close();
    log(failed ? `\n${failed} failed` : '\nall passed');
    stop(failed ? 1 : 0);
  } catch (e) {
    log('FAIL', e.stack || e);
    stop(1);
  }
};

// ── The run ──────────────────────────────────────────────────────────────────
const freePort = () => new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const AT_ONCE = Math.max(1, Math.min(3, (await import('node:os')).cpus().length - 1));
const pick = process.argv.slice(2), names = pick.length ? pick : Object.keys(SUITES);
const shared = await playwright.chromium.launch();
async function run(name) {
  const port = await freePort(), B = `http://127.0.0.1:${port}`, lines = [];
  const srv = spawn('python', ['-c', SERVE, String(port)], { cwd: ROOT, stdio: 'ignore' });
  const api = (p, body) => fetch(B + p, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  for (let i = 0; ; i++) { try { await fetch(B + '/api/progress'); break; } catch { if (i > 150) throw new Error('server did not start'); await sleep(100); } }
  const pages = [];
  // the section's own "browser": pages in the shared one, closed when it's done
  const chromium = { launch: async () => ({
    newPage: async o => { const c = await shared.newContext(o); const p = await c.newPage(); pages.push(c); return p; },
    close: async () => { await Promise.all(pages.map(c => c.close().catch(() => {}))); } }) };
  const t0 = Date.now();
  const code = await new Promise(res => SUITES[name]({ B, api, chromium, stop: res, log: (...a) => lines.push(a.join(' ')) })
    .catch(e => { lines.push('FAIL ' + (e.stack || e)); res(1); }));
  srv.kill();
  await Promise.all(pages.map(c => c.close().catch(() => {})));
  console.log(`\n== ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n${lines.join('\n')}`);
  return code;
}
const bad = [];
const queue = [...names];
await Promise.all([...Array(AT_ONCE)].map(async () => {
  while (queue.length) { const n = queue.shift(); if (!SUITES[n]) { console.log(`no section "${n}"`); bad.push(n); continue; } if (await run(n)) bad.push(n); }
}));
await shared.close();
console.log(bad.length ? `\nFAILED: ${bad.join(', ')}` : `\nall ${names.length} sections passed`);
process.exit(bad.length ? 1 : 0);
