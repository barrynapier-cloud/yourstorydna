// Small API for yourstorydna.com. Runs on the VPS next to Caddy (/api/* is proxied here).
// Secrets come only from environment variables set on the server, never from this repo.
import http from 'node:http';
import pg from 'pg';

const PORT = 8080;
const MODEL = process.env.MODEL || 'claude-haiku-5-5';
const KEY = process.env.ANTHROPIC_API_KEY || '';
const db = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 }) : null;

// Only the app's own prompts are accepted, so the endpoint can't be used as a free Claude proxy.
const PROMPT_PREFIXES = [
  'You are the Story DNA engine of a science fiction book app.',
  "You turn a reader's description of a sci-fi character into a trading card.",
];

const hits = new Map();
function limited(ip, bucket, max, windowMs = 3600e3) {
  const k = bucket + ip, now = Date.now(), arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(k, arr); return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3);

function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req, max) {
  return new Promise((ok, bad) => { let n = 0, c = [];
    req.on('data', d => { n += d.length; if (n > max) { bad(new Error('too big')); req.destroy(); } else c.push(d); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch (e) { bad(e); } }); });
}
function firstJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) return null; try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

async function sample(req, res, ip) {
  if (!KEY) return send(res, 503, { error: 'unavailable' });
  if (limited(ip, 's', 40)) return send(res, 429, { error: 'slow down' });
  const { prompt } = await body(req, 16000);
  if (typeof prompt !== 'string' || prompt.length > 12000 || !PROMPT_PREFIXES.some(p => prompt.startsWith(p))) return send(res, 400, { error: 'bad prompt' });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) { console.error('anthropic', r.status, (await r.text()).slice(0, 300)); return send(res, 502, { error: 'model error' }); }
  const j = await r.json();
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  send(res, 200, { text, json: firstJson(text) });
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

http.createServer(async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const path = new URL(req.url, 'http://x').pathname;
  try {
    if (path === '/api/health') return send(res, 200, { ok: true, model: !!KEY, db: !!db });
    if (path === '/api/sample' && req.method === 'POST') return await sample(req, res, ip);
    const m = path.match(/^\/api\/books(?:\/([^/]+))?$/);
    if (m) return await books(req, res, ip, m[1] && decodeURIComponent(m[1]));
    send(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: 'server error' }); }
}).listen(PORT, () => console.log('api on', PORT, 'model key', !!KEY, 'db', !!db));
