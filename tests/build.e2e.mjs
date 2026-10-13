// From plan to building, in a real browser on a throwaway planner: the build
// sheet (lines in build order, clocks, belts, a split per input, large on a
// click), and Analysis's limit with the nearest free nodes — Add & solve.
// Needs Playwright; skips without it.   node tests/build.e2e.mjs
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
  await step('⑂: the splitters that feed every machine its share; a click shows it large', async () => {
    await page.locator('.bs-sp').first().click(); await page.waitForSelector('.bs-d svg');
    assert.match(await page.locator('.bs-d').first().innerText(), /each of the 16 machines/);
    await page.locator('.bs-d svg').first().click(); await page.waitForSelector('#sp-full.show svg');
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

  if (errors.length) { failed++; console.log('FAIL page errors:\n     ' + errors.join('\n     ')); }
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  stop(failed ? 1 : 0);
} catch (e) {
  console.log('FAIL', e.stack || e);
  stop(1);
}
