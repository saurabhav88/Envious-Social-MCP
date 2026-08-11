# Instagram Poster (@envious_staging)

> ## PAUSED 2026-08-11 — scheduled posting is OFF, and that is intentional
>
> Both calendars ran out (carousel through 2026-08-10, reels through 2026-07-30)
> and there is no new portfolio work to post, so `crons = []` in
> `worker/wrangler.toml` and the Worker no longer publishes on a schedule.
> **Silence in #enviousstaging-support is now the EXPECTED state — read the
> watchdog section below before treating a missing post as an outage.**
>
> **This pause spans TWO repos.** EnviousMarketing's `instagram` pull source is
> paused in the same change (`ops/tracker/lib/sources.mjs` → `status: "blocked"`,
> and the entry commented out of `distribution/puller-worker/src/index.js`
> SOURCES). Resuming posting alone leaves Instagram analytics dark.
>
> The Worker is still DEPLOYED on purpose: `/status` stays live, and
> EnviousMarketing keeps its service binding configured for a later resume (the
> binding targets the Worker NAME, which is unchanged). `/media-facts` stays
> deployed but is expected to return 502 once the token lapses; nothing calls it
> on a schedule while the marketing source is paused. `/run` also stays
> reachable, but it is NOT an ad-hoc composer: a run requires a matching
> calendar entry for the date it is given, and fails (and alarms Discord)
> without one. There is no entry for any current date while paused, but an
> explicitly supplied OLD calendar date remains a manual publishing path for
> anyone holding `TRIGGER_SECRET`.
>
> **Known consequence — the IG token stops renewing while paused, by choice.**
> The only call to `maybeRefreshToken` is inside `finishPublished`, on the
> publish path (`maybeRefreshToken`, called only from `finishPublished` in
> `worker/src/index.js`); `readMediaFacts` reads the token but never refreshes
> it. With no posts, the
> ~60-day token lapses. That is accepted: the marketing source was paused in the
> same change precisely so the dead token cannot turn into a daily Discord alarm
> from the puller's side.
>
> **To resume SAFELY (order matters — do not redeploy crons first):**
> 1. Refill `worker/calendar.json` + `worker/reels-calendar.json`, and deploy
>    once with `crons = []` still in place.
> 2. Re-auth through Meta AND write the new token plus a fresh `updated_at` into
>    the Worker's `STATE` KV `token` record — KV is the live copy the code reads
>    (see `getToken` in `worker/src/index.js`), so re-authing without writing KV changes
>    nothing.
> 3. Verify: `/status` shows the new `token_updated_at` and the refilled
>    calendar ranges, and `/media-facts` returns 200.
> 4. In EnviousMarketing, restore the `instagram` source to `status: "live"`,
>    uncomment its cloud `SOURCES` entry, redeploy `distribution/puller-worker`,
>    and run `./ops/em pull --only instagram`.
> 5. Only then restore the recorded `crons` line, deploy again, and confirm the
>    Cron Triggers are registered.
>
> Restoring crons before step 2 lets a live schedule fire against a dead token.

When unpaused, Cloudflare Worker `envious-social-ig-poster` runs two daily slots:
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
| Cron | **PAUSED: `crons = []`.** When unpaused: 13:00 + 14:00 UTC (9am ET carousel) + 21:00 + 22:00 UTC (5pm ET reel); code gates each on NY hour (9 or 17), DST-proof via scheduledTime; `scheduled()` routes hour 17 -> reel |
| Calendar | **EXHAUSTED — refill before resuming.** `worker/calendar.json` (carousel) — `build_calendar.py <start-date>`, ran 2026-06-12..2026-08-10. `worker/reels-calendar.json` (reels) — generated from `envious-reels-poc/ads-captions/reels-schedule.json`, ran 2026-06-13..2026-07-30. Edit + redeploy to change content. |
| Reel cover | The publisher pins the feed thumbnail to the fully rendered frame at 2 seconds (`thumb_offset=2000`) so Instagram cannot select a black opening frame. |
| State | Workers KV `envious-social-ig-poster-state` (ccc88caba9d6486792a5cddea664d435): `token` {access_token, updated_at}, `last_posted_date`, `run:<date>`, `last_posted_reel_date`, `reelrun:<date>` |
| Secrets | wrangler secrets `TRIGGER_SECRET` (GCP `ig-poster-trigger-secret`), `DISCORD_WEBHOOK_URL` (Keychain `enviousstaging.discord-webhook-support`) |
| IG token | KV is the LIVE copy. **PAUSED: no auto-refresh is happening** — refresh rides the publish path, so with `crons = []` the token is expected to lapse (see the PAUSED banner). When unpaused, the worker auto-refreshes it once it is at least 14 days old and posts a Discord note; GCP `instagram-access-token-enviousstaging` + Keychain `envious-social/instagram-access-token` go stale after each refresh, so sync from KV when that note appears. |

## Daily signal (watchdog)

**SUSPENDED while paused (2026-08-11).** With `crons = []` there are no scheduled
runs, so no heartbeat is expected and THIS Worker raises no alarm. Do not treat
the absence of a daily message as an outage until the crons are restored.

Scope note: both the poster AND the EnviousMarketing `instagram` source are
paused, so no Instagram heartbeat, read-back, or related Discord alarm is
expected from either side. See the PAUSED banner above.

The rule below applies only when the poster is UNPAUSED:

> Carousel success sends `[ig-poster] Posted <date>: <room> ...`; reel success sends
> `[ig-poster] Reel posted <date>: <type> <style> <room> ...`. Both to
> #enviousstaging-support. **No carousel msg by ~9:20am ET, or no reel msg by
> ~5:20pm ET, means that slot is broken** (cron disabled, CF outage, token dead,
> video not processing, etc.). Failures also alert there.

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
