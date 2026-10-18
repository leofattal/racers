# Drift Circuit

Arcade drift racer in the browser: three.js, plain ES modules, no build step.
Live: https://racers-psi.vercel.app

## Play
- WASD / arrows drive, Space handbrake, S airbrake, R checkpoint reset, Esc pause.
- Gamepads (Xbox and PlayStation) work; pick a car class and a track in the menu, or roll a random circuit with R.
- 2 players on one machine: PLAYERS → 2 SPLIT. Online: HOST LOBBY, share the 5-letter code, friends JOIN.

## Online play and the relay server
Online races are peer-to-peer over WebRTC. Matchmaking uses [Trystero](https://github.com/dmotz/trystero)
over public Nostr relays (no account, no server of ours); game traffic then flows directly between
players, end-to-end encrypted. Players on different home or mobile networks sometimes need a
TURN relay server as well, and no free public relay is dependable. The site asks its own endpoint, `/api/turn`, for relay servers;
configure one of these in the Vercel project's **Environment Variables** and redeploy:

| Provider | Variables | Notes |
|---|---|---|
| Cloudflare Realtime TURN | `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Free tier (1 TB/month). Dashboard → Realtime → TURN → create key. |
| Metered.ca | `METERED_DOMAIN` (e.g. `yourapp.metered.live`), `METERED_API_KEY` | Free tier 50 GB/month. |
| Any TURN (coturn, Twilio…) | `TURN_URLS` (comma separated), `TURN_USERNAME`, `TURN_CREDENTIAL` | Static credentials. |

The lobby shows whether a relay is configured and, once connected, whether each link is
direct or relayed. Without a relay, players on the same network (or with open routers) still connect.

## Develop
- Serve the folder over http (`python3 -m http.server`) and open index.html. Modules are
  versioned through the import map in index.html: bump the `?v=` value when `src/` changes.
- Headless test battery: `node dev-tests/run.mjs` (uses a three.js stub; mirror `src/*.js` into `dev-tests/src/` first).
- Debug URL flags: `?norender` skips drawing, `?autopilot` lets the AI drive the human seats.

Car model: Ferrari 458 Italia by vicent091036 (CC-BY 4.0), from the three.js examples.
