// ==UserScript==
// @name         YouTube Queue
// @namespace    https://github.com/dataterminals/YouTubeQueue
// @version      0.1.0
// @description  Queue any video from any view — hover button, Shift-click, or the Q key — plus a queue panel that works on every page: running totals, one-click remove, drag reorder, and restore-after-reload.
// @author       dataterminals
// @homepageURL  https://github.com/dataterminals/YouTubeQueue
// @supportURL   https://github.com/dataterminals/YouTubeQueue/issues
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/dataterminals/YouTubeQueue/main/src/youtube-queue.user.js
// @updateURL    https://raw.githubusercontent.com/dataterminals/YouTubeQueue/main/src/youtube-queue.user.js
// @noframes
// ==/UserScript==
//
// DESIGN NOTES (for the next maintainer — human or Claude):
//
//   This script drives YouTube's OWN queue machinery. It does not maintain a parallel list and it
//   does not re-implement anything the site already does. Everything below was probed against live
//   youtube.com (2026-08-30) before being written down; the "verified" markers matter, because
//   YouTube's internals are minified and undocumented and the next person will want to know which
//   parts are load-bearing observation and which are inference.
//
//   THE FOUR PRIMITIVES
//
//   1. ADD  (verified).  YouTube's native "Add to queue" menu item carries a `signalServiceEndpoint`
//      whose single action is an `addToPlaylistCommand`. That command is entirely reconstructible
//      from a bare videoId — the `clickTrackingParams` in the native one are telemetry, not auth —
//      so we can queue ANY video from ANY page without opening a menu:
//
//          ytdApp.resolveCommand({ signalServiceEndpoint: { signal: 'CLIENT_SIGNAL',
//              actions: [{ addToPlaylistCommand: { videoId, videoIds: [...],
//                          listType: 'PLAYLIST_EDIT_LIST_TYPE_QUEUE', onCreateListCommand: {...} } }] } })
//
//      `videoIds` accepts an ARRAY and appends all of them, in order, in one round trip. That single
//      fact is what makes bulk-queueing and restore-after-reload cheap (one command, not N).
//      A YouTube queue is a real, server-side, throwaway playlist whose id starts with `TLPQ`.
//      `openMiniplayer:false` is verified safe — the create path, single appends and multi-appends
//      all still land, and the miniplayer stays shut. That is why it is the default: queueing from
//      the home page should not hijack the corner of the screen.
//
//   2. READ  (verified).  `yt-playlist-manager.getPlaylistData()` returns the live queue —
//      `{title, contents:[{playlistPanelVideoRenderer}], currentIndex, playlistId, totalVideos}` —
//      and it answers on EVERY page type, not just /watch. That is what lets the dock exist on the
//      home page, search, channels, and so on. `#movie_player.getPlaylist()/getPlaylistIndex()` is
//      a second, player-side view of the same list; we use it only as a fallback.
//
//   3. REORDER  (verified).  The panel's Polymer controller has `handleDrop({currDragItem: rowEl})`,
//      which reads the row's CURRENT position among its DOM siblings and syncs that order into
//      YouTube's internal queue proxy. So a reorder is: physically move the row node, then call
//      handleDrop. No endpoint, no auth, no network — and the player's own `getPlaylist()` reflects
//      the new order immediately. `computeCanReorder` returns true unconditionally for any `TLPQ`
//      playlist, so this is never gated. PLAY-NEXT is built on top: append, then move to index+1.
//      Caveat: this needs `ytd-playlist-panel-renderer#playlist` in the DOM. It is there on /watch
//      and it survives SPA navigation away from /watch — but on a COLD load of a browse page it is
//      absent, so reorder degrades to unavailable there and says so (see `moveItem`).
//
//   4. REMOVE  (verified signed-in, 2026-08-30).  Each queue row carries a menu whose remove item
//      has `icon.iconType === 'DELETE'` (its LABEL is "Remove from playlist", which is why we match
//      on icon and never on text). We harvest that row's own `serviceEndpoint` and fire it:
//
//          { commandMetadata: { webCommandMetadata: { sendPost: true,
//                               apiUrl: '/youtubei/v1/browse/edit_playlist' } },
//            playlistEditEndpoint: { playlistId: 'TLPQ…', params: 'CAE%3D',
//              actions: [{ setVideoId: '<playlistSetVideoId>', action: 'ACTION_REMOVE_VIDEO' }],
//              clientActions: [{ playlistRemoveVideosAction: { setVideoIds: ['<same>'] } }] } }
//
//      Note the `params` and `clientActions` — an earlier hand-built `playlistEditEndpoint` WITHOUT
//      them was silently swallowed by resolveCommand (no request at all), which is exactly why this
//      harvests the whole endpoint verbatim instead of reconstructing it.
//
//      TWO RULES discovered by testing, both load-bearing:
//        a) The menu rides along in `getPlaylistData()`, NOT only in the /watch panel — so removing
//           works on every page. Do not source it from `panelRows()`; that was the first draft's
//           bug and it made remove silently unavailable everywhere except /watch.
//        b) EVERY row has a remove action EXCEPT the one currently playing (`selected: true`), which
//           has no menu at all. That is YouTube's own rule, verified across a 4-item queue. So
//           "remove the playing item" is reported honestly rather than pushed into the rebuild path.
//
//      The REBUILD fallback (clear, then re-create from the remaining ids) survives for the case
//      where YouTube offers no endpoint at all. It restarts playback, so it stays behind a confirm.
//      `Diagnostics` reports which path is live.
//
//   TWO THINGS LIVE TESTING TAUGHT US (do not regress these)
//
//   * TRUSTED TYPES.  youtube.com ships `require-trusted-types-for 'script'`, so ANY `innerHTML`
//     assignment throws `TypeError: This document requires 'TrustedHTML' assignment` and kills the
//     feature outright. Every node here is therefore built with createElement/createElementNS and
//     filled with textContent. Do not reintroduce innerHTML, even for a "safe" constant string.
//     A pleasant side effect: user-controlled text (titles, channel names) never touches an HTML
//     parser, so there is no escaping to get wrong.
//
//   * LIVESTREAM DURATIONS ARE NOT DURATIONS.  A long-running live stream reports `lengthText` as
//     its elapsed time — real observed values include "20,843:43:51" and "33,778:11:52" — and it
//     does NOT always carry a LIVE badge. Naive parsing poisons every total on the panel. Duration
//     parsing therefore rejects: a missing lengthText, a LIVE badge, and anything over 24 hours.
//     Items that fail are counted separately as "unknown", never silently as zero.
//
//   HOUSE RULES
//
//   * Fail safe. Every reach into YouTube's internals is wrapped — a renamed element or a missing
//     method must make a feature quietly no-op, never throw into the page or break the site.
//   * We never fabricate queue state. The dock is a VIEW over `getPlaylistData()`; if YouTube says
//     the queue is empty, the dock says the queue is empty.
//   * We only touch throwaway `TLPQ` queues. If the user is playing a real playlist, we keep our
//     hands off it — no Clear, no reorder, no remove.
//   * Only non-sensitive UI prefs and a list of videoIds are persisted (`ytq_prefs_v1`,
//     `ytq_snapshot_v1`). No credentials, no tokens, no account data.
//   * Restore is opt-in per use: a snapshot never replays itself unless auto-restore is on, because
//     silently firing a playlist/create on every page load is rude.
//
//   ROADMAP lives in docs/BRIEF.md.

(function () {
  'use strict';

  // ===========================================================================
  // Preferences. GM storage when available, localStorage otherwise. UI only.
  // ===========================================================================
  const STORE_KEY = 'ytq_prefs_v1';
  const SNAP_KEY = 'ytq_snapshot_v1';

  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  const DEFAULTS = {
    hoverButtons: true,     // inject +queue / play-next buttons onto thumbnails
    hoverPlayNext: true,    // show the second (play-next) hover button
    clickModifier: 'shift', // 'shift' | 'alt' | 'middle' | 'off'
    hotkeys: true,          // Q / Shift+Q on the hovered video
    dock: true,             // floating queue panel on every page
    dockOpen: true,         // dock starts expanded rather than as a pill
    dockSide: 'right',      // 'right' | 'left' — left overlaps the guide rail on browse pages
    dockHeight: 330,        // px, drag-resizable
    panelTotals: true,      // totals line injected into YouTube's native queue panel
    panelKeepOpen: true,    // re-expand the native panel if YouTube collapses it
    panelHandles: true,     // keep the native drag handles permanently visible
    panelMaxHeight: 480,    // px, native panel scroll area
    openMiniplayer: false,  // let a queue-add pop YouTube's miniplayer
    autoRestore: false,     // replay the saved queue automatically on a cold load
  };

  function readPrefs() {
    let raw = null;
    try {
      raw = hasGM ? GM_getValue(STORE_KEY, null) : localStorage.getItem(STORE_KEY);
    } catch (e) { /* storage blocked — fall through to defaults */ }
    let parsed = {};
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch (e) { parsed = {}; }
    return Object.assign({}, DEFAULTS, parsed && typeof parsed === 'object' ? parsed : {});
  }

  function writePrefs(p) {
    try {
      const s = JSON.stringify(p);
      if (hasGM) GM_setValue(STORE_KEY, s); else localStorage.setItem(STORE_KEY, s);
    } catch (e) { /* non-fatal: prefs just won't persist */ }
  }

  const prefs = readPrefs();
  function setPref(k, v) { prefs[k] = v; writePrefs(prefs); }

  function readSnapshot() {
    let raw = null;
    try {
      raw = hasGM ? GM_getValue(SNAP_KEY, null) : localStorage.getItem(SNAP_KEY);
    } catch (e) { return null; }
    try {
      const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return s && Array.isArray(s.ids) && s.ids.length ? s : null;
    } catch (e) { return null; }
  }

  function writeSnapshot(s) {
    try {
      const str = JSON.stringify(s);
      if (hasGM) GM_setValue(SNAP_KEY, str); else localStorage.setItem(SNAP_KEY, str);
    } catch (e) { /* non-fatal */ }
  }

  // ===========================================================================
  // Small helpers.
  // ===========================================================================
  const log = (...a) => console.log('%c[yt-queue]', 'color:#3ea6ff', ...a);
  const warn = (...a) => console.warn('[yt-queue]', ...a);

  /** Run fn, swallow anything it throws. YouTube internals must never break the page. */
  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  /** Element factory. textContent only — see the Trusted Types note above. */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgIcon(pathData, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 18));
    svg.setAttribute('height', String(size || 18));
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('fill', 'currentColor');
    p.setAttribute('d', pathData);
    svg.appendChild(p);
    return svg;
  }

  const D_QUEUE = 'M3 6h13v2H3V6zm0 4h13v2H3v-2zm0 4h9v2H3v-2zm15-8v5h-3l4 4 4-4h-3V6h-2z';
  const D_NEXT = 'M4 6h10v2H4V6zm0 4h10v2H4v-2zm0 4h7v2H4v-2zm12-8l6 5-6 5V6z';

  /**
   * Parse a YouTube duration string to seconds, or null when it isn't a real duration.
   *
   * Rejects anything over MAX_SANE_DURATION. Long-running livestreams report elapsed time in
   * `lengthText` (observed: "20,843:43:51") and do not reliably carry a LIVE badge, so a plain
   * parse would add thousands of hours to the queue total. A genuine video longer than a day is
   * rare enough that treating it as "unknown" is the right trade.
   */
  const MAX_SANE_DURATION = 24 * 3600;
  function toSeconds(text) {
    if (!text || typeof text !== 'string') return null;
    const cleaned = text.replace(/[,\s ]/g, '');
    if (!/^\d+(:\d{1,2}){1,2}$/.test(cleaned)) return null;
    const parts = cleaned.split(':');
    let total = 0;
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isFinite(n)) return null;
      total = total * 60 + n;
    }
    return total > MAX_SANE_DURATION ? null : total;
  }

  /** 3723 -> "1:02:03" */
  function clock(s) {
    if (s == null) return '—';
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(sec).padStart(2, '0');
  }

  /** 3723 -> "1 hr 2 min" — for readouts where second-precision is noise. */
  function human(s) {
    if (s == null) return '—';
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    if (h && m) return `${h} hr ${m} min`;
    if (h) return `${h} hr`;
    return `${Math.max(1, m)} min`;
  }

  function ago(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 172800) return Math.round(s / 3600) + ' hr ago';
    return Math.round(s / 86400) + ' days ago';
  }

  function debounceRaf(fn) {
    let queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; safe(fn); });
    };
  }

  /** Poll until `test()` is true or we give up. Resolves true/false. */
  function waitFor(test, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      (function tick() {
        if (safe(test, false)) return resolve(true);
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(tick, 120);
      })();
    });
  }

  // ===========================================================================
  // The YouTube bridge. Every reach into the site's internals goes through here,
  // so there is exactly one place to fix when YouTube renames something.
  // ===========================================================================
  const YT = {
    app: () => document.querySelector('ytd-app'),
    manager: () => document.querySelector('yt-playlist-manager'),
    player: () => document.querySelector('#movie_player'),
    /** YouTube's native queue panel. Present on /watch, and survives SPA nav away from it. */
    panel: () => document.querySelector('ytd-playlist-panel-renderer#playlist'),
    panelRows: () => {
      const p = YT.panel();
      return p ? Array.from(p.querySelectorAll('ytd-playlist-panel-video-renderer')) : [];
    },
    /** Polymer elements expose their renderer payload as `.__data.data` (older builds: `.data`). */
    dataOf: (node) => safe(() => (node && (node.__data?.data ?? node.data)) || null, null),

    /** The live queue, readable from any page type. Null when there is no queue. */
    playlistData() {
      const m = YT.manager();
      if (!m || typeof m.getPlaylistData !== 'function') return null;
      const d = safe(() => m.getPlaylistData(), null);
      if (!d || !Array.isArray(d.contents)) return null;
      // Only throwaway `TLPQ…` playlists count as "the queue". A real playlist being played is the
      // user's, not ours — we must never offer to Clear or reorder someone's saved playlist.
      if (typeof d.playlistId === 'string' && !d.playlistId.startsWith('TLPQ')) return null;
      return d;
    },

    /** Normalized queue items. [] when there is no queue. */
    items() {
      const d = YT.playlistData();
      if (!d) return [];
      const out = [];
      d.contents.forEach((c, i) => {
        const r = c && c.playlistPanelVideoRenderer;
        if (!r || !r.videoId) return;
        const badges = (r.badges || []).map((b) => safe(() => b[Object.keys(b)[0]].style, '') || '');
        const isLive = badges.some((s) => /LIVE/.test(s));
        const durText = r.lengthText?.simpleText || null;
        const duration = isLive ? null : toSeconds(durText);
        out.push({
          index: i,
          videoId: r.videoId,
          title: r.title?.simpleText || r.title?.runs?.[0]?.text || r.videoId,
          author: r.shortBylineText?.runs?.[0]?.text || r.longBylineText?.runs?.[0]?.text || '',
          // Show "LIVE" rather than an elapsed-time string masquerading as a runtime.
          durationText: duration == null ? (isLive || durText ? 'LIVE' : null) : durText,
          duration,
          setId: r.playlistSetVideoId || null,
          selected: !!r.selected,
          thumb: r.thumbnail?.thumbnails?.[0]?.url || null,
          endpoint: r.navigationEndpoint || null,
        });
      });
      return out;
    },

    currentIndex() {
      const d = YT.playlistData();
      if (d && Number.isFinite(d.currentIndex)) return d.currentIndex;
      const idx = safe(() => YT.player()?.getPlaylistIndex?.(), null);
      return Number.isFinite(idx) ? idx : 0;
    },

    resolve(cmd) {
      const app = YT.app();
      if (!app || typeof app.resolveCommand !== 'function') return false;
      try { app.resolveCommand(cmd); return true; } catch (e) { warn('resolveCommand failed', e); return false; }
    },
  };

  /** Totals for a queue, keeping "unknown" honest rather than folding it into zero. */
  function totals(items, current) {
    const known = items.filter((i) => i.duration != null);
    const rest = items.slice(Math.max(0, current));
    return {
      total: known.reduce((a, i) => a + i.duration, 0),
      left: rest.filter((i) => i.duration != null).reduce((a, i) => a + i.duration, 0),
      unknown: items.length - known.length,
    };
  }

  // ===========================================================================
  // Queue operations.
  // ===========================================================================

  /**
   * Build the `addToPlaylistCommand` envelope. `ids` may hold one id or many; many are appended in
   * order by a single command. `onCreateListCommand` is the branch YouTube takes when no queue
   * exists yet (it POSTs /playlist/create); when a queue already exists it is ignored and the ids
   * are appended to the existing TLPQ playlist.
   */
  function addCommand(ids) {
    return {
      clickTrackingParams: '',
      commandMetadata: { webCommandMetadata: { sendPost: true } },
      signalServiceEndpoint: {
        signal: 'CLIENT_SIGNAL',
        actions: [{
          addToPlaylistCommand: {
            openMiniplayer: !!prefs.openMiniplayer,
            videoId: ids[0],
            listType: 'PLAYLIST_EDIT_LIST_TYPE_QUEUE',
            onCreateListCommand: {
              commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl: '/youtubei/v1/playlist/create' } },
              createPlaylistServiceEndpoint: { videoIds: ids.slice(), params: 'CAQ%3D' },
            },
            videoIds: ids.slice(),
          },
        }],
      },
    };
  }

  function addToQueue(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (!list.length) return false;
    return YT.resolve(addCommand(list));
  }

  /**
   * Move a queue row. Implemented as "put the DOM node where it belongs, then let YouTube's own
   * drop handler sync its internal queue proxy" — see DESIGN NOTES #3. Returns a status string so
   * callers can explain themselves rather than failing silently.
   */
  function moveItem(from, to) {
    const panel = YT.panel();
    const ctrl = panel && panel.polymerController;
    if (!ctrl || typeof ctrl.handleDrop !== 'function') return 'no-panel';

    const rows = YT.panelRows();
    if (!rows[from] || from === to) return 'noop';
    to = Math.max(0, Math.min(to, rows.length - 1));

    const node = rows[from];
    const parent = node.parentNode;
    if (!parent) return 'no-panel';

    // Target position is computed against the siblings AFTER `node` is taken out of the running.
    const others = rows.filter((_, i) => i !== from);
    const ref = others[to] || null;
    try {
      parent.insertBefore(node, ref);
      ctrl.handleDrop({ currDragItem: node });
      return 'ok';
    } catch (e) {
      warn('moveItem failed', e);
      return 'error';
    }
  }

  /** Append, then slot the new arrival directly after whatever is playing. */
  function playNext(videoId) {
    const had = YT.items().length;
    if (!addToQueue([videoId])) return Promise.resolve('error');
    if (!had) return Promise.resolve('ok'); // empty queue: "next" and "end" are the same place

    // The append is async (a /next round trip), so wait for the row to actually arrive.
    return waitFor(() => YT.items().length > had, 4000).then((arrived) => {
      if (!arrived) return 'queued-at-end';
      const items = YT.items();
      return moveItem(items.length - 1, YT.currentIndex() + 1) === 'ok' ? 'ok' : 'queued-at-end';
    });
  }

  /**
   * The row's own "remove" endpoint, or null. Sourced from `getPlaylistData()` rather than the
   * /watch panel so it resolves on every page (DESIGN NOTES #4a), and matched by ICON TYPE rather
   * than label text — YouTube labels it "Remove from playlist" and that wording is translated.
   */
  function removeEndpointFor(index) {
    const r = YT.playlistData()?.contents?.[index]?.playlistPanelVideoRenderer;
    for (const entry of r?.menu?.menuRenderer?.items || []) {
      const m = entry && entry[Object.keys(entry)[0]];
      if (/REMOVE|DELETE|TRASH/.test(m?.icon?.iconType || '') && m.serviceEndpoint) return m.serviceEndpoint;
    }
    return null;
  }

  /**
   * Remove one row. Returns a status string so callers can explain themselves:
   *   'ok' | 'playing' (YouTube offers no remove for the current item) | 'rebuilt' | 'cancelled' | 'error'
   */
  function removeAt(index) {
    const ep = removeEndpointFor(index);
    if (ep) return YT.resolve(ep) ? 'ok' : 'error';

    const items = YT.items();
    if (!items[index]) return 'error';

    // Every row has a remove action except the one playing — that one simply has no menu.
    if (items[index].selected || index === YT.currentIndex()) return 'playing';

    const remaining = items.filter((_, i) => i !== index).map((it) => it.videoId);
    if (!remaining.length) { clearQueue(); return 'ok'; }

    const ok = window.confirm(
      'YouTube didn’t offer a "remove from queue" action for this row.\n\n' +
      'YouTube Queue can rebuild the queue without it, but that restarts whatever is playing.\n\n' +
      'Rebuild the queue?'
    );
    if (!ok) return 'cancelled';

    clearQueue();
    setTimeout(() => addToQueue(remaining), 400);
    return 'rebuilt';
  }

  /**
   * Clear the queue. Returns 'ok' | 'partial' | 'unavailable'.
   *
   * The native Clear control is the only thing that removes EVERYTHING, and it exists only where the
   * panel does. `#movie_player.clearQueue()` looks like the obvious fallback and is a no-op — it is
   * present, it is a function, and calling it changes nothing (verified). So off /watch we do the
   * next best thing: fire each row's own remove endpoint, which clears everything but the item
   * currently playing. Staggered because each is a server round trip; `setVideoId`s are stable
   * identifiers rather than indices, so they stay valid as the list shrinks.
   */
  function clearQueue() {
    const panel = YT.panel();
    const btn = panel && panel.querySelector('button[aria-label="Clear queue"]');
    if (btn) { safe(() => btn.click()); return 'ok'; }

    const count = YT.playlistData()?.contents?.length || 0;
    const endpoints = [];
    for (let i = 0; i < count; i++) {
      const ep = removeEndpointFor(i);
      if (ep) endpoints.push(ep);
    }
    if (!endpoints.length) return 'unavailable';
    endpoints.forEach((ep, k) => setTimeout(() => YT.resolve(ep), k * 350));
    return 'partial';
  }

  function jumpTo(index) {
    const it = YT.items()[index];
    if (!it) return false;
    if (it.endpoint) return YT.resolve(it.endpoint);
    return YT.resolve({
      commandMetadata: { webCommandMetadata: { url: '/watch?v=' + it.videoId, webPageType: 'WEB_PAGE_TYPE_WATCH' } },
      watchEndpoint: { videoId: it.videoId },
    });
  }

  // ===========================================================================
  // Turning any bit of page into a videoId.
  // ===========================================================================
  function videoIdFromHref(href) {
    if (!href) return null;
    let u;
    try { u = new URL(href, location.origin); } catch (e) { return null; }
    if (u.hostname && !/(^|\.)youtube\.com$/.test(u.hostname) && u.hostname !== 'youtu.be') return null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{6,})/);
    if (m) return m[1];
    if (u.hostname === 'youtu.be') return u.pathname.replace(/^\//, '') || null;
    return null;
  }

  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-playlist-video-renderer',
    'ytd-reel-item-renderer',
    'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model',
  ].join(',');

  // Places we must never decorate: the queue panel itself, our own dock, the miniplayer.
  const NO_TOUCH = 'ytd-playlist-panel-video-renderer, .ytq-dock, ytd-miniplayer';

  /** The videoId for a card, given any element inside it. */
  function videoIdNear(node) {
    if (!node || !node.closest) return null;
    const a = node.closest('a[href]');
    const direct = a && videoIdFromHref(a.getAttribute('href'));
    if (direct) return direct;
    const card = node.closest(CARD_SELECTOR);
    if (card) {
      const d = YT.dataOf(card);
      if (d && d.videoId) return d.videoId;
      const link = card.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
      if (link) return videoIdFromHref(link.getAttribute('href'));
    }
    return null;
  }

  // ===========================================================================
  // Hover buttons on thumbnails.
  //
  // Rather than enumerate every renderer YouTube has ever shipped (a losing game — they are
  // mid-migration from `ytd-*-renderer` to `yt-lockup-view-model`), we find THUMBNAIL ANCHORS
  // structurally: an <a> that resolves to a videoId AND contains an image. A card's title link has
  // no image, so this lands exactly one button per card with no per-surface selector list to
  // maintain. Verified live: 1 anchor per card, 0 duplicates, 0 bleed into the queue panel.
  // ===========================================================================
  function thumbnailAnchors(root) {
    const scope = root && root.querySelectorAll ? root : document;
    let anchors;
    try { anchors = scope.querySelectorAll('a[href]'); } catch (e) { return []; }
    const out = [];
    for (const a of anchors) {
      // Re-decorate anchors YouTube recycled and stripped our node from.
      if (a.dataset.ytqHost && a.querySelector(':scope > .ytq-hover')) continue;
      if (!videoIdFromHref(a.getAttribute('href'))) continue;
      if (!a.querySelector('img, yt-image, ytd-thumbnail')) continue;
      if (a.closest(NO_TOUCH)) continue;
      out.push(a);
    }
    return out;
  }

  function decorate(anchor) {
    anchor.dataset.ytqHost = '1';
    anchor.classList.add('ytq-host');

    const wrap = el('div', 'ytq-hover');
    wrap.appendChild(makeHoverButton('add', 'Add to queue', D_QUEUE));
    if (prefs.hoverPlayNext) wrap.appendChild(makeHoverButton('next', 'Play next', D_NEXT));
    anchor.appendChild(wrap);
  }

  function undecorateAll() {
    document.querySelectorAll('.ytq-hover').forEach((n) => {
      const host = n.parentElement;
      n.remove();
      if (host) { delete host.dataset.ytqHost; host.classList.remove('ytq-host'); }
    });
  }

  function makeHoverButton(kind, label, pathData) {
    const b = el('button', 'ytq-btn');
    b.type = 'button';
    b.dataset.ytqAction = kind;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(svgIcon(pathData));
    // Capture phase: the button lives inside an <a>, so the click must be stopped before YouTube's
    // own delegated navigation handler ever sees it.
    b.addEventListener('click', onHoverButtonClick, true);
    b.addEventListener('auxclick', swallow, true);
    b.addEventListener('mousedown', swallow, true);
    return b;
  }

  function swallow(e) { e.preventDefault(); e.stopPropagation(); }

  function onHoverButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const btn = e.currentTarget;
    const id = videoIdNear(btn);
    if (!id) { toast('Couldn’t work out which video that is'); return; }

    if (btn.dataset.ytqAction === 'next') {
      flash(btn);
      playNext(id).then((status) => toast(
        status === 'queued-at-end' ? 'Added to the end (couldn’t reorder from this page)' : 'Playing next'
      ));
    } else if (addToQueue([id])) {
      flash(btn);
      toast('Added to queue');
    } else {
      toast('Couldn’t reach YouTube’s queue');
    }
  }

  function flash(btn) {
    btn.classList.add('ytq-flash');
    setTimeout(() => btn.classList.remove('ytq-flash'), 600);
  }

  // ===========================================================================
  // Modifier-click: queue any video link anywhere, including link-only surfaces
  // (playlist rows, comments, descriptions, the sidebar).
  // ===========================================================================
  function modifierMatches(e) {
    switch (prefs.clickModifier) {
      case 'shift': return e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
      case 'alt': return e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey;
      case 'middle': return e.type === 'auxclick' && e.button === 1;
      default: return false;
    }
  }

  function onDocumentClick(e) {
    if (prefs.clickModifier === 'off') return;
    if ((prefs.clickModifier === 'middle') !== (e.type === 'auxclick')) return;
    if (!modifierMatches(e)) return;
    if (e.target.closest && e.target.closest('.ytq-dock')) return;

    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const id = videoIdFromHref(a.getAttribute('href'));
    if (!id) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    toast(addToQueue([id]) ? 'Added to queue' : 'Couldn’t reach YouTube’s queue');
  }

  // ===========================================================================
  // Hotkeys. Q queues whatever is under the cursor; Shift+Q plays it next.
  // ===========================================================================
  let hoveredEl = null;
  function onMouseOver(e) { hoveredEl = e.target; }

  function typingInto(node) {
    if (!node) return false;
    if (node.isContentEditable) return true;
    const tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey) return;
    if (typingInto(document.activeElement) || typingInto(e.target)) return;
    const key = (e.key || '').toLowerCase();
    if (key !== 'q') return;

    // Alt+Shift+Q toggles the dock. Deliberately not a bare key: it is a global action and must
    // work with nothing hovered.
    if (e.altKey && e.shiftKey) {
      e.preventDefault();
      if (!prefs.dock) setPref('dock', true);
      setPref('dockOpen', !prefs.dockOpen);
      renderDock(true);
      return;
    }
    if (!prefs.hotkeys || e.altKey) return;

    const id = videoIdNear(hoveredEl);
    if (!id) { toast('Point at a video first'); return; }
    e.preventDefault();
    e.stopPropagation();

    if (e.shiftKey) {
      playNext(id).then((s) => toast(s === 'queued-at-end' ? 'Added to the end' : 'Playing next'));
    } else {
      toast(addToQueue([id]) ? 'Added to queue' : 'Couldn’t reach YouTube’s queue');
    }
  }

  // ===========================================================================
  // Toast.
  // ===========================================================================
  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!document.body) return;
    if (!toastEl || !toastEl.isConnected) {
      toastEl = el('div', 'ytq-toast');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('ytq-toast-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('ytq-toast-on'), 2200);
  }

  // ===========================================================================
  // The dock — a queue panel that exists on every page, not just /watch.
  // ===========================================================================
  let dockEl = null;
  let lastSignature = '';

  function ensureDock() {
    if (dockEl && dockEl.isConnected) return dockEl;
    if (!document.body) return null;

    dockEl = el('div', 'ytq-dock');
    dockEl.appendChild(el('div', 'ytq-grip')).title = 'Drag to resize';

    const head = el('div', 'ytq-head');
    head.appendChild(el('span', 'ytq-h-title', 'Queue'));
    head.appendChild(el('span', 'ytq-h-count'));
    head.appendChild(el('span', 'ytq-h-spacer'));
    head.appendChild(headButton('clear', 'Clear', 'Clear the queue'));
    head.appendChild(headButton('collapse', '▾', 'Collapse'));
    dockEl.appendChild(head);

    dockEl.appendChild(el('ol', 'ytq-list'));
    dockEl.appendChild(el('div', 'ytq-foot'));

    const pill = el('button', 'ytq-pill');
    pill.type = 'button';
    pill.title = 'Show queue (Alt+Shift+Q)';
    pill.addEventListener('click', () => { setPref('dockOpen', true); renderDock(true); });
    dockEl.appendChild(pill);

    dockEl.addEventListener('click', onDockClick);
    wireResize(dockEl);
    wireDockDrag(dockEl);
    document.body.appendChild(dockEl);
    return dockEl;
  }

  function headButton(action, label, title) {
    const b = el('button', 'ytq-h-btn' + (label.length === 1 ? ' ytq-h-icon' : ''), label);
    b.type = 'button';
    b.dataset.ytqDock = action;
    b.title = title || label;
    return b;
  }

  function onDockClick(e) {
    const btn = e.target.closest('[data-ytq-dock]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const action = btn.dataset.ytqDock;
    const row = btn.closest('.ytq-row');
    const index = row ? Number(row.dataset.index) : -1;

    if (action === 'collapse') { setPref('dockOpen', false); renderDock(true); return; }
    if (action === 'clear') {
      if (window.confirm('Clear the whole queue?')) {
        const status = clearQueue();
        if (status === 'partial') toast('Cleared everything except the video that’s playing');
        else if (status === 'unavailable') toast('Couldn’t clear from this page — open a video and try again');
        setTimeout(() => renderDock(true), 900);
      }
      return;
    }
    if (action === 'restore') {
      const snap = readSnapshot();
      if (snap) {
        addToQueue(snap.ids);
        toast(`Restoring ${snap.ids.length} video${snap.ids.length === 1 ? '' : 's'}`);
        setTimeout(() => renderDock(true), 1200);
      }
      return;
    }
    if (action === 'discard') { writeSnapshot({ ids: [], at: Date.now() }); renderDock(true); return; }
    if (index < 0) return;
    if (action === 'remove') {
      const status = removeAt(index);
      if (status === 'playing') toast('YouTube won’t remove the video that’s playing — skip past it first');
      else if (status === 'error') toast('Couldn’t remove that one');
      setTimeout(() => renderDock(true), 700);
      return;
    }
    if (action === 'play') jumpTo(index);
  }

  /** Drag-to-reorder inside the dock. Explains itself when the native panel isn't loaded. */
  function wireDockDrag(dock) {
    let dragFrom = -1;
    const clearMarks = () => dock.querySelectorAll('.ytq-over, .ytq-dragging')
      .forEach((n) => n.classList.remove('ytq-over', 'ytq-dragging'));

    dock.addEventListener('dragstart', (e) => {
      const row = e.target.closest && e.target.closest('.ytq-row');
      if (!row) return;
      dragFrom = Number(row.dataset.index);
      row.classList.add('ytq-dragging');
      safe(() => e.dataTransfer.setData('text/plain', String(dragFrom)));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    dock.addEventListener('dragover', (e) => {
      const row = e.target.closest && e.target.closest('.ytq-row');
      if (!row || dragFrom < 0) return;
      e.preventDefault();
      dock.querySelectorAll('.ytq-over').forEach((n) => n.classList.remove('ytq-over'));
      row.classList.add('ytq-over');
    });
    dock.addEventListener('drop', (e) => {
      const row = e.target.closest && e.target.closest('.ytq-row');
      clearMarks();
      if (!row || dragFrom < 0) return;
      e.preventDefault();
      const status = moveItem(dragFrom, Number(row.dataset.index));
      dragFrom = -1;
      if (status === 'no-panel') toast('Reordering needs YouTube’s queue panel — open a video once, then try again');
      setTimeout(() => renderDock(true), 250);
    });
    dock.addEventListener('dragend', () => { clearMarks(); dragFrom = -1; });
  }

  function wireResize(dock) {
    const grip = dock.querySelector('.ytq-grip');
    let startY = 0, startH = 0, dragging = false;
    grip.addEventListener('mousedown', (e) => {
      dragging = true; startY = e.clientY; startH = prefs.dockHeight;
      e.preventDefault();
      document.body.classList.add('ytq-resizing');
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const h = Math.max(140, Math.min(760, startH + (startY - e.clientY)));
      dock.style.setProperty('--ytq-dock-h', h + 'px');
      prefs.dockHeight = h;
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('ytq-resizing');
      setPref('dockHeight', prefs.dockHeight);
    });
  }

  function queueSignature(items, snap) {
    return [
      prefs.dockOpen ? 'o' : 'c',
      prefs.dockSide,
      items.map((i) => i.videoId).join(','),
      YT.currentIndex(),
      snap ? 's' + snap.ids.length : '',
    ].join('|');
  }

  function renderDock(force) {
    if (!prefs.dock) { if (dockEl) dockEl.style.display = 'none'; return; }
    const items = YT.items();
    const snap = items.length ? null : readSnapshot();

    // Nothing to show and nothing to offer — stay out of the way entirely.
    if (!items.length && !snap) { if (dockEl) dockEl.style.display = 'none'; return; }

    const sig = queueSignature(items, snap);
    if (!force && sig === lastSignature) return;
    lastSignature = sig;

    const dock = ensureDock();
    if (!dock) return;
    dock.style.display = '';
    dock.style.setProperty('--ytq-dock-h', prefs.dockHeight + 'px');
    dock.dataset.open = prefs.dockOpen ? '1' : '0';
    dock.dataset.side = prefs.dockSide === 'left' ? 'left' : 'right';

    const current = YT.currentIndex();
    const list = dock.querySelector('.ytq-list');
    const foot = dock.querySelector('.ytq-foot');
    const clearBtn = dock.querySelector('[data-ytq-dock="clear"]');
    list.textContent = '';

    if (!items.length) {
      dock.querySelector('.ytq-pill').textContent = `▸ Restore ${snap.ids.length}`;
      dock.querySelector('.ytq-h-count').textContent = '';
      clearBtn.style.display = 'none';
      foot.textContent = '';

      const li = el('li', 'ytq-empty');
      li.appendChild(el('div', 'ytq-empty-t', 'Queue from your last session'));
      li.appendChild(el('div', 'ytq-empty-s',
        `${snap.ids.length} video${snap.ids.length === 1 ? '' : 's'} saved${snap.at ? ' · ' + ago(snap.at) : ''}`));
      const actions = el('div', 'ytq-empty-a');
      const restore = headButton('restore', 'Restore', 'Put these back in the queue');
      restore.classList.add('ytq-primary');
      actions.appendChild(restore);
      actions.appendChild(headButton('discard', 'Discard', 'Forget the saved queue'));
      li.appendChild(actions);
      list.appendChild(li);
      return;
    }

    const t = totals(items, current);
    clearBtn.style.display = '';
    dock.querySelector('.ytq-pill').textContent = `▸ Queue ${items.length}`;
    dock.querySelector('.ytq-h-count').textContent =
      `${items.length} · ${clock(t.total)}${t.unknown ? ` +${t.unknown} live` : ''}`;

    items.forEach((it, i) => {
      const li = el('li', 'ytq-row' + (i === current ? ' ytq-now' : '') + (i < current ? ' ytq-past' : ''));
      li.dataset.index = String(i);
      li.draggable = true;

      li.appendChild(el('span', 'ytq-drag', '⠿')).title = 'Drag to reorder';
      li.appendChild(el('span', 'ytq-num', i === current ? '▶' : String(i + 1)));

      if (it.thumb) {
        const img = el('img', 'ytq-thumb');
        img.src = it.thumb;
        img.alt = '';
        img.loading = 'lazy';
        li.appendChild(img);
      } else {
        li.appendChild(el('span', 'ytq-thumb'));
      }

      const meta = el('span', 'ytq-meta');
      meta.dataset.ytqDock = 'play';
      meta.setAttribute('role', 'button');
      meta.tabIndex = 0;
      meta.title = it.title;
      meta.appendChild(el('span', 'ytq-t', it.title));
      meta.appendChild(el('span', 'ytq-b', it.author + (it.durationText ? ' · ' + it.durationText : '')));
      li.appendChild(meta);

      const x = el('button', 'ytq-x', '✕');
      x.type = 'button';
      x.dataset.ytqDock = 'remove';
      x.title = 'Remove from queue';
      x.setAttribute('aria-label', 'Remove from queue');
      li.appendChild(x);

      list.appendChild(li);
    });

    const after = items.length - current - 1;
    foot.textContent = after > 0
      ? `${after} after this · ${human(t.left)} left${t.unknown ? ' (+live)' : ''}`
      : `${clock(t.total)} total`;
  }

  // ===========================================================================
  // Enhancements to YouTube's own queue panel on /watch.
  // ===========================================================================
  function enhanceNativePanel() {
    const panel = YT.panel();
    if (!panel) return;

    if (prefs.panelKeepOpen && panel.hasAttribute('collapsed')) {
      panel.removeAttribute('collapsed');
      const expand = panel.querySelector('button[aria-label="Expand"], #expand-button button');
      if (expand) safe(() => expand.click());
    }

    const existing = panel.querySelector('.ytq-panel-totals');
    if (!prefs.panelTotals) { if (existing) existing.remove(); return; }

    const items = YT.items();
    if (!items.length) { if (existing) existing.remove(); return; }

    const t = totals(items, YT.currentIndex());
    let bar = existing;
    if (!bar) {
      const header = panel.querySelector('#header') || panel.firstElementChild;
      if (!header) return;
      bar = el('div', 'ytq-panel-totals');
      header.appendChild(bar);
    }
    bar.textContent =
      `${items.length} in queue · ${clock(t.total)} total` +
      `${t.unknown ? ` (+${t.unknown} live)` : ''} · ${human(t.left)} left`;
  }

  // ===========================================================================
  // Snapshot: remember the queue so a reload doesn't lose it.
  // ===========================================================================
  function snapshotQueue() {
    const items = YT.items();
    if (!items.length) return; // never overwrite a good snapshot with an empty one
    writeSnapshot({
      ids: items.map((i) => i.videoId),
      index: YT.currentIndex(),
      titles: items.slice(0, 60).map((i) => i.title),
      at: Date.now(),
    });
  }

  let autoRestored = false;
  function maybeAutoRestore() {
    if (!prefs.autoRestore || autoRestored) return;
    autoRestored = true;
    const snap = readSnapshot();
    if (!snap) return;

    // A signed-in YouTube restores the queue by itself, server-side, and that can land AFTER we
    // boot. Wait for it before replaying a snapshot, or we would append the whole list a second
    // time on top of the one YouTube just brought back.
    waitFor(() => YT.items().length > 0, 6000).then((youtubeBroughtItBack) => {
      if (youtubeBroughtItBack) return;
      addToQueue(snap.ids);
      toast(`Restored ${snap.ids.length} from last session`);
    });
  }

  // ===========================================================================
  // Styles.
  // ===========================================================================
  const CSS = `
  /* --- hover buttons on thumbnails ------------------------------------- */
  .ytq-host { position: relative; }
  .ytq-hover {
    position: absolute; top: 4px; left: 4px; z-index: 60;
    display: flex; gap: 4px; opacity: 0; pointer-events: none;
    transition: opacity .12s ease;
  }
  .ytq-host:hover .ytq-hover, .ytq-hover:focus-within { opacity: 1; pointer-events: auto; }
  .ytq-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; padding: 0; border: 0; border-radius: 6px; cursor: pointer;
    background: rgba(0,0,0,.75); color: #fff; line-height: 0;
    transition: background .12s ease, transform .12s ease;
  }
  .ytq-btn:hover { background: rgba(0,0,0,.92); transform: scale(1.06); }
  .ytq-btn.ytq-flash { background: #2ba640; }

  /* --- toast ------------------------------------------------------------ */
  .ytq-toast {
    position: fixed; left: 16px; bottom: 16px; z-index: 2400;
    max-width: 340px; padding: 10px 14px; border-radius: 8px;
    background: var(--yt-spec-menu-background, #282828);
    color: var(--yt-spec-text-primary, #f1f1f1);
    font: 500 13px/1.35 "Roboto", Arial, sans-serif;
    box-shadow: 0 4px 20px rgba(0,0,0,.45);
    opacity: 0; transform: translateY(8px); pointer-events: none;
    transition: opacity .18s ease, transform .18s ease;
  }
  .ytq-toast-on { opacity: 1; transform: translateY(0); }

  /* --- dock ------------------------------------------------------------- */
  .ytq-dock {
    --ytq-dock-h: 330px;
    position: fixed; bottom: 16px; z-index: 2300;
    width: 340px; display: flex; flex-direction: column;
    border-radius: 12px; overflow: hidden;
    background: var(--yt-spec-menu-background, #212121);
    color: var(--yt-spec-text-primary, #f1f1f1);
    border: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,.12));
    box-shadow: 0 8px 28px rgba(0,0,0,.45);
    font-family: "Roboto", Arial, sans-serif;
  }
  .ytq-dock[data-side="right"] { right: 16px; }
  .ytq-dock[data-side="left"]  { left: 16px; }
  .ytq-dock[data-open="0"] { width: auto; border: 0; background: transparent; box-shadow: none; }
  .ytq-dock[data-open="0"] .ytq-grip,
  .ytq-dock[data-open="0"] .ytq-head,
  .ytq-dock[data-open="0"] .ytq-list,
  .ytq-dock[data-open="0"] .ytq-foot { display: none; }
  .ytq-dock[data-open="1"] .ytq-pill { display: none; }

  .ytq-pill {
    padding: 9px 15px; border-radius: 999px; cursor: pointer;
    background: var(--yt-spec-menu-background, #212121);
    color: var(--yt-spec-text-primary, #f1f1f1);
    font: 500 13px/1 "Roboto", Arial, sans-serif;
    box-shadow: 0 4px 16px rgba(0,0,0,.45);
    border: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,.12));
  }
  .ytq-pill:hover { filter: brightness(1.15); }

  .ytq-grip { height: 7px; cursor: ns-resize; flex: 0 0 auto; background: transparent; }
  .ytq-grip::after {
    content: ""; display: block; width: 34px; height: 3px; margin: 2px auto 0; border-radius: 2px;
    background: var(--yt-spec-text-secondary, #aaa); opacity: .4;
  }
  body.ytq-resizing { user-select: none; }

  .ytq-head {
    display: flex; align-items: center; gap: 8px; padding: 4px 10px 8px;
    border-bottom: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,.12));
  }
  .ytq-h-title { font-size: 14px; font-weight: 600; }
  .ytq-h-count { font-size: 12px; color: var(--yt-spec-text-secondary, #aaa); }
  .ytq-h-spacer { flex: 1; }
  .ytq-h-btn {
    border: 0; border-radius: 6px; cursor: pointer; padding: 4px 9px;
    background: transparent; color: var(--yt-spec-text-secondary, #aaa);
    font: 500 12px/1 "Roboto", Arial, sans-serif;
  }
  .ytq-h-btn:hover {
    background: var(--yt-spec-10-percent-layer, rgba(255,255,255,.12));
    color: var(--yt-spec-text-primary, #f1f1f1);
  }
  .ytq-h-icon { font-size: 14px; padding: 4px 7px; }
  .ytq-primary {
    background: var(--yt-spec-text-primary, #f1f1f1);
    color: var(--yt-spec-base-background, #0f0f0f);
  }

  .ytq-list {
    list-style: none; margin: 0; padding: 4px; overflow-y: auto; overflow-x: hidden;
    height: var(--ytq-dock-h); flex: 1 1 auto; scrollbar-width: thin;
  }
  .ytq-row {
    display: flex; align-items: center; gap: 7px; padding: 4px; border-radius: 8px; cursor: grab;
  }
  .ytq-row:hover { background: var(--yt-spec-10-percent-layer, rgba(255,255,255,.09)); }
  .ytq-row.ytq-now { background: var(--yt-spec-10-percent-layer, rgba(255,255,255,.14)); }
  .ytq-row.ytq-past .ytq-thumb, .ytq-row.ytq-past .ytq-meta { opacity: .5; }
  .ytq-row.ytq-dragging { opacity: .4; }
  .ytq-row.ytq-over { box-shadow: inset 0 2px 0 var(--yt-spec-text-primary, #f1f1f1); }

  .ytq-drag { width: 12px; text-align: center; color: var(--yt-spec-text-secondary, #aaa); opacity: 0; font-size: 12px; }
  .ytq-row:hover .ytq-drag { opacity: .8; }
  .ytq-num { width: 16px; text-align: right; font-size: 11px; color: var(--yt-spec-text-secondary, #aaa); flex: 0 0 auto; }
  .ytq-thumb { width: 60px; height: 34px; object-fit: cover; border-radius: 4px; background: #000; flex: 0 0 auto; }
  .ytq-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; cursor: pointer; }
  .ytq-t {
    font-size: 12.5px; line-height: 1.25; max-height: 2.5em; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .ytq-b {
    font-size: 11px; color: var(--yt-spec-text-secondary, #aaa);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .ytq-x {
    border: 0; background: transparent; cursor: pointer; opacity: 0; flex: 0 0 auto;
    color: var(--yt-spec-text-secondary, #aaa); font-size: 13px; padding: 4px 5px; border-radius: 5px;
  }
  .ytq-row:hover .ytq-x { opacity: 1; }
  .ytq-x:hover {
    background: var(--yt-spec-10-percent-layer, rgba(255,255,255,.15));
    color: var(--yt-spec-text-primary, #f1f1f1);
  }

  .ytq-foot {
    padding: 7px 11px; font-size: 11.5px; color: var(--yt-spec-text-secondary, #aaa);
    border-top: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,.12));
  }
  .ytq-empty { padding: 18px 14px; text-align: center; }
  .ytq-empty-t { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  .ytq-empty-s { font-size: 11.5px; color: var(--yt-spec-text-secondary, #aaa); margin-bottom: 12px; }
  .ytq-empty-a { display: flex; gap: 8px; justify-content: center; }
  .ytq-empty-a .ytq-h-btn { padding: 6px 14px; }

  /* --- native queue panel ------------------------------------------------ */
  .ytq-panel-totals {
    padding: 5px 12px 8px; font: 400 12px/1.3 "Roboto", Arial, sans-serif;
    color: var(--yt-spec-text-secondary, #aaa);
  }
  `;

  // Reorder handles are always live for a TLPQ queue; YouTube just hides them until hover.
  const CSS_HANDLES = `
  ytd-playlist-panel-video-renderer #reorder { display: flex !important; }
  ytd-playlist-panel-video-renderer:not(:hover) #reorder { opacity: .45; }
  `;

  function injectStyles() {
    let node = document.getElementById('ytq-style');
    if (!node) {
      node = el('style');
      node.id = 'ytq-style';
      (document.head || document.documentElement).appendChild(node);
    }
    node.textContent = CSS + (prefs.panelHandles ? CSS_HANDLES : '') + `
  ytd-playlist-panel-renderer#playlist #items { max-height: ${prefs.panelMaxHeight}px !important; }`;
  }

  // ===========================================================================
  // Sweeps and observers.
  // ===========================================================================
  const sweep = debounceRaf(() => {
    if (prefs.hoverButtons) for (const a of thumbnailAnchors(document)) decorate(a);
    enhanceNativePanel();
    renderDock(false);
  });

  function startObserver() {
    new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: true });
    // YouTube's SPA swaps whole page bodies; these are the reliable "page changed" signals.
    document.addEventListener('yt-navigate-finish', () => setTimeout(sweep, 60), true);
    document.addEventListener('yt-page-data-updated', () => setTimeout(sweep, 60), true);
    // Straggler insurance for renderers that mount late.
    [500, 1500, 3500].forEach((t) => setTimeout(sweep, t));
  }

  // ===========================================================================
  // Tampermonkey menu.
  // ===========================================================================
  const menuIds = [];
  function buildMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    if (typeof GM_unregisterMenuCommand === 'function') {
      menuIds.splice(0).forEach((id) => safe(() => GM_unregisterMenuCommand(id)));
    }
    const add = (label, fn) => {
      const id = safe(() => GM_registerMenuCommand(label, () => { fn(); buildMenu(); }), null);
      if (id != null) menuIds.push(id);
    };
    const onOff = (v) => (v ? 'ON' : 'OFF');

    add(`➕ Thumbnail buttons: ${onOff(prefs.hoverButtons)}`, () => {
      setPref('hoverButtons', !prefs.hoverButtons);
      undecorateAll();
      if (prefs.hoverButtons) sweep();
    });
    add(`⏭️ "Play next" button: ${onOff(prefs.hoverPlayNext)}`, () => {
      setPref('hoverPlayNext', !prefs.hoverPlayNext);
      undecorateAll();
      sweep();
    });
    add(`🖱️ Queue on click: ${prefs.clickModifier}`, () => {
      const order = ['shift', 'alt', 'middle', 'off'];
      setPref('clickModifier', order[(order.indexOf(prefs.clickModifier) + 1) % order.length]);
    });
    add(`⌨️ Q hotkey: ${onOff(prefs.hotkeys)}`, () => setPref('hotkeys', !prefs.hotkeys));
    add(`📋 Floating queue panel: ${onOff(prefs.dock)}`, () => { setPref('dock', !prefs.dock); renderDock(true); });
    add(`↔️ Panel side: ${prefs.dockSide}`, () => {
      setPref('dockSide', prefs.dockSide === 'right' ? 'left' : 'right');
      renderDock(true);
    });
    add(`📐 Keep native panel expanded: ${onOff(prefs.panelKeepOpen)}`, () => setPref('panelKeepOpen', !prefs.panelKeepOpen));
    add(`⠿ Always show reorder handles: ${onOff(prefs.panelHandles)}`, () => { setPref('panelHandles', !prefs.panelHandles); injectStyles(); });
    add(`📺 Queueing opens the miniplayer: ${onOff(prefs.openMiniplayer)}`, () => setPref('openMiniplayer', !prefs.openMiniplayer));
    add(`💾 Auto-restore queue on load: ${onOff(prefs.autoRestore)}`, () => setPref('autoRestore', !prefs.autoRestore));
    add('↩️ Restore saved queue now', () => {
      const snap = readSnapshot();
      if (!snap) { toast('No saved queue'); return; }
      addToQueue(snap.ids);
      toast(`Restoring ${snap.ids.length}`);
    });
    add('🩺 Diagnostics (console)', diagnostics);
  }

  /**
   * One command's worth of "is this script actually wired into YouTube?". Reports which of the four
   * primitives are reachable right now — the fastest way to tell a YouTube change from a bug.
   */
  function diagnostics() {
    const panel = YT.panel();
    const items = YT.items();
    const current = YT.currentIndex();
    // Probe a row that ISN'T the current one — the playing item never has a remove action.
    const probe = items.findIndex((it, i) => i !== current && !it.selected);

    const report = {
      version: '0.1.0',
      page: location.pathname,
      'add: ytd-app.resolveCommand': !!(YT.app() && typeof YT.app().resolveCommand === 'function'),
      'read: yt-playlist-manager': !!YT.manager(),
      'queue items visible': items.length,
      'queue playlistId': safe(() => YT.playlistData()?.playlistId, null),
      'native panel present (needed for reorder)': !!panel,
      'reorder: handleDrop': !!(panel && typeof panel.polymerController?.handleDrop === 'function'),
      'remove: native endpoint': probe < 0
        ? 'n/a — no row other than the current one'
        : (removeEndpointFor(probe) ? 'yes' : 'NO (signed out?)'),
      'clear: native button': !!(panel && panel.querySelector('button[aria-label="Clear queue"]')),
      'thumbnails decorated': document.querySelectorAll('.ytq-hover').length,
      'snapshot saved': safe(() => readSnapshot()?.ids.length, 0) || 0,
    };
    log('diagnostics', report, prefs);
    safe(() => console.table(Object.entries(report).map(([k, v]) => ({ check: k, value: String(v) }))));
    toast('Diagnostics printed to the console');
    return report;
  }

  // ===========================================================================
  // Boot.
  // ===========================================================================
  function boot() {
    injectStyles();
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('auxclick', onDocumentClick, true);
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('keydown', onKeyDown, true);
    startObserver();
    buildMenu();

    // Snapshot on a timer rather than per-mutation: the queue changes rarely, and a timer also
    // catches changes made through YouTube's own UI, not just ours.
    setInterval(() => { safe(snapshotQueue); safe(() => renderDock(false)); }, 3000);
    setTimeout(() => safe(maybeAutoRestore), 2500);

    // Debug handle. Deliberately not part of the page's API surface.
    safe(() => Object.defineProperty(window, '__ytq', {
      value: { YT, addToQueue, playNext, moveItem, removeAt, clearQueue, diagnostics, prefs },
      configurable: true,
    }));
    log('ready — Q queues the hovered video, Shift+Q plays it next, Alt+Shift+Q toggles the panel');
  }

  if (document.readyState === 'loading') {
    injectStyles(); // no flash of un-styled dock / handles
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
