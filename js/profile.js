/**
 * profile.js
 * 个人中心模块（V2）
 *
 * 包含：词汇量显示、去测试入口、批量导入入口、学习数据、清空数据
 * 依赖：VocabBook / VocabTest（全局对象）
 */
var Profile = (function () {
  "use strict";

  /** 获取今天的 "YYYY-MM-DD" */
  function pToday() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  /** 转义 HTML */
  function esc(text) {
    return String(text == null ? "" : text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** toast 兼容 */
  function tip(msg) {
    if (typeof toast === "function") toast(msg);
  }

  /** 云端同步 UI 相关状态 */
  var SYNC_KEY = "anv_lastCloudSync";
  var _lastSyncTs = 0;
  var _syncing = false;
  (function () {
    try {
      var s = (typeof window !== "undefined" && window.localStorage) ? window.localStorage : null;
      if (s) { var v = s.getItem(SYNC_KEY); if (v) _lastSyncTs = Number(v) || 0; }
    } catch (e) { /* ignore */ }
  })();
  function readLastSync() { return _lastSyncTs; }
  function storeLastSync(ts) {
    _lastSyncTs = ts;
    try {
      var s = (typeof window !== "undefined" && window.localStorage) ? window.localStorage : null;
      if (s) s.setItem(SYNC_KEY, String(ts));
    } catch (e) { /* ignore */ }
  }
  function formatSyncTime(ts) {
    var d = new Date(ts);
    function p(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function updateSyncUI() {
    var box = (typeof document !== "undefined") ? document.getElementById("profileSyncArea") : null;
    if (!box) return;
    if (!window.DB || !window.DB.isLoggedIn || !window.DB.isLoggedIn()) {
      box.innerHTML = '<div class="profile-stat-row">登录后可同步数据到云端</div>';
      return;
    }
    var last = _lastSyncTs ? formatSyncTime(_lastSyncTs) : "尚未同步";
    if (_syncing) {
      box.innerHTML =
        '<div class="profile-stat-row">上次同步：' + esc(last) + '</div>' +
        '<button class="btn primary" id="profileSyncBtn" disabled>同步中…</button>';
      return;
    }
    box.innerHTML =
      '<div class="profile-stat-row">上次同步：' + esc(last) + '</div>' +
      '<button class="btn primary" id="profileSyncBtn">立即同步</button>';
    var b = box.querySelector("#profileSyncBtn");
    if (b) b.addEventListener("click", doManualSync);
  }

  async function doManualSync() {
    if (_syncing) return;
    if (!window.DB || !window.DB.isLoggedIn || !window.DB.isLoggedIn()) { tip("请先登录"); return; }
    _syncing = true; updateSyncUI();
    try {
      var res = await window.VocabBook.syncToCloud();
      _syncing = false;
      if (res && res.ok) { storeLastSync(Date.now()); tip("同步成功"); }
      else { tip("同步失败：" + ((res && res.error) || "未知错误")); }
    } catch (e) {
      _syncing = false;
      tip("同步失败：" + ((e && e.message) || e));
    }
    updateSyncUI();
  }

  /** 读取词汇量测试结果 */
  function getVocabScore() {
    try {
      var s = (typeof window !== "undefined" && window.localStorage) ? window.localStorage : null;
      if (!s) return null;
      var raw = s.getItem("anv_vocabTestResult");
      if (!raw) return null;
      var obj = JSON.parse(raw);
      return (obj && typeof obj.score === "number") ? obj.score : null;
    } catch (e) { return null; }
  }

  /** 累计学习天数（简化：从 localStorage 读最早日期算差） */
  function getStudyDays() {
    try {
      var s = (typeof window !== "undefined" && window.localStorage) ? window.localStorage : null;
      if (!s) return 0;
      var firstDate = s.getItem("anv_firstStudyDate");
      if (!firstDate) return 0;
      var parts = firstDate.split("-");
      var d1 = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      var d2 = new Date();
      return Math.max(1, Math.round((d2 - d1) / 86400000) + 1);
    } catch (e) { return 0; }
  }

  /** 渲染个人中心内容 */
  function renderContent() {
    var page = (typeof document !== "undefined") ? document.getElementById("profilePage") : null;
    if (!page) return;

    var score = getVocabScore();
    var scoreText = (score !== null) ? "约 " + score + " 词" : "还没测过词汇量";
    var studyDays = getStudyDays();
    var totalWords = 0, masteredCount = 0;
    if (typeof VocabBook !== "undefined") {
      var stats = VocabBook.getStats();
      totalWords = stats.total;
      masteredCount = stats.mastered;
    }

    var contentEl = page.querySelector(".profile-content");
    if (!contentEl) return;

    contentEl.innerHTML =
      '<div class="card">' +
        '<h3>词汇量</h3>' +
        '<div class="profile-vocab-score">' + esc(scoreText) + '</div>' +
        '<button class="btn primary" id="profileVocabTestBtn">去测试</button>' +
      '</div>' +
      '<div class="card">' +
        '<h3>批量导入单词</h3>' +
        '<button class="btn" id="profileBatchImportBtn">批量导入单词</button>' +
      '</div>' +
      '<div class="card">' +
        '<h3>学习数据</h3>' +
        '<div class="profile-stat-row">累计学习 <b>' + studyDays + '</b> 天</div>' +
        '<div class="profile-stat-row">单词本总词数 <b>' + totalWords + '</b></div>' +
        '<div class="profile-stat-row">已掌握词数 <b>' + masteredCount + '</b></div>' +
      '</div>' +
      '<div class="card">' +
        '<h3>账户</h3>' +
        '<div id="profileAccountCard"></div>' +
      '</div>' +
      '<div class="card">' +
        '<h3>数据同步</h3>' +
        '<div id="profileSyncArea"></div>' +
      '</div>' +
      '<div class="card">' +
        '<h3>数据管理</h3>' +
        '<button class="btn danger" id="profileClearBtn">清空所有数据</button>' +
      '</div>';

    // 绑定事件
    var testBtn = contentEl.querySelector("#profileVocabTestBtn");
    if (testBtn) {
      testBtn.addEventListener("click", function () {
        if (typeof VocabTest !== "undefined" && VocabTest.open) VocabTest.open();
        closeProfile();
      });
    }

    var importBtn = contentEl.querySelector("#profileBatchImportBtn");
    if (importBtn) {
      importBtn.addEventListener("click", function () {
        if (typeof VocabTest !== "undefined" && VocabTest.openBatchImport) VocabTest.openBatchImport();
      });
    }

    // 账户区根据当前登录态动态渲染（已登录显示邮箱 + 退出，未登录显示登录入口）
    updateAccountUI();

    // 数据同步卡片：未登录提示 / 已登录显示上次同步时间 + 立即同步按钮
    updateSyncUI();

    var clearBtn = contentEl.querySelector("#profileClearBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        if (typeof window !== "undefined" && window.confirm("确定要清空所有数据吗？此操作不可恢复。")) {
          clearAllData();
        }
      });
    }
  }

  /**
   * 列出 localStorage 里的所有 key
   * 标准 localStorage 只有 length + key(i)，部分实现（含自测桩）不支持，
   * 所以两条路都走一遍，取并集 —— 缺哪条都不会漏。
   * @param {Storage} s
   * @returns {Array<string>}
   */
  function listStorageKeys(s) {
    var keys = [];
    try {
      for (var i = 0; i < s.length; i++) {
        var k = s.key(i);
        if (k) keys.push(k);
      }
    } catch (e) { /* 部分实现不支持 key()，忽略 */ }
    try {
      Object.keys(s).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    } catch (e) { /* ignore */ }
    return keys;
  }

  /** 清空所有 anv_ 开头的 localStorage */
  function clearAllData() {
    try {
      var s = (typeof window !== "undefined" && window.localStorage) ? window.localStorage : null;
      if (!s) return;
      listStorageKeys(s).forEach(function (key) {
        if (key.indexOf("anv_") === 0) s.removeItem(key);
      });
      // 也清 vocabBook（key 不以 anv_ 开头，是 V1 起的固定名）
      s.removeItem("vocabBook");
    } catch (e) { /* ignore */ }

    if (typeof VocabBook !== "undefined" && VocabBook.clear) VocabBook.clear();
    renderContent();
    tip("所有数据已清空");
  }

  /**
   * 根据当前登录态渲染「账户」卡片区域
   * 已登录 → 显示邮箱 + 退出按钮；未登录 → 显示登录入口
   */
  function updateAccountUI() {
    var box = (typeof document !== "undefined") ? document.getElementById("profileAccountCard") : null;
    if (!box) return;

    // 认证模块未就绪：保守显示未登录入口
    if (typeof window === "undefined" || !window.Auth || !window.Auth.getCurrentUser) {
      renderLoggedOut(box);
      return;
    }

    window.Auth.getCurrentUser().then(function (user) {
      if (user) renderLoggedIn(box, user);
      else renderLoggedOut(box);
    }).catch(function () {
      renderLoggedOut(box);
    });
  }

  /** 已登录：邮箱 + 退出按钮 */
  function renderLoggedIn(box, user) {
    box.innerHTML =
      '<div class="profile-stat-row">已登录：<b>' + esc(user.email || "") + '</b></div>' +
      '<button class="btn danger" id="profileLogoutBtn">退出登录</button>';
    var out = box.querySelector("#profileLogoutBtn");
    if (out) {
      out.addEventListener("click", function () {
        window.Auth.signOut().then(function (res) {
          if (res && res.error) { tip(res.error.message || "退出失败"); return; }
          // 退出成功：刷新页面回到未登录态（onAuthStateChange 也会触发）
          if (typeof window !== "undefined" && window.location) window.location.reload();
        });
      });
    }
  }

  /** 未登录：登录 / 注册入口 */
  function renderLoggedOut(box) {
    box.innerHTML =
      '<div class="profile-stat-row">未登录</div>' +
      '<button class="btn" id="profileLoginBtn">登录 / 注册</button>';
    var login = box.querySelector("#profileLoginBtn");
    if (login) {
      login.addEventListener("click", function () {
        if (typeof window !== "undefined" && window.AuthUI && window.AuthUI.open) {
          window.AuthUI.open("signin");
        }
      });
    }
  }

  /** 底部操作栏（加词 / 单词本 / 刷词）
 *
 * 底部栏只属于主界面那四个 Tab（单词表 / 新闻 / 词汇段 / 检测）。
 * 个人中心是覆盖在主界面之上的全屏页（#profilePage 用 .vt-page），
 * 底部栏 z-index 85 > .vt-page 60，会浮在个人中心内容上把最后几行压住 ——
 * 所以进个人中心必须把它藏掉。
 *
 * 用 class 不用 style.display（需求要求走 CSS 类）：
 * display/过渡/padding 补偿全在 style.css 里，JS 只负责加类，
 * 样式改动不用碰 JS。
 */
function setBottombarHidden(hidden) {
  var bar = (typeof document !== "undefined")
    ? document.querySelector(".bottombar")
    : null;
  if (!bar) return;
  bar.classList.toggle("bottombar-hidden", !!hidden);
}

/** 打开个人中心 */
function openProfile() {
    var page = (typeof document !== "undefined") ? document.getElementById("profilePage") : null;
    if (!page) return;
    page.classList.remove("hidden");
    setBottombarHidden(true);
    renderContent();
  }

  /** 关闭个人中心 */
  function closeProfile() {
    var page = (typeof document !== "undefined") ? document.getElementById("profilePage") : null;
    if (!page) return;
    page.classList.add("hidden");
    setBottombarHidden(false);
  }

  /** 初始化 */
  function init() {
    var backBtn = (typeof document !== "undefined") ? document.getElementById("profileBackBtn") : null;
    if (backBtn) {
      backBtn.addEventListener("click", closeProfile);
    }

    // 监听登录状态变化，实时更新账户区（退出 / 登录后即便不刷新也同步）
    if (typeof window !== "undefined" && window.Auth && window.Auth.onAuthStateChange) {
      window.Auth.onAuthStateChange(function () {
        updateAccountUI();
        // 登录态变化会直接影响同步卡片（未登录→提示，已登录→可同步）
        updateSyncUI();
      });
    }
  }

  return {
    init: init,
    open: openProfile,
    close: closeProfile,
    renderContent: renderContent
  };
})();

if (typeof window !== "undefined") {
  window.Profile = Profile;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = Profile;
}
