// /api/turn — hands the game ICE servers. Peer-to-peer WebRTC needs a TURN
// relay when both players sit behind strict routers (most home and mobile
// networks), and no free public relay is reliable. Configure one of these in
// the Vercel project's environment variables and this endpoint returns it:
//
//   CF_TURN_KEY_ID + CF_TURN_API_TOKEN — Cloudflare Realtime TURN (free tier)
//   METERED_DOMAIN + METERED_API_KEY   — metered.ca TURN (free tier is plenty)
//   TURN_URLS (comma separated) + TURN_USERNAME + TURN_CREDENTIAL — any TURN
//
// With nothing configured it returns an empty list and the game uses STUN only.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  const out = { iceServers: [], source: "none" };
  try {
    const { CF_TURN_KEY_ID, CF_TURN_API_TOKEN, METERED_DOMAIN, METERED_API_KEY, TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
    if (CF_TURN_KEY_ID && CF_TURN_API_TOKEN) {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: "POST", headers: { Authorization: `Bearer ${CF_TURN_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 3600 }),
      });
      if (r.ok) {
        const data = await r.json(); // { iceServers: [{urls, username, credential}] }
        out.iceServers = Array.isArray(data.iceServers) ? data.iceServers : (data.iceServers ? [data.iceServers] : []);
        out.source = "cloudflare";
      } else out.error = `cloudflare ${r.status}`;
    } else if (METERED_DOMAIN && METERED_API_KEY) {
      const r = await fetch(`https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`);
      if (r.ok) {
        const list = await r.json(); // [{urls, username, credential}, ...]
        out.iceServers = Array.isArray(list) ? list : [];
        out.source = "metered";
      } else out.error = `metered ${r.status}`;
    } else if (TURN_URLS) {
      out.iceServers = [{ urls: TURN_URLS.split(",").map((u) => u.trim()).filter(Boolean), username: TURN_USERNAME || "", credential: TURN_CREDENTIAL || "" }];
      out.source = "env";
    }
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  res.status(200).end(JSON.stringify(out));
}
