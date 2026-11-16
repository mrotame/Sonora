// Dev tool (not shipped): renders the whole-song road profile of a scenario path to an HTML file, so the path
// constants can be tuned by looking at the curve instead of playing the song. It runs the same analysis
// (analyzeTrack) and the same path (createTrackPath) as the app, so what it draws is what the camera rides.
//
// Usage:
//   node tools/track-preview.ts <audio-file | youtube-url> [--ref image.png] [--out file.html]
// Requires ffmpeg on PATH (decoding) and, for a YouTube URL, yt-dlp (YTDLP_PATH overrides).
// Output goes to .preview/ (gitignored) by default.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeTrack } from '../src/audio/analysis/analyze.ts';
import { Timeline } from '../src/audio/intelligence/timeline.ts';
import { createTrackPath, intensityTrack, PATH } from '../src/scenarios/synthwave/path.ts';
import { parseYouTubeVideoId, canonicalUrl } from '../shared/youtubeUrl.ts';

const SR = 44_100;
const KMH = 3.6; // 1 world unit = 1 m
const SAMPLE_HZ = 10; // resolution of the drawn curves

function parseArgs(argv: string[]): { input: string; ref?: string; out?: string } {
  const rest: string[] = [];
  let ref: string | undefined, out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref') ref = argv[++i];
    else if (argv[i] === '--out') out = argv[++i];
    else rest.push(argv[i]!);
  }
  if (rest.length !== 1) {
    console.error('usage: node tools/track-preview.ts <audio-file | youtube-url> [--ref image.png] [--out file.html]');
    process.exit(2);
  }
  return { input: rest[0]!, ref, out };
}

/** Downloads a YouTube video's audio into a cache folder (reused on later runs). */
function download(videoId: string, cacheDir: string): string {
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = fs.readdirSync(cacheDir).find((f) => f.startsWith(videoId + '.'));
  if (cached) return path.join(cacheDir, cached);
  console.log(`downloading ${videoId}...`);
  const ytdlp = process.env.YTDLP_PATH ?? 'yt-dlp';
  const r = spawnSync(ytdlp, ['--no-playlist', '--no-warnings', '-f', 'ba[ext=m4a]/ba', '-o', path.join(cacheDir, `${videoId}.%(ext)s`), '--', canonicalUrl(videoId)], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('yt-dlp failed');
  const file = fs.readdirSync(cacheDir).find((f) => f.startsWith(videoId + '.'));
  if (!file) throw new Error('download produced no file');
  return path.join(cacheDir, file);
}

/** Decodes any audio file to two Float32 channels at 44.1 kHz with ffmpeg. */
function decode(file: string): Promise<[Float32Array, Float32Array]> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(SR), 'pipe:1'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with ${code}`));
      const buf = Buffer.concat(chunks);
      const all = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      const n = all.length >> 1;
      const left = new Float32Array(n), right = new Float32Array(n);
      for (let i = 0; i < n; i++) { left[i] = all[2 * i]!; right[i] = all[2 * i + 1]!; }
      resolve([left, right]);
    });
  });
}

const WHITE = [255, 255, 255], GREEN = [60, 255, 120], RED = [255, 60, 60];
function slopeColor(slope: number): string {
  const k = Math.min(1, Math.abs(slope) / PATH.maxSlope);
  const c = slope >= 0 ? GREEN : RED;
  return `rgb(${WHITE.map((w, i) => Math.round(w + (c[i]! - w) * k)).join(',')})`;
}

interface Series { t: number[]; d: number[]; h: number[]; slope: number[]; kmh: number[]; intensity: number[] }

function sampleSeries(timeline: Timeline): Series {
  const p = createTrackPath(timeline);
  const inten = intensityTrack(timeline);
  const s: Series = { t: [], d: [], h: [], slope: [], kmh: [], intensity: [] };
  const n = Math.floor(timeline.durationS * SAMPLE_HZ);
  const dt = 0.25;
  for (let i = 0; i <= n; i++) {
    const t = i / SAMPLE_HZ;
    s.t.push(t);
    s.d.push(p.distanceAt(t));
    s.h.push(p.heightAt(t));
    s.slope.push(p.slopeAt(t));
    s.kmh.push(((p.distanceAt(t + dt) - p.distanceAt(t)) / dt) * KMH);
    s.intensity.push(inten[Math.min(inten.length - 1, Math.round(t * timeline.data.rate))]!);
  }
  return s;
}

const W = 1400;
const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** A polyline chart; `color` per segment is optional. x and y are data arrays. */
function chart(title: string, x: number[], y: number[], opts: { height: number; xLabel: (v: number) => string; xStep: number; yUnit: string; color?: (i: number) => string; equalAspect?: boolean }): string {
  const padL = 60, padR = 20, padT = 28, padB = 28;
  const x0 = x[0]!, x1 = x[x.length - 1]!;
  let y0 = Math.min(...y), y1 = Math.max(...y);
  if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
  const iw = W - padL - padR;
  let ih = opts.height - padT - padB;
  if (opts.equalAspect) ih = Math.max(60, Math.min(600, ((y1 - y0) / (x1 - x0)) * iw)); // true slopes, like the camera sees them
  const H = ih + padT + padB;
  const px = (v: number) => padL + ((v - x0) / (x1 - x0 || 1)) * iw;
  const py = (v: number) => padT + ih - ((v - y0) / (y1 - y0)) * ih;
  const parts: string[] = [];
  for (let v = Math.ceil(x0 / opts.xStep) * opts.xStep; v <= x1; v += opts.xStep) {
    parts.push(`<line x1="${px(v)}" y1="${padT}" x2="${px(v)}" y2="${padT + ih}" class="grid"/><text x="${px(v)}" y="${H - 8}" class="lbl" text-anchor="middle">${opts.xLabel(v)}</text>`);
  }
  for (let k = 0; k <= 4; k++) {
    const v = y0 + ((y1 - y0) * k) / 4;
    parts.push(`<line x1="${padL}" y1="${py(v)}" x2="${W - padR}" y2="${py(v)}" class="grid"/><text x="${padL - 6}" y="${py(v) + 4}" class="lbl" text-anchor="end">${y1 - y0 < 10 ? v.toFixed(2) : Math.round(v)}${opts.yUnit}</text>`);
  }
  if (opts.color) {
    // Group consecutive points of the same colour into one polyline to keep the SVG small.
    let start = 0;
    for (let i = 1; i <= x.length; i++) {
      const same = i < x.length && opts.color(i) === opts.color(start);
      if (same) continue;
      const pts = [];
      for (let j = start; j <= Math.min(i, x.length - 1); j++) pts.push(`${px(x[j]!).toFixed(1)},${py(y[j]!).toFixed(1)}`);
      parts.push(`<polyline points="${pts.join(' ')}" stroke="${opts.color(start)}" class="line"/>`);
      start = i;
    }
  } else {
    parts.push(`<polyline points="${x.map((v, i) => `${px(v).toFixed(1)},${py(y[i]!).toFixed(1)}`).join(' ')}" stroke="#9cf" class="line"/>`);
  }
  return `<h2>${title}</h2><svg viewBox="0 0 ${W} ${H}" width="100%">${parts.join('')}</svg>`;
}

function render(name: string, s: Series, refDataUrl: string | null): string {
  const quantize = (v: number) => slopeColor(Math.round(v / 0.05) * 0.05);
  const dur = s.t[s.t.length - 1]!;
  const tStep = dur > 240 ? 30 : 15;
  const kmhSorted = [...s.kmh].sort((a, b) => a - b);
  const pct = (p: number) => kmhSorted[Math.floor(p * (kmhSorted.length - 1))]!.toFixed(0);
  const stats = `duração ${fmtTime(dur)} · distância ${(s.d[s.d.length - 1]! / 1000).toFixed(2)} km · velocidade p10/p50/p90 ${pct(0.1)}/${pct(0.5)}/${pct(0.9)} km/h · desnível ${Math.round(Math.max(...s.h) - Math.min(...s.h))} m`;
  const pathConsts = Object.entries(PATH).map(([k, v]) => `${k}=${v}`).join(' · ');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Track preview: ${name}</title>
<style>
body{background:#111;color:#ddd;font:14px system-ui,sans-serif;margin:16px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 4px;color:#aaa}
.grid{stroke:#2a2a2a;stroke-width:1}.lbl{fill:#777;font-size:11px}.line{fill:none;stroke-width:2}
.meta{color:#888;font-size:12px}img{max-width:100%;border:1px solid #333}
</style></head><body>
<h1>${name}</h1><div class="meta">${stats}</div><div class="meta">PATH: ${pathConsts}</div>
${refDataUrl ? `<h2>Referência</h2><img src="${refDataUrl}">` : ''}
${chart('Perfil da pista (altura × distância, proporção real; cor = inclinação: verde sobe, vermelho desce)', s.d, s.h, { height: 300, xLabel: (v) => `${(v / 1000).toFixed(1)} km`, xStep: 1000, yUnit: ' m', color: (i) => quantize(s.slope[i]!), equalAspect: true })}
${chart('Perfil da pista (altura × tempo; escala vertical exagerada)', s.t, s.h, { height: 260, xLabel: fmtTime, xStep: tStep, yUnit: ' m', color: (i) => quantize(s.slope[i]!) })}
${chart('Velocidade (km/h × tempo)', s.t, s.kmh, { height: 200, xLabel: fmtTime, xStep: tStep, yUnit: '' })}
${chart('Intensidade (0..1 × tempo, a mesma que move a pista)', s.t, s.intensity, { height: 160, xLabel: fmtTime, xStep: tStep, yUnit: '' })}
</body></html>`;
}

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.preview');
const videoId = parseYouTubeVideoId(args.input);
const file = videoId ? download(videoId, path.join(os.tmpdir(), 'sonora-preview-audio')) : args.input;
const name = videoId ?? path.basename(file);

console.log(`decoding ${file}...`);
const [left, right] = await decode(file);
console.log(`analyzing ${(left.length / SR).toFixed(1)} s...`);
const timeline = new Timeline(analyzeTrack(left, right, SR));
const series = sampleSeries(timeline);

let refDataUrl: string | null = null;
if (args.ref) {
  const ext = path.extname(args.ref).slice(1).toLowerCase().replace('jpg', 'jpeg');
  refDataUrl = `data:image/${ext};base64,${fs.readFileSync(args.ref).toString('base64')}`;
}

fs.mkdirSync(outDir, { recursive: true });
const out = args.out ?? path.join(outDir, `${name.replace(/[^\w.-]/g, '_')}.html`);
fs.writeFileSync(out, render(name, series, refDataUrl));
console.log(`wrote ${out}`);
