/* Villains Fantasy on Vercel.
   Stands in for the claude.ai page runtime: league data comes from pub.json,
   votes are saved through /api/db, and each manager signs in with their team + a PIN. */
(function () {
  var TK = "vf-token", RK = "vf-rid";
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  var token = lsGet(TK), acct = lsGet(RK), PUB = null, loaders = {};
  if (acct && /^\d+$/.test(acct)) acct = "team-" + acct; /* older sign-ins stored a team number */
  var EXTRA = ["jordan", "ryan"];

  async function getPub() {
    var r = await fetch("/pub.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("pub");
    PUB = await r.json();
    return PUB;
  }
  async function api(body) {
    var r = await fetch("/api/db", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) { var e = new Error(j.error || "Something went wrong."); e.code = j.code || "failed"; throw e; }
    return j;
  }
  function snap(docs) { return { docs: docs.map(function (d) { return { id: d.id, data: function () { return d.data; } }; }) }; }

  function collection(name) {
    return {
      onSnapshot: function (cb, err) {
        var stopped = false;
        async function load() {
          try {
            var docs;
            if (name === "pub") {
              var p = await getPub();
              docs = Object.keys(p).map(function (id) { return { id: id, data: p[id] }; });
            } else {
              var r = await fetch("/api/db?c=" + encodeURIComponent(name) + "&t=" + Date.now(), { cache: "no-store" });
              if (!r.ok) throw new Error("load");
              docs = (await r.json()).docs;
            }
            if (!stopped) cb(snap(docs));
          } catch (e) { if (err) err(e); }
        }
        loaders[name] = load;
        load();
        var iv = setInterval(function () { if (!document.hidden) load(); }, name === "pub" ? 120000 : 20000);
        document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
        return function () { stopped = true; clearInterval(iv); };
      }
    };
  }

  var db = {
    collection: collection,
    doc: function (path) {
      return {
        set: async function (data) {
          if (!token) { var e = new Error("Sign in first."); e.code = "unauthenticated"; throw e; }
          try { await api({ action: "set", token: token, path: path, data: data }); }
          catch (e) { if (e.code === "unauthenticated") signOut(true); throw e; }
          var col = path.split("/")[0];
          if (loaders[col]) loaders[col]();
        }
      };
    }
  };

  function teams() { return (PUB && PUB.league && PUB.league.teams) || []; }
  function mgrName(key) { var m = PUB && PUB.history && (PUB.history.managers || []).find(function (x) { return x.key === key; }); return m ? m.name : key.charAt(0).toUpperCase() + key.slice(1); }
  function teamOf(a) { var m = /^team-(\d+)$/.exec(a || ""); return m ? teams().find(function (x) { return String(x.rid) === m[1]; }) : null; }
  function acctName(a) {
    if (!a) return "";
    var t = teamOf(a); if (t) return t.name.trim();
    if (/^team-/.test(a)) return "Team " + a.slice(5);
    if (/^x-/.test(a)) return mgrName(a.slice(2));
    if (/^guest-/.test(a)) return "Guest";
    return a;
  }

  var user = {
    id: async function () { return token && acct ? acct : null; },
    can: async function () { return true; }, /* anyone can vote once they sign in with their team + PIN */
    isOwner: async function () { return false; },
    profiles: async function (ids) {
      var out = {};
      ids.forEach(function (id) { var t = teamOf(id); out[id] = { name: t ? t.mgr : /^x-/.test(id) ? mgrName(id.slice(2)) : /^guest-/.test(id) ? "Guest" : "" }; });
      return out;
    }
  };

  var downloads = {
    save: async function (o) {
      var url = URL.createObjectURL(o.data), a = document.createElement("a");
      a.href = url; a.download = o.filename || "download"; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return { ok: true };
    }
  };

  window.claude = { use: async function (n) { return n === "db" ? db : n === "user" ? user : n === "downloads" ? downloads : null; } };

  /* ---------- sign in with team + PIN ---------- */
  var css = document.createElement("style");
  css.textContent =
    ".vf-pill{position:fixed;right:12px;bottom:calc(76px + env(safe-area-inset-bottom,0px));z-index:50;border:0;border-radius:999px;padding:10px 14px;font:600 13px -apple-system,BlinkMacSystemFont,sans-serif;background:var(--gold,#ffc20e);color:#0b1b3a;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".vf-back{position:fixed;inset:0;z-index:60;background:rgba(5,15,35,.6);display:flex;align-items:flex-end;justify-content:center}" +
    ".vf-card{background:#fff;color:#0b1b3a;width:100%;max-width:420px;border-radius:18px 18px 0 0;padding:20px 16px calc(20px + env(safe-area-inset-bottom,0px));font:15px -apple-system,BlinkMacSystemFont,sans-serif;box-sizing:border-box}" +
    "@media(min-width:600px){.vf-back{align-items:center}.vf-card{border-radius:18px}}" +
    ".vf-card h3{margin:0 0 6px;font-size:19px}.vf-card p{margin:0 0 14px;color:#4a5670;font-size:14px;line-height:1.4}" +
    ".vf-card label{display:block;font-weight:600;font-size:13px;margin:12px 0 6px}" +
    ".vf-card select,.vf-card input{width:100%;box-sizing:border-box;font-size:16px;padding:12px;border:1px solid #c9d2e3;border-radius:10px;background:#fff;color:#0b1b3a}" +
    ".vf-go{width:100%;margin-top:16px;border:0;border-radius:10px;padding:13px;font-size:16px;font-weight:700;background:#0b3d91;color:#fff;cursor:pointer}" +
    ".vf-go:disabled{opacity:.6}.vf-msg{min-height:20px;margin-top:10px;font-size:14px;color:#b3261e}" +
    ".vf-row{display:flex;justify-content:space-between;margin-top:14px}.vf-link{background:none;border:0;color:#0b3d91;font-size:14px;padding:6px 0;cursor:pointer}";
  document.head.appendChild(css);

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "text") e.textContent = attrs[k]; else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  var pill = el("button", { class: "vf-pill", type: "button" });
  function drawPill() {
    pill.textContent = token && acct ? "Signed in: " + acctName(acct) : "Sign in to vote";
    pill.onclick = function () { token && acct ? openAccount() : openSignIn(); };
  }
  function mount() { document.body.appendChild(pill); drawPill(); getPub().then(drawPill).catch(function () {}); }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

  function sheet(children) {
    var back = el("div", { class: "vf-back", role: "dialog", "aria-modal": "true" }, [el("div", { class: "vf-card" }, children)]);
    back.addEventListener("click", function (e) { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
    return back;
  }

  function teamSelect(id, withGuest) {
    var s = el("select", { id: id }, [el("option", { value: "", text: "Pick who you are" })]);
    var g = el("optgroup", { label: "League teams" });
    teams().slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (t) {
      g.appendChild(el("option", { value: "team-" + t.rid, text: t.name.trim() + " (" + t.mgr + ")" }));
    });
    s.appendChild(g);
    var x = el("optgroup", { label: "Former managers" });
    EXTRA.forEach(function (k) { x.appendChild(el("option", { value: "x-" + k, text: mgrName(k) })); });
    s.appendChild(x);
    if (withGuest) s.appendChild(el("optgroup", { label: "Not in the league" }, [el("option", { value: "guest", text: "Guest (no PIN needed)" })]));
    return s;
  }

  async function openSignIn(note) {
    if (!teams().length) { try { await getPub(); } catch (e) {} }
    var sel = teamSelect("vf-team", true);
    var pin = el("input", { id: "vf-pin", type: "password", inputmode: "numeric", autocomplete: "off", maxlength: "8", placeholder: "4 to 8 numbers" });
    var msg = el("div", { class: "vf-msg", role: "status" });
    var go = el("button", { class: "vf-go", type: "button", text: "Sign in" });
    var pinLab;
    var back = sheet([
      el("h3", { text: "Sign in to vote" }),
      el("p", { text: note || "Pick who you are and type your PIN. First time? Make up a PIN now — it becomes yours. Not in the league? Pick Guest." }),
      el("label", { for: "vf-team", text: "Who are you?" }), sel,
      pinLab = el("label", { for: "vf-pin", text: "PIN" }), pin,
      go, msg,
      el("div", { class: "vf-row" }, [
        el("button", { class: "vf-link", type: "button", text: "Cancel", onclick: function () { back.remove(); } }),
        el("button", { class: "vf-link", type: "button", text: "Commissioner", onclick: function () { back.remove(); openAdmin(); } })
      ])
    ]);
    function syncGuest() { var g = sel.value === "guest"; pin.hidden = g; pinLab.hidden = g; go.textContent = g ? "Vote as a guest" : "Sign in"; }
    sel.addEventListener("change", syncGuest);
    async function submit() {
      msg.textContent = "";
      var guest = sel.value === "guest";
      if (!sel.value) { msg.textContent = "Pick who you are first."; return; }
      if (!guest && !/^\d{4,8}$/.test(pin.value)) { msg.textContent = "Your PIN needs to be 4 to 8 numbers."; return; }
      go.disabled = true; go.textContent = "Checking…";
      try {
        var r = guest ? await api({ action: "guest" }) : await api({ action: "login", acct: sel.value, pin: pin.value });
        lsSet(TK, r.token); lsSet(RK, String(r.acct));
        if (r.created) { go.textContent = "PIN saved. Loading…"; }
        location.reload();
      } catch (e) {
        msg.textContent = e.message; go.disabled = false; syncGuest();
      }
    }
    go.onclick = submit;
    pin.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
  }

  function openAccount() {
    var back = sheet([
      el("h3", { text: acctName(acct) }),
      el("p", { text: /^guest-/.test(acct) ? "You're voting as a guest on this phone. Guest votes count in the fan vote but not on the voting record." : "You're signed in on this phone, so you can vote on every matchup." }),
      el("button", { class: "vf-go", type: "button", text: "Sign out", onclick: function () { back.remove(); signOut(false); } }),
      el("div", { class: "vf-row" }, [el("button", { class: "vf-link", type: "button", text: "Close", onclick: function () { back.remove(); } })])
    ]);
  }

  async function openAdmin() {
    if (!teams().length) { try { await getPub(); } catch (e) {} }
    var sel = teamSelect("vf-rteam", false);
    var key = el("input", { id: "vf-key", type: "password", autocomplete: "off", placeholder: "Commissioner password" });
    var msg = el("div", { class: "vf-msg", role: "status" });
    var go = el("button", { class: "vf-go", type: "button", text: "Reset this team's PIN" });
    var back = sheet([
      el("h3", { text: "Commissioner: reset a PIN" }),
      el("p", { text: "Use this if someone forgot their PIN or grabbed the wrong team. They'll make a new PIN the next time they sign in." }),
      el("label", { for: "vf-rteam", text: "Team" }), sel,
      el("label", { for: "vf-key", text: "Commissioner password" }), key,
      go, msg,
      el("div", { class: "vf-row" }, [el("button", { class: "vf-link", type: "button", text: "Close", onclick: function () { back.remove(); } })])
    ]);
    go.onclick = async function () {
      msg.style.color = "#b3261e"; msg.textContent = "";
      if (!sel.value) { msg.textContent = "Pick who to reset."; return; }
      go.disabled = true;
      try { await api({ action: "reset", acct: sel.value, admin: key.value }); msg.style.color = "#1b7a3a"; msg.textContent = "Done. " + acctName(sel.value) + " can make a new PIN now."; }
      catch (e) { msg.textContent = e.message; }
      go.disabled = false;
    };
  }

  function signOut(expired) {
    lsSet(TK, null); lsSet(RK, null); token = null; acct = null;
    if (!expired) location.reload(); else drawPill();
  }

  window.vfSignIn = function (note) { openSignIn(note); };
})();
