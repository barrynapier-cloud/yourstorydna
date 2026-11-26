// The Librarian: a chat assistant that answers questions about books using only this site's
// own library (api/library.json, built from the book database export, plus books readers
// researched in site_books). Claude searches the library through tools, then answers.
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

const LIB = JSON.parse(fs.readFileSync(new URL('./library.json', import.meta.url)));
const GENE = new Map(LIB.genes.map(g => [g.s, g]));
const STOP = new Set('a an and are as at be book books but by for from has have i in is it its me my of on or so that the this to was with you your what which who like about any some more most into than then there their they them one ones'.split(' '));
const words = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

// ---------- index ----------
let BOOKS = [], BYID = new Map(), DF = new Map(), extraAt = 0;
function index(list) {
  BOOKS = list; BYID = new Map(list.map(b => [b.id, b])); DF = new Map();
  for (const b of list) {
    b._t = new Set(words(b.t)); b._a = new Set(words(b.a));
    b._d = new Set(words(b.d)); b._s = new Set(words(b.se));
    b._g = new Set(b.g.flatMap(s => words(GENE.get(s)?.n)));
    b._nt = norm(b.t);
    for (const w of new Set([...b._t, ...b._a, ...b._d, ...b._g, ...b._s])) DF.set(w, (DF.get(w) || 0) + 1);
  }
}
index(LIB.books.slice());

// Books readers researched on the site join the index (refreshed every 10 minutes).
export async function refresh(db) {
  if (!db || Date.now() - extraAt < 600e3) return; extraAt = Date.now();
  try {
    const r = await db.query(`SELECT data FROM site_books WHERE data->>'custom'='1' ORDER BY created_at DESC LIMIT 2000`);
    const have = new Set(LIB.books.map(b => norm(b.t)));
    const extra = r.rows.map(x => x.data).filter(d => d && d.t && Array.isArray(d.genes) && d.genes.length && !have.has(norm(d.t)))
      .map(d => ({ id: d.id, t: d.t, a: d.a || '', y: d.y || undefined, se: d.series || undefined, si: d.no || undefined,
        d: String(d.desc || '').slice(0, 700), g: d.genes.filter(s => GENE.has(s)), r: 0, u: 1 }))
      .filter(b => b.g.length);
    index(LIB.books.concat(extra));
  } catch (e) { console.error('librarian refresh', e.message); }
}

const idf = w => Math.log(1 + BOOKS.length / (1 + (DF.get(w) || 0)));
function search(query, genes = [], limit = 8) {
  const q = words(query), qn = norm(query), want = genes.filter(s => GENE.has(s));
  const scored = [];
  for (const b of BOOKS) {
    let s = 0;
    if (qn && qn.length > 3 && b._nt === qn) s += 50;
    else if (qn && qn.length > 3 && (b._nt.includes(qn) || qn.includes(b._nt) && b._nt.length > 4)) s += 20;
    for (const w of q) { const i = idf(w); if (b._t.has(w)) s += 6 * i; if (b._a.has(w)) s += 5 * i; if (b._s.has(w)) s += 4 * i; if (b._g.has(w)) s += 2.5 * i; if (b._d.has(w)) s += i; }
    if (want.length) { const hit = want.filter(g => b.g.includes(g)).length; if (!hit && !q.length) continue; s += hit * 8 + (hit === want.length ? 6 : 0); }
    if (s > 0) scored.push([s + Math.log10(1 + (b.r || 0)) * 0.6, b]);
  }
  return scored.sort((x, y) => y[0] - x[0]).slice(0, limit).map(x => x[1]);
}
function overlap(a, b) {
  const sa = new Set(a.g), shared = b.g.filter(g => sa.has(g));
  // rare genes count more; shelf facts (classic, standalone) and vibes count less than story genes
  const w = g => (FAMW[GENE.get(g)?.f] ?? 1) / Math.log(2 + (geneCount.get(g) || 1));
  const num = shared.reduce((n, g) => n + w(g), 0), den = new Set([...a.g, ...b.g]).size ? [...new Set([...a.g, ...b.g])].reduce((n, g) => n + w(g), 0) : 1;
  return { score: num / den, shared };
}
const FAMW = { 'Format and facts': 0.15, 'Vibes': 0.5 };
const geneCount = new Map();
for (const b of LIB.books) for (const g of b.g) geneCount.set(g, (geneCount.get(g) || 0) + 1);

const rare = (b, want) => want.filter(g => b.g.includes(g)).reduce((n, g) => n + 1 / (geneCount.get(g) || 1), 0);
const gname = s => GENE.get(s)?.n || s;
const brief = b => ({ id: b.id, title: b.t, author: b.a, year: b.y, series: b.se ? `${b.se}${b.si ? ' #' + b.si : ''}` : undefined,
  genes: b.g.slice(0, 8).map(gname), about: b.d ? b.d.slice(0, 220) : undefined });
function findBook(input) {
  if (!input) return null;
  if (BYID.has(input)) return BYID.get(input);
  return search(input, [], 1)[0] || null;
}

// ---------- tools ----------
const TOOLS = [
  { name: 'search_books', description: 'Search the library by title, author, series, theme words, or story genes. Use it before naming or recommending any book. Returns up to `limit` books with their top genes.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Words to search for, e.g. a title, an author, or what the reader wants' }, genes: { type: 'array', items: { type: 'string' }, description: 'Optional gene slugs the books should carry' }, limit: { type: 'integer', minimum: 1, maximum: 15 } }, required: ['query'], additionalProperties: false } },
  { name: 'get_book', description: 'Full record for one book: description, series, every story gene with its meaning, and how many readers logged it. Pass the id from a search, or a title.',
    input_schema: { type: 'object', properties: { book: { type: 'string', description: 'Book id or title' } }, required: ['book'], additionalProperties: false } },
  { name: 'similar_books', description: 'Books whose Story DNA overlaps most with one book, with the genes they share. Rare shared genes count more than common ones.',
    input_schema: { type: 'object', properties: { book: { type: 'string', description: 'Book id or title' }, limit: { type: 'integer', minimum: 1, maximum: 12 }, must_have: { type: 'array', items: { type: 'string' }, description: 'Optional gene slugs every result must carry' }, avoid: { type: 'array', items: { type: 'string' }, description: 'Optional gene slugs to exclude' } }, required: ['book'], additionalProperties: false } },
  { name: 'books_with_genes', description: 'Books that carry a set of story genes. match "all" needs every gene, "any" ranks by how many they carry.',
    input_schema: { type: 'object', properties: { genes: { type: 'array', items: { type: 'string' }, minItems: 1 }, match: { type: 'string', enum: ['all', 'any'] }, avoid: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer', minimum: 1, maximum: 15 } }, required: ['genes'], additionalProperties: false } },
  { name: 'compare_books', description: 'Compare the Story DNA of 2 to 4 books: genes they all share, and genes unique to each.',
    input_schema: { type: 'object', properties: { books: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, description: 'Book ids or titles' } }, required: ['books'], additionalProperties: false } },
];

const arr = x => Array.isArray(x) ? x.map(String) : [];
function runTool(name, input, seen) {
  const lim = (n, d, m) => Math.min(m, Math.max(1, Math.round(+n) || d));
  const mark = list => { for (const b of list) seen.add(b.id); return list; };
  if (name === 'search_books') {
    const r = mark(search(String(input.query || ''), arr(input.genes), lim(input.limit, 8, 15)));
    return { results: r.map(brief), total_books_in_library: BOOKS.length };
  }
  if (name === 'get_book') {
    const b = findBook(String(input.book || '')); if (!b) return { error: 'Not in the library' };
    seen.add(b.id);
    return { id: b.id, title: b.t, author: b.a, year: b.y, series: b.se, series_number: b.si, readers_logged: b.r || 0,
      description: b.d || 'No description on file', reader_added: !!b.u,
      genes: b.g.map(s => ({ slug: s, name: gname(s), meaning: GENE.get(s)?.d, family: GENE.get(s)?.f, verified_with_sources: (b.v || []).includes(s) || undefined })) };
  }
  if (name === 'similar_books') {
    const b = findBook(String(input.book || '')); if (!b) return { error: 'Not in the library' };
    seen.add(b.id);
    const must = arr(input.must_have), avoid = new Set(arr(input.avoid));
    const r = BOOKS.filter(x => x.id !== b.id && (!x.se || x.se !== b.se) && must.every(g => x.g.includes(g)) && !x.g.some(g => avoid.has(g)))
      .map(x => ({ x, ...overlap(b, x) })).filter(o => o.shared.length).sort((p, q) => q.score - p.score).slice(0, lim(input.limit, 8, 12));
    mark(r.map(o => o.x));
    return { for: { id: b.id, title: b.t }, results: r.map(o => ({ ...brief(o.x), match: Math.round(o.score * 100) + '%', shared_genes: o.shared.map(gname) })) };
  }
  if (name === 'books_with_genes') {
    const want = arr(input.genes).filter(s => GENE.has(s)), avoid = new Set(arr(input.avoid));
    if (!want.length) return { error: 'None of those gene slugs exist. Use slugs from the gene list.' };
    const all = input.match !== 'any';
    const r = BOOKS.map(b => ({ b, n: want.filter(g => b.g.includes(g)).length })).filter(o => o.n && (!all || o.n === want.length) && !o.b.g.some(g => avoid.has(g)))
      .sort((p, q) => q.n - p.n || rare(q.b, want) - rare(p.b, want) || (q.b.r || 0) - (p.b.r || 0)).slice(0, lim(input.limit, 10, 15));
    mark(r.map(o => o.b));
    return { genes: want.map(gname), results: r.map(o => ({ ...brief(o.b), carries: o.n + ' of ' + want.length })) };
  }
  if (name === 'compare_books') {
    const bs = arr(input.books).map(findBook).filter(Boolean).filter((b, i, a) => a.indexOf(b) === i);
    if (bs.length < 2) return { error: 'Found fewer than two of those books in the library' };
    mark(bs);
    const shared = bs[0].g.filter(g => bs.every(b => b.g.includes(g)));
    return { books: bs.map(b => ({ id: b.id, title: b.t, author: b.a, unique_genes: b.g.filter(g => !bs.some(o => o !== b && o.g.includes(g))).map(gname) })),
      shared_by_all: shared.map(gname),
      pairwise: bs.length > 2 ? bs.flatMap((a, i) => bs.slice(i + 1).map(b => ({ a: a.t, b: b.t, match: Math.round(overlap(a, b).score * 100) + '%' }))) : { match: Math.round(overlap(bs[0], bs[1]).score * 100) + '%' } };
  }
  return { error: 'unknown tool' };
}

// ---------- prompt ----------
const FAMILIES = [...new Set(LIB.genes.map(g => g.f))];
const GENE_LIST = FAMILIES.map(f => `## ${f}\n` + LIB.genes.filter(g => g.f === f).map(g => `${g.s}: ${g.n}`).join('\n')).join('\n\n');
const SYSTEM = `You are the Librarian at The Library (yourstorydna.com), a science fiction book discovery app built on Story DNA. Every book in the library is tagged with story genes: the ingredients that make it what it is (settings, story engines, character types, themes, feel, vibes). Readers come to you to talk about books, understand why they loved one, and find what to read next.

How you work:
- Your knowledge of which books exist here, and their genes, comes only from your tools. Search before you name, describe, or recommend a book. Never recommend a book the tools did not return. If a reader asks about a book the library does not have, say so plainly and offer the closest books it does have.
- You may add what any well read librarian knows about a book (premise, author, reputation), but keep it spoiler light unless the reader asks for spoilers, and never contradict the library's data.
- Explain Story DNA in plain words: say which genes two books share and why that overlap means the reader will likely enjoy one if they loved the other. Use gene names, never slugs.
- When you mention a specific library book, write its token [[book:ID]] right after its title the first time, using the exact id from a tool result. The app turns tokens into covers. Use at most 6 tokens per reply.
- Recommend 3 to 5 books unless asked for more, each with one line on the genes that connect it.
- If a request is vague, make a good first pick and ask one short follow up question.
- The library is science fiction only for now. For other genres, say the library is sci-fi for now.

Voice: a friendly, sharp librarian who reads everything. Short, conversational replies, usually under 150 words. Plain words. No em dashes. No buzzwords or hype words (game changer, must-read masterpiece, delve, tapestry, unleash, elevate, journey). Light markdown only: **bold** titles are fine, short lists are fine, no headings.

The full gene list (slug: name), grouped by family:

${GENE_LIST}`;

// ---------- route ----------
let client = null, clientKey = '';
const MAX_ROUNDS = 5;

export async function chat(req, res, { ip, send, body, secret, settings, limited, db, countUsage }) {
  const key = (await secret('anthropic')).value;
  if (!key) return send(res, 503, { error: 'nokey' });
  if (limited(ip, 'c', 40)) return send(res, 429, { error: 'rate', message: 'You have asked a lot this hour. Try again in a bit.' });
  const s = await settings();
  if (db) { try { const r = await db.query(`SELECT coalesce(sum(n),0)::int n FROM site_usage WHERE day=current_date AND kind='chat'`); if (r.rows[0].n >= s.chatCap) return send(res, 429, { error: 'cap', message: 'The Librarian is resting for today. Back tomorrow.' }); } catch {} }

  const b = await body(req, 40000);
  const history = (Array.isArray(b.messages) ? b.messages : []).slice(-12)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length || history[history.length - 1].role !== 'user') return send(res, 400, { error: 'bad messages' });
  // merge any same-role neighbours so turns alternate
  const messages = history.reduce((a, m) => { const l = a[a.length - 1]; if (l && l.role === m.role) l.content += '\n\n' + m.content; else a.push({ ...m }); return a; }, []);
  const ctx = typeof b.book === 'string' && BYID.get(b.book);
  if (ctx) messages[messages.length - 1].content = `(The reader is looking at ${ctx.t} by ${ctx.a}, id ${ctx.id}.)\n\n` + messages[messages.length - 1].content;

  await refresh(db);
  if (!client || clientKey !== key) { client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 60e3 }); clientKey = key; }
  if (countUsage) await countUsage('chat');

  const seen = new Set();
  const params = {
    model: s.chatModel, max_tokens: 4000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: TOOLS, output_config: { effort: 'low' }, messages,
  };
  let text = '', useFallback = true;
  try {
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      if (round === MAX_ROUNDS) params.tool_choice = { type: 'none' };
      let r;
      if (useFallback) {
        try { r = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }); }
        catch (e) { if (e instanceof Anthropic.BadRequestError) { useFallback = false; r = await client.messages.create(params); } else throw e; }
      } else r = await client.messages.create(params);
      if (r.stop_reason === 'refusal') { text = "I can't help with that one, but ask me about any book in the library."; break; }
      const uses = r.content.filter(c => c.type === 'tool_use');
      text = r.content.filter(c => c.type === 'text').map(c => c.text).join('');
      if (r.stop_reason !== 'tool_use' || !uses.length) break;
      messages.push({ role: 'assistant', content: r.content });
      messages.push({ role: 'user', content: uses.map(u => {
        let out; try { out = runTool(u.name, u.input || {}, seen); } catch (e) { out = { error: 'tool failed' }; console.error('librarian tool', u.name, e.message); }
        return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out), ...(out.error ? { is_error: true } : {}) };
      }) });
    }
  } catch (e) {
    console.error('librarian', e.status || '', e.message);
    if (e instanceof Anthropic.RateLimitError) return send(res, 429, { error: 'busy', message: 'The Librarian is busy. Try again in a moment.' });
    return send(res, 502, { error: 'model' });
  }

  // Only tokens for real library books survive; the page gets their card data.
  const ids = [];
  text = text.replace(/\s*\u2014\s*|\s+\u2013\s+/g, ', ').replace(/\[\[book:([\w.-]{1,100})\]\]/g, (m, id) => { if (!BYID.has(id)) return ''; if (!ids.includes(id)) ids.push(id); return m; }).replace(/[ \t]{2,}/g, ' ').replace(/ ([,.!?])/g, '$1').trim();
  const books = ids.slice(0, 8).map(id => { const x = BYID.get(id); return { id: x.id, t: x.t, a: x.a, y: x.y, cv: x.cv, g: x.g.slice(0, 3).map(gname) }; });
  send(res, 200, { reply: text || 'Sorry, I lost my place. Ask me again?', books });
}

export { runTool as _runTool, search as _search };
export const librarianInfo = () => ({ books: BOOKS.length, genes: LIB.genes.length });
