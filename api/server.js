// Small API for yourstorydna.com. Runs on the VPS next to Caddy (/api/* is proxied here).
// Secrets come only from environment variables on the server or the encrypted site_secrets
// table, never from this repo.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';

const PORT = 8080;
const env = process.env;
const db = env.DATABASE_URL ? new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 }) : null;
const ADMIN_EMAILS = (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || '';
const ENC_KEY = env.KEYS_SECRET ? crypto.createHash('sha256').update(env.KEYS_SECRET).digest() : null;
const GENES = JSON.parse(fs.readFileSync(new URL('./genes_sf.json', import.meta.url)));
const GENE_SET = new Set(GENES.map(g => g.slug));
const GENE_TEXT = GENES.map(g => `${g.slug}: ${g.name}. ${g.desc}`).join('\n');

// Only the app's own prompts are accepted, so /api/sample can't be used as a free Claude proxy.
const PROMPT_PREFIXES = [
  'You are the Story DNA engine of a science fiction book app.',
  "You turn a reader's description of a sci-fi character into a trading card.",
];
const MODELS = {
  claude: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  research: ['sonar', 'sonar-pro', 'sonar-reasoning-pro'],
};
const DEFAULTS = { dailyCap: 200, scifiOnly: true, researchModel: 'sonar', tagModel: 'claude-sonnet-5-5', lookupModel: 'claude-haiku-5-5', deepModel: 'claude-haiku-5-5' };
const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', perplexity: 'PERPLEXITY_API_KEY' };

// ---------- helpers ----------
const hits = new Map();
function limited(ip, bucket, max, windowMs = 3600e3) {
  const k = bucket + ip, now = Date.now(), arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(k, arr); return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3);

function send(res, code, obj, headers = {}) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); }
function body(req, max) {
  return new Promise((ok, bad) => { let n = 0, c = [];
    req.on('data', d => { n += d.length; if (n > max) { bad(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); } else c.push(d); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { bad(Object.assign(new Error('bad json'), { status: 400 })); } }); });
}
function firstJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) return null; try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}
const today = () => new Date().toISOString().slice(0, 10);
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40);

// ---------- schema (created by the setup job; this only checks) ----------
let ready = false;
async function ensure() { if (ready || !db) return ready; try { await db.query('SELECT 1 FROM site_settings LIMIT 1'); ready = true; } catch {} return ready; }

// ---------- secrets ----------
function enc(text) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv); const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]); }
function dec(buf) { const c = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, buf.subarray(0, 12)); c.setAuthTag(buf.subarray(12, 28)); return Buffer.concat([c.update(buf.subarray(28)), c.final()]).toString('utf8'); }
const secretCache = new Map();
async function secret(name) {
  const c = secretCache.get(name); if (c && Date.now() - c.at < 30e3) return c;
  let out = { value: '', source: null, updatedAt: null };
  if (db && ENC_KEY && await ensure()) {
    try { const r = await db.query('SELECT value_enc, updated_at FROM site_secrets WHERE name=$1', [name]);
      if (r.rows[0]) out = { value: dec(r.rows[0].value_enc), source: 'db', updatedAt: r.rows[0].updated_at }; } catch (e) { console.error('secret', name, e.message); }
  }
  if (!out.value && env[KEY_ENV[name]]) out = { value: env[KEY_ENV[name]], source: 'env', updatedAt: null };
  out.at = Date.now(); secretCache.set(name, out); return out;
}

// ---------- settings and usage ----------
let settingsCache = null;
async function settings() {
  if (settingsCache && Date.now() - settingsCache.at < 30e3) return settingsCache.v;
  const v = { ...DEFAULTS };
  if (db && await ensure()) { const r = await db.query('SELECT name, value FROM site_settings'); for (const row of r.rows) if (row.name in DEFAULTS) v[row.name] = row.value; }
  settingsCache = { v, at: Date.now() }; return v;
}
async function usageToday() { if (!db || !await ensure()) return 0; const r = await db.query('SELECT coalesce(sum(n),0)::int n FROM site_usage WHERE day=$1', [today()]); return r.rows[0].n; }
async function countUsage(kind) { if (db && await ensure()) await db.query('INSERT INTO site_usage(day, kind, n) VALUES ($1,$2,1) ON CONFLICT (day, kind) DO UPDATE SET n = site_usage.n + 1', [today(), kind]); }

// ---------- model calls ----------
async function claude(key, model, prompt, maxTokens = 800) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) { const t = (await r.text()).slice(0, 300); console.error('anthropic', r.status, t); throw Object.assign(new Error('model'), { upstream: r.status }); }
  const j = await r.json();
  return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
}
async function perplexity(key, model, prompt, maxTokens = 900) {
  const r = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) { const t = (await r.text()).slice(0, 300); console.error('perplexity', r.status, t); throw Object.assign(new Error('research'), { upstream: r.status }); }
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content || '';
  const sources = (j.search_results || []).map(s => ({ title: String(s.title || s.url).slice(0, 200), url: s.url }))
    .concat((j.citations || []).map(u => ({ title: u, url: u })))
    .filter((s, i, a) => /^https?:\/\//.test(s.url) && a.findIndex(x => x.url === s.url) === i).slice(0, 8);
  return { text, sources };
}

// ---------- public routes ----------
async function sample(req, res, ip) {
  const key = (await secret('anthropic')).value;
  if (!key) return send(res, 503, { error: 'unavailable' });
  if (limited(ip, 's', 40)) return send(res, 429, { error: 'slow down' });
  const { prompt } = await body(req, 16000);
  if (typeof prompt !== 'string' || prompt.length > 12000 || !PROMPT_PREFIXES.some(p => prompt.startsWith(p))) return send(res, 400, { error: 'bad prompt' });
  const s = await settings();
  const model = prompt.includes('A reader typed this book title') ? s.lookupModel : s.deepModel;
  try { const text = await claude(key, model, prompt); send(res, 200, { text, json: firstJson(text) }); }
  catch { send(res, 502, { error: 'model error' }); }
}

async function books(req, res, ip, id) {
  if (!db) return send(res, 503, { error: 'unavailable' });
  if (req.method === 'GET') {
    const limit = Math.min(1000, Math.max(1, +new URL(req.url, 'http://x').searchParams.get('limit') || 1000));
    const q = await db.query('SELECT data FROM site_books ORDER BY created_at LIMIT $1', [limit]);
    return send(res, 200, { docs: q.rows.map(r => r.data) });
  }
  if (req.method === 'PUT' && id) {
    if (!/^[\w.-]{1,100}$/.test(id)) return send(res, 400, { error: 'bad id' });
    if (limited(ip, 'b', 60)) return send(res, 429, { error: 'slow down' });
    const data = await body(req, 8000);
    await db.query(`INSERT INTO site_books(id, data, ip) VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [id, data, ip]);
    return send(res, 200, { ok: true });
  }
  send(res, 405, { error: 'method' });
}

async function research(req, res, ip) {
  if (!db || !await ensure()) return send(res, 503, { error: 'unavailable' });
  const b = await body(req, 24000);
  const q = String(b.q || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (q.length < 2) return send(res, 400, { error: 'bad query' });
  const hit = await db.query(`SELECT data FROM site_books WHERE lower(data->>'t') = lower($1) ORDER BY created_at DESC LIMIT 1`, [q]);
  if (hit.rows[0]) return send(res, 200, { found: true, cached: true, book: hit.rows[0].data });
  const [pk, ak, s] = [(await secret('perplexity')).value, (await secret('anthropic')).value, await settings()];
  if (!pk || !ak) return send(res, 503, { error: 'nokey' });
  if (await usageToday() >= s.dailyCap) return send(res, 429, { error: 'cap' });
  if (limited(ip, 'r', 10)) return send(res, 429, { error: 'rate' });

  let found;
  try {
    await countUsage('research');
    const r = await perplexity(pk, s.researchModel, `A reader typed this into a book discovery app: "${q}"
Identify the single most likely published novel or novella they mean. Use web sources. Reply with only a JSON object:
{"real":true|false,"confidence":"high"|"medium"|"low","title":"","author":"","year":0,"series":"","number":0,"genre":"sf"|"fantasy"|"other","description":"2 to 3 spoiler-light sentences","praise":"what readers praise","complaints":"what readers complain about"}
Use "sf" for science fiction. If you cannot find a real published book, set real to false. Never invent details.`);
    found = firstJson(r.text); if (found) found.sources = r.sources;
  } catch { return send(res, 502, { error: 'research' }); }
  if (!found || !found.real || found.confidence === 'low' || !found.title) return send(res, 200, { found: false });
  if (s.scifiOnly && found.genre !== 'sf') return send(res, 200, { found: false, reason: 'genre', title: String(found.title).slice(0, 200) });
  const again = await db.query(`SELECT data FROM site_books WHERE lower(data->>'t') = lower($1) ORDER BY created_at DESC LIMIT 1`, [found.title]);
  if (again.rows[0]) return send(res, 200, { found: true, cached: true, book: again.rows[0].data });

  let tagged;
  try {
    await countUsage('tag');
    const text = await claude(ak, s.tagModel, `You are the Story DNA engine of a science fiction book app. Tag one book using only the research below. Tag only what the research supports and never invent.

Book: ${found.title} by ${found.author} (${found.year || 'year unknown'})
Description: ${found.description}
Readers praise: ${found.praise}
Readers complain: ${found.complaints}

Story genes (slug: name. meaning):
${GENE_TEXT}

Headline tags:
${String(b.tags || '').slice(0, 6000)}

Axes:
${String(b.axes || '').slice(0, 3000)}

Reply with only JSON: {"genes":["6 to 14 gene slugs from the list, strongest first"],"tags":["4 to 6 headline tag keys from the list"],"ax":[five whole numbers 1 to 5, in the axes order]}`, 600);
    tagged = firstJson(text) || {};
  } catch { return send(res, 502, { error: 'model error' }); }

  const genes = (Array.isArray(tagged.genes) ? tagged.genes : []).filter(g => GENE_SET.has(g)).slice(0, 14);
  const tags = (Array.isArray(tagged.tags) ? tagged.tags : []).map(String).filter(t => /^[\w-]{1,40}$/.test(t)).slice(0, 6);
  const ax = (Array.isArray(tagged.ax) ? tagged.ax : []).slice(0, 5).map(n => Math.min(5, Math.max(1, Math.round(+n) || 3)));
  while (ax.length < 5) ax.push(3);
  const book = {
    id: `u-${slug(found.title) || 'book'}-${Date.now().toString(36)}`,
    t: String(found.title).slice(0, 200), a: String(found.author || '').slice(0, 200), y: +found.year || null,
    series: String(found.series || '').slice(0, 200) || null, no: +found.number || null, genre: 'sf',
    tags, genes, ax, desc: String(found.description || '').slice(0, 1200), sources: found.sources || [],
    custom: 1, unv: 1, at: Date.now(),
  };
  await db.query('INSERT INTO site_books(id, data, ip) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [book.id, book, ip]);
  send(res, 200, { found: true, cached: false, book });
}

// ---------- admin auth ----------
let jwks = { keys: [], at: 0 };
async function googleKeys() {
  if (Date.now() - jwks.at < 3600e3 && jwks.keys.length) return jwks.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs'); const j = await r.json();
  jwks = { keys: j.keys || [], at: Date.now() }; return jwks.keys;
}
async function verifyGoogle(token) {
  const [h, p, sig] = String(token).split('.'); if (!sig) return null;
  const head = JSON.parse(Buffer.from(h, 'base64url')), claims = JSON.parse(Buffer.from(p, 'base64url'));
  if (head.alg !== 'RS256') return null;
  const jwk = (await googleKeys()).find(k => k.kid === head.kid); if (!jwk) return null;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  if (!ok) return null;
  if (claims.aud !== GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) return null;
  if (!(claims.exp * 1000 > Date.now()) || claims.email_verified !== true) return null;
  return claims;
}
function cookies(req) { const o = {}; for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); } return o; }
const SID = 'sdna_admin';
async function session(req) {
  const id = cookies(req)[SID]; if (!id || !db || !await ensure()) return null;
  const r = await db.query('SELECT email, name FROM site_sessions WHERE id=$1 AND expires_at > now()', [crypto.createHash('sha256').update(id).digest('hex')]);
  const s = r.rows[0]; if (!s || !ADMIN_EMAILS.includes(s.email)) return null; return s;
}

async function admin(req, res, ip, path) {
  if (!db || !await ensure()) return send(res, 503, { error: 'unavailable' });
  const M = req.method;
  if (path === '/api/admin/config' && M === 'GET') {
    const s = await session(req);
    return send(res, 200, { googleClientId: GOOGLE_CLIENT_ID || null, signedIn: !!s, ...(s ? { email: s.email } : {}) });
  }
  if (path === '/api/admin/login' && M === 'POST') {
    if (limited(ip, 'l', 20)) return send(res, 429, { error: 'rate' });
    if (!GOOGLE_CLIENT_ID || !ADMIN_EMAILS.length) return send(res, 503, { error: 'notconfigured' });
    const { credential } = await body(req, 8000);
    let claims = null; try { claims = await verifyGoogle(credential); } catch (e) { console.error('google', e.message); }
    if (!claims) return send(res, 401, { error: 'auth' });
    const email = String(claims.email).toLowerCase();
    if (!ADMIN_EMAILS.includes(email)) return send(res, 403, { error: 'notadmin' });
    const id = crypto.randomBytes(32).toString('base64url');
    await db.query(`INSERT INTO site_sessions(id, email, name, expires_at) VALUES ($1,$2,$3, now() + interval '12 hours')`,
      [crypto.createHash('sha256').update(id).digest('hex'), email, String(claims.name || '').slice(0, 200)]);
    await db.query('DELETE FROM site_sessions WHERE expires_at < now()');
    return send(res, 200, { ok: true, email, name: claims.name || '' }, { 'set-cookie': `${SID}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=43200` });
  }
  if (path === '/api/admin/logout' && M === 'POST') {
    const id = cookies(req)[SID]; if (id) await db.query('DELETE FROM site_sessions WHERE id=$1', [crypto.createHash('sha256').update(id).digest('hex')]);
    return send(res, 200, { ok: true }, { 'set-cookie': `${SID}=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0` });
  }

  const me = await session(req);
  if (!me) return send(res, 401, { error: 'auth' });
  let m;

  if (path === '/api/admin/overview' && M === 'GET') {
    const keys = {};
    for (const n of Object.keys(KEY_ENV)) { const s = await secret(n); keys[n] = { set: !!s.value, source: s.source, updatedAt: s.updatedAt }; }
    const days = (await db.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, sum(n)::int AS n FROM site_usage WHERE day > current_date - 7 GROUP BY day ORDER BY day`)).rows;
    const c = (await db.query(`SELECT count(*)::int books, count(*) FILTER (WHERE data->>'custom'='1')::int researched,
      count(*) FILTER (WHERE data->>'custom'='1' AND data->>'unv'='1')::int unverified FROM site_books`)).rows[0];
    const st = await settings();
    return send(res, 200, { me, keys, settings: st, usage: { today: await usageToday(), cap: st.dailyCap, days }, counts: { ...c, users: 0 } });
  }
  if (path === '/api/admin/keys' && M === 'PUT') {
    if (!ENC_KEY) return send(res, 503, { error: 'nosecret' });
    const { name, value } = await body(req, 2000);
    if (!(name in KEY_ENV)) return send(res, 400, { error: 'bad name' });
    const v = String(value || '').trim(); if (!v || v.length > 300) return send(res, 400, { error: 'bad value' });
    await db.query('INSERT INTO site_secrets(name, value_enc, updated_at) VALUES ($1,$2,now()) ON CONFLICT (name) DO UPDATE SET value_enc=EXCLUDED.value_enc, updated_at=now()', [name, enc(v)]);
    secretCache.delete(name); return send(res, 200, { ok: true });
  }
  if ((m = path.match(/^\/api\/admin\/keys\/(anthropic|perplexity)$/)) && M === 'DELETE') {
    await db.query('DELETE FROM site_secrets WHERE name=$1', [m[1]]); secretCache.delete(m[1]); return send(res, 200, { ok: true });
  }
  if ((m = path.match(/^\/api\/admin\/keys\/(anthropic|perplexity)\/test$/)) && M === 'POST') {
    const k = (await secret(m[1])).value; if (!k) return send(res, 200, { ok: false, message: 'No key set' });
    try {
      if (m[1] === 'anthropic') await claude(k, 'claude-haiku-5-5', 'Say ok.', 5); else await perplexity(k, 'sonar', 'Say ok.', 5);
      return send(res, 200, { ok: true, message: 'Key works' });
    } catch (e) { return send(res, 200, { ok: false, message: 'Provider said ' + (e.upstream || 'error') }); }
  }
  if (path === '/api/admin/settings' && M === 'PUT') {
    const p = await body(req, 4000), cur = await settings(), next = {};
    if ('dailyCap' in p) { const n = Math.round(+p.dailyCap); if (!(n >= 0 && n <= 5000)) return send(res, 400, { error: 'dailyCap' }); next.dailyCap = n; }
    if ('scifiOnly' in p) next.scifiOnly = !!p.scifiOnly;
    if ('researchModel' in p) { if (!MODELS.research.includes(p.researchModel)) return send(res, 400, { error: 'researchModel' }); next.researchModel = p.researchModel; }
    for (const k of ['tagModel', 'lookupModel', 'deepModel']) if (k in p) { if (!MODELS.claude.includes(p[k])) return send(res, 400, { error: k }); next[k] = p[k]; }
    for (const [k, v] of Object.entries(next)) await db.query('INSERT INTO site_settings(name, value) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value', [k, JSON.stringify(v)]);
    settingsCache = null; return send(res, 200, { ok: true, settings: { ...cur, ...next } });
  }
  if (path === '/api/admin/books' && M === 'GET') {
    const u = new URL(req.url, 'http://x').searchParams;
    const limit = Math.min(200, Math.max(1, +u.get('limit') || 50)), offset = Math.max(0, +u.get('offset') || 0);
    const total = (await db.query(`SELECT count(*)::int n FROM site_books WHERE data->>'custom'='1'`)).rows[0].n;
    const r = await db.query(`SELECT data FROM site_books WHERE data->>'custom'='1' ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    return send(res, 200, { total, books: r.rows.map(({ data: d }) => ({ id: d.id, t: d.t, a: d.a, y: d.y, genre: d.genre, at: d.at, unv: d.unv ? 1 : 0, genes: (d.genes || []).length, sources: (d.sources || []).length })) });
  }
  if ((m = path.match(/^\/api\/admin\/books\/([\w.-]{1,100})$/))) {
    if (M === 'POST') { const { unv } = await body(req, 200); await db.query(`UPDATE site_books SET data = jsonb_set(data, '{unv}', to_jsonb($2::int)), updated_at=now() WHERE id=$1`, [m[1], unv ? 1 : 0]); return send(res, 200, { ok: true }); }
    if (M === 'DELETE') { await db.query('DELETE FROM site_books WHERE id=$1', [m[1]]); return send(res, 200, { ok: true }); }
  }
  if (path === '/api/admin/users' && M === 'GET') return send(res, 200, { enabled: false, users: [] });
  if (/^\/api\/admin\/users\/[^/]+$/.test(path) && M === 'POST') return send(res, 409, { error: 'disabled', message: 'Reader sign-in is not built yet' });
  send(res, 404, { error: 'not found' });
}

http.createServer(async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const path = new URL(req.url, 'http://x').pathname;
  try {
    if (path === '/api/health') return send(res, 200, { ok: true, model: !!(await secret('anthropic')).value, research: !!(await secret('perplexity')).value, db: !!db });
    if (path === '/api/sample' && req.method === 'POST') return await sample(req, res, ip);
    if (path === '/api/research' && req.method === 'POST') return await research(req, res, ip);
    if (path.startsWith('/api/admin/')) return await admin(req, res, ip, path);
    const m = path.match(/^\/api\/books(?:\/([^/]+))?$/);
    if (m) return await books(req, res, ip, m[1] && decodeURIComponent(m[1]));
    send(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); if (!res.headersSent) send(res, e.status || 500, { error: e.status ? 'bad request' : 'server error' }); }
}).listen(PORT, () => console.log('api on', PORT, 'db', !!db, 'admins', ADMIN_EMAILS.length, 'google', !!GOOGLE_CLIENT_ID, 'enc', !!ENC_KEY));
