// Unused node supply, in a real browser on a throwaway planner: a factory that
// mines more than its plan uses shows "+N unused" on its nodes; another factory
// picking nodes brings some of it over as an import, and leaves the rest.
// Needs Playwright; skips without it.   node tests/spare.e2e.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire((process.env.NPM_ROOT || process.cwd()) + '/');
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('skip: Playwright not installed'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5000 + Math.floor(Math.random() * 900) + 60;
const B = `http://127.0.0.1:${PORT}`;
const srv = spawn('python', ['-m', 'tests.serve_temp', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const stop = code => { srv.kill(); process.exit(code); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (p, body) => fetch(B + p, body === undefined ? {} : {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
async function solveAndSave(key, sc) {
  await api(`/api/scenarios/${key}`, sc);
  const { job_id } = await api('/api/solve', { ...sc, solve_styles: [], base_scenario: sc });
  for (;;) { const r = await api(`/api/solve/${job_id}`); if (r.status !== 'pending') return r.result; await sleep(150); }
}

let failed = 0;
const step = async (name, fn) => {
  try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
};

try {
  for (let i = 0; ; i++) { try { await fetch(B + '/api/progress'); break; } catch { if (i > 100) throw new Error('server did not start'); await sleep(100); } }
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
  await step('picking nodes: its nodes say "+N unused", and the side lists it', async () => {
    await page.fill('#sc-name', 'Next door'); await page.dispatchEvent('#sc-name', 'change');
    await page.keyboard.press('Control+m'); await page.waitForSelector('#mp-map [data-id]'); await sleep(300);
    await page.click('.mp-f[data-r="Iron_Ore"]'); await sleep(200);
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
    await page.click('.mp-f[data-r="Iron_Ore"]'); await sleep(200);
    assert.match(await page.locator('#mp-map .mp-spare').textContent(), /→ 20 of/);         // its own share shows as brought
    await page.locator('#mp-spare button').first().click(); await sleep(100);             // leave it there
    await page.click('#mp-apply'); await sleep(300);
    assert.equal(await page.locator('#kv-from .f-rate').count(), 0);
  });
  await step('the Blackboard\'s map shows what\'s unused', async () => {
    await page.keyboard.press('Alt+6'); await page.waitForSelector('.mp-view [data-id]'); await sleep(400);
    await page.click('.mp-filters .mp-f[data-r="Iron_Ore"]'); await sleep(200);
    assert.match(await page.locator('.mp-view .mp-spare').textContent(), /unused/);
    assert.match(await page.locator('.mp-legend').innerText(), /Unused at factories[\s\S]*Iron intermediate/);
  });

  if (errors.length) { failed++; console.log('FAIL page errors:\n     ' + errors.join('\n     ')); }
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  stop(failed ? 1 : 0);
} catch (e) {
  console.log('FAIL', e.stack || e);
  stop(1);
}
