// New alternates, in a real browser on a throwaway planner: after a solve the
// sidebar lists the alternates you haven't unlocked that the best plan would
// use, in unlock order with what each adds; tick and solve, untick and solve.
// Needs Playwright; skips without it.   node tests/newalts.e2e.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire((process.env.NPM_ROOT || process.cwd()) + '/');
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('skip: Playwright not installed'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5000 + Math.floor(Math.random() * 900) + 30;
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
  await api('/api/scenarios/plates', { name: 'Plates', alternate_recipes_enabled: [], unlimited_resources: [],
    resource_nodes: [{ resource: 'Iron_Ore', extractor: 'fixed', rate: 480 }, { resource: 'Copper_Ore', extractor: 'fixed', rate: 240 }],
    objective: { Iron_Plate: 1 } });
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

  await step('after a solve: new alternates under the solve settings, in unlock order, with what each adds', async () => {
    await page.click('.tabbt[data-tab="saved"]'); await sleep(400);
    await page.locator('.sv-row', { hasText: 'Plates' }).locator('button').first().click(); await sleep(900);
    await page.keyboard.press('Control+r'); await solved(); await sleep(300);
    before = await goal();
    await page.waitForFunction(() => document.querySelectorAll('#new-alts .na-row').length > 0, null, { timeout: 60000 });
    const t = await page.locator('#new-alts').innerText();
    assert.match(t, /With all \d+:\s+\+[\d.]+% output/, t);
    assert.match(await page.locator('#new-alts .na-row').first().innerText(), /\+[\d.]+% output/);
    assert.equal(await page.locator('#sec-oc #new-alts').count(), 1, 'under Solve settings');
  });
  await page.screenshot({ path: (process.env.TMPDIR || '/tmp') + '/newalts-after-solve.png' });
  await step('the results bar says so; a click there opens the list', async () => {
    await page.click('.tabbt[data-tab="saved"]'); await sleep(300);
    await page.waitForSelector('#rb-na');
    assert.match(await page.locator('#rb-na').innerText(), /\+[\d.]+%\s+\d+ new alts/i);
    await page.click('#rb-na'); await sleep(500);
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
