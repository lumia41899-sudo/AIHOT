/**
 * 云 SDK 封装（lib/cloud.js）· V2.6 多服务商版
 * 直连任意 OpenAI 兼容接口（DeepSeek / Kimi / 智谱 / 通义 / 硅基流动 / OpenRouter / 自定义）。
 * 配置（服务商+地址+Key+模型）只存浏览器 localStorage（键 cw_llm_config），不写入任何代码或仓库。
 * 不提供 database —— CWKnowledge 检测不到云库时会自动回退本地/内嵌知识兜底。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CWCloud = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var CFG_STORE = "cw_llm_config";
  var LEGACY_KEY = "cw_deepseek_key";

  /** 服务商预设（baseUrl 均为 OpenAI 兼容端点；模型名可随时在设置里改，不受此处限制） */
  var PROVIDERS = {
    cloud: {
      name: "WorkBuddy 云端（免密钥）",
      baseUrl: "",
      keyless: true,
      models: [{ id: "cloud-auto", name: "云端智能（自动路由）" }]
    },
    deepseek: {
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      models: [{ id: "deepseek-chat", name: "DeepSeek V3（日常首选）" }, { id: "deepseek-reasoner", name: "DeepSeek R1（深度思考）" }]
    },
    kimi: {
      name: "Kimi（月之暗面）",
      baseUrl: "https://api.moonshot.cn/v1",
      models: [{ id: "kimi-k2-0905-preview", name: "Kimi K2" }, { id: "moonshot-v1-8k", name: "Moonshot V1 8K" }, { id: "moonshot-v1-32k", name: "Moonshot V1 32K" }]
    },
    zhipu: {
      name: "智谱 GLM",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      /* 免费模型 glm-4-flash 放在第一个：切到「智谱 GLM」时默认即用免费档（模型 ID 文本框第一项为实际调用模型） */
      models: [{ id: "glm-4-flash", name: "GLM-4-Flash（免费）" }, { id: "glm-4.5", name: "GLM-4.5" }]
    },
    qwen: {
      name: "通义 Qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: [{ id: "qwen-plus", name: "Qwen-Plus" }, { id: "qwen-turbo", name: "Qwen-Turbo（快省）" }, { id: "qwen-max", name: "Qwen-Max（强）" }]
    },
    doubao: {
      name: "豆包（火山方舟）",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      models: [{ id: "doubao-seed-1-6-250615", name: "Doubao-Seed-1.6" }, { id: "doubao-pro-32k", name: "Doubao-Pro-32k" }, { id: "doubao-lite-32k", name: "Doubao-Lite-32k（快省）" }]
    },
    siliconflow: {
      name: "硅基流动 SiliconFlow",
      baseUrl: "https://api.siliconflow.cn/v1",
      models: [{ id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3（托管）" }, { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen2.5 72B" }]
    },
    openrouter: {
      name: "OpenRouter（海外聚合）",
      baseUrl: "https://openrouter.ai/api/v1",
      models: [{ id: "deepseek/deepseek-chat", name: "DeepSeek V3（OR）" }]
    },
    custom: {
      name: "自定义（任意 OpenAI 兼容）",
      baseUrl: "",
      models: []
    }
  };

  function getConfig() {
    try {
      var c = JSON.parse(localStorage.getItem(CFG_STORE) || "null");
      /* 云端免密钥配置没有 baseUrl，也必须被认作有效配置 */
      if (c && (c.baseUrl || c.provider === "cloud")) return c;
    } catch (e) {}
    // 兼容 V2.5 的旧 Key：自动迁移为 DeepSeek 配置
    try {
      var k = localStorage.getItem(LEGACY_KEY);
      if (k) {
        var c2 = { provider: "deepseek", baseUrl: PROVIDERS.deepseek.baseUrl, apiKey: k, models: PROVIDERS.deepseek.models.slice() };
        localStorage.setItem(CFG_STORE, JSON.stringify(c2));
        localStorage.removeItem(LEGACY_KEY);
        return c2;
      }
    } catch (e) {}
    return null;
  }
  function saveConfig(cfg) {
    try { localStorage.setItem(CFG_STORE, JSON.stringify(cfg)); } catch (e) {}
    return cfg;
  }
  function clearConfig() {
    try { localStorage.removeItem(CFG_STORE); localStorage.removeItem(LEGACY_KEY); } catch (e) {}
  }
  function hasConfig() {
    var c = getConfig();
    return !!(c && c.apiKey && c.baseUrl);
  }

  /** 把 SSE 流解析成 async generator，保持「for await + choices[0].delta.content」形状 */
  async function createStream(opts) {
    var cfg = getConfig();
    if (!cfg || !cfg.apiKey) throw new Error("尚未配置模型服务（请在页面顶部「连接设置」中选择服务商并保存 Key）");
    if (!cfg.baseUrl) throw new Error("未配置接口地址");
    /* 启动阶段超时保护：连接+首字节默认 90s（可由 opts.timeoutMs 覆盖），首块到达后自动解除，长内容不受限 */
    var ms = opts.timeoutMs || 90000;
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var killed = false;
    if (ctrl && opts.signal && opts.signal.addEventListener) {
      try { opts.signal.addEventListener("abort", function () { killed = true; try { ctrl.abort(); } catch (e) {} }); } catch (e) {}
    }
    var timer = ctrl ? setTimeout(function () { killed = true; try { ctrl.abort(); } catch (e) {} }, ms) : null;
    var res;
    try {
      res = await fetch(String(cfg.baseUrl).replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey },
        body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true }),
        signal: ctrl ? ctrl.signal : (opts.signal || undefined)
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (killed) throw new Error("连接超时（" + Math.round(ms / 1000) + "秒无响应）：模型服务繁忙或网络波动，请点重试");
      throw e;
    }
    if (!res.ok) {
      if (timer) clearTimeout(timer);
      var text = "";
      try { text = await res.text(); } catch (e) {}
      /* 常见错误码的友好提示（V2.6.2） */
      if (res.status === 401 || res.status === 403) {
        throw new Error("API Key 身份验证失败（" + res.status + "）：Key 无效、已过期或被重新生成。请到服务商控制台重新复制完整的 API Key，在顶部「连接设置」中粘贴保存，再点「重试本节点」。");
      }
      if (res.status === 402 || res.status === 429) {
        throw new Error("模型服务额度/频率受限（" + res.status + "）：账户余额不足或请求过于频繁，稍后重试或更换模型。");
      }
      throw new Error("模型接口错误 " + res.status + (text ? "：" + text.slice(0, 300) : ""));
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder("utf-8");
    var buffer = "";
    var finished = false;
    var firstRead = true;
    /* 流中闲置保护（V2.6.1）：首块之后若连续 90 秒无新数据（连接假死/服务端挂起/断网/休眠唤醒），
       主动 abort 并抛出可重试错误，避免 await 永久挂起导致页面一动不动 */
    var idleMs = Math.max(ms, 60000);
    var idleTimer = null;
    function armIdle() {
      if (!ctrl) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(function () { killed = true; try { ctrl.abort(); } catch (e) {} }, idleMs);
    }
    async function* gen() {
      try {
        while (!finished) {
          var r;
          try { r = await reader.read(); }
          catch (e) {
            if (timer) clearTimeout(timer);
            if (killed) throw new Error((firstRead ? "连接超时" : "流式响应中断") + "（" + Math.round((firstRead ? ms : idleMs) / 1000) + "秒无数据）：模型服务繁忙或网络波动，将自动重试");
            throw e;
          }
          if (firstRead) { firstRead = false; if (timer) clearTimeout(timer); }
          armIdle();
          if (r.done) break;
          buffer += decoder.decode(r.value, { stream: true });
          var idx;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            var line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line || line.indexOf("data:") !== 0) continue;
            var payload = line.slice(5).trim();
            if (payload === "[DONE]") { finished = true; break; }
            try { yield JSON.parse(payload); } catch (e) { /* 忽略不完整块 */ }
          }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        if (timer) clearTimeout(timer);
      }
    }
    return gen();
  }

  /**
   * 创建 cloud 实例。
   * @param override 显式指定 provider（'cloud' 走 WorkBuddy 云端免密钥；其余走外部 OpenAI 兼容）。
   *   Model Router 在自动回退到云端时，会传入 'cloud' 以覆盖已保存的外部配置。
   */
  function create(override) {
    var cfg = getConfig() || {};
    var provider = override || cfg.provider || "deepseek";

    /* —— 路径 A：WorkBuddy 云端免密钥模型（browser 端 window.cloud SDK） —— */
    if (provider === "cloud") {
      return {
        provider: "cloud",
        keyless: true,
        getConfig: getConfig,
        saveConfig: saveConfig,
        clearConfig: clearConfig,
        hasConfig: function () { return true; },
        PROVIDERS: PROVIDERS,
        llm: {
          models: {
            list: async function () {
              try {
                if (window.cloud && window.cloud.llm && window.cloud.llm.models && window.cloud.llm.models.list) {
                  var arr = await window.cloud.llm.models.list();
                  if (Array.isArray(arr) && arr.length) return arr;
                }
              } catch (e) { /* 落到兜底 */ }
              return PROVIDERS.cloud.models;
            }
          },
          chat: {
            completions: {
              create: async function (opts) {
                if (!window.cloud || !window.cloud.llm || !window.cloud.llm.chat || !window.cloud.llm.chat.completions) {
                  throw new Error("当前环境未启用云端免密钥模型：请在 WorkBuddy 运行时（已发布应用 / 工作台网页）中打开本页，云端模型会自动可用，无需任何 API Key。");
                }
                /* cloud-auto → 动态解析模型目录：优先稳定非推理对话模型（适合脚本批量生成），
                   目录里没有首选时回退首个启用模型（disabled!==true），不硬编码不存在的 id */
                var model = (opts.model && opts.model !== "cloud-auto") ? opts.model : null;
                if (!model) {
                  try {
                    var prefer = ["hunyuan-chat"];
                    var ms = await window.cloud.llm.models.list();
                    var en = (ms || []).filter(function (m) { return m.disabled !== true; });
                    for (var p = 0; p < prefer.length && !model; p++) {
                      for (var q = 0; q < en.length; q++) { if (en[q].id === prefer[p]) { model = en[q].id; break; } }
                    }
                    if (!model && en.length) model = en[0].id;
                  } catch (e) {}
                  if (!model) throw new Error("云端模型目录为空或不可读，无法确定默认模型");
                }
                try { window.CLOUD_LAST_MODEL = model; } catch (e) {}
                return await window.cloud.llm.chat.completions.create({
                  model: model,
                  messages: opts.messages,
                  stream: true,
                  stream_options: { include_usage: true },
                  signal: opts.signal,
                  timeoutMs: opts.timeoutMs
                });
              }
            }
          }
        }
      };
    }

    /* —— 路径 B：外部 OpenAI 兼容服务商（用户粘贴 Key） —— */
    return {
      provider: "openai-compatible",
      getConfig: getConfig,
      saveConfig: saveConfig,
      clearConfig: clearConfig,
      hasConfig: hasConfig,
      PROVIDERS: PROVIDERS,
      llm: {
        models: {
          list: async function () {
            var list = (cfg && cfg.models && cfg.models.length) ? cfg.models : PROVIDERS[(cfg && cfg.provider) || "deepseek"].models;
            return list.map(function (m) { return (typeof m === "string") ? { id: m, name: m } : m; });
          }
        },
        chat: { completions: { create: createStream } }
      }
    };
  }

  return { create: create, PROVIDERS: PROVIDERS, getConfig: getConfig, saveConfig: saveConfig, clearConfig: clearConfig, hasConfig: hasConfig };
});
