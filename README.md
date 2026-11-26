# yourstorydna.com

The live site for The Library ("Discover your Story DNA").

Everything in `site/` is served at https://yourstorydna.com from Barry's Hostinger VPS.
The server checks this repo every minute and copies `site/` live, so **publishing = push to `main`**.

- Build the app in the project files (`the-library-app/ui3`, `python3 ui3/build.py lineage`), then copy `ui3/lineage.html` to `site/index.html` here and push.
- Nothing secret goes in this repo. It is public.

Server setup (Hostinger VPS 2165167, Docker): project `library-web` runs Caddy with automatic HTTPS and the `sync` service that pulls this repo.

## API (`api/`)

`api/server.js` runs on the VPS as the `api` service and is reachable at `/api/*`:
- `POST /api/sample` runs the app's own Claude prompts (needs `ANTHROPIC_API_KEY` on the server).
- `GET /api/books`, `PUT /api/books/<id>` keep books readers add (Postgres table `site_books`).

`site/claude-shim.js` gives the page the same `window.claude.use()` calls it has inside the Claude preview, backed by this API. The server adds the script tag to `index.html` automatically. Code changes here go live within a minute; the API restarts itself.

## API v2 (Nov 26)

- `POST /api/research {q, tags, axes}`: Perplexity Sonar research, then Claude gene tagging; saves the book to site_books (custom:1, unv:1). Daily cap and per-IP limit.
- `/api/admin/*`: Google sign-in (env `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS`), encrypted API keys in site_secrets (env `KEYS_SECRET`), settings in site_settings, usage in site_usage.
- `/api/sample` uses settings.lookupModel for the book lookup prompt and settings.deepModel for everything else.
- Keys are read from the database first, then env (`ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`). No secret ever lives in this repo.
