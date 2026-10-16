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

/**
 * 来源归一化（统一 source 语义）：
 *   - 只有显式 "manual" 才是「手动添加」；
 *   - 其余（未传、以及旧数据的 "long_press" / "cloud" / "app" / "wordbook"）一律按 "news" 处理，
 *     兼容旧数据，同时让「今日新词只取新闻来源」的过滤可靠生效。
 * @param {string} s
 * @returns {"news"|"manual"}
 */
function normalizeVocabSource(s) {
  return s === "manual" ? "manual" : "news";
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
      source: normalizeVocabSource(item.source),
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
        source: normalizeVocabSource(item.source),
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

/**
 * 补全已存在记录的缺失字段（不覆盖已填内容）。
 * 规则：
 *   - meaning / pos：仅当记录为空且新数据有值时补；但若该记录是「用户手动添加且已带释义」，
 *     视为用户已编辑过的完整记录，不回写 meaning/pos，避免覆盖用户自己的版本。
 *   - phonetic / rank：客观数据，记录里缺失即补，不覆盖已有值。
 * @param {Object} rec 真实记录对象（会被原地修改）
 * @param {Object|string} data 新数据
 * @returns {boolean} 是否有改动
 */
function backfillVocabRecord(rec, data) {
  var raw = (typeof data === "string") ? { word: data } : (data || {});
  var changed = false;
  var userComplete = rec.source === "manual" && !!rec.meaning;
  if (!userComplete) {
    if (!rec.meaning && raw.meaning) { rec.meaning = String(raw.meaning); changed = true; }
    if (!rec.pos && raw.pos) { rec.pos = String(raw.pos); changed = true; }
  }
  if (!rec.phonetic && raw.phonetic) { rec.phonetic = String(raw.phonetic); changed = true; }
  var newRank = (raw.rank !== undefined && raw.rank !== null) ? raw.rank : null;
  if ((rec.rank === undefined || rec.rank === null) && newRank !== null) {
    rec.rank = newRank; changed = true;
  }
  return changed;
}

  /* ==========================================================================
   * 5. 对外 API：VocabBook
   * ========================================================================== */

  /* ---------- 云端同步（Supabase，本地优先、异步、不阻塞本地使用） ---------- */
  function isCloudApiReady() {
    return (typeof window !== "undefined") && !!window.DB;
  }

  // 单个单词异步同步到云端（fire-and-forget，失败仅打印控制台）
  function syncWordToCloud(rec) {
    if (!rec || !isCloudApiReady()) return;
    try {
      window.DB.upsertWord(copyVocabRecord(rec)).catch(function (e) {
        console.warn("[VocabBook] 同步单词到云端失败:", e && e.message);
      });
    } catch (e) {
      console.warn("[VocabBook] 同步单词到云端异常:", e && e.message);
    }
  }

  // 批量异步同步到云端
  function syncWordsToCloud(recs) {
    if (!recs || !recs.length || !isCloudApiReady()) return;
    try {
      window.DB.upsertWords(recs.map(copyVocabRecord)).catch(function (e) {
        console.warn("[VocabBook] 批量同步到云端失败:", e && e.message);
      });
    } catch (e) {
      console.warn("[VocabBook] 批量同步到云端异常:", e && e.message);
    }
  }

  // 云端删除（fire-and-forget）
  function deleteWordFromCloud(word) {
    if (!word || !isCloudApiReady()) return;
    try {
      window.DB.deleteWord(word).catch(function (e) {
        console.warn("[VocabBook] 云端删除单词失败:", e && e.message);
      });
    } catch (e) {
      console.warn("[VocabBook] 云端删除单词异常:", e && e.message);
    }
  }

  // 云端拉回的记录补全字段，保证与本地 schema 一致
  function normalizeCloudRecord(r) {
    if (!r || typeof r.word !== "string" || !r.word) return null;
    return {
      word: normalizeVocabWord(r.word),
      phonetic: String(r.phonetic || ""),
      pos: String(r.pos || ""),
      meaning: String(r.meaning || ""),
      status: VOCAB_STATUSES.indexOf(r.status) >= 0 ? r.status : "new",
      addedAt: Number(r.addedAt) || Date.now(),
      nextReviewDate: r.nextReviewDate || calcVocabNextReviewDate("new", vocabToday()),
      reviewCount: Number(r.reviewCount) || 0,
      source: normalizeVocabSource(r.source),
      sourceNewsId: String(r.sourceNewsId || "")
    };
  }

  // 登录成功后从云端拉取并覆盖本地（第一版：云端为准）
  function pullFromCloudOnLogin() {
    if (!isCloudApiReady() || !window.DB.isLoggedIn()) return;
    if (window.VocabBook && window.VocabBook.syncFromCloud) window.VocabBook.syncFromCloud();
  }

  // 订阅登录态：登录即拉取
  if (typeof window !== "undefined" && window.Auth && window.Auth.onAuthStateChange) {
    window.Auth.onAuthStateChange(function (event, user) {
      if (user) pullFromCloudOnLogin();
    });
  }

  /* ----------------------------------------------------------------------
   * 音标自动补全（免费 API：dictionaryapi.dev）
   * ---------------------------------------------------------------------- */

  /**
   * 查单词音标。
   * 解析规则：优先用返回数组里某条的顶层 phonetic；
   * 没有就遍历 phonetics 数组，取第一个带 text 的。
   * 查不到 / 404 / 网络异常 / JSON 解析失败 → 一律返回 ''，
   * 绝不抛错、绝不阻塞主流程（调用方自己决定要不要等）。
   * @param {string} word
   * @returns {Promise<string>}
   */
  function fetchPhonetic(word) {
    var w = normalizeVocabWord(word);
    if (!w) return Promise.resolve("");
    var url = "https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(w);
    if (typeof fetch !== "function") return Promise.resolve("");
    console.info("[VocabBook] 查音标 GET:", w, url);
    return fetch(url)
      .then(function (resp) {
        // 单词不存在时 API 返回 404 + {title:"No Definitions Found"}，算查不到
        if (!resp || !resp.ok) return "";
        return resp.json().then(function (json) {
          if (!json) return "";
          // 成功时返回的是数组；这里兼容一下非数组的情况，少一层假设
          var entries = Array.isArray(json) ? json : [json];
          // 1) 顶层 phonetic 优先
          for (var i = 0; i < entries.length; i++) {
            if (entries[i] && entries[i].phonetic) return String(entries[i].phonetic);
          }
          // 2) 退而求其次：遍历每条的 phonetics，取第一个有 text 的
          for (var j = 0; j < entries.length; j++) {
            var phs = entries[j] && entries[j].phonetics;
            if (Array.isArray(phs)) {
              for (var k = 0; k < phs.length; k++) {
                if (phs[k] && phs[k].text) return String(phs[k].text);
              }
            }
          }
          return "";
        }).catch(function () {
          return "";   // JSON 解析失败当查不到
        });
      })
      .catch(function (e) {
        console.warn("[VocabBook] 音标查询失败:", (e && e.message) || e);
        return "";
      });
  }

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
    var existing = findVocabRecord(word);
    if (existing) {
      // 已存在 → 只补全缺失字段，不覆盖用户已编辑的完整记录；有改动才落盘+同步
      var backfilled = backfillVocabRecord(existing, data);
      if (backfilled) {
        persistVocabBook();
        notifyVocabListeners();
        syncWordToCloud(existing);
      }
      return backfilled; // true=已补全；false=已存在且无变化 / 用户完整记录
    }

    var now = Date.now();
    var today = vocabToday();
    vocabBook.push({
      word: word,
      phonetic: String(data.phonetic || ""),
      pos: String(data.pos || ""),
      meaning: String(data.meaning || ""),
      rank: (data.rank !== undefined && data.rank !== null) ? data.rank : null,
      status: "new",
      addedAt: Number(data.addedAt) || now,
      nextReviewDate: calcVocabNextReviewDate("new", today),
      reviewCount: Number(data.reviewCount) || 0,
      source: normalizeVocabSource(data.source),
      sourceNewsId: String(data.sourceNewsId || "")
    });

    persistVocabBook();
    notifyVocabListeners();
    syncWordToCloud(findVocabRecord(word));

    // 用户没填音标 → 后台查一次自动补上（非阻塞：先以空音标存好，查到再回填 + 重新同步云端）
    if (!data.phonetic) {
      console.info("[VocabBook] 未填音标，后台查音标:", word);
      fetchPhonetic(word).then(function (ph) {
        if (!ph) return;                         // 查不到就维持空，不报错、不阻塞
        var rec = findVocabRecord(word);
        if (!rec || rec.phonetic) return;         // 词被删了，或已被别的流程填上，不覆盖
        rec.phonetic = ph;
        persistVocabBook();
        notifyVocabListeners();
        syncWordToCloud(rec);                     // 补上的音标同步到云端（syncToCloud / db.js 都不用改）
        console.info("[VocabBook] 音标补全:", word, ph);
      }).catch(function () { /* 查音标失败无所谓，本地已经存好这个词 */ });
    }

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
    deleteWordFromCloud(word);
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
    var success = 0, skipped = 0, failed = 0, backfilled = 0;
    var now = Date.now();
    var today = vocabToday();

    var addedRecs = [];
    arr.forEach(function (raw) {
      var word = normalizeVocabWord((raw && typeof raw === "object") ? raw.word : raw);
      if (!word) { failed++; return; }
      var ex = findVocabRecord(word);
      if (ex) {
        // 已存在 → 补全缺失字段（不覆盖用户完整记录）；有改动才计入 backfilled
        if (backfillVocabRecord(ex, raw)) {
          addedRecs.push(ex);
          backfilled++;
        } else {
          skipped++;
        }
        return;
      }

      var rec = {
        word: word,
        phonetic: String((raw && raw.phonetic) || ""),
        pos: String((raw && raw.pos) || ""),
        meaning: String((raw && raw.meaning) || ""),
        rank: (raw && (raw.rank !== undefined && raw.rank !== null)) ? raw.rank : null,
        status: "new",
        addedAt: now,
        nextReviewDate: calcVocabNextReviewDate("new", today),
        reviewCount: 0,
        source: normalizeVocabSource(source),
        sourceNewsId: ""
      };
      vocabBook.push(rec);
      addedRecs.push(rec);
      success++;
    });

    if (success > 0 || backfilled > 0) {
      persistVocabBook();
      notifyVocabListeners();
      syncWordsToCloud(addedRecs);
    }
    return { success: success, skipped: skipped, failed: failed, backfilled: backfilled };
  },

  /**
   * 重建单词本（导入词典时的「保留已有 / 覆盖」选项入口）
   * @param {Array<string|Object>} wordsArray 词典词列表
   * @param {"keep"|"overwrite"} [mode="keep"]
   *        - keep：等价于 batchAdd，新增缺失词 + 补全已有空壳词，不动其它词（默认、最安全）
   *        - overwrite：先移除「非手动添加」的词（news/dict 导入的旧词），保留用户手动词，
   *                     再用新词列表批量并入，相当于用一本词典重置单词本内容。
   * @param {string} [source="news"] 新词的来源标记
   * @returns {{success:number, skipped:number, failed:number, backfilled:number}}
   */
  rebuildBook(wordsArray, mode, source) {
    loadVocabBook();
    var arr = Array.isArray(wordsArray) ? wordsArray : [];
    if (mode === "overwrite") {
      // 覆盖模式：只保留用户手动添加的词，其余（新闻/旧词典导入）先清掉
      var kept = [];
      vocabBook.forEach(function (r) {
        if (r.source === "manual") kept.push(r);
      });
      vocabBook = kept;
      persistVocabBook();
      notifyVocabListeners();
    }
    // 无论哪种模式，最后统一走 batchAdd（新增 + 补全已有空壳）
    return this.batchAdd(arr, source || "news");
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
    syncWordToCloud(copyVocabRecord(record));
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
    syncWordToCloud(copyVocabRecord(record));
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

  /** 全量同步本地单词本到云端（手动「立即同步」/ 登录拉取后兜底都会用到） */
  syncToCloud() {
    if (!isCloudApiReady() || !window.DB.isLoggedIn()) {
      return Promise.resolve({ ok: false, error: "未登录" });
    }
    return window.DB.syncLocalToCloud(VocabBook.getAllWords())
      .then(function (res) {
        if (res && res.error) return { ok: false, error: res.error };
        return { ok: true, count: VocabBook.getAllWords().length };
      })
      .catch(function (e) { return { ok: false, error: (e && e.message) || "同步失败" }; });
  },

  /** 从云端拉取并覆盖本地（登录时由内部调用；第一版：云端为准） */
  syncFromCloud() {
    if (!isCloudApiReady() || !window.DB.isLoggedIn()) {
      return Promise.resolve(null);
    }
    return window.DB.syncCloudToLocal()
      .then(function (cloud) {
        if (!cloud) return null;
        if (cloud.length > 0) {
          var cleaned = [];
          for (var i = 0; i < cloud.length; i++) {
            var n = normalizeCloudRecord(cloud[i]);
            if (n) cleaned.push(n);
          }
          vocabBook = cleaned;
          vocabLoaded = true;
          persistVocabBook();
          notifyVocabListeners();
          return cleaned;
        }
        // 云端为空：把本地上传，保证首次登录不丢数据
        return window.DB.syncLocalToCloud(VocabBook.getAllWords())
          .then(function () { return []; });
      })
      .catch(function (e) {
        console.warn("[VocabBook] 云端拉取失败:", e && e.message);
        return null;
      });
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
  },

  /** 查音标（免费 API：dictionaryapi.dev），查不到返回 ''，不抛错 */
  fetchPhonetic: fetchPhonetic
};

// 浏览器环境下挂 window；Node 环境下导出
if (typeof window !== "undefined") {
  window.VocabBook = VocabBook;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = VocabBook;
}
