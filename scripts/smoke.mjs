#!/usr/bin/env node
// Automated verification suite for yourstorydna (HTML/JS integrity, zero 404 probes, API security invariants).
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// 1. Validate site/index.html & site/claude-shim.js JS syntax and security invariants
const html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
const shim = fs.readFileSync(path.join(root, 'site/claude-shim.js'), 'utf8');
new vm.Script(shim, { filename: 'claude-shim.js' });

const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)];
assert.equal(scripts.length, 1, 'Expected exactly 1 inline script block in site/index.html');
new vm.Script(scripts[0][1], { filename: 'site/index.html' });

assert.ok(html.includes('http-equiv="Content-Security-Policy"'), 'Missing CSP meta tag');
assert.ok(html.includes('name="referrer"'), 'Missing referrer policy meta tag');
assert.ok(!html.includes("i.src = 'covers/' + b.id + '.jpg'; d.append(i); return d;"), 'Eager unguarded /covers/*.jpg 404 probe still present');

// Ensure no em dashes exist in non-data UI script/template code (outside SEED/GENES/ABOUT/SAYS data blocks)
const afterDataIdx = html.indexOf('// ---- fx: shared');
assert.ok(afterDataIdx > 0, 'Missing fx section marker');
const uiSlice = html.slice(afterDataIdx);
assert.equal((uiSlice.match(/\u2014/g) || []).length, 0, 'Found forbidden em dash (U+2014) in UI code');

// 2. Spin up api/server.js on ephemeral port and verify security hardening
const TEST_PORT = 18941;
const proc = spawn(process.execPath, [path.join(root, 'api/server.js')], {
  env: { ...process.env, PORT: String(TEST_PORT), ANTHROPIC_API_KEY: '', DATABASE_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let errBuf = '';
proc.stderr.on('data', chunk => { errBuf += String(chunk); });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('API startup timeout: ' + errBuf)), 5000);
  proc.stdout.on('data', chunk => {
    if (String(chunk).includes('api on')) { clearTimeout(timer); resolve(); }
  });
  proc.on('exit', code => { clearTimeout(timer); reject(new Error('API exited early (' + code + '): ' + errBuf)); });
});

try {
  // Check health + security headers
  const hRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`);
  assert.equal(hRes.status, 200);
  assert.equal(hRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(hRes.headers.get('x-frame-options'), 'DENY');
  assert.equal(hRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const hJson = await hRes.json();
  assert.equal(hJson.ok, true);

  // Check cross-origin CSRF rejection on POST /api/sample
  const csrfRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/sample`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
    body: JSON.stringify({ prompt: 'test' }),
  });
  assert.equal(csrfRes.status, 403, 'Expected 403 on cross-origin POST /api/sample');

  // Check null JSON body handling (must return 400/503, never 500 TypeError)
  const nullRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://yourstorydna.com' },
    body: 'null',
  });
  assert.notEqual(nullRes.status, 500, 'Null JSON body caused 500 error');

  // Verify X-Forwarded-For leftmost spoofing cannot bypass per-IP rate limit on /api/admin/login
  let got429 = false;
  for (let i = 0; i < 18; i++) {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/admin/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://yourstorydna.com',
        'x-forwarded-for': `203.0.113.${i}, 198.51.100.77`,
      },
      body: JSON.stringify({ credential: 'fake' }),
    });
    if (r.status === 429) { got429 = true; break; }
  }
  assert.ok(got429, 'Expected 429 rate limit even when client spoofs leftmost X-Forwarded-For');
} finally {
  proc.kill('SIGTERM');
}

console.log('SMOKE TEST PASSED');
