"""Story DNA book ingest. Runs on the VPS in a one-shot container next to Postgres.

Steps (each can be switched with STEPS env, default all):
  genes   - sync genes table from genes_sf.json (append only)
  core    - curated core list (core.txt): Open Library match, upsert, genes as source claude-v1
  catalog - long tail from Open Library search by sci-fi subjects, genes from subject_map at low confidence
  desc    - fetch work descriptions for books missing one (core first, then most read)
  export  - write /out/data/books_sf.json (shown genes) and /out/data/catalog_sf.json (lite)
No secrets in this file: the DB password comes from the environment.
"""
import os, re, json, time, sys, urllib.request, urllib.parse, unicodedata
import psycopg

HERE = os.path.dirname(os.path.abspath(__file__))
UA = "StoryDNA-ingest/1.0 (book discovery app; contact via yourstorydna.com)"
STEPS = os.environ.get("STEPS", "genes,core,catalog,desc,export").split(",")
CAT_LIMIT = int(os.environ.get("CAT_LIMIT", "200"))     # per subject query
DESC_LIMIT = int(os.environ.get("DESC_LIMIT", "1500"))
OUT = os.environ.get("OUT", "/out")
PAUSE = float(os.environ.get("PAUSE", "0.35"))

def log(*a):
    print(*a, flush=True)

def get(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            if i == tries - 1:
                log("  fetch failed", url[:120], e); return None
            time.sleep(2 * (i + 1))
        finally:
            time.sleep(PAUSE)

def slugify(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = s.replace("'", "")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")

def norm(s):
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower())

def conn():
    pw = os.environ.get("POSTGRES_PASSWORD") or os.environ.get("PGPASSWORD")
    if not pw:
        log("no database password in environment"); sys.exit(2)
    return psycopg.connect(host=os.environ.get("PGHOST", "db"), dbname="library", user="library", password=pw, autocommit=True)

SCHEMA = """
ALTER TABLE books ADD COLUMN IF NOT EXISTS ol_key text;
ALTER TABLE books ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE books ADD COLUMN IF NOT EXISTS subjects text[];
ALTER TABLE books ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'core';
ALTER TABLE books ADD COLUMN IF NOT EXISTS readers int;
ALTER TABLE books ADD COLUMN IF NOT EXISTS ol_rating real;
ALTER TABLE books ADD COLUMN IF NOT EXISTS ol_rating_count int;
ALTER TABLE books ADD COLUMN IF NOT EXISTS editions int;
ALTER TABLE books ADD COLUMN IF NOT EXISTS updated_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS books_ol_key ON books(ol_key) WHERE ol_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS books_tier ON books(tier);
"""

# ---------- genes ----------
def step_genes(db):
    genes = json.load(open(os.path.join(HERE, "genes_sf.json")))
    fam_sort = {}; grp_sort = {}
    for i, g in enumerate(genes):
        fam_sort.setdefault(g["family"], len(fam_sort) + 1)
        grp_sort.setdefault((g["family"], g["group"]), len(grp_sort) + 1)
    kind = {"Feelings and effects": "feeling", "Format and facts": "fact"}
    with db.cursor() as c:
        for f, s in fam_sort.items():
            c.execute("INSERT INTO gene_families(name,sort) VALUES (%s,%s) ON CONFLICT (name) DO NOTHING", (f, s))
        for (f, gname), s in grp_sort.items():
            c.execute("""INSERT INTO gene_groups(family_id,name,sort) SELECT id,%s,%s FROM gene_families WHERE name=%s
                         ON CONFLICT (family_id,name) DO NOTHING""", (gname, s, f))
        added = 0
        for g in genes:
            c.execute("""INSERT INTO genes(slug,name,description,group_id,genre,kind)
                SELECT %s,%s,%s,gg.id,'sf',%s FROM gene_groups gg JOIN gene_families f ON f.id=gg.family_id
                WHERE f.name=%s AND gg.name=%s ON CONFLICT (slug) DO NOTHING""",
                (g["slug"], g["name"], g["desc"], kind.get(g["family"], "tag"), g["family"], g["group"]))
            added += c.rowcount
        c.execute("SELECT count(*) FROM genes WHERE genre='sf'")
        log(f"genes: added {added}, total sf genes {c.fetchone()[0]}")

# ---------- Open Library ----------
FIELDS = "key,title,author_name,first_publish_year,cover_i,subject,edition_count,ratings_average,ratings_count,readinglog_count,language"

def ol_match(title, author):
    q = {"title": title, "author": author, "fields": FIELDS, "limit": 5}
    d = get("https://openlibrary.org/search.json?" + urllib.parse.urlencode(q))
    docs = (d or {}).get("docs", [])
    if not docs:
        d = get("https://openlibrary.org/search.json?" + urllib.parse.urlencode({"q": f"{title} {author.split(' and ')[0]}", "fields": FIELDS, "limit": 5}))
        docs = (d or {}).get("docs", [])
    if not docs:
        return None
    nt = norm(title)
    best = sorted(docs, key=lambda x: (norm(x.get("title")) != nt, -(x.get("readinglog_count") or 0), -(x.get("edition_count") or 0)))[0]
    bt = norm(best.get("title"))
    if bt != nt and not (nt and (nt in bt or bt in nt)):
        return None
    return best

def upsert_book(c, *, slug, title, author, year, series, series_no, tier, doc, source):
    ol_key = doc.get("key") if doc else None
    if ol_key:
        c.execute("SELECT id, slug FROM books WHERE ol_key=%s", (ol_key,))
        r = c.fetchone()
        if r and r[1] != slug and tier == "catalog":
            return r[0], False
    c.execute("SELECT id FROM books WHERE slug=%s", (slug,))
    r = c.fetchone()
    vals = dict(title=title, author=author, year=year or (doc or {}).get("first_publish_year"),
                series=series, series_no=series_no, cover_id=str(doc["cover_i"]) if doc and doc.get("cover_i") else None,
                ol_key=ol_key, subjects=(doc or {}).get("subject", [])[:60] or None,
                readers=(doc or {}).get("readinglog_count"), ol_rating=(doc or {}).get("ratings_average"),
                ol_rating_count=(doc or {}).get("ratings_count"), editions=(doc or {}).get("edition_count"))
    if r:
        sets = ", ".join(f"{k}=COALESCE(%({k})s,{k})" for k in vals)
        c.execute(f"UPDATE books SET {sets}, tier=CASE WHEN tier='core' THEN 'core' ELSE %(tier)s END, updated_at=now() WHERE id=%(id)s",
                  {**vals, "tier": tier, "id": r[0]})
        return r[0], False
    c.execute("""INSERT INTO books(slug,title,author,series,series_no,genre,year,cover_id,source,ol_key,subjects,tier,readers,ol_rating,ol_rating_count,editions,updated_at)
                 VALUES (%(slug)s,%(title)s,%(author)s,%(series)s,%(series_no)s,'sf',%(year)s,%(cover_id)s,%(source)s,%(ol_key)s,%(subjects)s,%(tier)s,%(readers)s,%(ol_rating)s,%(ol_rating_count)s,%(editions)s,now())
                 RETURNING id""", {**vals, "slug": slug, "tier": tier, "source": source})
    return c.fetchone()[0], True

def set_genes(c, book_id, slugs, source, confidence, state, gene_ids):
    c.execute("DELETE FROM book_genes WHERE book_id=%s AND source=%s", (book_id, source))
    n = 0
    for s in dict.fromkeys(slugs):
        gid = gene_ids.get(s)
        if gid:
            c.execute("INSERT INTO book_genes(book_id,gene_id,source,confidence,state) VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                      (book_id, gid, source, confidence, state)); n += 1
    return n

def gene_id_map(c):
    c.execute("SELECT slug,id FROM genes"); return dict(c.fetchall())

# ---------- core ----------
def read_core():
    rows = []
    for line in open(os.path.join(HERE, "core.txt"), encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"): continue
        p = [x.strip() for x in line.split("|")]
        if len(p) != 5: continue
        title, author, year, series, tags = p
        sname, sno = None, None
        if series:
            m = re.match(r"(.*?)\s*#\s*([\d.]+)$", series)
            sname, sno = (m.group(1), float(m.group(2))) if m else (series, None)
        rows.append(dict(title=title, author=author, year=int(year) if year.isdigit() and int(year) > 0 else None,
                         series=sname, series_no=sno, tags=tags.split()))
    return rows

def step_core(db):
    rows = read_core()
    with db.cursor() as c:
        gids = gene_id_map(c)
        matched = links = new = 0; misses = []
        for i, r in enumerate(rows):
          try:
            doc = ol_match(r["title"], r["author"])
            if doc: matched += 1
            else: misses.append(r["title"])
            slug = slugify(r["title"])
            c.execute("SELECT author FROM books WHERE slug=%s", (slug,))
            ex = c.fetchone()
            if ex and norm(ex[0]) != norm(r["author"]):
                slug = slugify(r["title"] + " " + r["author"].split(" and ")[0].split()[-1])
            c.execute("SELECT slug, tier FROM books WHERE ol_key=%s AND slug<>%s", ((doc or {}).get("key"), slug))
            hit = c.fetchone() if doc else None
            if hit and hit[1] == "catalog":
                c.execute("SELECT 1 FROM books WHERE slug=%s", (slug,))
                if c.fetchone():
                    doc = {k: v for k, v in doc.items() if k != "key"}
                else:
                    slug = hit[0]
            elif hit:
                doc = {k: v for k, v in doc.items() if k != "key"}
            bid, created = upsert_book(c, slug=slug, title=r["title"], author=r["author"], year=r["year"], series=r["series"],
                                       series_no=r["series_no"], tier="core", doc=doc, source="claude-v1")
            new += created
            links += set_genes(c, bid, r["tags"], "claude-v1", 0.7, "shown", gids)
            if i % 50 == 0: log(f"core {i}/{len(rows)}")
          except Exception as e:
            log("  core error", r["title"], repr(e)[:200])
        log(f"core: {len(rows)} books, {new} new, {matched} matched on Open Library, {links} gene links")
        if misses: log("core no OL match:", "; ".join(misses[:40]))

# ---------- catalog ----------
QUERIES = ['subject:"science fiction"', 'subject:"space opera"', 'subject:"cyberpunk"', 'subject:"dystopias"',
    'subject:"time travel"', 'subject:"robots"', 'subject:"artificial intelligence"', 'subject:"extraterrestrial beings"',
    'subject:"human-alien encounters"', 'subject:"life on other planets"', 'subject:"interplanetary voyages"',
    'subject:"space warfare"', 'subject:"imaginary wars and battles"', 'subject:"space colonies"', 'subject:"genetic engineering"',
    'subject:"virtual reality"', 'subject:"androids"', 'subject:"post-apocalyptic"', 'subject:"alternative histories"',
    'subject:"science fiction, humorous"', 'subject:"military science fiction"', 'subject:"science fiction romance"',
    'subject:"alien romance"', 'subject:"litrpg"', 'subject:"harem"', 'subject:"reverse harem"', 'subject:"cyborgs"',
    'subject:"telepathy"', 'subject:"nanotechnology"', 'subject:"hugo award"', 'subject:"nebula award"', 'subject:"first contact"',
    'subject:"galactic empires"', 'subject:"space ships"', 'subject:"mars (planet)"', 'subject:"clones"']
SF_HINT = ("science fiction", "space opera", "cyberpunk", "dystopia", "time travel", "robot", "artificial intelligence",
    "extraterrestrial", "alien", "interplanetary", "interstellar", "space warfare", "space colon", "android", "cyborg",
    "post-apocalyptic", "litrpg", "virtual reality", "genetic engineering", "galactic")
BAD = ("history and criticism", "criticism, interpretation", "bibliography", "encyclopedias", "dictionaries", "comic books",
    "graphic novels", "juvenile literature", "study guides", "film adaptations", "motion picture", "periodicals", "handbooks",
    "drawing", "coloring books", "picture books", "board books")

def subject_genes(subjects, smap):
    out = []
    low = [s.lower() for s in subjects or []]
    for key, genes in smap.items():
        if key.startswith("_"): continue
        if any(key in s for s in low): out += genes
    return out

def step_catalog(db):
    smap = json.load(open(os.path.join(HERE, "subject_map.json")))
    seen = set(); kept = new = links = 0; skipped = 0
    with db.cursor() as c:
        gids = gene_id_map(c)
        for q in QUERIES:
            pages = max(1, CAT_LIMIT // 100) * (5 if q == QUERIES[0] else 1)
            got = 0
            for page in range(1, pages + 1):
                d = get("https://openlibrary.org/search.json?" + urllib.parse.urlencode(
                    {"q": q + " language:eng", "sort": "readinglog", "fields": FIELDS, "limit": 100, "page": page}))
                docs = (d or {}).get("docs", [])
                if not docs: break
                for doc in docs:
                  try:
                    k = doc.get("key")
                    if not k or k in seen: continue
                    seen.add(k)
                    subj = [s.lower() for s in doc.get("subject", [])]
                    if any(b in s for s in subj for b in BAD) or not any(h in s for s in subj for h in SF_HINT):
                        skipped += 1; continue
                    if (doc.get("edition_count") or 0) < 2 and (doc.get("readinglog_count") or 0) < 5:
                        skipped += 1; continue
                    if not doc.get("author_name"): skipped += 1; continue
                    author = doc["author_name"][0]; title = doc.get("title", "").strip()
                    slug = slugify(title)
                    c.execute("SELECT id,author,ol_key FROM books WHERE slug=%s", (slug,))
                    ex = c.fetchone()
                    if ex and ex[2] != k and norm(ex[1]) != norm(author):
                        slug = slugify(title + " " + author.split()[-1])
                    bid, created = upsert_book(c, slug=slug, title=title, author=author, year=doc.get("first_publish_year"),
                                               series=None, series_no=None, tier="catalog", doc=doc, source="openlibrary")
                    new += created; kept += 1; got += 1
                    links += set_genes(c, bid, subject_genes(doc.get("subject"), smap), "ol-subjects", 0.4, "hidden", gids)
                  except Exception as e:
                    log("  catalog error", doc.get("title"), repr(e)[:200])
            log(f"catalog {q}: {got} kept (running total {kept}, new {new})")
    log(f"catalog: {kept} kept, {new} new books, {skipped} skipped, {links} subject gene links (hidden)")

# ---------- descriptions ----------
def clean_desc(d):
    if isinstance(d, dict): d = d.get("value")
    if not d: return None
    d = re.split(r"\n-{3,}|\n\*{3,}|\(\[source\]|\[source\]", d)[0]
    d = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", d)
    d = re.sub(r"\s+", " ", d).strip()
    return d[:1500] or None

def step_desc(db):
    with db.cursor() as c:
        c.execute("""SELECT id, ol_key FROM books WHERE ol_key IS NOT NULL AND description IS NULL AND genre='sf'
                     ORDER BY (tier='core') DESC, readers DESC NULLS LAST LIMIT %s""", (DESC_LIMIT,))
        rows = c.fetchall(); got = 0
        for i, (bid, key) in enumerate(rows):
            w = get(f"https://openlibrary.org{key}.json")
            d = clean_desc((w or {}).get("description"))
            if d:
                c.execute("UPDATE books SET description=%s WHERE id=%s", (d, bid)); got += 1
            else:
                c.execute("UPDATE books SET description='' WHERE id=%s", (bid,))
            if i % 200 == 0: log(f"desc {i}/{len(rows)} ({got} found)")
        log(f"desc: {got} of {len(rows)} books now have a description")

# ---------- export ----------
def step_export(db):
    proto = json.load(open(os.path.join(HERE, "proto_map.json")))
    rev = {}
    for tag, gl in proto.items():
        if tag.startswith("_"): continue
        for g in gl: rev.setdefault(g, set()).add(tag)
    os.makedirs(OUT+"/data", exist_ok=True)
    with db.cursor() as c:
        c.execute("""SELECT b.id,b.slug,b.title,b.author,b.year,b.series,b.series_no,b.cover_id,b.ol_key,b.description,b.tier,b.readers,
                       COALESCE(json_agg(json_build_object('slug',g.slug,'confidence',round(bg.confidence::numeric,2),'source',bg.source)
                         ORDER BY bg.confidence DESC, g.id) FILTER (WHERE g.id IS NOT NULL AND bg.state='shown'), '[]')
                     FROM books b LEFT JOIN book_genes bg ON bg.book_id=b.id LEFT JOIN genes g ON g.id=bg.gene_id
                     WHERE b.genre='sf' GROUP BY b.id ORDER BY (b.tier='core') DESC, b.readers DESC NULLS LAST, b.id""")
        full, lite = [], []
        for (bid, slug, title, author, year, series, sno, cover, olk, desc, tier, readers, genes) in c.fetchall():
            seen = {}; 
            for g in genes:
                if g["slug"] not in seen or g["confidence"] > seen[g["slug"]]["confidence"]: seen[g["slug"]] = g
            gl = [{"slug": g["slug"], "confidence": float(g["confidence"])} for g in seen.values()]
            tags = sorted({t for g in gl for t in rev.get(g["slug"], ())})
            rec = {"id": slug, "title": title, "author": author, "year": year, "series": series,
                   "series_index": float(sno) if sno is not None else None, "cover_id": cover, "ol_key": olk,
                   "description": desc or None, "genes": gl, "tags": tags, "tier": tier, "readers": readers}
            (full if gl else lite).append(rec)
        meta = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "genre": "sf",
                "note": "genes are editorial (claude-v1) or swarm tags with confidence; tags = app prototype tags derived from genes."}
        json.dump({**meta, "count": len(full), "books": full}, open(OUT+"/data/books_sf.json", "w"), ensure_ascii=False, separators=(",", ":"))
        json.dump({**meta, "count": len(lite), "books": [{k: r[k] for k in ("id","title","author","year","cover_id","ol_key","readers")} for r in lite]},
                  open(OUT+"/data/catalog_sf.json", "w"), ensure_ascii=False, separators=(",", ":"))
        c.execute("""SELECT (SELECT count(*) FROM books WHERE genre='sf'), (SELECT count(*) FROM books WHERE tier='core'),
                     (SELECT count(*) FROM books WHERE tier='catalog'), (SELECT count(*) FROM books WHERE coalesce(description,'')<>''),
                     (SELECT count(*) FROM book_genes WHERE state='shown'), (SELECT count(*) FROM book_genes),
                     (SELECT count(DISTINCT gene_id) FROM book_genes WHERE state='shown'), (SELECT count(*) FROM genes WHERE genre='sf')""")
        t = c.fetchone()
        log(f"export: {len(full)} books with shown genes, {len(lite)} catalog-only")
        log(f"TOTALS books={t[0]} core={t[1]} catalog={t[2]} with_desc={t[3]} shown_links={t[4]} all_links={t[5]} genes_in_use={t[6]}/{t[7]}")


# ---------- peek (quality review in logs) ----------
def step_peek(db):
    with db.cursor() as c:
        c.execute("SELECT title, author, year, readers FROM books WHERE tier='catalog' ORDER BY readers DESC NULLS LAST LIMIT 40")
        log("PEEK top catalog by readers:"); [log("  ", *r) for r in c.fetchall()]
        c.execute("SELECT title, author, year, readers FROM books WHERE tier='catalog' ORDER BY random() LIMIT 40")
        log("PEEK random catalog:"); [log("  ", *r) for r in c.fetchall()]
        c.execute("SELECT title, author, left(coalesce(description,''),90) FROM books WHERE tier='core' ORDER BY random() LIMIT 8")
        log("PEEK core sample:"); [log("  ", *r) for r in c.fetchall()]
        c.execute("SELECT g.slug, count(*) FROM book_genes bg JOIN genes g ON g.id=bg.gene_id WHERE bg.source='ol-subjects' GROUP BY 1 ORDER BY 2 DESC LIMIT 25")
        log("PEEK subject genes:", ", ".join(f"{a}={b}" for a, b in c.fetchall()))
        c.execute("SELECT title, author FROM books b WHERE EXISTS (SELECT 1 FROM book_genes bg JOIN genes g ON g.id=bg.gene_id WHERE bg.book_id=b.id AND g.slug IN ('harem','reverse_harem','erotic_sci_fi','alien_romance')) LIMIT 30")
        log("PEEK adult sub-genre books:"); [log("  ", *r) for r in c.fetchall()]

def main():
    db = conn()
    with db.cursor() as c:
        c.execute(SCHEMA)
    for s in STEPS:
        t = time.time(); log(f"== {s}")
        globals()["step_" + s](db)
        log(f"== {s} done in {int(time.time()-t)}s")
    log("ALL DONE")

if __name__ == "__main__":
    main()
