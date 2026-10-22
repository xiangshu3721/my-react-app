export const SEFS_VERSION = "sefs-h5-v1";
export const CONSENT_VERSION = "consent-assessment-sefs-1";
export const SCHEMA_VERSION = "1.0.0";
export const ASSESSMENT_ID = "sefs";
export const ASSESSMENT_NAME = "SEFS · 主观体验功能状态量表";
export const READER_GAP = "统一阅读页目前只重绘职业六芒星，SEFS 的阅读页会另开 mindtest-web 任务。链接和存档已按统一协议保存。";

const DIM_IDS = ["breadth", "capacity", "belonging", "autonomy"];

function chars(value) {
  return Array.from(String(value || ""));
}

export function levelOf(score) {
  return score <= 7 ? "功能基本完好" : score <= 11 ? "轻度受损" : score <= 18 ? "中度受损" : "重度受损";
}

/** 与 sefs/app.js 的 calc 同一套草案：四维各 6 题相加，≥15 的维度不少于两个为复合关注。 */
export function scoreAnswers(answers) {
  const scores = [0, 1, 2, 3].map((index) => answers.slice(index * 6, index * 6 + 6).reduce((sum, value) => sum + value, 0));
  const max = Math.max.apply(null, scores);
  const leaders = scores.map((score, index) => (score === max ? index : -1)).filter((index) => index >= 0);
  const complex = scores.filter((score) => score >= 15).length >= 2;
  const total = scores.reduce((sum, score) => sum + score, 0);
  return { scores, total, leaders, complex };
}

function cleanAnswers(list) {
  if (!Array.isArray(list) || list.length !== 24) return null;
  if (list.some((value) => !Number.isInteger(value) || value < 0 || value > 4)) return null;
  return list.slice();
}

function narrative(scored, dims) {
  const names = scored.leaders.map((index) => `${dims[index].title}（${dims[index].type}）`);
  const lead = scored.leaders.length > 1
    ? `并列最高的体验方向：${names.join("、")}`
    : `相对突出的体验方向：${names[0]}`;
  const advice = scored.leaders.length === 1
    ? dims[scored.leaders[0]].suggest
    : "本次有多个并列维度。可以先选一个自己最想了解、最不让你感到负担的方向，慢慢观察。";
  const comp = scored.complex
    ? "按草案规则，有至少两个维度达到 15 分，属于“复合关注”模式。得分排序只是本次观察顺序，不等于临床干预优先级。"
    : "按草案规则，本次未达到“两个及以上维度均不少于 15 分”的复合关注条件。";
  return { lead, advice, comp };
}

/** 把这一次 SEFS 收成统一结果协议。题目算法不在这里重算以外的规则。失败返回 null，不上传。 */
export function buildSefsResult(input) {
  const dims = input.dims || globalThis.SEFS_DIMS;
  const answers = cleanAnswers(input.answers);
  const nickname = String(input.nickname || "").trim();
  if (!answers || !nickname || chars(nickname).length > 12) return null;
  if (!dims || dims.length !== 4) return null;
  if (!input.reportId || !input.clientSubmissionId || !input.completedAt) return null;

  const scored = scoreAnswers(answers);
  const text = narrative(scored, dims);
  const summary = `${text.comp}可以尝试：${text.advice}`;
  const ranking = scored.scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => `${dims[item.index].title} ${item.score}分`)
    .join(" · ");
  const flags = [];
  if (scored.complex) flags.push("complex");
  if (scored.leaders.length > 1) flags.push("tied");

  return {
    reportId: input.reportId,
    assessmentId: ASSESSMENT_ID,
    assessmentName: ASSESSMENT_NAME,
    assessmentVersion: SEFS_VERSION,
    nickname,
    completedAt: input.completedAt,
    dimensions: scored.scores.map((score, index) => ({
      id: DIM_IDS[index],
      name: dims[index].title,
      kind: "score",
      score,
      max: 24,
      level: levelOf(score),
      levelLabel: dims[index].type,
      labels: [],
    })),
    result: {
      headline: text.lead,
      code: null,
      label: "探索性分析 · 非病理诊断",
      summary,
      flags,
    },
    interpretation: [
      { id: "lead", title: null, text: text.lead },
      { id: "pattern", title: null, text: text.comp },
      { id: "ranking", title: null, text: `四维度从高到低：${ranking}。` },
    ],
    recommendations: [
      { id: "try", title: null, text: `可以尝试：${text.advice}` },
      { id: "reader", title: null, text: READER_GAP },
    ],
    reportContent: {
      format: "view-model+sections",
      viewModel: {
        answers: answers.slice(),
        scores: scored.scores.slice(),
        total: scored.total,
        leaders: scored.leaders.slice(),
        complex: scored.complex,
        levels: scored.scores.map((score) => levelOf(score)),
      },
      sections: [
        { t: "h", l: 2, x: text.lead },
        { t: "p", x: `总分 ${scored.total} / 96。它是四个体验维度的简单相加，不设未经验证的总体严重程度阈值。` },
        {
          t: "ul",
          it: scored.scores.map((score, index) => ({
            x: `${dims[index].title} ${score} / 24 · ${levelOf(score)} · ${dims[index].type}`,
            d: 0,
            n: 0,
          })),
        },
        { t: "p", x: text.comp },
        { t: "p", x: `可以尝试：${text.advice}` },
        { t: "p", x: READER_GAP },
      ],
      textFallback: `${text.lead}。总分 ${scored.total} / 96。${summary}。${READER_GAP}`,
    },
    extensionData: {
      answers: answers.slice(),
      score: {
        scores: scored.scores.slice(),
        total: scored.total,
        leaders: scored.leaders.slice(),
        complex: scored.complex,
      },
      consent: {
        agreed: true,
        version: CONSENT_VERSION,
        at: input.completedAt,
        scopes: ["store", "share_link", "mentor_read"],
      },
      compat: { level: "partial", gaps: [READER_GAP] },
    },
    source: {
      site: "ASVA 常用心理测试",
      path: "sefs/index.html",
      repo: "my-react-app",
      origin: "external-repo",
      pageUrl: "https://xiangshu3721.github.io/my-react-app/sefs/",
      clientSubmissionId: input.clientSubmissionId,
      resultKitId: "sefs",
      localKey: "sefs-v1-history",
    },
    schemaVersion: SCHEMA_VERSION,
  };
}
