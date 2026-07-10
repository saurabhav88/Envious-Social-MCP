import { beforeEach, describe, expect, it, vi } from "vitest";
import calendar from "../calendar.json";
import reels from "../reels-calendar.json";
import { __test, makeApp } from "../src/index.js";

class MockKV {
  constructor(initial = {}) {
    this.values = new Map(
      Object.entries(initial).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ])
    );
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value) {
    this.values.set(key, String(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  json(key) {
    const value = this.values.get(key);
    return value ? JSON.parse(value) : null;
  }
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const carouselEntry = {
  date: "2026-07-10",
  property: "test-property",
  room: "living-room",
  images: ["https://assets.test/after.jpg", "https://assets.test/before.jpg"],
  caption: "Exact caption\n\n#Test",
};

const reelEntry = {
  date: "2026-07-10",
  reel_id: "reel-1",
  type: "test",
  style: "modern",
  room: "living-room",
  town: "Test Town",
  video_url: "https://assets.test/reel.mp4",
  caption: "Reel caption\n\n#Test",
};

class InstagramHarness {
  constructor(options = {}) {
    this.now = Date.parse("2026-07-10T13:00:00Z");
    this.calls = [];
    this.media = options.media ? [...options.media] : [];
    this.containers = new Map();
    this.containerSequence = 0;
    this.mediaSequence = 0;
    this.publishMode = options.publishMode || "ok";
    this.hiddenReadsAfterPublish = options.hiddenReadsAfterPublish || 0;
    this.refreshFails = options.refreshFails || false;
    this.discordStatuses = [...(options.discordStatuses || [])];
    this.finishAfterPolls = options.finishAfterPolls || 1;
    this.pollCounts = new Map();
    this.pageTwo = options.pageTwo || null;
    this.mediaGetBarrier = options.mediaGetBarrier || null;
    this.pendingBarrierResolvers = [];
  }

  sleep = async (milliseconds) => {
    this.now += milliseconds;
  };

  releaseMediaBarrier() {
    for (const resolve of this.pendingBarrierResolvers.splice(0)) resolve();
  }

  mediaObjectFromContainer(container) {
    const mediaId = `media-${++this.mediaSequence}`;
    if (container.media_type === "REELS") {
      return {
        id: mediaId,
        caption: container.caption,
        timestamp: new Date(this.now).toISOString(),
        media_type: "VIDEO",
        media_product_type: "REELS",
      };
    }
    if (container.media_type === "CAROUSEL") {
      return {
        id: mediaId,
        caption: container.caption,
        timestamp: new Date(this.now).toISOString(),
        media_type: "CAROUSEL_ALBUM",
        media_product_type: "FEED",
        children: {
          data: container.children.split(",").map((id) => ({ id })),
        },
      };
    }
    return {
      id: mediaId,
      caption: container.caption,
      timestamp: new Date(this.now).toISOString(),
      media_type: "IMAGE",
      media_product_type: "FEED",
    };
  }

  fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || "GET";
    this.calls.push({ url: String(input), pathname: url.pathname, method });

    if (url.hostname === "discord.test") {
      const status = this.discordStatuses.shift() || 204;
      return new Response(null, { status });
    }

    if (method === "HEAD") return new Response("", { status: 200 });

    if (url.pathname === "/refresh_access_token") {
      if (this.refreshFails) {
        return response({ error: { message: "refresh failed" } }, 500);
      }
      return response({
        access_token: "refreshed-token",
        expires_in: 5_184_000,
      });
    }

    if (
      method === "GET" &&
      url.pathname === "/v23.0/user-1/media"
    ) {
      if (this.mediaGetBarrier) {
        await new Promise((resolve) => {
          this.pendingBarrierResolvers.push(resolve);
          if (
            this.pendingBarrierResolvers.length >= this.mediaGetBarrier
          ) {
            queueMicrotask(() => this.releaseMediaBarrier());
          }
        });
      }

      let visible = this.media;
      if (this.hiddenReadsAfterPublish > 0 && this.media.length > 0) {
        this.hiddenReadsAfterPublish--;
        visible = [];
      }

      return response({
        data: visible.slice(0, 50),
        ...(this.pageTwo
          ? { paging: { next: "https://graph.instagram.com/page-two" } }
          : {}),
      });
    }

    if (url.hostname === "graph.instagram.com" && url.pathname === "/page-two") {
      return response({ data: this.pageTwo || [] });
    }

    if (
      method === "POST" &&
      url.pathname === "/v23.0/user-1/media"
    ) {
      const id = `container-${++this.containerSequence}`;
      this.containers.set(id, Object.fromEntries(url.searchParams));
      return response({ id });
    }

    if (
      method === "GET" &&
      /^\/v23\.0\/container-[A-Za-z0-9-]+$/.test(url.pathname)
    ) {
      const id = url.pathname.split("/").at(-1);
      const polls = (this.pollCounts.get(id) || 0) + 1;
      this.pollCounts.set(id, polls);
      const container = this.containers.get(id);

      if (container?.forced_status) {
        return response({ status_code: container.forced_status });
      }

      return response({
        status_code:
          polls >= this.finishAfterPolls ? "FINISHED" : "IN_PROGRESS",
      });
    }

    if (
      method === "POST" &&
      url.pathname === "/v23.0/user-1/media_publish"
    ) {
      const container = this.containers.get(
        url.searchParams.get("creation_id")
      );

      if (this.publishMode !== "throw_without_publish") {
        const media = this.mediaObjectFromContainer(container);
        this.media.unshift(media);

        if (this.publishMode === "throw_after_publish") {
          return response(
            {
              error: {
                message: "Application request limit reached",
                code: 4,
                error_subcode: 2207051,
              },
            },
            403
          );
        }

        return response({ id: media.id });
      }

      return response(
        { error: { message: "publish failed" } },
        500
      );
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  };

  count(pathFragment, method = null) {
    return this.calls.filter(
      (call) =>
        call.url.includes(pathFragment) &&
        (!method || call.method === method)
    ).length;
  }
}

function makeEnvironment(kv = new MockKV()) {
  return {
    STATE: kv,
    IG_USER_ID: "user-1",
    DISCORD_WEBHOOK_URL: "https://discord.test/webhook",
    TRIGGER_SECRET: "secret",
  };
}

function makeHarnessApp(harness, options = {}) {
  return makeApp({
    fetchFn: harness.fetch,
    now: () => harness.now,
    sleep: harness.sleep,
    calendarData: options.calendarData || [carouselEntry],
    reelsData: options.reelsData || [reelEntry],
  });
}

function budgetFor(app, harness) {
  return app.test.makeBudget(harness.fetch);
}

function publishedCarouselMedia(overrides = {}) {
  return {
    id: "published-1",
    caption: carouselEntry.caption,
    timestamp: "2026-07-10T13:00:00Z",
    media_type: "CAROUSEL_ALBUM",
    media_product_type: "FEED",
    children: { data: [{ id: "a" }, { id: "b" }] },
    ...overrides,
  };
}

describe("Instagram publication safety net", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("1. heals when media_publish publishes and then returns the integrity 403", async () => {
    const harness = new InstagramHarness({
      publishMode: "throw_after_publish",
    });
    const kv = new MockKV({
      token: {
        access_token: "token",
        updated_at: "2026-07-09T00:00:00Z",
      },
    });
    const env = makeEnvironment(kv);
    const app = makeHarnessApp(harness);

    const record = await app.test.executePost(
      env,
      "carousel",
      carouselEntry.date,
      budgetFor(app, harness)
    );

    expect(record.status).toBe("published");
    expect(record.spurious_error).toContain("HTTP 403");
    expect(record.heartbeat_sent_at).toBeTruthy();
    expect(harness.count("/media_publish", "POST")).toBe(1);
  });

  it("2. waits through delayed visibility without republishing", async () => {
    const harness = new InstagramHarness({
      publishMode: "throw_after_publish",
      hiddenReadsAfterPublish: 3,
    });
    const kv = new MockKV({
      token: {
        access_token: "token",
        updated_at: "2026-07-09T00:00:00Z",
      },
    });
    const env = makeEnvironment(kv);
    const app = makeHarnessApp(harness);

    const record = await app.test.executePost(
      env,
      "carousel",
      carouselEntry.date,
      budgetFor(app, harness)
    );

    expect(record.status).toBe("published");
    expect(harness.count("/media_publish", "POST")).toBe(1);
    expect(harness.count("/user-1/media", "GET")).toBeGreaterThan(2);
  });

  it("3a. after a publish error with no match, stays publish_attempted and never republishes", async () => {
    const harness = new InstagramHarness({
      publishMode: "throw_without_publish",
      media: [],
    });
    const kv = new MockKV({
      token: { access_token: "token", updated_at: "2026-07-09T00:00:00Z" },
    });
    const env = makeEnvironment(kv);
    const app = makeHarnessApp(harness);

    await expect(
      app.test.executePost(env, "carousel", carouselEntry.date, budgetFor(app, harness))
    ).rejects.toThrow();

    expect(kv.json("run:2026-07-10").status).toBe("publish_attempted");

    // Second run sees the prior publish_attempted, reconciles only, never republishes.
    await expect(
      app.test.executePost(env, "carousel", carouselEntry.date, budgetFor(app, harness))
    ).rejects.toThrow(/no automatic republish/);

    expect(harness.count("/media_publish", "POST")).toBe(1);
  });

  it("3b. fails closed on multiple pre-existing matches at reconcile-first and never publishes", async () => {
    // Two posts already on the account before the run: reconcile-first is INDETERMINATE,
    // so the worker throws WITHOUT creating a container or publishing, and writes no record.
    const harness = new InstagramHarness({
      media: [
        publishedCarouselMedia({ id: "one" }),
        publishedCarouselMedia({ id: "two" }),
      ],
    });
    const kv = new MockKV({
      token: { access_token: "token", updated_at: "2026-07-09T00:00:00Z" },
    });
    const env = makeEnvironment(kv);
    const app = makeHarnessApp(harness);

    await expect(
      app.test.executePost(env, "carousel", carouselEntry.date, budgetFor(app, harness))
    ).rejects.toThrow(/indeterminate/i);

    expect(kv.json("run:2026-07-10")).toBeNull();
    expect(harness.count("/media_publish", "POST")).toBe(0);
  });

  it("3b. preserves the original publish error when reconciliation fails", async () => {
    const harness = new InstagramHarness({
      publishMode: "throw_without_publish",
    });
    const originalFetch = harness.fetch;
    let afterPublish = false;

    harness.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes("/media_publish")) afterPublish = true;
      if (
        afterPublish &&
        url.includes("/user-1/media") &&
        (init.method || "GET") === "GET"
      ) {
        throw new Error("reconcile transport failed");
      }
      return originalFetch(input, init);
    };

    const kv = new MockKV({
      token: {
        access_token: "token",
        updated_at: "2026-07-09T00:00:00Z",
      },
    });
    const env = makeEnvironment(kv);
    const app = makeHarnessApp(harness);

    await expect(
      app.test.executePost(
        env,
        "carousel",
        carouselEntry.date,
        budgetFor(app, harness)
      )
    ).rejects.toThrow("publish failed");

    expect(kv.json("run:2026-07-10").last_error).toContain(
      "publish failed"
    );
    expect(kv.json("run:2026-07-10").last_error).not.toContain(
      "reconcile transport failed"
    );
  });

  it.each(["absent", "created", "publish_attempted"])(
    "4. sweep heals %s without creating or publishing",
    async (state) => {
      const harness = new InstagramHarness({
        media: [publishedCarouselMedia()],
      });
      const initial = {
        token: {
          access_token: "token",
          updated_at: "2026-07-09T00:00:00Z",
        },
      };

      if (state !== "absent") {
        initial["run:2026-07-10"] = {
          container_id: "old-container",
          status: state,
          ...(state === "publish_attempted"
            ? {
                publish_attempted_at: "2026-07-10T12:59:00Z",
                last_error: "old error",
              }
            : {}),
        };
      }

      const kv = new MockKV(initial);
      const env = makeEnvironment(kv);
      const app = makeHarnessApp(harness);

      const record = await app.test.sweep(
        env,
        "carousel",
        carouselEntry.date,
        budgetFor(app, harness)
      );

      expect(record.status).toBe("published");
      expect(record.heartbeat_sent_at).toBeTruthy();
      expect(harness.count("/media_publish")).toBe(0);
      expect(harness.count("/user-1/media", "POST")).toBe(0);
    }
  );

  it("5. enforces the complete predicate", async () => {
    const cases = [
      [publishedCarouselMedia(), "MATCH"],
      [
        publishedCarouselMedia({
          caption: "Exact caption  \r\n\r\n#Test  ",
        }),
        "MATCH",
      ],
      [
        publishedCarouselMedia({
          timestamp: "2026-07-09T12:00:00Z",
        }),
        "NO_MATCH",
      ],
      [
        publishedCarouselMedia({ media_type: "IMAGE" }),
        "NO_MATCH",
      ],
      [
        publishedCarouselMedia({
          children: { data: [{ id: "only-one" }] },
        }),
        "NO_MATCH",
      ],
    ];

    for (const [media, expected] of cases) {
      const harness = new InstagramHarness({ media: [media] });
      const env = makeEnvironment(
        new MockKV({
          token: {
            access_token: "token",
            updated_at: "2026-07-09T00:00:00Z",
          },
        })
      );
      const app = makeHarnessApp(harness);
      const result = await app.test.findPostForEntry(
        env,
        budgetFor(app, harness),
        "token",
        "carousel",
        carouselEntry,
        app.test.nyDayWindow(carouselEntry.date)
      );
      expect(result.outcome).toBe(expected);
    }

    const reelHarness = new InstagramHarness({
      media: [
        {
          id: "video-feed",
          caption: reelEntry.caption,
          timestamp: "2026-07-10T21:00:00Z",
          media_type: "VIDEO",
          media_product_type: "FEED",
        },
      ],
    });
    const reelApp = makeHarnessApp(reelHarness);
    const reelResult = await reelApp.test.findPostForEntry(
      makeEnvironment(),
      budgetFor(reelApp, reelHarness),
      "token",
      "reel",
      reelEntry,
      reelApp.test.nyDayWindow(reelEntry.date)
    );
    expect(reelResult.outcome).toBe("NO_MATCH");

    const spring = __test.nyDayWindow("2026-03-08");
    const fall = __test.nyDayWindow("2026-11-01");
    expect(spring.end - spring.start).toBe(23 * 60 * 60_000);
    expect(fall.end - fall.start).toBe(25 * 60 * 60_000);
  });

  it("6. rebuilds a terminal created container but never retries publish_attempted", async () => {
    const harness = new InstagramHarness();
    harness.containers.set("container-old", {
      forced_status: "ERROR",
    });

    const kv = new MockKV({
      token: {
        access_token: "token",
        updated_at: "2026-07-09T00:00:00Z",
      },
      "run:2026-07-10": {
        container_id: "container-old",
        status: "created",
      },
    });
    const env = makeEnvironment(kv);
    const app = makeHarnessApp(harness);

    await app.test.executePost(
      env,
      "carousel",
      carouselEntry.date,
      budgetFor(app, harness)
    );
    expect(harness.count("/media_publish", "POST")).toBe(1);

    const secondHarness = new InstagramHarness();
    const secondKv = new MockKV({
      token: {
        access_token: "token",
        updated_at: "2026-07-09T00:00:00Z",
      },
      "run:2026-07-10": {
        container_id: "container-published",
        status: "publish_attempted",
        publish_attempted_at: "2026-07-10T12:59:00Z",
        last_error: "unknown outcome",
      },
    });
    const secondApp = makeHarnessApp(secondHarness);

    await expect(
      secondApp.test.executePost(
        makeEnvironment(secondKv),
        "carousel",
        carouselEntry.date,
        budgetFor(secondApp, secondHarness)
      )
    ).rejects.toThrow("no automatic republish");

    expect(secondHarness.count("/media_publish")).toBe(0);
    expect(secondHarness.count("/container-published")).toBe(0);
  });

  it("7. documents that two concurrent invocations can both publish", async () => {
    const harness = new InstagramHarness({ mediaGetBarrier: 2 });
    const kv = new MockKV({
      token: {
        access_token: "token",
        updated_at: "2026-07-09T00:00:00Z",
      },
    });
    const env = makeEnvironment(kv);
    const app = makeHarnessApp(harness);

    const first = app.test.executePost(
      env,
      "carousel",
      carouselEntry.date,
      budgetFor(app, harness)
    );
    const second = app.test.executePost(
      env,
      "carousel",
      carouselEntry.date,
      budgetFor(app, harness)
    );

    await Promise.all([first, second]);
    expect(harness.count("/media_publish", "POST")).toBe(2);
  });

  it("8. keeps all 108 calendar captions unique under canon", () => {
    const captions = [...calendar, ...reels].map((entry) =>
      __test.canon(entry.caption)
    );
    expect(new Set(captions).size).toBe(108);
  });

  it("9. intentionally ignores a matching item on page two", async () => {
    const harness = new InstagramHarness({
      media: [
        publishedCarouselMedia({
          id: "old",
          caption: "different",
          timestamp: "2026-07-09T13:00:00Z",
        }),
      ],
      pageTwo: [publishedCarouselMedia({ id: "page-two-match" })],
    });
    const app = makeHarnessApp(harness);
    const result = await app.test.findPostForEntry(
      makeEnvironment(),
      budgetFor(app, harness),
      "token",
      "carousel",
      carouselEntry,
      app.test.nyDayWindow(carouselEntry.date)
    );

    expect(result.outcome).toBe("NO_MATCH");
    expect(harness.count("page-two")).toBe(0);
  });

  it("10. retry_authorized reconciles before creating and preserves previous attempt", async () => {
    const harness = new InstagramHarness({
      media: [publishedCarouselMedia()],
    });
    const kv = new MockKV({
      token: {
        access_token: "token",
        updated_at: "2026-07-09T00:00:00Z",
      },
      "run:2026-07-10": {
        container_id: "old-container",
        status: "retry_authorized",
        last_error: "old publish error",
        resolved_at: "2026-07-10T14:00:00Z",
      },
    });
    const app = makeHarnessApp(harness);

    const record = await app.test.executePost(
      makeEnvironment(kv),
      "carousel",
      carouselEntry.date,
      budgetFor(app, harness)
    );

    expect(record.status).toBe("published");
    expect(harness.count("/user-1/media", "POST")).toBe(0);
    expect(harness.count("/media_publish")).toBe(0);
  });

  it("10b. archives the previous attempt when an authorized retry proceeds", async () => {
    const harness = new InstagramHarness();
    const kv = new MockKV({
      token: {
        access_token: "token",
        updated_at: "2026-07-09T00:00:00Z",
      },
      "run:2026-07-10": {
        container_id: "old-container",
        status: "retry_authorized",
        last_error: "old publish error",
        resolved_at: "2026-07-10T14:00:00Z",
      },
    });
    const app = makeHarnessApp(harness);

    const record = await app.test.executePost(
      makeEnvironment(kv),
      "carousel",
      carouselEntry.date,
      budgetFor(app, harness)
    );

    expect(record.previous_attempt).toEqual({
      container_id: "old-container",
      error: "old publish error",
      resolved_at: "2026-07-10T14:00:00Z",
    });
  });

  it("11. repairs a heartbeat skipped after the published write", async () => {
    const harness = new InstagramHarness();
    const kv = new MockKV({
      token: {
        access_token: "token",
        updated_at: "2026-07-09T00:00:00Z",
      },
      "run:2026-07-10": {
        container_id: "container-1",
        media_id: "media-1",
        status: "published",
      },
    });
    const app = makeHarnessApp(harness);

    const record = await app.test.executePost(
      makeEnvironment(kv),
      "carousel",
      carouselEntry.date,
      budgetFor(app, harness)
    );

    expect(record.heartbeat_sent_at).toBeTruthy();
    expect(harness.count("/media_publish")).toBe(0);
    expect(harness.count("discord.test")).toBe(1);
  });

  it("11b. does not stamp heartbeat_sent_at for Discord HTTP failure", async () => {
    const harness = new InstagramHarness({
      discordStatuses: [500],
    });
    const kv = new MockKV({
      token: {
        access_token: "token",
        updated_at: "2026-07-09T00:00:00Z",
      },
      "run:2026-07-10": {
        container_id: "container-1",
        media_id: "media-1",
        status: "published",
      },
    });
    const app = makeHarnessApp(harness);

    await expect(
      app.test.executePost(
        makeEnvironment(kv),
        "carousel",
        carouselEntry.date,
        budgetFor(app, harness)
      )
    ).rejects.toThrow("heartbeat was not delivered");

    expect(kv.json("run:2026-07-10").heartbeat_sent_at).toBeUndefined();
  });

  it("12. stays below 43 with six visibility checks, maximum polling, refresh failure, and reporting", async () => {
    const harness = new InstagramHarness({
      publishMode: "throw_after_publish",
      hiddenReadsAfterPublish: 5,
      finishAfterPolls: 6,
      refreshFails: true,
    });
    const kv = new MockKV({
      token: {
        access_token: "token",
        updated_at: "2026-06-01T00:00:00Z",
      },
    });
    const app = makeHarnessApp(harness);
    const budget = budgetFor(app, harness);

    const record = await app.test.executePost(
      makeEnvironment(kv),
      "carousel",
      carouselEntry.date,
      budget
    );

    expect(record.status).toBe("published");
    expect(budget.snapshot()).toEqual({
      ordinary: 30,
      reporting: 2,
      total: 32,
    });
    expect(harness.count("/media_publish", "POST")).toBe(1);
    expect(harness.count("discord.test")).toBe(2);
  });

  it("12b. reserves four reporting calls after ordinary requests stop at 39", async () => {
    const calls = [];
    const budget = __test.makeBudget(async (url) => {
      calls.push(url);
      return new Response(null, { status: 204 });
    });

    for (let i = 0; i < 39; i++) {
      await budget.ordinary(`https://ordinary.test/${i}`);
    }
    await expect(
      budget.ordinary("https://ordinary.test/blocked")
    ).rejects.toThrow("ordinary request budget exhausted");

    for (let i = 0; i < 4; i++) {
      await budget.reporting(`https://reporting.test/${i}`);
    }
    expect(budget.snapshot()).toEqual({
      ordinary: 39,
      reporting: 4,
      total: 43,
    });
  });

  it("13. routes exactly four of eight daily cron fires in EDT and EST", () => {
    const edt = [
      "2026-07-10T13:00:00Z",
      "2026-07-10T13:30:00Z",
      "2026-07-10T14:00:00Z",
      "2026-07-10T14:30:00Z",
      "2026-07-10T21:00:00Z",
      "2026-07-10T21:30:00Z",
      "2026-07-10T22:00:00Z",
      "2026-07-10T22:30:00Z",
    ];
    const est = [
      "2026-12-10T13:00:00Z",
      "2026-12-10T13:30:00Z",
      "2026-12-10T14:00:00Z",
      "2026-12-10T14:30:00Z",
      "2026-12-10T21:00:00Z",
      "2026-12-10T21:30:00Z",
      "2026-12-10T22:00:00Z",
      "2026-12-10T22:30:00Z",
    ];

    for (const times of [edt, est]) {
      const routes = times
        .map((time) => __test.routeScheduled(Date.parse(time)))
        .filter(Boolean);
      expect(routes).toHaveLength(4);
      expect(routes.map((route) => `${route.kind}:${route.action}`)).toEqual([
        "carousel:post",
        "carousel:sweep",
        "reel:post",
        "reel:sweep",
      ]);
    }
  });

  it("13b. sweep routes never create containers or call media_publish", async () => {
    const harness = new InstagramHarness({
      media: [publishedCarouselMedia()],
    });
    const app = makeHarnessApp(harness);
    const kv = new MockKV({
      token: {
        access_token: "token",
        updated_at: "2026-07-09T00:00:00Z",
      },
    });

    await app.test.sweep(
      makeEnvironment(kv),
      "carousel",
      carouselEntry.date,
      budgetFor(app, harness)
    );

    expect(harness.count("/user-1/media", "POST")).toBe(0);
    expect(harness.count("/media_publish")).toBe(0);
  });
});

describe("media-facts endpoint", () => {
  const NOW = Date.parse("2026-07-10T13:00:00Z");

  function igMedia(id, timestampIso, extra = {}) {
    return {
      id,
      caption: `caption ${id}`,
      timestamp: timestampIso,
      media_type: "CAROUSEL_ALBUM",
      media_product_type: "FEED",
      permalink: `https://instagram.com/p/${id}`,
      like_count: 5,
      comments_count: 1,
      ...extra,
    };
  }

  // pages: [{ data: [...], after: "cursor" | null }, ...] served in sequence.
  // insights: { [mediaId]: number | "error" | "empty" } (default: empty -> null).
  function mediaFactsHarness({ pages = [{ data: [] }], insights = {} } = {}) {
    let pageIndex = 0;
    const calls = { media: 0, insights: 0 };

    const fetchFn = async (input) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/media")) {
        calls.media++;
        const page = pages[pageIndex] || { data: [] };
        pageIndex++;
        const body = { data: page.data };
        // Cursor metadata (after) and the next-page signal (next) are independent:
        // Instagram can leave a cursor on the final page without advertising a next.
        if (page.after) {
          body.paging = { cursors: { after: page.after } };
        }
        if (page.hasNext) {
          body.paging = body.paging || {};
          body.paging.next = "next-url";
        }
        return response(body);
      }

      const match = url.pathname.match(/\/([^/]+)\/insights$/u);
      if (match) {
        calls.insights++;
        const mediaId = decodeURIComponent(match[1]);
        const conf = insights[mediaId];
        if (conf === "error") {
          return response({ error: { message: "insights not permitted" } }, 403);
        }
        if (typeof conf === "number") {
          return response({ data: [{ name: "reach", values: [{ value: conf }] }] });
        }
        return response({ data: [] });
      }

      throw new Error(`unexpected fetch: ${url}`);
    };

    return { fetchFn, calls };
  }

  function appWith(harness) {
    return makeApp({ fetchFn: harness.fetchFn, now: () => NOW });
  }

  function envWith(overrides = {}) {
    return {
      STATE: new MockKV({ token: { access_token: "tok" } }),
      IG_USER_ID: "user-1",
      MEDIA_FACTS_SECRET: "read-secret",
      TRIGGER_SECRET: "publish-secret",
      ...overrides,
    };
  }

  function run(harness, query = "") {
    const app = appWith(harness);
    return app.test.readMediaFacts(envWith(), new URLSearchParams(query));
  }

  it("maps one in-window page; carousel is one top-level row", async () => {
    const harness = mediaFactsHarness({
      pages: [{ data: [igMedia("m1", "2026-07-09T12:00:00Z")] }],
      insights: { m1: 42 },
    });

    const result = await run(harness);

    expect(result.schema_version).toBe(1);
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]).toMatchObject({
      media_id: "m1",
      caption: "caption m1",
      media_type: "CAROUSEL_ALBUM",
      media_product_type: "FEED",
      permalink: "https://instagram.com/p/m1",
      like_count: 5,
      comments_count: 1,
      reach: 42,
    });
    expect(result.posts[0].posted_at).toBe("2026-07-09T12:00:00.000Z");
    expect(result.insights).toMatchObject({ requested: 1, succeeded: 1, failed: 0 });
    expect(result.degraded).toBe(false);
  });

  it("maps a reel's media_product_type", async () => {
    const harness = mediaFactsHarness({
      pages: [
        {
          data: [
            igMedia("reel1", "2026-07-09T22:00:00Z", {
              media_type: "VIDEO",
              media_product_type: "REELS",
            }),
          ],
        },
      ],
      insights: { reel1: 10 },
    });

    const result = await run(harness);
    expect(result.posts[0].media_type).toBe("VIDEO");
    expect(result.posts[0].media_product_type).toBe("REELS");
  });

  it("excludes media older than the days window", async () => {
    const harness = mediaFactsHarness({
      pages: [
        {
          data: [
            igMedia("recent", "2026-07-09T12:00:00Z"),
            igMedia("old", "2026-07-01T12:00:00Z"),
          ],
        },
      ],
    });

    const result = await run(harness, "days=4");
    expect(result.posts.map((p) => p.media_id)).toEqual(["recent"]);
  });

  it("returns empty posts and 200-shape for an account with no media", async () => {
    const harness = mediaFactsHarness({ pages: [{ data: [] }] });
    const result = await run(harness);
    expect(result.posts).toEqual([]);
    expect(result.insights.requested).toBe(0);
  });

  it("failed reach leaves facts present and flags degraded", async () => {
    const harness = mediaFactsHarness({
      pages: [{ data: [igMedia("m1", "2026-07-09T12:00:00Z")] }],
      insights: { m1: "error" },
    });

    const result = await run(harness);
    expect(result.posts[0].media_id).toBe("m1");
    expect(result.posts[0].reach).toBeNull();
    expect(result.insights).toMatchObject({ requested: 1, succeeded: 0, failed: 1 });
    expect(result.degraded).toBe(true);
  });

  it("empty insights payload maps reach to null, not zero", async () => {
    const harness = mediaFactsHarness({
      pages: [{ data: [igMedia("m1", "2026-07-09T12:00:00Z")] }],
      insights: { m1: "empty" },
    });

    const result = await run(harness);
    expect(result.posts[0].reach).toBeNull();
  });

  it("follows paging.cursors.after across two pages and dedupes by media_id", async () => {
    const harness = mediaFactsHarness({
      pages: [
        { data: [igMedia("m1", "2026-07-09T12:00:00Z")], after: "cursor-1", hasNext: true },
        { data: [igMedia("m1", "2026-07-09T12:00:00Z"), igMedia("m2", "2026-07-08T12:00:00Z")] },
      ],
    });

    const result = await run(harness);
    expect(result.pages_fetched).toBe(2);
    expect(result.posts.map((p) => p.media_id).sort()).toEqual(["m1", "m2"]);
    expect(harness.calls.media).toBe(2);
  });

  it("throws on a pagination cursor loop", async () => {
    const harness = mediaFactsHarness({
      pages: [
        { data: [igMedia("m1", "2026-07-09T12:00:00Z")], after: "same", hasNext: true },
        { data: [igMedia("m2", "2026-07-09T11:00:00Z")], after: "same", hasNext: true },
      ],
    });

    await expect(run(harness)).rejects.toThrow(/cursor loop/iu);
  });

  it("throws when pagination exceeds the page cap", async () => {
    const pages = Array.from({ length: 9 }, (_, i) => ({
      data: [igMedia(`m${i}`, "2026-07-09T12:00:00Z")],
      after: `cursor-${i}`,
      hasNext: true,
    }));
    const harness = mediaFactsHarness({ pages });
    await expect(run(harness)).rejects.toThrow(/exceeded 8 pages/iu);
  });

  it("does not follow a final-page cursor when paging.next is absent", async () => {
    const harness = mediaFactsHarness({
      pages: [
        {
          data: [igMedia("m1", "2026-07-09T12:00:00Z")],
          after: "final-cursor",
          hasNext: false,
        },
      ],
    });

    const result = await run(harness);

    expect(result.pages_fetched).toBe(1);
    expect(result.posts.map((post) => post.media_id)).toEqual(["m1"]);
    expect(harness.calls.media).toBe(1);
  });

  it("fails closed on an invalid media timestamp", async () => {
    const harness = mediaFactsHarness({
      pages: [{ data: [igMedia("m1", "not-a-date")] }],
    });
    await expect(run(harness)).rejects.toThrow(/invalid timestamp/iu);
  });

  it("accepts missing caption and permalink as null", async () => {
    const harness = mediaFactsHarness({
      pages: [
        {
          data: [
            igMedia("m1", "2026-07-09T12:00:00Z", {
              caption: undefined,
              permalink: undefined,
            }),
          ],
        },
      ],
    });

    const result = await run(harness);
    expect(result.posts[0].caption).toBeNull();
    expect(result.posts[0].permalink).toBeNull();
  });

  it("rejects days and since together, and out-of-range days", async () => {
    const harness = mediaFactsHarness();
    await expect(run(harness, "days=4&since=2026-07-01")).rejects.toThrow(
      /mutually exclusive/iu
    );
    await expect(run(harness, "days=99")).rejects.toThrow(/days must be between/iu);
  });

  it("route requires the dedicated read secret, never the publish secret", async () => {
    const harness = mediaFactsHarness({
      pages: [{ data: [igMedia("m1", "2026-07-09T12:00:00Z")] }],
    });
    const app = appWith(harness);
    const env = envWith();

    const unauth = await app.handler.fetch(
      new Request("https://worker/media-facts"),
      env
    );
    expect(unauth.status).toBe(401);

    const withPublishSecret = await app.handler.fetch(
      new Request("https://worker/media-facts", {
        headers: { Authorization: "Bearer publish-secret" },
      }),
      env
    );
    expect(withPublishSecret.status).toBe(401);

    const ok = await app.handler.fetch(
      new Request("https://worker/media-facts", {
        headers: { Authorization: "Bearer read-secret" },
      }),
      env
    );
    expect(ok.status).toBe(200);
    const payload = await ok.json();
    expect(payload.posts).toHaveLength(1);
  });

  it("rejects a non-GET method on the route", async () => {
    const harness = mediaFactsHarness();
    const app = appWith(harness);
    const res = await app.handler.fetch(
      new Request("https://worker/media-facts", {
        method: "POST",
        headers: { Authorization: "Bearer read-secret" },
      }),
      envWith()
    );
    expect(res.status).toBe(405);
  });

  it("read secret cannot reach the publish route", async () => {
    const harness = mediaFactsHarness();
    const app = appWith(harness);
    const res = await app.handler.fetch(
      new Request("https://worker/run?kind=carousel", {
        method: "POST",
        headers: { Authorization: "Bearer read-secret" },
      }),
      envWith()
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on a bad window and 502 on an upstream failure", async () => {
    const app = appWith(mediaFactsHarness());
    const bad = await app.handler.fetch(
      new Request("https://worker/media-facts?days=0", {
        headers: { Authorization: "Bearer read-secret" },
      }),
      envWith()
    );
    expect(bad.status).toBe(400);

    const brokenHarness = {
      fetchFn: async () => {
        throw new Error("upstream boom");
      },
    };
    const brokenApp = appWith(brokenHarness);
    const upstream = await brokenApp.handler.fetch(
      new Request("https://worker/media-facts", {
        headers: { Authorization: "Bearer read-secret" },
      }),
      envWith()
    );
    expect(upstream.status).toBe(502);
  });
});
