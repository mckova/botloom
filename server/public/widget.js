/* BotLoom web chat widget. Embed:
 * <script src="https://YOUR-SERVER/widget.js" data-agent="agt_xxx" data-color="#6d5dfc" async></script>
 * No dependencies, Shadow DOM isolated, RTL aware. */
(function () {
  var script = document.currentScript;
  var agentId = script && script.getAttribute("data-agent");
  if (!agentId) return console.warn("[BotLoom] data-agent missing");
  var base = new URL(script.src).origin;
  var color = script.getAttribute("data-color") || "#6d5dfc";
  var key = "botloom_visitor_" + agentId;
  var visitor = localStorage.getItem(key);
  if (!visitor) {
    visitor = "v-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(key, visitor);
  }
  var host = document.createElement("div");
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" +
    ":host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif}" +
    ".fab{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;border:0;background:" + color + ";color:#fff;font-size:26px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:2147483646}" +
    ".panel{position:fixed;bottom:88px;right:20px;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;z-index:2147483647}" +
    ".panel.open{display:flex}.head{background:" + color + ";color:#fff;padding:14px 16px;font-weight:600}" +
    ".log{flex:1;overflow:auto;padding:12px;background:#f6f6fb;display:flex;flex-direction:column;gap:8px}" +
    ".b{max-width:80%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;line-height:1.4;font-size:14px;unicode-bidi:plaintext}" +
    ".bot{background:#fff;align-self:flex-start;border:1px solid #e6e6ef}.me{background:" + color + ";color:#fff;align-self:flex-end}" +
    ".btns{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start}.btns button{border:1px solid " + color + ";color:" + color + ";background:#fff;border-radius:999px;padding:6px 12px;cursor:pointer;font-size:13px}" +
    "form{display:flex;border-top:1px solid #eee}input{flex:1;border:0;padding:14px;font-size:14px;outline:none;unicode-bidi:plaintext}form button{border:0;background:none;color:" + color + ";font-weight:600;padding:0 16px;cursor:pointer}" +
    ".typing{color:#888;font-size:12px;padding:0 4px}" +
    "</style>" +
    "<button class='fab' aria-label='Chat'>💬</button>" +
    "<div class='panel' role='dialog'><div class='head'>Chat</div><div class='log'></div>" +
    "<form><input placeholder='Type a message…' aria-label='Message'/><button>Send</button></form></div>";
  var panel = root.querySelector(".panel");
  var log = root.querySelector(".log");
  var input = root.querySelector("input");
  var started = false;

  fetch(base + "/widget/" + agentId + "/info").then(function (r) { return r.json(); }).then(function (info) {
    root.querySelector(".head").textContent = info.name;
    if (info.language === "he") {
      panel.setAttribute("dir", "rtl");
      input.placeholder = "כתבו הודעה…";
      root.querySelector("form button").textContent = "שליחה";
    }
  }).catch(function () {});

  function bubble(text, who) {
    var d = document.createElement("div");
    d.className = "b " + who;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  function render(messages) {
    messages.forEach(function (m) {
      if (m.text) bubble(m.text, "bot");
      if (m.buttons && m.buttons.length) {
        var wrap = document.createElement("div");
        wrap.className = "btns";
        m.buttons.forEach(function (b) {
          var btn = document.createElement("button");
          btn.textContent = b.label;
          btn.onclick = function () { wrap.remove(); send(b.label, b.id); };
          wrap.appendChild(btn);
        });
        log.appendChild(wrap);
      }
    });
    log.scrollTop = log.scrollHeight;
  }
  function send(text, buttonId) {
    if (text) bubble(text, "me");
    var t = document.createElement("div");
    t.className = "typing";
    t.textContent = "…";
    log.appendChild(t);
    fetch(base + "/widget/" + agentId + "/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId: visitor, text: text, buttonId: buttonId }),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) { t.remove(); render(res.messages || []); })
      .catch(function () { t.remove(); bubble("Connection error", "bot"); });
  }
  root.querySelector(".fab").onclick = function () {
    panel.classList.toggle("open");
    if (!started && panel.classList.contains("open")) {
      started = true;
      // Restore a returning visitor's conversation; otherwise greet (runs the message trigger with an empty text).
      fetch(base + "/widget/" + agentId + "/history?visitorId=" + encodeURIComponent(visitor))
        .then(function (r) { return r.json(); })
        .then(function (h) {
          var hist = (h && h.history) || [];
          if (!hist.length) return send("", undefined);
          hist.forEach(function (m) { if (m.text) bubble(m.text, m.role === "user" ? "me" : "bot"); });
        })
        .catch(function () { send("", undefined); });
    }
    input.focus();
  };
  root.querySelector("form").onsubmit = function (e) {
    e.preventDefault();
    var v = input.value.trim();
    if (!v) return;
    input.value = "";
    send(v);
  };
})();
