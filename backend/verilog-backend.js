const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WORKSPACE_ROOT = path.join(os.tmpdir(), 'dcdv-verilog-workspaces');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOCAL_TOOL_BIN = path.join(PROJECT_ROOT, 'tools', 'iverilog', 'bin');
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const TYPE_KEYWORDS_RE = /\b(?:wire|reg|logic|signed|unsigned|tri|tri0|tri1|supply0|supply1|wand|wor|uwire)\b/g;
const DIRECTION_RE = /\b(input|output|inout)\b/;

function stripVerilogComments(source) {
  let out = '';
  let state = 'normal';

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === 'line-comment') {
      if (ch === '\n') {
        out += '\n';
        state = 'normal';
      } else {
        out += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        out += '  ';
        i += 1;
        state = 'normal';
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (state === 'string') {
      out += ch;
      if (ch === '\\' && next) {
        out += next;
        i += 1;
      } else if (ch === '"') {
        state = 'normal';
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      out += '  ';
      i += 1;
      state = 'line-comment';
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 1;
      state = 'block-comment';
      continue;
    }

    if (ch === '"') {
      out += ch;
      state = 'string';
      continue;
    }

    out += ch;
  }

  return out;
}

function skipWhitespace(text, index) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function findMatchingParen(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelComma(text) {
  const parts = [];
  let current = '';
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '[') bracketDepth += 1;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === '{') braceDepth += 1;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);

    if (ch === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) parts.push(current);
  return parts;
}

function extractIdentifiers(text) {
  return (text.match(/\b[A-Za-z_$][\w$]*\b/g) || []).filter((token) => IDENTIFIER_RE.test(token));
}

function evaluateSimpleRangeExpr(expr) {
  const normalized = String(expr || '').replace(/_/g, '').trim();
  if (!normalized) return null;
  if (!/^[\d+\-*/()%\s]+$/.test(normalized)) return null;
  try {
    const value = Function(`"use strict"; return (${normalized});`)();
    return Number.isFinite(value) ? Number(value) : null;
  } catch (error) {
    return null;
  }
}

function parseRange(rangeText) {
  if (!rangeText) {
    return { width: 1, msb: 0, lsb: 0, msbRaw: '0', lsbRaw: '0' };
  }
  const match = rangeText.match(/\[\s*([^:\]]+)\s*:\s*([^\]]+)\s*\]/);
  if (!match) {
    return { width: 1, msb: 0, lsb: 0, msbRaw: '0', lsbRaw: '0' };
  }
  const [, msbRaw, lsbRaw] = match;
  const msb = evaluateSimpleRangeExpr(msbRaw);
  const lsb = evaluateSimpleRangeExpr(lsbRaw);
  if (msb == null || lsb == null) {
    return { width: 1, msb: 0, lsb: 0, msbRaw: msbRaw.trim(), lsbRaw: lsbRaw.trim() };
  }
  return {
    width: Math.abs(msb - lsb) + 1,
    msb,
    lsb,
    msbRaw: msbRaw.trim(),
    lsbRaw: lsbRaw.trim(),
  };
}

function normalizePortName(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function buildPort(name, options) {
  const rangeInfo = parseRange(options.rangeText);
  return {
    name: normalizePortName(name),
    direction: options.direction,
    width: rangeInfo.width,
    msb: rangeInfo.msb,
    lsb: rangeInfo.lsb,
    signed: !!options.signed,
    msbRaw: rangeInfo.msbRaw,
    lsbRaw: rangeInfo.lsbRaw,
  };
}

function dedupePorts(ports) {
  const seen = new Set();
  const result = [];
  for (const port of ports) {
    if (!port || !port.name || seen.has(port.name)) continue;
    seen.add(port.name);
    result.push(port);
  }
  return result;
}

function parseAnsiPorts(portListText) {
  const segments = splitTopLevelComma(portListText);
  const ports = [];
  let current = { direction: null, signed: false, rangeText: null };

  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (!segment) continue;

    const directionMatch = segment.match(DIRECTION_RE);
    let working = segment;
    if (directionMatch) {
      current = {
        direction: directionMatch[1],
        signed: /\bsigned\b/.test(segment),
        rangeText: (segment.match(/\[[^\]]+\]/) || [null])[0],
      };
      working = working.replace(DIRECTION_RE, ' ');
    } else {
      if (/\bsigned\b/.test(segment)) current.signed = true;
      if (/\[[^\]]+\]/.test(segment)) current.rangeText = (segment.match(/\[[^\]]+\]/) || [current.rangeText])[0];
    }

    working = working.replace(TYPE_KEYWORDS_RE, ' ').replace(/\[[^\]]+\]/g, ' ');
    const names = extractIdentifiers(working).filter((token) => !['input', 'output', 'inout'].includes(token));
    names.forEach((name) => {
      if (current.direction) {
        ports.push(buildPort(name, current));
      }
    });
  }

  return dedupePorts(ports);
}

function parseBodyStylePorts(portListText, moduleBody) {
  const headerOrder = dedupePorts(
    splitTopLevelComma(portListText).flatMap((segment) => {
      const cleaned = segment.replace(/\[[^\]]+\]/g, ' ');
      return extractIdentifiers(cleaned);
    }).map((name) => ({ name }))
  ).map((port) => port.name);

  const found = new Map();
  const declarationRegex = /\b(input|output|inout)\b([\s\S]*?);/g;
  let match;
  while ((match = declarationRegex.exec(moduleBody))) {
    const direction = match[1];
    const rest = match[2];
    const segments = splitTopLevelComma(rest);
    let current = { direction, signed: /\bsigned\b/.test(rest), rangeText: (rest.match(/\[[^\]]+\]/) || [null])[0] };
    for (const rawSegment of segments) {
      const segment = rawSegment.trim();
      if (!segment) continue;
      if (/\bsigned\b/.test(segment)) current.signed = true;
      if (/\[[^\]]+\]/.test(segment)) current.rangeText = (segment.match(/\[[^\]]+\]/) || [current.rangeText])[0];
      const cleaned = segment.replace(TYPE_KEYWORDS_RE, ' ').replace(/\[[^\]]+\]/g, ' ');
      extractIdentifiers(cleaned).forEach((name) => {
        if (!found.has(name)) {
          found.set(name, buildPort(name, current));
        }
      });
    }
  }

  const ordered = [];
  headerOrder.forEach((name) => {
    ordered.push(found.get(name) || buildPort(name, { direction: 'input', signed: false, rangeText: null }));
  });

  for (const [name, port] of found.entries()) {
    if (!headerOrder.includes(name)) ordered.push(port);
  }

  return dedupePorts(ordered);
}

function parseModulePorts(moduleBlock) {
  if (!moduleBlock || !moduleBlock.portListText) return [];
  const hasAnsiDirection = splitTopLevelComma(moduleBlock.portListText).some((segment) => DIRECTION_RE.test(segment));
  const ports = hasAnsiDirection
    ? parseAnsiPorts(moduleBlock.portListText)
    : parseBodyStylePorts(moduleBlock.portListText, moduleBlock.bodyCleaned);
  return dedupePorts(ports);
}

function extractModuleBlocks(source) {
  const cleaned = stripVerilogComments(source);
  const modules = [];
  const moduleRegex = /\bmodule\b/g;
  let match;

  while ((match = moduleRegex.exec(cleaned))) {
    const start = match.index;
    let cursor = skipWhitespace(cleaned, start + 'module'.length);
    const nameMatch = cleaned.slice(cursor).match(/^([A-Za-z_$][\w$]*)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    cursor += name.length;
    cursor = skipWhitespace(cleaned, cursor);

    if (cleaned[cursor] === '#') {
      cursor = skipWhitespace(cleaned, cursor + 1);
      if (cleaned[cursor] === '(') {
        const parameterEnd = findMatchingParen(cleaned, cursor);
        if (parameterEnd < 0) break;
        cursor = parameterEnd + 1;
      }
    }

    cursor = skipWhitespace(cleaned, cursor);
    let portListText = '';
    if (cleaned[cursor] === '(') {
      const portEnd = findMatchingParen(cleaned, cursor);
      if (portEnd < 0) break;
      portListText = cleaned.slice(cursor + 1, portEnd);
      cursor = portEnd + 1;
    }

    const headerEnd = cleaned.indexOf(';', cursor);
    if (headerEnd < 0) break;

    const endModuleRegex = /\bendmodule\b/g;
    endModuleRegex.lastIndex = headerEnd;
    const endMatch = endModuleRegex.exec(cleaned);
    if (!endMatch) break;

    modules.push({
      name,
      start,
      end: endMatch.index + 'endmodule'.length,
      headerEnd,
      source: source.slice(start, endMatch.index + 'endmodule'.length),
      cleaned: cleaned.slice(start, endMatch.index + 'endmodule'.length),
      bodySource: source.slice(headerEnd + 1, endMatch.index),
      bodyCleaned: cleaned.slice(headerEnd + 1, endMatch.index),
      portListText,
    });

    moduleRegex.lastIndex = endMatch.index + 'endmodule'.length;
  }

  return modules;
}

function detectModuleInfo(source) {
  const modules = extractModuleBlocks(source);
  const moduleNames = modules.map((moduleBlock) => moduleBlock.name);
  const instantiated = new Set();

  modules.forEach((moduleBlock) => {
    moduleNames.forEach((candidateName) => {
      if (candidateName === moduleBlock.name) return;
      const instantiationRegex = new RegExp(
        `\\b${candidateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\s*(?:#\\s*\\([^;]*?\\)\\s*)?[A-Za-z_$][\\w$]*\\s*\\(`,
        'g'
      );
      if (instantiationRegex.test(moduleBlock.bodyCleaned)) {
        instantiated.add(candidateName);
      }
    });
  });

  const moduleCandidates = moduleNames.filter((name) => !instantiated.has(name));
  return {
    modules,
    moduleNames,
    moduleCandidates: moduleCandidates.length ? moduleCandidates : moduleNames,
  };
}

function resolveTopModule(source, requestedTopModule) {
  const info = detectModuleInfo(source);
  const { modules, moduleCandidates } = info;
  let selectedTop = null;
  let error = null;

  if (requestedTopModule) {
    if (modules.some((moduleBlock) => moduleBlock.name === requestedTopModule)) {
      selectedTop = requestedTopModule;
    } else {
      error = `指定的顶层模块不存在：${requestedTopModule}`;
    }
  } else if (moduleCandidates.length === 1) {
    selectedTop = moduleCandidates[0];
  }

  const moduleBlock = selectedTop ? modules.find((item) => item.name === selectedTop) : null;
  const ports = moduleBlock ? parseModulePorts(moduleBlock) : [];

  return {
    ...info,
    selectedTop,
    ports,
    error,
  };
}

function hashSource(source) {
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 20);
}

async function ensureWorkspace(sourceHash) {
  const dir = path.join(WORKSPACE_ROOT, sourceHash);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function collectLogLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function splitCompilerMessages(logText) {
  const lines = collectLogLines(logText);
  const warnings = [];
  const errors = [];
  lines.forEach((line) => {
    if (/warning/i.test(line)) warnings.push(line);
    else errors.push(line);
  });
  return { warnings, errors };
}

function runProcess(command, args, options = {}) {
  const { cwd, timeoutMs = 15000 } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ok: false,
        code: null,
        stdout: '',
        stderr: error.message || String(error),
        error,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({
          ok: false,
          code: null,
          stdout,
          stderr: `${stderr}\nProcess timeout after ${timeoutMs}ms`.trim(),
          timedOut: true,
        });
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        error,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
      });
    });
  });
}

function resolveExecutable(command) {
  const exeName = process.platform === 'win32' ? `${command}.exe` : command;
  const localPath = path.join(LOCAL_TOOL_BIN, exeName);
  if (fs.existsSync(localPath)) return localPath;
  return command;
}

async function detectExecutable(command, args = ['-V']) {
  const executable = resolveExecutable(command);
  const result = await runProcess(executable, args, { timeoutMs: 5000 });
  if (result.error && result.error.code === 'ENOENT') {
    return { available: false, version: null, detail: `${command} not found in PATH` };
  }
  if (!result.ok && result.code == null && /not found/i.test(result.stderr || '')) {
    return { available: false, version: null, detail: `${command} not found in PATH` };
  }
  const version = collectLogLines(`${result.stdout}\n${result.stderr}`)[0] || null;
  return {
    available: result.ok,
    version,
    detail: collectLogLines(`${result.stdout}\n${result.stderr}`).slice(0, 4).join('\n'),
  };
}

async function getToolchainStatus() {
  const [iverilog, vvp] = await Promise.all([detectExecutable('iverilog'), detectExecutable('vvp')]);
  return {
    ok: iverilog.available && vvp.available,
    iverilog,
    vvp,
  };
}

function sanitizeSignalName(name) {
  return String(name || '').trim();
}

function toBigIntValue(rawValue, radixHint = 'dec') {
  if (typeof rawValue === 'bigint') return rawValue;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return BigInt(Math.max(0, Math.trunc(rawValue)));
  const text = String(rawValue ?? '').trim().replace(/_/g, '');
  if (!text) return 0n;

  if (/^[xz?]+$/i.test(text)) return text.toLowerCase().replace(/\?/g, 'x');
  if (/^0b[01xz]+$/i.test(text)) return text.slice(2).toLowerCase();
  if (/^0x[0-9a-fxz]+$/i.test(text)) {
    const payload = text.slice(2);
    if (/[xz]/i.test(payload)) {
      return payload
        .toLowerCase()
        .split('')
        .map((ch) => {
          if (ch === 'x' || ch === 'z') return ch.repeat(4);
          return parseInt(ch, 16).toString(2).padStart(4, '0');
        })
        .join('');
    }
    return BigInt(`0x${payload}`);
  }
  if (/^0o[0-7]+$/i.test(text)) return BigInt(`0o${text.slice(2)}`);
  if (/^0d\d+$/i.test(text)) return BigInt(text.slice(2));

  if (/^[0-9]+$/.test(text)) {
    if (radixHint === 'bin') return BigInt(`0b${text}`);
    if (radixHint === 'hex') return BigInt(`0x${text}`);
    return BigInt(text);
  }

  if (radixHint === 'bin' && /^[01xz]+$/i.test(text)) return text.toLowerCase();
  if (radixHint === 'hex' && /^[0-9a-fxz]+$/i.test(text)) {
    if (/[xz]/i.test(text)) {
      return text
        .toLowerCase()
        .split('')
        .map((ch) => (ch === 'x' || ch === 'z' ? ch.repeat(4) : parseInt(ch, 16).toString(2).padStart(4, '0')))
        .join('');
    }
    return BigInt(`0x${text}`);
  }

  return 0n;
}

function stringifyBinaryValue(value, width) {
  if (typeof value === 'string') {
    const payload = value.replace(/[^01xz]/gi, '').toLowerCase();
    if (!payload) return '0'.repeat(Math.max(1, width));
    return payload.length >= width ? payload.slice(-width) : payload.padStart(width, payload[0] === 'z' ? 'z' : payload[0] === 'x' ? 'x' : '0');
  }
  const effectiveWidth = Math.max(1, Number(width) || 1);
  const mask = (1n << BigInt(effectiveWidth)) - 1n;
  return (value & mask).toString(2).padStart(effectiveWidth, '0');
}

function toVerilogLiteral(value, width, radixHint = 'dec') {
  const parsed = toBigIntValue(value, radixHint);
  const effectiveWidth = Math.max(1, Number(width) || 1);
  const payload = stringifyBinaryValue(parsed, effectiveWidth);
  return `${effectiveWidth}'b${payload}`;
}

function coerceStepCount(signals) {
  const counts = (signals || []).map((signal) => Array.isArray(signal.values) ? signal.values.length : 0);
  return Math.max(1, ...counts, 16);
}

function normalizeRequestedSignals(ports, signals) {
  const signalMap = new Map((signals || []).map((signal) => [sanitizeSignalName(signal.name), signal]));
  const steps = coerceStepCount(signals);
  const normalized = ports.map((port) => {
    const incoming = signalMap.get(port.name);
    const radix = incoming?.radix || (port.width > 1 ? 'hex' : 'bin');
    const values = Array.from({ length: steps }, (_, index) => {
      if (port.direction === 'input') {
        return incoming?.values?.[index] ?? 0;
      }
      return incoming?.values?.[index] ?? 0;
    });
    return {
      ...port,
      kind: port.direction === 'input' ? 'in' : 'out',
      radix,
      values,
    };
  });
  return { steps, signals: normalized };
}

function buildSimulationTestbench({ topModule, ports, signals, stepNs }) {
  const steps = coerceStepCount(signals);
  const inputPorts = ports.filter((port) => port.direction === 'input');
  const orderedInputPorts = [...inputPorts].sort((a, b) => {
    const rank = (port) => {
      if (/^(clk|clock)$/i.test(port.name)) return 2;
      if (/^(rst|reset)$/i.test(port.name)) return 1;
      return 0;
    };
    return rank(a) - rank(b);
  });
  const outputPorts = ports.filter((port) => port.direction !== 'input');
  const signalMap = new Map((signals || []).map((signal) => [signal.name, signal]));

  const declarationForPort = (port, keyword) => {
    if (port.width > 1) return `    ${keyword} [${port.msb}:${port.lsb}] ${port.name};`;
    return `    ${keyword} ${port.name};`;
  };

  const instanceMap = ports
    .map((port) => `        .${port.name}(${port.name})`)
    .join(',\n');

  const stepBlocks = [];
  for (let stepIndex = 0; stepIndex < steps; stepIndex += 1) {
    const assigns = orderedInputPorts
      .map((port) => {
        const signal = signalMap.get(port.name);
        const rawValue = signal?.values?.[stepIndex] ?? 0;
        const literal = toVerilogLiteral(rawValue, port.width, signal?.radix || 'dec');
        return `        ${port.name} = ${literal};`;
      })
      .join('\n');

    const outputWrites = outputPorts
      .map((port) => `        $write(" |${port.name}="); $write("%b", ${port.name});`)
      .join('\n');

    stepBlocks.push(
      `${assigns}\n        #${Math.max(1, Number(stepNs) || 10)};\n        $write("__DCDV_STEP__ ${stepIndex}");\n${outputWrites}\n        $display("");`
    );
  }

  return [
    '`timescale 1ns / 1ps',
    '',
    'module __dcdv_tb;',
    ...inputPorts.map((port) => declarationForPort(port, 'reg')),
    ...outputPorts.map((port) => declarationForPort(port, 'wire')),
    '',
    `    ${topModule} uut (`,
    instanceMap,
    '    );',
    '',
    '    initial begin',
    ...stepBlocks.flatMap((block) => block.split('\n')),
    '        $finish;',
    '    end',
    'endmodule',
    '',
  ].join('\n');
}

function parseSimulationRuntime(runtimeLog, ports) {
  const outputPorts = ports.filter((port) => port.direction !== 'input');
  const outputMap = new Map(
    outputPorts.map((port) => [
      port.name,
      {
        name: port.name,
        kind: 'out',
        width: port.width,
        radix: port.width > 1 ? 'hex' : 'bin',
        values: [],
      },
    ])
  );

  const lines = collectLogLines(runtimeLog);
  lines.forEach((line) => {
    if (!line.startsWith('__DCDV_STEP__')) return;
    const parts = line.split('|').map((part) => part.trim()).filter(Boolean);
    const stepMatch = parts[0].match(/^__DCDV_STEP__\s+(\d+)/);
    if (!stepMatch) return;
    const stepIndex = Number(stepMatch[1]);
    parts.slice(1).forEach((chunk) => {
      const [name, rawValue] = chunk.split('=');
      if (!outputMap.has(name)) return;
      const port = outputPorts.find((item) => item.name === name);
      if (!port) return;
      const normalized = stringifyBinaryValue(rawValue || '', port.width);
      const signal = outputMap.get(name);
      signal.values[stepIndex] = port.width === 1 && /^[01]$/.test(normalized) ? Number(normalized) : normalized;
    });
  });

  return Array.from(outputMap.values());
}

function buildCompilerResponse({ ok, selectedTop, sourceHash, ports, moduleCandidates, compilerLog, extraErrors = [], extraWarnings = [] }) {
  const split = splitCompilerMessages(compilerLog);
  return {
    ok,
    selectedTop,
    sourceHash,
    ports,
    moduleCandidates,
    compilerLog,
    warnings: [...extraWarnings, ...split.warnings],
    errors: [...extraErrors, ...split.errors],
  };
}

async function compileDesign({ code, topModule }) {
  const toolchain = await getToolchainStatus();
  const sourceHash = hashSource(code);
  const resolved = resolveTopModule(code, topModule);
  const workspaceDir = await ensureWorkspace(sourceHash);
  const designPath = path.join(workspaceDir, 'design.v');
  await fsp.writeFile(designPath, code, 'utf8');

  if (!toolchain.ok) {
    return buildCompilerResponse({
      ok: false,
      selectedTop: resolved.selectedTop,
      sourceHash,
      ports: resolved.ports,
      moduleCandidates: resolved.moduleCandidates,
      compilerLog: [toolchain.iverilog.detail, toolchain.vvp.detail].filter(Boolean).join('\n'),
      extraErrors: ['未检测到可用的 iverilog/vvp，请先安装并加入 PATH。'],
    });
  }

  if (resolved.error) {
    return buildCompilerResponse({
      ok: false,
      selectedTop: null,
      sourceHash,
      ports: [],
      moduleCandidates: resolved.moduleCandidates,
      compilerLog: resolved.error,
      extraErrors: [resolved.error],
    });
  }

  const args = ['-g2012', '-t', 'null'];
  if (resolved.selectedTop) {
    args.push('-s', resolved.selectedTop);
  }
  args.push('design.v');
  const run = await runProcess(resolveExecutable('iverilog'), args, { cwd: workspaceDir, timeoutMs: 20000 });
  const compilerLog = `${run.stdout}\n${run.stderr}`.trim();

  const extraWarnings = [];
  if (!resolved.selectedTop && resolved.moduleCandidates.length > 1) {
    extraWarnings.push(`检测到多个顶层候选模块：${resolved.moduleCandidates.join(', ')}，请选择一个顶层后再运行仿真。`);
  }

  return buildCompilerResponse({
    ok: run.ok,
    selectedTop: resolved.selectedTop,
    sourceHash,
    ports: resolved.ports,
    moduleCandidates: resolved.moduleCandidates,
    compilerLog,
    extraWarnings,
  });
}

async function simulateDesign({ code, topModule, signals, stepNs }) {
  const compileResult = await compileDesign({ code, topModule });
  if (!compileResult.ok) {
    return {
      ...compileResult,
      runtimeLog: '',
      generatedTestbench: '',
      outputs: [],
    };
  }
  if (!compileResult.selectedTop) {
    return {
      ...compileResult,
      ok: false,
      runtimeLog: '',
      generatedTestbench: '',
      outputs: [],
      errors: [...compileResult.errors, '仿真前必须先确定唯一的顶层模块。'],
    };
  }

  const sourceHash = compileResult.sourceHash;
  const workspaceDir = await ensureWorkspace(sourceHash);
  const designPath = path.join(workspaceDir, 'design.v');
  const tbPath = path.join(workspaceDir, 'dcdv_tb.v');
  const simPath = path.join(workspaceDir, 'dcdv_sim.out');
  await fsp.writeFile(designPath, code, 'utf8');

  const normalized = normalizeRequestedSignals(compileResult.ports, signals);
  const generatedTestbench = buildSimulationTestbench({
    topModule: compileResult.selectedTop,
    ports: compileResult.ports,
    signals: normalized.signals,
    stepNs,
  });
  await fsp.writeFile(tbPath, generatedTestbench, 'utf8');

  const compileArgs = ['-g2012', '-o', 'dcdv_sim.out', '-s', '__dcdv_tb', 'design.v', 'dcdv_tb.v'];
  const compileRun = await runProcess(resolveExecutable('iverilog'), compileArgs, { cwd: workspaceDir, timeoutMs: 20000 });
  const compilerLog = `${compileResult.compilerLog}\n${compileRun.stdout}\n${compileRun.stderr}`.trim();
  if (!compileRun.ok) {
    const split = splitCompilerMessages(compilerLog);
    return {
      ok: false,
      selectedTop: compileResult.selectedTop,
      sourceHash,
      ports: compileResult.ports,
      moduleCandidates: compileResult.moduleCandidates,
      compilerLog,
      runtimeLog: '',
      generatedTestbench,
      outputs: [],
      warnings: split.warnings,
      errors: split.errors,
    };
  }

  const runtimeRun = await runProcess(resolveExecutable('vvp'), [simPath], { cwd: workspaceDir, timeoutMs: 20000 });
  const runtimeLog = `${runtimeRun.stdout}\n${runtimeRun.stderr}`.trim();
  if (!runtimeRun.ok) {
    const split = splitCompilerMessages(runtimeLog);
    return {
      ok: false,
      selectedTop: compileResult.selectedTop,
      sourceHash,
      ports: compileResult.ports,
      moduleCandidates: compileResult.moduleCandidates,
      compilerLog,
      runtimeLog,
      generatedTestbench,
      outputs: [],
      warnings: split.warnings,
      errors: split.errors,
    };
  }

  return {
    ok: true,
    selectedTop: compileResult.selectedTop,
    sourceHash,
    ports: compileResult.ports,
    moduleCandidates: compileResult.moduleCandidates,
    compilerLog,
    runtimeLog,
    generatedTestbench,
    outputs: parseSimulationRuntime(runtimeRun.stdout, compileResult.ports),
    warnings: compileResult.warnings,
    errors: compileResult.errors,
  };
}

async function cleanupOldWorkspaces(maxAgeMs = 1000 * 60 * 60 * 12) {
  await fsp.mkdir(WORKSPACE_ROOT, { recursive: true });
  const entries = await fsp.readdir(WORKSPACE_ROOT, { withFileTypes: true });
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const target = path.join(WORKSPACE_ROOT, entry.name);
        try {
          const stat = await fsp.stat(target);
          if (now - stat.mtimeMs > maxAgeMs) {
            await fsp.rm(target, { recursive: true, force: true });
          }
        } catch (error) {
          // Best-effort cleanup only.
        }
      })
  );
}

module.exports = {
  WORKSPACE_ROOT,
  buildSimulationTestbench,
  cleanupOldWorkspaces,
  compileDesign,
  detectModuleInfo,
  getToolchainStatus,
  hashSource,
  parseModulePorts,
  parseSimulationRuntime,
  resolveExecutable,
  resolveTopModule,
  simulateDesign,
  splitTopLevelComma,
  stripVerilogComments,
  toVerilogLiteral,
};
