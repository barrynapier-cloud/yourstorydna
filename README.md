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
