# Paragem

A personal web app for following Porto STCP bus lines. You set your stop, and it shows the next one to three buses on their way to it, how many stops away each one is, and how late it is. Positions are inferred from STCP's arrival estimates, because the API publishes no GPS.

```
index.html             the whole app: one file, no build step
manifest.webmanifest   home-screen install (optional)
sw.js                  offline app shell (optional; works over https or localhost only)
icon.svg / icon-*.png  icons
proxy/worker.js        Cloudflare Worker that adds CORS (free tier)
proxy/wrangler.toml    config for the Worker
proxy/local_proxy.py   local alternative to the Worker: Python, standard library only
test/core.test.mjs     tests for the bus-locating logic: node test/core.test.mjs
```

## 1. Check whether you need a proxy

Phone browsers only let a page call stcp.pt directly if stcp.pt sends CORS headers. I couldn't test that from where this was built, so the app checks it for you:

- Open the app. If arrivals load, you don't need a proxy.
- If a red **Blocked by the browser** box appears, the browser refused the request, almost certainly because of CORS. Set up one of the two proxies below. It takes about five minutes.

Settings → **Test connection** checks every API address and tells you which one works.

## 2. Put it on your phone

Phones won't run a downloaded HTML file properly, so the app needs to be served from somewhere. Pick one option.

**A. GitHub Pages + Cloudflare Worker (free, works anywhere, recommended)**

This is already set up: the app is at https://adrianogpena.github.io/paragem/, and on github.io it uses the Worker at https://paragem-proxy.adrianogpena.workers.dev without any configuration (`PAGES_PROXY` in index.html). The steps below are for setting it up again from scratch.

1. Create a public GitHub repository, e.g. `paragem`, and upload every file in this folder (the `proxy/` and `test/` folders are optional).
2. Repository → Settings → Pages → Source: *Deploy from a branch* → `main` / root → Save. After a minute the app is at `https://YOURNAME.github.io/paragem/`.
3. If arrivals load there, you're done. If you get the CORS box, deploy the Worker (section 3) and open
   `https://YOURNAME.github.io/paragem/?api=https://paragem-proxy.YOURNAME.workers.dev`
   once. The `?api=` value is saved, so the plain address works after that.

**B. Your own computer on home Wi-Fi (no accounts)**

```
python3 proxy/local_proxy.py
```

On your phone, open `http://<your-computer's-IP>:8787` (on a Mac, find the IP under System Settings → Wi-Fi → Details). The local proxy serves the app and forwards the API, so CORS isn't an issue. This only works while the computer is on and you're on the same network. The service worker won't run over plain http on a LAN IP, so you get no offline shell with this option. Everything else works.

## 3. Proxy setup (only if CORS blocks direct calls)

The proxies forward only these read-only paths: `/api/stops/{id}`, `/api/stops/{id}/realtime`, `/api/stops/{id}/routes`, `/api/route/{id}/stops/direction?direction_id=0|1` and `/api/route/{id}/services`. Any other path gets a 404. Realtime answers are cached for 20 s and stop lists for an hour, so two devices refreshing at once don't double the load on STCP.

**Cloudflare Worker, dashboard only (no command line):**

1. Sign up at dash.cloudflare.com (free plan).
2. Workers & Pages → Create → Create Worker → name it `paragem-proxy` → Deploy.
3. Edit code → replace everything with the contents of `proxy/worker.js` → Deploy.
4. Optional but recommended: Settings → Variables → add `ALLOWED_ORIGIN` = `https://YOURNAME.github.io`, so only your app can use the proxy.
5. Copy the Worker URL (`https://paragem-proxy.YOURNAME.workers.dev`) and paste it in Paragem → Settings → API address → Test connection.

**Cloudflare Worker, command line:** `cd proxy && npx wrangler deploy`. Edit `ALLOWED_ORIGIN` in `wrangler.toml` first.

**Local Python proxy:** see 2B. Use `--port` to change the port. On macOS, if Python reports a certificate error, run *Install Certificates.command* from your Python folder once.

## 4. Add to home screen

- **iPhone (Safari):** open the app → Share → *Add to Home Screen*.
- **Android (Chrome):** open the app → ⋮ menu → *Add to Home screen* / *Install app*.

It then opens full screen like an app. With option A, the app shell is cached, so it opens offline and shows an *Offline* message until you reconnect.

## 5. Using it

- **502 toward Matosinhos** is preloaded from your example list, with **BCM1** set as your stop. It's tagged *Example data*. Tap **Line → Load both directions from STCP** to replace it with the official stop list for both directions. This uses BCM1 to look up the route.
- **Set your stop:** tap a stop in the timeline → *Set as my stop*.
- **Add a line:** + Add line.
  - *From STCP:* enter the line number and the code of any stop on it (e.g. `502` + `BCM1`). The app finds the internal `route_id` through `/api/stops/BCM1/routes` and then loads both directions. If you already know the route_id, you can enter it directly. stcp.pt/pt/linhas no longer puts route_ids in its HTML; to find one, open the line page with your browser's developer tools on the Network tab and look for a request to `/api/route/ID/stops`.
  - *Paste stops:* one stop per line, in order. `CODE Name`, `Name CODE`, `Name (CODE)` and the comma-separated format from your brief all work. A preview shows what was recognised.
- **Settings:** buses to follow (1–3), refresh interval (30 s minimum), how many stops back the app may poll, when a bus counts as not started (5, 10 or 15 min to its next stop), theme, API address, and copy/paste of your whole setup to move it to another device.

## How a bus is located

1. Fetch `/realtime` for **your stop**. Keep only arrivals for this line (`route_short_name`), drop negative minutes (buses that already passed), merge duplicate rows per `trip_id`, and take the soonest 1–3. Those are the buses being followed.
2. Walk **backwards** from your stop toward the start of the line, 3 stops at a time. A bus that has already passed a stop isn't listed there, so the first stop that doesn't list a trip is behind the bus. The walk stops as soon as every followed bus has been placed. With 1 bus followed that's usually 2–5 requests per refresh, never more than *Look back at most* + 1.
3. Then walk **forward** from your stop, 3 stops at a time and at most 6 stops, until a stop lists a trip your stop no longer lists. That's the last bus that passed, shown as a grey *Passed* marker. This adds 3 requests per refresh, or 6 when no bus passed recently.
4. A bus's **next stop** is the stop with its smallest `arrival_minutes` ≥ 0 among the consecutive stops that list it. The marker is drawn on the rail just above that stop.
5. States:
   - **At the first stop:** the first stop still lists the trip, so the bus hasn't left yet.
   - **Not started yet:** the bus's next stop is more than 10 minutes away. A real bus is never that far from the next stop, so this is a timetable entry with no bus behind it yet. This is how your "only listed at the last stops = not started" rule is generalised.
   - **N+ stops away:** the bus is beyond the look-back limit.

Polling pauses while the app is hidden and resumes when you return. Any failure (blocked, timeout, HTTP error, unexpected JSON) shows a clear error with *Try again*. If one stop fails mid-walk, the app shows the buses it could place and notes which stop it couldn't check.

## Tests

`node test/core.test.mjs` runs the logic from `index.html` (the `<script id="core">` block) against sample `/realtime` responses in the documented shape. Those responses are built by hand, not captured from STCP. The test cases cover trip_id grouping, other lines mixed in, a bus that already passed, duplicate rows, a bus waiting at the first stop, a timetable-only trip, the look-back limit, a failing stop, request counts, and the paste parser.

## Etiquette and caveats

This is for personal use. It sends one request per stop per refresh, every 30 s or slower, and only for the stops it needs. It doesn't store or redistribute STCP data. The API is unofficial and undocumented, so field names can change; when the app gets something unexpected, it says so instead of showing wrong buses. If a busy stop caps how many arrivals it lists, a bus missing from that list may just be cut off. When a list has 8 or more rows and ends before the time the bus would be due, the app does not take the missing bus as passed: it looks one stop further back, and the passed-bus marker ignores it.
