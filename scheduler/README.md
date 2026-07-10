# Instagram Poster (@envious_staging)

Cloudflare Worker `envious-social-ig-poster` runs two daily slots:
- **9:00am ET carousel** — one before/after portfolio carousel (`calendar.json`). Live since 2026-06-11.
- **5:00pm ET reel** — one video ad Reel, A->B->C->D rotation (`reels-calendar.json`). Added 2026-06-13.

Carousel Codex-cleared (3 rounds, session 019eb4dc-35ae-7cd3-bcdc-521fd70ab85f);
copy council-reviewed (ig-copy-proofread-2026-06-11); architecture council-reviewed
(ig-scheduler-host-2026-06-10). Reel path Codex-reviewed 2026-06-13
(session 019ec1f7-e03d-7b62-8a81-547143aeb561; blocker 1 fixed, blocker 2 =
KV-not-atomic race accepted: automated path is never concurrent, only manual
misuse races it). Reel copy Gemini-validated (reel-captions-conversion-2026-06-13).

## Moving parts

| Piece | Where |
|---|---|
| Worker | `worker/` — deploy with `npx wrangler deploy` (auth: `get-key launch cloudflare-global-api-key CLOUDFLARE_API_KEY -- bash -c 'export CLOUDFLARE_EMAIL=saurabhav@gmail.com; npx wrangler deploy'`) |
| Cron | 13:00 + 14:00 UTC (9am ET carousel) + 21:00 + 22:00 UTC (5pm ET reel); code gates each on NY hour (9 or 17), DST-proof via scheduledTime; `scheduled()` routes hour 17 -> reel |
| Calendar | `worker/calendar.json` (carousel) — `build_calendar.py <start-date>`, 2026-06-12..2026-08-10 live. `worker/reels-calendar.json` (reels) — generated from `envious-reels-poc/ads-captions/reels-schedule.json`, 2026-06-13..2026-07-30 live. Edit + redeploy to change content. |
| State | Workers KV `envious-social-ig-poster-state` (ccc88caba9d6486792a5cddea664d435): `token` {access_token, updated_at}, `last_posted_date`, `run:<date>`, `last_posted_reel_date`, `reelrun:<date>` |
| Secrets | wrangler secrets `TRIGGER_SECRET` (GCP `ig-poster-trigger-secret`), `DISCORD_WEBHOOK_URL` (Keychain `enviousstaging.discord-webhook-support`) |
| IG token | KV is the LIVE copy; the worker auto-refreshes when >14 days old and posts a Discord note. GCP `instagram-access-token-enviousstaging` + Keychain `envious-social/instagram-access-token` go stale after the first refresh; sync from KV when the Discord note appears. |

## Daily signal (watchdog)

Carousel success sends `[ig-poster] Posted <date>: <room> ...`; reel success sends
`[ig-poster] Reel posted <date>: <type> <style> <room> ...`. Both to
#enviousstaging-support. **No carousel msg by ~9:20am ET, or no reel msg by
~5:20pm ET, means that slot is broken** (cron disabled, CF outage, token dead,
video not processing, etc.). Failures also alert there.

## Manual operations

```bash
# status (now also shows last_posted_reel_date + reels_range)
~/.claude/bin/get-key launch ig-poster-trigger-secret TS -- bash -c \
  'curl -s https://envious-social-ig-poster.saurabhav.workers.dev/status -H "Authorization: Bearer $TS"'

# dry run a date — carousel: image HEAD checks; reel: video HEAD check. No posting.
... '/run?dry=1&force=1&date=YYYY-MM-DD' -X POST            # carousel
... '/run?kind=reel&dry=1&force=1&date=YYYY-MM-DD' -X POST  # reel

# real manual post (NEVER near the slot time; KV is not a concurrency lock)
... '/run?force=1&date=YYYY-MM-DD' -X POST                  # carousel (avoid ~9am ET)
... '/run?kind=reel&force=1&date=YYYY-MM-DD' -X POST        # reel (avoid ~5pm ET)
```

If a run fails during media_publish, VERIFY instagram.com/envious_staging
before retrying (publish may have landed despite the error). For reels, a
poll-budget-exhausted failure self-heals: re-run the same date and it reuses
the still-processing container; an ERROR/EXPIRED container is auto-cleared so
the re-run builds a fresh one.

## Calendar refresh (before 2026-08-10)

1. Add new portfolio images to the website, or extend ENCORES.
2. `python3 build_calendar.py 2026-08-11` (asserts: unique captions, rotation quality).
3. Skim `CALENDAR-PREVIEW.md` (regenerate it), get Saurabh's OK, `npx wrangler deploy`.

The worker Discord-alerts "calendar exhausted" if a day has no entry.
