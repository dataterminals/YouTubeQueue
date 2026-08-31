# YouTube Queue

A **Tampermonkey/Greasemonkey userscript** that makes YouTube's queue actually usable: add any video
to the queue from any view, and get a queue panel that follows you around the site.

> **Read-only where it counts.** The script drives YouTube's *own* queue commands — the same ones
> behind the native "Add to queue" menu item. It never touches credentials, never posts on your
> behalf, and never operates a control outside the queue.

---

## What it does

### Queue from anywhere

YouTube only gives you an "Add to queue" button on *some* thumbnails, in *some* layouts. This adds
three ways to queue anything, on every surface — home, search, channels, subscriptions, the watch
sidebar, playlist pages:

- **Hover button.** A `+ queue` button on every video thumbnail, plus a second **play next** button
  that drops the video in right after whatever is playing.
- **Shift-click.** Shift-click *any* video link and it queues instead of navigating. Works on
  surfaces that have no thumbnail at all — playlist rows, description links, comments.
  (Switchable to Alt-click or middle-click, or off.)
- **The `Q` key.** Point at a video, tap **`Q`** to queue it or **`Shift+Q`** to play it next.
  The fastest way to fling a dozen videos into the queue in a row.

### A queue panel that works everywhere

- **Floating panel on every page** (not just `/watch`), so you can see and manage the queue while you
  keep browsing. Toggle it with **`Alt+Shift+Q`**, collapse it to a small pill, drag its top edge to
  resize, and put it on whichever side you like.
- **Running totals.** How many are queued, the total runtime, and how much is left after the current
  video — in both the floating panel and YouTube's own sidebar panel.
- **One-click remove** on every row, and **drag to reorder**.
- **Reorder handles that are actually visible.** YouTube's queue has always been drag-reorderable;
  it just hides the handle until you happen to hover the exact right pixel. This keeps it on.
- **Keeps the native panel expanded** instead of letting it collapse on you.

### Survive a reload

Closing the tab or hard-navigating normally throws your queue away. This keeps a rolling snapshot of
it, and when you come back to an empty queue it offers a **Restore** button. One click puts the whole
list back, in order. (There's an auto-restore option too, off by default — see below.)

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge/Firefox/Safari) or Greasemonkey.
2. Open the raw script and Tampermonkey will offer to install it:
   [`src/youtube-queue.user.js`](src/youtube-queue.user.js) →
   [raw install link](https://raw.githubusercontent.com/dataterminals/YouTubeQueue/main/src/youtube-queue.user.js).
3. Visit [youtube.com](https://www.youtube.com/) and hover any thumbnail.

Because `@downloadURL`/`@updateURL` point at this repo's `main`, Tampermonkey will auto-update the
script when a new `@version` is pushed.

## Keys and controls

| Action | How |
| --- | --- |
| Queue the hovered video | **`Q`** |
| Play the hovered video next | **`Shift+Q`** |
| Queue any video link | **Shift-click** it |
| Show/hide the floating panel | **`Alt+Shift+Q`** |
| Queue / play next from a thumbnail | Hover it, click the button that appears (top-left) |
| Resize the panel | Drag its top edge |
| Reorder | Drag a row, in either the floating panel or YouTube's own |

Everything is toggleable from the Tampermonkey tray menu → **YouTube Queue**: the thumbnail buttons,
the play-next button, which modifier queues on click, the `Q` hotkey, the floating panel and its
side, keeping the native panel expanded, always-visible reorder handles, whether queueing pops the
miniplayer, and auto-restore. Settings persist via `GM_setValue` (or `localStorage` as a fallback) —
UI preferences and a list of video IDs only, nothing sensitive.

## Two things worth knowing

- **Auto-restore is off by default,** and deliberately. Restoring fires a real request to build the
  queue; doing that silently on every single page load is obnoxious. By default you get a *Restore*
  button when there's something to restore. Turn on auto-restore in the menu if you'd rather.
  Worth knowing: **while you're signed in, YouTube already restores your queue across a page reload**
  by itself (verified). The snapshot is a safety net for when it doesn't — a cleared queue, a signed-
  out session, a long gap — rather than the primary mechanism.
- **Reordering needs YouTube's queue panel to have loaded.** That panel lives on `/watch` and sticks
  around as you navigate away from it, so on a *cold* load of the home page reordering is unavailable
  until you've opened a video once; the script says so rather than failing quietly. **Adding and
  removing work everywhere, always.**
- **The video that's currently playing can't be removed from the queue.** That's YouTube's own rule —
  it's the one row it gives no remove action to. Skip past it first. The script tells you this instead
  of pretending to fail.

## How it works

The script doesn't maintain its own list or scrape anything — it drives YouTube's own machinery:

| What | Mechanism |
| --- | --- |
| Add to queue | `ytd-app.resolveCommand()` with an `addToPlaylistCommand`, rebuilt from a bare video ID. Takes an *array*, so a whole queue is restored in one request. |
| Read the queue | `yt-playlist-manager.getPlaylistData()` — answers on every page type, which is what lets the floating panel exist off `/watch`. |
| Reorder / play next | Move the row's DOM node, then call the panel's own `handleDrop()`, which syncs YouTube's internal queue proxy. No network, no auth. |
| Remove | The row's own remove endpoint, harvested at runtime from the queue data and matched by *icon type* — YouTube labels it "Remove from playlist", and that wording is translated. |

A YouTube queue is really a throwaway server-side playlist whose ID starts with `TLPQ`. The script
only ever touches those — if you're playing a real saved playlist, it keeps its hands off.

Run **🩺 Diagnostics** from the Tampermonkey menu to print exactly which of those four paths are live
on the current page. That's the fastest way to tell "YouTube changed something" from "this is a bug".

## Compatibility

- Scoped to `https://www.youtube.com/*`. YouTube Music and `m.youtube.com` aren't matched.
- All four paths — add, read, reorder, remove — plus restore were verified against live YouTube on
  **2026-08-30**, signed out *and* signed in. If something misbehaves, run Diagnostics and
  [open an issue](https://github.com/dataterminals/YouTubeQueue/issues) with the output.
- YouTube is mid-migration from `ytd-*-renderer` elements to `yt-lockup-view-model`. Rather than
  chase that with a selector list, thumbnails are found structurally (a link that resolves to a video
  ID *and* contains an image), which covers both generations and whatever comes next.

## License

MIT — see [LICENSE](LICENSE).
