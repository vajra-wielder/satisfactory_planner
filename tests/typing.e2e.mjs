// Typing into the sidebar's boxes, in a real browser on a throwaway planner:
// an item typed (not picked from the list) stays when you click away, add a
// row or save, and is saved as the item; a misspelt one stays, marked; the
// rate you type is the rate saved. Needs Playwright; skips without it.
//   node tests/typing.e2e.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire((process.env.NPM_ROOT || process.cwd()) + '/');
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('skip: Playwright not installed'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5000 + Math.floor(Math.random() * 900) + 70;
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

try {
  for (let i = 0; ; i++) { try { await fetch(B + '/api/progress'); break; } catch { if (i > 100) throw new Error('server did not start'); await sleep(100); } }
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

  if (errors.length) { failed++; console.log('FAIL page errors:\n     ' + errors.join('\n     ')); }
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  stop(failed ? 1 : 0);
} catch (e) {
  console.log('FAIL', e.stack || e);
  stop(1);
}
