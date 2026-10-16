// js/authUI.js - 登录 / 注册弹窗交互
// 依赖：window.Auth（认证模块）、全局 toast（轻提示）
// 通过 window.AuthUI 暴露：open / close / switchMode / showError / hideError
(function () {
  "use strict";

  var maskEl, titleEl, emailEl, pwdEl, pwd2El, pwd2Wrap,
      submitBtn, switchEl, errorEl, closeBtn;
  var currentMode = "signin"; // 'signin' | 'signup'

  function $(id) { return (typeof document !== "undefined") ? document.getElementById(id) : null; }

  function cacheEls() {
    maskEl = $("authModal");
    if (!maskEl) return;
    titleEl = $("authTitle");
    emailEl = $("authEmail");
    pwdEl = $("authPassword");
    pwd2El = $("authPassword2");
    pwd2Wrap = $("authPassword2Wrap");
    submitBtn = $("authSubmitBtn");
    switchEl = $("authSwitch");
    errorEl = $("authError");
    closeBtn = $("authCloseBtn");
  }

  /* ---------- 错误提示 ---------- */
  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg || "";
    errorEl.classList.remove("hidden");
  }
  function hideError() {
    if (!errorEl) return;
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }

  /* ---------- 模式切换 ---------- */
  function switchMode(mode) {
    currentMode = (mode === "signup") ? "signup" : "signin";
    if (titleEl) titleEl.textContent = (currentMode === "signup") ? "注册" : "登录";
    if (submitBtn) submitBtn.textContent = (currentMode === "signup") ? "注册" : "登录";
    if (pwd2Wrap) pwd2Wrap.classList.toggle("hidden", currentMode !== "signup");
    if (switchEl) {
      switchEl.textContent = (currentMode === "signup") ? "已有账号？去登录" : "还没有账号？去注册";
    }
    hideError();
    if (pwd2El && currentMode === "signin") pwd2El.value = "";
  }

  /* ---------- 打开 / 关闭 ---------- */
  function open(mode) {
    cacheEls();
    if (!maskEl) return;
    switchMode(mode || "signin");
    hideError();
    maskEl.classList.remove("hidden");
    // 打开后聚焦邮箱输入框
    if (emailEl) {
      setTimeout(function () { try { emailEl.focus(); } catch (e) { /* ignore */ } }, 50);
    }
  }

  function close() {
    if (!maskEl) return;
    maskEl.classList.add("hidden");
    hideError();
  }

  /* ---------- 提交中状态（防重复点击） ---------- */
  function setLoading(loading) {
    if (!submitBtn) return;
    submitBtn.disabled = !!loading;
    submitBtn.textContent = loading
      ? (currentMode === "signup" ? "注册中…" : "登录中…")
      : (currentMode === "signup" ? "注册" : "登录");
  }

  /* ---------- 基础校验（非空 + 两次密码一致） ---------- */
  function validate() {
    var email = (emailEl && emailEl.value || "").trim();
    var pwd = (pwdEl && pwdEl.value || "");
    if (!email || !pwd) {
      showError("请输入邮箱和密码");
      return null;
    }
    if (currentMode === "signup") {
      var pwd2 = (pwd2El && pwd2El.value || "");
      if (pwd !== pwd2) {
        showError("两次输入的密码不一致");
        return null;
      }
    }
    return { email: email, password: pwd };
  }

  /* ---------- 提交 ---------- */
  async function submit() {
    hideError();
    var data = validate();
    if (!data) return;
    if (!window.Auth) { showError("认证模块未就绪"); return; }

    setLoading(true);
    try {
      if (currentMode === "signin") {
        var r = await window.Auth.signIn(data.email, data.password);
        if (r.error) {
          showError(r.error.message || "登录失败，请重试");
          setLoading(false);
          return;
        }
        close();
        // 登录成功：刷新页面（onAuthStateChange 也会触发，刷新确保全局状态一致）
        if (typeof window !== "undefined" && window.location) window.location.reload();
      } else {
        var s = await window.Auth.signUp(data.email, data.password);
        if (s.error) {
          showError(s.error.message || "注册失败，请重试");
          setLoading(false);
          return;
        }
        close();
        // Supabase 默认开启 Email Confirmation：注册成功但需先验证邮件才能登录
        if (typeof toast === "function") {
          toast("注册成功，请前往邮箱查收验证邮件后再登录");
        } else {
          alert("注册成功，请前往邮箱查收验证邮件后再登录");
        }
        // 未登录（需验证邮件），不刷新，停留在未登录态
      }
    } catch (e) {
      showError((e && e.message) || "操作失败，请重试");
      setLoading(false);
    }
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    cacheEls();
    if (!maskEl) return;

    // 点击遮罩层关闭
    maskEl.addEventListener("click", function (e) {
      if (e.target === maskEl) close();
    });
    // 右上角 × 关闭
    if (closeBtn) closeBtn.addEventListener("click", close);
    // 底部"去注册 / 去登录"切换
    if (switchEl) {
      switchEl.addEventListener("click", function () {
        switchMode(currentMode === "signin" ? "signup" : "signin");
      });
    }
    // 主按钮提交
    if (submitBtn) submitBtn.addEventListener("click", submit);
    // 输入框按 Enter 提交
    [emailEl, pwdEl, pwd2El].forEach(function (el) {
      if (el) {
        el.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); submit(); }
        });
      }
    });
  }

  // authUI.js 在 <head> 引入，此时 #authModal 还没解析，等 DOM 就绪再绑定
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bind);
    } else {
      bind();
    }
  }

  window.AuthUI = {
    open: open,
    close: close,
    switchMode: switchMode,
    showError: showError,
    hideError: hideError
  };
})();
