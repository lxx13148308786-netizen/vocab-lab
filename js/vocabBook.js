/**
 * vocabBook.js
 * AI 新闻背单词 H5 应用 —— 单词本数据模块（V2 四档状态）
 *
 * V2 变更：
 *   - 五状态 (new/short/mid/long/mastered) → 四档 (new/familiar/known/mastered)
 *   - 升降级结合答题时间：快答对升2档 / 中速升1档 / 慢答对原地 / 答错降1档
 *   - nextReview 改为日期字符串 "YYYY-MM-DD"（V1 是时间戳，迁移时转换）
 *   - mastered 答对延长间隔：30d → 90d → 180d 逐步拉长
 *   - V1→V2 自动迁移（只跑一次）
 *
 * 对外：全局对象 VocabBook
 * 存储：localStorage["vocabBook"] = [ { word, phonetic, pos, meaning,
 *          status, addedAt, nextReviewDate, reviewCount, source, sourceNewsId }, ... ]
 */

/* ==========================================================================
 * 1. 常量：四档状态与间隔
 * ========================================================================== */

/** localStorage key */
var VOCAB_BOOK_KEY = "vocabBook";
/** 迁移标记 key */
var VOCAB_MIGRATION_KEY = "anv_migration_v2";
/** 一天毫秒数 */
var VOCAB_DAY_MS = 86400000;
/** 超过这个条数就提示该换 IndexedDB 了 */
var VOCAB_IDB_HINT_SIZE = 500;

/** 四档记忆状态，从低到高 */
var VOCAB_STATUSES = ["new", "familiar", "known", "mastered"];

/** 各状态对应的复习间隔（天） */
var VOCAB_INTERVAL_DAYS = {
  new: 1,
  familiar: 3,
  known: 7,
  mastered: 30
};

/** mastered 答对后的间隔序列：30 → 90 → 180 → 360（逐步拉长） */
var VOCAB_MASTERED_EXTEND_DAYS = [90, 180, 360];

/** 答题时间阈值（毫秒） */
var VOCAB_FAST_MS  = 3000;  // < 3s 快答
var VOCAB_SLOW_MS  = 6000;  // > 6s 慢答

/**
 * 升级规则（答对时）
 * @param {string} status 当前状态
 * @param {number} reactionMs 答题反应时间
 * @returns {string} 新状态
 */
function vocabStepUp(status, reactionMs) {
  var idx = VOCAB_STATUSES.indexOf(status);
  if (idx < 0) return "new";
  if (reactionMs < VOCAB_FAST_MS) {
    // 快答对：升2档（不超过 mastered）
    return VOCAB_STATUSES[Math.min(idx + 2, VOCAB_STATUSES.length - 1)];
  }
  if (reactionMs <= VOCAB_SLOW_MS) {
    // 中速答对：升1档
    return VOCAB_STATUSES[Math.min(idx + 1, VOCAB_STATUSES.length - 1)];
  }
  // 慢答对：原地不动
  return status;
}

/**
 * 降级规则（答错时）
 * @param {string} status 当前状态
 * @returns {string} 新状态
 */
function vocabStepDown(status) {
  var idx = VOCAB_STATUSES.indexOf(status);
  if (idx <= 0) return "new";  // 最低档不再降
  return VOCAB_STATUSES[idx - 1];
}

/* ==========================================================================
 * 2. 内部状态与工具
 * ========================================================================== */

/** 内存中的单词本 */
var vocabBook = [];
/** 是否已从 localStorage 载入 */
var vocabLoaded = false;
/** 数据变化订阅者 */
var vocabListeners = [];

/** 取 localStorage */
function vocabGetStorage() {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch (e) { /* ignore */ }
  return null;
}

/** 归一化单词：去首尾空白与标点、转小写 */
function normalizeVocabWord(text) {
  // 只剥首尾的【符号/空白】，不能连数字一起剥。
  // 旧实现用 [^A-Za-z]+ 会把 "zzznew1" 结尾的数字当"非字母"去掉，存成 "zzznew"
  // —— 于是 "zzznew1" 和 "zzznew2" 变成同一个词，第二个导入时被判重复跳过。
  // 词典里都是纯字母词所以不体现，但带数字的写法（3d、mp4、x-ray）
  // 和用户自造的编号词都可能是真的。
  return String(text || "").trim()
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9]+$/, "")
    .toLowerCase();
}

/** 浅拷贝一条记录 */
function copyVocabRecord(record) {
  return record ? Object.assign({}, record) : null;
}

/**
 * 获取今天的日期字符串 "YYYY-MM-DD"
 */
function vocabToday() {
  var d = new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

/**
 * 在日期字符串上加减天数
 * @param {string} dateStr "YYYY-MM-DD"
 * @param {number} days
 * @returns {string}
 */
function vocabAddDays(dateStr, days) {
  var parts = dateStr.split("-");
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  d.setDate(d.getDate() + Number(days || 0));
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

/**
 * 按状态算下次复习日期
 * @param {string} status 流转后的新状态
 * @param {string} [from] 起始日期 "YYYY-MM-DD"，默认今天
 * @param {number} [reviewCount] 复习次数（mastered 答对时用于选延长间隔）
 * @returns {string} "YYYY-MM-DD"
 */
function calcVocabNextReviewDate(status, from, reviewCount) {
  var base = from || vocabToday();
  var days = VOCAB_INTERVAL_DAYS[status];
  // mastered 答对后延长间隔
  if (status === "mastered" && typeof reviewCount === "number" && reviewCount > 0) {
    // reviewCount 1→30d, 2→90d, 3→180d, 4+→360d
    if (reviewCount >= 4) days = 360;
    else if (reviewCount >= 3) days = 180;
    else if (reviewCount >= 2) days = 90;
    // reviewCount === 1 用默认的 30 天
  }
  return vocabAddDays(base, days);
}

/** 通知订阅者 */
function notifyVocabListeners() {
  vocabListeners.forEach(function (fn) {
    try { fn(); } catch (e) { /* 单个订阅者出错不能影响其他 */ }
  });
}

/* ==========================================================================
 * 3. V1→V2 数据迁移
 * ========================================================================== */

/**
 * V1 五状态 → V2 四档映射
 */
var VOCAB_V1_TO_V2 = {
  new: "new",
  short: "familiar",
  mid: "familiar",
  long: "known",
  mastered: "mastered"
};

/**
 * 执行 V1→V2 迁移（只跑一次，由 anv_migration_v2 标记控制）
 * 将五状态字段转换为新四档字段，nextReview 时间戳转为 nextReviewDate 日期字符串
 */
function migrateV1ToV2() {
  var store = vocabGetStorage();
  if (!store) return;

  // 已迁移过则跳过
  if (store.getItem(VOCAB_MIGRATION_KEY) === "true") return;

  var raw;
  try {
    raw = JSON.parse(store.getItem(VOCAB_BOOK_KEY) || "[]");
  } catch (e) {
    raw = [];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    // 空数据，标记已迁移即可
    store.setItem(VOCAB_MIGRATION_KEY, "true");
    return;
  }

  var today = vocabToday();
  var migrated = raw.map(function (item) {
    if (!item || typeof item.word !== "string" || !item.word) return null;

    // 状态映射
    var v1Status = String(item.status || "new");
    var newStatus = VOCAB_V1_TO_V2[v1Status];
    if (!newStatus) newStatus = "new";

    // nextReview 时间戳 → nextReviewDate 日期字符串
    var nextReviewDate;
    if (item.nextReviewDate && typeof item.nextReviewDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.nextReviewDate)) {
      // 已经是 V2 格式
      nextReviewDate = item.nextReviewDate;
    } else if (typeof item.nextReview === "number" && item.nextReview > 0) {
      // V1 时间戳转日期
      var d = new Date(item.nextReview);
      nextReviewDate = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    } else {
      // 推算不出就设为今天（视为今天该复习）
      nextReviewDate = today;
    }

    return {
      word: normalizeVocabWord(item.word),
      phonetic: String(item.phonetic || ""),
      pos: String(item.pos || ""),
      meaning: String(item.meaning || ""),
      status: newStatus,
      addedAt: Number(item.addedAt) || Date.now(),
      nextReviewDate: nextReviewDate,
      reviewCount: Number(item.reviewCount) || 0,
      source: String(item.source || "long_press"),
      sourceNewsId: String(item.sourceNewsId || "")
    };
  }).filter(Boolean);

  // 去重
  var seen = {};
  migrated = migrated.filter(function (item) {
    if (seen[item.word]) return false;
    seen[item.word] = true;
    return true;
  });

  // 写回
  try {
    store.setItem(VOCAB_BOOK_KEY, JSON.stringify(migrated));
    store.setItem(VOCAB_MIGRATION_KEY, "true");
  } catch (e) { /* ignore */ }
}

/* ==========================================================================
 * 4. 持久化
 * ========================================================================== */

/**
 * 从 localStorage 载入（只载一次）
 * 字段补全，避免旧数据缺字段导致 UI 出错
 */
function loadVocabBook() {
  if (vocabLoaded) return;
  vocabLoaded = true;

  // 先执行迁移
  migrateV1ToV2();

  var store = vocabGetStorage();
  if (!store) return;

  var raw = [];
  try {
    raw = JSON.parse(store.getItem(VOCAB_BOOK_KEY) || "[]");
  } catch (e) {
    raw = [];
  }
  if (!Array.isArray(raw)) return;

  var seen = {};
  vocabBook = raw
    .filter(function (item) { return item && typeof item.word === "string" && item.word; })
    .map(function (item) {
      var word = normalizeVocabWord(item.word);
      var status = VOCAB_STATUSES.indexOf(item.status) >= 0 ? item.status : "new";
      var addedAt = Number(item.addedAt) || Date.now();
      // nextReviewDate：字符串日期或 fallback
      var nextReviewDate = item.nextReviewDate;
      if (!nextReviewDate || typeof nextReviewDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(nextReviewDate)) {
        nextReviewDate = calcVocabNextReviewDate(status, vocabToday());
      }
      return {
        word: word,
        phonetic: String(item.phonetic || ""),
        pos: String(item.pos || ""),
        meaning: String(item.meaning || ""),
        status: status,
        addedAt: addedAt,
        nextReviewDate: nextReviewDate,
        reviewCount: Number(item.reviewCount) || 0,
        source: String(item.source || "long_press"),
        sourceNewsId: String(item.sourceNewsId || "")
      };
    })
    .filter(function (item) {
      if (seen[item.word]) return false;
      seen[item.word] = true;
      return true;
    });
}

/** 写回 localStorage */
function persistVocabBook() {
  var store = vocabGetStorage();
  if (!store) return;
  try {
    store.setItem(VOCAB_BOOK_KEY, JSON.stringify(vocabBook));
  } catch (e) { /* ignore */ }
  if (vocabBook.length > VOCAB_IDB_HINT_SIZE && !persistVocabBook._warned) {
    persistVocabBook._warned = true;
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[VocabBook] 单词已超过 " + VOCAB_IDB_HINT_SIZE +
        " 条，localStorage 读写会变卡，建议迁移到 IndexedDB。");
    }
  }
}

/** 内部查找：返回真实记录对象（不是拷贝） */
function findVocabRecord(word) {
  var key = normalizeVocabWord(word);
  if (!key) return null;
  for (var i = 0; i < vocabBook.length; i++) {
    if (vocabBook[i].word === key) return vocabBook[i];
  }
  return null;
}

/* ==========================================================================
 * 5. 对外 API：VocabBook
 * ========================================================================== */

var VocabBook = {

  /** 四档状态列表（方便外部校验） */
  STATUSES: VOCAB_STATUSES,

  /** 间隔天数映射 */
  INTERVAL_DAYS: VOCAB_INTERVAL_DAYS,

  /** 答题时间阈值 */
  FAST_MS: VOCAB_FAST_MS,
  SLOW_MS: VOCAB_SLOW_MS,

  /**
   * 添加单词
   * @param {Object|string} wordData
   * @returns {boolean} 新增成功 true；已存在或数据非法 false
   */
  addWord(wordData) {
    loadVocabBook();
    var data = (typeof wordData === "string") ? { word: wordData } : (wordData || {});
    var word = normalizeVocabWord(data.word);
    if (!word) return false;
    if (findVocabRecord(word)) return false;

    var now = Date.now();
    var today = vocabToday();
    vocabBook.push({
      word: word,
      phonetic: String(data.phonetic || ""),
      pos: String(data.pos || ""),
      meaning: String(data.meaning || ""),
      status: "new",
      addedAt: Number(data.addedAt) || now,
      nextReviewDate: calcVocabNextReviewDate("new", today),
      reviewCount: Number(data.reviewCount) || 0,
      source: String(data.source || "long_press"),
      sourceNewsId: String(data.sourceNewsId || "")
    });

    persistVocabBook();
    notifyVocabListeners();
    return true;
  },

  /**
   * 删除单词
   */
  removeWord(word) {
    loadVocabBook();
    var key = normalizeVocabWord(word);
    if (!key) return false;
    var before = vocabBook.length;
    vocabBook = vocabBook.filter(function (item) { return item.word !== key; });
    if (vocabBook.length === before) return false;
    persistVocabBook();
    notifyVocabListeners();
    return true;
  },

  /**
   * 批量添加单词
   * @param {Array<string|Object>} wordsArray
   * @param {string} source
   * @returns {{success:number, skipped:number, failed:number}}
   */
  batchAdd(wordsArray, source) {
    loadVocabBook();
    var arr = Array.isArray(wordsArray) ? wordsArray : [];
    var success = 0, skipped = 0, failed = 0;
    var now = Date.now();
    var today = vocabToday();

    arr.forEach(function (raw) {
      var word = normalizeVocabWord((raw && typeof raw === "object") ? raw.word : raw);
      if (!word) { failed++; return; }
      if (findVocabRecord(word)) { skipped++; return; }

      vocabBook.push({
        word: word,
        phonetic: String((raw && raw.phonetic) || ""),
        pos: String((raw && raw.pos) || ""),
        meaning: String((raw && raw.meaning) || ""),
        status: "new",
        addedAt: now,
        nextReviewDate: calcVocabNextReviewDate("new", today),
        reviewCount: 0,
        source: String(source || "long_press"),
        sourceNewsId: ""
      });
      success++;
    });

    if (success > 0) {
      persistVocabBook();
      notifyVocabListeners();
    }
    return { success: success, skipped: skipped, failed: failed };
  },

  /** 查一条记录（返回拷贝） */
  getWord(word) {
    loadVocabBook();
    return copyVocabRecord(findVocabRecord(word));
  },

  /** 全部记录（返回拷贝数组） */
  getAllWords() {
    loadVocabBook();
    return vocabBook.map(copyVocabRecord);
  },

  /**
   * 按状态筛选
   * @param {string} status new / familiar / known / mastered
   * @returns {Array<Object>}
   */
  getWordsByStatus(status) {
    loadVocabBook();
    return vocabBook
      .filter(function (item) { return item.status === status; })
      .map(copyVocabRecord);
  },

  /**
   * 按下次复习日期筛选（复习词 + 候补词）
   * @param {string} today "YYYY-MM-DD"
   * @param {boolean} standbyOnly true=只返回候补（排除前10），false=全部待复习
   * @returns {Array<Object>}
   */
  getWordsByNextReviewDate(today, standbyOnly) {
    loadVocabBook();
    var dateStr = today || vocabToday();
    var due = vocabBook
      .filter(function (item) {
        if (item.status === "mastered") return false;
        return item.nextReviewDate <= dateStr;
      })
      .sort(function (a, b) {
        // 按词频（reviewCount少的优先=不熟的优先）再按 nextReviewDate
        if (a.reviewCount !== b.reviewCount) return a.reviewCount - b.reviewCount;
        return a.nextReviewDate < b.nextReviewDate ? -1 : 1;
      })
      .map(copyVocabRecord);

    if (standbyOnly) {
      return due.slice(10); // 候补 = 待复习池 - 前10
    }
    return due;
  },

  /**
   * V2 核心方法：复习后更新状态（结合答题时间）
   * @param {string} word 单词
   * @param {number} reactionMs 答题反应时间（毫秒）
   * @param {boolean} [correct] 是否答对（可选，由 reactionMs 推断时不传）
   * @returns {Object|null} 更新后的记录
   */
  updateWordStatus(word, reactionMs, correct) {
    loadVocabBook();
    var record = findVocabRecord(word);
    if (!record) return null;

    // 如果调用方直接传 correct 布尔值（兼容旧接口 updateWordStatus(word, true)）
    var isCorrect;
    var rtMs;
    if (typeof reactionMs === "boolean") {
      // 兼容旧调用：updateWordStatus(word, true/false)
      isCorrect = reactionMs;
      rtMs = isCorrect ? VOCAB_FAST_MS : 0; // 旧接口默认中速
    } else {
      rtMs = Number(reactionMs) || 0;
      isCorrect = (typeof correct === "boolean") ? correct : true;
    }

    if (isCorrect) {
      record.status = vocabStepUp(record.status, rtMs);
    } else {
      record.status = vocabStepDown(record.status);
    }
    record.reviewCount = Number(record.reviewCount || 0) + 1;
    record.nextReviewDate = calcVocabNextReviewDate(record.status, vocabToday(), record.reviewCount);

    persistVocabBook();
    notifyVocabListeners();
    return copyVocabRecord(record);
  },

  /**
   * 直接设为某个状态（手动修改用）
   * @param {string} word
   * @param {string} status new / familiar / known / mastered
   * @returns {Object|null}
   */
  setStatus(word, status) {
    loadVocabBook();
    if (VOCAB_STATUSES.indexOf(status) < 0) return null;
    var record = findVocabRecord(word);
    if (!record) return null;
    record.status = status;
    record.nextReviewDate = calcVocabNextReviewDate(status, vocabToday());
    persistVocabBook();
    notifyVocabListeners();
    return copyVocabRecord(record);
  },

  /**
   * 今天需要复习的词（nextReviewDate <= 今天，已掌握不算）
   * @param {string} [today] "YYYY-MM-DD"
   * @returns {Array<Object>}
   */
  getDueWords(today) {
    loadVocabBook();
    var dateStr = today || vocabToday();
    return vocabBook
      .filter(function (item) {
        if (item.status === "mastered") return false;
        return item.nextReviewDate <= dateStr;
      })
      .sort(function (a, b) {
        return a.nextReviewDate < b.nextReviewDate ? -1 : 1;
      })
      .map(copyVocabRecord);
  },

  /**
   * 统计信息
   * @returns {{total:number, byStatus:Object, new:number, familiar:number,
   *            known:number, mastered:number, dueCount:number}}
   */
  getStats() {
    loadVocabBook();
    var byStatus = { "new": 0, familiar: 0, known: 0, mastered: 0 };
    vocabBook.forEach(function (item) {
      if (byStatus[item.status] !== undefined) byStatus[item.status]++;
    });
    return {
      total: vocabBook.length,
      byStatus: byStatus,
      "new": byStatus["new"],
      familiar: byStatus.familiar,
      known: byStatus.known,
      mastered: byStatus.mastered,
      dueCount: this.getDueWords().length
    };
  },

  /** 是否已在单词本里 */
  isInVocabBook(word) {
    loadVocabBook();
    return !!findVocabRecord(word);
  },

  /** 补齐/更新单词的静态信息 */
  updateWordInfo(word, info) {
    loadVocabBook();
    var record = findVocabRecord(word);
    if (!record) return null;
    var data = info || {};
    if (record.phonetic === "" && data.phonetic) record.phonetic = String(data.phonetic);
    if (record.pos === "" && data.pos) record.pos = String(data.pos);
    if (record.meaning === "" && data.meaning) record.meaning = String(data.meaning);
    persistVocabBook();
    notifyVocabListeners();
    return copyVocabRecord(record);
  },

  /** 订阅数据变化 */
  subscribe(fn) {
    if (typeof fn !== "function") return function () { /* noop */ };
    vocabListeners.push(fn);
    return function () {
      var i = vocabListeners.indexOf(fn);
      if (i >= 0) vocabListeners.splice(i, 1);
    };
  },

  /** 清空单词本 */
  clear() {
    vocabBook = [];
    vocabLoaded = true;
    var store = vocabGetStorage();
    if (store) {
      try { store.removeItem(VOCAB_BOOK_KEY); } catch (e) { /* ignore */ }
    }
    notifyVocabListeners();
  },

  /** 内部测试接口 */
  _test: {
    VOCAB_STATUSES: VOCAB_STATUSES,
    VOCAB_INTERVAL_DAYS: VOCAB_INTERVAL_DAYS,
    VOCAB_FAST_MS: VOCAB_FAST_MS,
    VOCAB_SLOW_MS: VOCAB_SLOW_MS,
    VOCAB_V1_TO_V2: VOCAB_V1_TO_V2,
    vocabStepUp: vocabStepUp,
    vocabStepDown: vocabStepDown,
    calcVocabNextReviewDate: calcVocabNextReviewDate,
    normalizeVocabWord: normalizeVocabWord,
    vocabToday: vocabToday,
    vocabAddDays: vocabAddDays,
    migrateV1ToV2: migrateV1ToV2,
    /** 直接改内存记录的 nextReviewDate（造「已到期」测试数据用） */
    setNextReviewDate: function (word, dateStr) {
      loadVocabBook();
      var rec = findVocabRecord(word);
      if (!rec) return null;
      rec.nextReviewDate = dateStr;
      persistVocabBook();
      return copyVocabRecord(rec);
    }
  }
};

// 浏览器环境下挂 window；Node 环境下导出
if (typeof window !== "undefined") {
  window.VocabBook = VocabBook;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = VocabBook;
}
