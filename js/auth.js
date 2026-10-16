// js/auth.js - 用户认证模块（防御式：SDK 不可达时降级为离线 stub，应用不崩）
(function () {
  // 真实客户端
  function buildRealAuth(supabase) {
    const client = supabase.createClient(
      window.APP_CONFIG.SUPABASE_URL,
      window.APP_CONFIG.SUPABASE_ANON_KEY
    );
    window.Auth = {
      client: client,
      available: true,
      async getCurrentUser() {
        const { data: { user } } = await client.auth.getUser();
        return user;
      },
      async signUp(email, password) {
        const { data, error } = await client.auth.signUp({ email, password });
        return { user: data && data.user, error };
      },
      async signIn(email, password) {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        return { user: data && data.user, error };
      },
      async signOut() {
        const { error } = await client.auth.signOut();
        return { error };
      },
      onAuthStateChange(cb) {
        const { data } = client.auth.onAuthStateChange(function (event, session) {
          cb(event, session ? session.user : null);
        });
        return data; // { subscription: {...} }
      }
    };
    console.info("[auth] Supabase 客户端初始化成功（云端同步已启用）");
  }

  // 离线 stub：单词本本地可用，云端同步禁用，但登录/注册 UI 不会崩
  function buildStubAuth(reason) {
    console.warn("[auth] Supabase 不可用，降级为离线模式：" +
      (reason || "SDK 未加载") + " —— 单词本本地可用，云端同步已禁用");
    const offlineErr = new Error("离线模式：云端不可用");
    const noop = function () { return Promise.resolve({ user: null, error: offlineErr }); };
    window.Auth = {
      client: null,
      available: false,
      getCurrentUser: function () { return Promise.resolve(null); },
      signUp: noop,
      signIn: noop,
      signOut: function () { return Promise.resolve({ error: null }); },
      onAuthStateChange: function () { return { subscription: { unsubscribe: function () {} } }; }
    };
  }

  function bootstrap() {
    if (window.Auth) return; // 只初始化一次
    if (window.supabase && window.supabase.createClient && window.APP_CONFIG &&
        window.APP_CONFIG.SUPABASE_URL && window.APP_CONFIG.SUPABASE_ANON_KEY) {
      try {
        buildRealAuth(window.supabase);
      } catch (e) {
        console.error("[auth] 客户端初始化失败：", e && e.message);
        buildStubAuth("createClient 抛错");
      }
    } else {
      buildStubAuth("SDK/配置缺失");
    }
    // 通知下游模块（db.js / vocabBook.js 等）Auth 已就绪（真实或 stub）
    window.dispatchEvent(new Event("auth:ready"));
  }

  // SDK 动态加载完成（supabase-loader.js 派发）
  window.addEventListener("supabase-ready", bootstrap);
  // SDK 全部 CDN 不可达
  window.addEventListener("supabase-offline", bootstrap);
  // 兜底：若 6s 内既没 ready 也没 offline（极端情况），也降级，别卡住
  setTimeout(bootstrap, 6000);

  // 若 SDK 已同步就绪（例如命中缓存），立即初始化
  if (window.supabase && window.supabase.createClient) bootstrap();
})();
