// SPIKE DESCARTAVEL: roda a experiência completa no navegador via CDP e captura telas.
// Uso: node drive-run.mjs <exe> <porta-cdp> <url-app> <youtube-url> <pasta-saida> [gpu]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [exe, cdpPort, appUrl, ytUrl, outDir, gpu] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-'));
const flags = ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`,
  '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
if (!gpu) flags.push('--disable-gpu-vsync');
const child = spawn(exe, [...flags, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wsUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await sleep(200);
  }
  throw new Error('browser did not start');
}

const ws = new WebSocket(await wsUrl());
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id) { pending.get(d.id)?.(d); pending.delete(d.id); return; }
  if (d.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text));
  if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) logs.push(d.params.type + ': ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
  if (d.method === 'Log.entryAdded' && d.params.entry.level !== 'info') logs.push('LOG ' + d.params.entry.level + ': ' + d.params.entry.text);
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(r.result.data, 'base64'));
}

let out = {};
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.navigate', { url: appUrl });
  await sleep(1500);
  await evaluate(`(() => {
    const input = document.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(ytUrl)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button[type=submit]').click();
  })()`);
  const t0 = Date.now();
  let started = false;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const s = JSON.parse(await evaluate(`JSON.stringify({ stats: document.querySelector('#stats')?.textContent ?? null, alert: document.querySelector('[role=alert]')?.textContent ?? null })`));
    if (s.alert) { out.error = s.alert; break; }
    if (s.stats) { started = true; out.readyMs = Date.now() - t0; break; }
  }
  if (started) {
    await sleep(4000); await shot('t04.png');
    out.stats4 = await evaluate(`document.querySelector('#stats')?.textContent`);
    // simulate mouse look: move toward the upper right, then check the camera is not breaking anything
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300 });
    for (let k = 1; k <= 12; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400 + k * 60, y: 300 - k * 20 });
    await sleep(300); await shot('look.png');
    await sleep(8000); await shot('t13.png');
    out.stats13 = await evaluate(`document.querySelector('#stats')?.textContent`);
  }
} finally {
  try { out.body = await evaluate(`document.body.innerText.slice(0,300)`); await shot('final.png'); } catch {}
  out.logs = logs.slice(0, 15);
  ws.close(); child.kill();
  setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 1500);
}
console.log(JSON.stringify(out, null, 1));
process.exit(0);
