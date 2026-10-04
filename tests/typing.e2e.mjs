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

  if (errors.length) { failed++; console.log('FAIL page errors:\n     ' + errors.join('\n     ')); }
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  stop(failed ? 1 : 0);
} catch (e) {
  console.log('FAIL', e.stack || e);
  stop(1);
}
