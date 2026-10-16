/* ==========================================================================
 * Service Worker —— AI 新闻背单词
 * --------------------------------------------------------------------------
 * 作用：让app 在本地开发环境（127.0.0.1:8080）可离线打开、可安装到桌面。
 *
 * 【为什么这个文件必须放在根目录】
 * Service Worker 的作用域（scope）默认是它所在目录。放在 js/ 下就只能管到 /js/*，
 * 页面本身（/index.html）不会被缓存，离线就打不开。必须放根目录。
 *
 * 【缓存策略分三类，理由写在这里，改代码前先读】
 *   ① 静态资源  Cache First —— JS/CSS/图片/字体/HTML。内容随CACHE_VERSION 变，
 *      版本没变就说明文件没动，直接用缓存的，省流量也更快。
 *   ②词典 JSON  Cache First —— 词表是静态数据，缓存一次永久用。
 *      但【故意不预缓存】：三本词典合计 ~340KB，一次性 install 会明显拖慢首次
 *      加载。它们走「用到时缓存」，用户第一次点开某本词典时才拉。
 *   ③ AI 接口/动态内容  Network Only —— 一律不缓存。
 *      这一条最容易出错：新闻内容必须每次都是最新的，用了缓存就等于给用户看
 *      过期的新闻。另外所有 AI 调用都是 POST（js/ai.js 的 requestChatOnce），
 *      而 Cache API 根本不缓存非 GET 请求，所以这条规则同时是安全兜底。
 *
 * 【不要缓存什么】
 * localStorage / IndexedDB 里的数据（单词本、学习记录、测试结果）本来就存在本地，
 * Service Worker 碰不到它们，也不要试图缓存。
 *
 * 【改了文件但页面没变化？】
 * 提高下面 CACHE_VERSION。install 会开新缓存、activate 会删旧缓存。
 * 开发环境下 app.js 里做了 skipWaiting + clients.claim，所以新版本立刻生效，
 * 不用手动清缓存。改了CACHE_VERSION 之外的东西（比如 SW 逻辑本身）也一样。
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * 1. 版本与常量
 * -------------------------------------------------------------------------- */

/** 缓存版本号：任何被预缓存的文件内容变了都要 +1 */
const CACHE_VERSION = "v10";

/** 缓存名：anv = AI News Vocab。带上版本号是为了 activate 时能精确删旧缓存 */
const CACHE_NAME = "anv-vocab-" + CACHE_VERSION;

/**
 * 预缓存列表（install 阶段一次性缓存）
 *
 * 说明：
 * - 以 "./" 相对写法而不是 "/xxx"：这样部署到子目录（如 GitHub Pages 的 /repo/）
 *   也能正常工作。用绝对路径 "/" 会在子目录下全部 404。
 * - 顺序按重要性排：HTML → CSS → 核心 JS → 其它 JS。install 是并行的，
 *   顺序只影响失败时哪部分先不可用。
 * - 词典 JSON 有意不在这里（见文件头说明②）。
 */
const PRECACHE_URLS = [
  // ---- 核心----
  "./index.html",
  "./manifest.json",
  "./css/style.css",

  // ---- 核心 JS（首页加载链路上的）----
  "./js/app.js",
  "./js/data.js",
  "./js/wordpool.js",
  "./js/news.js",
  "./js/ai.js",
  "./js/dictionary.js",
  "./js/vocabBook.js",
  "./js/vocabBookUI.js",
  "./js/profile.js",
  "./js/db.js",
  "./js/flashcard.js",
  "./js/readHistory.js",
  "./js/wordbank.js",
  "./js/vocabTest.js",

  // ---- 预置新闻内容（离线也能读到昨天的新闻，兜底用）----
  "./data/news.json",

  // ---- 词汇量测试题库 ----
  // 必须预缓存：open() 现在是「先 await fetch(testBank.json) 再出题」，
  // 离线时拿不到它就会降级到 60 词小库，估算系统性偏高。
  // 1200 词条约 260KB，安装时会慢一点，但换来「测试功能离线完全可用」。
  // 三本词典（cet4/cet6/tem4）故意【不】预缓存：343KB 且用时才需要，
  // 放进install 会拖慢首次激活，交给 fetch 时的 Cache First 按需缓存。
  "./data/testBank.json",

  // ---- 图标 ----
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

/**
 * 词典数据路径：走 Cache First 但不预缓存（用到时才拉）。
 * 单独列出来而不是并入静态资源的正则，是为了意图明确——
 * 以后有人加/换词典只改这一行，不用去动 fetch 里的判断。
 */
const DICT_URLS = [
  "./data/cet4.json",
  "./data/cet6.json",
  "./data/tem4.json"
];

/**
 * 【故意不缓存的路径】
 * frequency.json 目前是 0 字节空文件（词频池实际硬编码在 js/data.js 里）。
 * 缓存一个空文件没意义，而且以后它一旦变成真数据、版本号又没改，
 * 用户会永远拿到那个空版本 —— 比不缓存更糟。所以显式排除。
 */
const NEVER_CACHE_URLS = [
  "./data/frequency.json"
];

/**
 * 外部域名黑名单：这些一律 Network Only，不进缓存。
 * 主要是 AI 服务商（api.deepseek.com / open.bigmodel.cn）和本地代理。
 * 双重保险：即使某天有人把AI 调用改成了 GET（Cache API 能缓存 GET！），
 * 这里也会拦住它。
 */
const EXTERNAL_HOSTS = [
  "api.deepseek.com",
  "open.bigmodel.cn",
  "127.0.0.1",// 本地代理（proxy_server.py）—— 只在本机有意义的转发，不该缓存
  "localhost"
];

/* --------------------------------------------------------------------------
 * 2. 工具函数
 * -------------------------------------------------------------------------- */

/**
 * 去掉查询串和 hash，得到干净的路径用于比较。
 * 为什么需要：/js/app.js 和 /js/app.js?v=3 是不同的 Request，
 * 但内容可能完全一样。不归一化的话缓存里会存两份。
 * @param {string} url
 * @returns {string}
 */
function normalizePath(url) {
  return String(url || "").split("?")[0].split("#")[0];
}

/**
 * 把路径归一成「无前导斜杠、无 ./ 前缀」的形式，用于两两比较。
 *
 * 【为什么需要这一层】常量表里写的是 "./data/cet4.json"（相对路径，能同时用于
 * 子目录部署），但 fetch 事件里拿到的是 url.pathname（"/data/cet4.json"，
 * 一定是带前导斜杠的绝对路径）。直接 endsWith 比较：
 *     "/data/cet4.json".endsWith("./data/cet4.json")  → false
 * 所以不做归一化的话，词典判断会失效；更糟的是 isNeverCache
 * 也失效 —— 而 isStaticRequest 内部靠它把 frequency.json 排除掉，
 * 一旦失效那个空文件就会被真的缓存起来（比不缓存更糟：
 * 以后它变成真数据、版本号又没改，用户会永远拿到空版本）。
 *
 * 顺带防住一类误判：结尾相同的不同路径
 *     "notdata/cet4.json" 不该被算成 "/data/cet4.json"
 * 所以比较时用「归一后完全相等」，不用 endsWith。
 *
 * @param {string} p
 * @returns {string}
 */
function canonical(p) {
  let s = normalizePath(p);
  if (s.indexOf("./") === 0) s = s.slice(2);
  if (s.charAt(0) !== "/") s = "/" + s;
  return s;
}

/**
 * 判断是否命中「词典 JSON」这一类（走 Cache First，但不做预缓存）。
 * @param {string} path
 * @returns {boolean}
 */
function isDictRequest(path) {
  const target = canonical(path);
  return DICT_URLS.some(function (u) { return canonical(u) === target; });
}

/**
 * 判断是否在「明确不缓存」名单里。
 * @param {string} path
 * @returns {boolean}
 */
function isNeverCache(path) {
  const target = canonical(path);
  return NEVER_CACHE_URLS.some(function (u) { return canonical(u) === target; });
}

/**
 * 判断是否静态资源（走 Cache First）。
 *
 * 匹配方式：看文件扩展名 + .html 兜底（有些服务器不给 .html 后缀）。
 * 用 pathname 而不是看 host，这样 CDN 上的同路径资源也能命中缓存。
 *
 * @param {string} path
 * @returns {boolean}
 */
function isStaticRequest(path) {
  if (isNeverCache(path)) return false;
  const p = canonical(path);
  if (p === "/" || p === "") return true;      // 目录 / SPA 入口
  return /\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|json|html?)$/i.test(p);
}

/**
 * 是否应该完全绕过缓存（Network Only）。
 *
 * 覆盖四种情况，缺一个就可能把动态内容缓存住：
 *   1. 非 GET 请求 —— Cache API 本来也不缓存 POST/PUT/DELETE，
 *      但显式 return 让意图明确，也防止将来有人用 GET 调 AI。
 *   2. 外部域名 —— AI 服务商和本地代理。
 *   3. 显式不缓存名单 —— frequency.json。
 *   4. 非 http(s) 协议 —— 比如 chrome-extension://、data:。
 *
 * @param {Request} request
 * @returns {boolean}
 */
function isNetworkOnly(request, origin) {
  // 1. 非 GET
  if (request.method !== "GET") return true;

  const url = new URL(request.url);

  // 4. 协议判断
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;

  // 2. 跨域一律 Network Only。
  //    为什么不再看 EXTERNAL_HOSTS 白名单：跨域内容（第三方字体 CDN、埋点、AI 服务商）
  //    本来就不该进我们的缓存——它们的缓存由对方自己的 SW/HTTP 头管。
  //    EXTERNAL_HOSTS 只是给人看的「清单」，让开发者知道哪些地址在走这条规则。
  //
  //    origin 通过参数传入而不是直接读 self.location：
  //    这个函数要能在 Node 里被require 做单测（见文件末尾导出），
  //    而 Node 环境没有 self。默认值只在浏览器里生效。
  const selfOrigin = origin !== undefined ? origin
    : (typeof self !== "undefined" && self.location ? self.location.origin : url.origin);
  if (url.origin !== selfOrigin) return true;

  // 3. 显式不缓存名单
  if (isNeverCache(normalizePath(url.pathname))) return true;

  return false;
}

/* --------------------------------------------------------------------------
 * 2.5 运行环境守卫
 * --------------------------------------------------------------------------
 * 下面的 install / activate / fetch / message 监听只在 Service Worker 上下文里
 * 有意义。Node 环境（require 本文件做自测）没有 self，直接写
 * `self.addEventListener(...)` 会在文件加载时就抛 ReferenceError，
 * 导致整个自测崩溃 —— 所以先把事件绑定整段包起来。
 *
 * 判断用 typeof self !== "undefined"，不能写 `if (self)`：
 * 未声明的标识符在 typeof 下是安全的（返回 "undefined"），直接读会抛错。
 */
var IS_SW = (typeof self !== "undefined" &&
             typeof self.addEventListener === "function" &&
             typeof caches !== "undefined");

/* --------------------------------------------------------------------------
 * 3. install —— 预缓存
 * -------------------------------------------------------------------------- */

/**
 * 预缓存失败时的降级策略：**不能因为一个文件 404 就让整个 install 崩掉**。
 * 崩掉的后果是 Service Worker 永远装不上，整站都失去离线能力 ——
 * 代价远大于少缓存一个文件。所以单个失败只 warn，全部成功才当成功。
 */
if (IS_SW) {
  self.addEventListener("install", function (event) {
    console.log("[SW] install 开始，版本", CACHE_VERSION, "，共", PRECACHE_URLS.length, "个文件");
    event.waitUntil(
      caches.open(CACHE_NAME).then(function (cache) {
        return Promise.all(
          PRECACHE_URLS.map(function (url) {
            // cache: "reload" 绕过 HTTP 缓存，确保拿到的是服务器上的最新版本。
            // 不加这个参数，浏览器可能拿自己的 HTTP 缓存喂我们，
            // 结果就是「改了文件但离线后还是旧版」，很难查。
            return cache.add(new Request(url, { cache: "reload" })).catch(function (err) {
              console.warn("[SW] 预缓存失败（已跳过）:", url, err && err.message);
            });
          })
        );
      }).then(function () {
        console.log("[SW] install 完成，缓存名", CACHE_NAME);
      })
    );
  });

  /* --------------------------------------------------------------------------
   * 4. activate —— 清理旧版本缓存
   * -------------------------------------------------------------------------- */

  /**
   * 只删「本项目自己的、且不是当前版本」的缓存。
   *
   * 两个防护缺一不可：
   *   1. startsWith("anv-vocab-") —— 不能把同源下别的应用的缓存删掉
   *      （比如以后再加一个 worker，或 devtools 里手建的测试缓存）。
   *   2. name !== CACHE_NAME —— 当前版本必须留着。
   */
  self.addEventListener("activate", function (event) {
    console.log("[SW] activate 开始，清理旧缓存");
    event.waitUntil(
      caches.keys().then(function (names) {
        const stale = names.filter(function (name) {
          return name.startsWith("anv-vocab-") && name !== CACHE_NAME;
        });
        return Promise.all(
          stale.map(function (name) {
            console.log("[SW] 删除旧缓存:", name);
            // 【必须兜catch】caches.delete 返回的 Promise 一旦 reject
            //（隐私模式、配额限制、用户拒绝持久化），它会顺着 Promise.all
            // 让整个 activate 的 waitUntil reject —— 后果是
            // 【Service Worker 永远不激活】，页面看着"注册成功"但离线完全无效。
            // 旧缓存删不掉只是占了点空间，不该阻断激活。
            return caches.delete(name).catch(function (err) {
              console.warn("[SW] 删除旧缓存失败（不阻断激活）:", name,
                           err && err.message);
              return false;
            });
          })
        );
      }).then(function () {
        // clients.claim：让已打开的页面立刻归这个新 SW 管，
        // 不用等用户刷新。不需要这行的话，下次导航才生效。
        return self.clients.claim();
      }).then(function () {
        console.log("[SW] activate 完成，当前缓存", CACHE_NAME);
      })
    );
  });

  /* --------------------------------------------------------------------------
   * 5. fetch —— 三类缓存策略
   * -------------------------------------------------------------------------- */

  /**
   * Cache First：命中缓存直接返回，否则走网络并写入缓存。
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  function cacheFirst(request) {
    return caches.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        // 只缓存 200 且基本类型的响应。opaque（跨域无 CORS，status 0）不缓存 ——
        // 缓存了也读不出内容，还会占空间。
        if (!response || response.status !== 200 || response.type === "opaque") {
          return response;
        }
        const copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(request, copy);
        }).catch(function (err) {
          // quota 超限之类。缓存写不进去不该影响本次响应。
          console.warn("[SW] 写入缓存失败:", request.url, err && err.message);
        });
        return response;
      });
    });
  }

  /**
   * Network First：有网用网络，没网（或网络出错）用缓存。
   * 用在「不匹配其它规则」的请求上 —— 属于兜底，行为最保守。
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  function networkFirst(request) {
    return fetch(request).then(function (response) {
      // 200 才更新缓存。网络错误时 fetch 本身就会 reject，走下面的 catch。
      if (response && response.status === 200 && response.type !== "opaque") {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(request, copy);
        }).catch(function () { /* 写不进去就算了 */ });
      }
      return response;
    }).catch(function (err) {
      return caches.match(request).then(function (cached) {
        if (cached) return cached;
        throw err;   // 缓存也没有，只能把错误抛给页面
      });
    });
  }

  self.addEventListener("fetch", function (event) {
    const request = event.request;

    // ③ Network Only：AI 接口、非 GET、外部请求。
    // 这一条放在最前面 —— 宁可漏缓存，也不能把动态内容缓存住。
    if (isNetworkOnly(request)) return;   // 不调 respondWith = 浏览器默认行为 = 走网络

    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    event.respondWith(
      (function () {
        // ① / ② 词典 JSON 和静态资源都是 Cache First，
        // 唯一区别是词典不预缓存（用到才拉），所以这里可以合��处理。
        if (isDictRequest(path) || isStaticRequest(path)) {
          return cacheFirst(request);
        }
        // 默认：Network First 兜底
        return networkFirst(request);
      })()
    );
  });

  /* --------------------------------------------------------------------------
   * 6. message ——供页面手动触发 skipWaiting（开发调试用）
   * -------------------------------------------------------------------------- */

  /**
   * 页面可以 postMessage({type:'SKIP_WAITING'}) 让 waiting 状态的 SW 立刻激活。
   * app.js 的注册逻辑在发现 updatefound 时也会调 skipWaiting，
   * 这里留着是为了调试时能手动控制时机。
   */
  self.addEventListener("message", function (event) {
    if (event.data && event.data.type === "SKIP_WAITING") {
      console.log("[SW] 收到 SKIP_WAITING 消息");
      self.skipWaiting();
    }
  });
}

/* --------------------------------------------------------------------------
 * 7. 自测导出（Node 环境下可用，浏览器里这段会被 tree-shake 掉/不影响行为）
 * -------------------------------------------------------------------------- */

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CACHE_VERSION: CACHE_VERSION,
    CACHE_NAME: CACHE_NAME,
    PRECACHE_URLS: PRECACHE_URLS,
    DICT_URLS: DICT_URLS,
    NEVER_CACHE_URLS: NEVER_CACHE_URLS,
    EXTERNAL_HOSTS: EXTERNAL_HOSTS,
    normalizePath: normalizePath,
    canonical: canonical,
    isDictRequest: isDictRequest,
    isNeverCache: isNeverCache,
    isStaticRequest: isStaticRequest,
    isNetworkOnly: isNetworkOnly
  };
}