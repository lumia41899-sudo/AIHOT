/**
 * 创作工作台 · 模型封装（lib/llm.js）· V2.5「换大脑」版
 * 直连 DeepSeek（连接与鉴权由 lib/cloud.js 提供）。
 * 保持旧形状：listModels(cloud) / streamText(cloud, opts) / complete(cloud, opts)
 *   - create 返回 async generator，必须 for await 逐块读取；
 *   - 每块为 OpenAI 兼容结构：chunk.choices[0].delta.content 累加即为输出。
 *   - DeepSeek R1（deepseek-reasoner）的思考过程在 delta.reasoning_content，
 *     这里只输出正文 content（思考阶段流式区会短暂静默，属正常现象）。
 * 浏览器：window.CWLLM
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CWLLM = factory();
})(typeof self !== "undefined" ? self : this, function () {

  var FALLBACK_MODELS = [
    { id: "deepseek-chat", name: "DeepSeek V3（日常首选）" },
    { id: "deepseek-reasoner", name: "DeepSeek R1（深度思考）" }
  ];

  /** 列出可用模型，返回 [{id,name,...}] */
  async function listModels(cloud) {
    if (cloud && cloud.llm && cloud.llm.models && cloud.llm.models.list) {
      try {
        var arr = await cloud.llm.models.list();
        if (Array.isArray(arr) && arr.length) return arr;
      } catch (e) { /* 落到兜底 */ }
    }
    return FALLBACK_MODELS;
  }

  /**
   * 流式生成文本。
   * @param cloud  cloud 实例（由 lib/cloud.js 提供）
   * @param opts   { model, messages, signal, onToken(text, full) }
   * @returns 完整文本（string）
   */
  async function streamText(cloud, opts) {
    var messages = opts.messages;
    var model = opts.model;
    if (!model) throw new Error("未指定模型（请先在「模型」下拉中选择）");
    if (!Array.isArray(messages) || !messages.length) throw new Error("messages 为空");

    var stream = await cloud.llm.chat.completions.create({
      model: model,
      messages: messages,
      stream: true,
      signal: opts.signal || undefined,
      timeoutMs: opts.timeoutMs || undefined
    });

    var full = "";
    var onToken = opts.onToken || null;
    for await (var chunk of stream) {
      var delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      var piece = delta && delta.content;
      if (piece) {
        full += piece;
        if (onToken) { try { onToken(piece, full); } catch (e) {} }
      }
    }
    return full;
  }

  /** 一次性生成（内部仍是流式，只是不回调 token） */
  async function complete(cloud, opts) {
    return streamText(cloud, opts);
  }

  return { listModels: listModels, streamText: streamText, complete: complete };
});
