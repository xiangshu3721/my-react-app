import { ASSESSMENT_CLOUD_CONFIG } from "./cloud-client.js";
import {
  backoffMs,
  buildShareUrl,
  createCloudStore,
  createSubmissionIds,
  gateSubmit,
  isoShanghai,
  resolveEndpoint,
  resolveReportBase,
  sefsOrderKey,
} from "./cloud-client.js";
import { buildSefsResult } from "./cloud-payload.js";

const STYLE = `
.sc-share{margin-top:26px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}
.sc-btn{appearance:none;border:0;border-radius:17px;background:#244c40;color:#fff;font:inherit;font-weight:650;font-size:16px;min-height:56px;padding:17px 24px;cursor:pointer;flex:1 1 100%}
.sc-btn:hover{background:#316551}
.sc-btn:focus-visible{outline:3px solid #75b49f;outline-offset:3px}
.sc-btn[aria-busy="true"]{opacity:.72}
.sc-retry{appearance:none;border:0;background:transparent;color:#a65840;font:inherit;font-weight:650;font-size:15px;min-height:44px;padding:8px 2px;text-decoration:underline;cursor:pointer}
.sc-note{flex:1 1 100%;margin:0;font-size:14px;line-height:1.6;color:#52725d}
.sc-note.warn{color:#8f4a37}
@media (min-width:640px){
  .sc-btn{flex:0 0 auto;min-width:168px}
  .sc-note{flex:1 1 auto}
}
`;

let styled = false;
let current = null;
let slotEl = null;
let timer = 0;
let copyTimer = 0;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function config() {
  return { ...ASSESSMENT_CLOUD_CONFIG, ...(globalThis.ASSESSMENT_CLOUD_CONFIG || {}) };
}

function endpoint() {
  return resolveEndpoint(globalThis.location || {}, config());
}

function store() {
  return createCloudStore(globalThis.localStorage);
}

function paint() {
  if (!slotEl || !slotEl.isConnected || !current) return;
  slotEl.innerHTML = view(current);
}

function activeSaved(key) {
  const saved = store().links()[key];
  if (!saved || saved.status !== "active" || !saved.reportUrl) return null;
  return saved;
}

function pendingItem(key) {
  return store().pending().find((item) => item.orderKey === key) || null;
}

function still(generation, key) {
  return Boolean(current && current.generation === generation && current.orderKey === key);
}

function view(input) {
  const saved = activeSaved(input.orderKey);
  const pending = pendingItem(input.orderKey);
  const failed = Boolean(!saved && !input.saving && pending && pending.attempts > 0 && pending.lastError);
  let note = input.note || "";
  if (!note && input.saving && !saved) note = "链接生成中";
  if (!note && failed) note = pending.lastError || "这次没生成链接";
  const warn = Boolean(note && note !== "链接已复制" && note !== "链接生成中");
  const retry = failed ? `<button class="sc-retry" type="button" data-cloud="retry">重试</button>` : "";
  return `
    <div class="sc-share">
      <button class="sc-btn" type="button" data-cloud="share"${input.saving && !saved ? ' aria-busy="true"' : ""}>分享结果</button>
      ${retry}
      ${note ? `<p class="sc-note${warn ? " warn" : ""}">${esc(note)}</p>` : ""}
    </div>
  `;
}

function ensureStyle() {
  if (styled || !globalThis.document) return;
  styled = true;
  const node = globalThis.document.createElement("style");
  node.id = "sefs-cloud-style";
  node.textContent = STYLE;
  globalThis.document.head.appendChild(node);
}

export function mountSefsCloud(slot, input) {
  ensureStyle();
  slotEl = slot;
  const key = sefsOrderKey(input.recordId);
  const previous = current && current.orderKey === key ? current : null;
  current = {
    ...input,
    orderKey: key,
    saving: Boolean(previous && previous.saving),
    note: previous ? previous.note : "",
    generation: previous ? previous.generation : null,
  };
  if (!slot.dataset.bound) {
    slot.dataset.bound = "1";
    slot.addEventListener("click", onClick);
  }
  paint();
  if (current.saving || activeSaved(key)) return;
  const pending = pendingItem(key);
  if (pending && pending.attempts > 0 && pending.attempts < 8) {
    resumePending();
    return;
  }
  void submit();
}

function onClick(event) {
  const button = event.target.closest("[data-cloud]");
  if (!button || !current) return;
  event.stopPropagation();
  const name = button.getAttribute("data-cloud");
  if (name === "retry") {
    retry();
    return;
  }
  if (name !== "share") return;
  if (activeSaved(current.orderKey)) {
    void copyLink();
    return;
  }
  if (current.saving) {
    current.note = "链接生成中，稍后再试";
    paint();
    return;
  }
  retry();
}

function resumePending() {
  if (!current || current.saving || activeSaved(current.orderKey)) return;
  const pending = pendingItem(current.orderKey);
  if (!pending || pending.attempts <= 0 || pending.attempts >= 8) return;
  const wait = Math.max(0, (pending.nextAt || 0) - Date.now());
  clearTimeout(timer);
  timer = setTimeout(() => { void submit(); }, wait);
}

function retry() {
  if (!current || current.saving) return;
  clearTimeout(timer);
  const cloud = store();
  const pending = pendingItem(current.orderKey);
  if (pending) {
    pending.attempts = 0;
    pending.lastError = "";
    pending.nextAt = 0;
    cloud.upsertPending(pending);
  }
  current.note = "";
  void submit();
}

async function submit() {
  if (!current || current.saving) return;
  const key = current.orderKey;
  if (activeSaved(key)) return;
  const cloud = store();
  const target = endpoint();
  const gate = gateSubmit({ agreed: true, endpoint: target, nickname: String(current.nickname || "").trim() });
  if (!gate.ok) {
    rememberError(gate.reason === "nickname" ? "先填昵称，才能分享" : "现在没法生成链接");
    return;
  }
  const generation = {};
  current.generation = generation;
  current.saving = true;
  current.note = "";
  paint();
  let item = null;
  try {
    item = ensurePending(cloud);
    if (!still(generation, key)) return;
    if (!item) {
      rememberError("这一次结果不完整，没法分享");
      return;
    }
    const response = await fetch(`${target}/v1/results`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: item.payload, linkSecret: item.linkSecret, ownerToken: item.ownerToken }),
    });
    if (!still(generation, key)) return;
    const body = await response.json().catch(() => ({}));
    if (!still(generation, key)) return;
    if (response.status === 200 && body.reportId) {
      rememberLink(cloud, item, key, generation);
      return;
    }
    if (response.status === 409) {
      const saved = await fetch(`${target}/v1/results/read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reportId: item.reportId, linkSecret: item.linkSecret }),
      });
      if (!still(generation, key)) return;
      if (saved.status === 200) {
        rememberLink(cloud, item, key, generation);
        return;
      }
      item.lastError = "这次没生成链接";
      item.attempts = 8;
      cloud.upsertPending(item);
      return;
    }
    if (response.status === 422) {
      item.lastError = "这次没生成链接";
      item.attempts = 8;
      cloud.upsertPending(item);
      return;
    }
    failPending(item, response.status === 429 ? "刚才点得太快了，稍后再试" : "这次没生成链接", generation, key);
  } catch {
    if (!still(generation, key)) return;
    if (item) failPending(item, "这次没生成链接", generation, key);
    else rememberError("这次没生成链接");
  } finally {
    if (still(generation, key)) {
      current.saving = false;
      paint();
    }
  }
}

function rememberLink(cloud, item, key, generation) {
  if (!still(generation, key)) return;
  const reportUrl = buildShareUrl(resolveReportBase(globalThis.location, config()), item.reportId, item.linkSecret);
  cloud.removePending(item.reportId);
  cloud.saveLink(key, {
    reportId: item.reportId,
    reportUrl,
    status: "active",
    byteSize: 0,
  });
  current.note = "";
}

function ensurePending(cloud) {
  const found = pendingItem(current.orderKey);
  if (found) return found;
  const ids = createSubmissionIds();
  if (ids.linkSecret === ids.ownerToken) ids.ownerToken = createSubmissionIds().ownerToken;
  const completedAt = current.completedAt || isoShanghai(new Date(current.completedAtMs || Date.now()));
  const payload = buildSefsResult({
    nickname: current.nickname,
    answers: current.answers,
    dims: current.dims || globalThis.SEFS_DIMS,
    reportId: ids.reportId,
    clientSubmissionId: ids.clientSubmissionId,
    completedAt,
  });
  if (!payload) return null;
  const item = {
    ...ids,
    orderKey: current.orderKey,
    payload,
    attempts: 0,
    nextAt: 0,
    lastError: "",
  };
  cloud.upsertPending(item);
  cloud.saveOwner(ids.reportId, ids.ownerToken);
  return item;
}

function failPending(item, message, generation, key) {
  const cloud = store();
  item.attempts += 1;
  item.lastError = message;
  item.nextAt = Date.now() + backoffMs(item.attempts);
  cloud.upsertPending(item);
  if (!still(generation, key)) return;
  current.note = "";
  if (item.attempts < 8) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (still(generation, key)) void submit();
    }, backoffMs(item.attempts));
  }
}

function rememberError(message) {
  if (!current) return;
  current.saving = false;
  current.note = message;
  paint();
}

async function writeClipboard(text) {
  const nav = globalThis.navigator;
  if (nav && nav.clipboard && nav.clipboard.writeText) {
    try {
      await nav.clipboard.writeText(text);
      return;
    } catch {
      /* 下面再试一次系统复制。 */
    }
  }
  const doc = globalThis.document;
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  doc.body.appendChild(area);
  area.select();
  const ok = doc.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("copy");
}

async function copyLink() {
  if (!current) return;
  const saved = activeSaved(current.orderKey);
  if (!saved) return;
  try {
    await writeClipboard(saved.reportUrl);
    current.note = "链接已复制";
  } catch {
    current.note = "没复制上，再点一次";
  }
  paint();
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    if (current && current.note === "链接已复制") {
      current.note = "";
      paint();
    }
  }, 2500);
}
