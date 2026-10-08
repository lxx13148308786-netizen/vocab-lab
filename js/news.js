/**
 * news.js
 * AI 新闻背单词 H5 应用 —— 新闻匹配模块
 *
 * 纯逻辑、无 UI、无依赖（原生 ES6+）。
 * 算法：词袋交集（Bag of Words）
 *   1. 新闻正文转小写，提取所有英文单词（去标点、去数字）
 *   2. 统计今日单词池中有多少个词出现在该新闻里
 *   3. 得分 = 重合单词数量，得分最高的为最佳匹配
 *   4. 得分相同时，选字数较少的那篇（更容易改写）
 *
 * 对外只暴露一个全局对象 NewsMatcher。
 * 浏览器控制台可直接调用：NewsMatcher.init(NEWS_LIST) / NewsMatcher.match(words) / ...
 */

/* ==========================================================================
 * 1. 内部数据区（模块私有）
 * ========================================================================== */

/** 新闻库：原始新闻对象数组 */
let newsLibrary = [];

/** 与 newsLibrary 一一对应的词袋（小写单词集合），init 时预计算 */
let newsBags = [];

/** 与 newsLibrary 一一对应的正文单词数，init 时预计算 */
let newsWordCounts = [];

/* ==========================================================================
 * 2. 内部工具函数
 * ========================================================================== */

/**
 * 把一段英文文本切成单词数组：转小写，只保留字母（自动去掉标点与数字）
 * @param {string} text
 * @returns {Array<string>} 小写单词数组
 */
function tokenize(text) {
  const lower = String(text || "").toLowerCase();
  return lower.match(/[a-z]+/g) || [];
}

/**
 * 把输入统一成小写单词字符串数组
 * 支持两种输入：单词对象数组（{word: "diligent"}）或字符串数组（["diligent"]）
 * @param {Array<Object|string>} words
 * @returns {Array<string>}
 */
function normalizeWords(words) {
  if (!Array.isArray(words)) return [];
  return words
    .map(function (item) {
      if (typeof item === "string") return item.toLowerCase();
      return String((item && item.word) || "").toLowerCase();
    })
    .filter(function (w) { return w.length > 0; });
}

/* ==========================================================================
 * 3. 已读过滤 / 主题去重（依赖 ReadHistory，缺失时静默降级）
 * ========================================================================== */

/** 英文停用词（标题关键词提取时剔除） */
const STOP_WORDS = new Set([
  "the", "a", "an", "of", "in", "on", "at", "to", "for", "and", "or", "but",
  "with", "by", "as", "is", "are", "was", "were", "be", "been", "from", "into",
  "that", "this", "it", "its", "has", "have", "had", "not", "no", "so", "if",
  "than", "then", "will", "would", "can", "could", "may", "might", "do", "does"
]);

/**
 * 从标题里提取前 N 个实词（小写、去停用词、去重复）
 * 用于主题去重的 MVP 简化版：只比关键词重合度，不做 NLP
 * @param {string} title 新闻标题
 * @param {number} [n] 取前几个，默认 3
 * @returns {Array<string>} 关键词数组（小写，最多 n 个）
 */
function extractTitleKeywords(title, n) {
  const max = Number(n) > 0 ? Number(n) : 3;
  const tokens = tokenize(title);         // 复用正文分词：转小写 + 只留字母
  const seen = {};
  const out = [];
  for (let i = 0; i < tokens.length && out.length < max; i++) {
    const w = tokens[i];
    if (STOP_WORDS.has(w) || seen[w]) continue;
    seen[w] = true;
    out.push(w);
  }
  return out;
}

/**
 * 把已读 + 主题去重规则叠加到 scored 列表上，返回重排后的新数组
 * 规则（优先级从高到低）：
 *   1. 未读且主题不重合 > 2. 未读但主题重合 > 3. 已读但已过冷却期 > 4. 已读且冷却期内
 * 同一档内保持原 sort（得分高 / 字数少优先）。已读模块缺失时原样返回（降级）。
 * @param {Array<Object>} scored matchTopN 内部算好的候选列表
 * @param {number} [now] 当前时间戳（测试可注入）
 * @returns {Array<Object>} 重排后的新数组（不改原数组）
 */
function reorderForDedup(scored, now) {
  if (typeof ReadHistory === "undefined" || !ReadHistory) return scored.slice();
  const cur = (typeof now === "number") ? now : Date.now();

  // 收集最近 7 天内已读新闻的标题关键词，用于主题去重
  const recentKeywords = {};
  try {
    ReadHistory.getAll().forEach(function (r) {
      if (cur - r.readAt > 7 * 24 * 3600 * 1000) return;     // 只看最近 7 天
      const news = newsLibrary.filter(function (n) { return n.id === r.id; })[0];
      if (!news || !news.title) return;
      extractTitleKeywords(news.title).forEach(function (k) { recentKeywords[k] = (recentKeywords[k] || 0) + 1; });
    });
  } catch (e) { /* ignore */ }

  // 给每个候选打一个档位数字（小 = 优先）
  const bucketed = scored.map(function (item) {
    const isRead = ReadHistory.isRead(item.news.id, cur);
    const kws = extractTitleKeywords(item.news.title);
    const overlap = kws.reduce(function (s, k) { return s + (recentKeywords[k] ? 1 : 0); }, 0);
    const topicClash = overlap >= 2;       // 关键词重合 >=2 视为主题重合
    let bucket;
    if (!isRead && !topicClash) bucket = 0;
    else if (!isRead && topicClash) bucket = 1;
    else if (isRead) bucket = 2;           // 冷却期内的已读（isRead 已含冷却判定）
    else bucket = 3;                       // 理论不可达，兜底
    return { item: item, bucket: bucket };
  });

  // 稳定排序：先按 bucket 升序，bucket 相同时保持原顺序（scored 已按得分排好）
  bucketed.sort(function (a, b) {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket;
    return 0;
  });
  return bucketed.map(function (b) { return b.item; });
}

/* ==========================================================================
 * 4. 对外 API：NewsMatcher
 * ========================================================================== */

const NewsMatcher = {

  /**
   * 初始化新闻库，并预计算每篇新闻的词袋与字数（匹配时不再重复计算）
   * @param {Array<Object>} newsList 新闻数组，每项至少含 id / title / content
   * @returns {number} 新闻数量
   */
  init(newsList) {
    newsLibrary = [];
    newsBags = [];
    newsWordCounts = [];

    if (!Array.isArray(newsList)) {
      console.warn("[NewsMatcher.init] 参数必须是数组");
      return 0;
    }

    newsList.forEach(function (news) {
      if (!news || !news.content) return;          // 跳过脏数据
      const tokens = tokenize(news.content);
      newsLibrary.push(news);
      newsBags.push(new Set(tokens));              // 词袋：去重后的小写单词集合
      newsWordCounts.push(tokens.length);          // 正文字数（用于同分时的取舍）
    });

    return newsLibrary.length;
  },

  /**
   * 找出与今日单词池匹配度最高的新闻
   * @param {Array<Object|string>} words 今日单词池（单词对象数组或字符串数组）
   * @returns {Object|null} {news, score, matchedWords, unmatchedWords}，无新闻时返回 null
   */
  match(words) {
    const top = this.matchTopN(words, 1);
    return top.length > 0 ? top[0] : null;
  },

  /**
   * 返回匹配度最高的 n 篇新闻，按得分从高到低排；得分相同则字数少的在前
   * @param {Array<Object|string>} words 今日单词池
   * @param {number} n 返回数量，默认 3
   * @returns {Array<Object>} [{news, score, matchedWords, unmatchedWords}, ...]
   */
  matchTopN(words, n) {
    const targets = normalizeWords(words);
    const limit = Number(n) > 0 ? Number(n) : 3;

    // 逐篇计算重合情况
    const scored = newsLibrary.map(function (news, index) {
      const bag = newsBags[index];
      const matched = [];
      const unmatched = [];

      targets.forEach(function (word) {
        if (bag.has(word)) {
          matched.push(word);
        } else {
          unmatched.push(word);
        }
      });

      return {
        news: news,
        score: matched.length,
        matchedWords: matched,
        unmatchedWords: unmatched,
        wordCount: newsWordCounts[index]
      };
    });

    // 排序：得分高的在前；得分相同，字数少的在前
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.wordCount - b.wordCount;
    });

    // 已读过滤 + 主题去重（ReadHistory 缺失时原样返回，静默降级）
    const reordered = reorderForDedup(scored);

    return reordered.slice(0, limit);
  },

  /**
   * 返回全部新闻（调试用）
   * @returns {Array<Object>}
   */
  getAllNews() {
    return newsLibrary.slice();
  },

  /* 自测内部接口 */
  _test: {
    STOP_WORDS: STOP_WORDS,
    extractTitleKeywords: extractTitleKeywords,
    reorderForDedup: reorderForDedup
  }
};

// 浏览器环境下挂到 window，方便控制台直接调用；Node 环境下作为模块导出
if (typeof window !== "undefined") {
  window.NewsMatcher = NewsMatcher;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = NewsMatcher;
}
