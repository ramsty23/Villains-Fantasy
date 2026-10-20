// Villains Fantasy vote server (Vercel serverless function).
// Stores votes, team PINs and sign-ins in Upstash Redis (added from Vercel's Storage tab).
const crypto = require("crypto");

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN = process.env.ADMIN_KEY || "";
const COLLECTIONS = ["votes", "talk"];

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

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString("hex");
}
function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}
function fail(res, status, code, error) { send(res, status, { code, error }); }

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
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
      const rid = String(b.rid || "");
      const pin = String(b.pin || "");
      if (!/^\d{1,2}$/.test(rid)) return fail(res, 400, "invalid_argument", "Pick your team first.");
      if (!/^\d{4,8}$/.test(pin)) return fail(res, 400, "invalid_argument", "Your PIN needs to be 4 to 8 numbers.");
      const failKey = "vf:fail:" + rid;
      const fails = Number((await redis("GET", failKey)) || 0);
      if (fails >= 8) return fail(res, 429, "rate_limited", "Too many wrong PINs. Wait 15 minutes or ask the commissioner to reset it.");
      let stored = await redis("HGET", "vf:pins", rid);
      let created = false;
      if (!stored) {
        const salt = crypto.randomBytes(12).toString("hex");
        const won = await redis("HSETNX", "vf:pins", rid, salt + ":" + hashPin(pin, salt));
        if (won === 1) created = true;
        stored = await redis("HGET", "vf:pins", rid);
      }
      const [salt, hash] = String(stored).split(":");
      if (!created && hashPin(pin, salt) !== hash) {
        await redis("INCR", failKey);
        await redis("EXPIRE", failKey, 900);
        return fail(res, 401, "wrong_pin", "That PIN doesn't match this team. If this is your team and you forgot it, ask the commissioner to reset it.");
      }
      await redis("DEL", failKey);
      const token = crypto.randomBytes(24).toString("hex");
      await redis("HSET", "vf:tokens", token, rid);
      return send(res, 200, { token, rid: Number(rid), created });
    }

    if (b.action === "set") {
      const rid = b.token ? await redis("HGET", "vf:tokens", String(b.token)) : null;
      if (!rid) return fail(res, 401, "unauthenticated", "Sign in again to vote.");
      const [col, id, extra] = String(b.path || "").split("/");
      const me = "team-" + rid;
      if (!COLLECTIONS.includes(col) || id !== me || extra !== undefined) return fail(res, 403, "invalid_argument", "You can only save your own team's picks.");
      const data = b.data && typeof b.data === "object" ? b.data : null;
      if (!data) return fail(res, 400, "invalid_argument", "Nothing to save.");
      data.uid = me;
      const json = JSON.stringify(data);
      if (json.length > 30000) return fail(res, 413, "quota_exceeded", "That's too much to save at once.");
      await redis("HSET", "vf:col:" + col, me, json);
      return send(res, 200, { ok: true });
    }

    if (b.action === "reset") {
      if (!ADMIN || ADMIN.length < 6 || String(b.admin || "") !== ADMIN) return fail(res, 403, "forbidden", "Wrong commissioner password.");
      const rid = String(b.rid || "");
      if (!/^\d{1,2}$/.test(rid)) return fail(res, 400, "invalid_argument", "Pick a team.");
      await redis("HDEL", "vf:pins", rid);
      const flat = (await redis("HGETALL", "vf:tokens")) || [];
      for (let i = 0; i < flat.length; i += 2) if (flat[i + 1] === rid) await redis("HDEL", "vf:tokens", flat[i]);
      return send(res, 200, { ok: true });
    }

    return fail(res, 400, "invalid_argument", "Unknown request.");
  } catch (e) {
    return fail(res, 500, "failed", "The vote server hit a snag. Try again in a minute.");
  }
};
