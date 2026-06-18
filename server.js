const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');

const {
  cleanupOldWorkspaces,
  compileDesign,
  getToolchainStatus,
  simulateDesign,
} = require('./backend/verilog-backend');
const {
  generateVerilogWithDeepSeek,
  getDeepSeekStatus,
  reviewVerilogWithDeepSeek,
  toPublicAiError,
} = require('./backend/deepseek-ai');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3030);
const PROJECT_ROOT = __dirname;

const DEFAULT_RATE_LIMITS = {
  ai: {
    max: Number(process.env.DCDV_AI_RATE_LIMIT || 10),
    windowMs: Number(process.env.DCDV_AI_RATE_WINDOW_MS || 10 * 60 * 1000),
  },
  verilog: {
    max: Number(process.env.DCDV_VERILOG_RATE_LIMIT || 60),
    windowMs: Number(process.env.DCDV_VERILOG_RATE_WINDOW_MS || 5 * 60 * 1000),
  },
};
const DEFAULT_MAX_VERILOG_JOBS = Math.max(1, Number(process.env.DCDV_MAX_VERILOG_JOBS || 2));

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

const SENSITIVE_TOP_LEVEL = new Set([
  '.edge-profile',
  '.git',
  'backend',
  'history',
  'node_modules',
  'PPT',
  'release',
  'runtime',
  'tests',
  'tools',
  '备份',
  '学习系统案例',
]);
const SENSITIVE_FILES = new Set([
  '.dockerignore',
  '.gitignore',
  'Dockerfile',
  'build-portable.ps1',
  'deepseek.config.example.json',
  'deepseek.config.json',
  'package-lock.json',
  'package.json',
  'PORTABLE_README.md',
  'server.js',
  'start-dcdv.cmd',
]);
const PUBLIC_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.svg', '.webp']);
const DEFAULT_CORS_ORIGINS = [
  'https://miraitowa73.github.io',
  'http://localhost:3030',
  'http://127.0.0.1:3030',
];

function getAllowedCorsOrigins() {
  const configured = String(process.env.DCDV_CORS_ORIGINS || '').trim();
  if (!configured) return DEFAULT_CORS_ORIGINS;
  return configured
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function getCorsHeaders(req) {
  const origin = String(req.headers.origin || '').trim().replace(/\/+$/, '');
  if (!origin) return {};

  const allowed = getAllowedCorsOrigins();
  if (!allowed.includes('*') && !allowed.includes(origin)) return {};

  return {
    'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname || '/');
  } catch (error) {
    return null;
  }
}

function isPathInside(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function firstPathSegment(pathname) {
  return pathname.replace(/^\/+/, '').split('/')[0];
}

function isSensitiveStaticPath(pathname) {
  const firstSegment = firstPathSegment(pathname);
  const fileName = path.posix.basename(pathname);
  return (
    pathname.includes('..') ||
    firstSegment.startsWith('.') ||
    SENSITIVE_TOP_LEVEL.has(firstSegment) ||
    SENSITIVE_FILES.has(fileName) ||
    fileName.endsWith('.zip')
  );
}

function resolvePublicStaticPath(projectRoot, pathname) {
  if (pathname === '/' || pathname === '/DCDV.html') {
    return path.join(projectRoot, 'DCDV.html');
  }

  if (pathname.startsWith('/screenshots/')) {
    const ext = path.posix.extname(pathname).toLowerCase();
    if (!PUBLIC_IMAGE_EXTENSIONS.has(ext)) return null;
    return path.resolve(projectRoot, pathname.slice(1));
  }

  if (pathname.startsWith('/assets/challenges/')) {
    const ext = path.posix.extname(pathname).toLowerCase();
    if (!PUBLIC_IMAGE_EXTENSIONS.has(ext)) return null;
    return path.resolve(projectRoot, pathname.slice(1));
  }

  return null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, rawPathname, projectRoot = PROJECT_ROOT) {
  const pathname = decodePathname(rawPathname);
  if (!pathname || isSensitiveStaticPath(pathname)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  const targetPath = resolvePublicStaticPath(projectRoot, pathname);
  if (!targetPath || !isPathInside(projectRoot, targetPath)) {
    sendText(res, 404, 'Not found');
    return;
  }

  try {
    const stat = await fsp.stat(targetPath);
    if (!stat.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }
    const content = await fsp.readFile(targetPath);
    const mime = MIME_TYPES[path.extname(targetPath).toLowerCase()] || 'application/octet-stream';
    sendText(res, 200, content, mime, {
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
    });
  } catch (error) {
    sendText(res, 404, 'Not found');
  }
}

function getClientIp(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const connectingIp = String(req.headers['cf-connecting-ip'] || '').trim();
  return forwardedFor || connectingIp || req.socket.remoteAddress || 'unknown';
}

function normalizeRateLimits(rateLimits = DEFAULT_RATE_LIMITS) {
  return {
    ai: {
      max: Math.max(0, Number(rateLimits.ai?.max ?? DEFAULT_RATE_LIMITS.ai.max)),
      windowMs: Math.max(1000, Number(rateLimits.ai?.windowMs ?? DEFAULT_RATE_LIMITS.ai.windowMs)),
    },
    verilog: {
      max: Math.max(0, Number(rateLimits.verilog?.max ?? DEFAULT_RATE_LIMITS.verilog.max)),
      windowMs: Math.max(1000, Number(rateLimits.verilog?.windowMs ?? DEFAULT_RATE_LIMITS.verilog.windowMs)),
    },
  };
}

function consumeRateLimit(req, state, group) {
  const config = state.rateLimits[group];
  if (!config || config.max <= 0) return { ok: true };

  const now = Date.now();
  const key = `${group}:${getClientIp(req)}`;
  let bucket = state.rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + config.windowMs };
    state.rateBuckets.set(key, bucket);
  }

  if (bucket.count >= config.max) {
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  return { ok: true };
}

function sendRateLimited(res, retryAfter, message = 'Too many requests. Please try again later.') {
  sendJson(
    res,
    429,
    {
      ok: false,
      error: message,
      code: 'rate_limited',
    },
    { 'Retry-After': String(retryAfter || 60) }
  );
}

function acquireVerilogJob(state) {
  if (state.activeVerilogJobs >= state.maxVerilogJobs) return false;
  state.activeVerilogJobs += 1;
  return true;
}

function releaseVerilogJob(state) {
  state.activeVerilogJobs = Math.max(0, state.activeVerilogJobs - 1);
}

async function handleApi(req, res, pathname, context) {
  const { projectRoot, state, handlers } = context;

  if (req.method === 'GET' && pathname === '/api/health') {
    const toolchain = await handlers.getToolchainStatus();
    sendJson(res, 200, {
      ok: true,
      service: 'dcdv-local-backend',
      toolchain,
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/ai/status') {
    const ai = await handlers.getDeepSeekStatus(projectRoot);
    sendJson(res, 200, {
      ok: true,
      service: 'deepseek-verilog-ai',
      ai,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/ai/verilog/generate') {
    const limit = consumeRateLimit(req, state, 'ai');
    if (!limit.ok) {
      sendRateLimited(res, limit.retryAfter);
      return;
    }

    const body = await readJsonBody(req);
    try {
      const result = await handlers.generateVerilogWithDeepSeek({
        projectRoot,
        description: body.description,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, toPublicAiError(error));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/ai/verilog/review') {
    const limit = consumeRateLimit(req, state, 'ai');
    if (!limit.ok) {
      sendRateLimited(res, limit.retryAfter);
      return;
    }

    const body = await readJsonBody(req);
    try {
      const result = await handlers.reviewVerilogWithDeepSeek({
        projectRoot,
        code: body.code,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, toPublicAiError(error));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/verilog/compile') {
    const limit = consumeRateLimit(req, state, 'verilog');
    if (!limit.ok) {
      sendRateLimited(res, limit.retryAfter);
      return;
    }
    if (!acquireVerilogJob(state)) {
      sendRateLimited(res, 10, 'The Verilog service is busy. Please try again shortly.');
      return;
    }

    try {
      const body = await readJsonBody(req);
      const code = String(body.code || '');
      if (!code.trim()) {
        sendJson(res, 400, {
          ok: false,
          errors: ['Verilog code cannot be empty.'],
          warnings: [],
          moduleCandidates: [],
          selectedTop: null,
          ports: [],
          sourceHash: '',
          compilerLog: '',
        });
        return;
      }

      const result = await handlers.compileDesign({
        code,
        topModule: body.topModule ? String(body.topModule) : undefined,
      });
      sendJson(res, result.ok ? 200 : 400, result);
    } finally {
      releaseVerilogJob(state);
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/verilog/simulate') {
    const limit = consumeRateLimit(req, state, 'verilog');
    if (!limit.ok) {
      sendRateLimited(res, limit.retryAfter);
      return;
    }
    if (!acquireVerilogJob(state)) {
      sendRateLimited(res, 10, 'The Verilog service is busy. Please try again shortly.');
      return;
    }

    try {
      const body = await readJsonBody(req);
      const code = String(body.code || '');
      if (!code.trim()) {
        sendJson(res, 400, {
          ok: false,
          errors: ['Verilog code cannot be empty.'],
          warnings: [],
          moduleCandidates: [],
          selectedTop: null,
          ports: [],
          sourceHash: '',
          compilerLog: '',
          runtimeLog: '',
          generatedTestbench: '',
          outputs: [],
        });
        return;
      }

      const result = await handlers.simulateDesign({
        code,
        topModule: body.topModule ? String(body.topModule) : undefined,
        signals: Array.isArray(body.signals) ? body.signals : [],
        stepNs: Number(body.stepNs) || 10,
      });
      sendJson(res, result.ok ? 200 : 400, result);
    } finally {
      releaseVerilogJob(state);
    }
    return;
  }

  sendText(res, 404, 'Unknown API endpoint');
}

function createDcdvServer(options = {}) {
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  const state = {
    activeVerilogJobs: 0,
    maxVerilogJobs: Math.max(1, Number(options.maxVerilogJobs || DEFAULT_MAX_VERILOG_JOBS)),
    rateBuckets: options.rateBuckets || new Map(),
    rateLimits: normalizeRateLimits(options.rateLimits),
  };
  const handlers = {
    compileDesign: options.handlers?.compileDesign || compileDesign,
    generateVerilogWithDeepSeek: options.handlers?.generateVerilogWithDeepSeek || generateVerilogWithDeepSeek,
    getDeepSeekStatus: options.handlers?.getDeepSeekStatus || getDeepSeekStatus,
    getToolchainStatus: options.handlers?.getToolchainStatus || getToolchainStatus,
    reviewVerilogWithDeepSeek: options.handlers?.reviewVerilogWithDeepSeek || reviewVerilogWithDeepSeek,
    simulateDesign: options.handlers?.simulateDesign || simulateDesign,
  };

  return http.createServer(async (req, res) => {
    try {
      const corsHeaders = getCorsHeaders(req);
      for (const [name, value] of Object.entries(corsHeaders)) {
        res.setHeader(name, value);
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = parsed.pathname || '/';

      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname, { projectRoot, state, handlers });
        return;
      }

      await serveStatic(req, res, pathname, projectRoot);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || 'Internal server error',
      });
    }
  });
}

if (require.main === module) {
  cleanupOldWorkspaces().catch(() => {});

  const server = createDcdvServer();
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`DCDV backend running at http://${HOST}:${PORT}`);
  });
}

module.exports = {
  DEFAULT_MAX_VERILOG_JOBS,
  DEFAULT_RATE_LIMITS,
  createDcdvServer,
  getClientIp,
  isSensitiveStaticPath,
  resolvePublicStaticPath,
};
