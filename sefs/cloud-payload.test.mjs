import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { ASSESSMENT_NAME, READER_GAP, buildSefsResult, levelOf, scoreAnswers } from "./cloud-payload.js";

async function dims() {
  const code = await readFile(new URL("./data.js", import.meta.url), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox);
  return sandbox.window.SEFS_DIMS;
}

function base(extra) {
  return {
    nickname: "小林",
    reportId: "rpt_abcdefghijk",
    clientSubmissionId: "sub_abcdefghijklmnop",
    completedAt: "2026-10-22T12:00:00+08:00",
    ...extra,
  };
}

test("SEFS 协议带四维分数、结论和阅读页缺口，不改分段算法", async () => {
  const app = await readFile(new URL("./app.js", import.meta.url), "utf8");
  const page = await readFile(new URL("./index.html", import.meta.url), "utf8");
  assert.equal(app.includes('score<=7?"功能基本完好":score<=11?"轻度受损":score<=18?"中度受损":"重度受损"'), true);
  assert.equal(app.includes("s>=15"), true);
  assert.equal(app.includes("不会上传"), false);
  assert.equal(page.includes("不会上传"), false);
  assert.equal(page.includes('id="sefsCloud"'), true);
  assert.equal(page.includes("cloud-boot.js?v=5"), true);
  assert.equal(levelOf(7), "功能基本完好");
  assert.equal(levelOf(8), "轻度受损");
  assert.equal(levelOf(11), "轻度受损");
  assert.equal(levelOf(12), "中度受损");
  assert.equal(levelOf(18), "中度受损");
  assert.equal(levelOf(19), "重度受损");

  const list = await dims();
  const answers = Array(24).fill(0);
  for (let i = 6; i < 12; i += 1) answers[i] = 3;
  const scored = scoreAnswers(answers);
  assert.deepEqual(scored.scores, [0, 18, 0, 0]);
  assert.equal(scored.total, 18);
  assert.deepEqual(scored.leaders, [1]);
  assert.equal(scored.complex, false);

  const report = buildSefsResult(base({ answers, dims: list }));
  assert.equal(report.assessmentId, "sefs");
  assert.equal(report.assessmentName, ASSESSMENT_NAME);
  assert.equal(report.assessmentName, "SEFS · 主观体验功能状态量表");
  assert.equal(report.schemaVersion, "1.0.0");
  assert.equal(report.result.headline, "相对突出的体验方向：体验容纳（体验泛滥型）");
  assert.equal(report.result.summary.includes(list[1].suggest), true);
  assert.equal(report.result.summary.includes("未达到"), true);
  assert.equal(report.result.code, null);
  assert.deepEqual(report.dimensions.map((item) => item.score), [0, 18, 0, 0]);
  assert.deepEqual(report.reportContent.viewModel.answers, answers);
  assert.equal(JSON.stringify(report).includes(READER_GAP), true);
  assert.equal(report.extensionData.compat.level, "partial");
  assert.equal(report.source.origin, "external-repo");
  assert.equal(report.source.resultKitId, "sefs");
  assert.equal(JSON.stringify(report).includes("13800000000"), false);
  assert.equal(buildSefsResult(base({ answers, dims: list, nickname: "" })), null);
  assert.equal(buildSefsResult(base({ answers: answers.slice(0, 23), dims: list })), null);
});

test("并列最高和复合关注沿用结果页文案", async () => {
  const list = await dims();
  const tied = Array(24).fill(1);
  const tiedReport = buildSefsResult(base({ answers: tied, dims: list }));
  assert.equal(tiedReport.result.headline.startsWith("并列最高的体验方向："), true);
  assert.equal(tiedReport.result.flags.includes("tied"), true);
  const complex = Array(24).fill(0);
  for (let i = 0; i < 12; i += 1) complex[i] = 3;
  const complexReport = buildSefsResult(base({ answers: complex, dims: list }));
  assert.equal(complexReport.extensionData.score.complex, true);
  assert.equal(complexReport.result.summary.includes("复合关注"), true);
  assert.equal(complexReport.result.flags.includes("complex"), true);
});
