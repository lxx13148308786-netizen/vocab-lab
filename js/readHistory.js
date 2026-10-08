/**
 * readHistory.js
 * AI 新闻背单词 H5 应用 —— 已读新闻记录模块
 *
 * 职责：
 *   - 记录用户看过的新闻 ID，供 NewsMatcher 在匹配时做已读过滤
 *   - FIFO 裁剪：只保留最近 MAX_RECORDS 条，避免 localStorage 无限膨胀
 *   - 冷却期：已读超过 COOLDOWN_MS 的新闻视为"未读"，可重新进入候选
 *
 * 设计原则：
 *   - 纯数据层，不碰 DOM、不绑定事件
 *   - localStorage key 统一前缀 "anv_"，本模块用 "anv_readHistory"
 *   - 重复 mark 同一篇只更新 readAt（不重复添加），保证 FIFO 顺序正确
 *   - 所有方法静默容错：localStorage 不可用时返回安全默认值，不让页面崩
 *
 * 对外：全局对象 ReadHistory
 *   - markAsRead(newsId)          标记一篇新闻为已读
 *   - isRead(newsId)              判断是否已读（冷却期内才算）
 *   - getAll()                    获取全部记录（按 readAt 升序，旧的在前）
 *   - clear()                     清空全部记录（预留，MVP 无 UI 入口）
 *   - _test                       自测内部接口（常量与底层方法）
 */

const ReadHistory = (function () {

  /* ==========================================================================
   * 1. 常量
   * ========================================================================== */

  /** localStorage key（anv_ 前缀） */
  const STORAGE_KEY = "anv_readHistory";
  /** 最多保留的记录条数，超出按 FIFO 删除最旧的 */
  const MAX_RECORDS = 100;
  /** 冷却期：已读超过该时间视为"未读"，可重新推荐（60 天，毫秒） */
  const COOLDOWN_MS = 60 * 24 * 3600 * 1000;

  /* ==========================================================================
   * 2. 内部工具
   * ========================================================================== */

  /** 取 localStorage（隐私模式 / 无 window 时返回 null，不让页面崩） */
  function getStorage() {
    try {
      if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    } catch (e) { /* ignore */ }
    return null;
  }

  /** 读全部记录（返回数组；坏数据 / 空返回 []） */
  function loadAll() {
    const store = getStorage();
    if (!store) return [];
    try {
      const raw = JSON.parse(store.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw.filter(function (r) { return r && typeof r.id === "string"; });
    } catch (e) { return []; }
  }

  /** 写全部记录（静默失败：localStorage 不可用时跳过） */
  function saveAll(records) {
    const store = getStorage();
    if (!store) return;
    try { store.setItem(STORAGE_KEY, JSON.stringify(records)); } catch (e) { /* ignore */ }
  }

  /* ==========================================================================
   * 3. 对外 API
   * ========================================================================== */

  /**
   * 标记一篇新闻为已读
   *   - 已存在：更新 readAt 并移到末尾（保持 FIFO：最近看的在后面）
   *   - 不存在：追加
   *   - 超过 MAX_RECORDS：从头删掉最旧的
   * @param {string} newsId 新闻 ID
   */
  function markAsRead(newsId) {
    const id = String(newsId || "").trim();
    if (!id) return;
    const now = Date.now();
    const records = loadAll();
    // 去掉同 id 的旧记录，再追加新的，保证顺序 = 最近看的在末尾
    const filtered = records.filter(function (r) { return r.id !== id; });
    filtered.push({ id: id, readAt: now });
    // FIFO 裁剪：只保留最近 MAX_RECORDS 条
    if (filtered.length > MAX_RECORDS) {
      filtered.splice(0, filtered.length - MAX_RECORDS);
    }
    saveAll(filtered);
  }

  /**
   * 判断某篇新闻是否已读（仅在冷却期内才算已读）
   *   - 不在记录里 → false
   *   - 在记录里但 readAt 距今超过 COOLDOWN_MS → false（冷却完成，视为未读）
   *   - 在记录里且未过冷却期 → true
   * @param {string} newsId
   * @param {number} [now] 当前时间戳（测试可注入），默认 Date.now()
   * @returns {boolean}
   */
  function isRead(newsId, now) {
    const id = String(newsId || "").trim();
    if (!id) return false;
    const cur = (typeof now === "number") ? now : Date.now();
    const records = loadAll();
    const r = records.filter(function (x) { return x.id === id; })[0];
    if (!r) return false;
    return (cur - r.readAt) < COOLDOWN_MS;
  }

  /**
   * 获取全部已读记录（按 readAt 升序，旧的在前，便于 FIFO 判断）
   * @returns {Array<{id:string, readAt:number}>}
   */
  function getAll() {
    return loadAll().slice().sort(function (a, b) { return a.readAt - b.readAt; });
  }

  /** 清空全部已读记录（预留，MVP 无 UI 入口） */
  function clear() {
    saveAll([]);
  }

  /* ==========================================================================
   * 4. 对外 API
   * ========================================================================== */

  return {
    markAsRead: markAsRead,
    isRead: isRead,
    getAll: getAll,
    clear: clear,
    // 自测内部接口
    _test: {
      STORAGE_KEY: STORAGE_KEY,
      MAX_RECORDS: MAX_RECORDS,
      COOLDOWN_MS: COOLDOWN_MS,
      loadAll: loadAll,
      saveAll: saveAll
    }
  };
})();

if (typeof window !== "undefined") {
  window.ReadHistory = ReadHistory;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = ReadHistory;
}
