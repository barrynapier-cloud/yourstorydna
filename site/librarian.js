// The Librarian: a chat panel readers can ask about books. Self-contained (own styles, own
// DOM under #sdna-lib), loaded by claude-shim.js so app rebuilds never drop it.
// Talks to POST /api/chat. Shows only when the server has a Claude key (or with ?librarian=1).
(function () {
  if (window.Librarian || window.top !== window && !/librarian=1/.test(location.search)) return;
  const API = (window.STORYDNA_API || '/api') + '/chat';
  const KEY = 'sdna-librarian-v1';
  const SUGGEST = [
    'Something like Project Hail Mary',
    'Why do people love Dune?',
    'Compare Hyperion and Dune',
    'A bleak book set on a generation ship',
  ];
  let msgs = [], books = {}, busy = false, open = false, built = false, root, log, input, sendBtn;
  try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s) { msgs = s.msgs || []; books = s.books || {}; } } catch {}
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify({ msgs: msgs.slice(-30), books })); } catch {} };

  const css = `
#sdna-lib{--L-acc:var(--acc,#5CE1FF);--L-hot:var(--hot,#FF4FD8);--L-ink:var(--ink,#F2F6FF);--L-mute:var(--mute,#AEB9DA);--L-line:var(--line,#ffffff2e);--L-bg:var(--bg,#03040C);--L-panel:var(--panel,#070A1Ce6);--L-hf:var(--hf,Unbounded,sans-serif);font:15px/1.5 Manrope,system-ui,sans-serif;color:var(--L-ink)}
#sdna-lib *{box-sizing:border-box}
#sdna-lib .lb-fab{position:fixed;right:max(18px,env(safe-area-inset-right,0px));bottom:max(18px,env(safe-area-inset-bottom,0px));z-index:190;display:flex;align-items:center;gap:10px;height:52px;padding:0 20px 0 14px;border-radius:26px;border:1px solid var(--L-line);background:var(--L-panel);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);color:var(--L-ink);font:800 12px/1 var(--L-hf);letter-spacing:.16em;text-transform:uppercase;cursor:pointer;box-shadow:0 0 0 1px #0006,0 10px 40px #0008,0 0 28px color-mix(in srgb,var(--L-acc) 35%,transparent);transition:transform .2s}
#sdna-lib .lb-fab:hover{transform:translateY(-2px)}
#sdna-lib .lb-fab i{width:26px;height:26px;border-radius:50%;background:radial-gradient(circle at 35% 35%,var(--L-acc),var(--L-hot));box-shadow:0 0 14px var(--L-acc);display:block;position:relative}
#sdna-lib .lb-fab i:after{content:"";position:absolute;inset:8px;border-radius:50%;background:var(--L-bg);opacity:.75}
#sdna-lib.on .lb-fab{display:none}
#sdna-lib .lb-panel{position:fixed;right:max(18px,env(safe-area-inset-right,0px));bottom:max(18px,env(safe-area-inset-bottom,0px));z-index:191;width:min(430px,calc(100vw - 36px));height:min(680px,calc(100vh - 36px));display:none;flex-direction:column;border-radius:var(--rad,20px);border:1px solid var(--L-line);background:var(--L-panel);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);box-shadow:0 20px 80px #000b,0 0 40px color-mix(in srgb,var(--L-acc) 22%,transparent);overflow:hidden}
#sdna-lib.on .lb-panel{display:flex;animation:lbIn .28s ease-out}
@keyframes lbIn{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}
#sdna-lib .lb-head{display:flex;align-items:center;gap:12px;padding:16px 16px 14px 18px;border-bottom:1px solid var(--L-line)}
#sdna-lib .lb-head b{font:800 14px/1.2 var(--L-hf);letter-spacing:.14em;text-transform:uppercase}
#sdna-lib .lb-head small{display:block;color:var(--L-mute);font-size:12px;letter-spacing:.02em;margin-top:3px}
#sdna-lib .lb-head .sp{flex:1}
#sdna-lib .lb-ic{width:36px;height:36px;border-radius:10px;border:1px solid var(--L-line);background:transparent;color:var(--L-mute);cursor:pointer;font:600 18px/1 Manrope,sans-serif;display:grid;place-items:center}
#sdna-lib .lb-ic:hover{color:var(--L-ink);border-color:var(--L-acc)}
#sdna-lib .lb-log{flex:1;overflow-y:auto;padding:16px 16px 6px;display:flex;flex-direction:column;gap:12px;overscroll-behavior:contain}
#sdna-lib .lb-m{max-width:92%;padding:11px 14px;border-radius:16px;white-space:normal;word-wrap:break-word}
#sdna-lib .lb-m p{margin:0 0 8px}#sdna-lib .lb-m p:last-child{margin:0}
#sdna-lib .lb-m ul,#sdna-lib .lb-m ol{margin:4px 0 8px;padding-left:20px}#sdna-lib .lb-m li{margin:3px 0}
#sdna-lib .lb-u{align-self:flex-end;background:var(--L-acc);color:var(--acc-ink,#03040C);border-bottom-right-radius:5px;font-weight:600}
#sdna-lib .lb-a{align-self:flex-start;background:color-mix(in srgb,var(--L-ink) 7%,transparent);border:1px solid var(--L-line);border-bottom-left-radius:5px}
#sdna-lib .lb-a strong{color:var(--L-ink)}
#sdna-lib .lb-t{color:var(--L-acc);font-weight:700;cursor:pointer;text-decoration:none;border-bottom:1px dotted currentColor}
#sdna-lib .lb-err{align-self:center;color:var(--L-mute);font-size:13px;text-align:center;padding:4px 10px}
#sdna-lib .lb-books{display:flex;gap:10px;overflow-x:auto;padding:2px 2px 6px;margin-top:2px;scrollbar-width:thin}
#sdna-lib .lb-b{flex:0 0 112px;text-align:left;background:transparent;border:0;padding:0;color:var(--L-ink);cursor:pointer;font:inherit}
#sdna-lib .lb-cv{width:112px;height:168px;border-radius:8px;overflow:hidden;position:relative;background:linear-gradient(150deg,color-mix(in srgb,var(--L-acc) 40%,#111),color-mix(in srgb,var(--L-hot) 40%,#111));box-shadow:0 6px 20px #0009;border:1px solid var(--L-line);transition:transform .2s}
#sdna-lib .lb-b:hover .lb-cv{transform:translateY(-3px);border-color:var(--L-acc)}
#sdna-lib .lb-cv img{width:100%;height:100%;object-fit:cover;display:block}
#sdna-lib .lb-cv span{position:absolute;inset:auto 8px 8px;font:800 11px/1.15 var(--L-hf);color:#fff;text-shadow:0 1px 4px #000}
#sdna-lib .lb-b b{display:block;font-size:12.5px;line-height:1.25;margin-top:7px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
#sdna-lib .lb-b em{display:block;font-style:normal;color:var(--L-mute);font-size:11.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#sdna-lib .lb-g{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
#sdna-lib .lb-g i{font-style:normal;font-size:10px;line-height:1;padding:4px 6px;border-radius:6px;border:1px solid color-mix(in srgb,var(--L-acc) 45%,transparent);color:var(--L-acc);white-space:nowrap;max-width:112px;overflow:hidden;text-overflow:ellipsis}
#sdna-lib .lb-hi{padding:6px 4px 2px}
#sdna-lib .lb-hi h3{margin:0 0 6px;font:700 20px/1.15 var(--L-hf)}
#sdna-lib .lb-hi p{margin:0 0 14px;color:var(--L-mute)}
#sdna-lib .lb-sug{display:flex;flex-wrap:wrap;gap:8px}
#sdna-lib .lb-sug button{border:1px solid var(--L-line);background:transparent;color:var(--L-ink);border-radius:12px;padding:9px 12px;font:600 13px/1.2 Manrope,sans-serif;cursor:pointer;text-align:left}
#sdna-lib .lb-sug button:hover{border-color:var(--L-acc);color:var(--L-acc)}
#sdna-lib .lb-dots{display:inline-flex;gap:5px;padding:4px 2px}
#sdna-lib .lb-dots i{width:7px;height:7px;border-radius:50%;background:var(--L-acc);animation:lbDot 1.1s infinite ease-in-out}
#sdna-lib .lb-dots i:nth-child(2){animation-delay:.15s}#sdna-lib .lb-dots i:nth-child(3){animation-delay:.3s}
@keyframes lbDot{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:none}}
#sdna-lib form{display:flex;gap:8px;padding:12px;border-top:1px solid var(--L-line)}
#sdna-lib textarea{flex:1;resize:none;height:46px;max-height:120px;border-radius:14px;border:1px solid var(--L-line);background:color-mix(in srgb,var(--L-bg) 70%,transparent);color:var(--L-ink);padding:12px 14px;font:15px/1.4 Manrope,system-ui,sans-serif;outline:none}
#sdna-lib textarea:focus{border-color:var(--L-acc)}
#sdna-lib textarea::placeholder{color:var(--L-mute)}
#sdna-lib .lb-go{flex:0 0 46px;height:46px;border:0;border-radius:14px;background:var(--L-acc);color:var(--acc-ink,#03040C);font:900 18px/1 Manrope,sans-serif;cursor:pointer}
#sdna-lib .lb-go:disabled{opacity:.4;cursor:default}
@media (max-width:560px){#sdna-lib .lb-panel{right:0;bottom:0;width:100vw;height:100dvh;border-radius:0;border:0;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}#sdna-lib .lb-fab{height:48px;padding:0 16px 0 12px}}
@media (prefers-reduced-motion:reduce){#sdna-lib *{animation:none!important;transition:none!important}}`;

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // Tiny, safe markdown: escape first, then bold/italic, lists, paragraphs, book tokens.
  function md(text) {
    const inline = s => esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\s*\[\[book:([\w.-]{1,100})\]\]/g, (m, id) => books[id] ? ` <a class="lb-t" data-id="${esc(id)}" title="${esc(books[id].t)}">&#9656;</a>` : '');
    const out = []; let list = null;
    for (const line of String(text).split('\n')) {
      const li = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
      if (li) { const t = li[1] ? 'ol' : 'ul'; if (!list || list.t !== t) { if (list) out.push(`</${list.t}>`); list = { t }; out.push(`<${t}>`); } out.push(`<li>${inline(li[2])}</li>`); continue; }
      if (list) { out.push(`</${list.t}>`); list = null; }
      if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`</${list.t}>`);
    return out.join('');
  }
  const cover = b => b.cv ? `https://covers.openlibrary.org/b/id/${encodeURIComponent(b.cv)}-M.jpg` : '';
  function card(b) {
    const img = cover(b);
    return `<button class="lb-b" data-id="${esc(b.id)}" title="${esc(b.t)}"><div class="lb-cv">${img ? `<img src="${img}" alt="${esc(b.t)}" loading="lazy" onerror="this.nextElementSibling.textContent=this.alt;this.remove()">` : ''}<span>${img ? '' : esc(b.t)}</span></div><b>${esc(b.t)}</b><em>${esc(b.a || '')}${b.y ? ' · ' + b.y : ''}</em>${b.g && b.g.length ? `<div class="lb-g">${b.g.slice(0, 2).map(g => `<i>${esc(g)}</i>`).join('')}</div>` : ''}</button>`;
  }

  function render() {
    if (!built) return;
    if (!msgs.length) {
      log.innerHTML = `<div class="lb-hi"><h3>Ask the Librarian</h3><p>Talk about any sci-fi book in the library. Ask why you loved one, what two books share, or what to read next. Answers come from our Story DNA database.</p><div class="lb-sug">${SUGGEST.map(s => `<button type="button">${esc(s)}</button>`).join('')}</div></div>`;
      return;
    }
    log.innerHTML = msgs.map(m => {
      if (m.role === 'user') return `<div class="lb-m lb-u">${esc(m.content)}</div>`;
      if (m.err) return `<div class="lb-err">${esc(m.content)}</div>`;
      const ids = m.ids || [];
      return `<div class="lb-m lb-a">${md(m.content)}${ids.length ? `<div class="lb-books">${ids.map(id => books[id] && card(books[id])).filter(Boolean).join('')}</div>` : ''}</div>`;
    }).join('') + (busy ? '<div class="lb-m lb-a"><span class="lb-dots"><i></i><i></i><i></i></span></div>' : '');
    log.scrollTop = log.scrollHeight;
  }

  async function ask(text) {
    text = String(text || '').trim(); if (!text || busy) return;
    msgs = msgs.filter(m => !m.err);
    msgs.push({ role: 'user', content: text.slice(0, 2000) });
    busy = true; sendBtn.disabled = true; render(); save();
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: msgs.filter(m => !m.err).slice(-12).map(m => ({ role: m.role, content: m.content })), book: ask.book || undefined }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw j;
      for (const b of j.books || []) books[b.id] = b;
      msgs.push({ role: 'assistant', content: j.reply, ids: (j.books || []).map(b => b.id) });
    } catch (e) {
      const msg = e && e.message ? e.message : e && e.error === 'nokey' ? 'The Librarian is not open yet. Check back soon.' : 'Something went wrong on my side. Try that again?';
      msgs.push({ role: 'assistant', content: msg, err: 1 });
    }
    ask.book = null; busy = false; sendBtn.disabled = false; render(); save();
  }

  function pick(id) {
    const b = books[id]; if (!b) return;
    if (window.L3 && typeof window.L3.openBook === 'function') { try { window.L3.openBook(id); toggle(false); return; } catch {} }
    ask(`Tell me about ${b.t} by ${b.a}. What is its Story DNA?`);
  }

  function build() {
    if (built) return; built = true;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    root = document.createElement('div'); root.id = 'sdna-lib';
    root.innerHTML = `<button class="lb-fab" type="button" aria-label="Ask the Librarian"><i></i>Ask the Librarian</button>
<section class="lb-panel" role="dialog" aria-label="The Librarian"><div class="lb-head"><div><b>The Librarian</b><small>Ask anything about the books in the library</small></div><div class="sp"></div><button class="lb-ic lb-new" type="button" title="New chat" aria-label="New chat">&#8635;</button><button class="lb-ic lb-x" type="button" title="Close" aria-label="Close">&times;</button></div>
<div class="lb-log" aria-live="polite"></div>
<form><textarea rows="1" placeholder="Ask about a book, or what to read next" aria-label="Your message" maxlength="2000"></textarea><button class="lb-go" type="submit" aria-label="Send">&#8593;</button></form></section>`;
    document.body.appendChild(root);
    log = root.querySelector('.lb-log'); input = root.querySelector('textarea'); sendBtn = root.querySelector('.lb-go');
    root.querySelector('.lb-fab').onclick = () => toggle(true);
    root.querySelector('.lb-x').onclick = () => toggle(false);
    root.querySelector('.lb-new').onclick = () => { if (busy) return; msgs = []; save(); render(); input.focus(); };
    root.querySelector('form').onsubmit = e => { e.preventDefault(); const t = input.value; input.value = ''; input.style.height = ''; ask(t); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); root.querySelector('form').requestSubmit(); } });
    input.addEventListener('input', () => { input.style.height = ''; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });
    log.addEventListener('click', e => {
      const s = e.target.closest('.lb-sug button'); if (s) return ask(s.textContent);
      const b = e.target.closest('[data-id]'); if (b) pick(b.dataset.id);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) toggle(false); });
    render();
  }
  function toggle(on) { build(); open = on; root.classList.toggle('on', on); if (on) { render(); setTimeout(() => input.focus(), 50); } }

  // Public hooks for the app: Librarian.open(), Librarian.ask("..."), Librarian.ask("...", bookId)
  window.Librarian = {
    open() { toggle(true); },
    close() { toggle(false); },
    ask(text, bookId) { toggle(true); ask.book = bookId || null; ask(text); },
  };

  async function start() {
    const force = /librarian=1/.test(location.search);
    let ok = force;
    if (!ok) { try { const h = await (await fetch((window.STORYDNA_API || '/api') + '/health')).json(); ok = !!h.model && !!h.librarian; } catch {} }
    if (ok) build();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
