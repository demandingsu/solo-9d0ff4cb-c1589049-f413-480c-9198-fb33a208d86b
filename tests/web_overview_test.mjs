// 网页总览逻辑自测（node 直接运行，无需浏览器）：
//   1. 打开页面即自动刷新总览；
//   2. 响应倒序：多次刷新重叠时只采用最后发起的那次结果；
//   3. 过期请求的失败也不会盖掉新结果；
//   4. 刷新失败：提示重试、保留上一次完整总览，恢复后可再刷新；
//   5. 上传字库/用字表、交印、演示清空成功后都会自动刷新总览。
//
// 运行：node tests/web_overview_test.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "web", "index.html"), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error("web/index.html 中未找到 <script> 块");

// ---- 最小浏览器环境桩 ----
function makeEl(id) {
  return { id, textContent: "", innerHTML: "", className: "", value: "", files: [], style: {} };
}
const els = new Map();
const document = {
  getElementById(id) {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  },
};
const window = { open() {} };
class FormData {
  constructor() { this._d = {}; }
  append(k, v) { this._d[k] = v; }
}
let fetchHandler = async () => { throw new Error("fetch 未配置"); };
const fetchLog = [];
const fetch = (url, opts) => {
  fetchLog.push([ (opts && opts.method) || "GET", url ]);
  return fetchHandler(url, opts || {});
};

const ctx = vm.createContext({ document, window, FormData, fetch, console });

// ---- 工具 ----
const flush = () => new Promise((r) => setImmediate(r));
function deferred() {
  let res, rej;
  const p = new Promise((a, b) => { res = a; rej = b; });
  return { p, res, rej };
}
const okResp = (data) => ({ ok: true, status: 200, json: async () => data });
const errResp = (status, msg) => ({ ok: false, status, json: async () => ({ error: msg }) });
const overview = (tag) => ({
  state: {
    libraries: [{ name: "宋韵楼", edition: "初刻", priority: 1, current: 1 }],
    volumes: [],
    shared_pool: [{ glyph_char: tag, library_name: "宋韵楼", edition: "初刻", matrix_no: "SR-1" }],
  },
  orders: [{ order_no: "MO-" + tag, seq: 1, volume: "册甲", created_at: "t",
             added_count: 1, removed_count: 0 }],
});

let passed = 0;
function check(name, cond) {
  if (!cond) {
    console.error("✗ " + name);
    process.exitCode = 1;
  } else {
    passed++;
    console.log("✓ " + name);
  }
}

// ---- 场景 1：打开页面即自动刷新 ----
const boot = deferred();
fetchHandler = () => boot.p;
vm.runInContext(m[1], ctx); // 顶层会调用一次 refreshOverview()
check("打开页面即发起总览请求",
  fetchLog.some(([method, url]) => method === "GET" && url === "/api/overview"));
boot.res(okResp(overview("甲")));
await flush();
check("首次总览渲染状态区", els.get("stateBox").innerHTML.includes("甲"));
check("首次总览渲染单列表", els.get("ordersBox").innerHTML.includes("MO-甲"));
check("首次成功后无错误提示", els.get("overviewMsg").className === "msg");

// ---- 场景 2：响应倒序，只采用最后发起的结果 ----
const d1 = deferred();
const d2 = deferred();
let n = 0;
fetchHandler = () => (++n === 1 ? d1.p : d2.p);
ctx.refreshOverview(); // 第 1 次（慢，旧数据）
ctx.refreshOverview(); // 第 2 次（快，新数据）
d2.res(okResp(overview("乙"))); // 后发起的先回来
await flush();
check("后发起的先到达：采用新结果", els.get("stateBox").innerHTML.includes("乙"));
d1.res(okResp(overview("丙"))); // 晚到的旧结果
await flush();
check("晚到的旧结果被丢弃（状态区仍为新）",
  els.get("stateBox").innerHTML.includes("乙") && !els.get("stateBox").innerHTML.includes("丙"));
check("晚到的旧结果被丢弃（单列表仍为新）",
  els.get("ordersBox").innerHTML.includes("MO-乙") && !els.get("ordersBox").innerHTML.includes("MO-丙"));

// ---- 场景 3：过期请求的失败也不盖掉新结果 ----
const d3 = deferred();
fetchHandler = (() => { let c = 0; return () => (++c === 1 ? d3.p : Promise.resolve(okResp(overview("丁")))); })();
ctx.refreshOverview(); // 慢请求，稍后才失败
ctx.refreshOverview(); // 快请求，成功
await flush();
check("新结果已应用", els.get("stateBox").innerHTML.includes("丁"));
d3.rej(new Error("旧请求网络错误"));
await flush();
check("过期请求的失败被忽略，仍显示新结果", els.get("stateBox").innerHTML.includes("丁"));
check("过期请求的失败不弹错误", els.get("overviewMsg").className === "msg");

// ---- 场景 4：刷新失败 → 提示重试、保留上一次完整总览；恢复后可再刷新 ----
fetchHandler = async () => okResp(overview("好"));
await ctx.refreshOverview();
await flush();
const goodState = els.get("stateBox").innerHTML;
const goodOrders = els.get("ordersBox").innerHTML;

fetchHandler = async () => { throw new Error("网络中断"); };
await ctx.refreshOverview();
await flush();
check("失败后状态区保留上一次完整总览", els.get("stateBox").innerHTML === goodState);
check("失败后单列表保留上一次完整总览", els.get("ordersBox").innerHTML === goodOrders);
check("失败后出现错误提示", els.get("overviewMsg").className.includes("err"));
check("错误提示要求重试", els.get("overviewMsg").textContent.includes("重试"));

fetchHandler = async () => errResp(500, "保存失败");
await ctx.refreshOverview();
await flush();
check("HTTP 500 同样保留上一次总览", els.get("stateBox").innerHTML === goodState);
check("HTTP 500 提示重试", els.get("overviewMsg").textContent.includes("重试"));

fetchHandler = async () => okResp(overview("新"));
await ctx.refreshOverview();
await flush();
check("恢复后刷新成功并更新", els.get("stateBox").innerHTML.includes("新"));
check("恢复后错误提示被清除", els.get("overviewMsg").className === "msg");

// ---- 场景 5：各操作成功后自动刷新总览 ----
function countOverviewCalls() {
  return fetchLog.filter(([m2, u]) => m2 === "GET" && u === "/api/overview").length;
}
fetchHandler = async (url, opts) => {
  if (url === "/api/libraries") return okResp({ library_count: 1, glyph_count: 2 });
  if (url.endsWith("/chars")) return okResp({ volume: "册甲", char_count: 3 });
  if (url.endsWith("/submit")) return okResp({
    order_no: "MO-X", volume: "册甲", reused: false,
    added: [], removed: [], pool_before: [], pool_after: [],
  });
  if (url === "/api/reset") return okResp({ status: "reset" });
  if (url === "/api/overview") return okResp(overview("刷"));
  throw new Error("未预期请求 " + url);
};

document.getElementById("libFile").files = [{}];
let before = countOverviewCalls();
await ctx.uploadLib();
await flush();
check("上传字库成功后自动刷新总览", countOverviewCalls() === before + 1);

document.getElementById("volName").value = "册甲";
document.getElementById("volFile").files = [{}];
before = countOverviewCalls();
await ctx.uploadVol();
await flush();
check("上传用字表成功后自动刷新总览", countOverviewCalls() === before + 1);

document.getElementById("submitName").value = "册甲";
document.getElementById("idemKey").value = "";
before = countOverviewCalls();
await ctx.submitVol();
await flush();
check("交印成功后自动刷新总览", countOverviewCalls() === before + 1);

before = countOverviewCalls();
await ctx.resetAll();
await flush();
check("演示清空成功后自动刷新总览", countOverviewCalls() === before + 1);
check("演示清空成功给出提示", els.get("demoMsg").className.includes("ok"));

console.log(`\n${passed} 项通过${process.exitCode ? "，存在失败" : ""}`);
