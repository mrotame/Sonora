// SPIKE DESCARTAVEL: compara dois dumps Float32 entrelacados. Uso: node compare.mjs a.f32 b.f32
import fs from 'node:fs';
const [a, b] = process.argv.slice(2).map((f) => { const buf = fs.readFileSync(f); return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4); });
if (a.length !== b.length) console.log(`COMPRIMENTOS DIFERENTES: ${a.length} vs ${b.length}`);
const n = Math.min(a.length, b.length);
let diff = 0, maxAbs = 0, sumSq = 0, sigSq = 0, peak = 0;
for (let i = 0; i < n; i++) {
  const d = a[i] - b[i]; if (d !== 0) diff++;
  const ad = Math.abs(d); if (ad > maxAbs) maxAbs = ad;
  sumSq += d * d; sigSq += a[i] * a[i]; peak = Math.max(peak, Math.abs(a[i]));
}
const rmsD = Math.sqrt(sumSq / n), rmsS = Math.sqrt(sigSq / n);
console.log(JSON.stringify({ samples: n, differing: diff, pctDiffering: +(100 * diff / n).toFixed(2), maxAbsDiff: maxAbs, rmsDiff: rmsD, rmsSignal: rmsS, peak, snr_dB: rmsD > 0 ? +(20 * Math.log10(rmsS / rmsD)).toFixed(1) : 'inf' }));
