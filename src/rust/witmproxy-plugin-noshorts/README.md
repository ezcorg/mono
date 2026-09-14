# witmproxy-plugin-noshorts

YouTube with the compulsive parts removed. A [witmproxy](../../apps/witmproxy)
plugin that:

- **Refuses Shorts.** `/shorts/*` pages and the Shorts playback API get a
  block page or a `403`; CSS injected into every page hides the Shorts shelf,
  tab, and links; client-side navigations to Shorts are caught in the page.
- **Blocks the whole site during working hours** (default `08:00-17:00`,
  Monday to Friday, in the host's local time zone).
- **Meters active viewing time against a daily budget** (default 30 minutes).
  A small agent injected into each page reports activity; when the budget is
  spent the agent covers the page and every further navigation gets the
  block page. The counter resets at local midnight.
- **Hides clickbait and ragebait** from feeds with a transparent title
  heuristic (see [Filtering](#filtering-clickbait-and-ragebait)).

Every block page says why, and how to turn the plugin off, in terms vague
enough that doing so takes a deliberate trip to a terminal.

## Building

```sh
make            # generates a signing key on first run, builds, signs
```

The Makefile drops `witmproxy_plugin_noshorts.signed.wasm` into
`target/wasm32-wasip2/release/`. Install it with:

```sh
witm plugin add target/wasm32-wasip2/release/witmproxy_plugin_noshorts.signed.wasm
```

## Configuration

```sh
witm plugin configure witmproxy/noshorts --set daily_budget_minutes=20 --set work_hours=09:00-18:00
witm service restart
```

| Setting                | Default                                                    | Meaning |
|------------------------|------------------------------------------------------------|---------|
| `hosts`                | `youtube.com, m.youtube.com, www.youtube.com, youtu.be, youtube-nocookie.com` | Hosts to manage; a host matches itself and its subdomains |
| `block_shorts`         | `true`  | Refuse Shorts pages and API |
| `hide_shorts_ui`       | `true`  | Inject CSS hiding Shorts UI |
| `daily_budget_minutes` | `30`    | Active minutes allowed per local day (`0` blocks outright) |
| `work_hours`           | `08:00-17:00` | Local window during which the site is blocked; may wrap midnight |
| `work_days`            | `mon-fri` | `mon-fri`, `all`, `none`, `sat,sun`, `fri-mon`, … |
| `utc_offset_minutes`   | *(host's zone)* | Override the local time zone offset, minutes east of UTC |
| `heartbeat_seconds`    | `15`    | How often tabs report activity |
| `idle_seconds`         | `180`   | A visible tab with no input for this long, and no video playing, is idle |
| `filter_enabled`       | `true`  | Hide feed items scored as clickbait |
| `filter_threshold`     | `0.6`   | Score (0–1) at or above which an item is hidden |
| `filter_keywords`      | *(none)* | Extra comma-separated phrases that mark a title as clickbait |

Note that the event scopes in the manifest (`connect`, `request`,
`inbound-content`) are CEL expressions over the YouTube hosts; `hosts` only
governs the plugin's own decisions. Widen the scopes if you widen `hosts`.

## How it works

```
browser ──► witmproxy ──► plugin
   │            │
   │   request event: /shorts/*, /youtubei/v1/reel/*  ──► 403 block page
   │                  working hours / budget spent      ──► 403 block page
   │                  /__witm/noshorts/{agent,tick,score,blocked,status}
   │                                                    ──► answered by the plugin
   │   content event (text/html on a managed host)      ──► <style> + <iframe src=/__witm/noshorts/agent>
   │
   └── agent iframe (same origin): heartbeats ──► /tick   (active? dt)
                                    titles     ──► /score  (hide? why)
                                    on "blocked": pause videos, go fullscreen,
                                    load /blocked?reason=…
```

The agent lives in a same-origin iframe rather than an inline script so it
is unaffected by YouTube's Trusted Types policy, needs no CSP exceptions
(its endpoints are on YouTube's own origin as far as the browser can tell),
and survives YouTube's client-side navigation.

Active time is credited on heartbeats, bounded by wall-clock time since the
previous credit, so two tabs ticking in parallel cannot count double. A tab
is *active* when a video is playing, or when it is visible and has seen
input within `idle_seconds`.

Usage is kept in the plugin's local storage under one key per local day.
That storage is in-memory in the current witmproxy: a daemon restart resets
the day's counter.

## Filtering clickbait and ragebait

What ships is a heuristic over titles (`src/score.rs`): upper-case ratio,
exclamation marks, emoji piles, a phrase list ("you won't believe",
"destroys", "meltdown", …), and operator keywords. Each signal is named in
the response, so a hidden item can always be explained
(`data-witm-hidden="mostly upper case, bait phrase"` on the element).

To go further than titles, the host would need to provide:

1. **Feed metadata.** The innertube JSON (`/youtubei/v1/browse`, `next`,
   `search`) carries view counts, publish dates, channel ids, durations and
   thumbnails. A response-event handler could score on engagement-per-day
   ratios, thumbnail text, and channel reputation, and strip items before
   the page renders them (no flash of hidden content). This needs nothing
   new from the host except effort: the JSON is large and streamed.
2. **Outbound HTTP** (`http-client`, still a TODO in the WIT) to consult a
   classifier or an LLM for titles and descriptions the heuristic is unsure
   about, with results cached in local storage.
3. **A persistent annotator.** The `annotator` capability exists but is a
   no-op today. Storing per-video labels (and the user's own "hide this"
   feedback) would let the filter learn channel-level priors.
4. **Persistent local storage**, so labels and the daily ledger survive
   restarts.

## Testing

```sh
cargo test -p witmproxy-plugin-noshorts            # unit + proxy integration tests
cargo test -p witmproxy-plugin-noshorts -- --ignored real_youtube   # needs network
```

The integration tests build and sign the component on demand, run it inside
a real witmproxy, and front a stand-in YouTube on `127.0.0.1`. One test
drives headless Chrome through the proxy with `puppeteer-core`
(`tests/puppeteer/noshorts.mjs`); it is skipped when `node`, the pnpm store
at the repo root, or a Chrome binary cannot be found.
