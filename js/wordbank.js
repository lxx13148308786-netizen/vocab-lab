/**
 * wordbank.js
 * AI 新闻背单词 H5 应用 —— 词汇量测试用的词库
 *
 * 设计说明：
 *   - 纯数据文件，不依赖任何库。
 *   - 每个单词带 rank（词频排名，越小越常用），vocabTest.js 据此把单词归入
 *     5 个难度层级（见 vocabTest.js 的 LEVEL_BOUNDS）。
 *   - 每个层级准备了 名词 / 动词 / 形容词 各 4 个，保证抽题时「同层 + 同词性」
 *     的干扰项一定够用（每个题干词都能在同层同词性里找到 3 个干扰项）。
 *   - 这是「词汇量估算」用的样本词库；日常学习的词（FREQUENCY_WORDS）是另一套，互不影响。
 *
 * 字段：
 *   word     单词（小写，词组用空格）
 *   pos      词性（n. / v. / adj.）
 *   meaning  中文释义
 *   rank     词频排名（用于划分层级）
 */

const WORD_BANK = [
  /* ============================ Level 1（入门，rank 1-1000） ============================ */
  // 名词
  { word: "cat",      pos: "n.",   meaning: "猫",             rank: 60 },
  { word: "dog",      pos: "n.",   meaning: "狗",             rank: 120 },
  { word: "book",     pos: "n.",   meaning: "书",             rank: 210 },
  { word: "water",    pos: "n.",   meaning: "水",             rank: 350 },
  // 动词
  { word: "eat",      pos: "v.",   meaning: "吃",             rank: 420 },
  { word: "run",      pos: "v.",   meaning: "跑；运行",       rank: 520 },
  { word: "read",     pos: "v.",   meaning: "读",             rank: 610 },
  { word: "help",     pos: "v.",   meaning: "帮助",           rank: 690 },
  // 形容词
  { word: "big",      pos: "adj.", meaning: "大的",           rank: 740 },
  { word: "small",    pos: "adj.", meaning: "小的",           rank: 820 },
  { word: "red",      pos: "adj.", meaning: "红色的",         rank: 880 },
  { word: "happy",    pos: "adj.", meaning: "快乐的",         rank: 950 },

  /* ============================ Level 2（基础，rank 1001-3000） ============================ */
  // 名词
  { word: "garden",   pos: "n.",   meaning: "花园",           rank: 1100 },
  { word: "letter",   pos: "n.",   meaning: "信；字母",       rank: 1250 },
  { word: "movie",    pos: "n.",   meaning: "电影",           rank: 1380 },
  { word: "teacher",  pos: "n.",   meaning: "老师",           rank: 1490 },
  // 动词
  { word: "borrow",   pos: "v.",   meaning: "借入",           rank: 1620 },
  { word: "enjoy",    pos: "v.",   meaning: "享受；喜欢",     rank: 1740 },
  { word: "listen",   pos: "v.",   meaning: "听",             rank: 1860 },
  { word: "arrive",   pos: "v.",   meaning: "到达",           rank: 1980 },
  // 形容词
  { word: "friendly", pos: "adj.", meaning: "友好的",         rank: 2120 },
  { word: "narrow",   pos: "adj.", meaning: "狭窄的",         rank: 2340 },
  { word: "empty",    pos: "adj.", meaning: "空的",           rank: 2620 },
  { word: "ancient",  pos: "adj.", meaning: "古老的",         rank: 2900 },

  /* ============================ Level 3（四级，rank 3001-5000） ============================ */
  // 名词
  { word: "decision",      pos: "n.",   meaning: "决定；决策",     rank: 3100 },
  { word: "freedom",       pos: "n.",   meaning: "自由",           rank: 3250 },
  { word: "pollution",     pos: "n.",   meaning: "污染",           rank: 3380 },
  { word: "relationship",  pos: "n.",   meaning: "关系；联系",     rank: 3490 },
  // 动词
  { word: "achieve",       pos: "v.",   meaning: "实现；达到",     rank: 3610 },
  { word: "annoy",         pos: "v.",   meaning: "使恼怒；打扰",   rank: 3740 },
  { word: "beg",           pos: "v.",   meaning: "乞求；恳求",     rank: 3870 },
  { word: "celebrate",     pos: "v.",   meaning: "庆祝",           rank: 3960 },
  // 形容词
  { word: "accurate",      pos: "adj.", meaning: "准确的",         rank: 4120 },
  { word: "clever",        pos: "adj.", meaning: "聪明的",         rank: 4330 },
  { word: "enormous",      pos: "adj.", meaning: "巨大的",         rank: 4640 },
  { word: "famous",        pos: "adj.", meaning: "著名的",         rank: 4950 },

  /* ============================ Level 4（六级，rank 5001-8000） ============================ */
  // 名词
  { word: "consequence",   pos: "n.",   meaning: "后果；结果",     rank: 5100 },
  { word: "phenomenon",    pos: "n.",   meaning: "现象",           rank: 5250 },
  { word: "tendency",      pos: "n.",   meaning: "趋势；倾向",     rank: 5370 },
  { word: "virtue",        pos: "n.",   meaning: "美德；优点",     rank: 5490 },
  // 动词
  { word: "abolish",       pos: "v.",   meaning: "废除；废止",     rank: 5610 },
  { word: "compile",       pos: "v.",   meaning: "汇编；编译",     rank: 5730 },
  { word: "dwell",         pos: "v.",   meaning: "居住；详述",     rank: 5860 },
  { word: "fluctuate",     pos: "v.",   meaning: "波动；起伏",     rank: 5970 },
  // 形容词
  { word: "bizarre",       pos: "adj.", meaning: "奇异的；怪诞的", rank: 6140 },
  { word: "crucial",       pos: "adj.", meaning: "关键的；重要的", rank: 6360 },
  { word: "feasible",      pos: "adj.", meaning: "可行的",         rank: 6680 },
  { word: "generous",      pos: "adj.", meaning: "慷慨的",         rank: 7900 },

  /* ============================ Level 5（高级，rank 8001-12000） ============================ */
  // 名词
  { word: "anomaly",       pos: "n.",   meaning: "异常；反常",     rank: 8100 },
  { word: "paradigm",      pos: "n.",   meaning: "范式；典范",     rank: 8250 },
  { word: "sovereignty",   pos: "n.",   meaning: "主权",           rank: 8380 },
  { word: "utopia",        pos: "n.",   meaning: "乌托邦；理想国", rank: 8490 },
  // 动词
  { word: "extrapolate",   pos: "v.",   meaning: "推断；外推",     rank: 8610 },
  { word: "juxtapose",     pos: "v.",   meaning: "并列；并置",     rank: 8740 },
  { word: "obliterate",    pos: "v.",   meaning: "抹去；摧毁",     rank: 8870 },
  { word: "substantiate",  pos: "v.",   meaning: "证实；充实",     rank: 8980 },
  // 形容词
  { word: "ephemeral",         pos: "adj.", meaning: "短暂的；朝生暮死的", rank: 9140 },
  { word: "indefatigable",     pos: "adj.", meaning: "不知疲倦的",         rank: 9480 },
  { word: "quintessential",    pos: "adj.", meaning: "典型的；精髓的",     rank: 9820 },
  { word: "ubiquitous",        pos: "adj.", meaning: "无处不在的",         rank: 11900 }
];

// 浏览器环境下挂到 window，方便控制台查看；Node 环境下导出（自测用）
if (typeof window !== "undefined") {
  window.WORD_BANK = WORD_BANK;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { WORD_BANK: WORD_BANK };
}
