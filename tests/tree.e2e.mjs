// The goal tree, in a real browser on a throwaway planner: resources grow
// into columns of what they can become; a tile sets its goal and storage;
// what's next says what a part needs and takes a supply for it; the tier
// and its sub-tiers set in Unlocks prune it.   node tests/tree.e2e.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
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
  try { await fn(); console.log(`ok  ${name}`); } catch (e) {
    failed++; console.log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`);
    await globalThis.PAGE?.screenshot({ path: (process.env.TMPDIR || '/tmp') + `/tree-fail-${failed}.png` }).catch(() => {});
  }
};

try {
  for (let i = 0; ; i++) { try { await fetch(B + '/api/progress'); break; } catch { if (i > 100) throw new Error('server did not start'); await sleep(100); } }
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

  if (errors.length) { failed++; console.log('FAIL page errors:\n     ' + errors.join('\n     ')); }
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  stop(failed ? 1 : 0);
} catch (e) {
  console.log('FAIL', e.stack || e);
  stop(1);
}
