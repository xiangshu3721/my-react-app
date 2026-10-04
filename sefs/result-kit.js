/*!
 * result-kit.js · 共用「结果小工具」
 * 作用：把一次测试的结果存到本机（localStorage）、看历史、导出结果长图、重新测试、删除前二次确认。
 * 纯前端，无依赖，不上传任何数据。用法见文件末尾的说明。
 *
 * 每个测试只要做三件事：
 *   1. ResultKit.configure({ id: "scl90", title: "SCL-90 症状自评量表", onRestart: function () { … } })
 *   2. 交卷那一刻：ResultKit.save(summary)         // summary 见下
 *   3. 结果页里放：ResultKit.bar(summary)           // 返回一段 HTML：导出图片 / 历史记录 / 重新测试
 *
 * 昵称门槛（内嵌，不开新页面）：configure 里给 start: ["开始按钮的选择器", …]（或 {sel, text, host}），
 *   kit 会在原有开始页的「开始」按钮前插入昵称输入框，没填昵称时按钮禁用；点开始即确认昵称。
 *   深链/刷新恢复进度直接落在答题页时，每次渲染调用 ResultKit.guard(是否处在答题中, 返回封面的函数)，
 *   会在当前页面最上方内嵌一块输入框补录；重新测试时调 ResultKit.nickReset()。
 * 导出图：configure 时给 capture: function(){ return ResultKit.capture(结果页根节点, {skip:"选择器"}) }，
 *   导出的长图会把结果页展示的全部板块（含图表）画进去，并显示「昵称 的测评结果」。
 *
 * summary = {
 *   headline: "核心结论，一句话",
 *   sub:      "补充说明（可选）",
 *   who:      "署名 / 基本信息（可选）",
 *   metrics:  [{ label: "焦虑", value: "2.1", frac: 0.42, tone: "ok|mid|high" }],   // frac 0~1 画横条，可省
 *   notes:    ["最多 6 条提示（可选）"]
 * }
 */
(function (root) {
  "use strict";

  var MAX = 30;                       // 每个测试最多保留的记录数
  var PREFIX = "rk.v1.";              // localStorage key 前缀，后面接测试 id
  var cfg = { id: "test", title: "测试", site: "ASVA 常用心理测试", onRestart: null, url: "", capture: null, exporter: null, start: null };
  var mem = {};                       // 存不进 localStorage 时，本次访问内仍可查看
  var lastSave = null;                // { ok, reason }
  var cur = null;                     // 结果页当前这份 summary
  var overlay = null;

  var INK = "#241c18", PAPER = "#f3ece4", SHEET = "#faf6f1", GREEN = "#2f5d4a", GOLD = "#b8923f",
      OCHRE = "#9b5b3c", SLATE = "#6f7a72", MUTED = "#4e433d", TRACK = "#e4dccf";
  var SERIF = '"Songti SC","STSong","Noto Serif CJK SC","Noto Serif SC","Source Han Serif SC","SimSun",serif';
  var SANS = '"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif';

  /* ---------- 小工具 ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function fmt(t) {
    var d = new Date(t);
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function uid() { return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function clean(s) {
    s = s || {};
    var out = {
      headline: clip(s.headline, 120), sub: clip(s.sub, 260), who: clip(s.who, 60),
      metrics: [], notes: []
    };
    (s.metrics || []).slice(0, 16).forEach(function (m) {
      if (!m) return;
      var o = { label: clip(m.label, 24), value: clip(m.value, 24) };
      if (typeof m.frac === "number" && isFinite(m.frac)) o.frac = Math.max(0, Math.min(1, m.frac));
      if (m.tone === "ok" || m.tone === "mid" || m.tone === "high") o.tone = m.tone;
      out.metrics.push(o);
    });
    (s.notes || []).slice(0, 6).forEach(function (n) { if (n) out.notes.push(clip(n, 160)); });
    if (s.sec) { var pk = packSections(s.sec); if (pk && pk.length) out.sec = pk; }
    return out;
  }
  function pageUrl() {
    if (cfg.url) return cfg.url;
    try { return (location.host + location.pathname).replace(/index\.html$/, "").replace(/\/$/, ""); } catch (e) { return ""; }
  }

  /* ---------- 存储 ---------- */
  function key() { return PREFIX + cfg.id; }
  function readStore() {
    var raw;
    try { raw = root.localStorage.getItem(key()); } catch (e) { return { items: mem[cfg.id] || [], status: "unavailable" }; }
    if (!raw) return { items: mem[cfg.id] || [], status: "ok" };
    try {
      var d = JSON.parse(raw);
      var arr = d && Array.isArray(d.items) ? d.items : null;
      if (!arr) throw new Error("bad");
      var items = arr.filter(function (r) { return r && typeof r.id === "string" && typeof r.t === "number" && r.s && typeof r.s.headline === "string"; });
      return { items: items, status: "ok" };
    } catch (e) {
      return { items: [], status: "corrupt" };
    }
  }
  function writeStore(items) {
    mem[cfg.id] = items;
    try {
      root.localStorage.setItem(key(), JSON.stringify({ v: 1, items: items }));
      return { ok: true };
    } catch (e) {
      // 空间满：只留最近 10 条再试一次
      try {
        root.localStorage.setItem(key(), JSON.stringify({ v: 1, items: items.slice(0, 10) }));
        return { ok: true, trimmed: true };
      } catch (e2) {
        var q = e2 && (e2.name === "QuotaExceededError" || e2.code === 22 || e2.code === 1014);
        return { ok: false, reason: q ? "quota" : "unavailable" };
      }
    }
  }
  function list() { return readStore().items.sort(function (a, b) { return b.t - a.t; }); }

  /** 保存一次结果。永远不抛错；失败时返回 { ok:false, reason }，结果页照常可看。 */
  function save(summary, opts) {
    var rec = { id: uid(), t: Date.now(), title: cfg.title, s: clean(summary) };
    var nk = getNick(); if (nk) rec.nick = nk;
    if (opts && opts.data !== undefined) rec.d = opts.data;
    var st = readStore();
    var rest = st.items.sort(function (a, b) { return b.t - a.t; });
    // 同一份作答在同一次打开页面里重复交卷（比如返回修改又提交，但答案没变），只更新最新一条，不重复记
    if (opts && opts.key) {
      rec.k = String(opts.key);
      if (rest[0] && rest[0].k === rec.k && Date.now() - rest[0].t < 6 * 3600 * 1000) rest = rest.slice(1);
    }
    var items = [rec].concat(rest).slice(0, MAX);
    var w = writeStore(items);
    lastSave = { ok: w.ok, reason: w.reason || (st.status === "corrupt" ? "recovered" : ""), id: rec.id };
    if (!w.ok) mem[cfg.id] = items;
    scheduleCapture(rec.id);
    return lastSave;
  }
  /** 取结果页当前的全部板块（没配置 capture 就返回 null） */
  function safeCapture() {
    if (typeof cfg.capture !== "function") return null;
    try { var s = cfg.capture(); return s && s.length ? packSections(s) : null; } catch (e) { return null; }
  }
  var capTimers = [];
  /** 结果页渲染出来后，把页面上的全部板块抓下来补进刚存的那条记录（历史里导出同样完整） */
  function scheduleCapture(id) {
    if (typeof cfg.capture !== "function" || !id) return;
    capTimers.forEach(clearTimeout); capTimers = [];
    [80, 450, 1400].forEach(function (ms) {
      capTimers.push(setTimeout(function () {
        if (!lastSave || lastSave.id !== id) return;
        var sec = safeCapture();
        if (sec && sec.length) attachSections(id, sec);
      }, ms));
    });
  }
  function attachSections(id, sec) {
    var st = readStore(), items = st.items, rec = null;
    items.forEach(function (r) { if (r.id === id) rec = r; });
    if (!rec) { (mem[cfg.id] || []).forEach(function (r) { if (r.id === id) rec = r; }); if (!rec) return; }
    rec.s.sec = sec;
    mem[cfg.id] = items.length ? items : mem[cfg.id];
    var put1 = function () { root.localStorage.setItem(key(), JSON.stringify({ v: 1, items: items })); };
    try { put1(); return; } catch (e) {}
    // 空间不够：先放掉较早几条记录里的长图板块（只留摘要），再试
    items.sort(function (a, b) { return b.t - a.t; });
    items.forEach(function (r, i) { if (i >= 3 && r.id !== id && r.s) delete r.s.sec; });
    try { put1(); return; } catch (e2) {}
    delete rec.s.sec;
    try { put1(); } catch (e3) {}
  }
  function removeOne(id) {
    var st = readStore();
    return writeStore(st.items.filter(function (r) { return r.id !== id; }));
  }
  function clearAll() {
    mem[cfg.id] = [];
    try { root.localStorage.removeItem(key()); } catch (e) {}
  }

  /* ---------- 样式 ---------- */
  var cssDone = false;
  function injectCss() {
    if (cssDone) return; cssDone = true;
    var css = [
      ".rk-bar{margin:22px 0 6px;padding:14px 14px 16px;border:1px solid " + GOLD + ";border-radius:4px 16px 4px 16px;background:" + SHEET + ";color:" + INK + ";font-family:" + SANS + ";line-height:1.55}",
      ".rk-bar *{box-sizing:border-box}",
      ".rk-note{margin:0 0 10px;font-size:13px;color:" + MUTED + "}",
      ".rk-note.warn{color:" + OCHRE + "}",
      ".rk-btns{display:flex;flex-wrap:wrap;gap:8px}",
      ".rk-btn{appearance:none;-webkit-appearance:none;border:1px solid " + INK + ";background:transparent;color:" + INK + ";font:inherit;font-size:15px;padding:10px 16px;min-height:44px;border-radius:999px;cursor:pointer;flex:1 1 auto}",
      ".rk-btn.primary{background:" + GREEN + ";border-color:" + GREEN + ";color:#fff}",
      ".rk-btn.danger{border-color:" + OCHRE + ";color:" + OCHRE + "}",
      ".rk-btn:disabled{opacity:.45;cursor:default}",
      ".rk-btn:focus-visible{outline:3px solid " + GOLD + ";outline-offset:2px}",
      ".rk-ov{position:fixed;inset:0;z-index:2147483000;background:rgba(36,28,24,.55);display:flex;align-items:flex-end;justify-content:center;font-family:" + SANS + ";color:" + INK + "}",
      ".rk-ov *{box-sizing:border-box}",
      ".rk-panel{width:100%;max-width:560px;max-height:92vh;max-height:92dvh;background:" + PAPER + ";border-radius:18px 18px 0 0;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 -8px 32px rgba(0,0,0,.25)}",
      "@media (min-width:700px){.rk-ov{align-items:center}.rk-panel{border-radius:18px;max-height:88vh}}",
      ".rk-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid " + TRACK + "}",
      ".rk-head h2{margin:0;flex:1;font:500 18px/1.3 " + SERIF + ";color:" + INK + "}",
      ".rk-x{appearance:none;border:0;background:transparent;font-size:26px;line-height:1;color:" + MUTED + ";min-width:44px;min-height:44px;cursor:pointer}",
      ".rk-body{padding:14px 16px;overflow:auto;-webkit-overflow-scrolling:touch;flex:1}",
      ".rk-foot{display:flex;gap:8px;padding:12px 16px calc(12px + env(safe-area-inset-bottom));border-top:1px solid " + TRACK + ";background:" + PAPER + "}",
      ".rk-empty{text-align:center;color:" + MUTED + ";padding:32px 8px;font-size:15px}",
      ".rk-item{display:flex;gap:8px;align-items:stretch;margin:0 0 10px}",
      ".rk-open{appearance:none;flex:1;text-align:left;border:1px solid " + TRACK + ";background:" + SHEET + ";border-radius:4px 14px 4px 14px;padding:10px 12px;font:inherit;color:" + INK + ";cursor:pointer;min-height:56px}",
      ".rk-open b{display:block;font-size:13px;font-weight:500;color:" + SLATE + "}",
      ".rk-open span{display:block;margin-top:2px;font-size:15px;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}",
      ".rk-del{appearance:none;border:1px solid " + TRACK + ";background:transparent;color:" + OCHRE + ";border-radius:12px;min-width:56px;font:inherit;font-size:14px;cursor:pointer}",
      ".rk-card{background:" + SHEET + ";border:1px solid " + GOLD + ";border-radius:4px 18px 4px 18px;padding:16px 16px 14px}",
      ".rk-card .k{font-size:12px;color:" + SLATE + ";letter-spacing:.12em}",
      ".rk-card h3{margin:4px 0 2px;font:500 20px/1.35 " + SERIF + "}",
      ".rk-card .d{font-size:13px;color:" + SLATE + "}",
      ".rk-card .h{margin:12px 0 4px;padding-top:12px;border-top:2px solid " + GOLD + ";font:600 18px/1.5 " + SERIF + "}",
      ".rk-card .s{margin:0 0 8px;font-size:14px;color:" + MUTED + ";line-height:1.7}",
      ".rk-m{margin:10px 0}",
      ".rk-m .r{display:flex;justify-content:space-between;gap:10px;font-size:14px}",
      ".rk-m .r b{color:" + GREEN + ";font-weight:600;text-align:right}",
      ".rk-m .t{height:8px;border-radius:4px;background:" + TRACK + ";margin-top:5px;overflow:hidden}",
      ".rk-m .t i{display:block;height:100%;border-radius:4px;background:" + GREEN + "}",
      ".rk-m .t i.mid{background:" + GOLD + "}.rk-m .t i.high{background:" + OCHRE + "}",
      ".rk-card ul{margin:8px 0 0;padding-left:18px;font-size:13.5px;color:" + MUTED + ";line-height:1.7}",
      ".rk-dlg{position:fixed;inset:0;z-index:2147483200;background:rgba(36,28,24,.6);display:flex;align-items:center;justify-content:center;padding:20px;font-family:" + SANS + "}",
      ".rk-dlg .box{width:100%;max-width:340px;background:" + PAPER + ";border-radius:4px 22px 4px 22px;padding:20px 18px 16px;color:" + INK + ";border:1px solid " + GOLD + "}",
      ".rk-dlg h3{margin:0 0 6px;font:500 18px/1.4 " + SERIF + "}",
      ".rk-dlg p{margin:0 0 16px;font-size:14px;line-height:1.65;color:" + MUTED + "}",
      ".rk-dlg .row{display:flex;gap:8px}",
      ".rk-img{display:block;max-width:100%;height:auto;margin:0 auto;border-radius:6px;box-shadow:0 2px 14px rgba(36,28,24,.25);-webkit-touch-callout:default;-webkit-user-select:auto;user-select:auto}",
      ".rk-tip{margin:0 0 12px;text-align:center;font-size:14px;line-height:1.6;color:" + INK + "}",
      ".rk-tip b{color:" + GREEN + "}",
      ".rk-nickf,.rk-nickf *{box-sizing:border-box}",
      ".rk-nickf{display:block;width:100%;max-width:520px;margin:14px auto;padding:14px 16px 10px;background:#fff;color:" + INK + ";border:1.5px solid " + GOLD + ";border-radius:14px;text-align:left;font-family:" + SANS + ";font-size:15px;line-height:1.55;position:static}",
      ".rk-nickf .nf-f{display:block;margin:0}.rk-nickf .nf-t{display:block;margin:0 0 8px;font:600 17px/1.4 " + SERIF + ";color:" + INK + "}",
      ".rk-nickf input{display:block;width:100%;min-height:48px;padding:10px 14px;border:1.5px solid " + INK + ";border-radius:12px;background:#fff;color:" + INK + ";font:inherit;font-size:17px;margin:0}",
      ".rk-nickf input:focus-visible{outline:3px solid " + GOLD + ";outline-offset:1px}",
      ".rk-nickf .nf-note{margin:8px 0 0;font-size:13px;line-height:1.6;color:" + MUTED + "}",
      ".rk-nickf .nf-hint{min-height:22px;margin:6px 0 4px;font-size:13px;line-height:1.6;color:" + OCHRE + "}",
      ".rk-nickf .nf-row{display:flex;gap:8px;margin:6px 0 4px}.rk-nickf .nf-row .rk-btn:first-child{flex:0 0 auto}",
      ".rk-nickbar{position:static;display:block;width:100%;padding:12px 14px 4px;background:" + PAPER + ";border-bottom:2px solid " + GOLD + ";z-index:1}",
      ".rk-nickbar .rk-nickf{margin:0 auto}",
      ".rk-nick-off{opacity:.5;cursor:not-allowed}",
      ".rk-nick-block{pointer-events:none;user-select:none;opacity:.45}",
      ".rk-toast{position:fixed;left:50%;bottom:calc(28px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483300;background:" + INK + ";color:#fff;font:14px/1.5 " + SANS + ";padding:10px 16px;border-radius:999px;max-width:86vw;text-align:center}"
    ].join("\n");
    var st = document.createElement("style");
    st.setAttribute("data-rk", "css");
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- 小弹窗 ---------- */
  var toastT;
  function toast(msg) {
    injectCss();
    var t = document.querySelector(".rk-toast");
    if (!t) { t = document.createElement("div"); t.className = "rk-toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.style.display = "block";
    clearTimeout(toastT); toastT = setTimeout(function () { t.style.display = "none"; }, 2600);
  }
  /** 二次确认。opts: { title, text, ok, danger } */
  function confirmBox(opts, cb) {
    injectCss();
    var d = document.createElement("div");
    d.className = "rk-dlg"; d.setAttribute("role", "alertdialog"); d.setAttribute("aria-modal", "true");
    d.innerHTML = '<div class="box"><h3>' + esc(opts.title) + "</h3><p>" + esc(opts.text) + '</p><div class="row">' +
      '<button type="button" class="rk-btn" data-no>取消</button>' +
      '<button type="button" class="rk-btn ' + (opts.danger === false ? "primary" : "danger") + '" data-yes>' + esc(opts.ok || "确定") + "</button></div></div>";
    document.body.appendChild(d);
    function close() { if (d.parentNode) d.parentNode.removeChild(d); }
    d.querySelector("[data-no]").onclick = close;
    d.querySelector("[data-yes]").onclick = function () { close(); cb && cb(); };
    d.addEventListener("click", function (e) { if (e.target === d) close(); });
    d.querySelector("[data-no]").focus();
  }

  /* ---------- 昵称 ---------- */
  var NICK_KEY = PREFIX + "nickname";   // 所有测试共用一个昵称，只存在这台设备里
  var memNick = "", memOk = {};
  function cleanNick(s) {
    s = String(s == null ? "" : s);
    s = s.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff9-\ufffb]/g, " ");
    s = s.replace(/<[^>]*>/g, "").replace(/[<>&"'`\\]/g, "");
    s = s.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    var a = Array.from ? Array.from(s) : s.split("");
    if (a.length > 12) a = a.slice(0, 12);
    return a.join("").replace(/^\s+|\s+$/g, "");
  }
  function getNick() {
    var v = "";
    try { v = root.localStorage.getItem(NICK_KEY) || ""; } catch (e) { v = memNick; }
    return cleanNick(v);
  }
  function setNick(n) {
    n = cleanNick(n); memNick = n;
    try { root.localStorage.setItem(NICK_KEY, n); } catch (e) {}
    return n;
  }
  function okKey() { return PREFIX + "nickok." + cfg.id; }
  function nickConfirmed() {
    var n = getNick(); if (!n) return false;
    var v;
    try { v = root.sessionStorage.getItem(okKey()); } catch (e) { v = memOk[cfg.id]; }
    return v === n;
  }
  function markOk(n) {
    memOk[cfg.id] = n;
    try { root.sessionStorage.setItem(okKey(), n); } catch (e) {}
  }
  /** 重新测试时调用：下一次开始前要重新点一次「开始测评」确认昵称。 */
  function nickReset() {
    delete memOk[cfg.id];
    try { root.sessionStorage.removeItem(okKey()); } catch (e) {}
  }
  /* ---- 昵称输入框：内嵌在每个测评原有的开始页里，不开新页面、不弹窗 ---- */
  var HINT_EMPTY = "先填一个昵称，才能开始（1–12 个字）。", HINT_SPACE = "昵称不能只有空格，请写一个名字或称呼。";
  var typed = null;                      // 还没点「开始」时输入框里正在写的内容（页面重绘后不丢）
  function hintFor(raw) { var v = cleanNick(raw); if (v) return ""; return raw && !/\S/.test(raw) ? HINT_SPACE : HINT_EMPTY; }
  function setOff(b, off) {
    if (!b) return;
    if (off) {
      if (!b.__rkOff) { b.__rkOff = 1; b.__rkWas = !!b.disabled; }
      if (!b.disabled) b.disabled = true;
      if (b.getAttribute("aria-disabled") !== "true") b.setAttribute("aria-disabled", "true");
      b.classList.add("rk-nick-off");
    } else if (b.__rkOff) {
      b.__rkOff = 0; b.disabled = !!b.__rkWas;
      b.removeAttribute("aria-disabled"); b.classList.remove("rk-nick-off");
    }
  }
  /** 生成一个昵称输入块。opts.bar = true 时带「返回 / 开始测评」两个按钮（用于没有封面的页面里补录）。 */
  function makeField(opts) {
    opts = opts || {};
    var el = document.createElement("div");
    el.className = "rk-nickf" + (opts.bar ? " rk-inbar" : ""); el.setAttribute("data-rk-skip", "");
    el.innerHTML = '<label class="nf-f"><span class="nf-t">先告诉我怎么称呼你</span>' +
      '<input type="text" maxlength="12" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" placeholder="你的昵称（1–12 个字）" aria-label="你的昵称（1–12 个字）" data-rk-nick-input></label>' +
      '<p class="nf-note">昵称会写在你的结果和导出的图片上，只存在这台设备里，不会上传。</p>' +
      '<p class="nf-hint" data-rk-nick-hint role="status" aria-live="polite"></p>' +
      (opts.bar ? '<div class="nf-row">' + (typeof opts.onCancel === "function" ? '<button type="button" class="rk-btn" data-rk-nick-back>返回</button>' : "") + '<button type="button" class="rk-btn primary" data-rk-nick-go disabled>开始测评</button></div>' : "");
    var inp = el.querySelector("input"), hint = el.querySelector("[data-rk-nick-hint]");
    var f = { el: el, inp: inp, btns: [], refresh: null };
    inp.value = typed != null ? typed : getNick();
    f.refresh = function () {
      var raw = inp.value, v = cleanNick(raw), h = hintFor(raw);
      typed = raw;
      if (hint.textContent !== h) hint.textContent = h;
      f.btns = f.btns.filter(function (b) { return b.isConnected !== false; });
      f.btns.forEach(function (b) { setOff(b, !v); });
      var go = el.querySelector("[data-rk-nick-go]"); if (go) go.disabled = !v;
    };
    inp.addEventListener("input", f.refresh);
    inp.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      if (!cleanNick(inp.value)) { f.refresh(); return; }
      var go = el.querySelector("[data-rk-nick-go]") || f.btns[0];
      if (go) go.click();
    });
    el.__rk = f;
    return f;
  }

  /* 封面里的「开始」按钮：cfg.start = 选择器或 [{sel, text, host}]，输入框插在按钮（或 host 容器）前面 */
  function startTargets() {
    var out = [], s = cfg.start; if (!s) return out;
    (Array.isArray(s) ? s : [s]).forEach(function (x) {
      var sel = typeof x === "string" ? x : x.sel, re = typeof x === "object" && x.text ? new RegExp(x.text) : null, host = typeof x === "object" ? x.host : null;
      var nodes; try { nodes = document.querySelectorAll(sel); } catch (e) { return; }
      Array.prototype.forEach.call(nodes, function (e) {
        if (re && !re.test(e.textContent || "")) return;
        if (e.closest && e.closest(".rk-nickf")) return;
        out.push({ btn: e, anchor: (host && e.closest(host)) || e });
      });
    });
    return out;
  }
  function decorate() {
    if (!cfg.start) return;
    // 这一轮已经确认过昵称（比如刚点过封面的开始）：后面的页面不再重复要求，按钮保持可用
    if (nickConfirmed()) { Array.prototype.forEach.call(document.querySelectorAll(".rk-nick-off"), function (b) { setOff(b, false); }); return; }
    startTargets().forEach(function (t) {
      var b = t.btn, p = t.anchor.parentNode; if (!p) return;
      var f = null, k;
      for (k = 0; k < p.children.length; k++) if (p.children[k].classList && p.children[k].classList.contains("rk-nickf") && p.children[k].__rk && !p.children[k].classList.contains("rk-inbar")) { f = p.children[k].__rk; break; }
      if (!f) { injectCss(); f = makeField(); p.insertBefore(f.el, t.anchor); }
      if (f.btns.indexOf(b) < 0) f.btns.push(b);
      b.__rkF = f; if (!b.classList.contains("rk-nick-btn")) b.classList.add("rk-nick-btn");
      f.refresh();
    });
  }
  var decoTimer = 0, decoObs = null;
  function scheduleDecorate() {
    if (decoTimer) return;
    decoTimer = setTimeout(function () { decoTimer = 0; try { decorate(); } catch (e) {} }, 30);
  }
  function watchStart() {
    if (decoObs || typeof MutationObserver === "undefined") { scheduleDecorate(); return; }
    var begin = function () { decoObs = new MutationObserver(scheduleDecorate); decoObs.observe(document.body, { childList: true, subtree: true }); decorate(); };
    if (document.body) begin(); else document.addEventListener("DOMContentLoaded", begin);
  }
  // 点封面上的「开始」：先确认昵称（空的就拦住），再把点击交给页面原来的处理函数
  document.addEventListener("click", function (e) {
    var t = e.target, b = t && t.closest ? t.closest(".rk-nick-btn") : null;
    if (!b || !b.__rkF) return;
    var v = cleanNick(b.__rkF.inp.value);
    if (!v) { e.preventDefault(); e.stopImmediatePropagation(); b.__rkF.refresh(); try { b.__rkF.inp.focus(); } catch (x) {} return; }
    setNick(v); markOk(v); typed = null;
  }, true);

  /* 没有封面可嵌的页面（深链、刷新恢复进度、重新测试后直接进题）：在当前页面最上方内嵌一块输入框，补录之前下面的内容不可操作 */
  var nbar = null, inerted = [];
  function ensureNick(cb, opts) {
    opts = opts || {};
    if (nickConfirmed()) { if (cb) cb(); return; }
    if (nbar) return;
    injectCss();
    var f = makeField({ bar: true, onCancel: opts.onCancel });
    var d = document.createElement("div"); d.className = "rk-nickbar"; d.setAttribute("role", "group"); d.setAttribute("aria-label", "先告诉我怎么称呼你");
    d.appendChild(f.el);
    var go = f.el.querySelector("[data-rk-nick-go]"); f.btns = [];
    function confirmGo() {
      var v = cleanNick(f.inp.value); if (!v) { f.refresh(); f.inp.focus(); return; }
      setNick(v); markOk(v); typed = null; closeNick(); if (cb) cb();
    }
    go.addEventListener("click", confirmGo);
    var back = f.el.querySelector("[data-rk-nick-back]");
    if (back) back.addEventListener("click", function () { closeNick(); opts.onCancel(); });
    nbar = d;
    Array.prototype.forEach.call(document.body.children, function (c) {
      if (c === d || /^(SCRIPT|STYLE|LINK|NOSCRIPT)$/.test(c.tagName) || (c.className && /\brk-(ov|toast)\b/.test(String(c.className)))) return;
      inerted.push([c, c.inert, c.getAttribute("aria-hidden")]);
      try { c.inert = true; } catch (e) {} c.setAttribute("aria-hidden", "true"); c.classList.add("rk-nick-block");
    });
    document.body.insertBefore(d, document.body.firstChild);
    f.refresh();
    try { root.scrollTo(0, 0); } catch (e) {}
    setTimeout(function () { try { f.inp.focus(); f.inp.select(); } catch (e) {} }, 30);
  }
  /** 离开测试页（比如返回首页）时收起补录输入框。 */
  function closeNick() {
    if (nbar && nbar.parentNode) nbar.parentNode.removeChild(nbar);
    nbar = null;
    inerted.forEach(function (x) {
      try { x[0].inert = !!x[1]; } catch (e) {}
      if (x[2] == null) x[0].removeAttribute("aria-hidden"); else x[0].setAttribute("aria-hidden", x[2]);
      x[0].classList.remove("rk-nick-block");
    });
    inerted = [];
  }
  /** 在每次渲染时调用：处于答题中（含深链、刷新恢复进度、重新测试后的第一题）且没确认过昵称，就在当前页面里补录。 */
  function guard(answering, onCancel) {
    if (answering && !nickConfirmed()) ensureNick(null, { onCancel: onCancel });
    else if (!answering && nbar) closeNick();
  }

  /* ---------- 把结果页抓成「分节」 ---------- */
  // 分节：{t:"h",l,x} 标题 · {t:"p",x} 段落 · {t:"ul",it:[{x,d,n}]} 列表 · {t:"table",r:[[…]],hd} 表格 · {t:"row",c:[…]} 一行多格 · {t:"svg",w,h,x} 图表 · {t:"hex",drive:[],pursue:[]} 六芒星
  var SKIP_SEL = "script,style,noscript,template,button,input,select,textarea,[hidden],[data-rk-bar],.rk-bar,.rk-ov,.rk-dlg,.rk-nickf,.rk-nickbar,.rk-toast,[data-rk-skip]";
  function normText(s) { return String(s).replace(/[ \t\r\f\v\u00a0]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, ""); }
  function capture(rootEl, opts) {
    opts = opts || {};
    rootEl = rootEl || document.body;
    if (!rootEl) return null;
    var skip = SKIP_SEL + (opts.skip ? "," + opts.skip : "");
    var out = [], buf = "";
    function matches(el, sel) { try { return el.matches(sel); } catch (e) { return false; } }
    function shown(el, cs) {
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (cs.display === "contents") return true;
      if (el.getClientRects().length) return true;
      return !!el.closest("details");
    }
    function inlineText(el) {
      var t = "";
      (function rec(n) {
        for (var c = n.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) t += c.nodeValue;
          else if (c.nodeType === 1) {
            if (matches(c, skip) || /^(svg|canvas|img)$/i.test(c.tagName)) continue;
            if (c.tagName === "BR") { t += "\n"; continue; }
            var cs = getComputedStyle(c);
            if (!shown(c, cs)) continue;
            var blockish = cs.display !== "inline" && cs.display !== "contents" && cs.display.indexOf("inline") !== 0;
            if (blockish && t && !/[\s]$/.test(t)) t += " ";
            rec(c);
            if (blockish && t && !/[\s]$/.test(t)) t += " ";
          }
        }
      })(el);
      return normText(t);
    }
    function flush() { var t = normText(buf); buf = ""; if (t) out.push({ t: "p", x: t }); }
    var P = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "letter-spacing"];
    function inlineSvg(a, b) {
      if (a.nodeType !== 1) return;
      var cs = getComputedStyle(a), st = "";
      for (var i = 0; i < P.length; i++) { var v = cs.getPropertyValue(P[i]); if (v) st += P[i] + ":" + v + ";"; }
      if (cs.display === "none") st += "display:none;";
      b.setAttribute("style", st);
      var ca = a.children, cb = b.children;
      for (var j = 0; j < ca.length && j < cb.length; j++) inlineSvg(ca[j], cb[j]);
    }
    function svgSection(svg) {
      var r = svg.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
      if (w < 40 || h < 40) return null;
      var c = svg.cloneNode(true);
      inlineSvg(svg, c);
      c.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      c.setAttribute("width", w); c.setAttribute("height", h);
      if (!c.getAttribute("viewBox")) c.setAttribute("viewBox", "0 0 " + w + " " + h);
      c.removeAttribute("class");
      var x = new XMLSerializer().serializeToString(c);
      return x.length > 40000 ? null : { t: "svg", w: w, h: h, x: x };
    }
    function listItems(ul, depth, items) {
      var n = 0, ordered = ul.tagName === "OL";
      for (var li = ul.firstElementChild; li; li = li.nextElementSibling) {
        if (li.tagName !== "LI" || matches(li, skip)) continue;
        var cs = getComputedStyle(li); if (!shown(li, cs)) continue;
        var t = "";
        (function rec(nn) {
          for (var c = nn.firstChild; c; c = c.nextSibling) {
            if (c.nodeType === 3) t += c.nodeValue;
            else if (c.nodeType === 1) {
              if (matches(c, skip) || /^(svg|canvas|img|ul|ol)$/i.test(c.tagName)) continue;
              if (c.tagName === "BR") { t += "\n"; continue; }
              var ccs = getComputedStyle(c); if (!shown(c, ccs)) continue;
              var bl = ccs.display !== "inline" && ccs.display.indexOf("inline") !== 0 && ccs.display !== "contents";
              if (bl && t && !/\s$/.test(t)) t += " ";
              rec(c);
              if (bl && t && !/\s$/.test(t)) t += " ";
            }
          }
        })(li);
        t = normText(t); n++;
        if (t) items.push({ x: t, d: depth, n: ordered ? n : 0 });
        for (var k = li.firstElementChild; k; k = k.nextElementSibling) {
          (function find(e) {
            if (e.tagName === "UL" || e.tagName === "OL") listItems(e, depth + 1, items);
            else if (e.children && !matches(e, skip)) for (var q = e.firstElementChild; q; q = q.nextElementSibling) find(q);
          })(k);
        }
      }
    }
    function isRow(el, cs) {
      if (!/flex|grid/.test(cs.display)) return null;
      var kids = [], total = 0;
      for (var tn = el.firstChild; tn; tn = tn.nextSibling) { if (tn.nodeType === 3 && /\S/.test(tn.nodeValue)) return null; }
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
        if (matches(c, skip)) continue;
        var ccs = getComputedStyle(c); if (!shown(c, ccs)) continue;
        if (/^(svg|canvas|img|ul|ol|table|h[1-6]|p|details)$/i.test(c.tagName)) return null;
        if (c.querySelector("ul,ol,table,h1,h2,h3,h4,h5,h6,p,svg,details")) return null;
        var t = inlineText(c); if (!t) continue;
        if (t.length > 60 || t.indexOf("\n") >= 0) return null;
        total += t.length; kids.push(t);
      }
      return kids.length >= 2 && kids.length <= 6 && total <= 100 ? kids : null;
    }
    function walk(el) {
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { buf += n.nodeValue; continue; }
        if (n.nodeType !== 1) continue;
        if (matches(n, skip)) continue;
        var tag = n.tagName.toLowerCase();
        if (tag === "br") { buf += "\n"; continue; }
        var cs = getComputedStyle(n);
        if (!shown(n, cs)) continue;
        if (tag === "svg") { flush(); var s = svgSection(n); if (s) out.push(s); continue; }
        if (tag === "canvas" || tag === "img" || tag === "video" || tag === "audio" || tag === "iframe") continue;
        if (/^h[1-6]$/.test(tag)) { flush(); var ht = inlineText(n); if (ht) out.push({ t: "h", l: +tag.charAt(1), x: ht }); continue; }
        if (tag === "summary") { flush(); var st = inlineText(n); if (st) out.push({ t: "h", l: 4, x: st }); continue; }
        if (tag === "ul" || tag === "ol") { flush(); var items = []; listItems(n, 0, items); if (items.length) out.push({ t: "ul", it: items }); continue; }
        if (tag === "table") {
          flush();
          var rows = [], hd = 0;
          var trs = n.querySelectorAll("tr");
          for (var i = 0; i < trs.length; i++) {
            var tr = trs[i]; if (matches(tr, skip)) continue;
            var tcs = getComputedStyle(tr); if (!shown(tr, tcs)) continue;
            var cells = [], allTh = true;
            for (var c = tr.firstElementChild; c; c = c.nextElementSibling) {
              if (c.tagName !== "TD" && c.tagName !== "TH") continue;
              if (c.tagName !== "TH") allTh = false;
              cells.push(inlineText(c));
            }
            if (!cells.length) continue;
            if (allTh && rows.length === hd) hd++;
            rows.push(cells);
          }
          if (rows.length) out.push({ t: "table", r: rows, hd: hd });
          continue;
        }
        if (tag === "dl") {
          flush();
          var drows = [], dt = "";
          var dds = n.querySelectorAll("dt,dd");
          for (var di = 0; di < dds.length; di++) {
            var d = dds[di];
            if (matches(d, skip)) continue;
            if (d.tagName === "DT") dt = inlineText(d);
            else { drows.push([dt, inlineText(d)]); dt = ""; }
          }
          if (drows.length) out.push({ t: "table", r: drows, hd: 0, kv: 1 });
          continue;
        }
        var blockish = cs.display !== "inline" && cs.display !== "contents" && cs.display.indexOf("inline") !== 0;
        if (blockish) {
          flush();
          var row = isRow(n, cs);
          if (row) { out.push({ t: "row", c: row }); continue; }
          walk(n); flush();
        } else walk(n);
      }
    }
    walk(rootEl); flush();
    // 去掉紧挨着的完全重复项（比如同一行同时有可视文本和隐藏读屏文本）
    var res = [];
    out.forEach(function (s) { var p = res[res.length - 1]; if (p && p.t === s.t && (s.t === "p" || s.t === "h") && p.x === s.x) return; res.push(s); });
    return res;
  }
  var SEC_CAP = 70000;          // 单条记录里「分节」最多占用的字符数
  function packSections(sec) {
    if (!Array.isArray(sec)) return null;
    var ok = [];
    sec.forEach(function (s) {
      if (!s || typeof s !== "object") return;
      if (s.t === "svg") { if (typeof s.x === "string" && s.w > 0 && s.h > 0) ok.push({ t: "svg", w: +s.w, h: +s.h, x: s.x }); }
      else if (s.t === "hex") ok.push({ t: "hex", drive: (s.drive || []).slice(0, 3).map(String), pursue: (s.pursue || []).slice(0, 3).map(String) });
      else if (s.t === "ul" && Array.isArray(s.it)) ok.push({ t: "ul", it: s.it.filter(function (i) { return i && typeof i.x === "string"; }).map(function (i) { return { x: i.x, d: i.d | 0, n: i.n | 0 }; }) });
      else if (s.t === "table" && Array.isArray(s.r)) ok.push({ t: "table", r: s.r.map(function (r) { return (r || []).map(String); }), hd: s.hd | 0, kv: s.kv ? 1 : 0 });
      else if (s.t === "row" && Array.isArray(s.c)) ok.push({ t: "row", c: s.c.map(String) });
      else if ((s.t === "h" || s.t === "p") && typeof s.x === "string") ok.push({ t: s.t, x: s.x, l: s.l | 0 });
    });
    var size = JSON.stringify(ok).length;
    if (size > SEC_CAP) {   // 先舍掉图表，再不行就保留前面的部分
      ok = ok.filter(function (s) { return s.t !== "svg"; });
      size = JSON.stringify(ok).length;
      while (size > SEC_CAP && ok.length > 1) { ok.pop(); size = JSON.stringify(ok).length; }
    }
    return ok;
  }

  /* ---------- 展示一份 summary（详情页 / 历史里） ---------- */
  function cardHtml(rec) {
    var s = rec.s;
    var h = '<div class="rk-card"><div class="k">' + esc(rec.site || cfg.site) + "</div><h3>" + esc(rec.title || cfg.title) + '</h3><div class="d">' +
      esc(rec.nick ? rec.nick + " 的测评结果 · " : "") + esc(fmt(rec.t)) + (s.who ? " · " + esc(s.who) : "") + '</div><div class="h">' + esc(s.headline) + "</div>";
    if (s.sub) h += '<p class="s">' + esc(s.sub) + "</p>";
    (s.metrics || []).forEach(function (m) {
      h += '<div class="rk-m"><div class="r"><span>' + esc(m.label) + "</span><b>" + esc(m.value) + "</b></div>";
      if (typeof m.frac === "number") h += '<div class="t"><i class="' + (m.tone || "") + '" style="width:' + Math.round(m.frac * 100) + '%"></i></div>';
      h += "</div>";
    });
    if (s.notes && s.notes.length) h += "<ul>" + s.notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul>";
    return h + "</div>";
  }

  /* ---------- 历史面板 ---------- */
  function closeOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    document.documentElement.style.overflow = overlayPrevOverflow || "";
  }
  var overlayPrevOverflow = "";
  function openOverlay(title, bodyHtml, footHtml) {
    injectCss();
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "rk-ov"; overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true");
      overlayPrevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
      overlay.addEventListener("click", function (e) { if (e.target === overlay) closeOverlay(); });
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = '<div class="rk-panel"><div class="rk-head"><h2>' + esc(title) + '</h2><button type="button" class="rk-x" data-rk-close aria-label="关闭">×</button></div>' +
      '<div class="rk-body">' + bodyHtml + "</div>" + (footHtml ? '<div class="rk-foot">' + footHtml + "</div>" : "") + "</div>";
    var first = overlay.querySelector(".rk-open,.rk-btn");
    if (first) try { first.focus({ preventScroll: true }); } catch (e) {}
    return overlay;
  }

  function showHistory() {
    var st = readStore(), items = st.items.sort(function (a, b) { return b.t - a.t; });
    var warn = "";
    if (st.status === "unavailable") warn = '<p class="rk-note warn">这台设备不让浏览器保存记录（可能是无痕模式），下面只有本次打开页面后做的结果。</p>';
    if (st.status === "corrupt") warn = '<p class="rk-note warn">之前保存的记录读不出来了，再做一次测试就会重新开始记录。</p>';
    var body = warn;
    if (!items.length) body += '<div class="rk-empty">还没有记录。<br>做完一次测试，结果会自动留在这里。</div>';
    else body += '<p class="rk-note">最多保留最近 ' + MAX + " 条，只存在这台设备上，不会上传。</p>" + items.map(function (r) {
      return '<div class="rk-item"><button type="button" class="rk-open" data-rk-open="' + esc(r.id) + '"><b>' + esc(fmt(r.t)) + (r.nick ? " · " + esc(r.nick) : "") + "</b><span>" + esc(r.s.headline) + '</span></button><button type="button" class="rk-del" data-rk-del="' + esc(r.id) + '" aria-label="删除这条记录">删除</button></div>';
    }).join("");
    var foot = '<button type="button" class="rk-btn danger" data-rk-clear ' + (items.length ? "" : "disabled") + '>清空全部</button><button type="button" class="rk-btn primary" data-rk-close>关闭</button>';
    openOverlay("历史记录 · " + cfg.title, body, foot);
  }
  function showDetail(id) {
    var rec = list().filter(function (r) { return r.id === id; })[0];
    if (!rec) { showHistory(); return; }
    openOverlay("记录详情", cardHtml(rec),
      '<button type="button" class="rk-btn" data-rk-back>返回列表</button>' +
      '<button type="button" class="rk-btn primary" data-rk-img="' + esc(rec.id) + '">导出图片</button>' +
      '<button type="button" class="rk-btn danger" data-rk-del="' + esc(rec.id) + '" data-from="detail">删除</button>');
  }
  function askDelete(id, fromDetail) {
    var rec = list().filter(function (r) { return r.id === id; })[0];
    if (!rec) { showHistory(); return; }
    confirmBox({ title: "删除这条记录？", text: fmt(rec.t) + " 的这次结果将从这台设备删除，不能恢复。", ok: "删除" }, function () {
      removeOne(id); toast("已删除"); showHistory();
    });
  }
  function askClear() {
    var n = list().length;
    if (!n) return;
    confirmBox({ title: "清空全部历史？", text: "这个测试在这台设备上的 " + n + " 条记录都会删除，不能恢复。", ok: "全部清空" }, function () {
      clearAll(); toast("已清空"); showHistory();
    });
  }

  /* ---------- 导出图片（canvas 自绘，整页内容；太长会自动分成几张） ---------- */
  var W = 750, PADX = 60, CW = W - PADX * 2;
  var lastDrawn = [];                       // 最近一次画进图里的文字（方便自检）
  function put(c, text, x, y) { lastDrawn.push(String(text)); c.fillText(text, x, y); }
  function wrap(ctx, text, maxW) {
    var lines = [];
    String(text).split("\n").forEach(function (para) {
      var line = "";
      for (var i = 0; i < para.length; i++) {
        var ch = para.charAt(i), test = line + ch;
        if (line && ctx.measureText(test).width > maxW) {
          // 英文单词尽量不在中间断开
          var brk = -1;
          if (/[A-Za-z0-9]/.test(ch) && /[A-Za-z0-9]/.test(line.charAt(line.length - 1))) brk = line.search(/[A-Za-z0-9]+$/);
          if (brk > 0) { lines.push(line.slice(0, brk)); line = line.slice(brk) + ch; } else { lines.push(line); line = ch; }
        } else line = test;
      }
      lines.push(line);
    });
    return lines;
  }
  function measureCtx() { var c = document.createElement("canvas"); c.width = 10; c.height = 10; return c.getContext("2d"); }
  function fnt(sz, w, fam) { return (w || "400") + " " + sz + "px " + (fam || SANS); }
  /** 文字块。o: { sz, color, weight, fam, lh, x, maxW, before, after, align } */
  function tb(g, text, o) {
    g.font = fnt(o.sz, o.weight, o.fam);
    var maxW = o.maxW || CW, x = o.x == null ? PADX : o.x, before = o.before || 0, after = o.after || 0, lh = o.lh;
    var ls = wrap(g, text, maxW);
    return {
      h: before + ls.length * lh + after,
      draw: function (c, y) {
        c.font = fnt(o.sz, o.weight, o.fam); c.fillStyle = o.color; c.textBaseline = "alphabetic";
        c.textAlign = o.align || "left";
        var ax = o.align === "right" ? x + maxW : o.align === "center" ? x + maxW / 2 : x;
        ls.forEach(function (ln, i) { put(c, ln, ax, y + before + (i + 1) * lh - (lh - o.sz) / 2 - o.sz * 0.12); });
      }
    };
  }
  function rule(color, w, hgt, before, after) {
    return { h: before + hgt + after, draw: function (c, y) { c.fillStyle = color; c.fillRect(PADX, y + before, w, hgt); } };
  }
  function tableBlocks(g, sec) {
    var rows = sec.r, n = 0, FS = 21, LH = 29, PADC = 9;
    rows.forEach(function (r) { n = Math.max(n, r.length); });
    if (!n) return [];
    g.font = fnt(FS, "400");
    var nat = [];
    for (var i = 0; i < n; i++) { nat[i] = 40; rows.forEach(function (r) { if (r[i] != null) nat[i] = Math.max(nat[i], Math.ceil(g.measureText(String(r[i]).split("\n")[0]).width) + PADC * 2); }); }
    var sum = nat.reduce(function (a, b) { return a + b; }, 0), ws = [];
    if (sum <= CW) { for (i = 0; i < n; i++) ws[i] = nat[i] + (CW - sum) * nat[i] / sum; }
    else {
      for (i = 0; i < n; i++) ws[i] = Math.max(64, nat[i] * CW / sum);
      var s2 = ws.reduce(function (a, b) { return a + b; }, 0);
      for (i = 0; i < n; i++) ws[i] = ws[i] * CW / s2;
    }
    var xs = [], acc = PADX;
    for (i = 0; i < n; i++) { xs[i] = acc; acc += ws[i]; }
    var out = [];
    rows.forEach(function (r, ri) {
      var head = ri < (sec.hd || 0), kvLabel = sec.kv, cells = [], maxL = 1;
      for (var k = 0; k < n; k++) {
        var isB = head || (kvLabel && k === 0);
        g.font = fnt(FS, isB ? "700" : "400");
        var ls = wrap(g, r[k] == null ? "" : r[k], ws[k] - PADC * 2);
        cells.push({ ls: ls, b: isB }); maxL = Math.max(maxL, ls.length);
      }
      var rh = maxL * LH + 14;
      out.push({
        h: rh, draw: function (c, y) {
          if (head) { c.fillStyle = "#ece2d0"; c.fillRect(PADX, y, CW, rh); }
          c.fillStyle = TRACK; c.fillRect(PADX, y + rh - 1, CW, 1);
          c.textAlign = "left"; c.textBaseline = "alphabetic";
          cells.forEach(function (cell, k) {
            c.font = fnt(FS, cell.b ? "700" : "400"); c.fillStyle = cell.b ? INK : MUTED;
            cell.ls.forEach(function (ln, li) { if (ln) put(c, ln, xs[k] + PADC, y + 7 + (li + 1) * LH - 7); });
          });
        }
      });
    });
    out.push({ h: 14, draw: function () {} });
    return out;
  }
  function hexBlock(sec) {
    return {
      h: 470, draw: function (c, y) {
        var cx = W / 2, cy = y + 240, R = 150, k = 0.866;
        function tri(pts, stroke, fill) {
          c.beginPath(); c.moveTo(cx + pts[0][0], cy + pts[0][1]); c.lineTo(cx + pts[1][0], cy + pts[1][1]); c.lineTo(cx + pts[2][0], cy + pts[2][1]); c.closePath();
          c.fillStyle = fill; c.fill(); c.strokeStyle = stroke; c.lineWidth = 3; c.stroke();
        }
        tri([[-k * R, -R / 2], [k * R, -R / 2], [0, R]], GREEN, "rgba(47,93,74,.10)");
        tri([[0, -R], [-k * R, R / 2], [k * R, R / 2]], OCHRE, "rgba(184,146,63,.16)");
        c.textBaseline = "middle"; c.font = fnt(27, "600", SERIF);
        var drive = [[-k * R - 8, -R / 2 - 30, "right"], [k * R + 8, -R / 2 - 30, "left"], [0, R + 34, "center"]];
        var pursue = [[0, -R - 34, "center"], [-k * R - 8, R / 2 + 30, "right"], [k * R + 8, R / 2 + 30, "left"]];
        (sec.drive || []).forEach(function (w, i) { var p = drive[i]; if (!p) return; c.fillStyle = GREEN; c.textAlign = p[2]; put(c, w, cx + p[0], cy + p[1]); });
        (sec.pursue || []).forEach(function (w, i) { var p = pursue[i]; if (!p) return; c.fillStyle = OCHRE; c.textAlign = p[2]; put(c, w, cx + p[0], cy + p[1]); });
        c.font = fnt(20, "500"); c.textAlign = "left"; c.fillStyle = GREEN; put(c, "▽ 底层动力", PADX, y + 28);
        c.textAlign = "right"; c.fillStyle = OCHRE; put(c, "△ 现实追求", W - PADX, y + 28);
        c.textBaseline = "alphabetic";
      }
    };
  }
  function buildBlocks(rec, imgs) {
    var g = measureCtx(), s = rec.s, sec = s.sec && s.sec.length ? s.sec : null;
    var head = [], body = [], foot = [];
    var nick = rec.nick || "匿名";
    head.push({
      h: 108, draw: function (c, y) {
        c.textAlign = "left"; c.font = fnt(21, "500"); c.fillStyle = SLATE; c.textBaseline = "alphabetic";
        put(c, (rec.site || cfg.site).split("").join(" "), PADX, y + 68);
        var sx = W - PADX - 64, sy = y + 36;
        c.fillStyle = GREEN; c.beginPath(); c.moveTo(sx + 8, sy); c.arcTo(sx + 64, sy, sx + 64, sy + 64, 10); c.arcTo(sx + 64, sy + 64, sx, sy + 64, 10); c.arcTo(sx, sy + 64, sx, sy, 10); c.arcTo(sx, sy, sx + 64, sy, 10); c.closePath(); c.fill();
        c.fillStyle = PAPER; c.font = fnt(38, "600", SERIF); c.textAlign = "center"; put(c, "测", sx + 32, sy + 46);
      }
    });
    head.push(tb(g, rec.title || cfg.title, { sz: 46, color: INK, weight: "600", fam: SERIF, lh: 62, maxW: CW - 90, before: 4 }));
    head.push(tb(g, nick + " 的测评结果", { sz: 30, color: GREEN, weight: "600", fam: SERIF, lh: 44, before: 6 }));
    head.push(tb(g, fmt(rec.t) + (s.who ? "  ·  " + s.who : ""), { sz: 22, color: SLATE, lh: 34, before: 2 }));
    head.push(rule(GOLD, 96, 4, 16, 22));
    head.push(tb(g, s.headline, { sz: 36, color: INK, weight: "700", fam: SERIF, lh: 54, after: 6 }));
    if (s.sub) head.push(tb(g, s.sub, { sz: 24, color: MUTED, lh: 40, after: 8 }));
    (s.metrics || []).forEach(function (m) {
      g.font = fnt(25, "700"); var vw = g.measureText(m.value).width;
      g.font = fnt(25, "400");
      var ls = wrap(g, m.label, CW - vw - 24), hasBar = typeof m.frac === "number";
      var h = 42 + (ls.length - 1) * 34 + (hasBar ? 24 : 0) + 8;
      body.push({
        h: h, draw: function (c, y) {
          var yy = y + 34;
          c.textBaseline = "alphabetic"; c.textAlign = "left"; c.font = fnt(25, "400"); c.fillStyle = INK; put(c, ls[0], PADX, yy);
          c.textAlign = "right"; c.font = fnt(25, "700"); c.fillStyle = GREEN; put(c, m.value, W - PADX, yy);
          c.textAlign = "left"; c.font = fnt(25, "400"); c.fillStyle = INK;
          for (var i = 1; i < ls.length; i++) { yy += 34; put(c, ls[i], PADX, yy); }
          if (hasBar) {
            yy += 12; c.fillStyle = TRACK; c.fillRect(PADX, yy, CW, 12);
            c.fillStyle = m.tone === "high" ? OCHRE : m.tone === "mid" ? GOLD : GREEN; c.fillRect(PADX, yy, Math.max(6, CW * m.frac), 12);
          }
        }
      });
    });
    if (sec) {
      body.push(rule(TRACK, CW, 2, 16, 8));
      sec.forEach(function (x, idx) {
        if (x.t === "h") {
          var l = x.l || 3, sz = l <= 1 ? 34 : l === 2 ? 31 : l === 3 ? 28 : 25;
          body.push(tb(g, x.x, { sz: sz, color: INK, weight: "700", fam: l <= 3 ? SERIF : SANS, lh: Math.round(sz * 1.45), before: l <= 2 ? 26 : 18, after: 6 }));
        } else if (x.t === "p") {
          body.push(tb(g, x.x, { sz: 23, color: MUTED, lh: 38, before: 2, after: 8 }));
        } else if (x.t === "ul") {
          x.it.forEach(function (it) {
            var ind = Math.min(it.d, 3) * 28, tx = PADX + 30 + ind;
            var blk = tb(g, (it.n ? it.n + ". " : "") + it.x, { sz: 23, color: MUTED, lh: 38, x: tx, maxW: CW - 30 - ind, after: 4 });
            var inner = blk.draw;
            body.push({ h: blk.h, draw: function (c, y) { inner(c, y); if (!it.n) { c.fillStyle = GOLD; c.beginPath(); c.arc(PADX + 10 + ind, y + 25, 4, 0, 7); c.fill(); } } });
          });
        } else if (x.t === "table") {
          tableBlocks(g, x).forEach(function (b) { body.push(b); });
        } else if (x.t === "row") {
          if (x.c.length === 2) {
            g.font = fnt(23, "700"); var rw = Math.min(g.measureText(x.c[1]).width + 8, CW * 0.45);
            var lb = tb(g, x.c[0], { sz: 23, color: INK, lh: 36, maxW: CW - rw - 20, before: 2, after: 6 });
            var rb = tb(g, x.c[1], { sz: 23, color: GREEN, weight: "700", lh: 36, maxW: rw, x: W - PADX - rw, align: "right", before: 2, after: 6 });
            body.push({ h: Math.max(lb.h, rb.h), draw: function (c, y) { lb.draw(c, y); rb.draw(c, y); } });
          } else {
            tableBlocks(g, { r: [x.c], hd: 0 }).forEach(function (b) { body.push(b); });
          }
        } else if (x.t === "svg" && imgs[idx]) {
          var im = imgs[idx], dw = Math.min(CW, x.w * 1.3), dh = dw * x.h / x.w;
          body.push({ h: dh + 20, draw: function (c, y) { c.drawImage(im, PADX + (CW - dw) / 2, y + 8, dw, dh); } });
        } else if (x.t === "hex") {
          body.push(hexBlock(x));
        }
      });
    } else if (s.notes && s.notes.length) {
      body.push(rule(TRACK, CW, 2, 14, 12));
      s.notes.forEach(function (n) {
        var blk = tb(g, n, { sz: 23, color: MUTED, lh: 38, x: PADX + 28, maxW: CW - 28, after: 6 });
        var inner = blk.draw;
        body.push({ h: blk.h, draw: function (c, y) { inner(c, y); c.fillStyle = GOLD; c.beginPath(); c.arc(PADX + 8, y + 25, 4, 0, 7); c.fill(); } });
      });
    }
    foot.push(rule(GOLD, CW, 2, 30, 38));
    foot.push(tb(g, "认识自己，成为自己，绽放生命！", { sz: 26, color: GREEN, weight: "500", fam: SERIF, lh: 40 }));
    foot.push(tb(g, "仅供自我了解，不是诊断 · 结果只存在你自己的设备里", { sz: 20, color: SLATE, lh: 32, before: 2 }));
    foot.push(tb(g, pageUrl(), { sz: 20, color: SLATE, lh: 32 }));
    foot.push({ h: 30, draw: function () {} });
    return { head: head, body: body, foot: foot, g: g };
  }
  function sumH(a) { return a.reduce(function (t, b) { return t + b.h; }, 0); }
  function drawParts(rec, imgs) {
    var B = buildBlocks(rec, imgs), TOP = 56, BOT = 40, LIMIT = 7000, SINGLE = 9400;
    var parts = [];
    var total = TOP + sumH(B.head) + sumH(B.body) + sumH(B.foot) + BOT;
    if (total <= SINGLE) parts.push(B.head.concat(B.body, B.foot));
    else {
      var cont = function (n) {
        return [tb(B.g, (rec.title || cfg.title) + "（续 " + n + "）", { sz: 24, color: SLATE, weight: "500", fam: SERIF, lh: 36, before: 10, after: 10 }), rule(GOLD, 96, 4, 0, 14)];
      };
      var curB = B.head.slice(), curH = sumH(curB), n = 1;
      B.body.forEach(function (b) {
        if (curH + b.h > LIMIT && curB.length > (parts.length ? 2 : B.head.length)) { parts.push(curB); n++; curB = cont(n); curH = sumH(curB); }
        curB.push(b); curH += b.h;
      });
      parts.push(curB.concat(B.foot));
    }
    lastDrawn = [];
    var urls = [];
    parts.forEach(function (blocks) {
      var H = TOP + sumH(blocks) + BOT, sc = Math.min(2, Math.sqrt(15500000 / (W * H))), url = "";
      for (var attempt = 0; attempt < 4 && (!url || url.length < 200); attempt++) {
        var cv = document.createElement("canvas");
        cv.width = Math.floor(W * sc); cv.height = Math.ceil(H * sc);
        var c = cv.getContext("2d");
        if (!c) { sc *= 0.75; continue; }
        c.scale(sc, sc);
        c.fillStyle = PAPER; c.fillRect(0, 0, W, H);
        c.strokeStyle = INK; c.lineWidth = 2; c.strokeRect(22, 22, W - 44, H - 44);
        c.strokeStyle = GOLD; c.lineWidth = 1; c.strokeRect(30, 30, W - 60, H - 60);
        var y = TOP;
        blocks.forEach(function (b) { b.draw(c, y); y += b.h; });
        try { url = cv.toDataURL("image/png"); } catch (e) { url = ""; }
        if (!url || url.length < 200) sc *= 0.75;
      }
      if (url) urls.push(url);
    });
    if (!urls.length) throw new Error("canvas");
    return urls;
  }
  function renderRecord(rec) {
    var sec = (rec.s && rec.s.sec) || [];
    return Promise.all(sec.map(function (x) {
      if (x.t !== "svg") return null;
      return new Promise(function (res) {
        var im = new Image(); im.onload = function () { res(im); }; im.onerror = function () { res(null); };
        im.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(x.x);
      });
    })).then(function (imgs) { return drawParts(rec, imgs); });
  }
  var inWechat = /MicroMessenger|QQ\//i.test(navigator.userAgent || "");
  function showImages(urls, filename) {
    var many = urls.length > 1;
    var tip = '<p class="rk-tip"><b>长按下面的图片</b>，选「保存到相册」或「保存图片」。' + (many ? "图比较长，已分成 " + urls.length + " 张，请依次保存。" : "") + "</p>";
    var body = tip + urls.map(function (u, i) {
      return '<img class="rk-img" style="margin-bottom:12px" alt="' + esc(cfg.title) + " 结果长图" + (many ? " 第" + (i + 1) + "张" : "") + '" src="' + u + '">';
    }).join("");
    var foot = (inWechat ? "" : urls.map(function (u, i) {
      return '<button type="button" class="rk-btn" data-rk-dl="' + i + '">' + (many ? "下载第" + (i + 1) + "张" : "下载图片") + "</button>";
    }).join("")) + '<button type="button" class="rk-btn primary" data-rk-close>关闭</button>';
    var ov = openOverlay("结果图片", body, foot);
    var dls = ov.querySelectorAll("[data-rk-dl]");
    for (var i = 0; i < dls.length; i++) (function (b) {
      b.onclick = function () {
        var k = +b.getAttribute("data-rk-dl"), a = document.createElement("a");
        a.href = urls[k]; a.download = (filename || "结果").replace(/\.png$/, "") + (many ? "-" + (k + 1) : "") + ".png";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      };
    })(dls[i]);
  }
  function fileName(rec) { return ((rec.nick ? rec.nick + "-" : "") + (rec.title || cfg.title) + "-" + fmt(rec.t).replace(/[^\d]/g, "").slice(0, 12) + ".png").replace(/\s+/g, ""); }
  /** 导出一条记录（结果页当前这份或历史里的某条）。有自定义导出器就用它。 */
  function exportRec(rec) {
    injectCss();
    if (typeof cfg.exporter === "function") {
      var r;
      try { r = cfg.exporter(rec); } catch (e) { toast("这台设备没能生成图片，可以直接截屏保存。"); return Promise.resolve(); }
      if (r !== false) return Promise.resolve(r);      // 返回 false = 这条记录它画不了，交给通用导出
    }
    toast("正在生成图片…");
    return renderRecord(rec).then(function (urls) { hideToast(); showImages(urls, fileName(rec)); return urls; })
      .catch(function () { toast("这台设备没能生成图片，可以直接截屏保存。"); });
  }
  /** 结果页「导出图片」：把 summary（和页面上当前的全部内容）画成图并弹出预览。返回 Promise。 */
  function exportImage(summary, t, extra) {
    var rec = { t: t || Date.now(), title: cfg.title, site: cfg.site, nick: extra && "nick" in extra ? cleanNick(extra.nick) : getNick(), s: clean(summary) };
    var sec = safeCapture();
    if (sec && sec.length) rec.s.sec = sec;
    return exportRec(rec);
  }

  function hideToast() { var t = document.querySelector('.rk-toast'); if (t) t.style.display = 'none'; }
  function exportRecord(id) { var rec = list().filter(function (r) { return r.id === id; })[0]; return rec ? exportRec(rec) : Promise.resolve(); }

  /* ---------- 页面里的按钮条 ---------- */
  function noteHtml() {
    if (lastSave && lastSave.ok) return '<p class="rk-note" data-rk-note="ok">✓ 这次结果已保存在这台设备（不上传），可在「历史记录」里再看。</p>';
    if (lastSave && !lastSave.ok) return '<p class="rk-note warn" data-rk-note="fail">这台设备暂时存不下记录（可能是无痕模式或空间已满）。结果照常能看，建议先点「导出图片」留一份。</p>';
    return '<p class="rk-note" data-rk-note="none">每次做完的结果都会记在「历史记录」里，只存在这台设备上。</p>';
  }
  /** 结果页按钮条（HTML 字符串）。opts.restart === false 不放「重新测试」；opts.export === false 不放「导出图片」（页面已有自己的导出时用）。 */
  function bar(summary, opts) {
    opts = opts || {};
    injectCss();
    cur = clean(summary);
    if (lastSave && lastSave.id && typeof cfg.capture === "function") scheduleCapture(lastSave.id);
    var n = list().length;
    return '<div class="rk-bar" data-rk-bar>' + noteHtml() + '<div class="rk-btns">' +
      (opts.export === false ? "" : '<button type="button" class="rk-btn primary" data-rk="export">导出图片</button>') +
      '<button type="button" class="rk-btn" data-rk="history">历史记录' + (n ? "（" + n + "）" : "") + "</button>" +
      (opts.restart === false ? "" : '<button type="button" class="rk-btn" data-rk="restart">重新测试</button>') +
      "</div></div>";
  }
  /** 封面上的「历史记录」入口（HTML 字符串）。没有记录时返回空串，除非 opts.always。 */
  function historyButton(opts) {
    opts = opts || {};
    var n = list().length;
    if (!n && !opts.always) return "";
    injectCss();
    return '<button type="button" class="' + (opts.className || "rk-btn") + '" data-rk="history">' + (opts.label || "历史记录") + (n ? "（" + n + "）" : "") + "</button>";
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var b;
    if ((b = t.closest("[data-rk]"))) {
      var a = b.getAttribute("data-rk");
      if (a === "export") { if (cur) exportImage(cur); }
      else if (a === "history") showHistory();
      else if (a === "restart") { if (typeof cfg.onRestart === "function") cfg.onRestart(); }
      return;
    }
    if (!overlay) return;
    if (t.closest("[data-rk-close]")) { closeOverlay(); return; }
    if ((b = t.closest("[data-rk-open]"))) { showDetail(b.getAttribute("data-rk-open")); return; }
    if ((b = t.closest("[data-rk-del]"))) { askDelete(b.getAttribute("data-rk-del"), b.getAttribute("data-from") === "detail"); return; }
    if (t.closest("[data-rk-clear]")) { askClear(); return; }
    if (t.closest("[data-rk-back]")) { showHistory(); return; }
    if ((b = t.closest("[data-rk-img]"))) {
      var rec = list().filter(function (r) { return r.id === b.getAttribute("data-rk-img"); })[0];
      if (rec) exportRec(rec);
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      var d = document.querySelector(".rk-dlg");
      if (d) d.parentNode.removeChild(d); else if (overlay) closeOverlay();
    }
  });

  /* ---------- 对外接口 ---------- */
  root.ResultKit = {
    MAX: MAX,
    configure: function (o) { cfg.start = null; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) cfg[k] = o[k]; cur = null; lastSave = null; if (cfg.start) watchStart(); },
    decorate: decorate,
    save: save,
    list: list,
    bar: bar,
    historyButton: historyButton,
    showHistory: showHistory,
    exportImage: exportImage,
    exportRecord: exportRecord,
    showImage: function (u, f) { showImages([u], f); },
    showImages: showImages,
    confirm: confirmBox,
    toast: toast,
    clear: clearAll,
    remove: removeOne,
    lastSave: function () { return lastSave; },
    refreshSections: function () { if (lastSave && lastSave.id) scheduleCapture(lastSave.id); },
    ensureNick: ensureNick,
    closeNick: closeNick,
    guard: guard,
    nickReset: nickReset,
    capture: capture,
    nick: { get: getNick, set: setNick, clean: cleanNick, confirmed: nickConfirmed },
    _drawn: function () { return lastDrawn.slice(); },
    _render: renderRecord
  };
})(window);
