"""Build the 60-day Instagram content calendar for @envious_staging.

Deterministic: same inputs -> same calendar.json. 48 before/after carousel
posts (one per portfolio room pair) + 12 "encore" single-image posts of the
strongest rooms, interleaved so consecutive days rotate across properties.

Output: scheduler/worker/calendar.json (the worker's bundle source) — list of
{date, images[], caption}. Images reference the live site (Instagram fetches
them server-side).

Run: python3 scheduler/build_calendar.py [start-date YYYY-MM-DD]
Current live calendar starts 2026-06-12 (2026-06-11 was posted manually
during the build session; KV last_posted_date reflects that).
"""

import json
import sys
import unicodedata
from datetime import date, timedelta
from pathlib import Path

SITE = "https://enviousstaging.com/images/portfolio"
PORTFOLIO_DIR = Path(
    "/Users/m4pro_sv/Developer/EnviousLabs/EnviousStaging/website/public/images/portfolio"
)
# Single source of truth: written directly where the worker bundles it from,
# so a deploy can never pick up a stale copy (Codex review 2026-06-11).
OUT = Path(__file__).parent / "worker" / "calendar.json"
REELS = Path(__file__).parent / "worker" / "reels-calendar.json"


def canon(value: str) -> str:
    """Match the worker's conservative Instagram caption normalization
    (index.js canon): NFC, CRLF/CR -> LF, strip trailing whitespace per line
    and at the end. The worker uses caption equality under canon() to match a
    published post back to its calendar entry, so the two must agree exactly.
    """
    value = unicodedata.normalize("NFC", value)
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in value.split("\n")).rstrip()

PROPERTIES = {
    "naugatuck-ct-cape": {"town": "Naugatuck", "label": "Naugatuck cape"},
    "naugatuck-ct-colonial": {"town": "Naugatuck", "label": "Naugatuck colonial"},
    "new-milford-ct-estate": {"town": "New Milford", "label": "New Milford estate"},
    "norwalk-ct-colonial": {"town": "Norwalk", "label": "Norwalk colonial"},
    "stamford-ct-colonial": {"town": "Stamford", "label": "Stamford colonial"},
}

ROOM_NAMES = {
    "basement-rec": "basement rec room",
    "basement-sitting": "basement sitting area",
    "bedroom-12": "bedroom",
    "bedroom-15": "bedroom",
    "breakfast-nook": "breakfast nook",
    "child-bedroom": "child's bedroom",
    "deck": "deck",
    "den": "den",
    "dining-area": "dining area",
    "dining-room": "dining room",
    "exterior-firepit": "firepit patio",
    "exterior-play": "backyard play area",
    "family-room": "family room",
    "first-floor-bedroom": "first-floor bedroom",
    "foyer": "foyer",
    "game-room-a": "game room",
    "game-room-b": "game room",
    "great-room": "great room",
    "guest-bedroom": "guest bedroom",
    "home-office": "home office",
    "kids-bedroom": "kids' bedroom",
    "living-room": "living room",
    "living-room-wide": "living room",
    "media-room": "media room",
    "music-room": "music room",
    "nursery": "nursery",
    "primary-bedroom": "primary bedroom",
    "primary-suite": "primary suite",
    "screened-porch": "screened porch",
    "teen-bedroom": "teen bedroom",
    "upstairs-bedroom": "upstairs bedroom",
    "upstairs-reading-nook": "reading nook",
}

# Caption pieces cycle independently (10 hooks x 6 bodies = 60-post cycle) so
# no two captions in the 60-day window assemble identically. Voice per
# brand-guide; council-reviewed 2026-06-11 (session ig-copy-proofread-2026-06-11):
# no "Swipe" tutorial language, pain-point-first hooks, sub-125-char stop line.
CAROUSEL_OPENERS = [
    "Empty rooms make buyers work too hard. We gave this {town} {room} a clear purpose.",
    "Buyers scroll right past empty spaces. This staged {room} makes them stop. The original is on slide two.",
    "First impressions happen online. This is what buyers see now when they open this {label} listing.",
    "A staged {room} helps buyers mentally move in. The empty version is next.",
    "Blank walls do not sell houses. The before photo is next to prove it.",
    "Empty room, easy scroll past. Staged room, reason to stop.",
    "This {town} {room} needed a stronger first impression. Before is on slide 2.",
    "The empty {room} was not doing this listing any favors. See the before next.",
    "Buyers do not linger over blank space. This {room} gives them a place to land.",
    "The bones were there. The staged {room} gave buyers the story.",
]

CAROUSEL_BODIES = [
    "Send us your listing photos and we handle everything. Our experts use AI to design the space, then review every detail by hand. Delivered MLS-ready in up to 2 business days, usually faster!",
    "AI-powered staging, handled by real people. We stage the room, review the details by hand, and send it back MLS-ready in up to 2 business days, usually faster!",
    "No software, no prompts, no extra task on your list. Send the listing photos and we handle the staging from start to finish.",
    "One simple flat price for the entire listing. Our AI-powered, hand-reviewed process gets beautiful photos back to you in up to 2 business days, usually faster!",
    "We use AI to move quickly, then our team reviews every image by hand so the final result feels polished, realistic, and ready to list.",
    "Let us take staging off your plate entirely. We combine smart AI staging with a human eye for detail, delivered in up to 2 business days, usually faster!",
]

ENCORE_OPENERS = [
    "We cannot stop looking at this {room} from a recent {town} listing.",
    "A favorite from the {label} listing: this staged {room} earned a second look.",
    "Sometimes the design just clicks. A standout {room} from this {label}.",
    "This {town} {room} is exactly why empty spaces deserve a plan.",
    "Buyers fell in love with this {room} and we completely understand why.",
    "Still one of our favorite staged rooms from this {label} listing.",
]

ENCORE_BODY = (
    "Every photo we deliver is AI-staged by our design team and reviewed by hand "
    "before it reaches you. We handle everything so you can focus on selling the property."
)

CTA = "Portfolio, pricing, and easy ordering at enviousstaging.com"

# Hashtags: core 4 always + a rotating niche bank of 3 + 2 town tags = 9 per post.
CORE_TAGS = "#virtualstaging #homestaging #listingagent #ctrealestate"
NICHE_BANKS = [
    "#realestatemarketing #stagedtosell #ctrealtor",
    "#listingmarketing #propertymarketing #connecticutrealestate",
    "#realestatemarketing #cthomesforsale #connecticutliving",
]
TOWN_TAGS = {
    "Naugatuck": "#naugatuckct #naugatuckrealestate",
    "New Milford": "#newmilfordct #newmilfordrealestate",
    "Norwalk": "#norwalkct #norwalkrealestate",
    "Stamford": "#stamfordct #stamfordrealestate",
}

# Strongest rooms to re-feature as single-image encore posts (12).
ENCORES = [
    ("new-milford-ct-estate", "music-room"),
    ("naugatuck-ct-cape", "game-room-a"),
    ("stamford-ct-colonial", "great-room"),
    ("norwalk-ct-colonial", "nursery"),
    ("new-milford-ct-estate", "media-room"),
    ("naugatuck-ct-colonial", "breakfast-nook"),
    ("new-milford-ct-estate", "primary-suite"),
    ("naugatuck-ct-cape", "screened-porch"),
    ("stamford-ct-colonial", "family-room"),
    ("norwalk-ct-colonial", "home-office"),
    ("new-milford-ct-estate", "exterior-firepit"),
    ("naugatuck-ct-cape", "upstairs-reading-nook"),
]


def room_pairs() -> list[tuple[str, str]]:
    pairs = []
    for prop in sorted(PROPERTIES):
        for after in sorted((PORTFOLIO_DIR / prop).glob("*-after.jpg")):
            room = after.name.removesuffix("-after.jpg")
            if (PORTFOLIO_DIR / prop / f"{room}-before.jpg").exists():
                pairs.append((prop, room))
    return pairs


ROOM_CATEGORIES = {
    "living": {
        "living-room", "living-room-wide", "family-room", "great-room", "den",
        "basement-rec", "basement-sitting", "media-room", "game-room-a",
        "game-room-b", "music-room", "foyer",
    },
    "bedroom": {
        "primary-bedroom", "primary-suite", "guest-bedroom", "kids-bedroom",
        "child-bedroom", "teen-bedroom", "bedroom-12", "bedroom-15",
        "first-floor-bedroom", "upstairs-bedroom", "nursery",
    },
    "dining": {"dining-area", "dining-room", "breakfast-nook"},
    "office": {"home-office", "upstairs-reading-nook"},
    "outdoor": {"deck", "screened-porch", "exterior-firepit", "exterior-play"},
}
ROOM_TO_CATEGORY = {room: cat for cat, rooms in ROOM_CATEGORIES.items() for room in rooms}


def interleave_by_property(pairs: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Greedy ordering: consecutive posts differ in BOTH property and room
    category wherever possible, draining the most-loaded buckets first so the
    tail doesn't collapse into one property or one category."""
    remaining = list(pairs)
    out: list[tuple[str, str]] = []
    prev_prop, prev_cat = None, None
    while remaining:
        prop_load = {p: sum(1 for q, _ in remaining if q == p) for p, _ in remaining}
        cat_load = {}
        for _, r in remaining:
            c = ROOM_TO_CATEGORY[r]
            cat_load[c] = cat_load.get(c, 0) + 1

        def score(item):
            prop, room = item
            cat = ROOM_TO_CATEGORY[room]
            return (
                prop != prev_prop,          # hard-ish preferences first
                cat != prev_cat,
                cat_load[cat],              # then drain the fullest buckets
                prop_load[prop],
                item,                       # deterministic tie-break
            )

        best = max(remaining, key=score)
        remaining.remove(best)
        out.append(best)
        prev_prop, prev_cat = best[0], ROOM_TO_CATEGORY[best[1]]
    return out


def _pick(
    pool: list[tuple[str, str]],
    day: int,
    last_prop_day: dict[str, int],
    last_cat_day: dict[str, int],
    last_room_day: dict[tuple[str, str], int],
) -> tuple[str, str]:
    """Greedy: prefer the property and room category seen longest ago (true
    rotation, not just different-from-yesterday), avoid re-showing the same
    room within 14 days (encores), and drain the fullest buckets on ties so
    the tail doesn't collapse into a single house or room type."""
    prop_load = {p: sum(1 for q, _ in pool if q == p) for p, _ in pool}
    cat_load: dict[str, int] = {}
    for _, r in pool:
        c = ROOM_TO_CATEGORY[r]
        cat_load[c] = cat_load.get(c, 0) + 1

    def score(item):
        prop, room = item
        cat = ROOM_TO_CATEGORY[room]
        prop_gap = day - last_prop_day.get(prop, -100)
        cat_gap = day - last_cat_day.get(cat, -100)
        room_gap = day - last_room_day.get((prop, room), -100)
        return (
            room_gap > 14,                    # never re-show a room within 2 weeks
            min(prop_gap, 4),                 # rotate properties (gaps past 4 equal)
            min(cat_gap, 3),                  # rotate room types (gaps past 3 equal)
            cat_load[cat],
            prop_load[prop],
            item,
        )

    best = max(pool, key=score)
    pool.remove(best)
    return best


def build(start: date) -> list[dict]:
    pairs_left = room_pairs()
    assert len(pairs_left) == 48, f"expected 48 pairs, got {len(pairs_left)}"
    assert len(ENCORES) == 12, f"expected 12 encores, got {len(ENCORES)}"

    entries = []
    # Slot one encore after every 4 carousels: positions 4, 9, 14, ... (0-based)
    encores_left = list(ENCORES)
    last_prop_day: dict[str, int] = {}
    last_cat_day: dict[str, int] = {}
    last_room_day: dict[tuple[str, str], int] = {}
    for i in range(60):
        is_encore = (i % 5 == 4) and i < 60
        d = start + timedelta(days=i)
        if is_encore:
            prop, room = _pick(encores_left, i, last_prop_day, last_cat_day, last_room_day)
            meta = PROPERTIES[prop]
            room_name = ROOM_NAMES[room]
            opener = ENCORE_OPENERS[(i // 5) % len(ENCORE_OPENERS)].format(
                room=room_name, town=meta["town"], label=meta["label"]
            )
            tags = f"{CORE_TAGS} {NICHE_BANKS[i % len(NICHE_BANKS)]} {TOWN_TAGS[meta['town']]}"
            caption = f"{opener}\n\n{ENCORE_BODY}\n\n{CTA}\n\n{tags}"
            images = [f"{SITE}/{prop}/{room}-after.jpg"]
        else:
            prop, room = _pick(pairs_left, i, last_prop_day, last_cat_day, last_room_day)
            meta = PROPERTIES[prop]
            room_name = ROOM_NAMES[room]
            opener = CAROUSEL_OPENERS[i % len(CAROUSEL_OPENERS)].format(
                room=room_name, town=meta["town"], label=meta["label"]
            )
            # i//10 offset de-syncs the 10-hook and 6-body cycles (they realign
            # every lcm=30 days otherwise, duplicating placeholder-free combos).
            body = CAROUSEL_BODIES[(i + i // len(CAROUSEL_OPENERS)) % len(CAROUSEL_BODIES)]
            tags = f"{CORE_TAGS} {NICHE_BANKS[i % len(NICHE_BANKS)]} {TOWN_TAGS[meta['town']]}"
            caption = f"{opener}\n\n{body}\n\n{CTA}\n\n{tags}"
            images = [
                f"{SITE}/{prop}/{room}-after.jpg",
                f"{SITE}/{prop}/{room}-before.jpg",
            ]
        entries.append(
            {
                "date": d.isoformat(),
                "property": prop,
                "room": room,
                "images": images,
                "caption": caption,
            }
        )
        last_prop_day[prop] = i
        last_cat_day[ROOM_TO_CATEGORY[room]] = i
        last_room_day[(prop, room)] = i

    _swap_pass(entries)
    return entries


def _violations(entries: list[dict]) -> int:
    """Count: same room within 14 days + same property/category on consecutive days."""
    count = 0
    seen: dict[tuple[str, str], int] = {}
    for idx, e in enumerate(entries):
        k = (e["property"], e["room"])
        if k in seen and idx - seen[k] <= 14:
            count += 1
        seen[k] = idx
    for a, b in zip(entries, entries[1:]):
        if a["property"] == b["property"]:
            count += 1
        if ROOM_TO_CATEGORY[a["room"]] == ROOM_TO_CATEGORY[b["room"]]:
            count += 1
    return count


def _swap_pass(entries: list[dict]) -> None:
    """Greedy leaves a few tail violations; try same-format swaps that lower
    the total count. Dates stay fixed; only the content moves between days."""
    improved = True
    while improved:
        improved = False
        for i in range(len(entries)):
            for j in range(i + 1, len(entries)):
                if (len(entries[i]["images"]) != len(entries[j]["images"])):
                    continue  # keep carousel/encore day pattern intact
                before = _violations(entries)
                entries[i], entries[j] = entries[j], entries[i]
                entries[i]["date"], entries[j]["date"] = entries[j]["date"], entries[i]["date"]
                if _violations(entries) < before:
                    improved = True
                else:
                    entries[i], entries[j] = entries[j], entries[i]
                    entries[i]["date"], entries[j]["date"] = entries[j]["date"], entries[i]["date"]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: build_calendar.py <start-date YYYY-MM-DD> (no default; be explicit)")
    start = date.fromisoformat(sys.argv[1])
    entries = build(start)

    # Caption uniqueness must hold under canon() across BOTH calendars, because
    # the worker matches a published post back to its entry by canonical caption
    # (a collision would let one post satisfy two entries, or mis-heal state).
    reels = json.loads(REELS.read_text()) if REELS.exists() else []
    captions_by_canon: dict[str, list[tuple[str, str]]] = {}
    for entry in (*entries, *reels):
        source = "carousel" if "images" in entry else "reel"
        captions_by_canon.setdefault(canon(entry["caption"]), []).append(
            (source, entry["date"])
        )
    duplicate_captions = {c: o for c, o in captions_by_canon.items() if len(o) > 1}
    assert not duplicate_captions, (
        f"duplicate canonical captions across both calendars: {duplicate_captions}"
    )
    dates = [e["date"] for e in entries]
    assert len(set(dates)) == 60 and sorted(dates) == dates, "dates not 60 unique ascending"
    clashes = sum(1 for a, b in zip(entries, entries[1:]) if a["property"] == b["property"])
    cat_clashes = sum(
        1 for a, b in zip(entries, entries[1:])
        if ROOM_TO_CATEGORY[a["room"]] == ROOM_TO_CATEGORY[b["room"]]
    )

    OUT.write_text(json.dumps(entries, indent=2) + "\n")
    used = {(e["property"], e["room"]) for e in entries}
    print(f"wrote {len(entries)} entries to {OUT} ({len(used)} unique property/room slots)")
    print(f"range: {entries[0]['date']} .. {entries[-1]['date']}")
    print(f"consecutive-day clashes: property={clashes}, room-category={cat_clashes}")
