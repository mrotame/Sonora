// SPIKE DESCARTAVEL (4.2): serve m4a de uma pasta temporaria + pagina de teste.
// Nao e o backend final. Uso: node server.mjs <pasta-com-audios> [porta]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 5174);
const html = fs.readFileSync(new URL('./index.html', import.meta.url));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  } else if (url.pathname === '/audio') {
    const name = path.basename(url.searchParams.get('f') ?? '');
    const file = path.join(dir, name);
    if (!name.endsWith('.m4a') || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  } else if (url.pathname === '/report' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { console.log('REPORT ' + body); res.writeHead(204).end(); });
  } else if (url.pathname === '/pcm' && req.method === 'POST') {
    const out = path.join(dir, 'pcm-' + path.basename(url.searchParams.get('tag') ?? 'x') + '.f32');
    req.pipe(fs.createWriteStream(out)).on('finish', () => res.writeHead(204).end());
  } else res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.log(`spike on http://localhost:${port}`));
