# yourstorydna.com

The live site for The Library ("Discover your Story DNA").

Everything in `site/` is served at https://yourstorydna.com from Barry's Hostinger VPS.
The server checks this repo every minute and copies `site/` live, so **publishing = push to `main`**.

- Build the app in the project files (`the-library-app/ui3`, `python3 ui3/build.py lineage`), then copy `ui3/lineage.html` to `site/index.html` here and push.
- Nothing secret goes in this repo. It is public.

Server setup (Hostinger VPS 2165167, Docker): project `library-web` runs Caddy with automatic HTTPS and the `sync` service that pulls this repo.
