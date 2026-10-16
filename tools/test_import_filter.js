/**
 * 自测 Step3：词典导入分层过滤 + 排序 + 跳过已知/已掌握（驱动 vocabTest.js 真实 previewDictImport）
 * vocabTest.js 末尾已 module.exports = VocabTest；previewDictImport 挂在 _test 下。
 */
const fs = require("fs");
const path = require("path");

// 1) 模拟浏览器环境 + 可控的 VocabBook（真实接口：word/getWord/isInVocabBook/getAllWords）
global.window = {};
const VB = {
  _recs: [],
  get word() { return this._recs; },        // 真实 VocabBook 用 localStorage 数组，这里用 _recs 装
  getAllWords() { return this._recs; },
  isInVocabBook(w) { return this._recs.some(r => r.word === String(w).toLowerCase()); },
  getWord(w) { return this._recs.find(r => r.word === String(w).toLowerCase()) || null; }
};
global.VocabBook = VB;

const VT = require("D:/产品/AI 新闻单词网站/ai-news-vocab/js/vocabTest.js");
const previewDictImport = VT._test && VT._test.previewDictImport;
if (typeof previewDictImport !== "function") {
  console.log("PREVIEW NOT FOUND. _test keys:", Object.keys(VT._test || {}).slice(0, 30).join(","));
  process.exit(1);
}

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  \u2713 " + msg); }
  else { fail++; console.log("  \u2717 " + msg); }
}
function resetVocab() { VB._recs = []; }
function addVocab(w, status) { VB._recs.push({ word: String(w).toLowerCase(), status: status || "new" }); }

console.log("== 自测 Step3：词典导入分层过滤 ==");

// 构造一本含 rank 的词典词表（模拟 data/tem4.json 的对象数组）
const dictWords = [
  { word: "the", rank: 1 },            // 基础词，应被剥离
  { word: "apple", rank: 2500 },       // 软区间 [hard,soft]，默认剥离
  { word: "serendipity", rank: 9000 }, // 高频外，保留
  { word: "ephemeral", rank: 12000 },  // 更高频外，保留
  { word: "alreadynew", rank: 5000 },  // 软区间外（>soft），保留（假设 vocabSize 较小）
  { word: "knownword", rank: 9001 },   // 已在单词本 known → 跳过（rank 在剥离带外，才能走到"已掌握"判定）
  { word: "masteredword", rank: 9002 },// 已在单词本 mastered → 跳过
  { word: "shellword", rank: 9003 },   // 已在单词本 new（空壳）→ 补全
  { word: "!!!", rank: 100 },          // 纯符号，归一化后为空 → invalid
  { word: "multi word", rank: 7000 }   // 多词词组，应保留
];

// 默认 vocabSize=0 → thresholds hard≈2000, soft≈4000
console.log("\n[1] 默认阈值（vocabSize=0 → hard≈2000 / soft≈4000）");
resetVocab();
addVocab("knownword", "known");
addVocab("masteredword", "mastered");
addVocab("shellword", "new");
const pv1 = previewDictImport(dictWords, { includeSoft: false });
// the(rank1)<2000 → filteredBasic
assert(pv1.filteredBasic.some(o => o.word === "the"), "the(rank1) 被基础词剥离");
// apple(rank2500) 在 [2000,4000] 且默认不开 includeSoft → 剥离
assert(pv1.filteredBasic.some(o => o.word === "apple"), "apple(rank2500) 默认被软区间剥离");
// serendipity/ephemeral/alreadynew/multi word 应进 toImport
assert(pv1.toImport.length === 4, "toImport=4（serendipity/ephemeral/alreadynew/multi word）");
assert(pv1.toImport.some(o => o.word === "multi word"), "多词词组 multi word 被保留");
assert(pv1.toImport.some(o => o.word === "alreadynew"), "alreadynew(rank5000>soft) 保留");
// 已知/已掌握跳过（这些词 rank 在剥离带外，才能走到"已掌握"判定）
assert(pv1.skippedKnown.length === 2, "skippedKnown=2（knownword+masteredword）");
// 空壳补全
assert(pv1.backfill.length === 1 && pv1.backfill[0].word === "shellword", "shellword 进入 backfill（补全）");
// 非法
assert(pv1.invalid.length === 1, "invalid=1（纯符号 !!!）");

console.log("\n[2] 打开「包含基础词」开关后 apple 应进 toImport");
resetVocab();
const pv2 = previewDictImport(dictWords, { includeSoft: true });
assert(pv2.toImport.some(o => o.word === "apple"), "apple 在 includeSoft=true 时进 toImport");
assert(!pv2.filteredBasic.some(o => o.word === "apple"), "apple 不再被剥离");

console.log("\n[3] 阈值随词汇量平移（vocabSize=20000 → hard 变大）");
resetVocab();
// 临时装一个大的 VB 来推高 vocabSize
for (let i = 0; i < 20000; i++) VB._recs.push({ word: "x" + i, status: "new" });
const pv3 = previewDictImport(dictWords, { includeSoft: false });
// vocabSize=20000 → hard≈2000+20*150=5000(夹到6000)，soft=7000。
// 原 apple(rank2500)<5000 → 仍剥离；alreadynew(rank5000) 现在等于 hard 边界 → <hard 剥离
assert(pv3.filteredBasic.some(o => o.word === "apple"), "大词汇量下 apple 仍被剥离（hard 阈值上移）");
assert(pv3.filteredBasic.some(o => o.word === "alreadynew"), "alreadynew(rank5000) 因阈值上移也被剥离");
// 清空
VB._recs = [];

console.log("\n[4] rank 缺失的词默认保留（无法判定为基础词）");
resetVocab();
const pv4 = previewDictImport(
  [{ word: "norankword" }, { word: "another", rank: null }],
  { includeSoft: false }
);
assert(pv4.toImport.length === 2, "无 rank 的词全部保留（2 个进 toImport）");

console.log("\n== 结果: " + pass + " 通过 / " + fail + " 失败 ==");
process.exit(fail === 0 ? 0 : 1);
