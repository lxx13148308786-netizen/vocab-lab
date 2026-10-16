/**
 * flashcard.js
 * 刷词模块（V2 四档状态）
 *
 * 三种模式：今日新词 / 今日复习 / 候补复习
 * 答题交互：看英文选中文释义，结合答题时间更新状态
 *
 * 依赖：VocabBook / WordPool（全局对象）
 */
var Flashcard = (function () {
  "use strict";

  /* ---------- 内部状态 ---------- */
  var currentMode = "today-new";  // today-new / today-review / standby
  var questions = [];
  var qIndex = 0;
  var startTime = 0;
  var correctCount = 0;
  var totalCount = 0;
  var busy = false;  // 反馈期间禁止点击

  // 本轮学习统计（用于写入 learning_logs）
  var sessNew = 0;           // 本轮「今日新词」已学数
  var sessReview = 0;        // 本轮「复习/候补」已学数
  var sessSec = 0;           // 本轮累计学习时长（秒，含每题反应时长）
  var loggedThisRound = true;// 本轮是否已写入学习日志（防重复/漏记）

  /* ---------- 工具 ---------- */
  function esc(text) {
    return String(text == null ? "" : text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function tip(msg) {
    if (typeof toast === "function") toast(msg);
  }

  function vbToday() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  /** 打乱数组（Fisher-Yates） */
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------- 词池获取 ---------- */
  function getPool(mode) {
    var today = vbToday();
    var pool = { newWords: [], reviewWords: [], standbyWords: [] };

    if (typeof WordPool !== "undefined" && WordPool.generateDailyPool) {
      var p = WordPool.generateDailyPool(today);
      pool.newWords = p.newWords || [];
      pool.reviewWords = p.reviewWords || [];
      pool.standbyWords = p.standbyWords || [];
    } else if (typeof VocabBook !== "undefined") {
      var due = VocabBook.getDueWords(today);
      pool.reviewWords = due.slice(0, 10);
      pool.standbyWords = due.slice(10);
    }

    switch (mode) {
      case "today-new": return pool.newWords;
      case "today-review": return pool.reviewWords;
      case "standby": return pool.standbyWords;
    }
    return [];
  }

  /* ---------- 生成题目 ---------- */
  function buildQuestions(words) {
    if (!words.length) return [];
    var allWords = [];
    if (typeof VocabBook !== "undefined") {
      allWords = VocabBook.getAllWords() || [];
    }
    if (!allWords.length) allWords = words;

    return words.map(function (w) {
      var correctMeaning = w.meaning || "（无释义）";
      // 收集干扰项（同词性优先）
      var samePos = allWords.filter(function (x) {
        return x.word !== w.word && x.meaning && (x.pos === w.pos || !w.pos);
      });
      var others = allWords.filter(function (x) {
        return x.word !== w.word && x.meaning && samePos.indexOf(x) < 0;
      });
      var candidates = shuffle(samePos.concat(others));
      var distractors = candidates.slice(0, 3).map(function (x) { return x.meaning; });
      // 不够时补占位
      while (distractors.length < 3) distractors.push("—");

      var options = shuffle([correctMeaning].concat(distractors));
      return {
        word: w.word,
        phonetic: w.phonetic || "",
        correctMeaning: correctMeaning,
        options: options
      };
    });
  }

  /* ---------- DOM 操作 ---------- */
  function getPage() { return (typeof document !== "undefined") ? document.getElementById("flashcardPage") : null; }
  function getWordEl() { return (typeof document !== "undefined") ? document.getElementById("flashcardWord") : null; }
  function getOptionsEl() { return (typeof document !== "undefined") ? document.getElementById("flashcardOptions") : null; }
  function getProgressText() { return (typeof document !== "undefined") ? document.getElementById("flashcardProgressText") : null; }
  function getProgressBar() { return (typeof document !== "undefined") ? document.getElementById("flashcardProgressBar") : null; }
  function getResultEl() { return (typeof document !== "undefined") ? document.getElementById("flashcardResult") : null; }
  function getResultText() { return (typeof document !== "undefined") ? document.getElementById("flashcardResultText") : null; }
  function getTitleEl() { return (typeof document !== "undefined") ? document.getElementById("flashcardTitle") : null; }

  /* ---------- 显示/隐藏 ---------- */
  function showQuestion() {
    if (qIndex >= questions.length) { showResult(); return; }

    var q = questions[qIndex];
    var wordEl = getWordEl();
    var optionsEl = getOptionsEl();
    if (wordEl) wordEl.textContent = q.word;

    if (optionsEl) {
      optionsEl.innerHTML = q.options.map(function (opt, i) {
        return '<button class="option-btn" data-opt-idx="' + i + '">' + esc(opt) + '</button>';
      }).join("");
    }

    updateProgress();
    startTime = Date.now();
    busy = false;
  }

  function updateProgress() {
    var progressText = getProgressText();
    var progressBar = getProgressBar();
    var total = Math.max(questions.length, 1);
    if (progressText) progressText.textContent = "第 " + (qIndex + 1) + " 题 / 共 " + total + " 题";
    if (progressBar) progressBar.style.width = ((qIndex / total) * 100) + "%";
  }

  /* ---------- 学习日志：本轮结束后写入（本地 + 云端累加） ---------- */
  function flushLearningLog() {
    if (loggedThisRound) return;
    if (sessNew === 0 && sessReview === 0 && sessSec === 0) { loggedThisRound = true; return; }
    loggedThisRound = true;
    try {
      if (typeof window !== "undefined" && window.DB && window.DB.updateLearningLog) {
        // 未登录时只写本地，登录后下次 updateLearningLog 补传云端
        window.DB.updateLearningLog(vbToday(), {
          new_words_count: sessNew,
          review_words_count: sessReview,
          total_study_seconds: Math.round(sessSec)
        });
      }
    } catch (e) {
      console.warn("[Flashcard] 学习日志写入失败:", e && e.message);
    }
  }

  function showResult() {
    flushLearningLog();   // 本轮答完，落账
    var optionsEl = getOptionsEl();
    var resultEl = getResultEl();
    var resultText = getResultText();
    var progressBar = getProgressBar();

    if (optionsEl) optionsEl.innerHTML = "";
    if (resultText) resultText.textContent = "本轮结果：" + correctCount + " / " + totalCount + " 正确";
    if (resultEl) resultEl.classList.remove("hidden");
    if (progressBar) progressBar.style.width = "100%";
  }

  /* ---------- 答题处理 ---------- */
  function handleAnswer(optIdx) {
    if (busy || qIndex >= questions.length) return;
    busy = true;

    var q = questions[qIndex];
    var reactionMs = Date.now() - startTime;
    var isCorrect = q.options[optIdx] === q.correctMeaning;

    totalCount++;
    if (isCorrect) correctCount++;

    // 累计本轮学习数据（新词 vs 复习按模式区分；时长取每题反应时长）
    if (currentMode === "today-new") sessNew++;
    else sessReview++;
    sessSec += reactionMs / 1000;

    // 更新单词状态
    if (typeof VocabBook !== "undefined" && VocabBook.updateWordStatus) {
      VocabBook.updateWordStatus(q.word, reactionMs, isCorrect);
    }

    // 视觉反馈
    var optionsEl = getOptionsEl();
    if (optionsEl) {
      var btns = optionsEl.querySelectorAll(".option-btn");
      for (var i = 0; i < btns.length; i++) {
        btns[i].disabled = true;
        if (q.options[i] === q.correctMeaning) {
          btns[i].classList.add("correct");
        } else if (i === optIdx && !isCorrect) {
          btns[i].classList.add("wrong");
        }
      }
    }

    // 1秒后下一题
    setTimeout(function () {
      qIndex++;
      busy = false;
      showQuestion();
    }, 1000);
  }

  /* ---------- 模式切换 ---------- */
  function switchMode(mode) {
    currentMode = mode;
    startNewRound();

    // 更新 tab 样式
    var page = getPage();
    if (!page) return;
    var tabs = page.querySelectorAll(".mode-tab");
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute("data-mode") === mode) {
        tabs[i].classList.add("active");
      } else {
        tabs[i].classList.remove("active");
      }
    }

    var titleEl = getTitleEl();
    var names = { "today-new": "刷词 · 今日新词", "today-review": "刷词 · 今日复习", "standby": "刷词 · 候补复习" };
    if (titleEl) titleEl.textContent = names[mode] || "刷词";
  }

  /** 开始新一轮 */
  function startNewRound() {
    flushLearningLog();   // 先把上一轮（可能没答完）的进度落账
    var pool = getPool(currentMode);
    // 候补复习每次随机抽10个
    if (currentMode === "standby" && pool.length > 10) {
      pool = shuffle(pool).slice(0, 10);
    }
    questions = buildQuestions(pool);
    qIndex = 0;
    correctCount = 0;
    totalCount = 0;
    busy = false;
    sessNew = 0;
    sessReview = 0;
    sessSec = 0;
    loggedThisRound = false;

    var resultEl = getResultEl();
    if (resultEl) resultEl.classList.add("hidden");

    if (!questions.length) {
      var optionsEl = getOptionsEl();
      var resultText = getResultText();
      if (optionsEl) optionsEl.innerHTML = "";
      if (resultText) resultText.textContent = "当前模式下没有可刷的词";
      if (resultEl) resultEl.classList.remove("hidden");
      return;
    }

    showQuestion();
  }

  /* ---------- 公共 API ---------- */
  function open() {
    var page = getPage();
    if (!page) return;
    page.classList.remove("hidden");
    startNewRound();
  }

  function close() {
    var page = getPage();
    if (!page) return;
    flushLearningLog();   // 中途退出也落账（已记过则跳过）
    page.classList.add("hidden");
  }

  function init() {
    var backBtn = (typeof document !== "undefined") ? document.getElementById("flashcardBackBtn") : null;
    if (backBtn) backBtn.addEventListener("click", close);

    var retryBtn = (typeof document !== "undefined") ? document.getElementById("flashcardRetryBtn") : null;
    if (retryBtn) retryBtn.addEventListener("click", startNewRound);

    // 模式 tab 点击
    var page = getPage();
    if (page) {
      var tabs = page.querySelectorAll(".mode-tab");
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].addEventListener("click", function () {
          switchMode(this.getAttribute("data-mode"));
        });
      }
    }

    // 选项点击委托
    var optionsEl = getOptionsEl();
    if (optionsEl) {
      optionsEl.addEventListener("click", function (e) {
        var btn = e.target.closest(".option-btn");
        if (!btn) return;
        var idx = parseInt(btn.getAttribute("data-opt-idx"), 10);
        handleAnswer(idx);
      });
    }
  }

  return {
    init: init,
    open: open,
    close: close,
    switchMode: switchMode,
    startNewRound: startNewRound,
    _test: {
      getPool: getPool,
      buildQuestions: buildQuestions,
      getCurrentMode: function () { return currentMode; },
      getQuestions: function () { return questions; },
      getQIndex: function () { return qIndex; },
      getCorrectCount: function () { return correctCount; },
      getTotalCount: function () { return totalCount; },
      answerCurrent: function (idx) { handleAnswer(idx); },
      getSession: function () { return { new: sessNew, review: sessReview, sec: sessSec, logged: loggedThisRound }; }
    }
  };
})();

if (typeof window !== "undefined") {
  window.Flashcard = Flashcard;
}

if (typeof window !== "undefined") {
  window.Flashcard = Flashcard;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = Flashcard;
}
