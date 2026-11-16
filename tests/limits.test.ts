import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { Breaker, clientKey, normalizeIp, Quota, SlidingWindow } from '../server/limits.ts';

function fakeReq(remote: string, xff?: string | string[]): IncomingMessage {
  return { socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } } as unknown as IncomingMessage;
}

test('sliding window blocks over the limit and recovers after the window', () => {
  let t = 0;
  const w = new SlidingWindow(2, 1000, () => t);
  assert.ok(w.tryHit('a'));
  assert.ok(w.tryHit('a'));
  assert.ok(!w.tryHit('a'));
  assert.ok(w.tryHit('b'), 'keys are independent');
  t = 1001;
  assert.ok(w.tryHit('a'));
});

test('allows() does not consume the budget', () => {
  const w = new SlidingWindow(1, 1000, () => 0);
  assert.ok(w.allows('a'));
  assert.ok(w.allows('a'));
  w.record('a');
  assert.ok(!w.allows('a'));
});

test('prune drops idle keys', () => {
  let t = 0;
  const w = new SlidingWindow(5, 1000, () => t);
  w.record('a');
  t = 2000;
  w.prune();
  assert.equal(w.size, 0);
});

test('breaker opens after the threshold, closes after the pause, resets on success', () => {
  let t = 0;
  const b = new Breaker(2, 1000, () => t);
  b.recordBlocked();
  assert.ok(!b.isOpen());
  b.recordOk();
  b.recordBlocked();
  assert.ok(!b.isOpen(), 'success reset the streak');
  b.recordBlocked();
  assert.ok(b.isOpen());
  t = 1001;
  assert.ok(!b.isOpen());
});

test('quota enforces day and month, rolls over, and persists', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-q-')), 'state.json');
  let t = Date.UTC(2026, 0, 31, 12);
  const max = { dayBytes: 100, monthBytes: 150 };
  const q = new Quota(file, max, () => t);
  q.add(60);
  assert.ok(!q.exceeded());
  q.add(60);
  assert.ok(q.exceeded(), 'daily cap');
  assert.ok(new Quota(file, max, () => t).exceeded(), 'survives a restart');
  t = Date.UTC(2026, 0, 31, 23, 59) + 2 * 60_000; // next day, same... new month (Feb 1)
  assert.ok(!q.exceeded(), 'new day and month reset');
  t = Date.UTC(2026, 1, 1, 12);
  q.add(90);
  t = Date.UTC(2026, 1, 2, 12);
  assert.ok(!q.exceeded(), 'new day resets the daily counter');
  q.add(90);
  assert.ok(q.exceeded(), 'monthly cap (180 >= 150)');
});

test('quota tolerates a corrupt state file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-q-')), 'state.json');
  fs.writeFileSync(file, '{not json');
  assert.ok(!new Quota(file, { dayBytes: 10, monthBytes: 10 }).exceeded());
});

test('normalizeIp collapses IPv6 to /64 and unwraps IPv4-mapped addresses', () => {
  assert.equal(normalizeIp('203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), normalizeIp('2001:db8:1:2::1'));
  assert.notEqual(normalizeIp('2001:db8:1:2::1'), normalizeIp('2001:db8:1:3::1'));
});

test('clientKey uses the socket address unless the proxy is trusted', () => {
  assert.equal(clientKey(fakeReq('127.0.0.1', '1.2.3.4'), false), '127.0.0.1');
});

test('clientKey trusts only the last X-Forwarded-For entry (the proxy\'s own)', () => {
  assert.equal(clientKey(fakeReq('127.0.0.1', '6.6.6.6, 198.51.100.9'), true), '198.51.100.9');
  assert.equal(clientKey(fakeReq('127.0.0.1', ['6.6.6.6', '198.51.100.9']), true), '198.51.100.9');
  assert.equal(clientKey(fakeReq('127.0.0.1'), true), '127.0.0.1');
});
