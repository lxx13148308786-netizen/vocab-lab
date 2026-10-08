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
        '<div>未登录</div>' +
        '<button class="btn" id="profileLoginBtn">登录 / 注册</button>' +
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

    var loginBtn = contentEl.querySelector("#profileLoginBtn");
    if (loginBtn) {
      loginBtn.addEventListener("click", function () {
        tip("功能开发中");
      });
    }

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
