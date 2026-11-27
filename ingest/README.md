# Book ingest (sci-fi)

Loads books into the Story DNA Postgres on the VPS and writes the app export to `yourstorydna.com/data/`.

- `core.txt`: curated core. `Title | Author | Year | Series #n | gene slugs`. Tags are Claude's editorial read (source `claude-v1`, confidence 0.7), not reader data. Source of truth is `the-library-app/data/core/b*.txt` in the project files.
- `genes_sf.json`: gene library (copy of `the-library-app/data/genes_sf.json`, append only).
- `subject_map.json`: Open Library subject -> genes for catalog books (confidence 0.4, state `hidden`).
- `proto_map.json`: the 26 app prototype tags -> genes, so the export carries `tags` too.
- `ingest.py`: steps `genes,core,catalog,desc,export` (env `STEPS`).
- `run-compose.yaml`: deploy as Hostinger Docker project `library-ingest`; it reads the DB password from `/docker/library-db/.env` and writes `/data/books_sf.json` and `/data/catalog_sf.json` into the site volume.
