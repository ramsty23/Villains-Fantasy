// Villains Fantasy live scores (Vercel serverless function).
// GET /api/live?week=7 → the week's Sleeper matchups, trimmed to what the page needs.
// Fetched server-side so the browser never depends on Sleeper allowing cross-site requests.
// Vercel's edge caches each answer for 30 seconds, so Sleeper gets at most ~2 requests a minute
// however many people have the site open.
const LEAGUE = "1388171060305743872";

module.exports = async (req, res) => {
  const week = Number((req.query && req.query.week) || 0);
  if (!Number.isInteger(week) || week < 1 || week > 18) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "week must be 1-18" });
  }
  try {
    const r = await fetch("https://api.sleeper.app/v1/league/" + LEAGUE + "/matchups/" + week, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) throw new Error("sleeper " + r.status);
    const rows = await r.json();
    const out = (Array.isArray(rows) ? rows : []).map((m) => ({
      r: m.roster_id,
      m: m.matchup_id,
      p: m.points || 0,
      s: m.starters || [],
      sp: m.starters_points || [],
      pp: m.players_points || {},
    }));
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=30");
    return res.status(200).json({ week, at: new Date().toISOString(), matchups: out });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "Sleeper is not answering right now." });
  }
};
