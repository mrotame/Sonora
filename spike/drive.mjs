// SPIKE DESCARTAVEL: dirige a tela de desenvolvimento via Chrome DevTools Protocol.
// Uso: node drive.mjs <exe-do-navegador> <porta-cdp> <url-da-app> <youtube-url>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [exe, cdpPort, appUrl, ytUrl] = process.argv.slice(2);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-'));
const child = spawn(exe, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
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

const ws = new WebSocket(await targets());
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

let out;
try {
  await send('Page.enable');
  await send('Page.navigate', { url: appUrl });
  await sleep(1500);
  const t0 = Date.now();
  await evaluate(`(() => {
    const input = document.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(ytUrl)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button[type=submit]').click();
  })()`);
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const state = await evaluate(`JSON.stringify({
      identity: document.querySelector('#identity')?.textContent ?? null,
      duration: document.querySelector('#duration')?.textContent ?? null,
      info: document.querySelector('#result')?.innerText ?? null,
      error: document.querySelector('[role=alert]')?.textContent ?? null,
      ua: navigator.userAgent.match(/(Edg|Brave|Chrome)\\/[\\d.]+/)?.[0] })`);
    const s = JSON.parse(state);
    if (s.identity || s.error) { out = { ...s, totalMs: Date.now() - t0 }; break; }
  }
  out ??= { timeout: true };
} finally {
  ws.close();
  child.kill();
  setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 1500);
}
console.log(JSON.stringify(out));
process.exit(0);
