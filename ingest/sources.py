"""Legal-today data sources for Story DNA (sci-fi). Runs on the VPS next to Postgres.

Every claim lands in one `evidence` table with its source, strength and receipt.
Steps (env STEPS, comma separated):
  schema    - create evidence table, book_ids table and gene_blend view
  backfill  - copy existing book_genes rows (claude, kimi, ol-subjects) into evidence
  wikidata  - Wikidata (CC0): match by Open Library work id, then title+author; awards, nominations,
              series, genres/subjects, ISFDB and Gutenberg ids
  isfdb     - ISFDB REST API (getpub by ISBN, documented public API) for books that have an ISBN in raw
  gutenberg - Project Gutenberg official catalog CSV (bulk feed meant for this): public-domain sci-fi
              matched by title+author, sets books.free_url when empty
  promote   - turn hard facts into shown genes (award_winner, free_to_read_legally, classic) as source 'facts'
  report    - print counts
No secrets here: the DB password comes from the environment.
"""
import os, re, sys, json, time, gzip, csv, io, urllib.request, urllib.parse, unicodedata
import xml.etree.ElementTree as ET
import psycopg

UA = "StoryDNA-sources/1.0 (book discovery app; https://yourstorydna.com)"
STEPS = os.environ.get("STEPS", "schema,backfill,wikidata,gutenberg,promote,report").split(",")
PAUSE = float(os.environ.get("PAUSE", "1.0"))
ISFDB_LIMIT = int(os.environ.get("ISFDB_LIMIT", "600"))

def log(*a): print(*a, flush=True)

def fetch(url, data=None, tries=4, timeout=90, accept=None, raw=False):
    for i in range(tries):
        try:
            h = {"User-Agent": UA}
            if accept: h["Accept"] = accept
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                b = r.read()
                return b if raw else b.decode("utf-8", "replace")
        except Exception as e:
            if i == tries - 1:
                log("  fetch failed", url[:110], e); return None
            time.sleep(5 * (i + 1))
        finally:
            time.sleep(PAUSE)

def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"^(the|a|an) ", "", s.strip())
    return re.sub(r"[^a-z0-9]", "", s)

def last(a):
    a = (a or "").split(",")[0].split(" and ")[0].strip()
    return norm(a.split()[-1]) if a.split() else ""

def conn():
    pw = os.environ.get("POSTGRES_PASSWORD") or os.environ.get("PGPASSWORD")
    if not pw: log("no database password in environment"); sys.exit(2)
    return psycopg.connect(host=os.environ.get("PGHOST", "db"), dbname="library", user="library", password=pw, autocommit=True)

SCHEMA = """
CREATE TABLE IF NOT EXISTS evidence(
  id bigserial PRIMARY KEY,
  book_id int NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('gene','vibe','verdict','scale','fact')),
  target text NOT NULL,
  value text NOT NULL DEFAULT '',
  source text NOT NULL,
  strength real NOT NULL DEFAULT 0.5,
  polarity smallint NOT NULL DEFAULT 1,
  receipt_url text,
  receipt_text text,
  license text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(book_id, target_kind, target, source, value));
CREATE INDEX IF NOT EXISTS evidence_book ON evidence(book_id);
CREATE INDEX IF NOT EXISTS evidence_target ON evidence(target_kind, target);
CREATE TABLE IF NOT EXISTS book_ids(
  book_id int NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  scheme text NOT NULL, ext_id text NOT NULL, source text NOT NULL,
  PRIMARY KEY(book_id, scheme, ext_id));
CREATE OR REPLACE VIEW gene_blend AS
  SELECT e.book_id, e.target AS gene,
         1 - exp(coalesce(sum(ln(greatest(1e-6, 1 - least(0.999, e.strength)))) FILTER (WHERE e.polarity > 0), 0)) AS score,
         count(*) FILTER (WHERE e.polarity < 0) AS against,
         count(DISTINCT split_part(e.source, '-', 1)) FILTER (WHERE e.polarity > 0) AS proof_kinds,
         array_agg(DISTINCT e.source) AS sources
  FROM evidence e WHERE e.target_kind IN ('gene','vibe') GROUP BY e.book_id, e.target;
"""
# gene_blend: score = noisy-OR of positive evidence; the plan's bar for showing is score >= 0.6 with 2+ proof kinds.

def add(c, book_id, kind, target, source, strength, value="", url=None, text=None, lic=None, polarity=1):
    c.execute("""INSERT INTO evidence(book_id,target_kind,target,value,source,strength,polarity,receipt_url,receipt_text,license)
                 VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                 ON CONFLICT (book_id,target_kind,target,source,value) DO UPDATE
                 SET strength=EXCLUDED.strength, receipt_url=EXCLUDED.receipt_url, receipt_text=EXCLUDED.receipt_text, fetched_at=now()""",
              (book_id, kind, target, value or "", source, strength, polarity, url, (text or "")[:500] or None, lic))
    return c.rowcount

def add_id(c, book_id, scheme, ext, source):
    c.execute("INSERT INTO book_ids VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING", (book_id, scheme, str(ext), source))

def step_schema(db):
    with db.cursor() as c: c.execute(SCHEMA)
    log("schema: evidence, book_ids, gene_blend ready")

def step_backfill(db):
    with db.cursor() as c:
        c.execute("""INSERT INTO evidence(book_id,target_kind,target,value,source,strength,polarity,receipt_text,license)
                     SELECT bg.book_id, CASE WHEN g.slug LIKE 'vibe\\_%%' THEN 'vibe' ELSE 'gene' END, g.slug, '', bg.source,
                            bg.confidence, CASE WHEN bg.presence < 0 THEN -1 ELSE 1 END, left(bg.evidence, 500),
                            CASE WHEN bg.source LIKE 'ol-%%' OR bg.source='openlibrary-print' THEN 'Open Library data (CC0)' ELSE 'editorial' END
                     FROM book_genes bg JOIN genes g ON g.id=bg.gene_id
                     ON CONFLICT (book_id,target_kind,target,source,value) DO NOTHING""")
        log(f"backfill: {c.rowcount} rows copied from book_genes")
        c.execute("""INSERT INTO book_ids SELECT id,'openlibrary',ol_key,'openlibrary' FROM books WHERE ol_key IS NOT NULL ON CONFLICT DO NOTHING""")

# ---------- Wikidata ----------
WD = "https://query.wikidata.org/sparql"
WD_LIC = "Wikidata (CC0)"
PROPS = {"P166": "award_won", "P1411": "award_nominated", "P179": "series", "P136": "genre", "P921": "main_subject",
         "P1274": "isfdb_title", "P2034": "gutenberg_id", "P407": "language", "P31": "instance_of"}
# Wikidata genre / subject label -> gene slug (only genes that exist in genes_sf.json)
LABEL_GENES = {
    "space opera": "space_opera", "cyberpunk": "cyberpunk", "military science fiction": "military",
    "hard science fiction": "hard_science", "time travel": "time_travel", "time travel in fiction": "time_travel",
    "dystopian fiction": "dystopian_state", "dystopian novel": "dystopian_state", "dystopia": "dystopian_state",
    "post-apocalyptic fiction": "post_apocalypse", "apocalyptic and post-apocalyptic fiction": "post_apocalypse",
    "alien invasion": "alien_invasion", "first contact": "first_contact", "generation ship": "generation_ships",
    "climate fiction": "climate_fiction", "solarpunk": "solarpunk", "biopunk": "biopunk", "alternate history": "alternate_history",
    "utopian and dystopian fiction": "dystopian_state", "artificial intelligence": "ai_awakening", "robot": "robot_companions",
    "parallel universe": "parallel_worlds", "multiverse": "multiverse_hopping", "virtual reality": "virtual_reality",
    "colonization of mars": "colonization_story", "space colonization": "colonization_story", "terraforming": "terraforming",
    "cosmic horror": "cosmic_horror", "lovecraftian horror": "cosmic_horror", "science fantasy": "mythic",
    "dying earth": "dying_earth", "dying earth genre": "dying_earth", "planetary romance": "space_opera",
    "novella": "novella", "short story collection": "short_stories", "anthology": "short_stories",
    "detective fiction": "noir_detective", "mystery fiction": "whodunit_with_a_twist_of_tech", "humorous science fiction": "funny",
    "comic science fiction": "funny", "satire": "funny", "romance novel": "slow_burn_romance", "lgbt literature": "queer_leads",
    "epistolary novel": "epistolary_and_found_documents", "immortality": "immortality_tech", "cloning": "clones",
    "genetic engineering": "genetic_engineering", "nanotechnology": "nanotech", "technological singularity": "the_singularity",
    "mars": "the_solar_system_settled", "telepathy": "telepathy", "cyborg": "cyborgs", "android": "androids_passing_as_human",
    "transhumanism": "post_human_forms", "mind uploading": "mind_transfer", "fermi paradox": "the_fermi_question",
    "coming-of-age story": "coming_of_age", "bildungsroman": "coming_of_age", "war novel": "war_is_hell",
    "survival": "survival_against_the_planet", "heist": "heists", "thriller": "conspiracy_thriller",
    "techno-thriller": "conspiracy_thriller", "spy fiction": "spy_games", "steampunk": "retro_futures",
    "young adult fiction": "coming_of_age", "zombie": "outbreak", "pandemic": "plague_aftermath",
}
NOVELISH = ("novel", "literary work", "written work", "book", "novella", "short story", "collection", "series", "trilogy", "version, edition")

def sparql(q):
    t = fetch(WD, data=urllib.parse.urlencode({"query": q, "format": "json"}).encode(), accept="application/sparql-results+json", timeout=120)
    if not t: return []
    try: return json.loads(t)["results"]["bindings"]
    except Exception as e: log("  sparql parse failed", e, t[:200]); return []

def wd_facts(c, book_id, qid, rows, source, valid):
    n = 0
    add_id(c, book_id, "wikidata", qid, source)
    url = "https://www.wikidata.org/wiki/" + qid
    for r in rows:
        p = r["p"]["value"].rsplit("/", 1)[-1]; key = PROPS.get(p)
        if not key: continue
        val = r.get("vLabel", r["v"])["value"]
        if key in ("isfdb_title", "gutenberg_id"):
            add_id(c, book_id, key.split("_")[0], r["v"]["value"], source)
        if key == "instance_of": continue
        n += add(c, book_id, "fact", key, source, 1.0, value=val, url=url, lic=WD_LIC)
        if key in ("genre", "main_subject"):
            g = LABEL_GENES.get(val.lower())
            if g and g in valid:
                n += add(c, book_id, "gene", g, source, 0.6, value=val, url=url, text=f"Wikidata {key.replace('_',' ')}: {val}", lic=WD_LIC)
        if key == "award_won" and "award_winner" in valid and re.search(r"award|prize|medal|premio|preis|prix|seiun|hugo|nebula", val, re.I):
            n += add(c, book_id, "gene", "award_winner", source, 0.95, value=val, url=url, text=f"Won: {val}", lic=WD_LIC)
        if key == "series" and "long_series" in valid:
            pass
    return n

def step_wikidata(db):
    with db.cursor() as c:
        c.execute("SELECT slug FROM genes"); valid = {r[0] for r in c.fetchall()}
        c.execute("""SELECT id, ol_key, title, author FROM books WHERE genre='sf' AND excluded_reason IS NULL
                     ORDER BY (tier='core') DESC, readers DESC NULLS LAST""")
        books = c.fetchall()
    by_ol = {b[1].rsplit("/", 1)[-1]: b[0] for b in books if b[1]}
    pvals = " ".join("wdt:" + p for p in PROPS)
    matched = {}; facts = 0
    ols = list(by_ol)
    log(f"wikidata: {len(books)} books, {len(ols)} with an Open Library work id")
    for i in range(0, len(ols), 150):
        chunk = ols[i:i + 150]
        q = f"""SELECT ?ol ?item ?p ?v ?vLabel WHERE {{ VALUES ?ol {{ {' '.join(json.dumps(x) for x in chunk)} }}
               ?item wdt:P648 ?ol . VALUES ?p {{ {pvals} }} ?item ?p ?v .
               SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }} }}"""
        rows = sparql(q); grp = {}
        for r in rows:
            grp.setdefault((r["ol"]["value"], r["item"]["value"].rsplit("/", 1)[-1]), []).append(r)
        with db.cursor() as c:
            for (ol, qid), rr in grp.items():
                bid = by_ol.get(ol)
                if not bid or bid in matched: continue
                types = {x.get("vLabel", x["v"])["value"].lower() for x in rr if x["p"]["value"].endswith("P31")}
                if types and not any(any(k in t for k in NOVELISH) for t in types): continue
                matched[bid] = qid; facts += wd_facts(c, bid, qid, rr, "wikidata", valid)
        log(f"  ol pass {i + len(chunk)}/{len(ols)}: matched {len(matched)}")
    # pass 2: English title label + author last name for core-ish books not matched yet (top readers first)
    rest = [b for b in books if b[0] not in matched and b[2]][: int(os.environ.get("WD_TITLE_LIMIT", "2500"))]
    for i in range(0, len(rest), 60):
        chunk = rest[i:i + 60]
        vals = " ".join(json.dumps(b[2]) + "@en" for b in chunk)
        q = f"""SELECT ?t ?item ?aLabel WHERE {{ VALUES ?t {{ {vals} }} ?item rdfs:label ?t ; wdt:P50 ?a .
               SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }} }}"""
        rows = sparql(q); cand = {}
        for r in rows:
            cand.setdefault(norm(r["t"]["value"]), []).append((r["item"]["value"].rsplit("/", 1)[-1], r["aLabel"]["value"]))
        hits = {}
        for b in chunk:
            for qid, al in cand.get(norm(b[2]), []):
                if last(al) and last(al) == last(b[3]): hits[qid] = b[0]; break
        if not hits: continue
        q = f"""SELECT ?item ?p ?v ?vLabel WHERE {{ VALUES ?item {{ {' '.join('wd:' + k for k in hits)} }}
               VALUES ?p {{ {pvals} }} ?item ?p ?v . SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }} }}"""
        grp = {}
        for r in sparql(q): grp.setdefault(r["item"]["value"].rsplit("/", 1)[-1], []).append(r)
        with db.cursor() as c:
            for qid, rr in grp.items():
                bid = hits[qid]
                if bid in matched: continue
                types = {x.get("vLabel", x["v"])["value"].lower() for x in rr if x["p"]["value"].endswith("P31")}
                if types and not any(any(k in t for k in NOVELISH) for t in types): continue
                matched[bid] = qid; facts += wd_facts(c, bid, qid, rr, "wikidata", valid)
        log(f"  title pass {i + len(chunk)}/{len(rest)}: matched {len(matched)}")
    log(f"wikidata: matched {len(matched)} books, wrote {facts} evidence rows")

# ---------- ISFDB (public REST API, by ISBN) ----------
def isbns_of(raw):
    if not raw: return []
    s = json.dumps(raw)
    return list(dict.fromkeys(re.findall(r'"(97[89]\d{10}|\d{9}[\dX])"', s)))[:3]

def step_isfdb(db):
    with db.cursor() as c:
        c.execute("""SELECT id, title, author, raw FROM books WHERE genre='sf' AND excluded_reason IS NULL AND raw IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM book_ids i WHERE i.book_id=books.id AND i.scheme='isfdb_pub')
                     ORDER BY (tier='core') DESC, readers DESC NULLS LAST LIMIT %s""", (ISFDB_LIMIT,))
        books = c.fetchall()
    found = 0; tried = 0
    for bid, title, author, raw in books:
        isb = isbns_of(raw)
        if not isb: continue
        tried += 1
        for isbn in isb:
            x = fetch("https://www.isfdb.org/cgi-bin/rest/getpub.cgi?" + isbn, raw=True)
            if not x: continue
            try: root = ET.fromstring(x)
            except Exception: continue
            pubs = root.findall(".//Publication")
            ok = [p for p in pubs if norm(p.findtext("Title")) == norm(title) or last(" ".join(a.text or "" for a in p.findall(".//Author"))) == last(author)]
            if not ok: continue
            p = ok[0]; rec = p.findtext("Record")
            with db.cursor() as c:
                add_id(c, bid, "isfdb_pub", rec, "isfdb")
                url = f"https://www.isfdb.org/cgi-bin/pl.cgi?{rec}"
                for k, tag in (("isfdb_type", "Type"), ("pages", "Pages"), ("publisher", "Publisher")):
                    v = p.findtext(tag)
                    if v: add(c, bid, "fact", k, "isfdb", 1.0, value=v.strip(), url=url, lic="ISFDB (CC BY 2.0)")
                t = (p.findtext("Type") or "").upper()
                if t in ("COLLECTION", "ANTHOLOGY", "OMNIBUS"):
                    add(c, bid, "gene", "short_stories" if t != "OMNIBUS" else "complete_series", "isfdb", 0.7, value=t, url=url, text=f"ISFDB type {t}", lic="ISFDB (CC BY 2.0)")
                if t == "CHAPBOOK":
                    add(c, bid, "gene", "novella", "isfdb", 0.6, value=t, url=url, text="ISFDB type CHAPBOOK (short work)", lic="ISFDB (CC BY 2.0)")
            found += 1; break
    log(f"isfdb: tried {tried} books with an ISBN, matched {found}")

# ---------- Project Gutenberg (official catalog feed) ----------
def step_gutenberg(db):
    b = None
    for u in ("https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz", "https://gutenberg.pglaf.org/cache/epub/feeds/pg_catalog.csv.gz",
              "https://aleph.pglaf.org/cache/epub/feeds/pg_catalog.csv.gz"):
        b = fetch(u, raw=True, timeout=300, tries=2)
        if b: break
    rows = []
    if b:
        rows = list(csv.DictReader(io.StringIO(gzip.decompress(b).decode("utf-8", "replace"))))
    else:
        log("gutenberg: catalog feed unavailable, using Wikidata ids plus Gutendex search for pre-1930 books")
        with db.cursor() as c:
            c.execute("""SELECT b.id, b.title, b.author FROM books b WHERE genre='sf' AND excluded_reason IS NULL AND year < 1930
                         AND NOT EXISTS (SELECT 1 FROM book_ids i WHERE i.book_id=b.id AND i.scheme='gutenberg')""")
            old = c.fetchall()
        seen = set()
        for bid, title, author in old:
            t = fetch("https://gutendex.com/books?" + urllib.parse.urlencode({"search": f"{title} {author.split()[-1] if author else ''}"}), timeout=90, tries=2)
            if not t: continue
            for r in json.loads(t).get("results", []):
                if r["id"] in seen: continue
                seen.add(r["id"])
                au = "; ".join(f"{a['name']}, {a.get('birth_year') or ''}-{a.get('death_year') or ''}" for a in r.get("authors", []))
                rows.append({"Text#": str(r["id"]), "Type": "Text", "Language": ";".join(r.get("languages", [])), "Title": r["title"], "Authors": au})
        with db.cursor() as c:
            c.execute("SELECT DISTINCT ext_id FROM book_ids WHERE scheme='gutenberg'")
            for (gid,) in c.fetchall():
                if gid not in seen: rows.append({"Text#": gid, "Type": "Text", "Language": "en", "Title": "", "Authors": ""})
    idx = {}
    for r in rows:
        if r.get("Type") != "Text" or "en" not in (r.get("Language") or ""): continue
        for t in re.split(r"[\n\r]+", r.get("Title") or ""):
            t = t.split(":")[0].split(";")[0]
            idx.setdefault(norm(t), []).append(r)
    log(f"gutenberg: catalog {len(rows)} rows, {len(idx)} English titles")
    with db.cursor() as c:
        c.execute("""SELECT b.id, b.title, b.author, b.year, b.free_url, (SELECT ext_id FROM book_ids i WHERE i.book_id=b.id AND i.scheme='gutenberg' LIMIT 1)
                     FROM books b WHERE genre='sf' AND excluded_reason IS NULL AND (year IS NULL OR year < 1960)""")
        n = 0
        for bid, title, author, year, free, gid in c.fetchall():
            hit = None
            if gid:
                hit = next((r for r in rows if r.get("Text#") == gid), None)
            if gid and not hit:
                hit = {"Text#": gid, "Authors": ""}
            if not hit:
                for r in idx.get(norm(title), []):
                    auth = r.get("Authors") or ""
                    if last(author) and last(author) in norm(auth):
                        hit = r; break
            if not hit: continue
            m = re.search(r"(\d{4})\s*-\s*(\d{4})", hit.get("Authors") or "")
            if year and year >= 1930 and not gid and not (m and int(m.group(2)) < 1955):
                continue  # keep to clearly old works; PG is US public domain, other countries differ
            url = f"https://www.gutenberg.org/ebooks/{hit['Text#']}"
            add_id(c, bid, "gutenberg", hit["Text#"], "gutenberg")
            add(c, bid, "fact", "free_text", "gutenberg", 1.0, value=url, url=url, text="Project Gutenberg (public domain in the USA)", lic="Public domain (USA)")
            add(c, bid, "gene", "free_to_read_legally", "gutenberg", 0.95, url=url, text="On Project Gutenberg", lic="Public domain (USA)")
            if not free:
                c.execute("UPDATE books SET free_url=%s WHERE id=%s AND free_url IS NULL", (url, bid))
            n += 1
    log(f"gutenberg: {n} books linked to a free legal copy")

# ---------- promote hard facts into shown genes ----------
def step_promote(db):
    with db.cursor() as c:
        # Wikidata P166 also holds "best of" lists (NPR Top 100 and the like): those are not awards
        c.execute("""DELETE FROM evidence WHERE target_kind='gene' AND target='award_winner' AND source='wikidata'
                     AND value !~* '(award|prize|medal|premio|preis|prix|seiun|hugo|nebula)'""")
        log(f"promote: dropped {c.rowcount} award_winner rows that were lists, not awards")
        c.execute("DELETE FROM book_genes WHERE source='facts'")
        c.execute("""INSERT INTO book_genes(book_id,gene_id,source,presence,confidence,state,evidence)
                     SELECT e.book_id, g.id, 'facts', 1, max(e.strength), 'shown', string_agg(DISTINCT e.receipt_text, '; ')
                     FROM evidence e JOIN genes g ON g.slug=e.target
                     WHERE e.target_kind='gene' AND e.target IN ('award_winner','free_to_read_legally') AND e.source IN ('wikidata','gutenberg')
                     GROUP BY e.book_id, g.id
                     ON CONFLICT (book_id,gene_id,source) DO UPDATE SET confidence=EXCLUDED.confidence, evidence=EXCLUDED.evidence""")
        log(f"promote: {c.rowcount} fact genes shown (award_winner, free_to_read_legally)")
        c.execute("""INSERT INTO book_genes(book_id,gene_id,source,presence,confidence,state,evidence)
                     SELECT e.book_id, g.id, 'wikidata', 1, 0.6, 'hidden', string_agg(DISTINCT e.receipt_text, '; ')
                     FROM evidence e JOIN genes g ON g.slug=e.target
                     WHERE e.target_kind='gene' AND e.source='wikidata' AND e.target NOT IN ('award_winner')
                     GROUP BY e.book_id, g.id ON CONFLICT DO NOTHING""")
        log(f"promote: {c.rowcount} wikidata genre genes stored hidden (blend input, not shown)")

def step_report(db):
    with db.cursor() as c:
        c.execute("SELECT source, target_kind, count(*), count(DISTINCT book_id) FROM evidence GROUP BY 1,2 ORDER BY 1,2")
        for r in c.fetchall(): log("EVIDENCE", *r)
        c.execute("SELECT scheme, count(*) FROM book_ids GROUP BY 1 ORDER BY 1")
        for r in c.fetchall(): log("IDS", *r)
        c.execute("SELECT value, count(*) FROM evidence WHERE target='award_won' GROUP BY 1 ORDER BY 2 DESC LIMIT 15")
        for r in c.fetchall(): log("AWARD", *r)
        c.execute("SELECT count(*) FROM gene_blend WHERE score>=0.6 AND proof_kinds>=2")
        log("BLEND genes passing 0.6 with 2+ proof kinds:", c.fetchone()[0])
        c.execute("SELECT count(*) FROM books WHERE free_url IS NOT NULL"); log("FREE_URL books:", c.fetchone()[0])
        c.execute("""SELECT b.title, b.author, e.value FROM evidence e JOIN books b ON b.id=e.book_id
                     WHERE e.target='free_text' ORDER BY b.readers DESC NULLS LAST LIMIT 25""")
        for r in c.fetchall(): log("FREE", *r)

if __name__ == "__main__":
    db = conn()
    for s in STEPS:
        s = s.strip()
        if not s: continue
        log(f"== {s}"); t = time.time()
        globals()["step_" + s](db)
        log(f"== {s} done in {time.time() - t:.0f}s")
