/**
 * ai.js
 * AI 新闻背单词 H5 应用 —— AI 调用模块
 *
 * 全局对象：AICaller
 * 分模型调用：
 *   Prompt 0 单词标准化   → DeepSeek Flash（快、便宜）
 *   Prompt 1 新闻改写     → 智谱 GLM-5.2（质量要求高）
 *   Prompt 2 词汇应用段   → DeepSeek Flash
 *   Prompt 3 检测题出题   → 智谱 GLM-5.2（格式要求高）
 *
 * 设计要点：
 *   1. 配置集中在顶部 AI_CONFIG，用户填好 API Key 即可切换成真实调用
 *   2. 没有 Key 或调用失败时，自动降级到本地兜底生成（mock），页面不会崩
 *   3. 所有函数返回 Promise，失败也不抛异常，统一返回带 ok / source / error 字段的结果
 */

/* ==========================================================================
 * 1. AI 配置（用户在此填写自己的 Key 与模型名）
 * ========================================================================== */

const AI_CONFIG = {
  // DeepSeek（OpenAI 兼容接口）
  deepseek: {
    apiKey: "sk-9697e8dbd7e04581b2c5498e8412c551",                                        
// ← 填你的 DeepSeek API Key
    baseUrl: "https://api.deepseek.com/chat/completions",
    proxyPath: "/deepseek/chat/completions",
    model: "deepseek-chat",                            // DeepSeek Flash 档（快、便宜）
    temperature: 0.3
  },

  // 智谱 GLM（OpenAI 兼容接口）
  zhipu: {
    apiKey: "a7801d328e8f4e3b8bef2d157c88b54a.ctbingiZ8pSCAiOS",                                        // ← 填你的智谱 API Key
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    proxyPath: "/zhipu/api/paas/v4/chat/completions",
    model: "glm-5.2",                                  // GLM-5.2（质量优先）
    temperature: 0.7
  },

  // 通用参数
  // 后续是「固定时间点预生成」模式，用户全程无感知，花几分钟无所谓，
  // 关键是最终能成功，所以单次请求给足 120 秒，不要因为慢就降级。
  timeoutMs: 120000,        // 单次请求超时（毫秒）
  maxRetries: 1,            // 单次失败后自动重试 1 次，再失败才降级
  retryDelayMs: 1500,       // 重试前的等待（毫秒），给服务端喘口气
  enableMockFallback: true, // 没 Key 或最终失败时，该模块用本地兜底（各模块独立判断）
  verboseLog: true,         // 控制台打印每个模块的耗时与状态，便于排查性能瓶颈

  // 本地代理：解决预览环境的 CSP 拦截
  // 预览面板的页面由服务端下发 CSP 响应头，connect-src 只允许 'self' 和 127.0.0.1:*，
  // 直连两家 API 会被拦。CSP 多策略取交集，页面 <meta> 只能更严不能更松，改不了，
  // 所以让请求先打到同机的代理（命中白名单），代理再转发到真实 API。
  // 代理没起就自动直连，功能不受影响。
  proxy: {
    enabled: true,                    // 关掉就永远直连
    baseUrl: "http://127.0.0.1:8787", // 与 proxy_server.py 的端口保持一致
    healthPath: "/health",
    probeTimeoutMs: 1500
  }
};

/* ==========================================================================
 * 2. 四个 Prompt（质量优化版）
 * ========================================================================== */

/**
 * Prompt 0：单词标准化 → DeepSeek Flash（第三版定稿）
 * 把用户随手输入的词条整理成标准结构
 * 输出为纯文本：每行 "单词 - 词性 - 中文释义"
 */
function buildPromptStandardize(rawWords) {
  const raw = Array.isArray(rawWords) ? rawWords.join("; ") : String(rawWords);
  return `你是一位英语词汇编辑。请将用户输入的单词整理成标准格式，补全词性和中文释义。保持专业、简洁的语气，不要有多余的寒暄和解释。
【输入】
${raw}
（可能是纯单词列表，也可能是带词性/释义的不完整格式，可能有拼写错误，可能是词的变形形式）
【处理规则】
1. 提取所有英文单词，去重
2. 如果输入的是词的变形形式（如过去式、复数、分词），还原为词根/原形
3. 每个单词给出最常用的 1 个词性和 1-2 个中文释义
4. 词性标注：n.（名词）v.（动词）adj.（形容词）adv.（副词）prep.（介词）conj.（连词）
5. 释义优先选择专四范围内的常用义，不要太偏门
6. 如果是多词性多义词，优先给出最常见的那个词性和释义
7. 如果单词拼写存疑，给出你认为最可能的正确拼写，并在后面标注（疑似）
【输出格式】
（每行一个，格式严格如下）
单词 - 词性 - 中文释义
【重要】只输出单词列表，不要输出任何额外解释。`;
}

/**
 * 把目标词渲染成 Prompt 要求的 "单词 - 词性 - 中文释义" 行
 * @param {Array<Object|string>} words
 * @returns {string}
 */
function formatWordLines(words) {
  return (words || []).map(function (w) {
    const word = typeof w === "string" ? w : (w && w.word);
    const pos = (w && w.pos) ? w.pos : "";
    const meaning = (w && w.meaning) ? w.meaning : "";
    return [word, pos, meaning].filter(function (x) { return String(x || "").trim(); }).join(" - ");
  }).filter(Boolean).join("\n");
}

/**
 * Prompt 1：新闻改写 → 智谱 GLM-5.2（第三版定稿）
 * 输出 markdown 分节：## 改写版 / ## 未覆盖单词 / ## 原文
 *
 * @param {Array} targetWords 今日目标词
 * @param {Object} newsArticle 新闻对象 {title, content, topic}
 * @param {Object} [opts]
 * @param {number} [opts.vocabSize] 学习者估计词汇量（来自词汇量测试）。
 *        没有就不传 —— 此时退回固定的「中级（专四水平）」设定。
 *        传了才按 90-95% 已知词 / 5-10% 目标词 / 0-2 超纲词的比例来约束改写。
 */
function buildPromptRewriteNews(targetWords, newsArticle, opts) {
  const words = formatWordLines(targetWords);
  const article = "标题：" + newsArticle.title + "\n\n" + newsArticle.content;
  return `你是资深英语新闻编辑兼二语习得专家。请将这篇真实新闻改写为英语学习材料。保持专业、严谨的编辑语气，不要有多余的寒暄和解释。
【任务目标】
让英语中级学习者在真实语境里认识今天的目标词汇，同时读到一篇完整、真实、可信的新闻。事实第一，词汇第二，绝不牺牲准确性。
【目标词汇】
${words}
【原文】
${article}
【改写规则】
1. 事实准确性第一（最高优先级）：
- 人名、机构名、地名、数字、时间、因果逻辑必须与原文一致
- 不得添加原文没有的信息，不得改变事件性质、影响范围或因果关系
- 不确定的细节宁可模糊表述（如 "about 40%" 而非 "39.7%"），不可编造
2. 优先自然地把目标词写进报道语境
- 目标词可以根据语法需要变化词形（时态、单复数、词性转换），不必强行用原形，加粗词根部分即可
- 目标词的语法位置要自然，不能生硬堆砌
- 不适合融入的单词不要硬塞，列在“未覆盖单词”里
3. 语言难度：${difficultyDirective(opts && opts.vocabSize)}
4. 篇幅控制：
- 改写后 200-260 词（英文），4-5 段
- 每段只讲一层意思，段首用一句话点明该段要点
5. 专有名词、数字、日期、机构名照抄原文，不要替换成同义词
【输出格式】
## 改写版
（改写后的全文，目标词用 **加粗** 标记）
## 未覆盖单词
（未能自然融入的目标词，每行一个，格式为：单词 - 词性 - 中文释义；如果没有就写“无”）
## 原文
（附原文，供学习者对照）`;
}

/**
 * 难度指令：按学习者词汇量生成。
 *
 * 核心是「可读性预算」——改写后的文章里，
 *   已知词（学习者会）      约 90-95%
 *   目标词（今天要学的）    约  5-10%
 *   超纲词（谁都不会）      0-2 个封顶
 * 只有目标词是「生词」，其余必须是用户已掌握的，
 * 这样用户能靠上下文猜懂目标词，而不是被满篇难词淹没。
 *
 * @param {number} [vocabSize] 估计词汇量；缺失时用固定的中级设定
 * @returns {string} 插到 prompt 第 3 条里的难度描述
 */
function difficultyDirective(vocabSize) {
  // 通用子项：两种模式都要有，所以放在这里而不是 prompt 模板里。
  // （之前它们写在「3. 语言难度：」下面，预算段落插进来后子项被挤到段落末尾，
  //   读起来像属于规则 4，所以整体收进本函数，让第 3 条自包含。）
  const GENERIC = [
    "- 句式以简单句和并列句为主，允许少量定语从句",
    "- 单句一般不超过 25 词",
    "- 保留新闻报道语气：客观第三人称，可保留 1-2 句直接引语"
  ];

  // 没有词汇量数据（或数据异常）：退回原来的固定描述，保持老行为
  if (typeof vocabSize !== "number" || !isFinite(vocabSize) || vocabSize <= 0) {
    return ["中级（专四水平）"].concat(GENERIC).join("\n");
  }

  // 按词汇量分档。band.ceil 是"其余词汇"的选取上限，
  // 数字对齐 vocabTest.js 的 LEVEL_BOUNDS = [1000, 3000, 5000, 8000, 12000]
  const band =
    vocabSize < 1500 ? { name: "初中级，CEFR A2-B1", ceil: 1500, extra: "非常日常的词", share: "8-12%" } :
    vocabSize < 3000 ? { name: "初中级偏上，CEFR B1", ceil: 3000, extra: "常见的日常词", share: "8-12%" } :
    vocabSize < 5000 ? { name: "中级，接近专四", ceil: 5000, extra: "中等词汇", share: "5-10%" } :
    vocabSize < 8000 ? { name: "中级偏上，接近专六", ceil: 8000, extra: "较正式的书面词", share: "5-10%" } :
    vocabSize < 12000 ? { name: "中高级，CEFR B2-C1", ceil: 12000, extra: "正式书面词", share: "3-8%" } :
    { name: "高级，CEFR C1", ceil: Infinity, extra: "专业与正式词汇", share: "3-8%" };

  // 词汇量越高，目标词占比越低（学习者已掌握的词更多），
  // 但比例区间不宜收得太窄，否则模型会为凑数字而生造生僻词。
  // 注意拼接后的空格：中文里数字与"词水平"之间要留一个空格，读起来才自然
  const ceilText = isFinite(band.ceil) ? band.ceil + " 词水平" : "该学习者水平";

  return [
    "面向词汇量约 " + vocabSize + " 词的学习者，水平为" + band.name + "。",
    "",
    "改写后的文章必须满足以下可读性预算，这是硬性要求：",
    "",
    "1) 已知词占绝大多数（约九成以上）：",
    "   除目标词外，全文只能用" + band.extra + "来写。",
    "   凡是超出" + ceilText + "的表达，请换成更简单的说法。",
    "",
    "2) 目标词（上面列出的那些）占 " + band.share + "：",
    "   每个目标词都要出现 1-2 次，词形可按语法需要变化。",
    "",
    "3) 超纲词最多 2 个：",
    "   原文中自带的生僻专有名词（人名、机构、术语）可以照抄，",
    "   但不要额外引入任何学习者不可能认识的词。",
    "",
    "自检：写完后数一遍实词，确认除目标词外，其余都是" + ceilText +
    "以内的常用词。如果某一句里有两个以上生词，请把这句换得更简单。",
    "",
    "另外，句式上仍需注意："
  ].concat(GENERIC).join("\n");
}

/**
 * Prompt 2：词汇应用段 → DeepSeek Flash（第三版定稿）
 * 用新闻没覆盖到的词，写一段贴近日常语境的短文
 */
function buildPromptVocabParagraph(topic, remainingWords) {
  const words = formatWordLines(remainingWords);

  return `你是英语写作教师。请写一段短文，把下面这些单词自然地用出来。保持专业、简洁的教师语气，不要有多余的寒暄和解释。
【背景】
这些单词来自今天的新闻，主题是：${topic}
【必须使用】
${words}
【写作要求】
1. 体裁：生活化随笔或小议论，和上面的主题相关即可
2. 篇幅：120-180 词（英文），2-3 段
3. 每个单词都要自然出现一次，用 **加粗** 标记
4. 语境要具体：给出人物、场景、细节，让词在句子里“有画面”，不要写成词典例句
5. 难度：中级；每句一般不超过 25 词
6. 单词可以根据语法需要变化词形，加粗词根部分即可
【输出格式】
（只输出短文正文，不要标题，不要编号，不要任何解释。）`;
}

/**
 * Prompt 3：检测题出题 → 智谱 GLM-5.2（第三版定稿）
 * 输出 markdown 分节 + 末尾答案
 */
function buildPromptQuiz(todayWords) {
  const list = formatWordLines(todayWords);

  return `你是英语测评专家。请基于下面的今日单词，生成一套检测题。保持专业、严谨的测评专家语气，不要有多余的寒暄和解释。
【今日单词】
${list}
【题型一：词义回忆题】
1. 数量：覆盖所有今日单词，每个单词一题
2. 题干：给出英文单词（加粗）
3. 选项：4 个中文释义选项（A/B/C/D）
4. 干扰项要求：
- 与正确答案语义相近，容易混淆
- 或与题干单词同词性、同主题
- 但必须有明确区分度，不能模棱两可
- 避免明显荒谬的选项（如"苹果"这种凑数项）
5. 正确答案位置随机分布，不要总是 A
【题型二：语境填空题】
1. 数量：5 题
2. 题目：一个英文句子，句中目标词用 ____ 挖空
3. 选项：4 个英文单词（A/B/C/D）
   - 正确答案必须是今日单词表里的词
   - 3 个干扰项中，至少 2 个来自今日单词表；今日单词表以外的干扰词最多 1 个
   - 那个今日单词表以外的干扰词必须是四级以内的常见基础词（如 inspection、compare），不要生僻词
4. 句子要求：
- 长度 15-30 词
- 语境清晰，有足够的线索让学习者通过上下文推断
- 体现该词的典型搭配或用法
- 不要写成词典例句，要有真实语境感
【题型三：主动词汇推荐】
1. 数量：从今日单词中推荐 3 个
2. 标准：
- 口语和写作中都高频、通用
- 搭配能力强，学了马上能用
- 不是生僻词，也不是太简单的词
3. 每条给出一句推荐理由，说明为什么值得主动使用
【输出格式】
## 一、词义回忆题
1. **diligent**
A. 勤奋的
B. 懒惰的
C. 昂贵的
D. 危险的
2. **resilient**
A. 有弹性的
B. 脆弱的
C. 昂贵的
D. 危险的
（以此类推，覆盖所有单词）
## 二、语境填空题
1. She is very ____ and always finishes her work on time.
A. diligent
B. ambiguous
C. inevitable
D. threshold
（以此类推，共 5 题）
## 三、主动词汇推荐
- **resilient**：口语和写作中都很常用，描写人或组织的抗压和恢复能力，搭配 能力强，学了马上能用。
（共 3 条）
【答案】
词义回忆题：1.A 2.A 3.B …
语境填空题：1.A 2.C 3.D 4.B 5.A`;
}

/* ==========================================================================
 * 3. 底层请求封装
 * ========================================================================== */

/**
 * 判断某个服务商是否已配置 API Key
 * @param {Object} provider AI_CONFIG 里的服务商配置
 * @returns {boolean}
 */
function hasApiKey(provider) {
  return !!(provider && provider.apiKey && String(provider.apiKey).trim());
}

/** 控制台日志（可用 AI_CONFIG.verboseLog 关掉） */
function aiLog(message, extra) {
  if (!AI_CONFIG.verboseLog) return;
  if (typeof console === "undefined" || typeof console.log !== "function") return;
  if (extra !== undefined) console.log("[AI] " + message, extra);
  else console.log("[AI] " + message);
}

/**
 * 打印单个模块的生成耗时与状态
 * @param {string} moduleName 模块名（用于日志）
 * @param {string} status api | mock | failed
 * @param {number} durationMs 耗时
 * @param {string} [note] 备注（错误信息等）
 */
function logModuleResult(moduleName, status, durationMs, note) {
  const sec = ((durationMs || 0) / 1000).toFixed(1) + "s";
  const label = status === "api" ? "成功" : (status === "mock" ? "降级" : "失败");
  aiLog(moduleName + " → " + label + "（" + sec + "）" + (note ? " · " + note : ""));
}

/**
 * 判断一次失败是否值得重试
 * 鉴权和参数类错误重试也没用，直接走降级；其余（网络、超时、5xx、429）都重试
 * @param {{error?:string}} res
 * @returns {boolean}
 */
function isRetryable(res) {
  if (!res || !res.error) return false;
  const msg = String(res.error);
  const httpMatch = msg.match(/^HTTP\s+(\d+)/);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    // 400/401/403/404/422：请求本身有问题，重试不会变好
    if (code === 400 || code === 401 || code === 403 || code === 404 || code === 422) return false;
    return true;                       // 429 限流、5xx 服务端错误都值得重试
  }
  return true;                         // 网络错误 / 超时 / 中断
}

/** 代理探测结果（一次会话只探一次） */
const proxyState = { checked: false, available: false };

/**
 * 探测本地代理是否可用
 * @returns {Promise<boolean>}
 */
async function detectProxy() {
  if (proxyState.checked) return proxyState.available;
  proxyState.checked = true;

  const cfg = AI_CONFIG.proxy;
  if (!cfg || !cfg.enabled || typeof fetch !== "function") {
    proxyState.available = false;
    return false;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, cfg.probeTimeoutMs || 1500);
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, "") + cfg.healthPath, {
      method: "GET",
      signal: controller.signal
    });
    clearTimeout(timer);
    proxyState.available = !!res.ok;
  } catch (e) {
    proxyState.available = false;                 // 没起代理 / 被拦 → 直连
  }

  aiLog("本地代理探测：" + (proxyState.available
    ? "可用（" + AI_CONFIG.proxy.baseUrl + "），请求走代理绕过 CSP"
    : "不可用，直连 API（如被 CSP 拦截，请运行 proxy_server.py）"));
  return proxyState.available;
}

/**
 * 取本次请求要打的地址：代理可用就用代理，否则直连
 * @param {Object} provider
 * @returns {Promise<string>}
 */
async function resolveEndpoint(provider) {
  const useProxy = await detectProxy();
  if (useProxy && provider && provider.proxyPath) {
    return AI_CONFIG.proxy.baseUrl.replace(/\/+$/, "") + provider.proxyPath;
  }
  return provider.baseUrl;
}

/**
 * 发起一次聊天补全请求（OpenAI 兼容格式，非流式）
 * @param {Object} provider 服务商配置
 * @param {string} userPrompt 用户提示词
 * @param {Object} [options] 单次调用覆盖项 { timeoutMs, ... }
 * @returns {Promise<{ok:boolean, text?:string, error?:string, durationMs:number, viaProxy?:boolean}>}
 */
async function requestChatOnce(provider, userPrompt, options) {
  const started = Date.now();

  if (typeof fetch !== "function") {
    return { ok: false, error: "当前环境不支持 fetch", durationMs: 0 };
  }

  // 超时默认取全局配置；查词这类需要快的调用可以传 options.timeoutMs 覆盖
  const timeoutMs = (options && options.timeoutMs) || AI_CONFIG.timeoutMs || 120000;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);

  const url = await resolveEndpoint(provider);
  const viaProxy = !!(await detectProxy()) && !!provider.proxyPath;

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + provider.apiKey
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: provider.temperature,
        stream: false,
        messages: [
          { role: "system", content: "You are a precise assistant that follows format instructions strictly." },
          { role: "user", content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      return { ok: false, error: "HTTP " + response.status + " " + response.statusText, durationMs: Date.now() - started };
    }

    const data = await response.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";

    if (!text) return { ok: false, error: "返回结果为空", durationMs: Date.now() - started, viaProxy: viaProxy };
    return { ok: true, text: text, durationMs: Date.now() - started, viaProxy: viaProxy };
  } catch (err) {
    const isAbort = err && (err.name === "AbortError" || /abort/i.test(String(err.message)));
    return {
      ok: false,
      error: isAbort ? "请求超时（" + Math.round(timeoutMs / 1000) + "s）" : ((err && err.message) ? err.message : String(err)),
      durationMs: Date.now() - started,
      viaProxy: viaProxy
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带重试的请求：失败后自动重试 maxRetries 次，仍失败才返回失败
 * @param {Object} provider 服务商配置
 * @param {string} userPrompt 用户提示词
 * @param {string} [moduleName] 模块名（日志用）
 * @param {Object} [options] 覆盖项 { timeoutMs, maxRetries, retryDelayMs }
 * @returns {Promise<{ok:boolean, text?:string, error?:string, durationMs:number, attempts:number}>}
 */
async function requestChat(provider, userPrompt, moduleName, options) {
  const maxRetries = (options && options.maxRetries !== undefined)
    ? Number(options.maxRetries)
    : (Number(AI_CONFIG.maxRetries) || 0);
  const retryDelay = (options && options.retryDelayMs !== undefined)
    ? Number(options.retryDelayMs)
    : (Number(AI_CONFIG.retryDelayMs) || 0);
  const totalStarted = Date.now();
  let last = null;
  let attempts = 0;

  for (let i = 0; i <= maxRetries; i++) {
    attempts = i + 1;
    last = await requestChatOnce(provider, userPrompt, options);
    if (last.ok) {
      last.attempts = attempts;
      last.durationMs = Date.now() - totalStarted;
      return last;
    }
    if (i < maxRetries && isRetryable(last)) {
      // 走代理还失败，多半是代理挂了 —— 这次重试改直连，别浪费机会
      if (last.viaProxy) {
        proxyState.available = false;
        aiLog("代理请求失败，重试改为直连 API");
      }
      aiLog((moduleName || "请求") + " 第 " + attempts + " 次失败：" + last.error +
        "，" + Math.round(retryDelay / 1000) + "s 后重试");
      await sleep(retryDelay);
    } else {
      break;                                  // 不可重试的错误，直接放弃
    }
  }

  last.attempts = attempts;
  last.durationMs = Date.now() - totalStarted;
  return last;
}

/** 等待指定毫秒 */
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * 判断当前是否处于离线状态。
 *
 * 为什么单独抽一个函数而不是在调用处内联判断：
 * 离线时的**用户体验**和有网但 AI 挂了完全不同 ——
 * 有网但服务挂了，用户重试一下可能就好了；离线则是「网络就没了」，
 * 提示语要说清楚「等有网自动就好」而不是「请检查 API Key」。
 *
 * @returns {boolean} true 表示确定离线；false 表示在线或无法判断
 */
function isOffline() {
  // navigator.onLine 是浏览器给的提示值：
  //   false → 一定离线（没连任何网络）
  //   true  → 只代表「有网络连接」，不代表真的能访问外网（连上了但没流量、
  //           或者 DNS 挂了都会是 true）。所以它只能用来判断「确定离线」。
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return false;
  return navigator.onLine === false;
}

/**
 * 给用户的离线提示文案。
 * 单独抽出来是为了让 UI 层能直接用这个字符串，不在多处重复写。
 * @returns {string}
 */
function offlineNotice() {
  return "当前处于离线状态，AI 新闻生成不可用。已切换到本地兜底内容，" +
         "单词本、刷词、词汇量测试等离线功能可正常使用；恢复网络后点「换一篇」即可生成新的 AI 新闻。";
}

/**
 * 统一的模块调用壳：计时 → 重试 → 解析 → 单模块降级
 *
 * 每个模块独立走完这条链路，一个模块失败只降级它自己，
 * 不影响其它模块继续用真实 AI 结果（分模块降级，不是整体回退）。
 *
 * 【离线短路】请求前先看navigator.onLine：确定离线时**直接降级**，
 * 不发请求也不重试。原因：离线时 fetch 会立刻失败，
 * 但 AI_CONFIG.maxRetries > 0 会白白重试一轮（每次都要等超时），
 * 用户点了「换一篇」后要卡十几秒才看到结果。短路后是秒回。
 *
 * @param {string} moduleName 模块名（日志用）
 * @param {Object} provider 服务商配置
 * @param {Function} buildPrompt () => string
 * @param {Function} parseFn (text) => any
 * @param {Function} validateFn (parsed) => boolean 结果是否可用
 * @param {Function} fallback () => any 本地兜底
 * @returns {Promise<{ok:boolean, source:string, data:any, error?:string, offline?:boolean, durationMs:number, attempts:number}>}
 */
async function runAIModule(moduleName, provider, buildPrompt, parseFn, validateFn, fallback) {
  const started = Date.now();

  // 离线短路：连Key 都不检查了，反正发出去也到不了。
  // 放在最前面是因为离线时用户的首要诉求是「别卡住」。
  if (isOffline()) {
    const reason = offlineNotice();
    logModuleResult(moduleName, "mock", 0, "离线，跳过请求");
    return {
      ok: true, source: "mock", data: fallback(),
      error: reason, offline: true, durationMs: 0, attempts: 0
    };
  }

  if (!hasApiKey(provider)) {
    logModuleResult(moduleName, "mock", 0, "未配置 API Key");
    return {
      ok: true, source: "mock", data: fallback(),
      error: "未配置 API Key，使用本地兜底", durationMs: 0, attempts: 0
    };
  }

  const prompt = buildPrompt();
  const res = await requestChat(provider, prompt, moduleName);

  if (!res.ok) {
    logModuleResult(moduleName, AI_CONFIG.enableMockFallback ? "mock" : "failed", res.durationMs, res.error);
    if (!AI_CONFIG.enableMockFallback) {
      return { ok: false, source: "api", data: null, error: res.error, durationMs: res.durationMs, attempts: res.attempts };
    }
    return { ok: true, source: "mock", data: fallback(), error: res.error, durationMs: res.durationMs, attempts: res.attempts };
  }

  let parsed = null;
  let parseError = "";
  try {
    parsed = parseFn(res.text);
  } catch (e) {
    parseError = (e && e.message) ? e.message : String(e);
  }
  const valid = !parseError && validateFn(parsed);

  if (!valid) {
    const reason = parseError || "结果解析失败";
    logModuleResult(moduleName, AI_CONFIG.enableMockFallback ? "mock" : "failed", res.durationMs, reason);
    if (!AI_CONFIG.enableMockFallback) {
      return { ok: false, source: "api", data: null, error: reason, durationMs: res.durationMs, attempts: res.attempts };
    }
    return { ok: true, source: "mock", data: fallback(), error: reason, durationMs: res.durationMs, attempts: res.attempts };
  }

  const elapsed = Date.now() - started;
  logModuleResult(moduleName, "api", elapsed, "重试 " + (res.attempts - 1) + " 次");
  return { ok: true, source: "api", data: parsed, durationMs: elapsed, attempts: res.attempts };
}

/**
 * 从模型输出里提取 JSON：先直接解析，失败则尝试剥掉 ```json 代码块
 * @param {string} text
 * @returns {Object|null}
 */
function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1].trim()); } catch (e2) { /* 继续往下走 */ }
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (e3) { return null; }
    }
    return null;
  }
}

/* ==========================================================================
 * 3.5 第三版输出解析（纯文本 / markdown 分节 → 结构化数据）
 * ========================================================================== */

/**
 * 按 "## 标题" 把 markdown 切成 { 标题: 正文 }
 * @param {string} text
 * @returns {Object}
 */
function splitMarkdownSections(text) {
  const result = {};
  const parts = String(text || "").split(/^##\s+([^\n]+?)\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    result[parts[i].trim()] = parts[i + 1] || "";
  }
  return result;
}

/** 从若干候选标题里取第一个命中的分节 */
function pickSection(sections, candidates) {
  for (let i = 0; i < candidates.length; i++) {
    if (sections[candidates[i]] !== undefined) return sections[candidates[i]];
  }
  // 宽松匹配：标题里包含关键字即可
  const keys = Object.keys(sections);
  for (let i = 0; i < candidates.length; i++) {
    const key = candidates[i].replace(/^[一二三四五六七八九十]、/, "");
    for (let j = 0; j < keys.length; j++) {
      if (keys[j].indexOf(key) >= 0) return sections[keys[j]];
    }
  }
  return "";
}

/** 取一段文本里的 **加粗** 内容 */
function extractBold(text) {
  const m = String(text || "").match(/\*\*(.+?)\*\*/);
  return m ? m[1].trim() : "";
}

/**
 * Prompt 0 解析：每行 "单词 - 词性 - 中文释义"
 * @param {string} text
 * @returns {Array<{word:string,pos:string,meaning:string,phonetic:string}>}
 */
function parseStandardize(text) {
  const out = [];
  String(text || "").split(/\r?\n/).forEach(function (line) {
    const line2 = String(line).trim().replace(/^[-*]\s*/, "");
    if (!line2) return;
    const m = line2.match(/^([A-Za-z][A-Za-z\-']*)\s*[-–—]\s*([a-z]+\.?)\s*[-–—]\s*(.+)$/);
    if (!m) return;
    out.push({
      word: m[1].toLowerCase(),
      pos: /\.$/.test(m[2]) ? m[2] : m[2] + ".",
      meaning: m[3].trim().replace(/[（(]疑似[)）].*$/, "").trim(),
      phonetic: ""            // 第三版 Prompt 0 不输出音标
    });
  });
  return out;
}

/**
 * Prompt 1 解析：## 改写版 / ## 未覆盖单词 / ## 原文
 * @param {string} text
 * @returns {{rewritten:string, uncoveredWords:Array<string>}}
 */
function parseRewrite(text) {
  const raw = String(text || "");
  const sections = splitMarkdownSections(raw);
  const rewritten = pickSection(sections, ["改写版", "改写后"]).trim();
  const uncoveredBlock = pickSection(sections, ["未覆盖单词", "未覆盖"]);

  const uncoveredWords = [];
  uncoveredBlock.split(/\r?\n/).forEach(function (line) {
    const t = String(line).trim().replace(/^[-*]\s*/, "");
    if (!t) return;
    if (/^无[。.!！]?$/.test(t)) return;                 // “无”表示全部覆盖
    const head = t.split(/\s+[-–—]\s+/)[0].trim();
    const m = head.match(/[A-Za-z][A-Za-z\-']*/);
    if (m) uncoveredWords.push(m[0].toLowerCase());
  });

  return { rewritten: rewritten || raw.trim(), uncoveredWords: uncoveredWords };
}

/**
 * 解析一个题目块（词义题 / 填空题共用）
 * @param {string} block
 * @returns {Array<{index:number, stem:string, options:Array<string>}>}
 */
function parseQuestionBlock(block) {
  const questions = [];
  let current = null;

  String(block || "").split(/\r?\n/).forEach(function (line) {
    const t = String(line).trim();
    if (!t) return;

    const stemMatch = t.match(/^(\d+)\s*[.、)]\s*(.*)$/);
    if (stemMatch) {
      current = { index: Number(stemMatch[1]), stem: stemMatch[2], options: [] };
      questions.push(current);
      return;
    }
    const optMatch = t.match(/^([A-D])\s*[.、)）]\s*(.*)$/);
    if (optMatch && current) {
      current.options.push(optMatch[2].trim());
      return;
    }
    if (current && !current.options.length) {
      current.stem += " " + t;                          // 题干折行，接回去
    }
  });

  return questions;
}

/**
 * 解析末尾【答案】：词义回忆题：1.A 2.B …
 * @param {string} text
 * @returns {{mq:Object, fq:Object}} 题号 → 选项字母
 */
function parseAnswers(text) {
  const result = { mq: {}, fq: {} };
  String(text || "").split(/\r?\n/).forEach(function (line) {
    const t = String(line).trim();
    if (!t) return;
    const bucket = /词义回忆题|词义题|题型一/.test(t) ? result.mq
      : (/语境填空题|填空题|题型二/.test(t) ? result.fq : null);
    if (!bucket) return;
    const pairs = t.match(/(\d+)\s*[.、)]?\s*([A-D])\b/g) || [];
    pairs.forEach(function (pair) {
      const m = pair.match(/(\d+)\s*[.、)]?\s*([A-D])/);
      if (m) bucket[m[1]] = m[2];
    });
  });
  return result;
}

/** 把字母答案换算成选项文本 */
function letterToOption(options, letter) {
  if (!options || !options.length) return "";
  if (letter && /^[A-D]$/.test(letter)) {
    const idx = letter.charCodeAt(0) - 65;
    if (options[idx] !== undefined) return options[idx];
  }
  if (letter && options.indexOf(letter) >= 0) return letter;   // 模型直接写了选项内容
  return options[0];
}

/** 取今日单词集合（小写），用于填空题选项校验 */
function buildWordSet(todayWords) {
  const set = new Set();
  const list = [];
  (todayWords || []).forEach(function (w) {
    const word = String(typeof w === "string" ? w : (w && w.word) || "").trim().toLowerCase();
    if (!word || set.has(word)) return;
    set.add(word);
    list.push(word);
  });
  return { set: set, list: list };
}

/** 洗牌（Fisher–Yates），用于挑选替换用的随机干扰项 */
function shuffleList(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** 生僻词启发式：过长的超纲词大概率不适合当干扰项，一并替换掉 */
function isLikelyObscure(word) {
  return String(word || "").length >= 12;
}

/**
 * 填空题选项校验
 *   - 正确答案必须是今日单词
 *   - 3 个干扰项里，今日单词表以外的词最多 1 个，且不能太生僻
 *   - 超纲词超量时，用今日单词里的随机词替换
 * @param {Object} q 单道填空题
 * @param {{set:Set, list:Array}} pool 今日单词集合
 * @returns {Object} 校验后的题目
 */
function sanitizeFillOptions(q, pool) {
  if (!pool || !pool.set.size) return q;

  const options = q.options.slice(0, 4);
  let answer = q.answer;

  // 1) 正确答案必须是今日单词：不在词表就换成选项里属于今日单词的那个
  if (!pool.set.has(String(answer || "").toLowerCase())) {
    const inPool = options.filter(function (o) { return pool.set.has(String(o).toLowerCase()); });
    if (inPool.length) answer = inPool[0];
  }

  // 2) 干扰项：今日单词表以外的词最多留 1 个，且不能太长太生僻
  const distractors = options.filter(function (o) { return o !== answer; });
  const outside = distractors.filter(function (o) { return !pool.set.has(String(o).toLowerCase()); });

  const needReplace = [];
  outside.forEach(function (w, i) {
    const keep = i === 0 && !isLikelyObscure(w);       // 只保留第一个、且不算生僻的超纲词
    if (!keep) needReplace.push(w);
  });

  if (needReplace.length) {
    const candidates = shuffleList(pool.list.filter(function (w) {
      return w !== answer && options.indexOf(w) < 0;
    }));
    needReplace.forEach(function (w, i) {
      const idx = options.indexOf(w);
      if (idx < 0) return;
      options[idx] = candidates[i] !== undefined ? candidates[i] : w;
    });
  }

  return {
    id: q.id,
    word: String(answer || "").toLowerCase(),
    sentence: q.sentence,
    options: options,
    answer: answer
  };
}

/** 解析主动词汇推荐块：- **resilient**：理由 */
function parseRecommend(block) {
  const out = [];
  String(block || "").split(/\r?\n/).forEach(function (line) {
    const t = String(line).trim().replace(/^[-*]\s*/, "");
    if (!t) return;
    const m = t.match(/\*\*([A-Za-z][A-Za-z\-']*)\*\*\s*[：:]\s*(.*)$/)
      || t.match(/^([A-Za-z][A-Za-z\-']*)\s*[：:]\s*(.*)$/);
    if (!m) return;
    out.push({ word: m[1].toLowerCase(), reason: m[2].trim() });
  });
  return out;
}

/**
 * Prompt 3 解析：三个分节 + 末尾答案 → 结构化题目
 * @param {string} text
 * @param {Array<Object|string>} [todayWords] 今日单词，用于填空题选项校验
 * @returns {{meaningQuestions:Array, fillQuestions:Array, activeRecommend:Array, answers:Object}}
 */
function parseQuiz(text, todayWords) {
  const raw = String(text || "");
  const sections = splitMarkdownSections(raw);
  const answers = parseAnswers(raw);
  const pool = buildWordSet(todayWords);

  const meaningQuestions = parseQuestionBlock(pickSection(sections, ["一、词义回忆题", "词义回忆题"]))
    .map(function (q, i) {
      const idx = q.index || (i + 1);
      const word = extractBold(q.stem) || (q.stem.match(/[A-Za-z][A-Za-z\-']*/) || [""])[0];
      return {
        id: "mq" + idx,
        word: String(word).toLowerCase(),
        options: q.options,
        answer: letterToOption(q.options, answers.mq[String(idx)])
      };
    })
    .filter(function (q) { return q.options.length >= 2; });

  const fillQuestions = parseQuestionBlock(pickSection(sections, ["二、语境填空题", "语境填空题"]))
    .map(function (q, i) {
      const idx = q.index || (i + 1);
      const answer = letterToOption(q.options, answers.fq[String(idx)]);
      return {
        id: "fq" + idx,
        word: String(answer || "").toLowerCase(),
        sentence: q.stem.replace(/\*\*/g, ""),
        options: q.options,
        answer: answer
      };
    })
    .filter(function (q) { return q.options.length >= 2; })
    .map(function (q) { return sanitizeFillOptions(q, pool); });

  const activeRecommend = parseRecommend(pickSection(sections, ["三、主动词汇推荐", "主动词汇推荐"]));

  const answerMap = {};
  meaningQuestions.forEach(function (q) { answerMap[q.id] = q.answer; });
  fillQuestions.forEach(function (q) { answerMap[q.id] = q.answer; });

  return {
    meaningQuestions: meaningQuestions,
    fillQuestions: fillQuestions,
    activeRecommend: activeRecommend,
    answers: answerMap
  };
}

/* ==========================================================================
 * 4. 本地兜底生成（没有 API Key 或调用失败时使用，保证页面始终可用）
 * ========================================================================== */

const MockAI = {

  /** 兜底：单词标准化（无法查词典，按规则给占位释义） */
  standardizeWords(rawWords) {
    const list = Array.isArray(rawWords)
      ? rawWords
      : String(rawWords || "").split(/[,，;；\n]+/);

    return list
      .map(function (item) {
        const word = String(item || "").trim().toLowerCase().match(/[a-z]+/);
        if (!word) return null;
        return { word: word[0], pos: "n.", meaning: "待补充释义（未配置 API Key）", phonetic: "" };
      })
      .filter(Boolean);
  },

  /**
   * 兜底：新闻改写
   * 直接返回原文，并把目标词报成“未覆盖”，交给词汇段自然覆盖
   * （不在正文末尾罗列单词清单）
   */
  rewriteNews(targetWords, newsArticle) {
    const words = (targetWords || []).map(function (w) { return typeof w === "string" ? w : w.word; });
    return { rewritten: newsArticle.content, uncoveredWords: words.slice() };
  },

  /** 兜底：词汇应用段（模板句，保证每个词都出场） */
  generateVocabParagraph(topic, remainingWords) {
    const words = (remainingWords || []).map(function (w) { return typeof w === "string" ? w : w.word; });
    if (!words.length) return "";
    const sentences = words.map(function (w) {
      return "In a story about " + topic + ", you might say that something is quite " + w +
        ", and your reader would still follow you without a dictionary.";
    });
    return sentences.join(" ") + " Try using one of them in a message today.";
  },

  /** 兜底：检测题（用本地词表造词义题和填空题） */
  generateQuiz(todayWords) {
    const words = (todayWords || []).map(function (w) { return typeof w === "string" ? w : w.word; });
    const meanings = (todayWords || []).map(function (w) { return (w && w.meaning) ? w.meaning : String(w); });

    const meaningQuestions = todayWords.map(function (w, i) {
      const word = typeof w === "string" ? w : w.word;
      const answer = (w && w.meaning) ? w.meaning : String(word);
      const distractors = meanings.filter(function (m, idx) { return idx !== i; })
        .sort(function () { return Math.random() - 0.5; }).slice(0, 3);
      const options = [answer].concat(distractors).sort(function () { return Math.random() - 0.5; });
      return { id: "mq" + (i + 1), word: word, options: options, answer: answer };
    });

    const fillQuestions = words.slice(0, 5).map(function (word, i) {
      const distractors = words.filter(function (x) { return x !== word; })
        .sort(function () { return Math.random() - 0.5; }).slice(0, 3);
      const options = [word].concat(distractors).sort(function () { return Math.random() - 0.5; });
      return {
        id: "fq" + (i + 1),
        word: word,
        sentence: "This situation is best described as ____ in today's reading.",
        options: options,
        answer: word
      };
    });

    const answers = {};
    meaningQuestions.forEach(function (q) { answers[q.id] = q.answer; });
    fillQuestions.forEach(function (q) { answers[q.id] = q.answer; });

    return {
      meaningQuestions: meaningQuestions,
      fillQuestions: fillQuestions,
      activeRecommend: words.slice(0, 3).map(function (w) {
        return { word: w, reason: "通用度高，口语和写作都能用（本地兜底推荐）" };
      }),
      answers: answers
    };
  }
};

/* ==========================================================================
 * 5. 对外 API：AICaller
 * ========================================================================== */

const AICaller = {

  /**
   * Prompt 0：单词标准化 → DeepSeek Flash
   * @param {string|Array} rawWords 原始输入
   * @returns {Promise<{ok:boolean, source:string, data:Array, error?:string}>}
   */
  async standardizeWords(rawWords) {
    return runAIModule(
      "单词标准化(P0/DeepSeek)",
      AI_CONFIG.deepseek,
      function () { return buildPromptStandardize(rawWords); },
      parseStandardize,
      function (data) { return Array.isArray(data) && data.length > 0; },
      function () { return MockAI.standardizeWords(rawWords); }
    );
  },

  /**
   * Prompt 1：新闻改写 → 智谱 GLM-5.2
   * @param {Array} targetWords 今日目标词
   * @param {Object} newsArticle 新闻对象 {title, content, topic}
   * @param {Object} [opts] 额外参数
   * @param {number} [opts.vocabSize] 学习者估计词汇量，用于难度适配；
   *        不传则按固定「中级（专四水平）」生成（保持老行为）
   * @returns {Promise<{ok:boolean, source:string, data:{rewritten:string, uncoveredWords:Array}, error?:string}>}
   */
  async rewriteNews(targetWords, newsArticle, opts) {
    return runAIModule(
      "新闻改写(P1/GLM)",
      AI_CONFIG.zhipu,
      function () { return buildPromptRewriteNews(targetWords, newsArticle, opts); },
      parseRewrite,
      function (parsed) { return !!(parsed && parsed.rewritten); },
      function () { return MockAI.rewriteNews(targetWords, newsArticle); }
    );
  },

  /**
   * Prompt 2：词汇应用段 → DeepSeek Flash
   * @param {string} topic 主题
   * @param {Array} remainingWords 新闻没覆盖到的词
   * @returns {Promise<{ok:boolean, source:string, data:string, error?:string}>}
   */
  async generateVocabParagraph(topic, remainingWords) {
    return runAIModule(
      "词汇应用段(P2/DeepSeek)",
      AI_CONFIG.deepseek,
      function () { return buildPromptVocabParagraph(topic, remainingWords); },
      function (text) { return String(text || "").trim(); },
      function (text) { return !!text; },
      function () { return MockAI.generateVocabParagraph(topic, remainingWords); }
    );
  },

  /**
   * Prompt 3：检测题出题 → 智谱 GLM-5.2
   * @param {Array} todayWords 今日单词
   * @returns {Promise<{ok:boolean, source:string, data:Object, error?:string}>}
   */
  async generateQuiz(todayWords) {
    return runAIModule(
      "检测题出题(P3/GLM)",
      AI_CONFIG.zhipu,
      function () { return buildPromptQuiz(todayWords); },
      function (text) { return parseQuiz(text, todayWords); },
      function (data) { return !!(data && data.meaningQuestions && data.meaningQuestions.length); },
      function () { return MockAI.generateQuiz(todayWords); }
    );
  },

  /**
   * 是否已配置全部 API Key（页面可据此提示用户）
   * @returns {{deepseek:boolean, zhipu:boolean}}
   */
  /**
   * 本地代理（proxy_server.py）是否可用。
   * 供 UI 决定要不要给「AI 服务未启动，请运行 proxy_server.py」的降级提示。
   * 一个会话只探测一次，结果会缓存，不会反复发请求。
   * @returns {Promise<boolean>}
   */
  isProxyAvailable() {
    return detectProxy();
  },

  /**
   * 取配置状态：哪个 provider 有 Key、本地代理是否在线
   * @returns {{deepseek:boolean, zhipu:boolean}}
   */
  getConfigStatus() {
    return { deepseek: hasApiKey(AI_CONFIG.deepseek), zhipu: hasApiKey(AI_CONFIG.zhipu) };
  },

  /**
   * 当前是否处于离线状态（true = 确定离线，false = 在线或判断不了）
   * @returns {boolean}
   */
  isOffline() {
    return isOffline();
  },

  /**
   * 面向用户的离线提示文案。UI 层直接取这个字符串，不要在别处重复写。
   * @returns {string}
   */
  offlineNotice() {
    return offlineNotice();
  }
};

/**
 * 供其它模块复用底层能力的内部出口
 * js/dictionary.js（点击查词）用它发请求，从而自动享有：
 * 代理探测（绕 CSP）、超时、重试、日志，不必自己再写一套 fetch
 */
const AI_INTERNAL = {
  requestChat: requestChat,
  extractJson: extractJson,
  hasApiKey: hasApiKey,
  sleep: sleep
};

// 调试用：把 Prompt 构造与解析函数暴露出来，方便在控制台/自测里单测
const AI_DEBUG = {
  buildPromptStandardize: buildPromptStandardize,
  buildPromptRewriteNews: buildPromptRewriteNews,
  // 单独暴露难度指令，方便调 prompt 时直接看各档位输出（不用构造整段 prompt）
  difficultyDirective: difficultyDirective,
  buildPromptVocabParagraph: buildPromptVocabParagraph,
  buildPromptQuiz: buildPromptQuiz,
  parseStandardize: parseStandardize,
  parseRewrite: parseRewrite,
  parseQuiz: parseQuiz
};

// 浏览器环境下挂到 window，方便控制台调用；Node 环境下导出
if (typeof window !== "undefined") {
  window.AICaller = AICaller;
  window.AI_CONFIG = AI_CONFIG;
  window.AI_DEBUG = AI_DEBUG;
  window.AI_INTERNAL = AI_INTERNAL;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = AICaller;
  module.exports.AI_DEBUG = AI_DEBUG;
  module.exports.AI_INTERNAL = AI_INTERNAL;
}
