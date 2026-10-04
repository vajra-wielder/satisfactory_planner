// Getting around, in a real browser on a throwaway planner: the Go-to palette,
// stepping through the systems with keys and the wheel, factories one after
// another, the shortcuts sheet, Esc, and the maps' keys and detail levels.
// Needs Playwright; skips without it.   node tests/nav.e2e.mjs
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
  try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
};

try {
  for (let i = 0; ; i++) { try { await fetch(B + '/api/progress'); break; } catch { if (i > 100) throw new Error('server did not start'); await sleep(100); } }
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
    assert.equal(await bbTab(), 'build');
    await page.keyboard.press('Alt+ArrowLeft'); await page.keyboard.press('Alt+ArrowLeft'); await sleep(300);
    assert.equal(await bbTab(), 'storage');
    assert.match(await page.locator('#nav-ring').innerText(), /Planner[\s\S]*Storage[\s\S]*Inside a factory/);
    await page.keyboard.press('Alt+1'); await sleep(300);
    assert.equal(await bbOpen(), false);
    await page.keyboard.press('Alt+ArrowLeft'); await sleep(300);              // round the ring
    assert.equal(await bbTab(), 'splits');
  });
  await step('the wheel over the Blackboard\'s tabs moves along them', async () => {
    await page.keyboard.press('Alt+3'); await sleep(300);
    const b = await page.locator('#bb-tabs').boundingBox();
    await page.mouse.move(b.x + 20, b.y + b.height / 2);
    await page.mouse.wheel(0, 120); await sleep(300);
    assert.equal(await bbTab(), 'storage');
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
  await step('the palette opens a factory and finds who makes an item', async () => {
    await page.keyboard.press('Control+k'); await page.keyboard.type('charlie'); await page.keyboard.press('Enter'); await sleep(700);
    assert.equal(await page.inputValue('#sc-name'), 'Charlie');
    await page.click('#btn-goto'); await page.keyboard.type('who iron plate'); await sleep(150);
    await page.keyboard.press('Enter'); await sleep(800);
    assert.equal(await bbTab(), 'find');
    assert.equal(await page.inputValue('#bb-find-q'), 'Iron Plate');
    await page.keyboard.press('Escape');
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
    await page.click('.mp-f[data-r="*"]'); await sleep(200);
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
    await page.click('.mp-f[data-r="Coal"]'); await sleep(100);
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

  if (errors.length) { failed++; console.log('FAIL page errors:\n     ' + errors.join('\n     ')); }
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  stop(failed ? 1 : 0);
} catch (e) {
  console.log('FAIL', e.stack || e);
  stop(1);
}
