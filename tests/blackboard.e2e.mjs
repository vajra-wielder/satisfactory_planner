// The Blackboard in a real browser, on a throwaway planner (tests/serve_temp.py):
// three linked factories, then every tab. Needs Playwright; skips without it.
//   node tests/blackboard.e2e.mjs            (NPM_ROOT=… if Playwright isn't global)
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
    if (r.status !== 'pending') { assert.ok(String(r.result.status).startsWith('Optimal'), `${key}: ${r.result.status}`); return r.result; }
    await sleep(150);
  }
}

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

try {
  for (let i = 0; ; i++) { try { await fetch(B + '/api/progress'); break; } catch { if (i > 100) throw new Error('server did not start'); await sleep(100); } }
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

  await page.locator('#bb-box').screenshot({ path: path.join(process.env.TMPDIR || '/tmp', 'blackboard-routes.png') });
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
    await page.locator('#bb-box').screenshot({ path: path.join(process.env.TMPDIR || '/tmp', 'blackboard-flows.png') });
    assert.equal(await page.locator('#bb-sankey .sk-band').count(), 2);        // iron→frames, iron→storage
    assert.equal(await page.locator('#bb-sankey .sk-link').count(), 4);        // 3 + the stored rods
    const labels = await page.$$eval('#bb-sankey .sk-lab', ls => ls.map(l => l.textContent));
    assert.ok(labels.some(l => /3 items · 95\/min/.test(l)), labels.join(' | '));
  });
  check('storage lists what is stored', async () => {
    await page.click('#bb-tabs button[data-tab="storage"]'); await sleep(200);
    assert.match(await page.locator('#bb-storage').innerText(), /Iron Rod\s+10\s+600/);
  });
  check('power, build list and map render', async () => {
    await page.click('#bb-tabs button[data-tab="power"]'); await sleep(200);
    assert.match(await page.locator('#bb-power').innerText(), /Grid:/);
    await page.click('#bb-tabs button[data-tab="build"]'); await page.waitForSelector('.bl-pick');
    assert.match(await page.locator('#bb-build').innerText(), /Smelter/);
    await page.click('#bb-tabs button[data-tab="map"]'); await page.waitForSelector('#bb-map svg');
    assert.ok(await page.locator('#bb-map [data-id]').count() > 500);
  });
  check('planning the network redraws the band from the plan', async () => {
    await page.click('#bb-tabs button[data-tab="factories"]'); await sleep(200);
    await page.click('#bb-plan');
    await page.waitForFunction(() => /Network plan|can't/.test(document.getElementById('bb-net')?.innerText || ''), null, { timeout: 60000 });
    assert.match(await page.locator('#bb-net').innerText(), /Network plan/);
    assert.ok(await page.locator('.bb-band .bb-stripe').count() >= 1);
    assert.match(await page.locator('.bb-route-load').innerText(), /cars|lanes|trucks|drones/);   // the route's load
  });

  let failed = 0;
  for (const [name, fn] of checks) {
    try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
  }
  if (errors.length) { failed++; console.log('FAIL page errors:\n     ' + errors.join('\n     ')); }
  await page.screenshot({ path: path.join(process.env.TMPDIR || '/tmp', 'blackboard-e2e.png') });
  await browser.close();
  console.log(`\n${checks.length - Math.min(failed, checks.length)} of ${checks.length} passed${errors.length ? ', with page errors' : ''}`);
  stop(failed ? 1 : 0);
} catch (e) {
  console.log('FAIL', e.stack || e);
  stop(1);
}
