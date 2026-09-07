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

**When the panel isn't there — strategy 2 (v0.2.0).** `handleDrop` needs
`ytd-playlist-panel-renderer#playlist` in the DOM. That is present on `/watch`, survives SPA
navigation away from it, and is even re-created on a *full* load of a browse page **when a queue is
actively playing**. The gap is narrower than it first looked but very real: queue some videos from a
search page without opening any of them and there is no panel, no player — and in v0.1.0 every drag
in that state did nothing but raise a toast. That was the bug reported after the first install.

So there is a second path, used whenever strategy 1 is unavailable:

```js
{ commandMetadata: { webCommandMetadata: { sendPost: true,
                     apiUrl: '/youtubei/v1/browse/edit_playlist' } },
  playlistEditEndpoint: { playlistId: 'TLPQ…', params: 'CAE%3D',
    actions: [{ action: 'ACTION_MOVE_VIDEO_AFTER', setVideoId: '<moving>',
                movedSetVideoIdPredecessor: '<the one it lands after>' }] } }
```

- **Omitting `movedSetVideoIdPredecessor` moves the item to the front** — verified, which is why this
  one action expresses every move and there is no need for `ACTION_MOVE_VIDEO_BEFORE` (which also
  works, with `movedSetVideoIdSuccessor`, but is redundant).
- **It persists.** Verified by reloading and reading the fresh server order: it matched, and the
  player agreed.
- **Nothing updates the local copy.** Unlike the harvested remove endpoint, a hand-built move carries
  no `clientActions`, and `getPlaylistData()` stayed stale for the full 15 s it was watched. So the
  move is followed by `yt-playlist-manager.setPlaylistData()` with the list reordered to match what
  we just asked the server for. End-to-end check: two moves (mid-list, and drag-to-front) applied
  instantly in the dock, and a fresh server read afterwards matched the optimistic order exactly.
- **Guard:** `setPlaylistData` updates the manager, never the player. If a player is currently driving
  this queue, strategy 2 refuses rather than let display and playback disagree. A player owning the
  queue implies a watch page rendered, which implies the panel exists — so in practice strategy 1
  covers that state and this is a backstop.

The index arithmetic: to land at final index `to`, the item must follow `without[to - 1]`, where
`without` is the list minus the item being moved. `to === 0` means no predecessor.

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

### Signed-in queues sometimes survive a reload — it depends on the session

Signed **out**, a hard reload always empties the queue (verified).

Signed **in** it is conditional, and the first pass over-read the evidence. A queue tied to an
**active watch session** does come back across a full page load — same `TLPQ` id, server-side. But a
queue built on a browse page with **nothing playing** was gone after a reload in a later test. The
honest statement is "often, not always", and the README says that rather than promising persistence.

Either way the conclusion for this script is the same, and it is the one that matters: **auto-restore
must not assume the queue is missing just because it is missing at boot.** YouTube's own restore can
land after we start, so replaying a snapshot on a timer would append the whole list a second time on
top of the one YouTube brought back. `maybeAutoRestore` therefore waits up to 6 s for a queue to
appear and only replays if none does. This is also why auto-restore stays off by default.

### Thumbnails steal the drag

A `<img>` is draggable by default (`-webkit-user-drag: auto`, `img.draggable === true`). The dock's
rows carry a 60×34 thumbnail, so a large share of each row's grab area started an **image drag**
instead of the row drag, and the row never moved. Together with the missing-panel gap above, this is
what "dragging isn't working very well" turned out to be — and unlike the panel gap, it applied on
*every* page, every time.

Fixed with both belts: `img.draggable = false` at construction and `-webkit-user-drag: none` in the
stylesheet. Any future non-text content dropped into a draggable row needs the same treatment.

The drop indicator also lied: it always drew the insertion line on the row's **top** edge, even when
dragging downward, where the item lands *below* the target. It now picks the edge from the drag
direction.

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
| Floating queue panel on every page | v0.3.0: a real window — see below |
| Running totals (count, total runtime, time left) | Both in the dock and injected into the native panel |
| One-click remove per row | Native endpoint, rebuild fallback |
| Drag reorder | Both panels |
| Always-visible native reorder handles | Pure CSS over a capability YouTube already had |
| Keep native panel expanded | |
| Hide YouTube's own queue panel (v0.2.0) | `display:none`, **never** removal — the panel staying in the DOM is what keeps the fast `handleDrop` reorder available. Verified: reorder still works, and the player stays in sync, while hidden |
| Move the panel anywhere; resize from 8 handles (v0.3.0) | Pointer events, not DnD — see below |
| Three window states: open / rolled up / pill (v0.3.0) | `dockState`, migrated from v0.2's `dockOpen` |
| Optional idle fade (v0.3.0) | Pure CSS `:hover`, off by default |
| Snapshot + restore after reload | One command; verified in exact order |
| Diagnostics | Reports which of the four primitives are live |

### The panel is a window (v0.3.0)

Three decisions worth not re-litigating.

**Two coordinate modes, and a one-way transition.** Until it is first touched the panel is *parked*:
CSS anchors it with `bottom: 16px` and `right`/`left: 16px`, so it stays in its corner when the
browser window changes size, which is the right default. But resize arithmetic against that anchor
is ambiguous — dragging the east edge rightwards cannot move an edge that is pinned to the right of
the viewport. So the first move or resize calls `pinPanel`, which measures where the panel actually
is and switches it to explicit `left`/`top` (`data-placed="1"`). Everything after that lives in one
plain left/top/width/height space. Double-clicking the title bar, or switching the parking side from
the menu, drops back to parked by nulling `dockX`/`dockY`.

**Pointer events, never HTML5 drag-and-drop.** The rows already use DnD to reorder. The two
mechanisms fight over the same gesture when they share a surface, and DnD additionally cannot report
a live position — you would get a drop point, not a drag. `setPointerCapture` is what keeps a drag
alive once the cursor crosses the video or one of YouTube's iframes; it is wrapped in `safe()`
because synthetic pointer events (tests) have no active pointer to capture.

**`dockH` is the LIST's height, not the panel's.** The CSS puts `--ytq-h` on `.ytq-list`, with the
head and foot outside it at fixed heights, so the two differ by a constant and the resize maths is
identical either way. The north and west handles adjust position *and* size together, so the edge
you are not dragging stays exactly where you put it.

`clampToViewport` keeps `KEEP_ON_SCREEN` (90px) of the panel reachable no matter where it was
dropped, and `reclampPlacement` re-runs it on `window.resize`, because a shrinking window can
otherwise strand a placed panel off the edge with no way to grab it back.

### Nothing is greyed out (v0.3.0)

v0.1.0 dimmed every row above `currentIndex` to 50% via a `.ytq-past` class. That encodes an
assumption the script has no business making: that a queue is played front to back, so anything
earlier has been watched. It hasn't, necessarily — people jump around their own queues. The class is
gone; only `.ytq-now` (the row that is actually playing) is marked.

Note that the footer's *"N after this · X left"* readout carries the same sequential assumption. It
was left alone on purpose — it is a statement about playing straight through from here, which is a
real thing to want to know, and unlike the dimming it doesn't make the other rows look spent.

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
| Queue across a full page load, signed in | ⚠️ persists when tied to an active watch session; **not** always — see above |

### v0.2.0 pass — 2026-08-30 (real account, after the first install)

Prompted by "dragging-to-reorder isn't working very well". Queue empty before and after.

| Check | Result |
| --- | --- |
| Dock thumbnails draggable by default | ❌ **confirmed the bug** — `img.draggable === true`, `-webkit-user-drag: auto` |
| Panel absent after queueing from a search page | ❌ **confirmed the bug** — `panelInDom: false`, so every v0.1.0 drag no-op'd |
| Panel present on a browse page *while the queue plays* | ✅ so the gap is "queued but never opened a video" |
| `ACTION_MOVE_VIDEO_AFTER` sends a request | ✅ (instrumented `fetch`; a control remove proved the instrumentation) |
| …and persists | ✅ fresh server read after reload matched; player agreed |
| …with no predecessor → moves to front | ✅ |
| `ACTION_MOVE_VIDEO_BEFORE` + successor | ✅ works too, but redundant |
| Client model refreshes itself after a move | ❌ **no** — stale for the full 15 s watched |
| `setPlaylistData` re-syncs the client model | ✅ |
| Strategy 2 end-to-end, no panel + no player | ✅ 2 moves applied instantly; fresh server read matched exactly |
| Reorder still works with the panel `display:none` | ✅ order correct, player in sync |
| Clear button present on `/feed/subscriptions` | ❌ panel in DOM but header not rendered — the `'partial'` fallback is what covers this |

### v0.3.0 pass — 2026-09-04 (local harness)

The window work touches none of the four primitives, so it was verified against a harness that stubs
`yt-playlist-manager.getPlaylistData()` with a ten-item `TLPQ` queue rather than against a live
account. `scratch/harness.html` (gitignored) is that harness; serve the repo root over HTTP and open
it. **Superseded by the v0.3.1 live pass below, which found one defect the harness could not see.**

| Check | Result |
| --- | --- |
| Title-bar drag, synthetic pointer events | ✅ landed exactly on target; `data-placed` flipped to 1 |
| Title-bar drag, real mouse across the whole viewport | ✅ pointer capture held; grab offset preserved |
| Resize `e` / `s` — opposite edge stays fixed | ✅ |
| Resize `w` / `n` — opposite edge stays fixed, panel moves | ✅ |
| Resize `se` / `nw` corners | ✅ both axes, anchor corner fixed |
| Geometry persists across the drag end | ✅ `dockX/Y/W/H` written on pointerup |
| Three states: open 552×595, shaded 552×**39**, pill 104×33 | ✅ |
| Pill click restores the *remembered* state (shaded, not open) | ✅ |
| Pill keeps its own position; panel's is untouched | ✅ |
| `Alt+Shift+Q` cycles pill ⇄ last open state | ✅ |
| Dropped far off bottom-right → clamped to 90px reachable | ✅ |
| Dropped far off top-left → right edge stays on screen | ✅ |
| Double-click title bar → parked, default size | ✅ |
| Header buttons do not start a panel move | ✅ no stuck `ytq-moving` |
| Row drag-to-reorder still fires; thumbnails still `draggable=false` | ✅ v0.2.0 fix intact |
| No `.ytq-past`; every row's `.ytq-meta` at opacity 1 | ✅ |
| v0.2 prefs (`dockOpen:false`, `dockHeight:512`) migrate | ✅ → `dockState:'pill'`, `dockH:512` |

### v0.3.1 pass — 2026-09-06 (real account, Edge on SylG5, live YouTube)

The live pass v0.3.0 never got. Signed in on the user's own account; **the queue was empty
throughout and was never touched**, and the 19-item saved snapshot was left intact — every check
below is either window geometry or read-only, and `snapshotQueue()`'s `if (!items.length) return`
guard is what makes that safe.

| Check | Result |
| --- | --- |
| Panel renders on live YouTube at v0.3.0 | ✅ `.ytq-dock` present, `z-index: 2300` |
| All 8 resize handles present with real hit-boxes | ✅ n/s/e/w 6px edges, corners 12–16px |
| Title-bar drag, **real mouse**, across the page | ✅ grab offset preserved to the pixel (74,19 in → 74,19 out) |
| Resize `e` — opposite edge fixed | ✅ w 342→442, left stayed 246 |
| Resize `n` — opposite edge fixed, panel moves | ✅ y 201→151, bottom stayed 594 |
| Resize `w` — opposite edge fixed, panel moves | ✅ x 246→196, right stayed 688 |
| Three states: open, shaded **39px**, pill 109×33 | ✅ matches the harness figures |
| Unshade restores the previous width/height | ✅ 492×443 both sides of the toggle |
| Pill keeps its own parked position; panel's untouched | ✅ pill at the corner, panel still remembered (196,151) |
| Pill click restores the remembered state *and* geometry | ✅ back to open at 196,151,492,443 |
| `Alt+Shift+Q` cycles pill ⇄ last open state | ✅ geometry preserved across the round trip |
| Double-click title bar → parked, fully on screen | ✅ `placed` 1→0, 16px margins |
| No stuck `ytq-moving` / `ytq-resizing` after any gesture | ✅ |
| No `.ytq-past` anywhere | ✅ 0 occurrences in source; only `.ytq-now` survives |

#### The defect the harness could not see

**Restoring a placed panel never reconciled its geometry with the current viewport.** Observed on
the very first open of the session, from the user's own persisted prefs: the panel came back at
(908, 668) at 342×419 in a 1149×940 viewport — **101px past the right edge, 147px past the bottom,
with the Discard button clipped at x=1152.** The user had done nothing but click the pill.

Reproduced deterministically: place the panel, grow it to 872px tall so its bottom hangs 113px below
the fold, reload → it renders in exactly that spot again, `fullyOnScreen: false`. Nothing pulls it
back.

Two causes, and the first one alone is not the whole story:

1. `reclampPlacement` was wired **only** to `window.resize`. Loading the page in a window smaller
   than the one the geometry was saved in fires no resize event at all, so nothing ran.
2. More importantly, running it would not have helped. Its guarantee is `clampToViewport`'s — that
   `KEEP_ON_SCREEN` (90px) stays grabbable — and for the observed case (y=668, viewport 940) that
   clamps `y` to `min(940-34, 668)` = **668, unchanged**. The panel would still have hung off the
   bottom. The reachability rule is the right rule for a panel the user *dropped* somewhere odd;
   it is the wrong rule for one restored from storage, which the user never positioned here at all.

Fixed in v0.3.1 by `fitPlacement()`: when the panel *fits* the viewport, seat it fully inside with
an `EDGE_GAP` margin; when it nearly fills it, seat it flush rather than giving up; when it
genuinely cannot fit, fall back to the old reachability guarantee. It runs inside
`reclampPlacement` — after the size clamps, since it positions against them — and
`reclampPlacement` is now also called once from `ensureDock`, when the panel is first built.

Checked against the measured numbers: the session-start failure (908,668) seats to (793,490); the
tall repro seats to y=52 (bottom 924); a panel taller than its viewport seats flush at y=0; **and a
panel that was already fully on screen does not move.** That last one is the point — this must not
relocate panels the user deliberately placed.

#### Harness notes for next time

- **Synthetic multi-hop drags under-travel.** Single `left_click_drag` calls landed pixel-exact, but
  three chained hops downward moved the panel ~83px out of an intended ~548. Trust single drags;
  verify positions by measurement, never by assuming the drop landed where it was aimed.
- **`window.__ytq` is not reachable from page context** — Tampermonkey sandboxes it away because of
  the `@grant`s. Driving prefs directly from a devtools/automation context is not available; go
  through the UI.
- **A maximized window ignores resize requests**, so "shrink the viewport" is not a usable way to
  reproduce stale-geometry bugs here. Growing the panel past the viewport with its own `s` handle
  is, and needs no window changes.

---

A note on session health: partway through testing, the signed-out session started returning `400`
from the queue APIs and *every* add failed, including ones that had worked minutes earlier. That was
YouTube throttling an anonymous session, not a script fault — a fresh load restored normal behaviour.
Worth remembering before chasing a phantom bug.

---

## Roadmap

- ~~**reorder without the native panel**~~ — done in v0.2.0 via `ACTION_MOVE_VIDEO_AFTER` +
  `setPlaylistData`. No primitive depends on `/watch` any more except as a preferred fast path.
- **v0.3 — decide the rebuild fallback's fate.** Now that the native remove endpoint is confirmed on
  every non-current row, the rebuild path may be dead weight. Keep it one more release, see whether
  the `'playing'` and `'error'` branches ever fire in practice, then consider dropping it.
- **v0.3 — reconsider the strategy-2 player guard.** It currently refuses whenever a player owns the
  queue, on the grounds that `setPlaylistData` cannot reach the player. If a player-side update turns
  out to be reachable (`updatePlaylist` is present on `#movie_player` but its signature is unknown),
  the guard could be lifted and strategy 2 would cover every state.
- **Save the queue as a playlist — there's a native button for it.** The queue panel's header
  carries a **Save** control alongside *Clear queue*. Almost certainly "save this queue as a real
  playlist"; harvesting that endpoint the same way we harvest remove is likely a small job.
- **Bulk actions.** "Queue everything in this row / this search / this playlist" — cheap now, since
  `videoIds` takes an array. Needs a UI that can't be fired by accident.
- **Shuffle / sort the queue**, and de-duplicate.
- **Watched markers** in the panel. Note this is *not* the dimming that v0.3.0 removed: a real
  watched marker would come from YouTube's own progress data, not from an item's position in the
  list.
- **Snap the panel to screen edges** while dragging, and remember a per-page-type position.
- **YouTube Music / `m.youtube.com`** — different app shells; out of scope until the desktop side is
  settled.
