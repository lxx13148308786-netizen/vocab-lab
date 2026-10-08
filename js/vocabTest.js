/**
 * vocabTest.js
 * AI 新闻背单词 H5 应用 —— 单词量测试 + 批量导入生词
 *
 * 功能：
 *   1. 单词量测试：20 道四选一（英文单词 → 选中文释义），**自适应出题**（adaptive-v1），
 *      题目随作答结果在 10 个难度层之间上/下移动，集中在用户真实水平附近，
 *      再用「正确率50% 临界层 + 线性插值」估算词汇量（结果页含误差范围与位置可视化）。
 *      每题 1 正确 + 3 干扰（同层同词性优先）。
 *   2. 批量导入生词：入口 A（测试结果页一键导入答错的词）、入口 B（单词本页手动粘贴导入）。
 *
 * 设计原则：
 *   - 纯原生 JS，事件全部用事件委托（容器会被整体重绘，绑死在元素上会失效）。
 *   - 测试页是「独立全屏 overlay」，打开时盖住首页与底部栏，返回即恢复。
 *   - 数据走 localStorage，key 统一前缀 "anv_"；
 *   - 不破坏现有功能：查词 / 长按收藏 / 底部 Tab / 单词本 全部保持原样。
 *
 * 对外：全局对象 VocabTest
 *   - init()  初始化（绑定按钮 + 委托事件 + 渲染首页词汇量行）
 *   - open()  打开测试页（重置状态、重新抽题）
 *   - close() 关闭测试页（不保存未完成的结果）
 *   - _test   自测内部接口（computeScore / advanceLayer / parseBatchText 等）
 *
 * 依赖：WORD_BANK（词库）、VocabBook（数据层）、app.js 的 toast/renderVocabBookSection
 *       （可选，缺失时静默降级）
 */

const VocabTest = (function () {

  /* ==========================================================================
   * 1. 常量
   * ========================================================================== */

  /** 题目总数 */
  const TEST_TOTAL = 20;

  /* ==========================================================================
     自适应出题常量（algorithm: adaptive-v1）
     ------------------------------------------------------------------------
     旧版是「5 个层级各抽 4 题」的固定分层抽样，每层只有 3-4 道题，
     抽样分布与用户真实水平无关 —— 真实词汇量 6000 的用户测出 9100 就是这么来的。
     根因不是公式错，而是【每层的样本量太小且分布不合理】：
     一个只在第 3 层有区分度的人，如果第 4/5 层蒙对 2 题就会被抬到高分区。

     自适应版把题目集中到用户真实水平附近：
     答对就往难走、答错往简单走，20 题里反复逼近临界层，
     这样「正确率恰好 50% 的那一层」才会被真正测出来。
     ========================================================================== */

  /** 算法版本号，写进测试结果。改算法逻辑时必须同步升版本，
   *  否则新旧结果混在一起无法区分（loadResult 靠它决定展示方式）。 */
  const ALGORITHM_VERSION = "adaptive-v1";
  /** 难度层数（1-10） */
  const LAYER_COUNT = 10;
  /** 每层代表的词汇量宽度。第 N 层 ≈ [ (N-1)*LAYER_SPAN, N*LAYER_SPAN ) 词 */
  const LAYER_SPAN = 1000;
  /** 各层上界（词频排名，越小越简单）。索引 0 = 第 1 层上界 = 1000。
   *  这些边界写在常量里方便调参：改这里就改了整套难度切分。 */
  const LAYER_BOUNDS = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 12000];
  /** 各层对应的「词汇量代表值」，用于插值与结果页位置条。
   *  第 N 层的中点= (上界+下界)/2，取整到百位。 */
  const LAYER_VOCAB = LAYER_BOUNDS.map(function (upper, i) {
    const lower = i === 0 ? 0 : LAYER_BOUNDS[i - 1];
    return Math.round(((upper + lower) / 2) / 100) * 100;
  });
  /** 第一题从第几层开始（4000-5000 词，中等难度）。
   *  从中间起步比从第 1 层连爬 10 层更快收敛，也比直接上第 10 层不容易劝退。 */
  const START_LAYER = 5;
  /** 难度调整步长（层数，可为小数）。 */
  const STEP_CORRECT = 1;      // 答对 → 下一题更难
  const STEP_WRONG = -1;       // 答错 → 下一题更简单
  const STEP_UNKNOWN = -1.5;   // 「不认识」→ 降得比答错更多。
   //  理由：答错可能是「认识但记混了释义」，不认识是主动确认「压根不会」，
   //  后者是更确定的信号，应该更快往简单区走。
  /** 连续多少题停在同一层就锁定难度（不再上下跳）。
   *  连续 3 题同层说明已经逼近真实水平，再跳只是噪声。 */
  const STABLE_THRESHOLD = 3;
  /** 每层正确率的权重：答对 +1、答错 0、不认识 -0.3。
   *  不认识给负分（而不是 0），因为「不认识」比「答错」更明确地表示不会 ——
   *  答错至少说明见过这个词。0.3 是经验值：略小于「答错的一半」。 */
  const W_CORRECT = 1;
  const W_WRONG = 0;
  const W_UNKNOWN = -0.3;
  /** 目标正确率（插值找的是这一条线） */
  const TARGET_RATE = 0.5;
  /** 估算结果的误差范围（±）。写进结果页文案与 localStorage。 */
  const ERROR_MARGIN = 500;
  /** 估算上限 / 下限（用于「全对 / 全错」的兜底与位置条量程） */
  const VOCAB_MAX = 12000;
  const VOCAB_MIN = 500;

  /** 层级中文名（柱状图 / 提示用）。10 层各有一个名字，缺省回退到「第N层」。 */
  const LEVEL_NAMES = {
    1: "入门", 2: "基础", 3: "起步", 4: "进阶", 5: "中级",
    6: "中高级", 7: "高级", 8: "熟练", 9: "流利", 10: "精通"
  };
  /** 测试结果持久化 key（anv_ 前缀） */
  const STORAGE_KEY = "anv_vocabTestResult";
  /** 答对后停留（ms），随后自动跳下一题 */
  const DELAY_CORRECT = 800;
  /** 答错后停留更久（ms），让用户看清正确答案 */
  const DELAY_WRONG = 1200;
  /** 点了「不认识」后停留（ms）。
   *  比 DELAY_CORRECT 长、比 DELAY_WRONG 短：没有正确答案要核对，
   *  但用户点它时往往还在犹豫，闪太快会让人以为没点上。 */
  const DELAY_UNKNOWN = 1000;
    /** 导入来源标记 */
    const SRC_TEST = "vocab_test";
    const SRC_MANUAL = "manual_import";
    /** 从内置词典导入的来源标记（需求：便于日后区分词从哪来） */
    const SRC_DICT = "builtin_dict";
    /** 今日内容包的持久化 key。与 app.js 的 STORAGE_KEYS.pack 一致，
        这里单独立一个常量而不用 STORAGE_KEY（那个已被测试结果占用）。 */
    const STORAGE_KEY_PACK = "ainv:dailyPack";
/** 今日新词目标数，与 wordpool.js 的 DAILY_NEW_LIMIT 保持一致 */
  const DAILY_NEW_TARGET = 10;

  /**
   * 「不认识」在 state.answered 里的哨兵值。
   * 正常答案是 0~3 的选项下标，用 -1 表示"这道题不认识"（没选任何选项）。
   * 选哨兵值而不是另开一个 unknown 集合：answered 已经是"每题一个状态"的
   * 单一数据源，回退/进度条/判分都只认它，多开一个集合必然漏同步。
   */
  const ANSWER_UNKNOWN = -1;

  /* 注：旧版的 UNKNOWN_CREDIT（未知词折算 0.1 分）已随 adaptive-v1 废弃。
     新算法改用 W_UNKNOWN（-0.3），语义从「未知词里有一部分其实会」
     变成「不认识是主动确认不会，比答错更确定地表示不会」。
     两者方向相反、不存在过渡价值，所以常量直接删掉而不是留着用。 */

  /**
   * 快捷键 → 选项下标。
   * 需求说「原来 1-4 对应四个选项，空格 = 不认识」，但实测本项目此前
   * 并没有任何键盘绑定，所以 1-4 与空格都是这次一并新建的。
   * 空格单独处理（见 bindKeys）：它不在这个表里，因为 e.key === " "，
   * 而选项键用 e.key 字符串比对更稳（比 keyCode 兼容布局）。
   */
  const KEY_OPTION_MAP = { "1": 0, "2": 1, "3": 2, "4": 3 };

  /* ==========================================================================
   * 2. 内部状态
   * ========================================================================== */

  const state = {
    questions: [],     // 已生成且已作答的题目（每题一个对象，含 level / targetLayer / word / options）
    index: 0,          // 当前题号（0 基）
    answered: {},      // { 题号: 选项下标 }；值为 ANSWER_UNKNOWN(-1) 表示点了「不认识」
    finished: false,   // 是否已答完
    result: null,      // 计算结果（含 score / levelDetails / wrongWords / 三项计数）
    imported: false,   // 结果页是否已执行过导入
    importedMsg: "",   // 导入结果提示

    /* --- 自适应出题（adaptive-v1）的运行时状态 --- */
    byLayer: null,     // 分层词库缓存 { 1:[], ... 10:[] }
    bank: null,        // 词库缓存（避免每题都getBank()）
    rng: null,         // 随机源。生产环境为 null → 走 Math.random；
                       // 自测注入确定性函数后可复现整条题目序列
    usedWords: {},     // 已出过的题干词word → true（20 题内不重复）
    curLayer: START_LAYER, // 当前难度层（下一题要出的层）
    sameStreak: 0,     // 已连续停在同一层的题数
    locked: false,     // 是否已锁定难度（连续 STABLE_THRESHOLD 题同层后为 true）
    history: [],       // 逐题记录 { qIndex, level, targetLayer, word, outcome }
    degraded: false,   // 题库降级：testBank.json 加载失败、正用 WORD_BANK 小词库出题
    pageToken: 0       // 本次 open 的令牌。await 加载题库期间用户可能已离开/重开，
                       // 回来后要能识别「我这次open 已经被作废了」并放弃渲染
  };

  /** 初始化守卫（防止 DOMContentLoaded 与手动调用重复绑定） */
  let inited = false;
  /** 计时器句柄（关闭/重开时清掉，避免旧定时器把页面切走） */
  let advanceTimer = null;

  /* ==========================================================================
   * 3. 小工具
   * ========================================================================== */

  /** 转义 HTML，防止释义里出现尖括号被当成标签 */
  function esc(text) {
    return String(text === undefined || text === null ? "" : text)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** 轻提示：复用 app.js 的 toast，没有就静默（本模块可独立跑测试） */
  function tip(message) {
    if (typeof toast === "function") toast(message);
  }

  /**
 * 取词库
 *
 * 【为什么不再直接用 WORD_BANK】
 * 旧词库只有 60 个词，摊到 10 层后第 8 层只剩 1 个 —— 自适应算法在一层停留
 * 3 题（STABLE_THRESHOLD）就会把该层抽空，实测 20 题里有 11 题是「借邻层的词」，
 * 难度梯度形同虚设。
 * 现在的主源是 data/testBank.json（10 层 × 120 词，基于真实词频排名分层），
 * 由 loadTestBank() 异步加载后缓存到 testBankCache。
 *
 * 降级顺序：
 *   1. testBankCache（已加载的新题库）
 *   2. WORD_BANK（js/wordbank.js，保留兼容万一别处在用）
 *   3. 空数组（由 open() 的 loading 态拦住，不会带着空题库开测）
 *
 * 注意：getBank() 是**同步**的，而 fetch 是异步的 —— 所以 open() 必须
 * 先 await loadTestBank() 再出题。这是本轮改造对调用方唯一的破坏性变更。
 */
function getBank() {
  if (testBankCache && testBankCache.length) return testBankCache;
  return (typeof WORD_BANK !== "undefined") ? WORD_BANK : [];
}

/**
 * 加载 data/testBank.json（自适应测试题库）
 *
 * 格式：{ version, layers: [[词,...], ...10层], meta: {...} }
 * 词条：{ word, pos, meaning, rank, layer }
 *
 * 用相对路径 "data/testBank.json" 而非绝对路径 —— 与 loadBuiltinDict 一致，
 * 部署到子目录不会 404。
 *
 * @param {boolean} [force] 忽略缓存强制重新拉（SW 更新后调试用）
 * @returns {Promise<Array>} 扁平化的词数组；失败时 reject，由调用方决定降级
 */
function loadTestBank(force) {
  if (!force && testBankPromise) return testBankPromise;

  testBankPromise = fetch(TEST_BANK_URL)
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (json) {
      const layers = json && json.layers;
      if (!Array.isArray(layers) || !layers.length) {
        throw new Error("testBank.json 缺少 layers 字段");
      }
      // 拍平 10 层。词条的 layer 字段优先（构建期已算好），
      // 缺失时按 rank 现算 —— 这样即使 JSON 是手改的也能正常工作。
      const bank = [];
      layers.forEach(function (arr, i) {
        if (!Array.isArray(arr)) return;
        arr.forEach(function (w) {
          if (!w || !w.word || !w.meaning) return;
          bank.push({
            word: w.word,
            pos: w.pos || "",
            meaning: w.meaning,
            rank: Number(w.rank) || 0,
            layer: Number(w.layer) || (i + 1)
          });
        });
      });
      if (!bank.length) throw new Error("testBank.json 里没有可用词条");
      testBankCache = bank;
      testBankMeta = json.meta || {};
      console.log("[vocabTest] 题库已加载：" + bank.length + " 词 / " +
                  layers.length + " 层");
      return bank;
    })
    .catch(function (err) {
      // 清掉缓存的 Promise，否则一次失败后永远重试不了（每次 open 都立刻 reject）
      testBankPromise = null;
      console.warn("[vocabTest] 题库加载失败，回退到内置小词库：", err && err.message);
      throw err;
    });

  return testBankPromise;
}

  /** 取 localStorage（隐私模式拿不到时返回 null，不让页面崩） */
  function getStorage() {
    try {
      if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    } catch (e) { /* ignore */ }
    return null;
  }

  /** 今天的日期字符串 "YYYY-MM-DD"；app.js 有现成 getTodayStr 就用它 */
  function todayStr() {
    if (typeof getTodayStr === "function") return getTodayStr();
    const d = new Date();
    const p = function (v) { return String(v).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /**
   * 词频排名 → 难度层（1-10）
   * @param {number} rank 词频排名（1 =最高频 = 最简单）
   * @returns {number} 1-10
   */
  function levelOf(rank) {
    const r = Number(rank) || 0;
    for (let i = 0; i < LAYER_BOUNDS.length; i++) {
      if (r <= LAYER_BOUNDS[i]) return i + 1;
    }
    return LAYER_COUNT;
  }

  /** Fisher–Yates 洗牌（返回新数组，不改原数组） */
  function shuffle(arr, rng) {
    rng = rng || Math.random;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* 注：旧版的 sample(arr, n, rng)（一次抽 n 个）也已随之废弃 ——
     自适应出题一次只要1 个词，且必须「只从未用过的里抽」，
     抽样职责已并入 pickWordForLayer。 */

  /* ==========================================================================
   * 4. 抽题逻辑（自适应，adaptive-v1）
   * ========================================================================== */

  /**
   * 把词库按难度层分组（1-10）
   * @param {Array} bank
   * @returns {Object} { 1: [...], 2: [...], ... }，每层内部按 rank 升序（简单→难）
   */
  function groupByLevel(bank) {
    const byLevel = {};
    for (let lv = 1; lv <= LAYER_COUNT; lv++) byLevel[lv] = [];
    (bank || []).forEach(function (w) {
      const lv = levelOf(w.rank);
      if (byLevel[lv]) byLevel[lv].push(w);
    });
    return byLevel;
  }

  /**
   * 从某层抽 1 个尚未出过的词
   *
   * 为什么要「同层抽不到就借邻层」：
   * 真实词库 WORD_BANK 只有 60 个词，摊到 10 层后第 8 层只有 1 个词 ——
   * 自适应算法一旦在某一层停留3 题（STABLE_THRESHOLD）就会把这一层抽空。
   * 借邻层的词时，**题目难度以借来的词的真实层为准**（记进 q.level），
   * 不强行标成目标层 —— 否则估算公式会拿一个简单词的作答结果去代表难层的水平，
   * 系统性高估。
   *
   * @param {Object} byLevel 分层词库
   * @param {number} lv 目标层
   * @param {Object} used 已出过的 word 集合（会被就地写入）
   * @param {Function} rng 随机源
   * @returns {Object|null} 词对象；全库都出完了返回 null
   */
  function pickWordForLayer(byLevel, lv, used, rng) {
    function firstUnused(pool) {
      const avail = pool.filter(function (w) { return !used[w.word]; });
      return avail.length ? avail[Math.floor(rng() * avail.length)] : null;
    }
    const direct = firstUnused(byLevel[lv] || []);
    if (direct) return direct;

    // 本层空了 → 从最近的邻层借（同侧最近优先）。
    //
    // 【坑】lv 可能是小数（STEP_UNKNOWN = -1.5 会产生 3.5 这种半层）。
    // 如果直接用整数偏移（lv-1, lv+1, ...），3.5 算出来是 2.5 / 4.5 ——
    // 这些层号在 byLevel 里根本不存在，一层层借下去要撞到很远才能命中，
    // 表现为「难度明明降了但出的题还是同一层」。
    // 正解：先把 lv 吸附到最近的整数层，再向两侧借。
    const base = Math.max(1, Math.min(LAYER_COUNT, Math.round(lv)));
    const offsets = [];
    for (let d = 1; d < LAYER_COUNT; d++) { offsets.push(-d, d); }
    for (let k = 0; k < offsets.length; k++) {
      const nb = base + offsets[k];
      if (nb < 1 || nb > LAYER_COUNT) continue;
      const got = firstUnused(byLevel[nb] || []);
      if (got) return got;
    }
    return null;   // 全库都出完了
  }

  /**
   * 构造一道自适应题目（1 正确 + 3 干扰）
   *
   * @param {Array} bank 词库
   * @param {Object} byLevel 分层词库（内部维护 used 集合）
   * @param {number} lv 目标难度层
   * @param {Object} used 已出过的 word 集合（就地写入）
   * @param {Function} rng
   * @returns {Object|null} 题目对象；全库出完返回 null
   */
  function buildAdaptiveQuestion(bank, byLevel, lv, used, rng) {
    const qWord = pickWordForLayer(byLevel, lv, used, rng);
    if (!qWord) return null;
    used[qWord.word] = true;
    const q = buildOneQuestion(qWord, byLevel, levelOf(qWord.rank), rng);
    // targetLayer 只用于调试/回看：记录「本来想考哪层」vs「实际考了哪层」，
    // 借词时两者会不同，这个差值本身就是估算误差的信号之一。
    q.targetLayer = lv;
    return q;
  }

  /**
   * 难度推进：按上一题结果算出下一题该出第几层
   *
   * 规则（需求定义）：
   *   答对 +1 层 / 答错 -1 层 / 不认识 -1.5 层，边界不越界，
   *   连续 STABLE_THRESHOLD 题停在同一层 → 锁定，之后不再上下跳。
   *
   * 【locked 是粘性的】必须由调用方传进来、且一旦为true 就永远是 true。
   * 若只用本函数内部的 `streak >= STABLE_THRESHOLD` 判定，会出现这样的 bug：
   * 用户卡在第 5 层连对 3 题 → locked=true；第 4 题答对 → 层号移动到 6，
   * streak 归 1 → 本次判定 locked=false → 外部的 state.locked 被冲回 false
   * → 锁定彻底失效。实测中「一直卡在下界」的场景每次都算出 true，
   * 恰好掩盖了这个 bug，只有「卡在中间层」才会暴露。
   *
   * @param {number} curLayer 当前层
   * @param {string} outcome "correct" | "wrong" | "unknown"
   * @param {number} sameStreak 已连续停在同一层的题数
   * @param {boolean} [locked] 当前是否已锁定（默认 false）
   * @returns {{layer:number, sameStreak:number, locked:boolean}}
   */
  function advanceLayer(curLayer, outcome, sameStreak, locked) {
    // 已锁定 → 层号完全不动，只让 streak 继续累加（便于诊断卡了多久）
    if (locked) {
      return { layer: curLayer, sameStreak: sameStreak + 1, locked: true };
    }

    let delta;
    if (outcome === "correct") delta = STEP_CORRECT;
    else if (outcome === "unknown") delta = STEP_UNKNOWN;
    else delta = STEP_WRONG;

    let next = curLayer + delta;
    // 边界：到第 1 层不再降，到第 10 层不再升
    if (next < 1) next = 1;
    if (next > LAYER_COUNT) next = LAYER_COUNT;
    next = Math.round(next * 2) / 2;      // 允许半层（-1.5 的结果），粒度 0.5

    // streak 的语义是「上一题和这一题在同一层」的连续次数。
    // 所以只有 next === curLayer 才累加，一旦移动就归 1——
    // 这也让「-1.5 产生的半层移动」必然重置计数，这是对的：
    // 难度还在调整中，就不算稳定。
    const streak = (next === curLayer) ? sameStreak + 1 : 1;
    return { layer: next, sameStreak: streak, locked: streak >= STABLE_THRESHOLD };
  }

  /**
   * 为单个题干词构造一道题（1 正确 + 3 干扰选项）
   *
   * 【分档取干扰项，不混池】—— 需求「干扰项难度差不超过 1 层」的关键。
   *
   * 旧实现把「同层同词性 / 邻层同词性 / 任意同词性 / 任意词」的候选
   * 全部 push 进同一个数组再打乱取前 3 个 —— 这等于**取消了优先级**：
   * 跨 8 层的候选和同层候选在池里地位相同，被随机抽中的概率只取决于
   * 各档的数量多少。词库变大后（testBank.json 每层 120 词），
   * 「任意词」那一档有 1200 个候选，会把同层候选完全淹没，
   * 于是「正确答案是最难的词、三个选项都是简单词」这种送分题会大量出现。
   *
   * 现在改为逐档取：某一档取够了就不往下取。档位顺序即优先级：
   *   1. 同层同词性   —— 难度完全一致，最理想
   *   2. 同层任意词性 —— 难度一致（词性不同不影响难度判断）
   *   3. 邻层同词性   —— 难度差 1 层，可接受
   *   4. 邻层任意词性 —— 难度差 1 层，兜底
   * 邻层定义是「层号差 <= 1」，比需求的「不超过 1 层」严格对齐。
   *
   * 【释义去重】候选的meaning 若与正确答案相同，或互为子串
   * （如正确答案「搜索」vs 干扰项「搜索查找」），用户看到就能秒排除 ——
   * 同样是送分题。所以这些候选直接跳过。
   *
   * @param {Object} qWord 题干词 { word, pos, meaning, rank }
   * @param {Object} byLevel 按层级分组的词库
   * @param {number} lv 题干词所属层级
   * @param {Function} rng 随机源
   * @returns {Object} { level, word, options:[{text,correct}], answerIndex,
   *                     distractorLevels:[层号...] }
   */
  function buildOneQuestion(qWord, byLevel, lv, rng) {
    const used = {};
    used[qWord.word] = true;

    // 释义去重判据：与正确答案相同，或互为子串（去空格后比）
    const rightText = String(qWord.meaning || "");
    const rightKey = rightText.replace(/\s+/g, "");
    function meaningClash(m) {
      if (!m) return true;
      const key = String(m).replace(/\s+/g, "");
      if (!key) return true;
      return key === rightKey || key.indexOf(rightKey) >= 0 || rightKey.indexOf(key) >= 0;
    }

    // 收集某一层里符合条件（未用过 + 释义不冲突）的候选
    function collect(layer, needPos) {
      const out = [];
      const arr = byLevel[layer] || [];
      for (let k = 0; k < arr.length; k++) {
        const w = arr[k];
        if (used[w.word]) continue;
        if (needPos && w.pos !== qWord.pos) continue;
        if (meaningClash(w.meaning)) continue;
        out.push(w);
      }
      return out;
    }

    // 档位定义：{ 层集合, 是否要求同词性 }
    const near = [lv - 1, lv + 1].filter(function (x) {
      return x >= 1 && x <= LAYER_COUNT;
    });
    const tiers = [
      { name: "同层同词性", pick: collect(lv, true) },
      { name: "同层任意词性", pick: collect(lv, false) },
      { name: "邻层同词性", pick: near.reduce(function (acc, x) { return acc.concat(collect(x, true)); }, []) },
      { name: "邻层任意词性", pick: near.reduce(function (acc, x) { return acc.concat(collect(x, false)); }, []) }
    ];

    // 逐档取，凑够 3 个就停
    const distractors = [];
    const distractorLevels = [];
    for (let ti = 0; ti < tiers.length && distractors.length < 3; ti++) {
      const shuffled = shuffle(tiers[ti].pick, rng);
      for (let k = 0; k < shuffled.length && distractors.length < 3; k++) {
        const w = shuffled[k];
        if (used[w.word]) continue;
        // 同档内可能重复（collect(lv,false) 包含 collect(lv,true) 已选的），
        // used[w.word] 判重已挡住，但释义重复要再挡一次
        let dupMeaning = false;
        for (let d = 0; d < distractors.length; d++) {
          const a = distractors[d].meaning, b = w.meaning;
          if (a && b && String(a).replace(/\s+/g, "") === String(b).replace(/\s+/g, "")) { dupMeaning = true; break; }
        }
        if (dupMeaning) continue;
        used[w.word] = true;
        distractors.push(w);
        distractorLevels.push(levelOf(w.rank));
      }
    }

    // 构造 4 个选项并打乱
    const options = [
      { text: qWord.meaning, correct: true },
      { text: (distractors[0] || { meaning: "（干扰项）" }).meaning, correct: false },
      { text: (distractors[1] || { meaning: "（干扰项）" }).meaning, correct: false },
      { text: (distractors[2] || { meaning: "（干扰项）" }).meaning, correct: false }
    ];
    const shuffledOpts = shuffle(options, rng);
    let answerIndex = 0;
    shuffledOpts.forEach(function (o, i) { if (o.correct) answerIndex = i; });

    return {
      level: lv,
      word: qWord.word,
      // rank 一并带出来：题目对象要能自己回答「这词有多常用」。
      // 缺了它，调试/ 分析时只能反查词库，而 vocabTest 的题库是异步
      // fetch 进来的（不保证与外部持有的引用是同一份），反查不可靠。
      rank: qWord.rank,
      meaning: qWord.meaning,
      options: shuffledOpts,
      answerIndex: answerIndex,
      distractorLevels: distractorLevels
    };
  }

  /* ==========================================================================
   * 5. 结果计算
   * ========================================================================== */

  /**
   * 根据题目与作答情况估算词汇量（adaptive-v1）
   *
   * 核心思路：**找正确率恰好 50% 的那一层**，而不是「答对率 × 词库总量」。
   *
   * 为什么后者误差大：词库总量是个常数，答对率的变化会被线性放大 ——
   * 20 题里多对 1 题就是 +5%，直接让估算跳 600 词。
   * 而人对外界刺激的反应是对数型的：真实能力 3000 和 3600 的人，
   * 在 5000 词那一档的答对率差别很小。所以应该找**转折点**（临界层），
   * 转折点的位置由少量题目就能定住。
   *
   * 算法：
   *   1) 每层算加权正确率：答对 +1、答错 0、不认识 -0.3，再除以该层题数。
   *      「不认识」给负分而不是 0：它是主动确认不会，比答错更确定地表示「不会」；
   *      给 0 会把它当成「答错但可能对」而高估。
   *   2) 按层号从小到大扫描，找相邻两层：正确率从 >50% 掉到 <50%。
   *   3) 在这两层之间线性插值，算出正确率恰好 50% 的位置（可以是 6.5 这种小数层）。
   *   4) 该位置 × LAYER_SPAN = 词汇量。
   *
   * 例：第 6 层正确率 70%、第 7 层 30% → 临界层 = 6 + (0.7-0.5)/(0.7-0.3) = 6.5
   *   → 词汇量≈ 6.5 × 1000 = 6500。
   *
   * 【关于 +500 的系统性偏移 —— 这不是 bug，是插值定义的必然结果】
   * 如果一个用户的真实水平正好卡在两层的分界上（比如「5000 以内的词全认识，
   * 5000 以上的词全不认识」），实测会发现估出来是 `真实层×1000 + 500`，
   * 恒定高估半个层。原因是这种用户的正确率曲线是**阶跃**：
   *   第 N 层 rate = 1（> 50%）→ 第 N+1 层 rate = 0（< 50%）
   *   临界层正好落在两层正中间 = N + 0.5 → 词汇量 = N×1000 + 500。
   * 自测已验证：knowLevel = 3/4/5/6/7 时分数**全部稳定**为 3500/4500/…/7500，
   * 20 次采样零波动（不是随机误差，是定义上的必然）。
   *
   * 为什么不补偿掉这个偏移：
   *   真实用户的正确率曲线不是阶跃而是连续衰减（会认但不确定的那些词），
   *   恰好落在临界层的概率并不高；而一旦补偿掉，公式就不再是
   *   「找50% 正确率的层」了，而是掺入了一个经验系数，
   *   调参时就无法解释「这个数字为什么是这个数字」。
   *   需求原文给的例子也是「6000 → 6500」，与本实现一致。
   *   误差本身由 ERROR_MARGIN（±500）在结果页明示。
   *
   * 边界处理（见 result.capped）：
   *   - 全对 / 全错 / 全不认识 → 无临界点，按上下限给，并标注「可能更高/更低」
   *   - 只有 1 层答过题 → 数据点不足，回退到简化公式（最高答对层 × 0.8）
   *
   * @param {Array} questions buildAdaptiveQuestion 的结果数组
   * @param {Object} answered { 题号: 选项下标 }，值为 ANSWER_UNKNOWN 表示不认识
   * @returns {{score:number, levelDetails:Array, wrongWords:Array,
   *            correctCount:number, wrongCount:number, unknownCount:number,
   *            capped:string|null, method:string, errorMargin:number}}
   */
  function computeScore(questions, answered) {
    const ans = answered || {};
    // 三项计数（unknown 不计入 correct 也不计入 wrong）
    let correctCount = 0, wrongCount = 0, unknownCount = 0;

    // 各层统计：weighted 是加权得分之和（可带小数），rate = weighted / total
    const allLevels = [];
    for (let lv = 1; lv <= LAYER_COUNT; lv++) allLevels.push({ level: lv, weighted: 0, total: 0, unknown: 0 });
    const map = {};
    allLevels.forEach(function (d) { map[d.level] = d; });

    questions.forEach(function (q, i) {
      const a = ans[i];
      if (a === undefined) return;              // 未答（不该出现）
      const d = map[q.level];
      if (!d) return;
      d.total++;
      if (a === ANSWER_UNKNOWN) { unknownCount++; d.unknown++; d.weighted += W_UNKNOWN; }
      else if (a === q.answerIndex) { correctCount++; d.weighted += W_CORRECT; }
      else { wrongCount++; d.weighted += W_WRONG; }
    });
    allLevels.forEach(function (d) {
      d.correct = Math.max(0, Math.round(d.weighted));   // 给柱状图用的「等效答对数」
      d.rate = d.total ? d.weighted / d.total : null;      // 加权正确率，null = 无题
    });

    // ---- 找50% 临界层 ----
    const measured = allLevels.filter(function (d) { return d.rate !== null; });
    let score = 0;
    let capped = null;      // "high" / "low" / null
    let method = "interpolate";

    if (measured.length < 2) {
      // 数据点太少（只在 1 层答过题）→ 回退简化公式
      method = "fallback";
      const topLayer = measured.length ? highestCorrectLayer(allLevels) : START_LAYER;
      score = topLayer * LAYER_SPAN * 0.8;
      capped = measured.length ? null : "low";
      if (!measured.length) score = VOCAB_MIN;
    } else {
      // 扫描相邻两层的 50% 交叉点
      let found = null;
      for (let i = 0; i < allLevels.length - 1; i++) {
        const lo = allLevels[i], hi = allLevels[i + 1];   // lo 层号更小（更简单）
        if (lo.rate === null || hi.rate === null) continue;
        // 需要 lo.rate > 50% >= hi.rate（从上往下找第一次跌破）
        if (lo.rate > TARGET_RATE && hi.rate <= TARGET_RATE) {
          // 插值：t=0 时在 lo 层，t=1 时在 hi 层
          const span = lo.rate - hi.rate;
          const t = span > 0 ? (lo.rate - TARGET_RATE) / span : 0;
          found = { layer: (lo.level + t), lo: lo, hi: hi };
          break;
        }
      }
      if (found) {
        // 临界层可能是小数（如 6.5）→ ×1000 得词汇量
        score = found.layer * LAYER_SPAN;
        method = "interpolate";
      } else {
        // 没有交叉点：看整体偏易还是偏难
        const first = measured[0], last = measured[measured.length - 1];
        if (first.rate > TARGET_RATE) {
          // 最简单的层都 > 50% → 全对级别的表现，封顶
          score = VOCAB_MAX;
          capped = "high";
        } else if (last.rate <= TARGET_RATE) {
          // 最难的层都 ≤ 50% → 全错/全不认识级别，封底
          score = VOCAB_MIN;
          capped = "low";
        } else {
          // 理论上不可达（单调性假设不成立时可能发生，比如同层内题目难度不均）
          // 保守取「最后 >50% 的层」的下界
          method = "fallback";
          score = highestCorrectLayer(allLevels) * LAYER_SPAN * 0.8;
        }
      }
    }

    // 取整到百位
    score = Math.round(score / 100) * 100;
    // 夹到 [VOCAB_MIN, VOCAB_MAX]，防止插值位置越界（比如实测出现 layer=0）
    if (score < VOCAB_MIN) score = VOCAB_MIN;
    if (score > VOCAB_MAX) score = VOCAB_MAX;

    // 答错的词（用于一键导入生词）。
    // 「不认识」不算答错 —— 用户没选错，是不知道，导进生词本反而合理，
    // 但需求没要求把 unknown 也导进去，这里保持原样只收答错的。
    const wrongWords = [];
    questions.forEach(function (q, i) {
      const a = ans[i];
      if (a !== undefined && a !== ANSWER_UNKNOWN && a !== q.answerIndex) wrongWords.push(q.word);
    });

    return {
      score: score,
      levelDetails: allLevels,
      wrongWords: wrongWords,
      correctCount: correctCount,
      wrongCount: wrongCount,
      unknownCount: unknownCount,
      capped: capped,
      method: method,
      errorMargin: ERROR_MARGIN
    };
  }

  /** 最高的「答对过」的层号（用于回退公式与提示语），没有则返回 0 */
  function highestCorrectLayer(levelDetails) {
    for (let i = levelDetails.length - 1; i >= 0; i--) {
      const d = levelDetails[i];
      if (d.total > 0 && d.rate !== null && d.rate > 0) return d.level;
    }
    return 0;
  }

  /** 根据分数返回鼓励文案 */
  function encouragement(score) {
    if (score < 1000) return "刚开始积累，每天进步一点点！";
    if (score < 3000) return "基础不错，继续扩大词汇量！";
    if (score < 5000) return "四级水平，向六级冲刺！";
    if (score < 8000) return "六级水平，词汇量很扎实！";
    if (score < 12000) return "高级水平，可以读原版书了！";
    return "词汇量爆表，太厉害了！";
  }

  /* ==========================================================================
   * 6. 持久化
   * ========================================================================== */

  /** 读取已保存的测试结果（没有/坏数据返回 null） */
  function loadResult() {
    const store = getStorage();
    if (!store) return null;
    try {
      const raw = JSON.parse(store.getItem(STORAGE_KEY) || "null");
      if (!raw || typeof raw.score !== "number") return null;
      return raw;
    } catch (e) { return null; }
  }

  /** 保存测试结果 */
  function saveResult(result) {
    const store = getStorage();
    if (!store) return;
    try { store.setItem(STORAGE_KEY, JSON.stringify(result)); } catch (e) { /* ignore */ }
  }

  /* ==========================================================================
   * 7. 渲染：题目视图 / 结果视图
   * ========================================================================== */

  /** 取测试页子元素（不存在时返回 null） */
  function el(id) {
    return (typeof document !== "undefined") ? document.getElementById(id) : null;
  }
  function pageEl() { return el("vocabTestPage"); }
  function bodyEl() { return el("vtBody"); }
  function footerEl() { return el("vtFooter"); }
  function headerProgressEl() { return el("vtHeaderProgress"); }

  /** 重置内部状态（每次打开都从头开始） */
  function resetState() {
    state.questions = [];
    state.index = 0;
    state.answered = {};
    state.finished = false;
    state.result = null;
    state.imported = false;
    state.importedMsg = "";
    // 自适应状态一并复位
    state.byLayer = null;
    state.bank = null;
    state.rng = null;
    state.usedWords = {};
    state.curLayer = START_LAYER;
    state.sameStreak = 0;
    state.locked = false;
    state.history = [];
    state.degraded = false;
    // 注意：pageToken 【不】在这里复位。
    // open() 是「先 openToken += 1、再 resetState、再 state.pageToken = openToken」，
    // 如果 resetState 也清它，赋的值就被抹掉了，令牌永远等于 0，
    // isStaleOpen 恒为 false ——竞态保护静默失效（页面隐藏后仍会渲染并污染 state）。
    if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; }
  }

  /**
   * 生成一道新题并追加到 state.questions（自适应核心）
   *
   * 只在「还需要更多题」时调用。全库抽空（WORD_BANK 只有 60 词但要20 题，
   * 且同层停留会集中消耗某层）时返回一个**已用过的词**，
   * 保证 20 题一定能出完 —— 宁可有个别重复词，也不能让测试卡住。
   *
   * @param {Function} [rng] 随机源；不传则用 state.rng，再不传才用 Math.random。
   *   **必须支持从 state 读 rng** —— 因为 applyAnswer 内部调它时不方便传参，
   *   而自测要靠注入确定性 rng 来复现整条题目序列。
   * @returns {Object|null} 新题；连兜底都拿不到时返回 null
   */
  function generateNextQuestion(rng) {
    rng = rng || state.rng || Math.random;
    if (!state.byLayer) state.byLayer = groupByLevel(getBank());
    if (!state.bank) state.bank = getBank();

    let q = buildAdaptiveQuestion(state.bank, state.byLayer, state.curLayer, state.usedWords, rng);

    // 兜底：新词抽完了（新词用尽）→ 退回抽已用过的词，保证题量。
    // 这只会在极小词库 + 高层停留的组合下发生，记录到 targetLayer 便于排查。
    if (!q) {
      const pool = [];
      for (let lv = 1; lv <= LAYER_COUNT; lv++) {
        (state.byLayer[lv] || []).forEach(function (w) { pool.push(w); });
      }
      if (!pool.length) return null;
      const fallbackWord = pool[Math.floor(rng() * pool.length)];
      state.usedWords[fallbackWord.word] = true;
      q = buildOneQuestion(fallbackWord, state.byLayer, levelOf(fallbackWord.rank), rng);
      q.targetLayer = state.curLayer;
      q.reusedWord = true;                       // 标记出来，便于自测与将来优化
    }
    state.questions.push(q);
    return q;
  }

  /** 渲染题目视图（当前题：大单词 + 4 选项 + 不认识按钮） */
  function renderQuestionView() {
    const q = state.questions[state.index];
    const b = bodyEl();
    if (!q || !b) return;

    const n = state.index + 1;
    const hp = headerProgressEl();
    if (hp) hp.textContent = n + "/" + TEST_TOTAL;

    const answered = state.answered[state.index];   // undefined = 未答
    const isUnknown = (answered === ANSWER_UNKNOWN);
    const optsHtml = q.options.map(function (o, i) {
      let cls = "vt-opt";
      let mark = "";
      // 禁用条件是「答过了」，与答的是哪个选项无关。
      // 【别写成 answered !== undefined && !isUnknown】—— 那样选了「不认识」
      // 的题，四个选项【没有】 disabled class，看起来还能点；
      // 点了之后 applyAnswer 内部虽会挡住（不重复计数），
      // 但重绘后选项仍然不显示任何标记，用户得到的是「点了没反应」，
      // 会以为选项坏了。视觉反馈必须和实际可点性一致。
      if (answered !== undefined) {
        // 只有选了具体选项才标对错；选「不认识」不是答错，不打 ✗ 也不打 ✓。
        if (!isUnknown) {
          if (o.correct) { cls += " correct"; mark = ' <span class="vt-mark ok">✓</span>'; } // 正确 → 绿 + ✓
          else if (i === answered) { cls += " wrong"; mark = ' <span class="vt-mark no">✗</span>'; } // 选错 → 红 + ✗
        }
        cls += " disabled";                          // 答过就禁用，不能再改
      }
      return '<button class="' + cls + '" data-oindex="' + i + '">' + esc(o.text) + mark + "</button>";
    }).join("");

    // 「不认识」按钮：弱样式（灰边灰字），已答过则禁用并标记选中态。
    // 不显示对错标记 —— 选它不是"答错"，没资格打 ✗。
    const unknownCls = "vt-unknown" + (answered !== undefined ? " disabled" : "") + (isUnknown ? " picked" : "");
    const unknownHtml = '<button class="' + unknownCls + '" data-vt-unknown>' +
      (isUnknown ? "不认识" : "不认识（空格）") + "</button>";

    b.innerHTML = renderBankNoticeHtml() +
      '<div class="vt-question">' +
      '<div class="vt-word">' + esc(q.word) + "</div>" +
      '<div class="vt-prompt">请选择正确释义</div>' +
      '<div class="vt-opts">' + optsHtml + "</div>" +
      '<div class="vt-unknown-row">' + unknownHtml + "</div>" +
      "</div>";

    renderFooter();
  }

  /**
   * 渲染底部进度条（20 小格 + 提示文字）
   * 三种状态：done（已答，用实心）/ unknown（点了不认识，斜纹填充）/
   *          current（当前题，空心描边）/ 未答（浅灰）
   * unknown 单独一种视觉是为了让用户扫一眼就知道"这题我是跳过的，
   * 不是不会做"—— 回看时这两种情况的意义完全不同。
   */
  function renderFooter() {
    const f = footerEl();
    if (!f) return;
    const cells = [];
    for (let i = 0; i < TEST_TOTAL; i++) {
      let cls = "vt-cell";
      const a = state.answered[i];
      if (a === ANSWER_UNKNOWN) cls += " done unknown";   // 不认识 → 第三种标记
      else if (a !== undefined) cls += " done";           // 答过（含答错）
      if (!state.finished && a === undefined && i === state.index) cls += " current"; // 当前题
      cells.push('<span class="' + cls + '"></span>');
    }
    const skipped = Object.keys(state.answered).filter(function (k) {
      return state.answered[k] === ANSWER_UNKNOWN;
    }).length;
    f.innerHTML = '<div class="vt-cells">' + cells.join("") + "</div>" +
      '<div class="vt-hint">' + (state.finished
        ? "已完成全部 " + TEST_TOTAL + " 题" + (skipped ? "，其中 " + skipped + " 题不认识" : "")
        : "第 " + (state.index + 1) + " 题 / 共 " + TEST_TOTAL + " 题") + "</div>";
  }

  /** 渲染结果页（大数字 + 误差范围 + 位置条 + 鼓励文案 + 柱状图 + 按钮） */
  function renderResultView(result) {
    const b = bodyEl();
    if (!b) return;
    result = result || state.result;
    if (!result) return;
    const score = result.score;

    // ---- 柱状图：只画【实际考过的层】----
    // 旧版固定画 5 根，自适应版只出现过 3-5 层，
    // 画全部 10 根会有 5-6 根空柱，既难看又会让人误以为"这些层都测过了"。
    const details = result.levelDetails || [];
    const measured = [];
    for (let i = 0; i < details.length; i++) {
      const d = details[i];
      if (d && d.total > 0) measured.push(d);
    }
    // 旧格式结果（localStorage 里的历史数据）没有 rate 字段，退回用 correct/total 算
    function rateOf(d) {
      if (typeof d.rate === "number") return d.rate;
      return d.total ? d.correct / d.total : 0;
    }
    const bars = measured.map(function (d) {
      const pct = Math.round(rateOf(d) * 100);
      // rate 可能为负（全层「不认识」→ -0.3），柱状图不能画负高度，夹到 0
      const h = Math.max(0, Math.min(100, pct));
      const name = LEVEL_NAMES[d.level] || ("第" + d.level + "层");
      return '<div class="vt-bar-wrap" title="第 ' + d.level + ' 层：' +
        d.total + ' 题，加权正确率 ' + pct + '%">' +
        '<div class="vt-bar"><div class="vt-bar-fill" data-rate="' + pct + '" style="height:' + h + '%"></div></div>' +
        '<div class="vt-bar-name">' + name + "</div>" +
        '<div class="vt-bar-pct">' + pct + "%</div>" +
        "</div>";
    }).join("");

    const wrongCount = (result.wrongWords || []).length;
    const importBtn = (wrongCount === 0)
      ? '<button class="btn primary" disabled>全部答对，没有生词</button>'
      : '<button class="btn primary" data-vt-import>一键导入生词</button>';

    // 三项计数：答对 / 答错 / 不认识。
    // 旧版结果对象（localStorage 里的历史数据）没有这三个字段，
    // 所以每个都做了缺省回退，避免老数据回看时显示 NaN。
    const correctCount = result.correctCount != null ? result.correctCount : TEST_TOTAL - wrongCount;
    const wrongCnt = result.wrongCount != null ? result.wrongCount : wrongCount;
    const unknownCnt = result.unknownCount || 0;
    const tally = '<div class="vt-tally">' +
      '<span class="vt-tally-item ok">答对 <b>' + correctCount + "</b> 题</span>" +
      '<span class="vt-tally-item no">答错 <b>' + wrongCnt + "</b> 题</span>" +
      '<span class="vt-tally-item unknown">不认识 <b>' + unknownCnt + "</b> 题</span>" +
      "</div>";

    /* ---- 位置可视化 + 误差范围（adaptive-v1 新增）----
     * 一条 0 - VOCAB_MAX 的横条，标出估算值落点与误差区间。
     * 目的是让用户看到「这只是估计」而不是「精确测量」——
     * 20 道题的抽样误差客观存在，把±500 明着写出来比藏起来更可信。 */
    const isAdaptive = result.algorithm === ALGORITHM_VERSION;
    const margin = result.errorMargin != null ? result.errorMargin : ERROR_MARGIN;
    const pctOf = Math.max(0, Math.min(100, (score / VOCAB_MAX) * 100));
    const loPct = Math.max(0, ((score - margin) / VOCAB_MAX) * 100);
    const hiPct = Math.min(100, ((score + margin) / VOCAB_MAX) * 100);
    const gauge = isAdaptive
      ? '<div class="vt-gauge">' +
        '<div class="vt-gauge-track">' +
        '<div class="vt-gauge-range" style="left:' + loPct.toFixed(1) + '%;width:' +
          Math.max(1.5, hiPct - loPct).toFixed(1) + '%"></div>' +
        '<div class="vt-gauge-mark" style="left:' + pctOf.toFixed(1) + '%"></div>' +
        "</div>" +
        '<div class="vt-gauge-scale"><span>0</span><span>' + (VOCAB_MAX / 2) +
        '</span><span>' + VOCAB_MAX + " 词</span></div>" +
        '<div class="vt-gauge-note">基于 ' + TEST_TOTAL + ' 道题的抽样估计，误差约 ±' + margin +
        " 词</div>" +
        "</div>"
      : "";

    // 封顶 / 封底提示：只在触边界时出现，明确告诉用户「测到头了」
    const capped = result.capped;
    const capNote = capped === "high"
      ? '<div class="vt-cap-note">你的正确率一路偏高，词汇量可能<b>高于 ' + VOCAB_MAX +
        '</b>。20 道题已到本题库上限，建议扩充词库后重测。</div>'
      : (capped === "low"
        ? '<div class="vt-cap-note">正确率一路偏低，词汇量可能<b>低于 ' + VOCAB_MIN +
          '</b>。这也可能只是状态不佳，稍后再测一次更准。</div>'
        : "");

    const scoreText = isAdaptive
      ? "约 " + score + " <span>词</span>（±" + margin + "）"
      : "约 " + score + ' <span>词</span>';

    const actions = '<div class="vt-result-actions">' +
      importBtn +
      (state.imported ? '<button class="btn" data-vt-book>去单词本看看</button>' : "") +
      '<button class="btn ghost" data-vt-home>返回首页</button>' +
      "</div>";

    b.innerHTML = '<div class="vt-result">' +
      '<div class="vt-score-title">你的词汇量</div>' +
      '<div class="vt-score">' + scoreText + "</div>" +
      '<div class="vt-encourage">' + encouragement(score) + "</div>" +
      gauge +
      capNote +
      tally +
      '<div class="vt-chart">' + bars + "</div>" +
      (state.imported ? '<div class="vt-imported">' + esc(state.importedMsg) + "</div>" : "") +
      actions +
      "</div>";

    // 结果页不需要题目进度条，底部只留一句完成提示
    const f = footerEl();
    if (f) f.innerHTML = '<div class="vt-hint">已完成全部 ' + TEST_TOTAL + " 题</div>";
  }

  /* ==========================================================================
   * 8. 答题交互
   * ========================================================================== */

  /**
   * 作答一道题（内部：落状态 + 立即重绘反映对错/禁用 + 推进自适应难度）
   *
   * 自适应的时序很关键：**这里就生成下一题**，而不是等用户看到第 N+1 题时再生成。
   * 因为「下一题出多难」必须在用户点完当前题的瞬间就确定 ——
   * 晚一步，renderQuestionView 就会渲染出一道难度还没定的题。
   *
   * @param {number} qIndex 题号
   * @param {number} optIndex 选项下标，或 ANSWER_UNKNOWN 表示「不认识」
   * @returns {boolean|null} 答对 true / 答错或不认识 false / 已答过返回 null（忽略）
   */
  function applyAnswer(qIndex, optIndex) {
    if (state.answered[qIndex] !== undefined) return null;   // 已答过 → 不计、不重复
    const q = state.questions[qIndex];
    if (!q) return null;
    state.answered[qIndex] = optIndex;
    const correct = optIndex === q.answerIndex;
    const outcome = correct ? "correct" : (optIndex === ANSWER_UNKNOWN ? "unknown" : "wrong");

    // 逐题记录（调试 / 以后优化算法用）
    state.history.push({
      qIndex: qIndex,
      word: q.word,
      level: q.level,// 该词真实所在层（估算公式用这个）
      targetLayer: q.targetLayer, // 本想考哪层（与 level 不一致 = 借词，可查估算误差来源）
      outcome: outcome
    });

    // 推进难度（锁定后钉在当前层）
    stepDifficulty(outcome);

    // 预生成下一题
    if (state.questions.length < TEST_TOTAL) generateNextQuestion();

    renderQuestionView();                // 立即显示对错样式 + 禁用
    return correct;
  }

  /**
   * 按当前作答结果推进难度，并落 state
   *
   * locked 是粘性的：只在第一次判定为 true 时置位，之后永远保持。
   * 这一点靠把 state.locked 传进 advanceLayer 实现 —— 见那里的注释。
   */
  function stepDifficulty(outcome) {
    const adv = advanceLayer(state.curLayer, outcome, state.sameStreak, state.locked);
    state.curLayer = adv.layer;
    state.sameStreak = adv.sameStreak;
    state.locked = state.locked || adv.locked;   // 一旦锁定不可回退
    return adv;
  }

  /** 安排跳到下一题 / 结算（带延迟，答对快、答错慢、「不认识」居中） */
  function scheduleNext() {
    const qIndex = state.index;
    const q = state.questions[qIndex];
    if (!q) return;
    const a = state.answered[qIndex];
    const correct = a === q.answerIndex;
    // 「不认识」没有正确答案要展示，不需要像答错那样留 1200ms 让用户核对，
    // 但也不能像答对那样 800ms 就走 —— 用户点它时通常还在犹豫，给 DELAY_UNKNOWN。
    const delay = correct ? DELAY_CORRECT : (a === ANSWER_UNKNOWN ? DELAY_UNKNOWN : DELAY_WRONG);
    if (advanceTimer) clearTimeout(advanceTimer);
    advanceTimer = setTimeout(function () {
      advanceTimer = null;
      if (qIndex >= TEST_TOTAL - 1) finish();
      else { state.index++; renderQuestionView(); }
    }, delay);
  }

  /**
   * 用户作答（UI 入口，带自动跳转延迟）
   * @param {number} qIndex
   * @param {number} optIndex 选项下标，或 ANSWER_UNKNOWN
   */
  function answer(qIndex, optIndex) {
    const res = applyAnswer(qIndex, optIndex);
    if (res === null) return;          // 已答过，忽略（防连点重复计数）
    scheduleNext();
  }

  /** 用户点「不认识」（点击按钮与空格键都走这里） */
  function answerUnknown(qIndex) {
    answer(qIndex, ANSWER_UNKNOWN);
  }

  /** 结算：算分 + 保存 + 切结果页 */
  function finish() {
    state.finished = true;
    if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; }
    const result = computeScore(state.questions, state.answered);
    result.testDate = todayStr();
    // 算法版本 + 误差范围 + 逐题记录：存进localStorage，
    // 便于以后回头分析「哪些题偏难/偏易」「误差来自哪一层」。
    result.algorithm = ALGORITHM_VERSION;
    result.errorMargin = ERROR_MARGIN;
    result.answerHistory = state.history.slice();
    state.result = result;
    saveResult(result);
    renderResultView(result);
    renderVocabTestLine();            // 首页状态栏同步显示词汇量
  }

  /* ==========================================================================
   * 9. 批量导入
   * ========================================================================== */

  /**
   * 解析批量导入文本
   *   - 按换行分割，去首尾空白
   *   - 只保留「字母 / 连字符 / 空格」组合（词组允许空格），其余算无效
   *   - 转小写、去重（大小写不敏感）、忽略空行
   *   - 再区分「已在单词本」与「将导入」
   * @param {string} text
   * @returns {{valid:Array, invalid:Array, inBook:Array, willImport:Array, counts:Object}}
   */
  function parseBatchText(text) {
    const lines = String(text || "").split(/\r?\n/);
    const valid = [];
    const invalid = [];
    const seen = {};
    lines.forEach(function (line) {
      const t = line.trim();
      if (!t) return;                                   // 空行忽略
      if (!/^[A-Za-z\- ]+$/.test(t)) { invalid.push(t); return; } // 非英文 → 无效
      const w = t.toLowerCase().replace(/\s+/g, " ");   // 统一小写、合并多余空格
      if (seen[w]) return;                               // 去重
      seen[w] = true;
      valid.push(w);
    });
    const inBook = [];
    const willImport = [];
    valid.forEach(function (w) {
      if (typeof VocabBook !== "undefined" && VocabBook.isInVocabBook(w)) inBook.push(w);
      else willImport.push(w);
    });
    return {
      valid: valid, invalid: invalid, inBook: inBook, willImport: willImport,
      counts: { total: valid.length, skipped: inBook.length, invalid: invalid.length, import: willImport.length }
    };
  }

  /** 通用弹窗（返回 { mask, modal, close }） */
  function openModal(html) {
    if (typeof document === "undefined" || !document.createElement) return null;
    const mask = document.createElement("div");
    mask.className = "modal-mask vt-modal-mask";
    mask.innerHTML = '<div class="modal"></div>';
    const modal = mask.querySelector(".modal");
    modal.innerHTML = html;
    document.body.appendChild(mask);
    mask.addEventListener("click", function (e) { if (e.target === mask) removeModal(mask); });
    return { mask: mask, modal: modal, close: function () { removeModal(mask); } };
  }
  function removeModal(mask) {
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
  }

  /** 入口 A：测试结果页「一键导入生词」→ 确认框 → 批量导入答错的词 */
  function importWrong() {
    const res = loadResult();
    const wrong = (res && res.wrongWords) || [];
    if (!wrong.length) { tip("没有需要导入的生词"); return; }
    const modal = openModal(
      '<div class="modal-head"><h3>导入生词</h3>' +
      '<button class="modal-close" data-cancel>×</button></div>' +
      '<div class="modal-body"><p class="hint">将导入 ' + wrong.length + ' 个生词到单词本，确定吗？</p></div>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-cancel>取消</button>' +
      '<button class="btn primary" data-ok>确定导入</button>' +
      "</div>"
    );
    if (!modal) return;
    modal.modal.querySelector("[data-cancel]").addEventListener("click", modal.close);
    modal.modal.querySelector("[data-ok]").addEventListener("click", function () {
      modal.close();
      doImportWrong(wrong);
    });
  }

  /** 真正执行「导入答错的词」 */
  function doImportWrong(words) {
    const r = (typeof VocabBook !== "undefined") ? VocabBook.batchAdd(words, SRC_TEST) : { success: 0, skipped: 0, failed: 0 };
    state.imported = true;
    state.importedMsg = r.success > 0
      ? ("已成功导入 " + r.success + " 个词" + (r.skipped ? "，重复 " + r.skipped + " 个已跳过" : ""))
      : (r.skipped ? ("成功 0 个，重复 " + r.skipped + " 个已跳过") : "导入完成");
    tip(state.importedMsg);
    if (state.result) renderResultView(state.result);   // 刷新出「去单词本看看」
  }

  /** 入口 B：单词本页「批量导入」→ 粘贴弹窗（实时预览） */
  function openBatchImport() {
    const modal = openModal(
      '<div class="modal-head"><h3>批量导入单词</h3>' +
      '<button class="modal-close" data-cancel>×</button></div>' +
      '<div class="modal-body">' +
      '<p class="hint">每行一个单词，支持英文单词、词组</p>' +
      '<button class="btn vt-dict-entry" id="vtOpenDictImport" type="button">' +
      '📚 从内置词典一键导入' +
      '</button>' +
      '<textarea id="vtBatchInput" class="vt-textarea" placeholder="例如：\napple\nbanana\ncherry"></textarea>' +
      '<div id="vtBatchPreview" class="vt-preview"></div>' +
      "</div>" +
      '<div class="modal-actions">' +
      '<button class="btn" data-cancel>取消</button>' +
      '<button class="btn primary" id="vtBatchImportBtn" data-import disabled>导入</button>' +
      "</div>"
    );
    if (!modal) return;
    const input = modal.modal.querySelector("#vtBatchInput");
    const preview = modal.modal.querySelector("#vtBatchPreview");
    const importBtn = modal.modal.querySelector("#vtBatchImportBtn");
    modal.modal.querySelector("[data-cancel]").addEventListener("click", modal.close);

    // 「从内置词典一键导入」入口：关掉粘贴弹窗再开词典弹窗，
    // 避免两个 modal-mask 叠在一起（下面的遮罩会吃掉上面的点击）。
    const dictEntry = modal.modal.querySelector("#vtOpenDictImport");
    if (dictEntry) {
      dictEntry.addEventListener("click", function () {
        modal.close();
        openDictImport();
      });
    }

    function refresh() {
      const parsed = parseBatchText(input.value);
      preview.innerHTML =
        "共识别 <b>" + parsed.counts.total + "</b> 个单词<br>" +
        "其中 <b>" + parsed.counts.skipped + "</b> 个已在单词本中，将跳过<br>" +
        "无效 <b>" + parsed.counts.invalid + "</b> 个（非英文），将跳过<br>" +
        "将导入：<b>" + parsed.counts.import + "</b> 个新词";
      importBtn.textContent = "导入 " + parsed.counts.import + " 个词";
      if (parsed.counts.import > 0) importBtn.removeAttribute("disabled");
      else importBtn.setAttribute("disabled", "");
    }
    input.addEventListener("input", refresh);
    refresh();

    importBtn.addEventListener("click", function () {
      const parsed = parseBatchText(input.value);
      if (parsed.counts.import === 0) { modal.close(); return; }
      const r = (typeof VocabBook !== "undefined")
        ? VocabBook.batchAdd(parsed.willImport, SRC_MANUAL) : { success: 0, skipped: 0, failed: 0 };
      tip("成功导入 " + r.success + " 个词" + (r.skipped ? "，重复 " + r.skipped + " 个已跳过" : ""));
      modal.close();
      // 单词本列表刷新（app.js 的函数；缺失则靠 VocabBook.subscribe 自动刷新）
      if (typeof renderVocabBookSection === "function") renderVocabBookSection();
    });
  }

  /* ==========================================================================
   * 9b. 内置词典一键导入
   *
   * 与「粘贴批量导入」的区别：词表来自 data/*.json，用户不用自己准备文本。
   *
   * 三层数据的关系（容易搞混，先说清）：
   *   VocabBook  —— 单词本。用户真正在背的词，导入的目标就是这里。
   *   WordPool   —— 词频池（wordLibrary）。今日新词从这里选，
   *                 WordPool.syncVocabBookWords() 会把单词本的词同步进来。
   *   pack       —— 今日内容包（缓存），今日 10 个新词最终落到这里。
   *
   * 所以「导入后补足今日新词」不能只动 VocabBook：
   * 补差池 freqPool 筛的是 wordLibrary，光进单词本的话今日池不会变化。
   * 正确做法是让 WordPool 重新生成今日池（它内部会 syncVocabBookWords 把新词带进
   * wordLibrary），再把新词写回 pack —— 详见 refillTodayNewWords()。
   * ========================================================================== */

  /** 内置词典清单。与 data/ 下的 JSON 文件一一对应。 */
  const BUILTIN_DICTS = [
    { id: "cet4", name: "英语四级 CET-4", level: "CET-4", approx: 4543, desc: "大学英语四级考试大纲词汇" },
    { id: "cet6", name: "英语六级 CET-6", level: "CET-6", approx: 6661, desc: "大学英语六级考试大纲词汇" },
    { id: "tem4", name: "英语专业四级 TEM-4", level: "TEM-4", approx: 9909, desc: "英语专业四级考试大纲词汇" }
  ];
  // approx 是 data/<id>.json 里_meta.wordCount 的镜像，用于弹窗列表的
  // 「词表约 N 词」那句静态描述（那时词表还没fetch 出来，只能先给个预期值）。
  // 【改词表时必须同步这里的三个数字】—— 预载成功后列表里显示的是真实词数，
  // 但预载完成前的那一瞬间、以及 fetch 失败时，用户看到的是这个值。
  // 两处不一致会让人怀疑"到底哪个是对的"。

  /** 词典 JSON 缓存：同一个会话内不重复 fetch */
  const dictCache = {};

  /* ---------------- 自适应测试题库（data/testBank.json）---------------- */

  /**
   * 题库文件路径。用相对路径而非 "/data/testBank.json"——
   * 绝对路径部署到子目录会 404（与 loadBuiltinDict 同一约定）。
   * 该文件已加入 sw.js 的 PRECACHE_URLS，离线也能测。
   */
  const TEST_BANK_URL = "data/testBank.json";

  /** 已加载的题库（扁平词数组）；null = 还没加载 */
  let testBankCache = null;
  /** 加载中的 Promise，避免并发重复 fetch */
  /** open() 的并发令牌，每次进入 +1。用来识别「await 期间用户已离开/重开」 */
  let openToken = 0;
  /** 题库加载中的 Promise（并发去重：连续点两次不会发两次 fetch） */
  let testBankPromise = null;
  /** 题库的 meta（词数、层数、数据来源），供结果页/调试展示 */
  let testBankMeta = {};

  /**
   * 加载一本内置词典
   * @param {string} dictId
   * @returns {Promise<{id:string,name:string,words:Array<string>,meta:Object,placeholder:boolean}>}
   */
  function loadBuiltinDict(dictId) {
    const known = BUILTIN_DICTS.filter(function (d) { return d.id === dictId; })[0];
    if (!known) return Promise.reject(new Error("未知的词典：" + dictId));
    if (dictCache[dictId]) return Promise.resolve(dictCache[dictId]);

    return fetch("data/" + dictId + ".json")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (json) {
        // 兼容两种格式：{_meta, words:[...]} 或直接 ["word", ...]
        const raw = Array.isArray(json) ? json : (json && json.words);
        if (!Array.isArray(raw)) throw new Error("词表格式不正确");
        const meta = (json && json._meta) || {};
        // 归一化 + 过滤：跟 previewDictImport 用同一套规则，
        // 保证「加载时看到的词数」和「导入时实际处理的词数」一致。
        const words = raw
          .map(normalizeImportWord)
          .filter(isValidImportWord);
        const dict = {
          id: dictId,
          name: meta.name || known.name,
          words: words,
          meta: meta,
          placeholder: meta.status === "PLACEHOLDER"
        };
        dictCache[dictId] = dict;
        return dict;
      });
  }

  /**
   * 归一化一个待导入词，规则必须与 VocabBook 内部的 normalizeVocabWord 一致：
   * 去首尾空白 → 去首尾非字母数字 → 转小写。
   * 归一化后还要过一次词形校验：只放行「字母开头 + 字母/连字符」的单个词。
   *
   * 为什么必须在这里也做一遍：VocabBook.findVocabRecord 比对时会归一化，
   * 所以 isInVocabBook("Apple") 能正确命中已有的 "apple"。
   * 但如果不归一化就把它塞进 willImport，脏数据（"Apple"、"  banana  "、"!!!"）
   * 会漏进 batchAdd —— 一部分被救回、一部分被判 failed，
   * 结果就是「预演说能导入 N 个，实际只成功 N-几个」，数字对不上。
   *
   * @param {string} raw
   * @returns {string} 归一化后的词；无效时返回空串
   */
  function normalizeImportWord(raw) {
    return String(raw == null ? "" : raw).trim()
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/[^A-Za-z0-9]+$/, "")
      .toLowerCase();
  }

  /** 词形是否合法：单个英文单词（可含连字符），不含空格 */
  function isValidImportWord(w) {
    return /^[a-z][a-z-]*$/.test(w);
  }

  /**
   * 统计「选中词典导入后」的实际结果（不落库，纯预演）
   * @param {Array<string>} words 词典词表
   * @returns {{inBook:Array, willImport:Array, invalid:Array}}
   */
  function previewDictImport(words) {
    const inBook = [], willImport = [], invalid = [];
    const seen = {};
    (words || []).forEach(function (raw) {
      const w = normalizeImportWord(raw);
      // 归一化后为空（纯符号/数字）或含空格等非法字符 → 剔除
      if (!w || !isValidImportWord(w)) { invalid.push(String(raw)); return; }
      if (seen[w]) return;                              // 词表内部去重
      seen[w] = true;
      if (typeof VocabBook !== "undefined" && VocabBook.isInVocabBook(w)) inBook.push(w);
      else willImport.push(w);
    });
    return { inBook: inBook, willImport: willImport, invalid: invalid };
  }

  /**
   * 导入后补足今日新词（需求：今日新词不足 10 个时，从新导入的词里按词频补够）
   *
   * 注意「已学过的今日进度不受影响」：已缓存的 pack 里，
   * 已经背过/做对过的词靠 progress（quizProgress，按 quizKey 绑定）记录，
   * 这里只动 pack.words（新词表），不碰 progress / quizKey，所以进度不受影响。
   *
   * @param {Array<string>} importedWords 本次成功导入的词
   * @returns {{before:number, after:number, added:number, poolRefreshed:boolean}}
   */
  function refillTodayNewWords(importedWords) {
    const out = { before: 0, after: 0, added: 0, poolRefreshed: false };
    if (!importedWords || !importedWords.length) return out;

    // 1) 让词频池把单词本的新词同步进来（WordPool.generateDailyPool 内部会做）
    if (typeof WordPool === "undefined" || !WordPool.generateDailyPool) return out;
    let pool;
    try {
      pool = WordPool.generateDailyPool();
    } catch (e) {
      return out;
    }
    out.poolRefreshed = true;

    // 2) 读回今日缓存包（没有缓存说明今天还没生成过内容包，不擅自触发 AI 生成）
    const store = getStorage();
    if (!store) return out;
    let pack = null;
    try {
      pack = JSON.parse(store.getItem(STORAGE_KEY_PACK) || "null");
    } catch (e) { return out; }
    if (!pack || !Array.isArray(pack.words)) return out;

    out.before = pack.words.length;
    // 早退前先把 after 填上：调用方会读 ref.after 显示「现共 N 个」，
    // 漏赋值会让提示语少一块。
    out.after = out.before;
    if (out.before >= DAILY_NEW_TARGET) return out;   // 已够 10 个，不动

    // 3) 从今日池的新词里按顺序补足（generateDailyPool 已按 addDate + 词频排好序）
    const have = {};
    pack.words.forEach(function (w) { have[String(w.word || w).toLowerCase()] = true; });
    const candidates = (pool.newWords || []).filter(function (w) {
      const key = String(w.word || w).toLowerCase();
      return !have[key];
    });
    for (let i = 0; i < candidates.length && pack.words.length < DAILY_NEW_TARGET; i++) {
      pack.words.push(candidates[i]);
      out.added++;
    }
    if (out.added > 0) {
      try { store.setItem(STORAGE_KEY_PACK, JSON.stringify(pack)); } catch (e) { /* ignore */ }
    }
    out.after = pack.words.length;
    return out;
  }

  /**
   * 预载所有内置词典的词数并写回列表项。
   *
   * 为什么必须主动载：列表项的初始文案是「载入中…」，而原来只有用户
   *【点某一本词典】（onPick）才会去loadBuiltinDict —— 也就是说
   * 弹窗一打开，三本词典全部停在「载入中…」，用户不点就永远不知道有几词。
   * 看起来像"加载失败"，实际是"根本没发起请求"。
   *
   * 失败时也要显示明确状态（词数未知），不能让「载入中…」停在那儿 ——
   * 用户分不清"还在加载"和"加载失败但没人告诉我"。
   */
function preloadDictCounts(listEl) {
    BUILTIN_DICTS.forEach(function (d) {
      const li = listEl.querySelector('[data-dict="' + d.id + '"]');
      const countEl = li ? li.querySelector("[data-count]") : null;
      loadBuiltinDict(d.id).then(function (dict) {
        if (!countEl) return;
        // 打上 data-loaded：onPick 靠它判断"要不要先闪一下「载入中…」"。
        // 少了这个标记，用户点已预载的词典时按钮会闪一下再变数字。
        countEl.setAttribute("data-loaded", "1");
        if (!dict.words.length) {
          countEl.textContent = "0 词（待补全）";
          return;
        }
        // 占位词表要标出来，否则「100 词」会被当成完整版，用户导完才发现只有 100 个。
        countEl.textContent = dict.words.length + " 词" +
          (dict.placeholder ? "（占位）" : "");
      }).catch(function () {
        if (countEl) {
          countEl.textContent = "词数未知（加载失败）";
          countEl.setAttribute("data-loaded", "");
        }
      });
    });
  }

  /** 打开「从词典导入」弹窗 */
  function openDictImport() {
    const rows = BUILTIN_DICTS.map(function (d) {
      return '<li class="vt-dict-item" data-dict="' + d.id + '">' +
        '<div class="vt-dict-main">' +
        '<div class="vt-dict-name">' + d.name + "</div>" +
        '<div class="vt-dict-desc">' + d.desc + "（词表 " + d.approx + " 词）</div>" +
        "</div>" +
        '<div class="vt-dict-count" data-count>载入中…</div>' +
        "</li>";
    }).join("");

    const modal = openModal(
      '<div class="modal-head"><h3>从内置词典导入</h3>' +
      '<button class="modal-close" data-cancel>×</button></div>' +
      '<div class="modal-body">' +
      '<p class="hint">选择一本词典，确认后会一次性导入其中全部单词到单词本。' +
      '已在单词本里的词会自动跳过。</p>' +
      '<ul class="vt-dict-list">' + rows + "</ul>" +
      '<div class="vt-textarea" id="vtDictDetail" style="display:none"></div>' +
      "</div>" +
      '<div class="modal-actions">' +
      '<button class="btn" data-cancel>取消</button>' +
      '<button class="btn primary" id="vtDictConfirm" data-ok disabled>请先选择词典</button>' +
      "</div>"
    );
    if (!modal) return;

    const confirmBtn = modal.modal.querySelector("#vtDictConfirm");
    const detail = modal.modal.querySelector("#vtDictDetail");
    let selected = null;          // {dict, willImport, inBook}

    modal.modal.querySelector("[data-cancel]").addEventListener("click", modal.close);

    // 点某一本词典 → 加载词表 → 显示总数与去重后的可导入数
    function onPick(e) {
      const li = e.target.closest ? e.target.closest("[data-dict]") : null;
      if (!li) return;
      const id = li.getAttribute("data-dict");
      const countEl = li.querySelector("[data-count]");
      // 预载通常已经把词数写好了，这里只在还没拿到时兜底显示「载入中…」。
      // loadBuiltinDict 有 dictCache 兜底，正常走的是微任务级返回，不会有可见等待。
      if (countEl && !countEl.getAttribute("data-loaded")) countEl.textContent = "载入中…";
      selected = null;
      confirmBtn.setAttribute("disabled", "");
      confirmBtn.textContent = "请先选择词典";

      loadBuiltinDict(id).then(function (dict) {
        const pv = previewDictImport(dict.words);
        selected = { dict: dict, willImport: pv.willImport, inBook: pv.inBook };
        if (countEl) {
          countEl.textContent = dict.words.length + " 词" + (dict.placeholder ? "（占位）" : "");
          countEl.setAttribute("data-loaded", "1");
        }
        detail.style.display = "block";
        detail.innerHTML =
          '<b>' + dict.name + "</b> 共 <b>" + dict.words.length + "</b> 词" +
          (dict.placeholder ? "（<b>占位词表</b>，正式版会补全）" : "") +
          "<br>其中 <b>" + pv.willImport.length + "</b> 个可导入，" +
          "<b>" + pv.inBook.length + "</b> 个已在单词本中会跳过" +
          (pv.invalid && pv.invalid.length ? "，<b>" + pv.invalid.length + "</b> 个格式无效已剔除" : "") +
          (pv.willImport.length
            ? "<br><span class=\"hint\">导入后状态为「新词」，首次复习安排在明天，不会立刻进入今日复习池。</span>"
            : "");
        confirmBtn.removeAttribute("disabled");
        confirmBtn.textContent = pv.willImport.length
          ? ("导入 " + pv.willImport.length + " 个词")
          : "没有可导入的新词";
      }).catch(function (err) {
        if (countEl) {
          countEl.textContent = "加载失败";
          countEl.setAttribute("data-loaded", "");
        }
        detail.style.display = "block";
        detail.innerHTML = '<span style="color:#b91c1c">词典加载失败：' +
          String(err && err.message || err) + "</span>";
      });
    }
    const listEl = modal.modal.querySelector(".vt-dict-list");
    listEl.addEventListener("click", onPick);
    // 打开弹窗就把三本词典的词数拉出来（原来只有点了某本才加载，
    // 列表就一直停在「载入中…」，看着像加载失败）。见 preloadDictCounts 注释。
    preloadDictCounts(listEl);

    // 确认导入
    confirmBtn.addEventListener("click", function () {
      if (!selected || !selected.willImport.length) { modal.close(); return; }
      const r = (typeof VocabBook !== "undefined")
        ? VocabBook.batchAdd(selected.willImport, SRC_DICT)
        : { success: 0, skipped: 0, failed: 0 };

      // 补足今日新词（需求 8）
      const refill = refillTodayNewWords(selected.willImport);

      let msg = "成功导入 " + r.success + " 个词";
      if (r.skipped) msg += "，重复 " + r.skipped + " 个已跳过";
      if (refill.added > 0) msg += "；今日新词已补 " + refill.added + " 个（现共 " + refill.after + " 个）";
      tip(msg);

      modal.close();
      if (typeof renderVocabBookSection === "function") renderVocabBookSection();
    });
  }

  /* ==========================================================================
   * 10. 首页状态栏 / 底部「上次」提示
   * ========================================================================== */

  /** 根据已保存结果刷新首页的词汇量行（顶部状态栏 + 底部按钮下方小字） */
  function renderVocabTestLine() {
    const res = loadResult();
    const line = el("vocabTestLine");
    const hint = el("testLastHint");
    if (res && typeof res.score === "number") {
      if (line) { line.textContent = "📊 词汇量：约 " + res.score + " 词"; line.classList.remove("hidden"); }
      if (hint) { hint.textContent = "上次：约 " + res.score + " 词"; hint.classList.remove("hidden"); }
    } else {
      if (line) line.classList.add("hidden");
      if (hint) hint.classList.add("hidden");
    }
  }

  /* ==========================================================================
   * 11. 页面控制（打开 / 关闭 / 导航）
   * ========================================================================== */

  /**
 * 打开测试页
 *
 * 【本轮改造：从同步变异步】
 * 题库从「同步可用的 WORD_BANK」换成「需 fetch 的 testBank.json」，
 * 所以 open() 必须先 await loadTestBank()。
 *
 * 为什么要 loading 态而不是「先出题、题库回来再换」：
 * 自适应出题依赖「题目难度 = 该词真实层级」，词库没到位就没法算层级 ——
 * 硬出题只能出一套按旧小词库算的难度，估出的词汇量是错的。
 * 而且用户已经看到「第 1/20 题」却等不到题，比明确告知「正在加载」更糟。
 *
 * 降级路径：题库加载失败 → 落回 WORD_BANK（旧的小词库，估算精度差但能测），
 * 并在页面上提示「题库加载失败，已使用精简题库」。静默降级会让用户
 * 以为测的是完整题库，得到的词汇量却系统性偏高。
 *
 * @returns {Promise<void>}
 */
async function open() {
  openToken += 1;
  resetState();
  state.pageToken = openToken;
  const page = pageEl();
  if (page) page.classList.remove("hidden");
  if (typeof document !== "undefined" && document.body) document.body.style.overflow = "hidden";

  renderLoadingView("正在加载题库…");

  let degraded = false;
  try {
    await loadTestBank();
  } catch (e) {
    degraded = true;
  }

  // 竞态保护：await 期间用户可能已经关了页面或又点了一次别的入口
  if (isStaleOpen(openToken)) return;

  state.bank = getBank();
  if (!state.bank.length) {
    renderErrorView("题库加载失败，且没有可用的备用词库。请检查网络后重试。");
    return;
  }
  state.byLayer = groupByLevel(state.bank);
  state.degraded = degraded;

  // 只出第 1 题，后面 19 题随作答逐题生成（这是自适应的前提）
  generateNextQuestion();
  renderQuestionView();
  renderVocabTestLine();
}

/**
 * 打开测试页时递增的令牌：用来识别「await 期间用户已离开/重开」。
 *
 * 场景：用户点开测试页 → 题库还在 fetch → 用户等不及点了返回 →
 * fetch 才回来。如果不校验令牌，旧 open() 会把题渲染到一个已经隐藏的页面上，
 * 并覆盖 state —— 用户再进来时看到的是被上一次残留污染的状态。
 *
 * openToken 声明在模块级常量组（testBankPromise 旁边）而不是 open() 的上一行：
 * let 不提升，写在 open() 上面的话函数体里先读到它会抛 TDZ ReferenceError。
 */
function isStaleOpen(token) {
  return state.pageToken !== token;
}

/** 题库加载中的占位视图（保留底部进度条位置，避免布局跳动） */
function renderLoadingView(text) {
  const b = bodyEl();
  if (b) {
    b.innerHTML = '<div class="vt-loading">' +
      '<div class="vt-loading-text">' + esc(text || "加载中…") + "</div>" +
      '<div class="vt-loading-bar"><span></span></div>' +
      "</div>";
  }
  const f = footerEl();
  if (f) f.innerHTML = '<div class="vt-hint">第 1 题 / 共 ' + TEST_TOTAL + " 题</div>";
}

/** 题库完全不可用时的错误视图（比空白页好：告诉用户发生了什么、能做什么） */
function renderErrorView(text) {
  const b = bodyEl();
  if (!b) return;
  b.innerHTML = '<div class="vt-result">' +
    '<div class="vt-score-title">无法开始测试</div>' +
    '<div class="vt-error-text">' + esc(text) + "</div>" +
    '<div class="vt-result-actions">' +
    '<button class="btn primary" data-vt-retry>重试</button>' +
    '<button class="btn ghost" data-vt-home>返回首页</button>' +
    "</div></div>";
}

/**
 * 题库降级提示条的 HTML 片段。
 *
 * 【为什么返回字符串而不是直接操作 DOM】
 * 旧实现是 `document.createElement` + `b.insertBefore(tip, b.firstChild)`，
 * 但 renderQuestionView 每题都重写 `b.innerHTML` —— 提示条在答第 1 题时插入，
 * 答第 2 题就被抹掉了。用户后面几题看不到「这次测不准」，可能直接采信结果。
 * 现在由 renderQuestionView 内联输出，每一题都带着，不依赖 DOM 操作顺序。
 *
 * @returns {string} 非降级时返回空串
 */
function renderBankNoticeHtml() {
  if (!state.degraded) return "";
  return '<div class="vt-bank-notice">题库加载失败，正在使用<b>精简题库</b>（' +
    ((typeof WORD_BANK !== "undefined" && WORD_BANK.length) || 0) + ' 词）。' +
    "估算结果会明显偏高，建议检查网络后重测。</div>";
}

  /** 关闭测试页（不保存未完成结果） */
  function close() {
    resetState();
    const page = pageEl();
    if (page) page.classList.add("hidden");
    if (typeof document !== "undefined" && document.body) document.body.style.overflow = "";
  }

  /** 返回首页（关闭 + 滚到顶部） */
  function goHome() {
    close();
    if (typeof window !== "undefined") window.scrollTo(0, 0);
  }

  /** 去单词本看看（关闭 + 切到单词本区块） */
  function goBook() {
    close();
    if (typeof DailyApp !== "undefined" && DailyApp.scrollToSection) DailyApp.scrollToSection("book");
  }

  /* ==========================================================================
   * 12. 事件绑定与初始化
   * ========================================================================== */

  /** 绑定测试页内部的委托事件（选项 / 不认识 / 返回 / 导入 / 首页 / 单词本） */
  function bindPageEvents() {
    const page = pageEl();
    if (!page || typeof page.addEventListener !== "function") return;
    page.addEventListener("click", function (event) {
      const target = event.target;
      if (!target || !target.closest) return;

      const back = target.closest("[data-vt-back]");
      if (back) { goHome(); return; }

      const opt = target.closest(".vt-opt");
      if (opt && !opt.classList.contains("disabled")) {
        answer(state.index, Number(opt.getAttribute("data-oindex")));
        return;
      }

      // 「不认识」按钮。放在 .vt-opt 判断之后 —— 两者互斥，
      // 但先判选项可以让高频路径（点选项）少一次 closest 查找。
      const unk = target.closest("[data-vt-unknown]");
      if (unk && !unk.classList.contains("disabled")) {
        answerUnknown(state.index);
        return;
      }

      const importBtn = target.closest("[data-vt-import]");
      if (importBtn) { importWrong(); return; }

      const bookBtn = target.closest("[data-vt-book]");
      if (bookBtn) { goBook(); return; }

      const homeBtn = target.closest("[data-vt-home]");
      if (homeBtn) { goHome(); return; }

      const batchBtn = target.closest("[data-vt-batch]");
      if (batchBtn) { openBatchImport(); return; }
    });
  }

  /**
   * 绑定键盘快捷键（1-4 选项 / 空格 = 不认识）。
   *
   * 需求原文说「原来 1-4 对应四个选项，空格 = 不认识」，但实测本项目此前
   * 没有任何键盘绑定，所以两组键都是这次一并新建的。
   *
   * 挂在 document 上而不是 page 上：测试页是 .hidden 控制的，
   * 事件目标（body）落在 page 之外，绑 page 收不到键盘事件。
   * 所以改用「检查测试页是否可见」来 gate：
   *   ① page 存在且没有 .hidden
   *   ② 还没结算（结果页按 1-4/空格没意义）
   *   ③ 焦点不在输入控件里（批量导入弹窗的 textarea / 词典搜索框）
   */
  function bindKeys() {
    if (typeof document === "undefined" || !document.addEventListener) return;
    document.addEventListener("keydown", function (event) {
      const page = pageEl();
      if (!page || page.classList.contains("hidden")) return;
      if (state.finished) return;
      const t = event.target;
      const tag = (t && t.tagName ? t.tagName : "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (t && t.isContentEditable) return;

      // 空格 = 不认识。用 event.key 判 " "（不是 keyCode 32），
      // 兼容布局；顺手 preventDefault 挡掉页面滚动。
      if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        answerUnknown(state.index);
        return;
      }
      // 1-4 → 对应选项。用 KEY_OPTION_MAP 表，未列出的键不响应。
      const idx = KEY_OPTION_MAP[event.key];
      if (idx !== undefined) {
        event.preventDefault();
        answer(state.index, idx);
      }
    });
  }

  /** 初始化：绑定单词本批量导入入口 + 渲染词汇量行（只跑一次） */
  function init() {
    if (inited) return;
    inited = true;

    // 首页底部「📊 测词汇量」按钮的绑定放在 app.js 的 bindEvents 里
    // （避免与 app.js 的底部栏按钮绑定逻辑分散；app.js 调用 VocabTest.open）

    // 单词本页「批量导入」入口（按钮在 vocabBookUI 的统栏里渲染，用委托挂到单词本容器）
    const bookBox = el("vocabBookBody");
    if (bookBox && typeof bookBox.addEventListener === "function") {
      bookBox.addEventListener("click", function (event) {
        const target = event.target;
        if (target && target.closest && target.closest("[data-vt-batch]")) openBatchImport();
      });
    }

    bindPageEvents();
    bindKeys();
    renderVocabTestLine();
  }

  /* ==========================================================================
   * 13. 对外 API
   * ========================================================================== */

  return {
    init: init,
    open: open,
    close: close,
    goHome: goHome,
    goBook: goBook,
    importWrong: importWrong,
    openBatchImport: openBatchImport,
    openDictImport: openDictImport,
    renderVocabTestLine: renderVocabTestLine,
    // 公开读取入口：app.js 的难度适配要拿词汇量（score）来定 prompt 难度。
    // 必须挂在顶层而不是只留在 _test 里，否则生产环境 VocabTest.loadResult 是
    // undefined，getVocabSize 会永远返回 null，难度适配静默失效。
    loadResult: loadResult,
    // 自测内部接口
    _test: {
      // --- 自适应出题常量（调参全在这里） ---
      ALGORITHM_VERSION: ALGORITHM_VERSION,
      LAYER_COUNT: LAYER_COUNT,
      LAYER_SPAN: LAYER_SPAN,
      LAYER_BOUNDS: LAYER_BOUNDS,
      LAYER_VOCAB: LAYER_VOCAB,
      START_LAYER: START_LAYER,
      STEP_CORRECT: STEP_CORRECT,
      STEP_WRONG: STEP_WRONG,
      STEP_UNKNOWN: STEP_UNKNOWN,
      STABLE_THRESHOLD: STABLE_THRESHOLD,
      W_CORRECT: W_CORRECT,
      W_WRONG: W_WRONG,
      W_UNKNOWN: W_UNKNOWN,
      TARGET_RATE: TARGET_RATE,
      ERROR_MARGIN: ERROR_MARGIN,
      VOCAB_MAX: VOCAB_MAX,
      VOCAB_MIN: VOCAB_MIN,
      // --- 旧常量已随算法废弃（PER_LEVEL / LEVELS / UNKNOWN_CREDIT 不再导出）---
      TEST_TOTAL: TEST_TOTAL,
      DELAY_CORRECT: DELAY_CORRECT,
      DELAY_WRONG: DELAY_WRONG,
      DELAY_UNKNOWN: DELAY_UNKNOWN,
      ANSWER_UNKNOWN: ANSWER_UNKNOWN,
      KEY_OPTION_MAP: KEY_OPTION_MAP,
      STORAGE_KEY: STORAGE_KEY,
      levelOf: levelOf,
      groupByLevel: groupByLevel,
      advanceLayer: advanceLayer,
      pickWordForLayer: pickWordForLayer,
      buildAdaptiveQuestion: buildAdaptiveQuestion,
      generateNextQuestion: generateNextQuestion,
      stepDifficulty: stepDifficulty,
      highestCorrectLayer: highestCorrectLayer,
      buildOneQuestion: buildOneQuestion,
      computeScore: computeScore,
      encouragement: encouragement,
      parseBatchText: parseBatchText,
      BUILTIN_DICTS: BUILTIN_DICTS,
      SRC_DICT: SRC_DICT,
      STORAGE_KEY_PACK: STORAGE_KEY_PACK,
      DAILY_NEW_TARGET: DAILY_NEW_TARGET,
      loadBuiltinDict: loadBuiltinDict,
      preloadDictCounts: preloadDictCounts,
      loadTestBank: loadTestBank,
      getBank: getBank,
      isStaleOpen: isStaleOpen,
      previewDictImport: previewDictImport,
      refillTodayNewWords: refillTodayNewWords,
      loadResult: loadResult,
      saveResult: saveResult,
      applyAnswer: applyAnswer,
      answer: answer,
      answerUnknown: answerUnknown,
      scheduleNext: scheduleNext,
      finish: finish,
      resetState: resetState,
      getState: function () { return state; },
      doImportWrong: doImportWrong,
      renderResultView: renderResultView,
      renderQuestionView: renderQuestionView,
      renderBankNoticeHtml: renderBankNoticeHtml
    }
  };
})();

if (typeof window !== "undefined") {
  window.VocabTest = VocabTest;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = VocabTest;
}

// DOM 环境下自动初始化
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", function () { VocabTest.init(); });
}
