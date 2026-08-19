# LFC Fixtures

A fixtures, results, and history PWA for Liverpool FC — built as a single-page app with no framework, no build step, and (as of this year) a genuinely automated pipeline that keeps its historical record up to date on its own.

**Live:** [dirtyduffers.github.io](https://dirtyduffers.github.io)

---

## What it does

- **Fixtures & Calendar** — upcoming matches, pulled live from the club's own official calendar feed
- **Results** — every completed match, filterable by season, competition, manager, home/away, and era
- **On This Day** — what happened on today's date across Liverpool's history, including Famous Matches and In Memoriam tributes for Hillsborough and Heysel
- **Head-to-Head** — full record against any opponent the club has ever played
- **Stats** — manager-by-manager breakdowns, win/loss/draw splits, goal records
- **Honours** — the trophy cabinet, computed live from match data rather than typed in by hand
- **Away** (trip planner) — save a date range you'll be travelling and see which matches you'll miss
- Dark/light theme, offline-friendly caching, "add to home screen" support on iOS

## How it's built

Single HTML file (`index.html`) — no React, no bundler, no `npm install`. Historical data lives separately in `data/*.json`, fetched at load time rather than baked into the app shell, which keeps the app itself small and means a data update never touches app code.

```
index.html               → the whole app: HTML, CSS, and JS in one file
data/
  matches.json            → every historical result (the one the automation updates)
  managers.json           → manager spells and stats
  badges.json             → opponent crests
  venues-attendance.json  → venue and attendance lookups
  honours.json            → famous matches, tribute dates, league title years
```

Deployed via GitHub Pages straight from this repo — no CI, no build pipeline. Push to `main`, and it's live within a minute or two.

## The automated results pipeline

A Cloudflare Worker checks the club's official fixture calendar every few hours for newly-finished matches. When it finds one:

1. It looks the result up on **lfchistory.net**, treated as the authoritative source — if found, the result (including opposition manager and attendance) is committed straight to `main`, no human needed.
2. If lfchistory.net doesn't have it yet, it falls back to a live check of **liverpoolfc.com**, but anything found this way always opens a GitHub Pull Request for manual review rather than being trusted automatically.
3. The same Worker also proxies the live fixtures calendar the app itself reads from, and handles on-demand attendance/manager lookups for older matches.

The Worker's source isn't in this repo (it's deployed and edited directly in the Cloudflare dashboard) — worth pulling into version control here at some point.

## Data integrity

There's a built-in audit tool for catching data problems — duplicate fixtures, misattributed managers, missing badges, and similar issues — that's found and fixed a genuine string of real bugs during this project's history. It's hidden by default; tap the version number on the About page five times to reveal it.

## Local development

There isn't really a "dev setup" — it's a static site. Open `index.html` in a browser, or serve the folder with anything that can host static files (the `data/` fetches need to be same-origin, so opening the raw file with `file://` won't load the historical data — use a local server, e.g. `python3 -m http.server`, and browse to it over `http://`).

## Credits

Historical match data sourced primarily from [lfchistory.net](https://www.lfchistory.net), cross-referenced against the club's own published records. Built and maintained as a personal project — not affiliated with Liverpool Football Club.
