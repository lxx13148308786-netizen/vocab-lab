/**
 * app.js
 * AI 新闻背单词 H5 应用 —— 每日阅读页面主逻辑（单页应用 · 四 Tab）
 *
 * 依赖加载顺序：data.js → wordpool.js → news.js → ai.js → app.js
 * 依赖的全局对象：FREQUENCY_WORDS / NEWS_LIST / WordPool / NewsMatcher / AICaller
 *
 * 职责：
 *   1. 打开页面自动生成今日内容包（单词池 → 匹配新闻 → 改写 → 词汇段 → 检测题）并存 localStorage
 *   2. 当天再次打开直接读缓存
 *   3. Tab 切换、做题判分并联动 WordPool.updateWordStatus
 *   4. 底部：加词 / 换一篇 / 单词本
 */

// 测试 Supabase 连接
(async function testSupabase() {
  console.log('🚀 正在初始化 Supabase...');
  if (!window.Auth || !window.Auth.client) {
    console.error('❌ Supabase 客户端初始化失败');
    return;
  }
  console.log('✅ Supabase 客户端创建成功');
  const user = await window.Auth.getCurrentUser();
  if (user) {
    console.log('👤 当前已登录：', user.email);
  } else {
    console.log('🔓 当前未登录');
  }
  window.Auth.onAuthStateChange((event, user) => {
    console.log(`🔔 认证状态变化：${event}`, user?.email || '未登录');
  });
})();

/* ==========================================================================
 * 1. 常量与工具
 * ========================================================================== */

const STORAGE_KEYS = {
  pack: "ainv:dailyPack",
  library: "ainv:library",
  days: "ainv:learnDays",
  progress: "ainv:quizProgress"   // 答题进度单独存，且绑定题包 key
};

/* 内容包格式版本：Prompt 或结构变了就 +1，旧缓存会自动失效并重新生成 */
const PACK_VERSION = 4;   // v3 = 答题进度从 pack 里拆出来，按 quizKey 绑定

const WEEK_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 取 localStorage，Node 环境下返回 null */
function getStorage() {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch (e) { /* 隐私模式等场景，忽略 */ }
  return null;
}

/** 今天日期 "YYYY-MM-DD" */
function getTodayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + m + "-" + day;
}

/** 日期转成 "10月2日 周五" */
function formatDateCN(dateStr) {
  const parts = String(dateStr).split("-");
  if (parts.length !== 3) return dateStr;
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return Number(parts[1]) + "月" + Number(parts[2]) + "日 " + WEEK_CN[d.getDay()];
}

/** HTML 转义 */
function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 把正文里出现的目标词加粗高亮
 * 两步：
 *   1) 先把 AI 输出的 **加粗** markdown 转成 <strong class="hl">（词形变化由模型自己负责）
 *   2) 再对没被标记的目标词补一层高亮，允许常见词形变化（s/es/ed/ing/ly…）
 * @param {string} text 正文
 * @param {Array<Object|string>} words 目标词
 * @returns {string} 已转义的 HTML
 */
function highlightWords(text, words) {
  const list = (words || []).map(function (w) {
    const word = typeof w === "string" ? w : (w && w.word);
    return String(word || "").trim().toLowerCase();
  }).filter(Boolean);

  let html = escapeHtml(text);

  // 1) **加粗** → 占位符（占位符不含字母，不会被第 2 步误伤）
  const bolds = [];
  html = html.replace(/\*\*(.+?)\*\*/g, function (all, inner) {
    bolds.push(inner);
    return "\u0000" + (bolds.length - 1) + "\u0000";
  });

  // 2) 目标词原形 + 常见词形变化统一补高亮
  list.forEach(function (word) {
    const root = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("\\b(" + root + "(?:s|es|d|ed|ing|ly|er|ers|ion|ions|ive|able|ment|ness)?)\\b", "gi");
    html = html.replace(re, function (all) { return "<strong class=\"hl\">" + all + "</strong>"; });
  });

  // 3) 占位符还原成高亮标签
  html = html.replace(/\u0000(\d+)\u0000/g, function (all, i) {
    return "<strong class=\"hl\">" + bolds[Number(i)] + "</strong>";
  });

  return html;
}

/**
 * 给正文里的每个英文单词包一层 <span class="word">，供点击查词用
 *
 * 规则：
 *   - 只包英文字母串（含词内连字符/撇号，如 state-of-the-art、don't）
 *   - 标点、数字、空格原样留在 span 外面
 *   - 已有的 HTML 标签（<strong>…</strong>、<br>）整段跳过，
 *     所以加粗目标词会变成 <strong class="hl"><span class="word">diligent</span></strong>
 *   - HTML 实体（&amp; 等）整体跳过，不会被拆坏
 *
 * @param {string} html 已转义、已完成高亮的 HTML
 * @returns {string}
 */
function wrapWordsInHtml(html) {
  const src = String(html || "");
  let out = "";
  let i = 0;
  let wordDepth = 0;      // 正在 .word 内部的层数（防止重复包裹）

  while (i < src.length) {
    const ch = src[i];

    // 1) HTML 标签原样整段复制（<strong class="hl">、</strong>、<br>…）
    if (ch === "<") {
      const end = src.indexOf(">", i);
      const stop = (end < 0) ? src.length : end + 1;
      const tag = src.slice(i, stop);
      // 记录是否已经身处 <span class="word"> 里，保证本函数重复执行也不会嵌套包裹
      if (/^<span\b/i.test(tag) && /class="[^"]*\bword\b[^"]*"/i.test(tag)) wordDepth++;
      else if (/^<\/span>/i.test(tag) && wordDepth > 0) wordDepth--;
      out += tag;
      i = stop;
      continue;
    }

    // 2) HTML 实体整体复制，避免 &amp; 被当成词切开
    if (ch === "&") {
      const end = src.indexOf(";", i);
      const stop = (end < 0) ? src.length : end + 1;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }

    // 3) 已经在 .word 里面的内容，原样输出（幂等）
    if (wordDepth > 0) {
      out += ch;
      i++;
      continue;
    }

    // 4) 英文单词 → 包 span
    const m = /^[A-Za-z][A-Za-z'\-]*/.exec(src.slice(i));
    if (m) {
      out += '<span class="word">' + m[0] + "</span>";
      i += m[0].length;
      continue;
    }

    // 5) 其余字符（空格、标点、数字、中文）原样输出
    out += ch;
    i++;
  }

  return out;
}

/** 显示 toast 提示 */
function toast(message) {
  const box = (typeof document !== "undefined") ? document.getElementById("toast") : null;
  if (!box) return;
  box.textContent = message;
  box.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function () { box.classList.remove("show"); }, 2600);
}

/* ==========================================================================
 * 2. 词库持久化（wordpool.js 不提供持久化，这里在应用层做）
 * ========================================================================== */

/** 把当前词库写进 localStorage */
function saveLibrary() {
  const store = getStorage();
  if (!store || typeof WordPool === "undefined") return;
  try {
    store.setItem(STORAGE_KEYS.library, JSON.stringify(WordPool.getAllWords()));
  } catch (e) { /* 存不下就算了 */ }
}

/**
 * 恢复词库：先用高频词初始化，再把本地存过的词补齐字段塞回去
 */
function restoreLibrary() {
  if (typeof WordPool === "undefined" || typeof FREQUENCY_WORDS === "undefined") return;
  WordPool.init(FREQUENCY_WORDS);

  const store = getStorage();
  if (!store) return;

  let saved = [];
  try {
    saved = JSON.parse(store.getItem(STORAGE_KEYS.library) || "[]");
  } catch (e) {
    saved = [];
  }
  if (!Array.isArray(saved)) return;

  saved.forEach(function (item) {
    if (!item || !item.word) return;
    const word = WordPool.addWord(item.word, item.pos, item.meaning, item.source, item.phonetic);
    if (!word) return;
    // 把记忆状态相关的字段同步回去
    // fromVocab：是否在单词本里（今日单词表据此标 📚），每次进池时会由 syncVocabBookWords 重算
    ["status", "addDate", "nextReview", "reviewCount", "lastReview", "active", "fromVocab"].forEach(function (key) {
      if (item[key] !== undefined) word[key] = item[key];
    });
  });
}

/** 记录学习天数，返回累计天数 */
function touchLearnDay(todayStr) {
  const store = getStorage();
  if (!store) return 1;
  let days = [];
  try {
    days = JSON.parse(store.getItem(STORAGE_KEYS.days) || "[]");
  } catch (e) {
    days = [];
  }
  if (!Array.isArray(days)) days = [];
  if (days.indexOf(todayStr) < 0) days.push(todayStr);
  try {
    store.setItem(STORAGE_KEYS.days, JSON.stringify(days));
  } catch (e) { /* ignore */ }
  return days.length;
}

/* ==========================================================================
 * 3. 今日内容包：生成 / 读取 / 保存
 * ========================================================================== */

/**
 * 降级内容包：新闻库为空时用。
 * 单词表照常显示（这是用户真正要的），新闻/词汇段给出明确说明而不是转圈或崩掉。
 * @param {string} today 今天日期
 * @param {Array<Object>} words 今日新词（已 normalize）
 * @param {Object} pool generateDailyPool 原始返回
 * @param {Object} extra { newCount, reviewCount, standbyCount }
 * @returns {Object} 内容包
 */
function buildDegradedPack(today, words, pool, extra) {
  const info = extra || {};
  const pack = {
    version: PACK_VERSION,
    date: today,
    quizGeneratedAt: Date.now(),
    words: words,
    breakdown: {
      newCount: info.newCount || 0,
      reviewCount: info.reviewCount || 0,
      standbyCount: info.standbyCount || 0
    },
    news: null,
    newsIndex: 0,
    rewritten: "",
    uncoveredWords: [],
    vocabParagraph: "",
    quiz: { meaningQuestions: [], fillQuestions: [], activeRecommend: [], answers: {} },
    aiSource: { rewrite: "skip", vocab: "skip", quiz: "skip" },
    aiTiming: { rewrite: 0, vocab: 0, quiz: 0 },
    aiError: { rewrite: "新闻库为空", vocab: "新闻库为空", quiz: "" },
    degraded: true,
    degradeReason: "news_missing"
  };
  savePack(pack);
  resetQuizProgress(pack);
  saveLibrary();
  touchLearnDay(today);
  return pack;
}

/**
 * 取学习者的估计词汇量，用于新闻改写的难度适配。
 *
 * 数据来自词汇量测试（vocabTest.js 的 loadResult），存在 anv_vocabTestResult，
 * 字段是 score（0~12000，取整到百位）。没测过 / 数据异常时返回 null，
 * 调用方据此退回「固定中级难度」的老行为，不会因为缺数据而报错。
 *
 * @returns {number|null}
 */
function getVocabSize() {
  if (typeof VocabTest === "undefined" || !VocabTest.loadResult) return null;
  try {
    const r = VocabTest.loadResult();
    const n = r && Number(r.score);
    // 上限跟 vocabTest 的 LEVEL_BOUNDS 对齐：超过 12000 说明数据异常
    if (!isFinite(n) || n <= 0 || n > 12000) return null;
    return n;
  } catch (e) {
    return null;
  }
}

/**
 * 生成今日内容包
 * @param {string} todayStr 今天日期
 * @param {Object} options { newsIndex:number } 「换一篇」时轮换到候选列表的第几篇
 * @returns {Promise<Object>} 今日内容包
 */
async function generateDailyPack(todayStr, options) {
  const opts = options || {};
  const today = todayStr || getTodayStr();

  restoreLibrary();

  // 1) 今日单词池
  //    V2 的 generateDailyPool 返回 { date, newWords, reviewWords, standbyWords }，
  //    首页只消费「今日新学」这一组（复习/候补归单词本和刷词模块管）。
  //    这里对三个字段都做兜底，避免任何一层返回 undefined 时整页崩在 .map() 上。
  const pool = WordPool.generateDailyPool(today, 20) || {};
  const newWords = Array.isArray(pool.newWords) ? pool.newWords : [];
  const reviewWords = Array.isArray(pool.reviewWords) ? pool.reviewWords : [];
  const standbyWords = Array.isArray(pool.standbyWords) ? pool.standbyWords : [];

  // 词库整个空了（新用户 + 单词本空）时也不能崩：给一个空数组，
  // 后续新闻匹配会退化成「随便挑一篇」，UI 走"还没有今日单词"的空态。
  const todayWords = newWords;
  const words = todayWords.map(function (w) {
    return {
      id: w.id, word: w.word, pos: w.pos, meaning: w.meaning,
      phonetic: w.phonetic, source: w.source, status: w.status,
      fromVocab: !!w.fromVocab
    };
  });

  // 2) 匹配新闻（newsIndex 用于「换一篇」轮换）
  //    新闻库为空属于「新闻部分不可用」，不该把单词表/词汇段一起带走，
  //    所以这里不 throw，改为标记 newsMissing 走降级渲染。
  NewsMatcher.init(NEWS_LIST);
  const candidates = NewsMatcher.matchTopN(words, 10) || [];
  const newsMissing = candidates.length === 0;
  const index = newsMissing ? 0 : Math.min(opts.newsIndex || 0, candidates.length - 1);
  const news = newsMissing ? null : candidates[index].news;

  // 标记为已读（覆盖「初次生成」与「换一篇」两个场景，换一篇走的是同一个 generateDailyPack）
  if (news && typeof ReadHistory !== "undefined" && ReadHistory.markAsRead) {
    ReadHistory.markAsRead(news.id);
  }

  // 3) 改写成学习材料（词汇段依赖它的结果，必须先跑完）
  //    没有新闻可匹配时，rewrite/词汇段/检测题全部走空态，不去空跑 AI
  if (newsMissing) {
    return buildDegradedPack(today, words, pool, {
      newCount: newWords.length,
      reviewCount: reviewWords.length,
      standbyCount: standbyWords.length
    });
  }
  setGenerating(true, "正在生成今日内容…（1/2 新闻改写）");
  // 难度适配：把学习者词汇量交给改写 prompt。没测过词汇量时 getVocabSize() 返回 null，
  // ai.js 会退回固定「中级（专四水平）」，所以未测量的用户行为跟以前完全一样。
  const rewriteRes = await AICaller.rewriteNews(words, news, { vocabSize: getVocabSize() });
  const rewrite = (rewriteRes && rewriteRes.data) || { rewritten: news.content, uncoveredWords: [] };
  const rewritten = rewrite.rewritten || news.content;
  // 没嵌进正文的词不追加到末尾（会把新闻搞成单词表），单独列在新闻区下方，
  // 同时它们会进入词汇段的 remainingWords，由短文自然覆盖
  const uncoveredWords = Array.isArray(rewrite.uncoveredWords) ? rewrite.uncoveredWords : [];

  // 4) 词汇应用段：覆盖新闻里没出现的词
  //    本地兜底模式下所有词都会被塞进正文，此时取前 8 个词生成练习段，避免 Tab 3 空着
  const remainingWords = words.filter(function (w) {
    return !new RegExp("\\b" + w.word + "\\b", "i").test(rewritten);
  }).concat(
    // 模型自己报告没写进去的词，也要补进短文
    uncoveredWords
      .map(function (word) {
        return words.filter(function (w) { return w.word === word; })[0];
      })
      .filter(Boolean)
  ).filter(function (w, i, arr) { return arr.indexOf(w) === i; });
  // 4)+5) 词汇段和检测题互不依赖，并行跑，省一半等待时间
  //        两者各自独立降级：一个失败只影响它自己，不会把另一个也拖回本地
  const vocabTargetWords = remainingWords.length ? remainingWords : words.slice(0, 8);
  setGenerating(true, "正在生成今日内容…（2/2 词汇段 + 检测题）");

  // 万一某个模块整个炸了（正常不会，AICaller 内部已兜住），也不能把另一个拖下水
  const [vocabRes, quizRes] = await Promise.all([
    AICaller.generateVocabParagraph(news.topic, vocabTargetWords)
      .catch(function (err) {
        return { ok: false, source: "mock", data: "", error: String((err && err.message) || err) };
      }),
    AICaller.generateQuiz(words)
      .catch(function (err) {
        return { ok: false, source: "mock", data: null, error: String((err && err.message) || err) };
      })
  ]);

  const vocabParagraph = (vocabRes && vocabRes.data) || "";
  const quiz = (quizRes && quizRes.data) ||
    { meaningQuestions: [], fillQuestions: [], activeRecommend: [], answers: {} };

  const pack = {
    version: PACK_VERSION,
    date: today,
    quizGeneratedAt: Date.now(),   // 题目生成时间戳，和 version 一起组成答题进度 key
    words: words,
    // V2 的三区块构成，替代 V1 的 breakdown（new/review/standby 各自的数量）
    breakdown: {
      newCount: newWords.length,
      reviewCount: reviewWords.length,
      standbyCount: standbyWords.length
    },
    news: { id: news.id, title: news.title, topic: news.topic, difficulty: news.difficulty },
    newsIndex: index,
    rewritten: rewritten,
    uncoveredWords: uncoveredWords,
    vocabParagraph: vocabParagraph,
    quiz: quiz,
    aiSource: {
      rewrite: (rewriteRes && rewriteRes.source) || "mock",
      vocab: (vocabRes && vocabRes.source) || "mock",
      quiz: (quizRes && quizRes.source) || "mock"
    },
// 每个模块的耗时与错误，控制台排查性能瓶颈用
      aiTiming: {
        rewrite: (rewriteRes && rewriteRes.durationMs) || 0,
        vocab: (vocabRes && vocabRes.durationMs) || 0,
        quiz: (quizRes && quizRes.durationMs) || 0
      },
      aiError: {
        rewrite: (rewriteRes && rewriteRes.error) || "",
        vocab: (vocabRes && vocabRes.error) || "",
        quiz: (quizRes && quizRes.error) || ""
      },
      // 本次生成时是否处于离线状态（来自 ai.js 的短路判断 res.offline）。
      // UI 用它区分「离线」和「AI 服务挂了」——两者的提示文案不同。
      // 兼容：老包里没这个字段，renderNews 里读到 undefined 会按非离线处理。
      aiOffline: !!((rewriteRes && rewriteRes.offline) ||
                    (vocabRes && vocabRes.offline) ||
                    (quizRes && quizRes.offline))
    };

  logPackTiming(pack);

  savePack(pack);
  resetQuizProgress(pack);      // 新题包 → 旧作答状态一律作废
  saveLibrary();
  touchLearnDay(today);
  return pack;
}

/** 写入今日内容包 */
function savePack(pack) {
  const store = getStorage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEYS.pack, JSON.stringify(pack));
  } catch (e) { /* ignore */ }
}

/** 读取今日内容包（日期不符或解析失败返回 null） */
function loadTodayPack(todayStr) {
  const store = getStorage();
  if (!store) return null;
  let pack = null;
  try {
    pack = JSON.parse(store.getItem(STORAGE_KEYS.pack) || "null");
  } catch (e) {
    pack = null;
  }
  if (!pack || pack.date !== todayStr) return null;
  if (pack.version !== PACK_VERSION) return null;   // 旧格式缓存，重新生成
  // 结构校验：words 必须是数组。V2 重构前的缓存包虽然 version 相同，
  // 但字段结构不同，缺数组会让渲染层在 .map() 上炸掉 —— 宁可重新生成。
  if (!Array.isArray(pack.words)) return null;
  return pack;
}

/* ==========================================================================
 * 3.5 答题进度（单独存储 + 绑定题包 key）
 *
 * 为什么单独存：题目 id 是 mq1/fq1 这类固定序号，换一篇后 id 相同但内容变了。
 * 如果进度跟着 pack 走（或换题时被原样继承），旧答案会套到新题上，
 * 页面一打开就显示上一轮的选中和对错。所以进度必须和「题包身份」绑定：
 * quizKey 变了就作废重来。
 * ========================================================================== */

/**
 * 题包身份 key = 内容包版本 + 题目生成时间戳（+ 新闻序号，换一篇也换 key）
 * @param {Object} pack
 * @returns {string}
 */
function makeQuizKey(pack) {
  const version = (pack && pack.version !== undefined) ? pack.version : 0;
  const ts = (pack && pack.quizGeneratedAt) ? pack.quizGeneratedAt : 0;
  const idx = (pack && pack.newsIndex !== undefined) ? pack.newsIndex : 0;
  return "v" + version + "-" + ts + "-" + idx;
}

/** 一份干净的空进度（graded 记录已升降级过的词，避免同词被多道题重复批改） */
function createEmptyProgress(pack) {
  return {
    quizKey: makeQuizKey(pack),
    answers: {},
    correctIds: [],
    wrongIds: [],
    graded: {},
    finished: false
  };
}

/** 存进度 */
function saveProgress(progress) {
  const store = getStorage();
  if (!store || !progress) return;
  try {
    store.setItem(STORAGE_KEYS.progress, JSON.stringify(progress));
  } catch (e) { /* ignore */ }
}

/** 清掉进度（新题包生成时调用） */
function clearProgress() {
  const store = getStorage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEYS.progress);
  } catch (e) { /* ignore */ }
}

/**
 * 新题包生成后：写入一份绑定新 quizKey 的空进度，等价于清空
 * @param {Object} pack
 * @returns {Object} 空进度对象
 */
function resetQuizProgress(pack) {
  const fresh = createEmptyProgress(pack);
  clearProgress();
  saveProgress(fresh);
  return fresh;
}

/**
 * 读取进度：题包身份对不上就直接重置，旧答案绝不带到新题上
 * @param {Object} pack
 * @returns {Object} 进度对象（保证字段完整）
 */
function loadProgress(pack) {
  if (!pack) return createEmptyProgress(pack);

  const key = makeQuizKey(pack);
  const store = getStorage();
  let saved = null;
  if (store) {
    try {
      saved = JSON.parse(store.getItem(STORAGE_KEYS.progress) || "null");
    } catch (e) {
      saved = null;
    }
  }

  // key 一致才复用；缺失或题包变了都走重置
  if (saved && saved.quizKey === key) {
    return {
      quizKey: key,
      answers: (saved.answers && typeof saved.answers === "object") ? saved.answers : {},
      correctIds: Array.isArray(saved.correctIds) ? saved.correctIds : [],
      wrongIds: Array.isArray(saved.wrongIds) ? saved.wrongIds : [],
      graded: (saved.graded && typeof saved.graded === "object") ? saved.graded : {},
      finished: !!saved.finished
    };
  }

  if (saved && saved.quizKey && saved.quizKey !== key) clearProgress();
  const fresh = createEmptyProgress(pack);
  saveProgress(fresh);
  return fresh;
}

/** 装载题包：进度跟着一起绑定好 */
function applyPack(pack) {
  if (!pack) return;
  appState.pack = pack;
  appState.progress = loadProgress(pack);
  renderAll();
}

/* ==========================================================================
 * 4. 渲染
 * ========================================================================== */

/** 当前页面状态 */
const appState = {
  pack: null,
  progress: null,     // 答题进度，由 applyPack / loadProgress 绑定当前题包
  tab: "words",
  generating: false
};

/** 渲染顶部状态栏 */
function renderTopbar() {
  const pack = appState.pack;
  const today = pack ? pack.date : getTodayStr();
  const dateEl = document.getElementById("topDate");
  const streakEl = document.getElementById("streakDays");
  const countEl = document.getElementById("todayCount");

  if (dateEl) dateEl.textContent = formatDateCN(today);
  if (streakEl) streakEl.textContent = String(touchLearnDay(today));
  if (countEl) countEl.textContent = String(pack && pack.words ? pack.words.length : 0);

  // 首页顶部状态栏的词汇量行（上次测试结果），由 VocabTest 模块维护
  if (typeof VocabTest !== "undefined" && VocabTest.renderVocabTestLine) {
    VocabTest.renderVocabTestLine();
    // 这行有结果才显示，会改变顶栏高度。必须重算 --nav-top（Tab 栏的 sticky 偏移）
    // 和 --nav-hide-shift（隐藏位移量），否则做完词汇量测试后 Tab 栏会错位、
    // 隐藏时滑出的距离也不够。
    syncNavTop();
  }
}

/**
 * 渲染 Tab 1：单词表
 *
 * V2 起卡片只保留「单词 / 词性 / 音标 / 释义」四要素。
 * 早期版本带过两个元素，V2 已移除：
 *   - 「✓ 已在单词本 / ＋ 加入单词本」按钮：每日单词本来就在单词本里，按钮没有实际作用
 *   - 单词右侧的 📚 来源标记：用户看不懂含义，纯视觉累赘
 *
 * 布局（紧凑化）：词头独占一行，词性 + 音标 + 释义挤在下面同一行；
 * 放不下时只有释义允许换行（靠 flex-wrap + meaning 的 min-width:0 实现），
 * 词性和音标始终留在首行。词头字号/行高不动。
 * 长按收藏/查词统一走 .word 元素 + 事件委托，不依赖卡片内其他元素。
 */
function renderWordList() {
  const box = document.getElementById("tabWordsBody");
  if (!box) return;
  const words = (appState.pack && appState.pack.words) || [];
  if (!words.length) {
    box.innerHTML = '<p class="empty">还没有今日单词。</p>';
    return;
  }
  box.innerHTML = words.map(function (w) {
    return '<div class="word-item">' +
      '<div class="word-main">' +
        '<span class="word">' + escapeHtml(w.word) + "</span>" +
      "</div>" +
      '<div class="word-sub">' +
        '<span class="pos">' + escapeHtml(w.pos || "") + "</span>" +
        '<span class="phonetic">' + escapeHtml(w.phonetic || "") + "</span>" +
        '<span class="meaning">' + escapeHtml(w.meaning || "") + "</span>" +
      "</div>" +
      "</div>";
  }).join("");
}

/** 渲染 Tab 2：新闻 */
function renderNews() {
  const box = document.getElementById("tabNewsBody");
  if (!box) return;
  const pack = appState.pack;
  if (!pack) { box.innerHTML = '<p class="empty">内容生成失败。</p>'; return; }

  // 新闻库为空（降级包）：只解释原因，不让整页跟着崩
  if (!pack.news) {
    box.innerHTML =
      '<h2 class="news-title">今日新闻暂不可用</h2>' +
      '<p class="news-meta"><span class="tag">降级模式</span></p>' +
      '<div class="article news-content">' +
      "<p>新闻库没有可用条目，今天先只做单词学习。</p>" +
      "<p>单词表与检测题都可以正常使用。</p>" +
      "</div>";
    return;
  }

  // AI 没生效时会全部走 mock 兜底，这里明确告诉用户怎么恢复。
  // 分两种原因给不同文案（离线 vs 服务不可用）—— 用户看到「请运行 proxy_server.py」
  // 却发现自己根本没联网，会以为程序坏了。
  const aiDown = pack.aiSource && (pack.aiSource.rewrite === "mock" || pack.aiSource.rewrite === "skip");
  // 离线标记来自 ai.js 的短路判断（res.offline），存在 pack.aiOffline 里。
  // 兼容老包：这个字段是后加的，读不到就按「非离线」处理。
  const aiOffline = !!(pack && pack.aiOffline);

  // 未覆盖的词不在这里展示，交给词汇段自然覆盖
  box.innerHTML =
    '<h2 class="news-title">' + escapeHtml(pack.news.title) + '<button class="switch-btn" id="switchBtn">↻</button></h2>' +
    '<p class="news-meta">' + escapeHtml(pack.news.topic) + " · " + escapeHtml(pack.news.difficulty) +
    (aiDown
      ? (aiOffline
          ? ' · <span class="tag">离线模式</span>'
          : ' · <span class="tag">本地生成（AI 未生效，已降级）</span>')
      : "") +
    "</p>" +
    (aiDown ? renderAiDownHint(aiOffline) : "") +
    '<div class="article news-content" id="newsContent">' +
    wrapWordsInHtml(highlightWords(pack.rewritten, pack.words).replace(/\n\n/g, "<br><br>")) +
    "</div>";
}

/**
 * AI 服务不可用时的降级提示条。
 *
 * @param {boolean} [offline] true = 当前离线（区别于「有网但 AI 服务挂了」）
 * @returns {string} HTML
 *
 * 为什么分两种文案：离线时让用户去运行 proxy_server.py 是错的建议
 * —— 本机代理同样需要网络，而且用户此刻的问题根本不是代理。
 */
function renderAiDownHint(offline) {
  if (offline) {
    return '<div class="ai-down-hint is-offline">' +
      '<b>当前处于离线状态</b>，AI 新闻生成不可用，已切换到本地兜底内容。' +
      '单词本、刷词、词汇量测试等离线功能均可正常使用；' +
      "恢复网络后点标题右侧的 ↻ 重新生成。</div>";
  }
  return '<div class="ai-down-hint">AI 服务未启动，当前为本地兜底内容。' +
    '如需实时生成，请运行 <code>proxy_server.py</code>（默认 127.0.0.1:8787）后刷新页面。</div>';
}

/** 渲染 Tab 3：词汇应用段 */
function renderVocab() {
  const box = document.getElementById("tabVocabBody");
  if (!box) return;
  const pack = appState.pack;
  if (!pack) { box.innerHTML = '<p class="empty">内容生成失败。</p>'; return; }
  if (!pack.news) {
    box.innerHTML = '<p class="empty">今日新闻暂不可用，词汇段需要基于新闻生成，请稍后再试。</p>';
    return;
  }
  if (!pack.vocabParagraph) {
    box.innerHTML = '<p class="empty">今日单词在新闻里已全部出现，无需补充词汇段。</p>';
    return;
  }
  box.innerHTML =
    '<div class="article vocab-paragraph" id="vocabContent">' +
    wrapWordsInHtml(highlightWords(pack.vocabParagraph, pack.words).replace(/\n\n/g, "<br><br>")) +
    "</div>";
}

/**
 * 渲染单道题
 * @param {string} type "mq"（词义题）| "fq"（填空题）
 * @param {Object} q 题目对象
 * @param {Object} progress 作答进度
 * @returns {string} HTML
 */
function renderQuestion(type, q, progress) {
  const chosen = progress.answers[q.id];
  const answered = chosen !== undefined;
  const isCorrect = chosen === q.answer;

  const stem = type === "mq"
    ? '<div class="q-stem"><b>' + escapeHtml(q.word) + "</b> 的意思是？</div>"
    : '<div class="q-stem">' +
      highlightWords(q.sentence || "", [q.word]).replace(/____/g, '<span class="blank">____</span>') +
      "</div>";

  const options = (q.options || []).map(function (opt) {
    let cls = "option";
    if (answered) {
      if (opt === q.answer) cls += " is-right";
      else if (opt === chosen) cls += " is-wrong";
      cls += " disabled";
    }
    return '<button class="' + cls + '" data-qid="' + escapeHtml(q.id) +
      '" data-value="' + escapeHtml(opt) + '">' + escapeHtml(opt) + "</button>";
  }).join("");

  const feedback = answered
    ? '<div class="q-feedback ' + (isCorrect ? "ok" : "no") + '">' +
      (isCorrect ? "回答正确" : "回答错误，正确答案：" + escapeHtml(q.answer)) + "</div>"
    : "";

  return '<div class="question">' + stem + '<div class="options">' + options + "</div>" + feedback + "</div>";
}

/** 渲染 Tab 4：检测 */
function renderQuiz() {
  const box = document.getElementById("tabQuizBody");
  if (!box) return;
  const pack = appState.pack;
  if (!pack || !pack.quiz) { box.innerHTML = '<p class="empty">还没有题目。</p>'; return; }

  const quiz = pack.quiz;
  const progress = appState.progress || (appState.progress = createEmptyProgress(pack));
  const mq = quiz.meaningQuestions || [];
  const fq = quiz.fillQuestions || [];
  const rec = quiz.activeRecommend || [];
  const total = mq.length + fq.length;

  let html = "";

  if (progress.finished) {
    html += '<div class="score-card">本次得分：' + progress.correctIds.length + " / " + total +
      "（正确率 " + Math.round((progress.correctIds.length / Math.max(total, 1)) * 100) + "%）</div>";
  }

  if (mq.length) {
    html += '<h3 class="sec-title">词义回忆题（' + mq.length + "）</h3>";
    html += mq.map(function (q) { return renderQuestion("mq", q, progress); }).join("");
  }
  if (fq.length) {
    html += '<h3 class="sec-title">语境填空题（' + fq.length + "）</h3>";
    html += fq.map(function (q) { return renderQuestion("fq", q, progress); }).join("");
  }
  if (rec.length) {
    html += '<h3 class="sec-title">主动词汇推荐</h3>';
    html += rec.map(function (r) {
      return '<div class="rec-item">' +
        "<b>" + escapeHtml(r.word) + "</b>：" + escapeHtml(r.reason || "") + "</div>";
    }).join("");
  }

  box.innerHTML = html;
}

/** 渲染全部 Tab */
function renderAll() {
  renderTopbar();
  renderWordList();
  renderNews();
  renderVocab();
  renderQuiz();
  hideDictBubble();          // 正文重排了，气泡留着会指错位置
  closeWordMenu();           // 菜单同理
  applyWordMarks();          // 回灌已查词底色 + 已收藏下划线
  renderVocabBookSection();
}

/* ==========================================================================
 * 4.6 点击查词：气泡弹出 + 已查词标记
 *
 * 事件委托挂在 document 上：新闻区 / 词汇段的容器会被 renderAll 整体重绘，
 * 直接绑在容器上会在重绘后失效，所以统一在 document 上判断点击目标是不是
 * .news-content / .vocab-paragraph 里的 .word。
 * ========================================================================== */

let dictBubbleEl = null;     // 气泡 DOM（懒创建，全局只此一个）
let dictLookupToken = 0;     // 请求令牌：连点多个词时，丢弃已过期的查询结果

/** 取（没有就创建）气泡元素 */
function getDictBubble() {
  if (dictBubbleEl) return dictBubbleEl;
  if (typeof document === "undefined" || !document.createElement) return null;

  dictBubbleEl = document.createElement("div");
  dictBubbleEl.className = "dict-bubble";
  dictBubbleEl.id = "dictBubble";
  if (document.body) document.body.appendChild(dictBubbleEl);
  return dictBubbleEl;
}

/** 关闭气泡（淡出，元素保留但不可见、不响应点击） */
function hideDictBubble() {
  if (dictBubbleEl && dictBubbleEl.classList) dictBubbleEl.classList.remove("show");
}

/**
 * 计算浮层位置：优先显示在单词上方，上方空间不够就翻到下方
 * 用页面坐标（getBoundingClientRect + scroll），配合 position:absolute，
 * 这样滚动时浮层跟着正文走，不会飘在屏幕上不动。
 * 查词气泡和长按菜单共用这套定位逻辑。
 * @param {HTMLElement} bubble 浮层元素（气泡 / 菜单）
 * @param {HTMLElement} target 被点击/长按的 .word 元素
 */
function positionFloating(bubble, target) {
  if (!bubble || !target || typeof target.getBoundingClientRect !== "function") return;

  const rect = target.getBoundingClientRect();
  const scrollX = (typeof window !== "undefined") ? (window.pageXOffset || 0) : 0;
  const scrollY = (typeof window !== "undefined") ? (window.pageYOffset || 0) : 0;
  const wordTop = rect.top + scrollY;
  const wordBottom = rect.bottom !== undefined ? rect.bottom + scrollY : wordTop + (rect.height || 0);
  const wordCenterX = rect.left + scrollX + (rect.width || 0) / 2;

  const bubbleWidth = bubble.offsetWidth || 200;
  const bubbleHeight = bubble.offsetHeight || 60;
  const viewportWidth = (typeof document !== "undefined" && document.documentElement)
    ? (document.documentElement.clientWidth || 375) : 375;

  // 水平：尽量居中对齐单词，再夹到视口内，避免左右溢出
  let left = wordCenterX - bubbleWidth / 2;
  left = Math.max(8, Math.min(left, viewportWidth - bubbleWidth - 8));

  // 垂直：上方放得下就放上方，否则放下方
  // 底部还要避开常驻的操作栏（.bottombar，fixed），否则词在页面底部时
  // 气泡会被白色按钮栏盖住。BAR_H 与 css 里的 --bottombar-h 保持一致。
  const BAR_H = 63;
  const viewportHeight = (typeof window !== "undefined" && window.innerHeight) ? window.innerHeight : 667;
  const barTopInViewport = viewportHeight - BAR_H;   // 底部栏顶边（视口坐标）

  let top;
  let below = false;
  if (rect.top > bubbleHeight + 12) {
    top = wordTop - bubbleHeight - 8;
  } else {
    top = wordBottom + 8;
    below = true;
  }

  // 放在下方时若会被底部栏盖住，改放到词的上方（上方一定放得下，因为上面这条分支没走）
  if (below && (rect.bottom + bubbleHeight + 8) > barTopInViewport) {
    top = Math.max(8, wordTop - bubbleHeight - 8);
    below = false;
  }

  bubble.style.left = left + "px";
  bubble.style.top = top + "px";
  if (bubble.classList) {
    if (below) bubble.classList.add("below");
    else bubble.classList.remove("below");
  }
  // 小三角对准单词中心（气泡被夹到边缘时，三角也跟着夹住）
  const arrowX = wordCenterX - left;
  if (bubble.style && bubble.style.setProperty) {
    bubble.style.setProperty("--arrow-x",
      Math.max(12, Math.min(arrowX, Math.max(bubbleWidth - 12, 12))) + "px");
  }
}

/** 显示气泡（先定位，下一帧加 show 触发淡入） */
function showDictBubble(target) {
  const bubble = getDictBubble();
  if (!bubble) return;
  positionFloating(bubble, target);
  setTimeout(function () {
    if (bubble.classList) bubble.classList.add("show");
  }, 10);
}

/**
 * 把查询结果填进气泡
 * @param {{word:string, phonetic:string, pos:string, meaning:string}} info
 */
function renderDictBubbleContent(info) {
  const bubble = getDictBubble();
  if (!bubble) return;

  const posHtml = info.pos ? '<span class="dict-pos">' + escapeHtml(info.pos) + "</span>" : "";
  const phoneticHtml = info.phonetic
    ? '<div class="dict-phonetic">' + escapeHtml(info.phonetic) + "</div>"
    : "";

  bubble.innerHTML =
    '<div class="dict-head"><strong>' + escapeHtml(info.word) + "</strong>" + posHtml + "</div>" +
    phoneticHtml +
    '<div class="dict-meaning">' + escapeHtml(info.meaning) + "</div>";
}

/**
 * 点击一个 .word：先弹「查询中…」，拿到结果再填充
 * @param {HTMLElement} wordEl
 */
async function handleWordClick(wordEl) {
  if (typeof Dictionary === "undefined") return;
  const raw = String((wordEl && wordEl.textContent) || "").trim();
  // 去掉首尾标点再转小写，跟缓存 key 保持一致
  const word = raw.replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z]+$/, "").toLowerCase();
  if (!word) return;

  const token = ++dictLookupToken;      // 这次点击的令牌
  const bubble = getDictBubble();
  if (!bubble) return;

  bubble.innerHTML = '<div class="dict-loading">查询中…</div>';
  showDictBubble(wordEl);

  const info = await Dictionary.lookupWord(word);
  if (token !== dictLookupToken) return;   // 期间又点了别的词，这个结果已经过期

  renderDictBubbleContent(info);
  showDictBubble(wordEl);

  // 查成功的词才打标记；失败的留着让用户重试
  if (!info.failed) {
    Dictionary.markLookedUp(word);
    markWordElements(word);
  }
}

/**
 * 给正文里所有等于该词的 span 打上已查底色（同一个词可能出现在多处）
 * @param {string} word 归一化后的小写单词
 */
function markWordElements(word) {
  const key = String(word || "").toLowerCase();
  if (!key || typeof document === "undefined" || !document.querySelectorAll) return;
  const nodes = document.querySelectorAll(".news-content .word, .vocab-paragraph .word");
  Array.prototype.forEach.call(nodes, function (node) {
    const text = String(node.textContent || "").trim().toLowerCase();
    if (text === key && node.classList) node.classList.add("looked-up");
  });
}

/** 页面渲染后：把 localStorage 里已查过的词重新打上底色 */
function applyLookedUpMarks() {
  if (typeof Dictionary === "undefined") return;
  if (typeof document === "undefined" || !document.querySelectorAll) return;
  const nodes = document.querySelectorAll(".news-content .word, .vocab-paragraph .word");
  Array.prototype.forEach.call(nodes, function (node) {
    const text = String(node.textContent || "").trim().toLowerCase();
    if (text && Dictionary.isLookedUp(text) && node.classList) node.classList.add("looked-up");
  });
}

/**
 * 给正文里所有等于该词的 span 加/去掉「已收藏」标记 class
 * 同一个词在新闻和词汇段里可能出现多次，要一起改
 *
 * 注意：.in-vocab 原先对应绿色下划线，现已按需求移除视觉表现，
 * 正文里只保留 .hl 的蓝色高亮。class 仍要继续打上 —— 它是「已收藏」的
 * 状态载体（长按收藏要靠它回显、取消收藏要靠它去掉），
 * 将来若要换成底色或角标，不用重写这套遍历逻辑。
 *
 * @param {string} word 归一化后的小写单词
 * @param {boolean} inBook 是否加入（false = 移除标记）
 */
function markVocabElements(word, inBook) {
  const key = String(word || "").toLowerCase();
  if (!key || typeof document === "undefined" || !document.querySelectorAll) return;
  const nodes = document.querySelectorAll(".news-content .word, .vocab-paragraph .word");
  Array.prototype.forEach.call(nodes, function (node) {
    const text = String(node.textContent || "").trim().toLowerCase();
    if (text !== key || !node.classList) return;
    if (inBook) node.classList.add("in-vocab");
    else node.classList.remove("in-vocab");
  });
}

/** 页面渲染后：把单词本里已有的词重新打上「已收藏」标记（.in-vocab，现无视觉表现） */
function applyVocabMarks() {
  if (typeof VocabBook === "undefined") return;
  if (typeof document === "undefined" || !document.querySelectorAll) return;
  const nodes = document.querySelectorAll(".news-content .word, .vocab-paragraph .word");
  Array.prototype.forEach.call(nodes, function (node) {
    const text = String(node.textContent || "").trim().toLowerCase();
    if (text && VocabBook.isInVocabBook(text) && node.classList) node.classList.add("in-vocab");
  });
}

/** 一次性回灌两种标记（已查词底色 + 已收藏下划线） */
function applyWordMarks() {
  applyLookedUpMarks();
  applyVocabMarks();
}

/* ==========================================================================
 * 4.7 长按收藏：操作菜单 + 单词本联动
 *
 * 短按（<500ms）→ 查词气泡；长按（≥500ms）→ 操作菜单。
 * 两者都用事件委托挂在 document 上，因为正文会被 renderAll 整体重绘。
 * ========================================================================== */

/** 长按判定阈值 */
const LONG_PRESS_MS = 500;
/** 长按时允许的移动距离（超过就当成滚动/拖动，取消长按） */
const PRESS_MOVE_TOLERANCE = 10;

let wordMenuEl = null;          // 长按菜单 DOM（懒创建，全局唯一）
let wordMenuTarget = null;      // 当前菜单指向的 .word 元素
let pressTimer = null;          // 长按计时器
let pressEl = null;             // 当前按住的 .word 元素
let pressStartX = 0;
let pressStartY = 0;
let suppressClickUntil = 0;     // 长按触发后，抑制紧随其后的 click（否则会又弹查词气泡）
let suppressClickEl = null;     // 被长按的那个 .word：只吞落在它身上的 click

/**
 * 判断这个 .word 是不是正文里的（只处理新闻区 / 词汇段，单词表的词不参与）
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function isArticleWordEl(el) {
  if (!el || !el.closest) return false;
  return !!(el.closest(".news-content") || el.closest(".vocab-paragraph"));
}

/** 取（没有就创建）长按菜单元素 */
function getWordMenu() {
  if (wordMenuEl) return wordMenuEl;
  if (typeof document === "undefined" || !document.createElement) return null;

  wordMenuEl = document.createElement("div");
  wordMenuEl.className = "dict-bubble word-menu";
  wordMenuEl.id = "wordMenu";
  if (document.body) document.body.appendChild(wordMenuEl);
  return wordMenuEl;
}

/**
 * 渲染菜单内容：已在单词本里就显示「从单词本移除」
 * @param {string} word 归一化后的单词
 */
function renderWordMenu(word) {
  const menu = getWordMenu();
  if (!menu) return;
  const inBook = (typeof VocabBook !== "undefined") && VocabBook.isInVocabBook(word);
  menu.innerHTML =
    '<div class="menu-word">' + escapeHtml(word) + "</div>" +
    '<button class="menu-item" data-action="toggle">' +
    (inBook ? "从单词本移除" : "加入单词本") + "</button>" +
    '<button class="menu-item" data-action="copy">复制</button>';
}

/** 关闭菜单，并清掉被长按单词的高亮 */
function closeWordMenu() {
  if (wordMenuEl && wordMenuEl.classList) wordMenuEl.classList.remove("show");
  if (wordMenuTarget && wordMenuTarget.classList) wordMenuTarget.classList.remove("long-pressed");
  wordMenuTarget = null;
}

/**
 * 打开长按菜单
 * 如果此时查词气泡是开着的，先关掉，避免两个浮层叠在一起
 * @param {HTMLElement} wordEl
 */
function openWordMenu(wordEl) {
  if (!wordEl) return;
  const word = String(wordEl.textContent || "").trim()
    .replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z]+$/, "").toLowerCase();
  if (!word) return;

  hideDictBubble();                       // 已有查词气泡 → 先关
  closeWordMenu();                        // 之前长按过别的词 → 先收

  const menu = getWordMenu();
  if (!menu) return;

  wordMenuTarget = wordEl;
  if (wordEl.classList) wordEl.classList.add("long-pressed");

  renderWordMenu(word);
  positionFloating(menu, wordEl);
  setTimeout(function () {
    if (menu.classList) menu.classList.add("show");
  }, 10);
}

/**
 * 把词加入单词本
 * 释义来源优先级：查词缓存 → 今日单词表 → 异步查词回填（不阻塞交互）
 * @param {string} word
 * @returns {boolean} 是否新增成功
 */
function addWordToVocabBook(word) {
  if (typeof VocabBook === "undefined") return false;
  const key = String(word || "").toLowerCase();
  if (!key) return false;

  const data = {
    word: key,
    source: "news",
    sourceNewsId: (appState.pack && appState.pack.news) ? (appState.pack.news.id || "") : ""
  };

  // 1) 查词缓存里有的话直接用（最快，且不花钱）
  const cached = (typeof Dictionary !== "undefined" && Dictionary.peek) ? Dictionary.peek(key) : null;
  if (cached && !cached.failed) {
    data.phonetic = cached.phonetic || "";
    data.pos = cached.pos || "";
    data.meaning = cached.meaning || "";
  } else {
    // 2) 今日单词表里的释义（这些词本来就是今天要学的）
    const today = ((appState.pack && appState.pack.words) || []).filter(function (w) {
      return String(w.word || "").toLowerCase() === key;
    })[0];
    if (today) {
      data.phonetic = today.phonetic || "";
      data.pos = today.pos || "";
      data.meaning = today.meaning || "";
    }
  }

  const added = VocabBook.addWord(data);

  // 3) 信息还是空的？后台查一次再回填，用户不用等
  if (added && !data.meaning && typeof Dictionary !== "undefined") {
    Dictionary.lookupWord(key).then(function (info) {
      if (info && !info.failed) VocabBook.updateWordInfo(key, info);
    }).catch(function () { /* 回填失败无所谓，下次查词时还有缓存 */ });
  }

  return added;
}

/**
 * 复制文本到剪贴板
 * 优先用异步 Clipboard API，不支持时退回到临时 textarea + execCommand
 * @param {string} text
 */
function copyToClipboard(text) {
  const value = String(text || "");
  if (!value) return;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value);
      return;
    }
  } catch (e) { /* 权限被拒时走兜底 */ }

  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch (e2) { /* 实在复制不了就算了 */ }
}

/**
 * 菜单项点击处理
 * @param {string} action "toggle" | "copy"
 */
function handleWordMenuAction(action) {
  const word = wordMenuTarget
    ? String(wordMenuTarget.textContent || "").trim()
      .replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z]+$/, "").toLowerCase()
    : "";

  if (action === "copy") {
    copyToClipboard(word || (wordMenuTarget ? wordMenuTarget.textContent : ""));
    toast("已复制");
    closeWordMenu();
    return;
  }

  if (action !== "toggle" || !word) { closeWordMenu(); return; }

  if (VocabBook.isInVocabBook(word)) {
    VocabBook.removeWord(word);
    markVocabElements(word, false);
    toast("已从单词本移除：" + word);
  } else {
    const ok = addWordToVocabBook(word);
    markVocabElements(word, true);
    toast(ok ? "已加入单词本：" + word : "加入单词本失败");
  }

  closeWordMenu();
  renderVocabBookSection();
}

/* ---------- 长按：按下 / 移动 / 松开 ---------- */

/** 取消长按计时（松开、移出、滑动都会走这里） */
function cancelPress() {
  clearTimeout(pressTimer);
  pressTimer = null;
  if (pressEl && pressEl.classList) pressEl.classList.remove("pressing");
  pressEl = null;
}

/**
 * 开始计时：按住满 500ms 就触发菜单
 * @param {HTMLElement} el 被按住的 .word
 * @param {number} x 按下时的横坐标（用于判断是不是在滑动）
 * @param {number} y 按下时的纵坐标
 */
function startPress(el, x, y) {
  cancelPress();
  pressEl = el;
  pressStartX = x;
  pressStartY = y;
  if (el.classList) el.classList.add("pressing");   // 按住就有反馈，用户知道在生效

  pressTimer = setTimeout(function () {
    const target = pressEl;
    pressTimer = null;
    pressEl = null;
    if (target && target.classList) {
      target.classList.remove("pressing");
      target.classList.add("long-pressed");
    }
    // 长按触发后浏览器还会补一个 ghost click，把它吞掉，避免又弹一次查词气泡
    // 只吞「落在被长按那个词上」的 click：点菜单、点空白这些正常点击不能受影响
    suppressClickUntil = Date.now() + 800;
    suppressClickEl = target;
    openWordMenu(target);
  }, LONG_PRESS_MS);
}

/** 按住期间移动：位移超阈值就当滚动，取消长按 */
function movePress(x, y) {
  if (!pressEl || !pressTimer) return;
  if (Math.abs(x - pressStartX) > PRESS_MOVE_TOLERANCE ||
      Math.abs(y - pressStartY) > PRESS_MOVE_TOLERANCE) {
    cancelPress();
  }
}

/** 松开：没到阈值就是短按，什么都不做（click 会去查词） */
function endPress() {
  clearTimeout(pressTimer);
  pressTimer = null;
  if (pressEl && pressEl.classList) pressEl.classList.remove("pressing");
  pressEl = null;
}

/**
 * 绑定长按（移动端 touch + 桌面端鼠标左键）
 * 优先用 Pointer Events（一套代码覆盖鼠标和触摸），不支持时退回 touch + mouse
 */
function bindPressEvents() {
  if (typeof document === "undefined" || !document.addEventListener) return;

  /** 统一取坐标：pointer / touch / mouse 三种事件结构不一样 */
  function getXY(event) {
    if (event.touches && event.touches[0]) return { x: event.touches[0].clientX, y: event.touches[0].clientY };
    if (event.changedTouches && event.changedTouches[0]) {
      return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
    }
    return { x: event.clientX || 0, y: event.clientY || 0 };
  }

  /** 取事件里的 .word 元素（不是正文里的词就不处理） */
  function pickWordEl(event) {
    const el = (event.target && event.target.closest) ? event.target.closest(".word") : null;
    return (el && isArticleWordEl(el)) ? el : null;
  }

  const hasPointer = (typeof window !== "undefined" && typeof window.PointerEvent === "function");

  if (hasPointer) {
    document.addEventListener("pointerdown", function (event) {
      // 桌面端只认鼠标左键（右键留给浏览器菜单）
      if (event.pointerType === "mouse" && event.button !== undefined && event.button !== 0) return;
      const el = pickWordEl(event);
      if (!el) return;
      const p = getXY(event);
      startPress(el, p.x, p.y);
    });
    document.addEventListener("pointermove", function (event) {
      const p = getXY(event);
      movePress(p.x, p.y);
    });
    document.addEventListener("pointerup", endPress);
    document.addEventListener("pointercancel", endPress);
  } else {
    // 兜底：老浏览器 / 测试环境
    document.addEventListener("touchstart", function (event) {
      const el = pickWordEl(event);
      if (!el) return;
      const p = getXY(event);
      startPress(el, p.x, p.y);
    }, { passive: true });
    document.addEventListener("touchmove", function (event) {
      const p = getXY(event);
      movePress(p.x, p.y);
    }, { passive: true });
    document.addEventListener("touchend", endPress);
    document.addEventListener("touchcancel", endPress);
    document.addEventListener("mousedown", function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      const el = pickWordEl(event);
      if (!el) return;
      startPress(el, event.clientX || 0, event.clientY || 0);
    });
    document.addEventListener("mousemove", function (event) { movePress(event.clientX || 0, event.clientY || 0); });
    document.addEventListener("mouseup", endPress);
  }

  // 长按期间别弹系统的右键菜单 / 文本选择菜单
  document.addEventListener("contextmenu", function (event) {
    if (pickWordEl(event)) event.preventDefault();
  });
}

/* ---------- 单词本入口：页面区块 ---------- */

/*
 * 原 updateVocabBadge()（刷新底部「单词本」Tab 的待复习小红点）已按产品决策移除：
 * 底部栏不再显示任何红色数字徽章。DOM 元素（index.html 的 #bookBadge）、
 * 渲染逻辑和 .bottombar .btn.tab .badge 样式都已一并删掉，不是用 display:none 藏的。
 *
 * 待复习的【数据层】保留：VocabBook.getStats().dueCount 仍在用，
 * 单词本页的统计栏（vocabBookUI.renderVocabBookHeader）也照旧显示「今日待复习 N」。
 * 以后若想恢复底部提示，直接往 .bottombar .btn.tab 里加元素 +
 * 在这里补一个渲染函数即可，不用重建计数逻辑。
 */

/**
 * 渲染「单词本」区块
 * 完整页面在 js/vocabBookUI.js 里（统计栏 / 筛选 / 卡片 / 复习 / 左滑删除），
 * 这里只做转发，保证 renderAll 重绘时单词本跟着一起刷新；
 * 日常的数据变化由 VocabBook.subscribe 直接回调 VocabBookUI.render，不走这里
 */
function renderVocabBookSection() {
  if (typeof VocabBookUI !== "undefined" && VocabBookUI && VocabBookUI.render) {
    VocabBookUI.render();
    return;
  }
  // 兜底：UI 模块没加载时至少显示统计，不让入口点进去一片死白
  const box = (typeof document !== "undefined") ? document.getElementById("vocabBookBody") : null;
  if (!box || typeof VocabBook === "undefined") return;
  const stats = VocabBook.getStats();
  box.innerHTML = '<p class="empty">单词本共 ' + stats.total + " 词，今日待复习 " + stats.dueCount + " 词。</p>";
}

/**
 * 单词本数据变化时的统一刷新（订阅在 bootstrap 里注册）
 * 数据层任何写操作都会回调这里：正文的已收藏标记、今日单词表按钮文案
 */
function onVocabBookChange() {
  applyVocabMarks();
  renderWordList();
}

/* ==========================================================================
 * 4.5 导航：单页流式滚动 + Tab 栏智能隐藏
 * ========================================================================== */

const TAB_NAMES = ["words", "news", "vocab", "quiz"];

// 显隐阈值（px）。一次滚动方向的判定要超过这个位移才生效，
// 小于它就保持当前状态 —— 手指滚动时每帧只有几像素，阈值太小会来回抖。
const SCROLL_DELTA = 20;
// 页面滚动位置小于这个值时强制显示顶部区域。
// 不能用 0：橡皮筋回弹、hash 跳转落点、首屏渲染后的微小偏移都会让 y 停在 1~9，
// 那时用户主观上就在页面顶部，导航却还藏着。
const SCROLL_TOP_FORCE_SHOW = 10;

let lastScrollY = 0;
let autoScrolling = false;     // 锚点滚动过程中不要隐藏吸顶栏
let navHidden = false;          // 顶栏 + Tab 栏当前是否隐藏（两者永远一致）

/** 顶栏 + Tab 栏总高度，滚动定位时用它避让，避免标题被盖住 */
function getNavOffset() {
  const topbar = document.querySelector(".topbar");
  const tabs = document.getElementById("tabs");
  return (topbar ? topbar.offsetHeight : 0) + (tabs ? tabs.offsetHeight : 0) + 8;
}

/** 把顶栏实际高度写进 CSS 变量 --nav-top（Tab 栏的 sticky 与隐藏位移都依赖它） */
function syncNavTop() {
  const topbar = document.querySelector(".topbar");
  const root = document.documentElement;
  if (!topbar || !root || !root.style || !root.style.setProperty) return;
  const topbarH = topbar.offsetHeight || 0;
  root.style.setProperty("--nav-top", topbarH + "px");

  // 隐藏位移量 = 顶栏 + Tab 栏总高度，写成共享变量让两者用同一个偏移量。
  // 不能靠各自的 -100%：两者高度不同则位移量不同，虽然永远同显同隐
  // （看起来一样），但「同一像素 + 同一曲线」才是严格同步的保证。
  const tabs = document.getElementById("tabs");
  const total = topbarH + (tabs ? (tabs.offsetHeight || 0) : 0);
  if (total > 0) root.style.setProperty("--nav-hide-shift", total + "px");
}

/** 高亮某个 Tab（单页滚动下只改样式，不再切换面板显隐） */
function setActiveTab(tab) {
  appState.tab = tab;
  TAB_NAMES.forEach(function (name) {
    const btn = document.querySelector('.tab-btn[data-tab="' + name + '"]');
    if (btn) btn.className = "tab-btn" + (name === tab ? " active" : "");
  });
}

/** 点 Tab → 平滑滚动到对应区域 */
function scrollToSection(tab) {
  const target = document.getElementById("tab-" + tab);
  if (!target) return;
  // 单词本区块没有对应的顶部 Tab，别把当前高亮清掉
  if (TAB_NAMES.indexOf(tab) >= 0) setActiveTab(tab);

  // 跳转后保证顶栏和 Tab 栏都是显示状态（两者必须同步）
  navHidden = false;
  getNavBars().forEach(function (el) { el.classList.remove("nav-hidden"); });

  const top = Math.max(
    target.getBoundingClientRect().top + (window.pageYOffset || 0) - getNavOffset(),
    0
  );
  const distance = Math.abs(top - (window.pageYOffset || 0));

  autoScrolling = true;
  clearTimeout(scrollToSection._timer);
  // 锁定时长随滚动距离自适应（约 250ms + 每 500px 加 120ms，下限 700ms）。
  // 固定 700ms 在长距离滚动（如首屏直接跳到新闻段）时会提前解除，
  // 滚动监听中途接管并按实际位置反推 Tab 高亮，产生一次无谓的高亮跳变。
  scrollToSection._timer = setTimeout(function () { autoScrolling = false; },
    Math.max(700, 250 + Math.ceil(distance / 500) * 120));

  try {
    window.scrollTo({ top: top, behavior: "smooth" });
  } catch (e) {
    window.scrollTo(0, top);                  // 老浏览器不支持 options 形式
  }
}

/** 滚动时高亮当前所在区域 */
function syncActiveTabByScroll(y) {
  const line = y + getNavOffset() + 24;
  let current = TAB_NAMES[0];
  TAB_NAMES.forEach(function (name) {
    const el = document.getElementById("tab-" + name);
    if (!el) return;
    const top = el.getBoundingClientRect().top + (window.pageYOffset || 0);
    if (top <= line) current = name;
  });
  if (current !== appState.tab) setActiveTab(current);
}

/**
 * 需要跟着滚动一起显隐的两个吸顶元素。
 * 顶栏（.topbar）和 Tab 栏（#tabs）必须同步动作，所以统一在这里取，
 * 避免两处各写一套逻辑导致不同步。
 */
function getNavBars() {
  return [
    document.querySelector(".topbar"),
    document.getElementById("tabs")
  ].filter(Boolean);
}

/**
 * 滚动监听：下滑隐藏顶栏 + Tab 栏，上滑显示，回到顶部始终显示
 *
 * 显隐状态存在 navHidden 变量里，不去读 classList.contains ——
 * 后者会在每个 scroll 事件强制样式重算，滚动时掉帧。
 */
function handleScroll() {
  const bars = getNavBars();
  const y = window.pageYOffset || document.documentElement.scrollTop || 0;
  const delta = y - lastScrollY;

  if (bars.length) {
    let next = navHidden;                     // 阈值内保持原状
    if (y <= SCROLL_TOP_FORCE_SHOW) {
      next = false;                           // 页面在顶部：始终显示
    } else if (!autoScrolling && delta > SCROLL_DELTA) {
      next = true;                            // 往下滑：隐藏
    } else if (!autoScrolling && delta < -SCROLL_DELTA) {
      next = false;                           // 往上滑：显示
    }
    // 状态没变就不碰 DOM，避免无谓的 class 写入
    if (next !== navHidden) {
      navHidden = next;
      bars.forEach(function (el) {
        if (next) el.classList.add("nav-hidden");
        else el.classList.remove("nav-hidden");
      });
    }
  }

  lastScrollY = y;
  syncActiveTabByScroll(y);
}

/* ==========================================================================
 * 5. 做题：判分 + 联动记忆状态
 * ========================================================================== */

/**
 * 处理一次作答
 * @param {string} qid 题目 id
 * @param {string} value 用户选的答案
 */
function answerQuestion(qid, value) {
  const pack = appState.pack;
  if (!pack || !pack.quiz) return;
  const progress = appState.progress || (appState.progress = createEmptyProgress(pack));
  if (!progress.graded) progress.graded = {};
  if (progress.answers[qid] !== undefined) return;        // 已答过

  const all = (pack.quiz.meaningQuestions || []).concat(pack.quiz.fillQuestions || []);
  let question = null;
  for (let i = 0; i < all.length; i++) {
    if (all[i].id === qid) { question = all[i]; break; }
  }
  if (!question) return;

  const isCorrect = value === question.answer;
  progress.answers[qid] = value;
  if (isCorrect) progress.correctIds.push(qid);
  else progress.wrongIds.push(qid);

  // 同一个词可能在词义题和填空题里都出现，只批改一次（graded 跟着 progress 走，换题自动清空）
  if (!progress.graded[question.word]) {
    progress.graded[question.word] = true;
    let updated = WordPool.updateWordStatus(question.word, isCorrect, pack.date);
    if (!updated) {                                       // 词库里没有（状态被清过），补进去再判
      WordPool.addWord(question.word, "", "", "review");
      updated = WordPool.updateWordStatus(question.word, isCorrect, pack.date);
    }
    saveLibrary();
  }

  if (Object.keys(progress.answers).length >= all.length) progress.finished = true;

  saveProgress(progress);
  renderQuiz();
  if (progress.finished) toast("全部完成，得分 " + progress.correctIds.length + " / " + all.length);
}

/* ==========================================================================
 * 6. 底部操作：加词 / 换一篇 / 单词本
 * ========================================================================== */

/** 打开 / 关闭弹窗 */
function toggleModal(show) {
  const mask = document.getElementById("modalMask");
  if (mask) {
    if (show) mask.classList.remove("hidden");
    else mask.classList.add("hidden");
  }
}

/** 加词：标准化 → 加入词库 */
async function handleAddWord(rawInput) {
  if (!rawInput || !rawInput.trim()) return;
  toggleModal(false);

  const res = await AICaller.standardizeWords(rawInput);
  const list = (res && Array.isArray(res.data)) ? res.data : [];
  if (!list.length) {
    toast("没有识别到有效单词");
    return;
  }

  let added = 0;
  list.forEach(function (item) {
    if (!item || !item.word) return;
    if (WordPool.getWord(item.word)) return;              // 已存在就不重复加
    if (WordPool.addWord(item.word, item.pos, item.meaning, "manual", item.phonetic)) added++;
    // 同时写入单词本（vocabBook）：手动词 source:"manual"，按设计 nextReviewDate=次日，
    // 所以会出现在「单词本→全部单词」，但今天不进「今日单词」（明天的复习池才包含它）。
    // 之前 Round 7 声称的这行编辑未实际落盘，导致词只进词库(anv_library)不进单词本。
    try {
      if (typeof VocabBook !== "undefined" && VocabBook.addWord) {
        VocabBook.addWord({
          word: item.word,
          phonetic: item.phonetic,
          pos: item.pos,
          meaning: item.meaning,
          source: "manual"
        });
      }
    } catch (e) {
      // 只 warn 不抛错：加词主流程（写词库）不能因为单词本写入失败而中断；
      // 也不在控制台刷屏——单个词失败一次就记一条，不影响用户继续操作。
      console.warn("[app] 加词写入单词本失败:", item.word, e && e.message);
    }
  });

  saveLibrary();
  toast(added > 0
    ? "已添加 " + added + " 个词，明天的学习内容会包含它"
    : "这些词已经在词库里了");
}

/** 换一篇：重新匹配新闻并重新生成相关内容 */
async function handleSwitchNews() {
  const pack = appState.pack;
  if (!pack) return;
  setGenerating(true);
  try {
    const fresh = await generateDailyPack(pack.date, { newsIndex: (pack.newsIndex || 0) + 1 });
    // 换了新闻就是换了题目，作答状态一律清空，不能继承上一轮的答案
    appState.pack = fresh;
    appState.progress = resetQuizProgress(fresh);
    renderAll();
    toast(fresh.degraded ? "新闻库暂无可用新闻，仍在单词学习模式" : "已换一篇新闻，答题已重置");
  } catch (e) {
    toast("换一篇失败：" + ((e && e.message) || e));
  } finally {
    setGenerating(false);
  }
}

/** 单词本：展示收藏词与已标记主动词汇 */
function renderWordbook() {
  const words = (typeof WordPool !== "undefined") ? WordPool.getAllWords() : [];
  const collected = words.filter(function (w) {
    return w.active || w.source === "wordbook" || w.source === "news" || w.source === "manual";
  });

  const body = collected.length
    ? '<div class="modal-body">' + collected.map(function (w) {
        // 结构与首页单词表一致：词头一行 + 词性/音标/释义同一行
        return '<div class="word-item">' +
          '<div class="word-main"><span class="word">' + escapeHtml(w.word) + "</span></div>" +
          '<div class="word-sub">' +
          '<span class="pos">' + escapeHtml(w.pos || "") + "</span>" +
          '<span class="phonetic">' + escapeHtml(w.phonetic || "") + "</span>" +
          '<span class="meaning">' + escapeHtml(w.meaning || "") + "</span></div>" +
          "</div>";
      }).join("") + "</div>"
    : '<div class="modal-body"><p class="empty">还没有收藏的词。可以在「检测」页把推荐词加入单词本。</p></div>';

  const content = document.getElementById("modalContent");
  const titleEl = document.getElementById("modalTitle");
  if (titleEl) titleEl.textContent = "单词本（" + collected.length + "）";
  if (content) content.innerHTML = body;
  toggleModal(true);
}

/**
 * 把词加入单词本（检测页的「加入单词本」按钮）
 * 同时写进 WordPool.active 和 VocabBook，两边保持一致
 */
function collectWord(wordId) {
  const word = WordPool.getWord(wordId);
  if (!word) { toast("词库里没有这个词"); return; }
  word.active = true;
  saveLibrary();

  // 与正文长按收藏走同一个入口，保证两边的字段（释义 / 来源新闻）一致
  const added = addWordToVocabBook(word.word);
  markVocabElements(word.word, true);

  toast(added ? "已加入单词本：" + word.word : "已经在单词本里了：" + word.word);
  renderQuiz();
}

/** 生成中的 loading 状态（可带文案：显示当前跑到第几个模块） */
function setGenerating(flag, text) {
  appState.generating = flag;
  const mask = document.getElementById("loadingMask");
  if (mask) {
    if (flag) {
      if (text) mask.textContent = text;
      mask.classList.remove("hidden");
    } else {
      mask.classList.add("hidden");
    }
  }
}

/**
 * 控制台打印各模块生成耗时与状态（排查性能瓶颈用）
 * @param {Object} pack 今日内容包
 */
function logPackTiming(pack) {
  if (typeof console === "undefined" || typeof console.log !== "function") return;
  const t = pack.aiTiming || {};
  const s = pack.aiSource || {};
  const e = pack.aiError || {};
  const fmt = function (ms) { return ((ms || 0) / 1000).toFixed(1) + "s"; };
  const modules = [
    ["新闻改写", "rewrite"],
    ["词汇段", "vocab"],
    ["检测题", "quiz"]
  ];
  console.log("──────── 今日内容包生成完成 ────────");
  modules.forEach(function (m) {
    const key = m[1];
    const label = s[key] === "api" ? "AI 生成" : "本地降级";
    console.log("  " + m[0] + "：" + label + " · " + fmt(t[key]) + (e[key] ? " · " + e[key] : ""));
  });
  console.log("  合计：" + fmt((t.rewrite || 0) + Math.max(t.vocab || 0, t.quiz || 0)) + "（词汇段与检测题并行）");
  console.log("──────────────────────────────────");
}

/* ==========================================================================
 * 7. 启动与事件绑定
 * ========================================================================== */

/**
 * 页面启动：有今天的缓存就直接读，没有就生成
 */
async function bootstrap() {
  const today = getTodayStr();
  restoreLibrary();

  // 单词本数据变化时刷新红点 / 正文标记 / 今日单词表按钮
  // （单词本页面自己也在 vocabBookUI.js 里订阅了一次，两边各管各的，不重复写数据）
  if (typeof VocabBook !== "undefined" && VocabBook.subscribe) {
    VocabBook.subscribe(onVocabBookChange);
  }

  let pack = loadTodayPack(today);
  if (!pack) {
    setGenerating(true);
    try {
      pack = await generateDailyPack(today);
    } catch (e) {
      // 兜底：宁可给一个只有单词表的降级页面，也不要整页卡在「加载中…」
      // （单词表不依赖 AI，也不依赖新闻）
      try {
        const pool = (WordPool.generateDailyPool(today, 20) || {});
        const nw = Array.isArray(pool.newWords) ? pool.newWords : [];
        pack = buildDegradedPack(
          today,
          nw.map(function (w) {
            return {
              id: w.id, word: w.word, pos: w.pos, meaning: w.meaning,
              phonetic: w.phonetic, source: w.source, status: w.status,
              fromVocab: !!w.fromVocab
            };
          }),
          pool,
          {
            newCount: nw.length,
            reviewCount: Array.isArray(pool.reviewWords) ? pool.reviewWords.length : 0,
            standbyCount: Array.isArray(pool.standbyWords) ? pool.standbyWords.length : 0
          }
        );
        pack.degradeReason = "error";
        pack.aiError = { rewrite: String((e && e.message) || e), vocab: "", quiz: "" };
        savePack(pack);
        toast("部分内容生成失败，已降级为单词学习模式");
      } catch (e2) {
        toast("生成今日内容失败：" + ((e && e.message) || e));
      }
    } finally {
      setGenerating(false);
    }
  }

  if (!pack) {
    // 连降级包都造不出来：明确告诉用户，而不是留一个永远转圈的页面
    const box = document.getElementById("tabWordsBody");
    if (box) box.innerHTML = '<p class="empty">今日内容生成失败，请点击底部「加词」或稍后重试。</p>';
    return;
  }
  applyPack(pack);          // 内部会按 quizKey 绑定/重置答题进度
  syncNavTop();
  resetScrollRestoration();
  focusInitialSection();
}

/**
 * 关掉浏览器的滚动位置恢复。
 *
 * 不关的话，刷新页面时浏览器会把用户放回上次的位置（比如检测区中间），
 * 跟"首屏落在新闻段"矛盾；而且那个位置会让 syncActiveTabByScroll 反推出
 * 错误的 Tab 高亮，页面一打开就高亮在检测上。
 * 必须在任何 scrollTo 之前调用（浏览器恢复位置发生在 load 前后，早设早生效）。
 */
function resetScrollRestoration() {
  try {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
  } catch (e) {
    // 老浏览器 / 隐私模式可能不允许写，忽略即可（退回浏览器默认行为）
  }
}

/**
 * 首页默认落在新闻段。
 *
 * 核心功能是「读新闻 + 背单词」，单词表只是辅助，所以打开页面就该直接看到新闻，
 * 不用先滑一段。复用 scrollToSection —— 它已经处理了三件事，不要重写：
 *   1. setActiveTab 同步 Tab 高亮
 *   2. 减去 getNavOffset()，让标题落在吸顶栏下方而不是被挡住
 *   3. behavior: "smooth" 平滑滚动（并有 try/catch 兜老浏览器）
 *
 * 时机：必须等 applyPack 渲染完再调用 —— 此时各区块高度才确定，
 * 否则 getBoundingClientRect 量到的是渲染前的高度，滚动位置会偏。
 *
 * 只做一次：用户手动点 Tab 之后不该被拽回新闻段，所以用 bootScrolled 标记，
 * 而不是每次都滚。（bootstrap 若因换一篇等路径被再调一次，守卫会挡住。）
 */
let bootScrolled = false;
function focusInitialSection() {
  if (bootScrolled) return;
  // 降级包可能压根没有新闻区块（pack.news === null），那就留在单词表
  const pack = appState.pack;
  if (!pack || !pack.news) {
    bootScrolled = true;                 // 降级也算「已定位过」，别反复重试
    setActiveTab("words");
    return;
  }
  // 屏幕太矮（放不下新闻段）时也别硬滚，否则用户会以为页面坏了
  if (window.innerHeight && window.innerHeight < 360) {
    bootScrolled = true;
    setActiveTab("words");
    return;
  }
  bootScrolled = true;
  scrollToSection("news");
}

/** 打开加词弹窗 */
function openAddWordModal() {
  const content = document.getElementById("modalContent");
  const titleEl = document.getElementById("modalTitle");
  if (titleEl) titleEl.textContent = "加词";
  if (content) {
    content.innerHTML =
      '<div class="modal-body">' +
      '<p class="hint">可以只输入单词，也可以带词性和释义，例如：<br><code>scrutiny n. 详细审查</code></p>' +
      '<input id="addWordInput" class="input" type="text" placeholder="输入要添加的单词" />' +
      '<div class="modal-actions"><button class="btn primary" id="addWordConfirmBtn">确认添加</button></div>' +
      "</div>";
  }
  toggleModal(true);

  const input = document.getElementById("addWordInput");
  const confirmBtn = document.getElementById("addWordConfirmBtn");
  if (confirmBtn) confirmBtn.addEventListener("click", function () {
    handleAddWord(input ? input.value : "");
  });
  if (input) input.focus();
}

/**
 * 离线状态横幅：监听 online / offline 事件，实时显隐。
 *
 * 为什么必须有这个（而不是只靠 AI 降级时的提示）：
 * 需求要求「离线状态下 AI 新闻生成显示友好的离线提示，而不是白屏或报错」。
 * 但如果只在【下一次点「换一篇」时】才提示，用户会先看到一屏旧内容、
 * 毫无察觉地以为一切正常 —— 提示来得太晚就失去了意义。
 * 所以掉线的那一刻就要说。
 *
 * navigator.onLine 的局限（必须知道，否则会做出错误承诺）：
 *   true 只代表「网卡连上了」，不代表能访问外网（连上热点但没流量、
 *   DNS 挂了、代理断了都还是 true）。所以我们【只】在确定为 false 时
 *   显示横幅，绝不在 true 时承诺「联网正常」——那是浏览器管不了的事。
 */
function setupNetworkWatcher() {
  if (typeof window === "undefined" || !window.addEventListener) return;

  const bar = document.getElementById("netOfflineBar");

  function sync(online) {
    if (!bar) return;
    bar.classList.toggle("hidden", !!online);
    const note = bar.querySelector("span");
    if (note && online) {
      // 恢复联网后补一句「可以重新生成了」，否则横幅直接消失像是没发生过
      note.textContent = "— 网络已恢复，点标题右侧↻ 可生成新的 AI 新闻";
      setTimeout(function () {
        if (bar.classList.contains("hidden")) return;
        note.textContent = "— AI 新闻生成不可用，单词本 / 刷词 / 词汇量测试均可正常使用";
      }, 4000);
    }
  }

  // 首次同步：如果用户打开页面时就已经离线（例如从 PWA 离线启动）
  sync(typeof navigator !== "undefined" ? navigator.onLine !== false : true);

  window.addEventListener("offline", function () {
    sync(false);
    console.info("[PWA] 网络已断开：AI 功能将走本地兜底");
  });
  window.addEventListener("online", function () {
    sync(true);
    console.info("[PWA] 网络已恢复");
  });
}

/** 绑定页面事件 */
function bindEvents() {
  const tabs = document.querySelectorAll(".tab-btn");
  Array.prototype.forEach.call(tabs, function (btn) {
    btn.addEventListener("click", function () { scrollToSection(btn.getAttribute("data-tab")); });
  });

  // 滚动：顶栏 + Tab 栏同步智能隐藏 + 当前区域高亮
  window.addEventListener("scroll", handleScroll, { passive: true });
  window.addEventListener("resize", function () {
    syncNavTop();                    // 顶栏高度可能变（换行/字号），重算 --nav-top 与 --nav-hide-shift
    lastScrollY = window.pageYOffset || 0;
    // 视口高度变化可能把页面顶到最上方，此时强制恢复显示，避免状态与实际不符
    if (lastScrollY <= SCROLL_TOP_FORCE_SHOW) {
      navHidden = false;
      getNavBars().forEach(function (el) { el.classList.remove("nav-hidden"); });
    }
  });
  syncNavTop();
  // 早于 bootstrap 的首屏滚动：先关掉浏览器的滚动位置恢复，
  // 否则刷新后浏览器可能把用户放回上次位置，把首屏定位顶掉
  resetScrollRestoration();

  // 离线横幅：与 bootstrap 无关，独立挂一次即可
  setupNetworkWatcher();

  // 长按交互（新闻区 / 词汇段的 .word）
  bindPressEvents();

    // 初始化个人中心
    if (typeof Profile !== "undefined") {
      Profile.init();
    }

    // 初始化刷词模块
    if (typeof Flashcard !== "undefined") {
      Flashcard.init();
    }

    // 绑定个人中心按钮点击事件
    const profileBtn = document.getElementById("profileBtn");
    if (profileBtn) {
      profileBtn.addEventListener("click", function() {
        if (typeof Profile !== "undefined") {
          Profile.open();
        }
      });
    }

    // 绑定刷词按钮点击事件
    const flashcardBtn = document.getElementById("flashcardBtn");
    if (flashcardBtn) {
      flashcardBtn.addEventListener("click", function() {
        if (typeof Flashcard !== "undefined") {
          Flashcard.open();
        }
      });
    }

  // 点击查词 + 长按菜单：委托到 document（新闻区 / 词汇段会被整体重绘，绑容器上会失效）
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("click", function (event) {
      const target = event.target;

      // 1) 菜单里的按钮
      //    必须排在「长按抑制」判断之前：用户长按后马上点「加入单词本」时，
      //    还在抑制窗口内，若先判断抑制会把这次点击一起吞掉，导致点了没反应
      const menuItem = (target && target.closest) ? target.closest(".menu-item") : null;
      if (menuItem) {
        handleWordMenuAction(menuItem.getAttribute("data-action"));
        return;
      }

      // 2) 长按刚触发过菜单：浏览器补发的 ghost click 要吞掉，
      //    否则会再弹一次查词气泡。
      //    两个条件同时满足才吞：还在 800ms 窗口内 + 落点就是被长按的那个词。
      //    只吞一次（用完立刻清零），避免吃掉用户紧接着的正常点击
      if (suppressClickEl && Date.now() < suppressClickUntil) {
        const hitWord = (target && target.closest) ? target.closest(".word") : null;
        if (target === suppressClickEl || hitWord === suppressClickEl ||
            (suppressClickEl.contains && suppressClickEl.contains(target))) {
          suppressClickEl = null;
          suppressClickUntil = 0;
          return;
        }
      }
      suppressClickEl = null;   // 窗口外/落点不对 → 失效，后续点击正常处理

      // 3) 正文单词 → 查词（顺手关掉可能开着的菜单）
      const wordEl = (target && target.closest) ? target.closest(".word") : null;
      if (wordEl && isArticleWordEl(wordEl)) {
        closeWordMenu();
        handleWordClick(wordEl);
        return;
      }

      // 4) 点菜单自身（非按钮区域）不动；其余地方一律关菜单 + 关气泡
      if (wordMenuEl && (target === wordMenuEl || (wordMenuEl.contains && wordMenuEl.contains(target)))) return;
      closeWordMenu();

      if (!dictBubbleEl) return;
      if (target === dictBubbleEl || (dictBubbleEl.contains && dictBubbleEl.contains(target))) return;
      hideDictBubble();
    });
  }

  // 做题 / 收藏：事件委托
  const quizBody = document.getElementById("tabQuizBody");
  if (quizBody) {
    quizBody.addEventListener("click", function (event) {
      const target = event.target;
      const optionBtn = target.closest ? target.closest(".option") : null;
      if (optionBtn && !optionBtn.classList.contains("disabled")) {
        answerQuestion(optionBtn.getAttribute("data-qid"), optionBtn.getAttribute("data-value"));
        return;
      }
      const collectBtn = target.closest ? target.closest("[data-collect]") : null;
      if (collectBtn) collectWord(collectBtn.getAttribute("data-collect"));
    });
  }

  const addBtn = document.getElementById("btnAdd");
  const bookBtn = document.getElementById("btnBook");
  const modalClose = document.getElementById("modalClose");
  const modalMask = document.getElementById("modalMask");

  if (addBtn) addBtn.addEventListener("click", openAddWordModal);
  // 换一篇：按钮在新闻标题里动态创建（renderNews 重建），所以用事件委托挂 document
  document.addEventListener("click", function (e) {
    if (e.target && e.target.closest && e.target.closest("#switchBtn")) handleSwitchNews();
  });
  // 单词本：滚到页面末尾的单词本区块
  if (bookBtn) bookBtn.addEventListener("click", function () { scrollToSection("book"); });
  if (modalClose) modalClose.addEventListener("click", function () { toggleModal(false); });
  if (modalMask) {
    modalMask.addEventListener("click", function (event) {
      if (event.target === modalMask) toggleModal(false);
    });
  }
}

// 暴露给控制台 / 自测使用
const DailyApp = {
  generateDailyPack: generateDailyPack,
  loadTodayPack: loadTodayPack,
  loadProgress: loadProgress,
  resetQuizProgress: resetQuizProgress,
  makeQuizKey: makeQuizKey,
  createEmptyProgress: createEmptyProgress,
  applyPack: applyPack,
  answerQuestion: answerQuestion,
  highlightWords: highlightWords,
  wrapWordsInHtml: wrapWordsInHtml,
  handleWordClick: handleWordClick,
  hideDictBubble: hideDictBubble,
  applyLookedUpMarks: applyLookedUpMarks,
  applyVocabMarks: applyVocabMarks,
  applyWordMarks: applyWordMarks,
  markWordElements: markWordElements,
  markVocabElements: markVocabElements,
  openWordMenu: openWordMenu,
  closeWordMenu: closeWordMenu,
  handleWordMenuAction: handleWordMenuAction,
  addWordToVocabBook: addWordToVocabBook,
  onVocabBookChange: onVocabBookChange,
  startPress: startPress,
  movePress: movePress,
  endPress: endPress,
  bindPressEvents: bindPressEvents,
  isArticleWordEl: isArticleWordEl,
  renderVocabBookSection: renderVocabBookSection,
  handleAddWord: handleAddWord,
  handleSwitchNews: handleSwitchNews,
  renderWordbook: renderWordbook,
  scrollToSection: scrollToSection,
  focusInitialSection: focusInitialSection,
  resetScrollRestoration: resetScrollRestoration,
  handleScroll: handleScroll,
  getNavBars: getNavBars,
  setActiveTab: setActiveTab,
  renderAll: renderAll,
  bindEvents: bindEvents,
  renderNews: renderNews,
getState: function () { return appState; },
    bootstrap: bootstrap,
    // --- PWA：供自测断言「不支持 SW 时不报错」---
    registerServiceWorker: registerServiceWorker,
    isLocalDevHost: isLocalDevHost,
    setupNetworkWatcher: setupNetworkWatcher,
    renderAiDownHint: renderAiDownHint
  };

if (typeof window !== "undefined") {
  window.DailyApp = DailyApp;
}

/* ==========================================================================
 * PWA：Service Worker 注册
 * --------------------------------------------------------------------------
 * 放在文件末尾、导出面之后注册 —— 这样自测 require 本文件时不会真的去注册
 * （Node 环境没有 navigator.serviceWorker，registerServiceWorker 会静默返回）。
 *
 * 开发环境下要skipWaiting 的原因：SW 更新有延迟，不强制激活的话
 * 改完代码刷新页面还是旧版本，每次都要手动去 devtools 点 Unregister，
 * 调试效率极低。生产环境反而不该这么干（可能正在用旧版本的页面对应的
 * 缓存被突然清掉），所以只在 http://localhost / 127.0.0.1 下开。
 * ========================================================================== */

/**
 * 判断当前是否「本地开发环境」。
 * Service Worker 本身要求 https 或 localhost，file:// 下不会注册成功，
 * 所以这个判断同时也是一道保险：不会在 file:// 下浪费一次失败的注册。
 * @returns {boolean}
 */
function isLocalDevHost() {
  if (typeof location === "undefined" || !location.hostname) return false;
  return location.hostname === "localhost" ||
         location.hostname === "127.0.0.1" ||
         location.hostname === "[::1]" ||
         /^127\./.test(location.hostname);
}

/**
 * 注册 Service Worker。
 *
 * 三层保护，任何一层不满足都**静默返回**，绝不抛异常——
 * 注册失败不该让整个 app 起不来（旧浏览器 / file:// 打开 / 隐私模式禁用 SW）。
 *
 * @returns {boolean} 是否真正发起了注册
 */
function registerServiceWorker() {
  // ① 特性检测：不支持直接返回，不报错
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    console.info("[PWA] 当前浏览器不支持 Service Worker，跳过注册（离线功能不可用）");
    return false;
  }
  // ② 只在 DOM 环境注册
  if (typeof document === "undefined") return false;

  // ③ 本地开发环境：强制 skipWaiting，便于调试
  //    注意用的是相对路径 "./sw.js" 而不是 "/sw.js"：
  //    绝对路径在部署到子目录时会 404，而相对路径在根目录和子目录都能用。
  const url = "./sw.js";
  const devMode = isLocalDevHost();

  navigator.serviceWorker.register(url).then(function (reg) {
    console.log("[PWA] Service Worker 注册成功:", url);

    // 开发环境下，新 SW 装好后立刻激活，不用等所有旧页面关掉
    if (devMode && reg.waiting) {
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
    }

    // 检测「有新版本正在安装」：每次页面加载都会重新拉一次 sw.js，
    // 内容变了浏览器会走 install 流程。
    reg.addEventListener("updatefound", function () {
      const installing = reg.installing;
      if (!installing) return;
      console.log("[PWA]发现新版 Service Worker，等待安装…");

      installing.addEventListener("statechange", function () {
        // installed 说明装好了。若已经有 controller 说明是首次安装（不是更新）
        if (installing.state === "installed") {
          if (navigator.serviceWorker.controller) {
            console.log("[PWA] 新版本已就绪，页面将在刷新后生效（已启用自动激活）");
            // 开发环境：立刻让 waiting 的那个接管
            if (devMode) {
              installing.postMessage({ type: "SKIP_WAITING" });
            }
          } else {
            // 首次安装：没有 controller 属于正常情况，不是「更新」
            console.log("[PWA] Service Worker 首次安装完成，已可离线使用");
          }
        }
      });
    });
  }).catch(function (err) {
    // 注册失败只记日志，不影响页面（单词本/刷词/测试都还在 localStorage 里）
    console.warn("[PWA] Service Worker 注册失败（不影响在线使用）:", err && err.message);
  });

  return true;
}

// DOM 环境下自动注册（与上面的 bindEvents/bootstrap 并列，互不依赖）
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", function () {
    registerServiceWorker();
  });
}

// DOM 环境下自动启动
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", function () {
    bindEvents();
    bootstrap();
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = DailyApp;
}
