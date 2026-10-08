/**
 * dictionary.js
 * AI 新闻背单词 H5 应用 —— 点击查词模块（纯逻辑，不含 UI）
 *
 * 依赖：js/ai.js（复用它的 requestChat，因此自动享有同一套
 *       代理探测 / 超时 / 重试策略，预览环境的 CSP 问题同样走本地代理绕过）
 *
 * 对外：全局对象 Dictionary
 *   - lookupWord(word)        查词（带 7 天本地缓存，失败降级）
 *   - isLookedUp(word)        这个词是否查过（用于给正文里的词打底色）
 *   - markLookedUp(word)      标记为已查（写入 localStorage）
 *   - getLookedUpWords()      已查词列表（页面加载时回灌底色用）
 *
 * 存储：
 *   - 释义缓存   localStorage["dict_" + word] = { word, phonetic, pos, meaning, ts }
 *   - 已查词集合 localStorage["lookedUpWords"] = ["diligent", ...]
 */

/* ==========================================================================
 * 1. 常量
 * ========================================================================== */

/** 释义缓存 key 前缀 */
const DICT_CACHE_PREFIX = "dict_";
/** 缓存有效期：7 天 */
const DICT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
/** 已查词集合的 key */
const DICT_LOOKED_KEY = "lookedUpWords";

/** 查词失败时的兜底释义（字段保持完整，页面照常渲染气泡） */
const DICT_FALLBACK_MEANING = "查词失败，请稍后重试";

/* ==========================================================================
 * 2. 工具函数
 * ========================================================================== */

/** 取 localStorage（隐私模式等拿不到时返回 null，不让页面崩） */
function dictGetStorage() {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * 归一化单词：去掉首尾标点、转小写
 * 点到的可能是 "word," 或 "(word" 这类带标点的文本
 * @param {string} text
 * @returns {string}
 */
function normalizeDictWord(text) {
  return String(text || "").replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z]+$/, "").toLowerCase();
}

/**
 * 构造失败结果
 * @param {string} word
 * @param {string} [meaning] 兜底文案
 * @returns {{word:string, phonetic:string, pos:string, meaning:string, failed:boolean}}
 */
function dictFallback(word, meaning) {
  return {
    word: normalizeDictWord(word) || String(word || "").toLowerCase(),
    phonetic: "",
    pos: "",
    meaning: meaning || DICT_FALLBACK_MEANING,
    failed: true
  };
}

/**
 * 词性补点：模型偶尔输出 "adj" 而不是 "adj."
 * @param {string} pos
 * @returns {string}
 */
function normalizePos(pos) {
  const p = String(pos || "").trim().toLowerCase();
  if (!p) return "";
  if (/\.$/.test(p)) return p;
  if (/^(n|v|adj|adv|prep|conj|pron|num|art|int)$/.test(p)) return p + ".";
  return p;
}

/* ==========================================================================
 * 3. Prompt（查词 → DeepSeek Flash）
 * ========================================================================== */

/**
 * 查词 Prompt：要求只输出一行 JSON，方便直接 JSON.parse
 * @param {string} word
 * @returns {string}
 */
function buildPromptLookup(word) {
  return `你是一本英汉词典。请给出这个单词的标准释义，只输出JSON。
单词：${word}
输出格式严格如下，不要任何其他内容：
{"word":"...","phonetic":"...","pos":"...","meaning":"..."}
要求：
- phonetic 给美式音标，用 // 包裹
- pos 给最常用的1个词性（n./v./adj./adv./prep./conj.）
- meaning 给最常用的1-2个中文意思，多个用分号分隔
- 如果输入的是词的变形形式，还原为词根再查`;
}

/* ==========================================================================
 * 4. 释义缓存读写（7 天有效）
 * ========================================================================== */

/**
 * 读缓存：命中且未过期才返回，过期顺手清掉
 * @param {string} key 归一化后的单词
 * @returns {Object|null}
 */
function readDictCache(key) {
  const store = dictGetStorage();
  if (!store || !key) return null;

  let raw = null;
  try {
    raw = store.getItem(DICT_CACHE_PREFIX + key);
  } catch (e) {
    return null;
  }
  if (!raw) return null;

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    data = null;
  }
  if (!data || typeof data !== "object" || !data.meaning) {
    try { store.removeItem(DICT_CACHE_PREFIX + key); } catch (e2) { /* ignore */ }
    return null;
  }

  // 超过 7 天就当没查过，重新问一次（避免一直用旧数据）
  if (data.ts && (Date.now() - Number(data.ts) > DICT_CACHE_TTL)) {
    try { store.removeItem(DICT_CACHE_PREFIX + key); } catch (e3) { /* ignore */ }
    return null;
  }

  return {
    word: data.word || key,
    phonetic: data.phonetic || "",
    pos: data.pos || "",
    meaning: data.meaning || "",
    cached: true
  };
}

/**
 * 写缓存
 * @param {string} key 归一化后的单词
 * @param {{word:string, phonetic:string, pos:string, meaning:string}} info
 */
function writeDictCache(key, info) {
  const store = dictGetStorage();
  if (!store || !key) return;
  try {
    store.setItem(DICT_CACHE_PREFIX + key, JSON.stringify({
      word: info.word || key,
      phonetic: info.phonetic || "",
      pos: info.pos || "",
      meaning: info.meaning || "",
      ts: Date.now()                 // 写入时间，用于 7 天有效期判断
    }));
  } catch (e) { /* 存不下就算了，下次再查一次 */ }
}

/* ==========================================================================
 * 5. 已查词集合（给正文里的词打淡蓝底色）
 * ========================================================================== */

/** 读取已查词数组 */
function readLookedUpWords() {
  const store = dictGetStorage();
  if (!store) return [];
  let list = [];
  try {
    list = JSON.parse(store.getItem(DICT_LOOKED_KEY) || "[]");
  } catch (e) {
    list = [];
  }
  return Array.isArray(list) ? list : [];
}

/** 写回已查词数组 */
function writeLookedUpWords(list) {
  const store = dictGetStorage();
  if (!store) return;
  try {
    store.setItem(DICT_LOOKED_KEY, JSON.stringify(list));
  } catch (e) { /* ignore */ }
}

/* ==========================================================================
 * 6. 对外 API：Dictionary
 * ========================================================================== */

const Dictionary = {

  /**
   * 查词：缓存命中直接返回，不调 AI；未命中才走 DeepSeek Flash
   * @param {string} word 单词（可带标点，内部会归一化）
   * @returns {Promise<{word:string, phonetic:string, pos:string, meaning:string, cached?:boolean, failed?:boolean}>}
   */
  async lookupWord(word) {
    const key = normalizeDictWord(word);
    if (!key) return dictFallback(word);

    // 1) 先查本地缓存
    const cached = readDictCache(key);
    if (cached) return cached;

    // 2) 没配 Key 就没得查（复用 ai.js 的判断逻辑）
    const AI = (typeof AI_INTERNAL !== "undefined") ? AI_INTERNAL : null;
    if (!AI || !AI.hasApiKey(AI_CONFIG.deepseek)) {
      return dictFallback(key, "未配置 API Key，无法查词");
    }

    // 3) 调 AI：查词要的是快，超时/重试都比内容生成激进一些
    let res = null;
    try {
      res = await AI.requestChat(
        AI_CONFIG.deepseek,
        buildPromptLookup(key),
        "查词(Dictionary/DeepSeek)",
        { timeoutMs: 20000, maxRetries: 1, retryDelayMs: 500 }
      );
    } catch (e) {
      return dictFallback(key, DICT_FALLBACK_MEANING);
    }

    if (!res || !res.ok) return dictFallback(key, DICT_FALLBACK_MEANING);

    // 4) 解析：只认严格 JSON，解析不出来按失败处理
    let parsed = null;
    try {
      parsed = AI.extractJson(res.text);
    } catch (e) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object" || !String(parsed.meaning || "").trim()) {
      return dictFallback(key, DICT_FALLBACK_MEANING);
    }

    const info = {
      word: normalizeDictWord(parsed.word) || key,
      phonetic: String(parsed.phonetic || "").trim(),
      pos: normalizePos(parsed.pos),
      meaning: String(parsed.meaning || "").trim()
    };

    writeDictCache(key, info);
    return info;
  },

  /**
   * 只读本地缓存，不触发 AI 请求
   * 用途：长按收藏时要立刻落库，不能等 AI 返回；有缓存就顺手带上音标/释义，
   * 没缓存就返回 null（调用方可以先存空信息，之后再异步回填）
   * @param {string} word
   * @returns {Object|null} 命中返回 { word, phonetic, pos, meaning, cached:true }
   */
  peek(word) {
    const key = normalizeDictWord(word);
    if (!key) return null;
    return readDictCache(key);        // 过期/不存在都返回 null
  },

  /**
   * 这个词是否查过
   * @param {string} word
   * @returns {boolean}
   */
  isLookedUp(word) {
    const key = normalizeDictWord(word);
    if (!key) return false;
    return readLookedUpWords().indexOf(key) >= 0;
  },

  /**
   * 标记为已查（供 UI 打底色）
   * @param {string} word
   * @returns {string[]} 标记后的完整已查词列表
   */
  markLookedUp(word) {
    const key = normalizeDictWord(word);
    if (!key) return readLookedUpWords();
    const list = readLookedUpWords();
    if (list.indexOf(key) < 0) {
      list.push(key);
      writeLookedUpWords(list);
    }
    return list;
  },

  /** 已查词列表（页面加载时回灌底色） */
  getLookedUpWords() {
    return readLookedUpWords();
  },

  /** 调试用：清掉全部查词缓存与已查标记 */
  clearAll() {
    const store = dictGetStorage();
    if (!store) return;
    try {
      Object.keys(store).forEach(function (k) {
        if (k.indexOf(DICT_CACHE_PREFIX) === 0) store.removeItem(k);
      });
      store.removeItem(DICT_LOOKED_KEY);
    } catch (e) { /* ignore */ }
  }
};

// 浏览器环境下挂 window；Node 环境下导出，方便自测
if (typeof window !== "undefined") {
  window.Dictionary = Dictionary;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = Dictionary;
}
