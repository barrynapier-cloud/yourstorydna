// On yourstorydna.com there is no Claude artifact runtime, so this gives the page the same
// window.claude.use() calls it uses inside the preview, backed by the site's own /api.
(function () {
  window.STORYDNA_API = '/api';
  async function call(url, opts = {}) {
    const ctrl = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(22000) } : {};
    const r = await fetch(url, Object.assign({ credentials: 'same-origin' }, ctrl, opts));
    if (!r.ok) {
      const code = r.status === 429 ? 'rate_limited' : r.status === 503 ? 'none' : r.status;
      throw { code, status: r.status };
    }
    return r.json();
  }
  window.storyDnaResearch = function (q) {
    return call('/api/research', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: String(q || '').slice(0, 200) }),
    });
  };
  if (window.claude) return;
  const sample = {
    async json(prompt) {
      const r = await call('/api/sample', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) });
      if (!r.json) throw { code: 'parse' };
      return r.json;
    },
    async text(prompt) {
      return (await call('/api/sample', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) })).text;
    },
  };
  function collection(name) {
    if (name !== 'books') throw new Error('unknown collection');
    let n = 1000;
    const api = {
      limit(x) { n = x; return api; },
      async get() { const r = await call('/api/books?limit=' + n); return { docs: (r.docs || []).map(d => ({ data: () => d })) }; },
      doc(id) {
        return {
          set: d => call('/api/books/' + encodeURIComponent(id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d) }),
        };
      },
    };
    return api;
  }
  let health = null;
  const ok = () => health || (health = call('/api/health').catch(() => ({})));
  window.claude = {
    async use(cap) {
      const h = await ok();
      if (cap === 'sample') return h.model ? sample : null;
      if (cap === 'db') return h.db ? { collection } : null;
      return null;
    },
  };
})();
