# YouTube Queue — design brief

A single userscript that makes YouTube's queue reachable from anywhere and pleasant to manage. This
doc is the authoritative-ish spec; the README is the user-facing summary.

## Non-negotiables

- **Drive YouTube's own machinery.** Never maintain a parallel queue, never scrape what the site
  already models. Every operation is a YouTube command or handler, invoked the way YouTube invokes
  it. This is what keeps the feature honest when YouTube changes.
- **Fail safe.** Every reach into YouTube internals is wrapped. A renamed element or a missing method
  makes a feature quietly no-op — never a thrown error, never a broken page.
- **Never fabricate state.** The panel is a *view* over `getPlaylistData()`. If YouTube says the
  queue is empty, we say the queue is empty.
- **Hands off real playlists.** Only throwaway `TLPQ…` queues are ours to clear, reorder or edit. If
  the user is playing a saved playlist, every mutating affordance stays out of the way.
- **No innerHTML, ever.** See "Trusted Types" below. This is a hard constraint, not a style choice.
- **Persist only non-sensitive data** (`ytq_prefs_v1`, `ytq_snapshot_v1`): UI preferences and a list
  of video IDs. No credentials, no tokens, no account data.
- **Never act silently on the user's behalf at load time.** Auto-restore is opt-in.

---

## The four primitives

Everything the script does decomposes into four operations against YouTube's queue. All were probed
against live youtube.com on **2026-08-30** before any code was written.

### 1. ADD — verified ✅

YouTube's native "Add to queue" menu item carries a `signalServiceEndpoint` whose only action is an
`addToPlaylistCommand`. The whole envelope is reconstructible from a bare `videoId`; the
`clickTrackingParams` present in the native one are telemetry, not authorization.

```js
ytdApp.resolveCommand({
  commandMetadata: { webCommandMetadata: { sendPost: true } },
  signalServiceEndpoint: { signal: 'CLIENT_SIGNAL', actions: [{ addToPlaylistCommand: {
    openMiniplayer: false,
    videoId: ids[0],
    listType: 'PLAYLIST_EDIT_LIST_TYPE_QUEUE',
    onCreateListCommand: { /* apiUrl: /youtubei/v1/playlist/create */ },
    videoIds: ids,          // <- an ARRAY, appended in order, one round trip
  } }] },
});
```

Three things this bought us:

- **Queue from any page** without opening a menu, which is the entire premise of the script.
- **`videoIds` is an array.** Bulk-queue and restore-after-reload cost one request, not N.
- **`openMiniplayer: false` is safe.** Verified across the cold-create path, single appends and
  multi-appends: everything still lands and the miniplayer stays shut. Hence the default — queueing
  from the home page shouldn't hijack the corner of the screen.

A queue is a real, server-side, throwaway playlist whose id starts with `TLPQ`.

### 2. READ — verified ✅

`yt-playlist-manager.getPlaylistData()` returns
`{title, contents:[{playlistPanelVideoRenderer}], currentIndex, playlistId, totalVideos}`.

Critically, **it answers on every page type**, not just `/watch` — confirmed on the home page and on
search. That single fact is what makes a floating panel possible off the watch page.
`#movie_player.getPlaylist()` / `.getPlaylistIndex()` is a second, player-side view of the same list,
used only as a fallback for `currentIndex`.

### 3. REORDER (and PLAY-NEXT) — verified ✅

The queue panel's Polymer controller exposes `handleDrop({currDragItem: rowEl})`. Reading its
minified source shows it computes the target index from the row's **current position among its DOM
siblings**, then syncs that order into YouTube's internal queue proxy:

```js
function(g){ var Z=g.currDragItem; g=Z.data.playlistSetVideoId;
  var t=_.p6U(Z.parentNode.childNodes,Z), a=void 0;
  t>0&&(a=Z.parentNode.childNodes[t-1].data.playlistSetVideoId);
  … Z.queueProxy ? tXL(Z.queueProxy,b,t,g,a) : … }
```

So a reorder is: **move the node, then call `handleDrop`**. No endpoint, no auth, no network. The
player's own `getPlaylist()` reflects the new order immediately.

Verified with three moves (middle→up, front→end, end→front); every resulting order was exactly right
and the panel DOM stayed in sync with the player's list. **Play-next is built on this**: append, wait
for the row to arrive, then move it to `currentIndex + 1`.

`computeCanReorder` is `playlistId.startsWith("TLPQ") ? true : (isEditable && !isInfinite)` — so
reordering is *never* gated for a queue. YouTube simply hides the handle (`#reorder`) until hover,
which is why the script forces it visible. The capability was always there; only the affordance was
missing.

**Known limit:** this needs `ytd-playlist-panel-renderer#playlist` in the DOM. It is present on
`/watch` and *survives SPA navigation away from it* (confirmed: still present and functional on the
home page after visiting a video). But on a **cold load** of a browse page it is absent, so reorder
and remove degrade to unavailable there and say so. Adding is unaffected.

### 4. REMOVE — verified signed-in ✅

Each queue row's menu carries a remove item. The script harvests that row's own `serviceEndpoint` and
fires it, **matching on `icon.iconType` (`REMOVE`/`DELETE`/`TRASH`) rather than label text** — note
the label is actually **"Remove from playlist"**, not "Remove from queue", and it is translated, so
icon-matching isn't just defensive here, it's necessary.

```jsonc
{ "commandMetadata": { "webCommandMetadata": {
    "sendPost": true, "apiUrl": "/youtubei/v1/browse/edit_playlist" } },
  "playlistEditEndpoint": {
    "playlistId": "TLPQ…",
    "params": "CAE%3D",
    "actions": [{ "setVideoId": "<playlistSetVideoId>", "action": "ACTION_REMOVE_VIDEO" }],
    "clientActions": [{ "playlistRemoveVideosAction": { "setVideoIds": ["<same>"] } }] } }
```

**Why we harvest instead of reconstruct:** during signed-out research a hand-built
`playlistEditEndpoint` carrying only `playlistId` + `actions` was passed to `resolveCommand` and
*silently swallowed* — no error, no network request at all. The real endpoint also carries `params`
and `clientActions`. Rather than guess which of those is load-bearing, take the whole object verbatim
from the row that owns it.

Two rules found by testing, both load-bearing:

- **(a) The menu rides along in `getPlaylistData()`**, not only in the `/watch` panel. The first
  draft sourced it from `panelRows()`, which made remove silently unavailable on every page except
  `/watch` — a real bug, caught and fixed. Verified after the fix: a mid-queue row removed cleanly
  from a **search page with no panel in the DOM**.
- **(b) Every row has a remove action EXCEPT the one currently playing**, which has no menu at all.
  Verified across a 4-item queue: `hasMenu === !selected` held for every row. This is YouTube's own
  rule, so `removeAt` returns `'playing'` and the UI says so, rather than pushing a common action
  into the scary rebuild path.

**Fallback:** rebuild the queue from the remaining IDs in one `addToPlaylistCommand`. Retained for
the case where YouTube offers no endpoint at all. It restarts playback, so it stays behind a confirm.
**Diagnostics reports which path is live** — and probes a non-current row, since the current one
never has an endpoint.

---

### Clearing, and one attractive dead end

`#movie_player.clearQueue()` looks exactly like the fallback you want when the panel isn't around:
it exists, it is a `function`, and calling it throws nothing. **It also does nothing** — verified on
both a browse page and the home page, queue unchanged. Do not trust it.

The only control that empties a queue completely is the panel's native
`button[aria-label="Clear queue"]` (confirmed the working selector; `#clear-button button` and
`tp-yt-paper-button#clear` both match nothing). Off `/watch`, `clearQueue()` therefore falls back to
firing each row's own remove endpoint — which clears everything **except** the playing item — and
returns `'partial'` so the UI can say precisely that. Verified: 3-item queue → 1 remaining.

The removes are staggered ~350 ms apart because each is a server round trip. That is safe because
`setVideoId`s are stable per-item identifiers, not positions, so they stay valid as the list shrinks.

### Signed-in queues already survive a reload

Signed **out**, a hard reload empties the queue (verified). Signed **in**, it does not — a full page
load restored the queue with the *same* `TLPQ` id, i.e. YouTube persists it server-side against the
session.

This narrows what the snapshot/restore feature is actually for. It is **not** the primary mechanism
for a signed-in user; it is a safety net for when YouTube does drop the queue — a clear, a signed-out
session, a long enough gap. That is worth stating plainly in the README rather than overselling it,
and it is a further argument for keeping auto-restore off by default: for the common case YouTube has
already done the job, and replaying a snapshot over a queue YouTube just restored would duplicate it.

## Two things live testing taught us

Both of these were found by running the code against real YouTube, and both would have shipped as
bugs otherwise. Do not regress them.

### Trusted Types breaks `innerHTML`

`youtube.com` ships `require-trusted-types-for 'script'`. Any `innerHTML` assignment throws:

```
TypeError: Failed to set the 'innerHTML' property on 'Element':
This document requires 'TrustedHTML' assignment.
```

The first draft built the hover buttons and the whole dock with `innerHTML` — every one of those
would have been dead on arrival. Everything is now built with `createElement` /
`createElementNS` and filled via `textContent`. Pleasant side effect: user-controlled text (video
titles, channel names) never touches an HTML parser, so there is no escaping left to get wrong — the
`escapeHtml` helpers the first draft needed are gone entirely.

### Livestream "durations" are not durations

A long-running livestream reports `lengthText` as its **elapsed** time. Real observed values from a
five-item test queue:

| `lengthText` | Reality |
| --- | --- |
| `8:00:00` | a genuine 8-hour video |
| `20,843:43:51` | a livestream, no LIVE badge |
| `33,778:11:52` | a livestream, no LIVE badge |
| *(absent)* | a livestream, **with** a `BADGE_STYLE_TYPE_LIVE_NOW` badge |

Naive parsing adds tens of thousands of hours to every total. Note that the badge is **not** a
reliable signal — two of the three livestreams didn't carry one — and the thousands separator only
happens to break `Number()` in an English locale, so that near-miss is luck, not logic.

Duration parsing therefore rejects, explicitly: a missing `lengthText`, a `LIVE` badge, a string that
doesn't match `^\d+(:\d{1,2}){1,2}$` after stripping separators, and **anything over 24 hours**.
Rejected items are counted separately as "unknown" and shown as `LIVE` — never silently as zero, and
never as a fake runtime. A genuine video longer than a day is rare enough that this is the right
trade.

---

## Feature inventory (all shipped in v0.1.0)

| Feature | Notes |
| --- | --- |
| Hover `+ queue` / `play next` buttons on thumbnails | Structural anchor discovery, see below |
| Shift-click (or Alt / middle-click) any video link to queue | Capture-phase, so YouTube's navigation never fires |
| `Q` / `Shift+Q` on the hovered video | Ignored while typing; `q` is unbound by YouTube |
| `Alt+Shift+Q` toggles the floating panel | Works with nothing hovered |
| Floating queue panel on every page | Collapsible to a pill, drag-resizable, left/right |
| Running totals (count, total runtime, time left) | Both in the dock and injected into the native panel |
| One-click remove per row | Native endpoint, rebuild fallback |
| Drag reorder | Both panels |
| Always-visible native reorder handles | Pure CSS over a capability YouTube already had |
| Keep native panel expanded | |
| Snapshot + restore after reload | One command; verified in exact order |
| Diagnostics | Reports which of the four primitives are live |

### Thumbnail discovery is structural, not a selector list

YouTube is mid-migration from `ytd-*-renderer` elements to `yt-lockup-view-model`, and enumerating
every renderer across every surface is a losing game. Instead the script finds thumbnail anchors by
shape: **an `<a>` that resolves to a video ID *and* contains an image**. A card's title link has no
image, so this lands exactly one button per card.

Verified live: 1 anchor per card, 0 duplicates, 0 bleed into the queue panel / dock / miniplayer.
Anchors that YouTube recycled and stripped our node from are re-decorated on the next sweep
(`:scope > .ytq-hover` presence check, not just the `data-` marker).

### Sweep strategy

A `MutationObserver` on `documentElement` with a `requestAnimationFrame`-debounced flush, plus the
SPA's own `yt-navigate-finish` / `yt-page-data-updated` events, plus one-time re-sweeps at
500/1500/3500 ms as insurance for late-mounting renderers. Queue snapshotting runs on a 3 s timer
rather than per-mutation — the queue changes rarely, and a timer also catches changes the user made
through YouTube's *own* UI, not just ours.

---

## Verification log — 2026-08-30 (signed out)

| Check | Result |
| --- | --- |
| Synthesized `addToPlaylistCommand` from a bare video ID | ✅ `/playlist/create` + `/next` both 200 |
| Multi-ID append (3 at once) | ✅ all three appended, in order |
| `getPlaylistData()` off `/watch` (home page) | ✅ full queue returned |
| Queue survives SPA navigation | ✅ search → watch → home, intact |
| Reorder via `handleDrop` (3 moves incl. both edges) | ✅ order correct, panel/player in sync |
| `openMiniplayer:false` (create + append + multi) | ✅ all land, miniplayer stays shut |
| Hard reload → restore from snapshot | ✅ empty after reload; 1 command restored all 5 in order |
| Thumbnail anchor discovery | ✅ 1/card, 0 duplicates, 0 bleed |
| Duration parsing incl. livestream elapsed times | ✅ rejects `20,843:43:51`, `25:00:00`; accepts `23:59:59` |
| Dock render against a live 5-item queue | ✅ visually confirmed, theme-matched |

### Signed-in pass — 2026-08-30 (real account, Edge on SylG5)

Queue was empty before and after; nothing of the user's was disturbed.

| Check | Result |
| --- | --- |
| Remove via harvested endpoint | ✅ right row gone, 3 → 2, survivors intact and in order |
| Repeatability | ✅ 4 further removes, one per call |
| Remove **without the panel** (search page) | ✅ the fix works — `panelPresent: false`, row removed |
| Remove the currently-playing row | ✅ returns `'playing'`; queue untouched, no rebuild prompt |
| `hasMenu === !selected` across a 4-item queue | ✅ holds for every row |
| `clearQueue()` fallback off `/watch` | ✅ `'partial'`, 3 → 1 (playing item remains) |
| `#movie_player.clearQueue()` | ❌ **no-op** — present, callable, changes nothing |
| Native clear selector | ✅ `button[aria-label="Clear queue"]` (other two selectors match nothing) |
| `handleDrop` present signed-in | ✅ |
| Queue across a full page load, signed in | ⚠️ **persists** (same `TLPQ` id) — see above |

A note on session health: partway through testing, the signed-out session started returning `400`
from the queue APIs and *every* add failed, including ones that had worked minutes earlier. That was
YouTube throttling an anonymous session, not a script fault — a fresh load restored normal behaviour.
Worth remembering before chasing a phantom bug.

---

## Roadmap

- **v0.2 — reorder without the native panel.** Reorder is now the *only* primitive that still needs
  `ytd-playlist-panel-renderer` in the DOM (remove was freed from it in the signed-in pass). Worth
  investigating whether YouTube's queue proxy is reachable another way — it is module-scoped and
  `_.cx()` is not exposed as a global — which would make the dock fully independent of `/watch`.
- **v0.2 — decide the rebuild fallback's fate.** Now that the native remove endpoint is confirmed on
  every non-current row, the rebuild path may be dead weight. Keep it one release, see if the
  `'playing'` and `'error'` branches ever fire in practice, then consider dropping it.
- **Save the queue as a playlist — there's a native button for it.** The queue panel's header
  carries a **Save** control alongside *Clear queue*. Almost certainly "save this queue as a real
  playlist"; harvesting that endpoint the same way we harvest remove is likely a small job.
- **Bulk actions.** "Queue everything in this row / this search / this playlist" — cheap now, since
  `videoIds` takes an array. Needs a UI that can't be fired by accident.
- **Shuffle / sort the queue**, and de-duplicate.
- **Watched markers** in the panel.
- **YouTube Music / `m.youtube.com`** — different app shells; out of scope until the desktop side is
  settled.
