# AGENTS.md (yourstorydna)

## Ownership & Cap-Table Firewall
- **Entity:** Barry 100%-Owned Holdco (`barrynapier-cloud/yourstorydna`). Strictly firewalled from Clinical Edge Partners and Sage Integrative Medicine.
- **Live Domain:** https://yourstorydna.com (Hostinger VPS Docker stack: Caddy + Node API + Postgres).

## Deployment & Safety Rules (CRITICAL)
1. **Pushing to `main` deploys to production within 60 seconds** (the VPS `sync` container polls `origin/main` every minute and restarts `api`).
2. **Never push directly to `main` without Barry's explicit approval.** Develop on a scoped branch (`gemini/<topic>`, `claude/<topic>`, `codex/<topic>`), run `node scripts/smoke.mjs`, and open a Draft PR.
3. **Zero secrets in git.** This repository is public. API keys (`ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `KEYS_SECRET`, `DATABASE_URL`) live only in VPS environment variables or encrypted `site_secrets`.
4. **Copy & Voice Rules:** Plain reader words only, no star ratings, and **zero em dashes (`U+2014`)** in UI copy.

## Verification Commands
```bash
node scripts/smoke.mjs
```
