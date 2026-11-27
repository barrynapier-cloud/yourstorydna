"""Reader-owned import: a reader's own Goodreads or StoryGraph CSV export, uploaded by that reader.

This is the legal route to Goodreads/StoryGraph data: the reader exports their own library from
Goodreads (My Books > Import and export) or StoryGraph (Manage account > Export), and gives the file to us.
We never log in to or scrape either site.

parse(csv_text) -> list of {title, author, isbn13, rating (0-5 or None), shelf, read_at, review}
  works for both formats (detected from the header row).
match(rows, books) -> list of (row, book_id or None) using ISBN, then normalized title + author last name.

Usage on the VPS: python reader_import.py export.csv   (prints a match summary, writes nothing)
"""
import csv, io, re, sys, unicodedata

def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\(.*?\)", "", s)                 # Goodreads puts series in brackets: "Dune (Dune, #1)"
    s = re.sub(r"^(the|a|an) ", "", s.strip())
    return re.sub(r"[^a-z0-9]", "", s.split(":")[0])

def last(a):
    a = (a or "").split(",")[0].strip()
    return norm(a.split()[-1]) if a.split() else ""

def clean_isbn(s):
    return re.sub(r"[^0-9X]", "", (s or "").upper()) or None

def parse(text):
    rd = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    hdr = set(rd.fieldnames or [])
    out = []
    if "Exclusive Shelf" in hdr or "My Rating" in hdr:          # Goodreads
        for r in rd:
            rating = int(r.get("My Rating") or 0) or None
            out.append({"title": r.get("Title", "").strip(), "author": r.get("Author", "").strip(),
                        "isbn13": clean_isbn(r.get("ISBN13")), "rating": rating,
                        "shelf": r.get("Exclusive Shelf") or None, "read_at": r.get("Date Read") or None,
                        "review": (r.get("My Review") or "").strip() or None, "source": "goodreads-export"})
    elif "Read Status" in hdr or "Star Rating" in hdr:           # StoryGraph
        for r in rd:
            sr = r.get("Star Rating") or ""
            out.append({"title": r.get("Title", "").strip(), "author": (r.get("Authors") or "").strip(),
                        "isbn13": clean_isbn(r.get("ISBN/UID")), "rating": float(sr) if sr.strip() else None,
                        "shelf": r.get("Read Status") or None, "read_at": r.get("Last Date Read") or None,
                        "review": (r.get("Review") or "").strip() or None, "moods": r.get("Moods") or None,
                        "pace": r.get("Pace") or None, "source": "storygraph-export"})
    else:
        raise ValueError("not a Goodreads or StoryGraph export (unknown header)")
    return [r for r in out if r["title"]]

def match(rows, books):
    """books: iterable of (book_id, title, author, isbn_list)."""
    by_isbn, by_title = {}, {}
    for bid, t, a, isbns in books:
        for i in isbns or []: by_isbn[i] = bid
        by_title.setdefault(norm(t), []).append((bid, last(a)))
    res = []
    for r in rows:
        bid = by_isbn.get(r["isbn13"]) if r["isbn13"] else None
        if not bid:
            for cand, la in by_title.get(norm(r["title"]), []):
                if la == last(r["author"]): bid = cand; break
        res.append((r, bid))
    return res

if __name__ == "__main__":
    rows = parse(open(sys.argv[1], encoding="utf-8").read())
    print(f"{len(rows)} rows, {sum(1 for r in rows if r['rating'])} rated, source {rows[0]['source'] if rows else '-'}")
