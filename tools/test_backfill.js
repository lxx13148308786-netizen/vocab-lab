/**
 * 自测：VocabBook 补全已有空壳词（Step 4）
 * 复刻「已有空壳词 + 词典导入带释义」的真实场景，验证：
 *  1) batchAdd 对已有空壳词补全缺失的 meaning/pos/rank（不再 skip 整条）；
 *  2) addWord 对已有空壳词同样补全；
 *  3) 用户手动添加且已带释义的完整记录，不会被词典数据覆盖 meaning/pos；
 *  4) phonetic/rank 缺失即补，已有值不覆盖；
 *  5) rebuildBook("keep") 等价于 batchAdd；rebuildBook("overwrite") 清掉非手动词后并入。
 *
 * 仅逻辑层，浏览器实测仍需用户走一遍导入流程。
 */
const path = require("path");

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}
const store = makeStorage();
global.window = { localStorage: store }; // 无 DB / 无 fetch → 云端同步与音标查词自动 no-op

const VocabBook = require("D:/产品/AI 新闻单词网站/ai-news-vocab/js/vocabBook.js");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  \u2713 " + msg); }
  else { fail++; console.log("  \u2717 " + msg); }
}
function rec(word) { return VocabBook.getWord(word); }

console.log("== 自测 Step4：补全已有空壳词 ==");

// 清空环境
store.clear();

console.log("\n[1] batchAdd 补全已有空壳词");
// 模拟历史遗留的空壳词（新闻/旧导入，无释义）
VocabBook.addWord({ word: "abandon", source: "news" });
let shell = rec("abandon");
assert(shell && !shell.meaning, "abandon 初始是空壳（无 meaning）");

// 词典导入带完整数据
const r1 = VocabBook.batchAdd(
  [{ word: "abandon", pos: "v.", meaning: "v. 放弃；抛弃", phonetic: "/əˈbændən/", rank: 1234 }],
  "news"
);
assert(r1.success === 0, "abandon 已存在 → success=0");
assert(r1.backfilled === 1, "abandon → backfilled=1（补全而非跳过）");
assert(r1.skipped === 0, "abandon 不被计入 skipped");
shell = rec("abandon");
assert(shell && shell.meaning === "v. 放弃；抛弃", "abandon.meaning 被补全");
assert(shell && shell.pos === "v.", "abandon.pos 被补全");
assert(shell && shell.rank === 1234, "abandon.rank 被补全");
assert(shell && shell.phonetic === "/əˈbændən/", "abandon.phonetic 被补全");

console.log("\n[2] addWord 单条补全路径");
store.clear();
VocabBook.addWord({ word: "ability", source: "news" });
const r2 = VocabBook.addWord({ word: "ability", pos: "n.", meaning: "n. 能力", rank: 500 });
assert(r2 === true, "addWord 补全返回 true");
const ab = rec("ability");
assert(ab && ab.meaning === "n. 能力", "ability.meaning 被补全");
assert(ab && ab.rank === 500, "ability.rank 被补全");

console.log("\n[3] 用户手动完整记录：meaning/pos 受保护，但缺失 phonetic 仍补");
store.clear();
VocabBook.addWord({ word: "hello", meaning: "用户自己写的释义", source: "manual" });
const r3 = VocabBook.batchAdd(
  [{ word: "hello", meaning: "词典释义会被忽略", pos: "n.", phonetic: "/h/", rank: 9 }],
  "news"
);
assert(r3.backfilled === 1, "hello 触发 backfilled（缺失的 phonetic 仍补）");
assert(r3.skipped === 0, "hello 不计 skipped");
const he = rec("hello");
assert(he && he.meaning === "用户自己写的释义", "hello.meaning 仍是用户原文，未被覆盖");
assert(he && he.pos === "", "hello.pos 未被动（manual 完整记录不回写）");
assert(he && he.phonetic === "/h/", "hello.phonetic 缺失 → 从词典补全");

console.log("\n[4] phonetic / rank 不覆盖已有值，只补缺");
store.clear();
VocabBook.addWord({ word: "world", phonetic: "/wɜːld/", meaning: "n. 世界", source: "news" });
const r4 = VocabBook.batchAdd(
  [{ word: "world", phonetic: "/XXX/", meaning: "新释义", rank: 77 }],
  "news"
);
assert(r4.backfilled === 1, "world 仍有缺失字段被补（rank）");
const wo = rec("world");
assert(wo && wo.phonetic === "/wɜːld/", "world.phonetic 已有值不被覆盖");
assert(wo && wo.rank === 77, "world.rank 被补全（之前为空）");
assert(wo && wo.meaning === "n. 世界", "world.meaning 已有值不被覆盖");

console.log("\n[5] rebuildBook keep vs overwrite");
store.clear();
VocabBook.addWord({ word: "manual1", meaning: "手动词", source: "manual" });
VocabBook.addWord({ word: "oldnews", meaning: "旧新闻词", source: "news" });
// keep 模式：保留全部，仅并入新词
const r5 = VocabBook.rebuildBook(
  [{ word: "new1", pos: "n.", meaning: "新词1", rank: 1 }],
  "keep", "news"
);
assert(rec("manual1") && rec("oldnews") && rec("new1"),
  "keep 模式：手动词 / 旧新闻词 / 新词都在");
assert(r5.backfilled === 0 && r5.success === 1, "keep：新增 new1，无 backfill");
// overwrite 模式：清掉非手动，保留手动，并入新词
VocabBook.rebuildBook(
  [{ word: "new2", pos: "n.", meaning: "新词2", rank: 2 }],
  "overwrite", "news"
);
assert(rec("manual1") != null, "overwrite 后手动词仍在");
assert(rec("oldnews") == null, "overwrite 后旧新闻词被清掉");
assert(rec("new2") != null, "overwrite 后新词进入");

console.log("\n== 结果: " + pass + " 通过 / " + fail + " 失败 ==");
process.exit(fail === 0 ? 0 : 1);
