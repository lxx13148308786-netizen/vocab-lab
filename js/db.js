// js/db.js - 数据库操作模块（Supabase）
// 依赖：window.Auth.client（认证模块已暴露的 Supabase 客户端）
// 通过 window.DB 暴露：单词 CRUD / 学习日志 / 双向同步
// 约定：未登录时所有方法直接返回 null 或空数组；任何错误都 catch 并打印控制台，不抛页面。
(function () {
  "use strict";

  var TABLE_WORDS = "user_words";
  var TABLE_LOGS = "learning_logs";

  /* ---------- 登录态缓存 ---------- */
  // 缓存当前用户 id，避免每次操作都去网络取；onAuthStateChange 与初始化时刷新
  var currentUserId = null;

  function getClient() {
    if (typeof window === "undefined" || !window.Auth || !window.Auth.client) return null;
    return window.Auth.client;
  }

  // 确保拿到当前用户（订阅事件 + 初始化时取一次）
  function ensureUser() {
    if (currentUserId) return Promise.resolve(currentUserId);
    var auth = (typeof window !== "undefined") ? window.Auth : null;
    if (!auth || !auth.getCurrentUser) return Promise.resolve(null);
    return auth.getCurrentUser().then(function (user) {
      currentUserId = user ? user.id : null;
      return currentUserId;
    }).catch(function () {
      currentUserId = null;
      return null;
    });
  }

  function isLoggedIn() {
    return !!currentUserId;
  }

  /* ---------- 本地 ↔ 云端 字段映射 ---------- */
  function normalize(w) {
    return String(w == null ? "" : w).trim().toLowerCase();
  }
  // source 归一：只有显式 "manual" 才是手动添加，其余（未传/旧值/云拉取）一律 "news"
  function normalizeSource(s) {
    return (s === "manual") ? "manual" : "news";
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }
  function dateToStr(date) {
    if (!date) return todayStr();
    return date.getFullYear() + "-" +
      String(date.getMonth() + 1).padStart(2, "0") + "-" +
      String(date.getDate()).padStart(2, "0");
  }
  function addDaysStr(dateStr, days) {
    var p = String(dateStr || todayStr()).split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() + Number(days || 0));
    return dateToStr(d);
  }
  // 状态间隔（天），供 updateWordStatus 估算 next_review
  var STATUS_INTERVAL = { new: 1, familiar: 3, known: 7, mastered: 30 };

  // 本地学习日志缓存（localStorage）：{ "YYYY-MM-DD": { new_words_count, review_words_count, total_study_seconds } }
  // 与单词本一样走「本地优先」：离线也能记；登录后由 updateLearningLog 补传云端。
  var LOCAL_LOGS_KEY = "anv_learning_logs";
  function loadLocalLogs() {
    try {
      if (typeof localStorage === "undefined") return {};
      var raw = localStorage.getItem(LOCAL_LOGS_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return (obj && typeof obj === "object") ? obj : {};
    } catch (e) { return {}; }
  }
  function saveLocalLogs(obj) {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(LOCAL_LOGS_KEY, JSON.stringify(obj || {}));
    } catch (e) { /* 隐私模式 / 配额满：忽略，不阻塞学习 */ }
  }

  // 本地记录（VocabBook 形状）→ 云端行
  function localToRow(rec, uid) {
    var base = (typeof rec.addedAt === "number" && rec.addedAt)
      ? dateToStr(new Date(rec.addedAt)) : todayStr();
    var addDate = rec.addDate || base;
    return {
      user_id: uid,
      word: normalize(rec.word),
      phonetic: String(rec.phonetic || ""),
      pos: String(rec.pos || ""),
      meaning: String(rec.meaning || ""),
      status: rec.status || "new",
      source: normalizeSource(rec.source),
      add_date: addDate,
      next_review: rec.nextReviewDate || addDate,
      review_count: Number(rec.reviewCount) || 0,
      last_review: rec.lastReview || null,
      reaction_ms: (typeof rec.reactionMs === "number") ? rec.reactionMs : null
    };
  }

  // 云端行 → 本地记录（VocabBook 形状）
  function rowToLocal(row) {
    if (!row || !row.word) return null;
    return {
      word: normalize(row.word),
      phonetic: String(row.phonetic || ""),
      pos: String(row.pos || ""),
      meaning: String(row.meaning || ""),
      status: row.status || "new",
      addedAt: row.add_date ? Date.parse(row.add_date) : Date.now(),
      nextReviewDate: row.next_review || todayStr(),
      reviewCount: Number(row.review_count) || 0,
      source: normalizeSource(row.source),
      sourceNewsId: ""
    };
  }

  function mapRows(rows) {
    if (!rows || !rows.length) return [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rowToLocal(rows[i]);
      if (r) out.push(r);
    }
    return out;
  }

  /* ---------- 通用执行器：统一 catch，返回 {error} ---------- */
  function run(promise) {
    return promise.then(function (res) {
      if (res && res.error) return { data: res.data, error: res.error };
      return { data: res.data, error: null };
    }).catch(function (e) {
      console.error("[DB] 数据库操作失败:", e && e.message);
      return { data: null, error: (e && e.message) || "数据库错误" };
    });
  }

  /* ========================================================================
   * 单词相关
   * ======================================================================== */
  async function getAllWords() {
    var uid = await ensureUser();
    if (!uid) return [];
    var client = getClient();
    if (!client) return [];
    var r = await run(client.from(TABLE_WORDS).select("*").eq("user_id", uid));
    if (r.error) return [];
    return mapRows(r.data);
  }

  async function getDueWords(today) {
    var uid = await ensureUser();
    if (!uid) return [];
    var client = getClient();
    if (!client) return [];
    var day = today || todayStr();
    var r = await run(
      client.from(TABLE_WORDS)
        .select("*")
        .eq("user_id", uid)
        .lte("next_review", day)
        .neq("status", "mastered")
    );
    if (r.error) return [];
    return mapRows(r.data);
  }

  async function upsertWord(wordData) {
    var uid = await ensureUser();
    if (!uid || !wordData) return null;
    var client = getClient();
    if (!client) return null;
    var row = localToRow(wordData, uid);
    var r = await run(client.from(TABLE_WORDS).upsert(row, { onConflict: "user_id,word" }));
    if (r.error) return { error: r.error };
    return { error: null };
  }

  async function upsertWords(words) {
    var uid = await ensureUser();
    if (!uid || !words || !words.length) return { count: 0, error: null };
    var client = getClient();
    if (!client) return { count: 0, error: null };
    var rows = words.map(function (w) { return localToRow(w, uid); });
    var r = await run(client.from(TABLE_WORDS).upsert(rows, { onConflict: "user_id,word" }));
    if (r.error) return { count: 0, error: r.error };
    return { count: rows.length, error: null };
  }

  async function updateWordStatus(word, isCorrect, reactionMs, today) {
    var uid = await ensureUser();
    if (!uid) return null;
    var client = getClient();
    if (!client) return null;
    // 先取云端现有记录，本地算出新状态再 upsert（与 VocabBook 升降级规则保持一致）
    var cur = await run(client.from(TABLE_WORDS).select("*").eq("user_id", uid).eq("word", normalize(word)));
    var rec = (cur.data && cur.data[0]) ? rowToLocal(cur.data[0]) : {
      word: normalize(word), status: "new", reviewCount: 0,
      nextReviewDate: today || todayStr(), source: "app"
    };
    var idx = ["new", "familiar", "known", "mastered"].indexOf(rec.status);
    if (idx < 0) idx = 0;
    var ms = Number(reactionMs) || 0;
    if (isCorrect) {
      if (ms < 3000) idx = Math.min(idx + 2, 3);
      else if (ms <= 6000) idx = Math.min(idx + 1, 3);
    } else {
      idx = Math.max(idx - 1, 0);
    }
    var newStatus = ["new", "familiar", "known", "mastered"][idx];
    rec.status = newStatus;
    rec.reviewCount = (Number(rec.reviewCount) || 0) + 1;
    rec.lastReview = today || todayStr();
    rec.reactionMs = ms || null;
    rec.nextReviewDate = addDaysStr(today || todayStr(), STATUS_INTERVAL[newStatus] || 1);
    rec.addDate = rec.addedAt ? dateToStr(new Date(rec.addedAt)) : (today || todayStr());
    var r = await run(client.from(TABLE_WORDS).upsert(localToRow(rec, uid), { onConflict: "user_id,word" }));
    if (r.error) return { error: r.error };
    return { error: null };
  }

  async function deleteWord(word) {
    var uid = await ensureUser();
    if (!uid) return null;
    var client = getClient();
    if (!client) return null;
    var r = await run(
      client.from(TABLE_WORDS).delete().eq("user_id", uid).eq("word", normalize(word))
    );
    if (r.error) return { error: r.error };
    return { error: null };
  }

  /* ========================================================================
   * 学习日志相关
   * ======================================================================== */
  async function getLearningLog(date) {
    var day = date || todayStr();
    // 本地优先（离线可用，且累计值已在本地合并）；本地没有再查云端并回写本地缓存
    var logs = loadLocalLogs();
    if (logs[day]) return logs[day];
    var uid = await ensureUser();
    if (!uid) return null;
    var client = getClient();
    if (!client) return null;
    var r = await run(
      client.from(TABLE_LOGS).select("*").eq("user_id", uid).eq("log_date", day)
    );
    if (r.error) return null;
    var row = (r.data && r.data[0]) || null;
    if (!row) return null;
    var rec = {
      new_words_count: Number(row.new_words_count) || 0,
      review_words_count: Number(row.review_words_count) || 0,
      total_study_seconds: Number(row.total_study_seconds) || 0
    };
    logs[day] = rec;
    saveLocalLogs(logs);
    return rec;
  }

  async function updateLearningLog(date, data) {
    var day = date || todayStr();
    var d = data || {};
    // 本地累加：同一天多次学习合并到同一天，绝不新建多条
    var logs = loadLocalLogs();
    var cur = logs[day] || { new_words_count: 0, review_words_count: 0, total_study_seconds: 0 };
    var merged = {
      new_words_count: (Number(cur.new_words_count) || 0) + (Number(d.new_words_count) || 0),
      review_words_count: (Number(cur.review_words_count) || 0) + (Number(d.review_words_count) || 0),
      total_study_seconds: (Number(cur.total_study_seconds) || 0) + (Number(d.total_study_seconds) || 0)
    };
    logs[day] = merged;
    saveLocalLogs(logs);

    // 云端：登录后 upsert 累计总值（onConflict user_id,log_date 合并到同一行）
    var uid = await ensureUser();
    if (!uid) return { error: null, localOnly: true };
    var client = getClient();
    if (!client) return { error: null, localOnly: true };
    var row = {
      user_id: uid,
      log_date: day,
      new_words_count: merged.new_words_count,
      review_words_count: merged.review_words_count,
      total_study_seconds: merged.total_study_seconds
    };
    var r = await run(client.from(TABLE_LOGS).upsert(row, { onConflict: "user_id,log_date" }));
    if (r.error) return { error: r.error };
    return { error: null };
  }

  /* ========================================================================
   * 同步相关
   * ======================================================================== */
  // 把本地单词本全量同步到云端
  async function syncLocalToCloud(localWords) {
    if (!localWords) {
      var uid0 = await ensureUser();
      if (!uid0) return { count: 0, error: null };
      // 没传则从 VocabBook 取（这里不依赖 VocabBook，调用方负责传）
      return { count: 0, error: "缺少本地单词数据" };
    }
    return upsertWords(localWords);
  }

  // 把云端单词全量拉回本地（返回本地形状数组，调用方决定如何合并）
  async function syncCloudToLocal() {
    var uid = await ensureUser();
    if (!uid) return null;
    var client = getClient();
    if (!client) return null;
    var r = await run(client.from(TABLE_WORDS).select("*").eq("user_id", uid));
    if (r.error) return null;
    return mapRows(r.data);
  }

  /* ---------- 初始化：种子用户 + 订阅登录态 ---------- */
  if (typeof window !== "undefined" && window.Auth) {
    // 初始化时取一次当前用户（处理「已登录后刷新」）
    ensureUser();
    if (window.Auth.onAuthStateChange) {
      window.Auth.onAuthStateChange(function (event, user) {
        currentUserId = user ? user.id : null;
      });
    }
  }

  window.DB = {
    // 登录态
    isLoggedIn: isLoggedIn,
    // 单词
    getAllWords: getAllWords,
    getDueWords: getDueWords,
    upsertWord: upsertWord,
    upsertWords: upsertWords,
    updateWordStatus: updateWordStatus,
    deleteWord: deleteWord,
    // 日志
    getLearningLog: getLearningLog,
    updateLearningLog: updateLearningLog,
    // 同步
    syncLocalToCloud: syncLocalToCloud,
    syncCloudToLocal: syncCloudToLocal
  };
})();
