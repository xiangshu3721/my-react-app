import assert from "node:assert/strict";
import test from "node:test";
import { ASSESSMENT_CLOUD_CONFIG } from "./cloud-client.js";
import {
  backoffMs,
  buildShareUrl,
  createCloudStore,
  createSubmissionIds,
  gateSubmit,
  parseShareLink,
  resolveEndpoint,
  resolveReportBase,
  sefsOrderKey,
} from "./cloud-client.js";

function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

test("未同意或没有服务地址时不提交", () => {
  assert.equal(gateSubmit({ agreed: false, endpoint: "http://127.0.0.1:4173", nickname: "小林" }).reason, "consent");
  assert.equal(gateSubmit({ agreed: true, endpoint: "", nickname: "小林" }).reason, "endpoint");
  assert.equal(gateSubmit({ agreed: true, endpoint: "http://127.0.0.1:4173", nickname: "" }).reason, "nickname");
  assert.equal(gateSubmit({ agreed: true, endpoint: "http://127.0.0.1:4173", nickname: "小林" }).ok, true);
});

test("分享秘密只放在 hash，旧长链和 75 字短链都能解析", () => {
  const ids = createSubmissionIds();
  assert.match(ids.reportId, /^rpt_[A-Za-z0-9_-]{11}$/);
  assert.match(ids.linkSecret, /^[A-Za-z0-9_-]{16}$/);
  assert.match(ids.ownerToken, /^[A-Za-z0-9_-]{24}$/);
  const url = buildShareUrl(ASSESSMENT_CLOUD_CONFIG.reportPageBase, ids.reportId, ids.linkSecret);
  assert.equal(url.startsWith("https://xiangshu3721.github.io/mindtest-web/r/#"), true);
  assert.equal(url.includes("rpt_"), false);
  assert.equal(url.length, 75);
  assert.equal(parseShareLink(url).reportId, ids.reportId);
  assert.equal(parseShareLink(url).linkSecret, ids.linkSecret);

  const legacy = "https://xiangshu3721.github.io/mindtest-web/r/#rpt_abcdefghijklmnopqrstuvwx.0123456789abcdefghijklmnopqrstuvwxyz0123456";
  const previous = buildShareUrl(
    "https://xiangshu3721.github.io/mindtest-web/r/",
    `rpt_${"a".repeat(16)}`,
    "b".repeat(22),
  );
  assert.equal(parseShareLink(legacy).reportId, "rpt_abcdefghijklmnopqrstuvwx");
  assert.equal(parseShareLink(legacy).linkSecret.length, 43);
  assert.equal(parseShareLink(previous).reportId, `rpt_${"a".repeat(16)}`);
  assert.equal(parseShareLink(`#${"a".repeat(10)}.${"b".repeat(16)}`), null);
  assert.equal(parseShareLink(`#${"a".repeat(11)}.${"b".repeat(15)}`), null);
  assert.equal(sefsOrderKey("rabc"), "sefs:rabc");
});

test("同一条待提交可以重试，正式接口是 assessment-report-dev", () => {
  const cloud = createCloudStore(memoryStorage());
  cloud.upsertPending({ reportId: "rpt_abcdefghijk", orderKey: sefsOrderKey("r1"), attempts: 1 });
  cloud.upsertPending({ reportId: "rpt_abcdefghijk", orderKey: sefsOrderKey("r1"), attempts: 2 });
  assert.equal(cloud.pending().length, 1);
  assert.equal(cloud.pending()[0].attempts, 2);
  assert.equal(backoffMs(1), 5000);
  assert.equal(backoffMs(2), 30000);
  assert.equal(backoffMs(3), 120000);
  cloud.removePending("rpt_abcdefghijk");
  assert.equal(cloud.pending().length, 0);
  assert.equal(
    ASSESSMENT_CLOUD_CONFIG.endpoint,
    "https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/assessment-report-dev",
  );
  assert.equal(ASSESSMENT_CLOUD_CONFIG.reportPageBase, "https://xiangshu3721.github.io/mindtest-web/r/");
  const base = resolveReportBase(
    { hostname: "xiangshu3721.github.io", origin: "https://xiangshu3721.github.io" },
    ASSESSMENT_CLOUD_CONFIG,
  );
  assert.equal(
    buildShareUrl(base, "rpt_abcdefghijk", "ownersecretvalue1"),
    "https://xiangshu3721.github.io/mindtest-web/r/#abcdefghijk.ownersecretvalue1",
  );
  assert.equal(resolveEndpoint({ hostname: "127.0.0.1", origin: "http://127.0.0.1:4173" }, {}), "http://127.0.0.1:4173");
  assert.equal(resolveEndpoint({ hostname: "xiangshu3721.github.io" }, {}), "");
  assert.equal(resolveEndpoint({ hostname: "xiangshu3721.github.io" }, ASSESSMENT_CLOUD_CONFIG), ASSESSMENT_CLOUD_CONFIG.endpoint);
});
