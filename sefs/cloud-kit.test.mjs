import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { mock } from "node:test";
import vm from "node:vm";
import { createCloudStore } from "./cloud-client.js";
import { mountSefsCloud } from "./cloud-kit.js";

mock.timers.enable({ apis: ["setTimeout"] });
globalThis.clearTimeout = () => {};

function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function installDom() {
  const listeners = new Map();
  const slot = {
    dataset: {},
    isConnected: true,
    innerHTML: "",
    addEventListener(type, fn) { listeners.set(type, fn); },
    click(name) {
      listeners.get("click")({
        stopPropagation() {},
        target: {
          closest(sel) {
            if (sel !== "[data-cloud]") return null;
            return { getAttribute: () => name };
          },
        },
      });
    },
  };
  defineGlobal("document", {
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
    createElement() {
      return { id: "", textContent: "", value: "", style: {}, setAttribute() {}, select() {}, remove() {} };
    },
    execCommand() { return false; },
  });
  defineGlobal("localStorage", memoryStorage());
  defineGlobal("location", {
    hostname: "xiangshu3721.github.io",
    origin: "https://xiangshu3721.github.io",
    search: "",
  });
  return slot;
}

let dimsPromise;
function loadDims() {
  if (!dimsPromise) {
    dimsPromise = readFile(new URL("./data.js", import.meta.url), "utf8").then((code) => {
      const sandbox = { window: {} };
      vm.runInNewContext(code, sandbox);
      return sandbox.window.SEFS_DIMS;
    });
  }
  return dimsPromise;
}

function sample(shift = 0) {
  const answers = Array.from({ length: 24 }, (_, index) => (index + shift) % 5);
  return {
    nickname: "小林",
    answers,
    recordId: `r-test-${shift}`,
    completedAtMs: Date.parse("2026-10-22T04:00:00Z"),
  };
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

test("结果页自动提交，只留下分享结果", async () => {
  const source = await readFile(new URL("./cloud-kit.js", import.meta.url), "utf8");
  assert.equal(source.includes("分享结果"), true);
  assert.equal(source.includes("保存并分享这一次"), false);
  assert.equal(source.includes("腾讯云"), false);
  assert.equal(source.includes("我同意"), false);
  assert.equal(source.includes("生成报告链接"), false);

  defineGlobal("SEFS_DIMS", await loadDims());
  const slot = installDom();
  const calls = [];
  let copied = "";
  defineGlobal("navigator", {
    clipboard: { writeText: async (text) => { copied = text; } },
  });
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (String(url).endsWith("/v1/results")) {
      return {
        status: 200,
        json: async () => ({
          reportId: body.result.reportId,
          reportUrl: `https://xiangshu3721.github.io/mindtest-web/r/#${body.result.reportId}.${body.linkSecret}`,
          index: "off",
          byteSize: 4,
        }),
      };
    }
    return { status: 404, json: async () => ({}) };
  };

  const input = sample(0);
  mountSefsCloud(slot, input);
  assert.match(slot.innerHTML, /分享结果/);
  assert.equal(slot.innerHTML.includes("保存并分享"), false);
  assert.equal(slot.innerHTML.includes("我同意"), false);
  await flush();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/assessment-report-dev\/v1\/results$/);
  assert.equal(calls[0].body.result.assessmentId, "sefs");
  assert.equal(calls[0].body.result.assessmentName, "SEFS · 主观体验功能状态量表");
  assert.equal(calls[0].body.result.nickname, "小林");
  assert.equal(typeof calls[0].body.result.result.headline, "string");
  assert.equal(typeof calls[0].body.result.result.summary, "string");
  assert.equal(calls[0].body.result.reportContent.format, "view-model+sections");
  mountSefsCloud(slot, input);
  await flush();
  assert.equal(calls.length, 1);

  slot.click("share");
  await flush();
  assert.match(copied, /^https:\/\/xiangshu3721\.github\.io\/mindtest-web\/r\/#[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{16}$/);
  assert.equal(copied.includes("rpt_"), false);
  assert.equal(copied.length, 75);
  assert.match(slot.innerHTML, /链接已复制/);
  const saved = createCloudStore(globalThis.localStorage).links();
  assert.equal(Object.values(saved)[0].reportUrl, copied);
});

test("同步失败时可以重试，不再出现同意勾选", async () => {
  defineGlobal("SEFS_DIMS", await loadDims());
  const slot = installDom();
  let failed = true;
  const ids = [];
  defineGlobal("navigator", { clipboard: { writeText: async () => {} } });
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    ids.push(body.result.reportId);
    if (failed) throw new Error("offline");
    return {
      status: 200,
      json: async () => ({ reportId: body.result.reportId, index: "off", byteSize: 4 }),
    };
  };
  mountSefsCloud(slot, sample(3));
  await flush();
  assert.match(slot.innerHTML, /重试/);
  assert.match(slot.innerHTML, /这次没生成链接/);
  assert.equal(slot.innerHTML.includes("我同意"), false);
  assert.equal(slot.innerHTML.includes("腾讯云"), false);
  failed = false;
  slot.click("retry");
  await flush();
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(slot.innerHTML.includes("重试"), false);
  slot.click("share");
  await flush();
  assert.match(slot.innerHTML, /链接已复制/);
});

test("链接还在生成时，点分享会提示稍后再试", async () => {
  defineGlobal("SEFS_DIMS", await loadDims());
  const slot = installDom();
  let release;
  defineGlobal("navigator", { clipboard: { writeText: async () => {} } });
  globalThis.fetch = () => new Promise((resolve) => { release = resolve; });
  mountSefsCloud(slot, sample(6));
  assert.match(slot.innerHTML, /aria-busy="true"/);
  assert.match(slot.innerHTML, /链接生成中/);
  slot.click("share");
  assert.match(slot.innerHTML, /链接生成中，稍后再试/);
  release({ status: 200, json: async () => ({ reportId: "rpt_abcdefghijk", index: "off", byteSize: 1 }) });
  await flush();
});
