// Villains Fantasy vote server (Vercel serverless function).
// Stores votes, PINs and sign-ins in Upstash Redis (added from Vercel's Storage tab).
// Accounts: "team-<1..12>" (league teams), "x-jordan" / "x-ryan" (former managers), "guest-<random>" (no PIN).
const crypto = require("crypto");

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN = process.env.ADMIN_KEY || "";
const COLLECTIONS = ["votes", "talk"];
const EXTRA = ["jordan", "ryan"];
const GUESTS_PER_DAY = 6; // new guest sign-ins allowed per internet connection per day

async function redis(...cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString("hex");
function send(res, status, body) { res.setHeader("Cache-Control", "no-store"); res.status(status).json(body); }
function fail(res, status, code, error) { send(res, status, { code, error }); }
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

// Normalise what the page sends into an account id that may use a PIN.
function pinAccount(b) {
  let a = String(b.acct || "");
  if (!a && /^\d{1,2}$/.test(String(b.rid || ""))) a = "team-" + b.rid; // older pages sent a team number
  const m = /^team-(\d{1,2})$/.exec(a);
  if (m && +m[1] >= 1 && +m[1] <= 20) return a;
  const x = /^x-([a-z]+)$/.exec(a);
  if (x && EXTRA.includes(x[1])) return a;
  return null;
}
// Older sign-ins stored a bare team number.
const normAcct = (v) => (v == null ? null : /^\d+$/.test(String(v)) ? "team-" + v : String(v));

function clientIp(req) {
  const f = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return f || String(req.headers["x-real-ip"] || "unknown");
}

module.exports = async (req, res) => {
  if (!URL_ || !TOKEN) return fail(res, 500, "setup", "Vote storage isn't connected yet. The commissioner needs to add Upstash Redis in Vercel's Storage tab.");
  try {
    if (req.method === "GET") {
      const c = String(req.query.c || "");
      if (!COLLECTIONS.includes(c)) return fail(res, 400, "invalid_argument", "Unknown list.");
      const flat = (await redis("HGETALL", "vf:col:" + c)) || [];
      const docs = [];
      for (let i = 0; i < flat.length; i += 2) {
        try { docs.push({ id: flat[i], data: JSON.parse(flat[i + 1]) }); } catch (e) {}
      }
      return send(res, 200, { docs });
    }
    if (req.method !== "POST") return fail(res, 405, "invalid_argument", "Not allowed.");

    const b = await readBody(req);

    if (b.action === "login") {
      const acct = pinAccount(b);
      const pin = String(b.pin || "");
      if (!acct) return fail(res, 400, "invalid_argument", "Pick who you are first.");
      if (!/^\d{4,8}$/.test(pin)) return fail(res, 400, "invalid_argument", "Your PIN needs to be 4 to 8 numbers.");
      const failKey = "vf:fail:" + acct;
      const fails = Number((await redis("GET", failKey)) || 0);
      if (fails >= 8) return fail(res, 429, "rate_limited", "Too many wrong PINs. Wait 15 minutes or ask the commissioner to reset it.");
      const legacy = acct.startsWith("team-") ? acct.slice(5) : null;
      let stored = (await redis("HGET", "vf:pins", acct)) || (legacy ? await redis("HGET", "vf:pins", legacy) : null);
      let created = false;
      if (!stored) {
        const salt = crypto.randomBytes(12).toString("hex");
        const won = await redis("HSETNX", "vf:pins", acct, salt + ":" + hashPin(pin, salt));
        if (won === 1) created = true;
        stored = await redis("HGET", "vf:pins", acct);
      }
      const [salt, hash] = String(stored).split(":");
      if (!created && hashPin(pin, salt) !== hash) {
        await redis("INCR", failKey);
        await redis("EXPIRE", failKey, 900);
        return fail(res, 401, "wrong_pin", "That PIN doesn't match. If this is you and you forgot it, ask the commissioner to reset it.");
      }
      await redis("DEL", failKey);
      const token = crypto.randomBytes(24).toString("hex");
      await redis("HSET", "vf:tokens", token, acct);
      return send(res, 200, { token, acct, created });
    }

    if (b.action === "guest") {
      const ipKey = "vf:gip:" + crypto.createHash("sha256").update(clientIp(req)).digest("hex").slice(0, 24);
      const n = await redis("INCR", ipKey);
      if (n === 1) await redis("EXPIRE", ipKey, 86400);
      if (n > GUESTS_PER_DAY) return fail(res, 429, "rate_limited", "Too many guest sign-ins from here today. Try again tomorrow.");
      const acct = "guest-" + crypto.randomBytes(6).toString("hex");
      const token = crypto.randomBytes(24).toString("hex");
      await redis("HSET", "vf:tokens", token, acct);
      return send(res, 200, { token, acct, created: true });
    }

    if (b.action === "set") {
      const acct = b.token ? normAcct(await redis("HGET", "vf:tokens", String(b.token))) : null;
      if (!acct) return fail(res, 401, "unauthenticated", "Sign in again to vote.");
      const [col, id, extra] = String(b.path || "").split("/");
      if (!COLLECTIONS.includes(col) || id !== acct || extra !== undefined) return fail(res, 403, "invalid_argument", "You can only save your own picks.");
      if (!acct.startsWith("team-")) return fail(res, 403, "invalid_argument", "Only current league managers can vote or post. Guests and former managers can follow along.");
      const data = b.data && typeof b.data === "object" ? b.data : null;
      if (!data) return fail(res, 400, "invalid_argument", "Nothing to save.");
      data.uid = acct;
      // Managers can't vote their own matchup for game of the week (from 2026 week 9 on): drop any such vote.
      const own = /^team-(\d+)$/.exec(acct);
      if (col === "votes" && own && data.gotw && typeof data.gotw === "object") {
        for (const [wk, key] of Object.entries(data.gotw)) {
          const [s, w] = String(wk).split("-").map(Number);
          if ((s > 2026 || (s === 2026 && w >= 9)) && String(key).split("-").map(Number).includes(+own[1])) delete data.gotw[wk];
        }
      }
      const json = JSON.stringify(data);
      if (json.length > 30000) return fail(res, 413, "quota_exceeded", "That's too much to save at once.");
      await redis("HSET", "vf:col:" + col, acct, json);
      return send(res, 200, { ok: true });
    }

    if (b.action === "reset") {
      if (!ADMIN || ADMIN.length < 6 || String(b.admin || "") !== ADMIN) return fail(res, 403, "forbidden", "Wrong commissioner password.");
      const acct = pinAccount(b);
      if (!acct) return fail(res, 400, "invalid_argument", "Pick who to reset.");
      await redis("HDEL", "vf:pins", acct);
      if (acct.startsWith("team-")) await redis("HDEL", "vf:pins", acct.slice(5));
      const flat = (await redis("HGETALL", "vf:tokens")) || [];
      for (let i = 0; i < flat.length; i += 2) if (normAcct(flat[i + 1]) === acct) await redis("HDEL", "vf:tokens", flat[i]);
      return send(res, 200, { ok: true });
    }

    return fail(res, 400, "invalid_argument", "Unknown request.");
  } catch (e) {
    return fail(res, 500, "failed", "The vote server hit a snag. Try again in a minute.");
  }
};
