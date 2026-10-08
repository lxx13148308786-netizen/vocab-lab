/**
 * vocabBookUI.js
 * AI 新闻背单词 H5 应用 —— 单词本页面（V2 四档状态 + 今日单词视图）
 *
 * V2 变更：
 *   - 五档标签 → 四档 (new/familiar/known/mastered)
 *   - 双视图：今日单词（新学+复习+候补） / 全部单词
 *   - 顶部统计：总词数 / 已掌握 / 今日待复习（醒目）
 *   - 批量导入按钮移到个人中心，统计栏不再放
 *   - nextReviewDate 改为日期字符串
 *
 * 对外：全局对象 VocabBookUI
 */

var VocabBookUI = (function () {

  /* ==========================================================================
   * 1. 常量
   * ========================================================================== */

  /** 四档状态顺序 */
  var STATUS_ORDER = ["new", "familiar", "known", "mastered"];

  /** 状态 → 标签文案 + 颜色 class */
  var STATUS_META = {
    "new":      { label: "新词",   cls: "st-new" },
    familiar:   { label: "眼熟",   cls: "st-familiar" },
    known:      { label: "认识",   cls: "st-known" },
    mastered:   { label: "已掌握", cls: "st-mastered" }
  };

  /** 状态筛选标签（全部单词视图用） */
  var FILTERS = [
    { key: "all",       label: "全部",   statuses: null },
    { key: "new",       label: "新词",   statuses: ["new"] },
    { key: "familiar",  label: "眼熟",   statuses: ["familiar"] },
    { key: "known",     label: "认识",   statuses: ["known"] },
    { key: "mastered",  label: "已掌握", statuses: ["mastered"] }
  ];

  /** 排序方式 */
  var SORTS = [
    { key: "time", label: "添加时间" },
    { key: "freq", label: "词频" }
  ];

  /** 左滑删除按钮宽度 */
  var DELETE_WIDTH = 72;
  var SWIPE_LOCK_PX = 8;

  /* ==========================================================================
   * 2. 内部状态
   * ========================================================================== */

  var state = {
    view: "today",     // "today" = 今日单词视图, "all" = 全部单词视图
    filter: "all",     // 全部单词视图的筛选
    sort: "time",      // 全部单词视图的排序
    asc: false,        // 是否升序
    expanded: null     // 当前展开的单词
  };

  var swipe = null;
  var suppressClick = false;
  var menuEl = null;
  var menuWord = null;

  /* ==========================================================================
   * 3. 工具函数
   * ========================================================================== */

  function esc(text) {
    return String(text === undefined || text === null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function tip(message) {
    if (typeof toast === "function") toast(message);
  }

  function getBox() {
    return (typeof document !== "undefined") ? document.getElementById("vocabBookBody") : null;
  }

  function fmtTime(ts) {
    var n = Number(ts);
    if (!n) return "—";
    var d = new Date(n);
    var p = function (v) { return String(v).padStart(2, "0"); };
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function fmtNextReview(item) {
    if (item.status === "mastered") return "已掌握，不再安排";
    if (item.nextReviewDate) return item.nextReviewDate;
    return "—";
  }

  function freqRank(word) {
    var list = (typeof FREQUENCY_WORDS !== "undefined") ? FREQUENCY_WORDS : null;
    if (Array.isArray(list)) {
      var key = String(word || "").toLowerCase();
      for (var i = 0; i < list.length; i++) {
        var w = list[i];
        var name = (typeof w === "string") ? w : (w && w.word);
        if (String(name || "").toLowerCase() === key) return i;
      }
    }
    return Number.MAX_SAFE_INTEGER;
  }

  /** 获取今天的 "YYYY-MM-DD" */
  function vbToday() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  /* ==========================================================================
   * 4. 取数
   * ========================================================================== */

  /** 获取今日单词池（从 WordPool.generateDailyPool 取，fallback 到 VocabBook） */
  function getTodayPool() {
    if (typeof WordPool !== "undefined" && WordPool.generateDailyPool) {
      var pool = WordPool.generateDailyPool(vbToday());
      return {
        newWords: pool.newWords || [],
        reviewWords: pool.reviewWords || [],
        standbyWords: pool.standbyWords || []
      };
    }
    // fallback：没有 WordPool 时直接从 VocabBook 取
    if (typeof VocabBook !== "undefined") {
      var due = VocabBook.getDueWords(vbToday());
      return { newWords: [], reviewWords: due.slice(0, 10), standbyWords: due.slice(10) };
    }
    return { newWords: [], reviewWords: [], standbyWords: [] };
  }

  /** 全部单词视图：筛选 + 排序 */
  function getVisibleWords() {
    if (typeof VocabBook === "undefined") return [];
    var list = VocabBook.getAllWords() || [];

    var filter = FILTERS.filter(function (f) { return f.key === state.filter; })[0];
    if (filter && filter.statuses) {
      list = list.filter(function (item) { return filter.statuses.indexOf(item.status) >= 0; });
    }

    var dir = state.asc ? 1 : -1;
    var natural = (state.sort === "freq") ? -1 : 1;
    list.sort(function (a, b) {
      if (state.sort === "freq") {
        var ra = freqRank(a.word);
        var rb = freqRank(b.word);
        if (ra !== rb) return (ra - rb) * dir * natural;
        return (Number(a.addedAt) - Number(b.addedAt)) * dir;
      }
      return (Number(a.addedAt) - Number(b.addedAt)) * dir;
    });

    return list;
  }

  /* ==========================================================================
   * 5. 渲染
   * ========================================================================== */

  /** 顶部统计栏 */
  function renderStats(stats) {
    return '<div class="vb-stats">' +
      '<div class="vb-stats-left">共 <b>' + stats.total + '</b> 词 · 已掌握 <b>' + stats.mastered + "</b></div>" +
      '<div class="vb-stats-right">' +
        '<svg class="vb-cal" viewBox="0 0 16 16" aria-hidden="true">' +
          '<rect x="1.5" y="3" width="13" height="11.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
          '<path d="M1.5 6.5h13M5 1.5v3M11 1.5v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
        "</svg>" +
        "今日待复习 <b>" + stats.dueCount + "</b>" +
      "</div>" +
      "</div>";
  }

  /** 视图切换栏 */
  function renderViewTabs() {
    return '<div class="vb-view-tabs">' +
      '<button class="vb-view-tab' + (state.view === "today" ? " active" : "") + '" data-view="today">今日单词</button>' +
      '<button class="vb-view-tab' + (state.view === "all" ? " active" : "") + '" data-view="all">全部单词</button>' +
      "</div>";
  }

  /** 全部单词视图的筛选/排序栏 */
  function renderFilters() {
    var chips = FILTERS.map(function (f) {
      var active = f.key === state.filter ? " active" : "";
      return '<button class="vb-chip' + active + '" data-filter="' + f.key + '">' + f.label + "</button>";
    }).join("");

    var sorts = SORTS.map(function (s) {
      var active = s.key === state.sort ? " active" : "";
      var arrow = state.asc ? "↑" : "↓";
      return '<button class="vb-sort' + active + '" data-sort="' + s.key + '">' +
        s.label + (active ? ' <span class="vb-arrow">' + arrow + "</span>" : " ⇅") + "</button>";
    }).join("");

    return '<div class="vb-filterbar">' +
      '<div class="vb-chips">' + chips + "</div>" +
      '<div class="vb-sorts">' + sorts + "</div>" +
      "</div>";
  }

  /** 记忆进度条（四档） */
  function renderDots(status) {
    var idx = STATUS_ORDER.indexOf(status);
    var cur = idx < 0 ? 0 : idx;
    return '<div class="vb-progress"><div class="vb-dots">' +
      STATUS_ORDER.map(function (s, i) {
        var cls = "vb-dot " + (i < cur ? "done " : "") + (i === cur ? "cur " + STATUS_META[s].cls : "");
        return '<span class="' + cls + '" title="' + STATUS_META[s].label + '"></span>';
      }).join("") +
      '</div><span class="vb-progress-tip">' + STATUS_META[status].label +
      "（第 " + (cur + 1) + " / 4 阶）" + "</span></div>";
  }

  /** 单张卡片 */
  function renderCard(item, compact) {
    var meta = STATUS_META[item.status] || STATUS_META["new"];
    var expanded = state.expanded === item.word;
    var word = esc(item.word);

    var detail = expanded
      ? '<div class="vb-detail">' +
          '<div class="vb-detail-row"><span>添加时间</span><b>' + fmtTime(item.addedAt) + "</b></div>" +
          '<div class="vb-detail-row"><span>复习次数</span><b>' + (Number(item.reviewCount) || 0) + " 次</b></div>" +
          '<div class="vb-detail-row"><span>下次复习</span><b>' + fmtNextReview(item) + "</b></div>" +
          renderDots(item.status) +
          '<div class="vb-actions">' +
            '<button class="vb-btn no" data-review="0" data-word="' + word + '">不认识</button>' +
            '<button class="vb-btn yes" data-review="1" data-word="' + word + '">认识</button>' +
          "</div>" +
        "</div>"
      : "";

    var compactCls = compact ? " compact" : "";
    return '<div class="vb-card' + (expanded ? " expanded" : "") + compactCls + '" data-word="' + word + '">' +
      '<div class="vb-card-inner">' +
        '<div class="vb-main">' +
          '<div class="vb-left">' +
            '<div class="vb-word-row">' +
              '<b class="vb-word">' + word + "</b>" +
              (item.phonetic ? '<span class="vb-phonetic">' + esc(item.phonetic) + "</span>" : "") +
              (item.pos ? '<span class="vb-pos">' + esc(item.pos) + "</span>" : "") +
            "</div>" +
            '<div class="vb-meaning">' + esc(item.meaning || "（暂无释义）") + "</div>" +
          "</div>" +
          '<div class="vb-right">' +
            '<span class="vb-status ' + meta.cls + '">' + meta.label + "</span>" +
            '<button class="vb-more" data-more="' + word + '" aria-label="更多操作">⋯</button>' +
          "</div>" +
        "</div>" +
        detail +
      "</div>" +
      '<button class="vb-del" data-del="' + word + '">删除</button>' +
      "</div>";
  }

  /** 今日单词视图：三个区块 */
  function renderTodayView(pool) {
    var newHtml = pool.newWords.length
      ? pool.newWords.map(function (w) { return renderCard(w); }).join("")
      : '<p class="vb-section-empty">今天没有新词</p>';
    var revHtml = pool.reviewWords.length
      ? pool.reviewWords.map(function (w) { return renderCard(w); }).join("")
      : '<p class="vb-section-empty">今天没有复习词</p>';
    var sbHtml = pool.standbyWords.length
      ? pool.standbyWords.map(function (w) { return renderCard(w, true); }).join("")
      : '<p class="vb-section-empty">没有候补词</p>';

    return '<div class="vb-today">' +
      '<div class="vb-section"><h3 class="vb-section-title">🟦 今日新学（' + pool.newWords.length + "）</h3>" + newHtml + "</div>" +
      '<div class="vb-section"><h3 class="vb-section-title">🟩 今日复习（' + pool.reviewWords.length + "）</h3>" + revHtml + "</div>" +
      '<div class="vb-section"><h3 class="vb-section-title">⬜ 候补复习（' + pool.standbyWords.length + "）</h3>" + sbHtml + "</div>" +
      "</div>";
  }

  /** 空状态 */
  function renderEmpty() {
    return '<div class="vb-empty">' +
      '<svg viewBox="0 0 120 88" width="120" height="88" aria-hidden="true">' +
        '<ellipse cx="60" cy="76" rx="42" ry="5" fill="#eef2f7"/>' +
        '<path d="M14 30c14-6 26-6 46 2 20-8 32-8 46-2v34c-14-6-26-6-46 2-20-8-32-8-46-2V30z" fill="#fff" stroke="#c7d2fe" stroke-width="2"/>' +
        '<path d="M60 32v34" stroke="#c7d2fe" stroke-width="2"/>' +
        '<path d="M24 40h22M24 48h20M74 40h22M74 48h20" stroke="#dbeafe" stroke-width="3" stroke-linecap="round"/>' +
        '<circle cx="88" cy="24" r="12" fill="#2563eb"/>' +
        '<path d="M88 18v12M82 24h12" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>' +
      "</svg>" +
      '<p class="vb-empty-text">还没有收藏单词，长按新闻里的单词试试吧</p>' +
      "</div>";
  }

  /** 主渲染函数 */
  function render() {
    var box = getBox();
    if (!box || typeof VocabBook === "undefined") return;

    var stats = VocabBook.getStats();
    var body = "";

    if (state.view === "today") {
      var pool = getTodayPool();
      body = renderTodayView(pool);
    } else {
      var list = getVisibleWords();
      if (state.expanded && !list.some(function (item) { return item.word === state.expanded; })) {
        state.expanded = null;
      }
      body = renderFilters() +
        '<div class="vb-list">' +
        (list.length ? list.map(function (w) { return renderCard(w); }).join("") : renderEmpty()) +
        "</div>";
    }

    box.innerHTML = renderStats(stats) + renderViewTabs() + body;
  }

  /* ==========================================================================
   * 6. 交互
   * ========================================================================== */

  function toggleCard(word) {
    state.expanded = (state.expanded === word) ? null : word;
    render();
  }

  function applyView(view) {
    if (view === state.view) return;
    state.view = view;
    state.expanded = null;
    render();
  }

  function applyFilter(key) {
    if (!key) return;
    state.filter = key;
    render();
  }

  function applySort(key) {
    if (!key) return;
    if (state.sort === key) state.asc = !state.asc;
    else { state.sort = key; state.asc = false; }
    render();
  }

  function review(word, correct) {
    if (typeof VocabBook === "undefined") return;
    var before = VocabBook.getWord(word);
    // V2: updateWordStatus(word, reactionMs, correct) — 手动操作默认中速
    var after = VocabBook.updateWordStatus(word, correct);
    if (!after) { tip("这个单词已经不在单词本里了"); return; }
    tip((correct ? "记住了：" : "再记一次：") + word +
      "（" + STATUS_META[before.status].label + " → " + STATUS_META[after.status].label + "）");
    if (after.status === "mastered" && before.status !== "mastered") {
      celebrate(word);
    }
  }

  function celebrate(word) {
    var box = getBox();
    if (!box) return;
    var card = box.querySelector('.vb-card[data-word="' + word + '"]');
    if (!card) return;
    var tag = card.querySelector(".vb-status");
    if (tag) {
      tag.classList.add("celebrate");
      setTimeout(function () { tag.classList.remove("celebrate"); }, 1000);
    }
    var icons = ["🎉", "✨", "🎊", "👏", "🍊", "⭐"];
    for (var i = 0; i < 8; i++) {
      var piece = document.createElement("span");
      piece.className = "vb-confetti";
      piece.textContent = icons[i % icons.length];
      piece.style.left = (8 + i * 11) + "%";
      piece.style.animationDelay = (i * 40) + "ms";
      card.appendChild(piece);
    }
    setTimeout(function () {
      var left = card.querySelectorAll(".vb-confetti");
      Array.prototype.forEach.call(left, function (el) {
        if (el.parentNode) el.parentNode.removeChild(el);
      });
    }, 1200);
  }

  function getMenu() {
    if (menuEl) return menuEl;
    if (typeof document === "undefined" || !document.createElement) return null;
    menuEl = document.createElement("div");
    menuEl.className = "vb-menu";
    menuEl.id = "vbMenu";
    if (document.body) document.body.appendChild(menuEl);
    return menuEl;
  }

  function closeMenu() {
    menuWord = null;
    if (menuEl && menuEl.classList) menuEl.classList.remove("show");
  }

  function openMenu(word, anchor) {
    var menu = getMenu();
    if (!menu) return;
    var inMastered = (typeof VocabBook !== "undefined") &&
      (VocabBook.getWord(word) || {}).status === "mastered";
    menu.innerHTML =
      '<button class="vb-menu-item" data-act="master"' + (inMastered ? " disabled" : "") + '>✅ 标记已掌握</button>' +
      '<button class="vb-menu-item danger" data-act="remove">🗑 从单词本移除</button>';
    menu.setAttribute("data-word", word);
    menuWord = word;
    menu.classList.add("show");
    var rect = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : null;
    if (rect) {
      var mw = menu.offsetWidth || 140;
      var mh = menu.offsetHeight || 90;
      var left = rect.right - mw;
      var top = rect.bottom + 6;
      if (left < 8) left = 8;
      if (left + mw > window.innerWidth - 8) left = window.innerWidth - 8 - mw;
      if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
      menu.style.left = left + "px";
      menu.style.top = top + "px";
    } else {
      menu.style.left = "50%";
      menu.style.top = "40%";
    }
  }

  function handleMenuAction(action, word) {
    closeMenu();
    if (typeof VocabBook === "undefined" || !word) return;
    if (action === "master") {
      var after = VocabBook.setStatus(word, "mastered");
      if (!after) { tip("这个单词已经不在单词本里了"); return; }
      tip("已标记为掌握：" + word);
      celebrate(word);
      return;
    }
    if (action === "remove") { confirmRemove(word); }
  }

  function confirmRemove(word) {
    if (typeof window === "undefined" || typeof window.confirm !== "function") {
      removeWord(word);
      return;
    }
    if (window.confirm("确定从单词本移除吗？")) removeWord(word);
  }

  function removeWord(word) {
    if (typeof VocabBook === "undefined") return;
    if (!VocabBook.removeWord(word)) { tip("这个单词已经不在单词本里了"); return; }
    if (state.expanded === word) state.expanded = null;
    tip("已从单词本移除：" + word);
    render();
    if (typeof markVocabElements === "function") markVocabElements(word, false);
  }

  /* ---------- 左滑删除 ---------- */

  function closeSwiped(except) {
    var box = getBox();
    if (!box) return;
    var cards = box.querySelectorAll(".vb-card.swiped");
    Array.prototype.forEach.call(cards, function (card) {
      if (card === except) return;
      card.classList.remove("swiped");
      var inner = card.querySelector(".vb-card-inner");
      if (inner) inner.style.transform = "";
    });
  }

  function calcTranslate(base, dx) {
    var x = base + dx;
    if (x > 0) x = x * 0.2;
    if (x < -DELETE_WIDTH) x = -DELETE_WIDTH + (x + DELETE_WIDTH) * 0.25;
    return x;
  }

  function onSwipeStart(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (target.closest(".vb-more") || target.closest(".vb-del") || target.closest("[data-review]")) return;
    var card = target.closest(".vb-card");
    if (!card) return;
    var inner = card.querySelector(".vb-card-inner");
    if (!inner) return;
    swipe = {
      card: card, inner: inner,
      x: event.clientX, y: event.clientY,
      locked: false,
      opened: card.classList.contains("swiped"),
      width: card.offsetWidth || 300
    };
    inner.style.transition = "none";
    closeSwiped(card);
  }

  function onSwipeMove(event) {
    if (!swipe) return;
    var dx = event.clientX - swipe.x;
    var dy = event.clientY - swipe.y;
    if (!swipe.locked) {
      if (Math.abs(dx) > SWIPE_LOCK_PX && Math.abs(dx) > Math.abs(dy)) { swipe.locked = true; }
      else if (Math.abs(dy) > SWIPE_LOCK_PX) { swipe = null; return; }
      else { return; }
    }
    var base = swipe.opened ? -DELETE_WIDTH : 0;
    swipe.inner.style.transform = "translateX(" + calcTranslate(base, dx) + "px)";
  }

  function onSwipeEnd(event) {
    if (!swipe) return;
    var s = swipe;
    swipe = null;
    if (!s.locked) { s.inner.style.transition = ""; return; }
    var dx = (event && typeof event.clientX === "number") ? (event.clientX - s.x) : 0;
    var threshold = (s.width || 300) / 3;
    var open;
    if (s.opened) open = !(dx > threshold);
    else open = (-dx) > threshold;
    s.inner.style.transition = "transform .22s ease";
    s.inner.style.transform = open ? "translateX(-" + DELETE_WIDTH + "px)" : "translateX(0)";
    if (open) s.card.classList.add("swiped");
    else s.card.classList.remove("swiped");
    suppressClick = true;
    setTimeout(function () { suppressClick = false; }, 60);
  }

  /* ==========================================================================
   * 7. 事件绑定与初始化
   * ========================================================================== */

  function bindEvents() {
    var box = getBox();
    if (!box || typeof document === "undefined") return;

    box.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      if (suppressClick) {
        var onCardBody = target.closest(".vb-card") &&
          !target.closest("[data-del]") && !target.closest(".vb-more") && !target.closest("[data-review]");
        if (onCardBody) return;
      }

      var delBtn = target.closest("[data-del]");
      if (delBtn) { confirmRemove(delBtn.getAttribute("data-del")); return; }

      var moreBtn = target.closest("[data-more]");
      if (moreBtn) {
        var word = moreBtn.getAttribute("data-more");
        if (menuWord === word && menuEl && menuEl.classList.contains("show")) closeMenu();
        else openMenu(word, moreBtn);
        return;
      }

      var reviewBtn = target.closest("[data-review]");
      if (reviewBtn) {
        review(reviewBtn.getAttribute("data-word"), reviewBtn.getAttribute("data-review") === "1");
        return;
      }

      // 视图切换
      var viewTab = target.closest(".vb-view-tab");
      if (viewTab) { applyView(viewTab.getAttribute("data-view")); return; }

      var chip = target.closest(".vb-chip");
      if (chip) { applyFilter(chip.getAttribute("data-filter")); return; }

      var sortBtn = target.closest(".vb-sort");
      if (sortBtn) { applySort(sortBtn.getAttribute("data-sort")); return; }

      var card = target.closest(".vb-card");
      if (card) { toggleCard(card.getAttribute("data-word")); return; }
    });

    if (typeof window !== "undefined" && typeof window.PointerEvent === "function") {
      box.addEventListener("pointerdown", onSwipeStart);
      box.addEventListener("pointermove", onSwipeMove);
      box.addEventListener("pointerup", onSwipeEnd);
      box.addEventListener("pointercancel", onSwipeEnd);
    }

    document.addEventListener("click", function (event) {
      var target = event.target;
      var menuItem = (target && target.closest) ? target.closest(".vb-menu-item") : null;
      if (menuItem) {
        if (menuItem.disabled) return;
        handleMenuAction(menuItem.getAttribute("data-act"), menuEl ? menuEl.getAttribute("data-word") : null);
        return;
      }
      if (!menuEl || !menuEl.classList.contains("show")) return;
      if (target && target.closest && target.closest(".vb-menu")) return;
      if (target && target.closest && target.closest(".vb-more")) return;
      closeMenu();
    });

    window.addEventListener("scroll", function () { closeMenu(); closeSwiped(null); }, { passive: true });
  }

  function init() {
    bindEvents();
    if (typeof VocabBook !== "undefined" && VocabBook.subscribe) {
      VocabBook.subscribe(function () { render(); });
    }
    render();
  }

  /* ==========================================================================
   * 8. 对外 API
   * ========================================================================== */

  return {
    init: init,
    render: render,
    toggleCard: toggleCard,
    review: review,
    removeWord: removeWord,
    confirmRemove: confirmRemove,
    handleMenuAction: handleMenuAction,
    openMenu: openMenu,
    closeMenu: closeMenu,
    onSwipeStart: onSwipeStart,
    onSwipeMove: onSwipeMove,
    onSwipeEnd: onSwipeEnd,
    getVisibleWords: getVisibleWords,
    getTodayPool: getTodayPool,
    getState: function () { return { view: state.view, filter: state.filter, sort: state.sort, asc: state.asc, expanded: state.expanded }; },
    setFilter: applyFilter,
    setSort: applySort,
    setView: applyView
  };
})();

if (typeof window !== "undefined") {
  window.VocabBookUI = VocabBookUI;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = VocabBookUI;
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", function () { VocabBookUI.init(); });
}
