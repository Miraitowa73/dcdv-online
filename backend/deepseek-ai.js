const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const CONFIG_FILENAME = 'deepseek.config.json';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_THINKING = 'disabled';
const ENV_API_KEY = 'DEEPSEEK_API_KEY';
const ENV_BASE_URL = 'DEEPSEEK_BASE_URL';
const ENV_MODEL = 'DEEPSEEK_MODEL';
const ENV_THINKING = 'DEEPSEEK_THINKING';

function createAiError(statusCode, message, code = 'ai_error') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

function normalizeThinking(thinking) {
  if (typeof thinking === 'boolean') return { type: thinking ? 'enabled' : 'disabled' };
  if (typeof thinking === 'string') {
    const value = thinking.toLowerCase().trim();
    return { type: value === 'enabled' ? 'enabled' : DEFAULT_THINKING };
  }
  if (thinking && typeof thinking === 'object') {
    const value = String(thinking.type || DEFAULT_THINKING).toLowerCase().trim();
    return { type: value === 'enabled' ? 'enabled' : DEFAULT_THINKING };
  }
  return { type: DEFAULT_THINKING };
}

async function loadDeepSeekConfig(projectRoot = process.cwd()) {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  let rawConfig = {};
  let source = 'defaults';
  let readError = '';

  if (fs.existsSync(configPath)) {
    source = CONFIG_FILENAME;
    try {
      rawConfig = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    } catch (error) {
      readError = `${CONFIG_FILENAME} 读取失败：${error.message}`;
    }
  }

  const envConfig = {
    apiKey: process.env[ENV_API_KEY],
    baseUrl: process.env[ENV_BASE_URL],
    model: process.env[ENV_MODEL],
    thinking: process.env[ENV_THINKING],
  };
  const hasEnvConfig = Object.values(envConfig).some((value) => String(value || '').trim());
  const apiKey = String(envConfig.apiKey || rawConfig.apiKey || '').trim();
  const model = String(envConfig.model || rawConfig.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const baseUrl = normalizeBaseUrl(envConfig.baseUrl || rawConfig.baseUrl);
  const thinking = normalizeThinking(envConfig.thinking || rawConfig.thinking);
  const errors = [];

  if (readError) errors.push(readError);
  if (!apiKey) {
    errors.push(`未配置 DeepSeek API Key，请设置 ${ENV_API_KEY} 环境变量，或复制 deepseek.config.example.json 为 ${CONFIG_FILENAME} 并填写 apiKey。`);
  }

  return {
    configured: !!apiKey && !readError,
    apiKey,
    model,
    baseUrl,
    thinking,
    source: hasEnvConfig ? 'environment' : source,
    errors,
  };
}

async function getDeepSeekStatus(projectRoot = process.cwd()) {
  const config = await loadDeepSeekConfig(projectRoot);
  return {
    configured: config.configured,
    model: config.model,
    baseUrl: config.baseUrl,
    thinking: config.thinking.type,
    source: config.source,
    errors: config.configured ? [] : config.errors,
  };
}

function buildDeepSeekPayload({ config, messages, temperature = 0.2, maxTokens = 4096 }) {
  return {
    model: config.model || DEFAULT_MODEL,
    messages,
    stream: false,
    temperature,
    max_tokens: maxTokens,
    thinking: config.thinking || { type: DEFAULT_THINKING },
  };
}

function stripPossibleSecret(text, secret) {
  if (!secret) return String(text || '');
  return String(text || '').split(secret).join('[redacted]');
}

function parseChatCompletionContent(data) {
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

function cleanupCodeText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/^```[a-zA-Z0-9_-]*\s*/g, '')
    .replace(/```$/g, '')
    .trim();
}

function extractVerilogCode(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return '';

  const fencedBlocks = [...raw.matchAll(/```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g)];
  if (fencedBlocks.length) {
    const preferred = fencedBlocks.find((match) => /^(verilog|systemverilog|sv)$/i.test(match[1] || '')) || fencedBlocks[0];
    return cleanupCodeText(preferred[2]);
  }

  const moduleStart = raw.search(/\bmodule\s+[A-Za-z_][A-Za-z0-9_$]*\b/);
  const moduleEnd = raw.lastIndexOf('endmodule');
  if (moduleStart >= 0 && moduleEnd >= moduleStart) {
    return cleanupCodeText(raw.slice(moduleStart, moduleEnd + 'endmodule'.length));
  }

  return cleanupCodeText(raw);
}

function buildVerilogGenerationMessages(description) {
  return [
    {
      role: 'system',
      content: [
        '你是数字电路教学工具 DCDV 的 Verilog 代码生成器。',
        '只输出可编译的 Verilog/SystemVerilog 源代码，不要输出 Markdown、解释、表格或代码块围栏。',
        '默认顶层模块名使用 custom_logic，除非用户描述明确指定模块名。',
        '优先生成 Icarus Verilog 可编译的 Verilog/SystemVerilog 子集。',
        '端口命名要清晰；时序电路优先使用 clk 和 rst；组合逻辑避免锁存器。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请根据以下功能描述生成 Verilog 代码：\n${description}`,
    },
  ];
}

function buildVerilogReviewMessages(code) {
  return [
    {
      role: 'system',
      content: [
        '你是数字电路教学工具 DCDV 的 Verilog 代码审查助手。',
        '请用中文简洁指出语法、可综合性、时序逻辑、端口和仿真风险。',
        '如果没有明显问题，请说明可以继续编译/仿真。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请审查以下 Verilog 代码：\n${code}`,
    },
  ];
}

async function callDeepSeekChat({ projectRoot, messages, temperature, maxTokens, fetchImpl = globalThis.fetch }) {
  const config = await loadDeepSeekConfig(projectRoot);
  if (!config.configured) {
    throw createAiError(400, config.errors[0], 'missing_deepseek_config');
  }
  if (typeof fetchImpl !== 'function') {
    throw createAiError(500, '当前 Node.js 运行时不支持 fetch，请使用 Node.js 18+。', 'fetch_unavailable');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  const payload = buildDeepSeekPayload({ config, messages, temperature, maxTokens });

  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (error) {
      data = { error: { message: text || error.message } };
    }

    if (!response.ok) {
      const detail = stripPossibleSecret(data?.error?.message || data?.message || `HTTP ${response.status}`, config.apiKey);
      throw createAiError(response.status, `DeepSeek 请求失败：${detail}`, 'deepseek_api_error');
    }

    return {
      content: parseChatCompletionContent(data),
      model: data?.model || config.model,
      usage: data?.usage || null,
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw createAiError(504, 'DeepSeek 请求超时，请稍后重试。', 'deepseek_timeout');
    }
    if (error.statusCode) throw error;
    throw createAiError(502, `DeepSeek 请求失败：${stripPossibleSecret(error.message, config.apiKey)}`, 'deepseek_network_error');
  } finally {
    clearTimeout(timeout);
  }
}

async function generateVerilogWithDeepSeek({ projectRoot, description, fetchImpl }) {
  const cleanDescription = String(description || '').trim();
  if (!cleanDescription) {
    throw createAiError(400, '请输入功能描述。', 'empty_description');
  }

  const result = await callDeepSeekChat({
    projectRoot,
    messages: buildVerilogGenerationMessages(cleanDescription),
    temperature: 0.15,
    maxTokens: 4096,
    fetchImpl,
  });
  const code = extractVerilogCode(result.content);
  if (!code) {
    throw createAiError(502, 'DeepSeek 返回为空，未生成 Verilog 代码。', 'empty_ai_code');
  }

  return {
    ok: true,
    code,
    model: result.model,
    usage: result.usage,
  };
}

async function reviewVerilogWithDeepSeek({ projectRoot, code, fetchImpl }) {
  const cleanCode = String(code || '').trim();
  if (!cleanCode) {
    throw createAiError(400, '请先输入 Verilog 代码。', 'empty_verilog');
  }

  const result = await callDeepSeekChat({
    projectRoot,
    messages: buildVerilogReviewMessages(cleanCode),
    temperature: 0.2,
    maxTokens: 2048,
    fetchImpl,
  });
  const review = result.content.trim();
  if (!review) {
    throw createAiError(502, 'DeepSeek 返回为空，未生成审查结果。', 'empty_ai_review');
  }

  return {
    ok: true,
    review,
    model: result.model,
    usage: result.usage,
  };
}

function toPublicAiError(error) {
  return {
    ok: false,
    error: error.message || 'AI 服务不可用。',
    code: error.code || 'ai_error',
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  CONFIG_FILENAME,
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_MODEL,
  ENV_THINKING,
  buildDeepSeekPayload,
  buildVerilogGenerationMessages,
  extractVerilogCode,
  generateVerilogWithDeepSeek,
  getDeepSeekStatus,
  loadDeepSeekConfig,
  parseChatCompletionContent,
  reviewVerilogWithDeepSeek,
  toPublicAiError,
};
