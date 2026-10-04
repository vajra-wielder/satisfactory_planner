// A factory whose goals can't all be met, in a real browser on a throwaway
// planner: the solve says why (what's short, how much each goal can be),
// offers fixes, and one click on a fix makes it work.
// Needs Playwright; skips without it.   node tests/infeasible.e2e.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire((process.env.NPM_ROOT || process.cwd()) + '/');
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('skip: Playwright not installed'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5000 + Math.floor(Math.random() * 900) + 40;
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

  if (errors.length) { failed++; console.log('FAIL page errors:\n     ' + errors.join('\n     ')); }
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  stop(failed ? 1 : 0);
} catch (e) {
  console.log('FAIL', e.stack || e);
  stop(1);
}
