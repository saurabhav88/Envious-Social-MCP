/**
 * Instagram poster for @envious_staging.
 *
 * One Cloudflare cron expression fires the DST-twin posting and sweep times:
 *   0,30 13,14,21,22 * * *
 *
 * Active New York routes:
 *   09:00 carousel post
 *   09:30 carousel reconciliation sweep
 *   17:00 reel post
 *   17:30 reel reconciliation sweep
 *
 * Instagram is authoritative for whether content was published. Workers KV
 * records the local workflow state and is repaired from Instagram sightings.
 *
 * Workers Free permits 50 external requests per invocation. This worker permits
 * 43: at most 39 ordinary requests and 4 Discord reporting requests.
 */

import calendar from "../calendar.json";
import reels from "../reels-calendar.json";

const GRAPH = "https://graph.instagram.com/v23.0";
const MEDIA_LIMIT = "50";
const POLL_INTERVAL_MS = 60_000;
const POLL_CYCLES = 6;
const VISIBILITY_DELAYS_MS = [0, 2_000, 5_000, 10_000, 20_000, 30_000];

const MAX_ORDINARY_REQUESTS = 39;
const MAX_REPORTING_REQUESTS = 4;
const MAX_TOTAL_REQUESTS = 43;

// Read-only /media-facts endpoint: lets the EnviousMarketing puller read what
// @envious_staging published without ever holding the Instagram token. The token
// stays in this worker's KV; the puller calls this endpoint instead of Instagram.
const MEDIA_FACTS_PAGE_CAP = 8;
const MEDIA_FACTS_DEFAULT_DAYS = 4;
const MEDIA_FACTS_MAX_DAYS = 30;
const MEDIA_FACTS_INSIGHTS_CONCURRENCY = 4;

function canon(value = "") {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .replace(/\s+$/u, "");
}

function nyParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function zonedMidnight(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;

  for (let i = 0; i < 4; i++) {
    const parts = nyParts(new Date(guess));
    const represented = Date.UTC(
      Number(parts.date.slice(0, 4)),
      Number(parts.date.slice(5, 7)) - 1,
      Number(parts.date.slice(8, 10)),
      parts.hour,
      parts.minute,
      0
    );
    const adjustment = target - represented;
    guess += adjustment;
    if (adjustment === 0) break;
  }

  return guess;
}

function nextDateString(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

function nyDayWindow(dateString) {
  return {
    start: zonedMidnight(dateString),
    end: zonedMidnight(nextDateString(dateString)),
  };
}

function makeBudget(fetchFn) {
  let ordinary = 0;
  let reporting = 0;
  let total = 0;

  async function request(kind, input, init) {
    if (total >= MAX_TOTAL_REQUESTS) {
      throw new Error(`external request budget exhausted (${total}/${MAX_TOTAL_REQUESTS})`);
    }

    if (kind === "reporting") {
      if (reporting >= MAX_REPORTING_REQUESTS) {
        throw new Error(
          `reporting request budget exhausted (${reporting}/${MAX_REPORTING_REQUESTS})`
        );
      }
      reporting++;
    } else {
      if (ordinary >= MAX_ORDINARY_REQUESTS) {
        throw new Error(
          `ordinary request budget exhausted (${ordinary}/${MAX_ORDINARY_REQUESTS})`
        );
      }
      ordinary++;
    }

    total++;
    return fetchFn(input, init);
  }

  return {
    ordinary: (input, init) => request("ordinary", input, init),
    reporting: (input, init) => request("reporting", input, init),
    snapshot: () => ({ ordinary, reporting, total }),
  };
}

function safeErrorUrl(url) {
  return String(url).split("?")[0];
}

function runKey(kind, date) {
  return kind === "reel" ? `reelrun:${date}` : `run:${date}`;
}

function entryFor(kind, date, calendarData, reelsData) {
  const source = kind === "reel" ? reelsData : calendarData;
  return source.find((entry) => entry.date === date) || null;
}

function expectedIdentity(kind, entry) {
  if (kind === "reel") {
    return { mediaType: "VIDEO", productType: "REELS", childCount: null };
  }
  if (entry.images.length === 1) {
    return { mediaType: "IMAGE", productType: "FEED", childCount: null };
  }
  return {
    mediaType: "CAROUSEL_ALBUM",
    productType: "FEED",
    childCount: entry.images.length,
  };
}

function visibilityWindow(prior, entry, now) {
  if (prior?.status === "publish_attempted" && prior.publish_attempted_at) {
    return {
      start: Date.parse(prior.publish_attempted_at) - 2 * 60_000,
      end: now + 2 * 60_000,
    };
  }
  return nyDayWindow(entry.date);
}

function slotGuardActive(now) {
  const ny = nyParts(new Date(now));
  const minuteOfDay = ny.hour * 60 + ny.minute;
  const slots = [9 * 60, 17 * 60];

  return slots.some(
    (slot) => minuteOfDay >= slot - 15 && minuteOfDay <= slot + 35
  );
}

function routeScheduled(scheduledTime) {
  const ny = nyParts(new Date(scheduledTime));
  const key = `${ny.hour}:${ny.minute}`;

  if (key === "9:0") return { action: "post", kind: "carousel", date: ny.date };
  if (key === "9:30") return { action: "sweep", kind: "carousel", date: ny.date };
  if (key === "17:0") return { action: "post", kind: "reel", date: ny.date };
  if (key === "17:30") return { action: "sweep", kind: "reel", date: ny.date };
  return null;
}

function publicError(error) {
  return error instanceof Error ? error.message : String(error);
}

export function makeApp(overrides = {}) {
  const fetchFn = overrides.fetchFn || globalThis.fetch.bind(globalThis);
  const now = overrides.now || (() => Date.now());
  const sleep =
    overrides.sleep ||
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const calendarData = overrides.calendarData || calendar;
  const reelsData = overrides.reelsData || reels;

  function log(event, fields = {}) {
    console.log(
      JSON.stringify({
        event,
        at: new Date(now()).toISOString(),
        ...fields,
      })
    );
  }

  async function discord(env, budget, message) {
    if (!env.DISCORD_WEBHOOK_URL) return false;

    try {
      const response = await budget.reporting(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `[ig-poster] ${message}`.slice(0, 1900),
        }),
      });
      return response.ok;
    } catch (error) {
      log("discord_failed", { error: publicError(error) });
      return false;
    }
  }

  async function igFetch(budget, url, init) {
    const response = await budget.ordinary(url, init);
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        `${safeErrorUrl(url)} -> HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`
      );
    }

    return body;
  }

  async function getToken(env) {
    const raw = await env.STATE.get("token");
    if (!raw) throw new Error("KV key 'token' missing");
    return JSON.parse(raw);
  }

  async function writeRecord(env, key, record, fromStatus = null) {
    await env.STATE.put(key, JSON.stringify(record));
    log("state_transition", {
      key,
      from: fromStatus,
      to: record.status,
      container_id: record.container_id || null,
      media_id: record.media_id || null,
    });
    return record;
  }

  async function findPostForEntry(
    env,
    budget,
    token,
    kind,
    entry,
    window
  ) {
    try {
      const fields =
        "id,caption,timestamp,media_type,media_product_type,children{id}";
      const query = new URLSearchParams({
        fields,
        limit: MEDIA_LIMIT,
        access_token: token,
      });
      const body = await igFetch(
        budget,
        `${GRAPH}/${env.IG_USER_ID}/media?${query}`
      );
      const media = Array.isArray(body.data) ? body.data : [];

      const timestamps = media
        .map((item) => Date.parse(item.timestamp))
        .filter(Number.isFinite);

      if (media.length > 0 && timestamps.length === 0) {
        return { outcome: "INDETERMINATE", reason: "media timestamps invalid" };
      }

      const grossStaleBoundary = nyDayWindow(entry.date).start - 48 * 60 * 60_000;
      if (
        timestamps.length > 0 &&
        Math.max(...timestamps) < grossStaleBoundary
      ) {
        return {
          outcome: "INDETERMINATE",
          reason: "returned media page is implausibly stale",
        };
      }

      const expected = expectedIdentity(kind, entry);
      const matches = media.filter((item) => {
        const timestamp = Date.parse(item.timestamp);
        if (!Number.isFinite(timestamp)) return false;
        if (timestamp < window.start || timestamp >= window.end) return false;
        if (canon(item.caption || "") !== canon(entry.caption)) return false;
        if (item.media_type !== expected.mediaType) return false;
        if (item.media_product_type !== expected.productType) return false;

        if (expected.childCount !== null) {
          const children = item.children?.data;
          if (!Array.isArray(children) || children.length !== expected.childCount) {
            return false;
          }
        }

        return true;
      });

      if (matches.length === 1) {
        return { outcome: "MATCH", mediaId: matches[0].id };
      }
      if (matches.length > 1) {
        return { outcome: "INDETERMINATE", reason: "multiple matching media" };
      }
      return { outcome: "NO_MATCH" };
    } catch (error) {
      return {
        outcome: "INDETERMINATE",
        reason: "media lookup failed",
        error: publicError(error),
      };
    }
  }

  async function createContainer(env, budget, token, params) {
    const query = new URLSearchParams({ ...params, access_token: token });
    const body = await igFetch(
      budget,
      `${GRAPH}/${env.IG_USER_ID}/media?${query}`,
      { method: "POST" }
    );
    return body.id;
  }

  async function containerStatus(budget, token, containerId) {
    const query = new URLSearchParams({
      fields: "status_code",
      access_token: token,
    });
    const body = await igFetch(
      budget,
      `${GRAPH}/${containerId}?${query}`
    );
    return body.status_code;
  }

  async function pollContainers(budget, token, containerIds) {
    const pending = new Set(containerIds);

    for (let cycle = 0; cycle < POLL_CYCLES; cycle++) {
      const results = await Promise.all(
        [...pending].map(async (containerId) => ({
          containerId,
          status: await containerStatus(budget, token, containerId),
        }))
      );

      for (const result of results) {
        if (result.status === "FINISHED") {
          pending.delete(result.containerId);
        } else if (
          result.status === "ERROR" ||
          result.status === "EXPIRED"
        ) {
          const error = new Error(
            `container ${result.containerId} status ${result.status}`
          );
          error.terminalContainer = true;
          throw error;
        }
      }

      if (pending.size === 0) return;
      if (cycle < POLL_CYCLES - 1) await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(
      `container polling exceeded ${POLL_CYCLES} checks over five minutes`
    );
  }

  async function buildContainer(
    env,
    budget,
    token,
    kind,
    entry,
    key,
    previousAttempt
  ) {
    let containerId;

    if (kind === "reel") {
      containerId = await createContainer(env, budget, token, {
        media_type: "REELS",
        video_url: entry.video_url,
        caption: entry.caption,
        share_to_feed: "true",
        // Every campaign video has a stable, fully rendered frame by 2s.
        // Pinning it prevents Instagram from choosing a black feed thumbnail.
        thumb_offset: "2000",
      });
    } else if (entry.images.length === 1) {
      containerId = await createContainer(env, budget, token, {
        image_url: entry.images[0],
        caption: entry.caption,
      });
    } else {
      const children = await Promise.all(
        entry.images.map((imageUrl) =>
          createContainer(env, budget, token, {
            image_url: imageUrl,
            is_carousel_item: "true",
          })
        )
      );

      await pollContainers(budget, token, children);

      containerId = await createContainer(env, budget, token, {
        media_type: "CAROUSEL",
        children: children.join(","),
        caption: entry.caption,
      });
    }

    const record = {
      container_id: containerId,
      status: "created",
      ...(previousAttempt ? { previous_attempt: previousAttempt } : {}),
    };
    await writeRecord(env, key, record);
    await pollContainers(budget, token, [containerId]);
    return record;
  }

  async function prepareContainer(
    env,
    budget,
    token,
    kind,
    entry,
    key,
    prior,
    previousAttempt
  ) {
    if (prior?.status !== "created" || !prior.container_id) {
      return buildContainer(
        env,
        budget,
        token,
        kind,
        entry,
        key,
        previousAttempt
      );
    }

    try {
      await pollContainers(budget, token, [prior.container_id]);
      return prior;
    } catch (error) {
      if (!error.terminalContainer) throw error;

      log("terminal_created_container_rebuild", {
        key,
        container_id: prior.container_id,
      });

      return buildContainer(
        env,
        budget,
        token,
        kind,
        entry,
        key,
        previousAttempt || prior.previous_attempt
      );
    }
  }

  async function publishContainer(env, budget, token, containerId) {
    const query = new URLSearchParams({
      creation_id: containerId,
      access_token: token,
    });
    const body = await igFetch(
      budget,
      `${GRAPH}/${env.IG_USER_ID}/media_publish?${query}`,
      { method: "POST" }
    );
    return body.id;
  }

  async function markPublished(
    env,
    key,
    prior,
    mediaId,
    extra = {}
  ) {
    return writeRecord(
      env,
      key,
      {
        container_id: prior?.container_id || null,
        status: "published",
        media_id: mediaId,
        ...(prior?.previous_attempt
          ? { previous_attempt: prior.previous_attempt }
          : {}),
        ...extra,
      },
      prior?.status || null
    );
  }

  function heartbeatMessage(kind, entry, record, refreshedDays) {
    const prefix = kind === "reel" ? "Reel posted" : "Posted";
    const detail =
      kind === "reel"
        ? `${entry.type} ${entry.style} ${entry.room} (${entry.town})`
        : `${entry.room} (${entry.property})`;

    return (
      `${prefix} ${entry.date}: ${detail} media_id=${record.media_id}` +
      (record.spurious_error ? ` | IG returned an error after publishing` : "") +
      (refreshedDays
        ? ` | token refreshed, ~${refreshedDays}d left`
        : "")
    );
  }

  async function ensureHeartbeat(
    env,
    budget,
    kind,
    entry,
    key,
    record,
    refreshedDays = null
  ) {
    if (record.heartbeat_sent_at) return record;

    const delivered = await discord(
      env,
      budget,
      heartbeatMessage(kind, entry, record, refreshedDays)
    );
    if (!delivered) {
      throw new Error(
        `${kind} ${entry.date} is published but its heartbeat was not delivered`
      );
    }

    const stamped = {
      ...record,
      heartbeat_sent_at: new Date(now()).toISOString(),
    };
    await writeRecord(env, key, stamped, "published");
    return stamped;
  }

  async function maybeRefreshToken(env, budget, tokenObject) {
    const ageDays =
      (now() - Date.parse(tokenObject.updated_at || 0)) / 86_400_000;
    if (ageDays < 14) return null;

    const query = new URLSearchParams({
      grant_type: "ig_refresh_token",
      access_token: tokenObject.access_token,
    });
    const body = await igFetch(
      budget,
      `https://graph.instagram.com/refresh_access_token?${query}`
    );
    await env.STATE.put(
      "token",
      JSON.stringify({
        access_token: body.access_token,
        updated_at: new Date(now()).toISOString(),
      })
    );
    return Math.round((body.expires_in || 0) / 86_400);
  }

  async function finishPublished(
    env,
    budget,
    kind,
    entry,
    key,
    record,
    tokenObject
  ) {
    let refreshedDays = null;

    try {
      refreshedDays = await maybeRefreshToken(env, budget, tokenObject);
    } catch (error) {
      log("token_refresh_failed", {
        kind,
        date: entry.date,
        error: publicError(error),
      });
      await discord(
        env,
        budget,
        `${kind} ${entry.date} posted, but token refresh FAILED: ${publicError(error)}`
      );
    }

    return ensureHeartbeat(
      env,
      budget,
      kind,
      entry,
      key,
      record,
      refreshedDays
    );
  }

  async function reconcileAttempt(
    env,
    budget,
    token,
    kind,
    entry,
    prior
  ) {
    return findPostForEntry(
      env,
      budget,
      token,
      kind,
      entry,
      visibilityWindow(prior, entry, now())
    );
  }

  async function reconcileAfterPublishError(
    env,
    budget,
    token,
    kind,
    entry,
    attempted,
    originalError
  ) {
    let previousDelay = 0;

    for (const delay of VISIBILITY_DELAYS_MS) {
      if (delay > previousDelay) await sleep(delay - previousDelay);
      previousDelay = delay;

      const result = await reconcileAttempt(
        env,
        budget,
        token,
        kind,
        entry,
        attempted
      );
      if (result.outcome === "MATCH") return result;
    }

    return {
      outcome: "UNRESOLVED",
      originalError,
    };
  }

  async function executePost(env, kind, date, budget) {
    const entry = entryFor(kind, date, calendarData, reelsData);
    if (!entry) throw new Error(`no ${kind} calendar entry for ${date}`);

    const key = runKey(kind, date);
    const tokenObject = await getToken(env);
    const token = tokenObject.access_token;
    let prior = JSON.parse((await env.STATE.get(key)) || "null");

    if (prior?.status === "published") {
      if (prior.heartbeat_sent_at) return prior;
      return finishPublished(
        env,
        budget,
        kind,
        entry,
        key,
        prior,
        tokenObject
      );
    }

    if (prior?.status === "publish_attempted") {
      const result = await reconcileAttempt(
        env,
        budget,
        token,
        kind,
        entry,
        prior
      );

      if (result.outcome === "MATCH") {
        const published = await markPublished(
          env,
          key,
          prior,
          result.mediaId
        );
        return finishPublished(
          env,
          budget,
          kind,
          entry,
          key,
          published,
          tokenObject
        );
      }

      throw new Error(
        `${kind} ${date} remains publish_attempted; no automatic republish. Original error: ${prior.last_error || "unknown"}`
      );
    }

    const dayResult = await findPostForEntry(
      env,
      budget,
      token,
      kind,
      entry,
      nyDayWindow(date)
    );

    if (dayResult.outcome === "MATCH") {
      const published = await markPublished(
        env,
        key,
        prior,
        dayResult.mediaId
      );
      return finishPublished(
        env,
        budget,
        kind,
        entry,
        key,
        published,
        tokenObject
      );
    }

    if (dayResult.outcome === "INDETERMINATE") {
      throw new Error(
        `${kind} ${date} reconciliation indeterminate: ${dayResult.reason}`
      );
    }

    let previousAttempt = prior?.previous_attempt || null;

    if (prior?.status === "retry_authorized") {
      previousAttempt = {
        container_id: prior.container_id || null,
        error: prior.last_error || null,
        resolved_at: prior.resolved_at,
      };
      prior = null;
    }

    const created = await prepareContainer(
      env,
      budget,
      token,
      kind,
      entry,
      key,
      prior,
      previousAttempt
    );

    const attempted = {
      ...created,
      status: "publish_attempted",
      publish_attempted_at: new Date(now()).toISOString(),
    };
    await writeRecord(env, key, attempted, "created");

    let mediaId;

    try {
      mediaId = await publishContainer(
        env,
        budget,
        token,
        attempted.container_id
      );
    } catch (originalError) {
      const result = await reconcileAfterPublishError(
        env,
        budget,
        token,
        kind,
        entry,
        attempted,
        originalError
      );

      if (result.outcome === "MATCH") {
        const published = await markPublished(
          env,
          key,
          attempted,
          result.mediaId,
          { spurious_error: publicError(originalError) }
        );
        return finishPublished(
          env,
          budget,
          kind,
          entry,
          key,
          published,
          tokenObject
        );
      }

      await writeRecord(
        env,
        key,
        {
          ...attempted,
          last_error: publicError(originalError),
        },
        "publish_attempted"
      );
      throw originalError;
    }

    const published = await markPublished(
      env,
      key,
      attempted,
      mediaId
    );
    return finishPublished(
      env,
      budget,
      kind,
      entry,
      key,
      published,
      tokenObject
    );
  }

  async function sweep(env, kind, date, budget) {
    const entry = entryFor(kind, date, calendarData, reelsData);
    if (!entry) throw new Error(`no ${kind} calendar entry for ${date}`);

    const key = runKey(kind, date);
    const prior = JSON.parse((await env.STATE.get(key)) || "null");

    if (prior?.status === "published") {
      if (prior.heartbeat_sent_at) return prior;
      return ensureHeartbeat(env, budget, kind, entry, key, prior);
    }

    const tokenObject = await getToken(env);
    const result = await findPostForEntry(
      env,
      budget,
      tokenObject.access_token,
      kind,
      entry,
      visibilityWindow(prior, entry, now())
    );

    if (result.outcome === "MATCH") {
      const published = await markPublished(
        env,
        key,
        prior,
        result.mediaId
      );
      return ensureHeartbeat(
        env,
        budget,
        kind,
        entry,
        key,
        published
      );
    }

    if (result.outcome === "INDETERMINATE") {
      throw new Error(
        `${kind} sweep ${date} indeterminate: ${result.reason}`
      );
    }

    if (!prior) {
      throw new Error(
        `${kind} ${date} missing: the scheduled posting cron never ran or did not create state`
      );
    }

    throw new Error(
      `${kind} ${date} not published; current state=${prior.status}`
    );
  }

  async function dryRun(env, kind, date, budget) {
    const entry = entryFor(kind, date, calendarData, reelsData);
    if (!entry) throw new Error(`no ${kind} calendar entry for ${date}`);

    const urls = kind === "reel" ? [entry.video_url] : entry.images;
    const checks = [];

    for (const url of urls) {
      const response = await budget.ordinary(url, { method: "HEAD" });
      checks.push({ url, status: response.status });
    }

    return { dryRun: true, kind, date, checks };
  }

  async function resolveAttempt(env, kind, date, outcome) {
    if (outcome !== "not_published") {
      throw new Error("outcome must be not_published");
    }

    const key = runKey(kind, date);
    const prior = JSON.parse((await env.STATE.get(key)) || "null");

    if (prior?.status !== "publish_attempted") {
      throw new Error(
        `${key} must be publish_attempted before retry authorization`
      );
    }

    return writeRecord(
      env,
      key,
      {
        ...prior,
        status: "retry_authorized",
        resolved_at: new Date(now()).toISOString(),
      },
      "publish_attempted"
    );
  }

  async function scheduled(event, env, ctx) {
    const route = routeScheduled(event.scheduledTime);
    if (!route) {
      log("cron_dst_twin_skipped", {
        scheduled_time: event.scheduledTime,
      });
      return;
    }

    const budget = makeBudget(fetchFn);
    const operation =
      route.action === "sweep"
        ? sweep(env, route.kind, route.date, budget)
        : executePost(env, route.kind, route.date, budget);

    ctx.waitUntil(
      operation.catch(async (error) => {
        log("scheduled_failed", {
          action: route.action,
          kind: route.kind,
          date: route.date,
          error: publicError(error),
          budget: budget.snapshot(),
        });

        await discord(
          env,
          budget,
          `${route.kind} ${route.action} FAILED for ${route.date}: ${publicError(error)}`
        );
        throw error;
      })
    );
  }

  function mediaFactsWindow(searchParams) {
    const daysRaw = searchParams.get("days");
    const sinceRaw = searchParams.get("since");

    if (daysRaw !== null && sinceRaw !== null) {
      throw new Error("days and since are mutually exclusive");
    }

    if (daysRaw !== null) {
      if (!/^\d+$/u.test(daysRaw)) {
        throw new Error("days must be an integer");
      }

      const days = Number(daysRaw);
      if (days < 1 || days > MEDIA_FACTS_MAX_DAYS) {
        throw new Error(`days must be between 1 and ${MEDIA_FACTS_MAX_DAYS}`);
      }

      return {
        sinceMs: now() - days * 86_400_000,
        mode: "days",
        value: days,
      };
    }

    if (sinceRaw !== null) {
      // A date means midnight UTC. A complete ISO timestamp keeps its offset.
      const normalized = /^\d{4}-\d{2}-\d{2}$/u.test(sinceRaw)
        ? `${sinceRaw}T00:00:00Z`
        : sinceRaw;

      const sinceMs = Date.parse(normalized);
      if (!Number.isFinite(sinceMs)) {
        throw new Error("since must be YYYY-MM-DD or a valid ISO timestamp");
      }

      if (sinceMs > now()) {
        throw new Error("since cannot be in the future");
      }

      return {
        sinceMs,
        mode: "since",
        value: new Date(sinceMs).toISOString(),
      };
    }

    return {
      sinceMs: now() - MEDIA_FACTS_DEFAULT_DAYS * 86_400_000,
      mode: "days",
      value: MEDIA_FACTS_DEFAULT_DAYS,
    };
  }

  function parseMediaTimestamp(media) {
    const timestamp = Date.parse(media?.timestamp);
    if (!Number.isFinite(timestamp)) {
      throw new Error(`media ${media?.id || "unknown"} has an invalid timestamp`);
    }
    return timestamp;
  }

  function nullableCount(value) {
    if (value === null || value === undefined) return null;

    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) return null;

    return number;
  }

  function mediaFact(media) {
    if (!media?.id || !media?.media_type) {
      throw new Error("Instagram media is missing id or media_type");
    }

    return {
      media_id: String(media.id),
      caption: media.caption ?? null,
      media_type: media.media_type,
      media_product_type: media.media_product_type ?? null,
      permalink: media.permalink ?? null,
      posted_at: new Date(parseMediaTimestamp(media)).toISOString(),
      like_count: nullableCount(media.like_count),
      comments_count: nullableCount(media.comments_count),
      reach: null,
    };
  }

  function insightValue(body, metricName) {
    const metric = (body?.data || []).find((item) => item?.name === metricName);

    const raw =
      metric?.values?.at(-1)?.value ??
      metric?.total_value?.value ??
      metric?.value;

    return nullableCount(raw);
  }

  async function fetchReach(budget, token, mediaId) {
    try {
      const query = new URLSearchParams({
        metric: "reach",
        access_token: token,
      });

      const body = await igFetch(
        budget,
        `${GRAPH}/${encodeURIComponent(mediaId)}/insights?${query}`
      );

      return { reach: insightValue(body, "reach"), failed: false };
    } catch (error) {
      log("media_facts_insight_failed", {
        media_id: mediaId,
        error: publicError(error),
      });

      return { reach: null, failed: true };
    }
  }

  async function mapConcurrent(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    }

    const count = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: count }, () => worker()));
    return results;
  }

  async function readMediaFacts(env, searchParams) {
    const window = mediaFactsWindow(searchParams);
    const tokenObject = await getToken(env);
    const token = tokenObject.access_token;

    if (!token) {
      throw new Error("KV token record is missing access_token");
    }

    const budget = makeBudget(fetchFn);
    const fields = [
      "id",
      "caption",
      "timestamp",
      "media_type",
      "media_product_type",
      "permalink",
      "like_count",
      "comments_count",
    ].join(",");

    const postsById = new Map();
    const seenCursors = new Set();

    let after = null;
    let pagesFetched = 0;
    let morePages = false;

    while (pagesFetched < MEDIA_FACTS_PAGE_CAP) {
      const query = new URLSearchParams({
        fields,
        limit: MEDIA_LIMIT,
        access_token: token,
      });

      if (after) query.set("after", after);

      const body = await igFetch(
        budget,
        `${GRAPH}/${env.IG_USER_ID}/media?${query}`
      );

      pagesFetched++;

      const media = Array.isArray(body.data) ? body.data : [];
      const timestamps = media.map(parseMediaTimestamp);

      for (let index = 0; index < media.length; index++) {
        if (timestamps[index] < window.sinceMs) continue;

        const fact = mediaFact(media[index]);
        postsById.set(fact.media_id, fact);
      }

      // paging.next is the authoritative "another page exists" signal. Instagram
      // can leave a cursor on the final page, so a lone cursor must NOT trigger
      // another request (it would spuriously fail as a loop or cap overflow).
      const nextCursor = body.paging?.cursors?.after || null;
      morePages = Boolean(body.paging?.next);

      // The media edge is normally newest first. Stop once the entire page is
      // older than the lower bound. Do not stop on one old item in a mixed page.
      const pageEntirelyOlder =
        media.length > 0 &&
        timestamps.every((timestamp) => timestamp < window.sinceMs);

      if (media.length === 0 || pageEntirelyOlder || !morePages) {
        morePages = false;
        break;
      }

      if (!nextCursor) {
        throw new Error(
          "Instagram pagination advertised a next page without a cursor"
        );
      }

      if (seenCursors.has(nextCursor)) {
        throw new Error("Instagram pagination cursor loop detected");
      }

      seenCursors.add(nextCursor);
      after = nextCursor;
    }

    if (morePages) {
      throw new Error(
        `Instagram pagination exceeded ${MEDIA_FACTS_PAGE_CAP} pages`
      );
    }

    const posts = [...postsById.values()].sort(
      (a, b) => Date.parse(b.posted_at) - Date.parse(a.posted_at)
    );

    // Preserve room inside the worker's existing ordinary-request budget.
    const remainingRequests = Math.max(
      0,
      MAX_ORDINARY_REQUESTS - budget.snapshot().ordinary
    );

    const insightCandidates = posts.slice(0, remainingRequests);
    const insightResults = await mapConcurrent(
      insightCandidates,
      MEDIA_FACTS_INSIGHTS_CONCURRENCY,
      (post) => fetchReach(budget, token, post.media_id)
    );

    let succeeded = 0;
    let failed = 0;

    for (let index = 0; index < insightCandidates.length; index++) {
      const result = insightResults[index];
      insightCandidates[index].reach = result.reach;

      if (result.failed) failed++;
      else if (result.reach !== null) succeeded++;
    }

    const skipped = posts.length - insightCandidates.length;
    const missing = posts.length - succeeded;

    return {
      schema_version: 1,
      posts,
      pages_fetched: pagesFetched,
      window: {
        mode: window.mode,
        value: window.value,
        since: new Date(window.sinceMs).toISOString(),
      },
      insights: {
        requested: insightCandidates.length,
        succeeded,
        missing,
        failed,
        skipped,
      },
      degraded: failed > 0 || skipped > 0,
      budget: budget.snapshot(),
    };
  }

  async function fetchHandler(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/media-facts") {
      if (request.method !== "GET") {
        return new Response("method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      }

      if (
        !env.MEDIA_FACTS_SECRET ||
        request.headers.get("Authorization") !==
          `Bearer ${env.MEDIA_FACTS_SECRET}`
      ) {
        return new Response("unauthorized", { status: 401 });
      }

      try {
        return Response.json(await readMediaFacts(env, url.searchParams), {
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) {
        const message = publicError(error);
        const clientError =
          message.includes("mutually exclusive") ||
          message.startsWith("days ") ||
          message.startsWith("since ");

        log("media_facts_failed", { error: message });

        return Response.json(
          { error: message },
          {
            status: clientError ? 400 : 502,
            headers: { "Cache-Control": "no-store" },
          }
        );
      }
    }

    const authorization = request.headers.get("Authorization") || "";

    if (
      !env.TRIGGER_SECRET ||
      authorization !== `Bearer ${env.TRIGGER_SECRET}`
    ) {
      return new Response("forbidden", { status: 403 });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const today = nyParts(new Date(now())).date;
      const [carouselRaw, reelRaw, tokenRaw] = await Promise.all([
        env.STATE.get(runKey("carousel", today)),
        env.STATE.get(runKey("reel", today)),
        env.STATE.get("token"),
      ]);
      const token = tokenRaw ? JSON.parse(tokenRaw) : null;

      return Response.json({
        now_ny: nyParts(new Date(now())),
        carousel: carouselRaw ? JSON.parse(carouselRaw) : null,
        reel: reelRaw ? JSON.parse(reelRaw) : null,
        token_updated_at: token?.updated_at || null,
        calendar_range: [
          calendarData[0]?.date || null,
          calendarData.at(-1)?.date || null,
        ],
        reels_range: [
          reelsData[0]?.date || null,
          reelsData.at(-1)?.date || null,
        ],
      });
    }

    if (url.pathname === "/resolve" && request.method === "POST") {
      const kind =
        url.searchParams.get("kind") === "reel" ? "reel" : "carousel";
      const date = url.searchParams.get("date");
      const outcome = url.searchParams.get("outcome");

      if (!date) {
        return Response.json({ error: "date is required" }, { status: 400 });
      }

      try {
        const record = await resolveAttempt(env, kind, date, outcome);
        return Response.json({ resolved: true, kind, date, record });
      } catch (error) {
        return Response.json(
          { error: publicError(error) },
          { status: 409 }
        );
      }
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const kind =
        url.searchParams.get("kind") === "reel" ? "reel" : "carousel";
      const date =
        url.searchParams.get("date") || nyParts(new Date(now())).date;
      const isDryRun = url.searchParams.get("dry") === "1";
      const override =
        url.searchParams.get("i_know_the_cron_is_about_to_fire") === "1";
      const budget = makeBudget(fetchFn);

      if (!isDryRun && slotGuardActive(now()) && !override) {
        return Response.json(
          {
            error:
              "manual publishing is blocked from 15 minutes before a slot until 35 minutes after it",
          },
          { status: 409 }
        );
      }

      if (!isDryRun && slotGuardActive(now()) && override) {
        log("manual_slot_guard_overridden", { kind, date });
        await discord(
          env,
          budget,
          `WARNING: manual ${kind} run for ${date} is overriding the cron safety window`
        );
      }

      try {
        const result = isDryRun
          ? await dryRun(env, kind, date, budget)
          : await executePost(env, kind, date, budget);
        return Response.json({
          ok: true,
          result,
          budget: budget.snapshot(),
        });
      } catch (error) {
        log("manual_failed", {
          kind,
          date,
          error: publicError(error),
          budget: budget.snapshot(),
        });
        await discord(
          env,
          budget,
          `Manual ${kind} run FAILED for ${date}: ${publicError(error)}`
        );
        return Response.json(
          {
            error: publicError(error),
            budget: budget.snapshot(),
          },
          { status: 500 }
        );
      }
    }

    return new Response("not found", { status: 404 });
  }

  return {
    handler: {
      scheduled,
      fetch: fetchHandler,
    },
    test: {
      canon,
      nyParts,
      nyDayWindow,
      routeScheduled,
      slotGuardActive,
      makeBudget,
      findPostForEntry,
      executePost,
      sweep,
      resolveAttempt,
      mediaFactsWindow,
      mediaFact,
      insightValue,
      readMediaFacts,
    },
  };
}

const app = makeApp();
export default app.handler;

export const __test = {
  canon,
  nyParts,
  nyDayWindow,
  routeScheduled,
  slotGuardActive,
  makeBudget,
};
