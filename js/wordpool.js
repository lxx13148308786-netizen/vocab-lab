/**
 * wordpool.js
 * AI 新闻背单词 H5 应用 —— 词库与每日配额模块（V2 四档状态）
 *
 * V2 变更：
 *   - 五状态 → 四档 (new/familiar/known/mastered)
 *   - generateDailyPool 重写：每日新词10 + 每日复习10 + 补差 + 候补
 *   - 返回 { date, newWords, reviewWords, standbyWords }
 *
 * 纯逻辑、无 UI、无依赖（原生 ES6+）。
 * 对外暴露全局对象 WordPool。
 */

/* ==========================================================================
 * 1. 内部数据区
 * ========================================================================== */

/** 词库本体 */
var wordLibrary = [];

/** 四档状态流转表 */
var STATUS_FLOW = {
  new:      { correct: "familiar",  wrong: "new",      interval: 1 },
  familiar: { correct: "known",     wrong: "new",      interval: 3 },
  known:    { correct: "mastered",  wrong: "familiar", interval: 7 },
  mastered: { correct: "mastered",  wrong: "known",    interval: 30 }
};

/** 合法状态名 */
var VALID_STATUS = Object.keys(STATUS_FLOW);

/** 合法来源 */
var VALID_SOURCE = ["manual", "wordbook", "review", "frequency", "news"];

/** 每日配额 */
var DAILY_NEW_LIMIT     = 10;
var DAILY_REVIEW_LIMIT  = 10;

/* ==========================================================================
 * 2. 日期工具函数
 * ========================================================================== */

/** "YYYY-MM-DD" → Date（本地零点） */
function parseDate(dateStr) {
  if (typeof dateStr !== "string") return null;
  var parts = dateStr.split("-");
  if (parts.length !== 3) return null;
  var y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2]);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** Date → "YYYY-MM-DD" */
function formatDate(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, "0");
  var d = String(date.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

/** 获取今天 "YYYY-MM-DD" */
function getToday() {
  return formatDate(new Date());
}

/** 在日期上加减天数 */
function addDays(dateStr, days) {
  var date = parseDate(dateStr);
  if (!date) return dateStr;
  date.setDate(date.getDate() + Number(days || 0));
  return formatDate(date);
}

/** 两日期天数差 */
function diffDays(dateStrA, dateStrB) {
  var a = parseDate(dateStrA);
  var b = parseDate(dateStrB);
  if (!a || !b) return NaN;
  return Math.round((b - a) / 86400000);
}

/* ==========================================================================
 * 3. 内部辅助函数
 * ========================================================================== */

/** 生成标准单词对象 */
function createWordObject(raw, source) {
  var today = getToday();
  var src = VALID_SOURCE.indexOf(source) >= 0 ? source : "manual";

  return {
    id: String(raw.word || "").trim(),
    word: String(raw.word || "").trim(),
    pos: raw.pos || "",
    meaning: raw.meaning || "",
    phonetic: raw.phonetic || "",
    status: VALID_STATUS.indexOf(raw.status) >= 0 ? raw.status : "new",
    addDate: raw.addDate || today,
    source: src,
    active: typeof raw.active === "boolean" ? raw.active : false,
    nextReview: raw.nextReview || today,
    reviewCount: Number(raw.reviewCount) || 0,
    lastReview: raw.lastReview || null,
    // 词频排名：数字越小越高频；没传时给一个大数，排到最后（补差时高频优先）
    rank: Number(raw.rank) > 0 ? Number(raw.rank) : 99999,
    fromVocab: false
  };
}

/** 单词本是否可用 */
function hasVocabBook() {
  return typeof VocabBook !== "undefined" && VocabBook &&
         typeof VocabBook.getAllWords === "function";
}

/** 按 id 在词库中查找（大小写不敏感） */
function findWordById(wordId) {
  if (typeof wordId !== "string") return null;
  var key = wordId.trim().toLowerCase();
  for (var i = 0; i < wordLibrary.length; i++) {
    if (wordLibrary[i].word.toLowerCase() === key) return wordLibrary[i];
  }
  return null;
}

/* ==========================================================================
 * 4. 对外 API：WordPool
 * ========================================================================== */

var WordPool = {

  /** 初始化词库 */
  init(frequencyWords) {
    wordLibrary = [];
    if (!Array.isArray(frequencyWords)) return 0;
    frequencyWords.forEach(function (item) {
      if (!item || !item.word) return;
      if (findWordById(item.word)) return;
      wordLibrary.push(createWordObject(item, "frequency"));
    });
    return wordLibrary.length;
  },

  /** 选中的今日新词入单词本（当天收录的 + 补差进来的都算） */
  ensureInVocabBook: function (w, source) {
    if (!hasVocabBook()) return;
    if (VocabBook.isInVocabBook(w.word)) return;
    VocabBook.addWord({
      word: w.word,
      phonetic: w.phonetic,
      pos: w.pos,
      meaning: w.meaning,
      source: source
    });
  },

  /** 添加一个新词 */
  addWord(word, pos, meaning, source, phonetic) {
    var key = String(word || "").trim();
    if (!key) return null;
    var exist = findWordById(key);
    if (exist) return exist;
    var newWord = createWordObject({ word: key, pos: pos, meaning: meaning, phonetic: phonetic }, source || "manual");
    wordLibrary.push(newWord);
    return newWord;
  },

  /**
   * 获取今日需要复习的单词（四档状态）
   * @param {string} today "YYYY-MM-DD"
   * @param {number} limit
   * @returns {Array<Object>}
   */
  getReviewWords(today, limit) {
    var dateStr = today || getToday();
    var max = Number(limit) > 0 ? Number(limit) : 10;

    return wordLibrary
      .filter(function (w) { return w.status !== "mastered" && w.nextReview <= dateStr; })
      .sort(function (a, b) {
        // 不熟的优先（reviewCount 少的），再按 nextReview 早的优先
        if (a.reviewCount !== b.reviewCount) return a.reviewCount - b.reviewCount;
        return a.nextReview < b.nextReview ? -1 : 1;
      })
      .slice(0, max);
  },

  /**
   * 更新单词记忆状态（四档）
   */
  updateWordStatus(wordId, isCorrect, today) {
    var word = findWordById(wordId);
    if (!word) return null;
    var dateStr = today || getToday();
    var rule = STATUS_FLOW[word.status];
    if (!rule) return word;
    word.status = isCorrect ? rule.correct : rule.wrong;
    word.reviewCount += 1;
    word.lastReview = dateStr;
    word.nextReview = this.calcNextReviewDate(word.status, dateStr);
    return word;
  },

  /** 根据状态计算下次复习日期 */
  calcNextReviewDate(status, today) {
    var dateStr = today || getToday();
    var rule = STATUS_FLOW[status];
    if (!rule) return dateStr;
    return addDays(dateStr, rule.interval);
  },

  /** 按单词 ID 查询 */
  getWord(wordId) {
    return findWordById(wordId);
  },

  /** 返回全部单词 */
  getAllWords() {
    return wordLibrary.slice();
  },

  /**
   * 把单词本（VocabBook）里的词同步进词库
   * @returns {Array<Object>}
   */
  syncVocabBookWords() {
    if (!hasVocabBook()) return [];

    var all = VocabBook.getAllWords() || [];
    var result = [];

    all.forEach(function (v) {
      var key = String(v.word || "").trim().toLowerCase();
      if (!key) return;

      var w = findWordById(key);

      if (v.status === "mastered") {
        if (w) w.fromVocab = false;
        return;
      }

      if (!w) {
        w = WordPool.addWord(key, v.pos || "", v.meaning || "", (v.source === "manual" ? "manual" : "news"), v.phonetic || "");
      }
      if (!w) return;

      if (!w.phonetic && v.phonetic) w.phonetic = v.phonetic;
      if (!w.pos && v.pos) w.pos = v.pos;
      if (!w.meaning && v.meaning) w.meaning = v.meaning;
      // 同步 V2 状态
      if (v.status && VALID_STATUS.indexOf(v.status) >= 0) {
        w.status = v.status;
      }

      w.fromVocab = true;
      result.push(w);
    });

    // 清理残留标记
    wordLibrary.forEach(function (w) {
      if (!w.fromVocab) return;
      var still = all.some(function (v) { return String(v.word || "").trim().toLowerCase() === w.word.toLowerCase(); });
      if (!still) w.fromVocab = false;
    });

    return result;
  },

  /**
   * V2 核心：生成当日单词池（每日新词10 + 每日复习10 + 补差 + 候补）
   *
   * @param {string} today "YYYY-MM-DD"，默认今天
   * @returns {{date:string, newWords:Array, reviewWords:Array, standbyWords:Array}}
   */
  generateDailyPool(today) {
    var dateStr = today || getToday();

    // 先同步单词本
    this.syncVocabBookWords();

    // ---- 今日复习：所有 nextReview <= 今天 且未掌握，按词频排序取前10 ----
    var allDue = [];
    if (hasVocabBook()) {
      allDue = VocabBook.getDueWords(dateStr);
    }
    // 按词频排序（reviewCount 少的优先）
    allDue.sort(function (a, b) {
      return (a.reviewCount || 0) - (b.reviewCount || 0);
    });
    var reviewWords = allDue.slice(0, DAILY_REVIEW_LIMIT).map(function (v) {
      var w = findWordById(v.word);
      return w || Object.assign({}, v, { id: v.word, fromVocab: true, poolType: "vocab" });
    });
    // 打标记
    reviewWords.forEach(function (w) { w.poolType = "vocab"; w.fromVocab = true; });

    // 候补复习 = 待复习池 - 今日复习
    var standbyWords = allDue.slice(DAILY_REVIEW_LIMIT).map(function (v) {
      var w = findWordById(v.word);
      return w || Object.assign({}, v, { id: v.word, fromVocab: true, poolType: "standby" });
    });
    standbyWords.forEach(function (w) { w.poolType = "standby"; w.fromVocab = true; });

    // ---- 今日新词：当天从新闻收录 + 补差 ----
    var newWords = [];
    var pickedIds = Object.create(null);

    // 标记已选的复习词
    reviewWords.forEach(function (w) { pickedIds[String(w.word || w.id).toLowerCase()] = true; });
    standbyWords.forEach(function (w) { pickedIds[String(w.word || w.id).toLowerCase()] = true; });

    // 1) 当天从新闻收录的词（addDate === today 且 status === new 且来源为 news）
    var todayNewFromNews = wordLibrary.filter(function (w) {
      return w.addDate === dateStr && w.status === "new" && w.source === "news" && !pickedIds[w.id];
    });
    todayNewFromNews.forEach(function (w) {
      if (newWords.length >= DAILY_NEW_LIMIT) return;
      pickedIds[w.id] = true;
      w.poolType = "new";
      // 当天收录的词也要在单词本里（每日单词本来就来自单词本）
      WordPool.ensureInVocabBook(w, "daily_new");
      newWords.push(w);
    });

    // 2) 补差：词频池（status === new 的未排进每日的词），按词频排序补足
    if (newWords.length < DAILY_NEW_LIMIT) {
      var freqPool = wordLibrary.filter(function (w) {
        return w.status === "new" && !pickedIds[w.id] && w.source !== "manual";
      }).sort(function (a, b) {
        // rank 小的优先（高频优先），无 rank 的排后面
        var ra = Number(a.rank) || 99999;
        var rb = Number(b.rank) || 99999;
        return ra - rb;
      });
      freqPool.forEach(function (w) {
        if (newWords.length >= DAILY_NEW_LIMIT) return;
        pickedIds[w.id] = true;
        w.poolType = "frequency";
        // 补差进来的词自动进入单词本
        WordPool.ensureInVocabBook(w, "frequency_fill");
        newWords.push(w);
      });
    }

    return {
      date: dateStr,
      newWords: newWords,
      reviewWords: reviewWords,
      standbyWords: standbyWords
    };
  },

  /* ---------- 调试辅助 ---------- */

  clear() {
    wordLibrary = [];
  },

  setStatus(wordId, status, nextReview) {
    var word = findWordById(wordId);
    if (!word) return null;
    if (VALID_STATUS.indexOf(status) >= 0) word.status = status;
    if (nextReview) word.nextReview = nextReview;
    return word;
  },

  getStats() {
    var stats = {};
    VALID_STATUS.forEach(function (s) { stats[s] = 0; });
    wordLibrary.forEach(function (w) { stats[w.status] = (stats[w.status] || 0) + 1; });
    stats.total = wordLibrary.length;
    return stats;
  }
};

// 浏览器环境挂 window；Node 环境导出
if (typeof window !== "undefined") {
  window.WordPool = WordPool;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = WordPool;
}
