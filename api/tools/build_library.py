"""Builds api/library.json (what the Librarian chat searches) from the book database export.
Usage: python3 api/tools/build_library.py <books_sf.json> <genes_sf.json> api/library.json
"""
import json, sys
books_p, genes_p, out_p = sys.argv[1:4]
genes = json.load(open(genes_p))
gs = {g['slug'] for g in genes}
src = json.load(open(books_p))
books = []
for b in src['books']:
    gl = sorted(b.get('genes') or [], key=lambda g: -(g.get('confidence') or 0))
    g = [x['slug'] for x in gl if x['slug'] in gs]
    if not g: continue
    d = (b.get('description') or '').strip().replace('\r', '')
    if len(d) > 700: d = d[:700].rsplit(' ', 1)[0] + '...'
    books.append({k: v for k, v in {
        'id': b['id'], 't': b['title'], 'a': b.get('author') or '', 'y': b.get('year'),
        'se': b.get('series'), 'si': b.get('series_index'), 'cv': b.get('cover_id'),
        'd': d, 'g': g, 'v': [x['slug'] for x in gl if x.get('verified')], 'r': b.get('readers') or 0,
    }.items() if v not in (None, '', [])})
lib = {'generated_at': src.get('generated_at'),
       'genes': [{'s': g['slug'], 'n': g['name'], 'd': g['desc'], 'f': g.get('family', ''), 'gr': g.get('group', '')} for g in genes],
       'books': books}
json.dump(lib, open(out_p, 'w'), separators=(',', ':'), ensure_ascii=False)
print(len(lib['genes']), 'genes', len(books), 'books')
