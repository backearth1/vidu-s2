#!/usr/bin/env node
'use strict';

/**
 * Vidu S2 调试台本地服务。
 *
 * 三个职责：
 *   1. 托管 public/ 静态页面
 *   2. HTTP 反代 /proxy/{env}/*  ->  https://api.vidu.{cn|com}/*
 *   3. WebSocket 隧道，同样走 /proxy/{env}/*
 *
 * 存在的理由：浏览器直连 api.vidu.cn 会被 CORS 拦掉，而且 WebSocket
 * 构造函数无法自定义 Authorization 头。官方 quickstart.py 也是这个解法，
 * 鉴权归一化逻辑与它保持一致。
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ENV_BASES = {
  cn: 'https://api.vidu.cn',
  ovs: 'https://api.vidu.com',
};

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const PUBLIC_DIR = path.join(__dirname, 'public');
const RECORD_DIR = path.join(__dirname, 'recordings');
const { spawn } = require('child_process');
const publisher = require('./lib/publisher');
const relay = require('./lib/relay');
const asr = require('./lib/asr');
const timeline = require('./lib/timeline');
const DOCS_DIR = path.join(__dirname, 'docs');

/**
 * 归一化鉴权值：页面可能把 key 放在 Authorization 头里，也可能因为
 * WebSocket 的限制塞在 ?authorization= 查询参数里。裸 vda_ 开头的补上
 * "Token " 前缀 —— Vidu 的 live 接口要求带前缀，而 s_editing 的文档示例
 * 又是不带前缀的，带前缀两边都收。
 */
function normalizeAuth(headerValue, queryValue) {
  const value = String(headerValue || '').trim() || String(queryValue || '').trim();
  if (!value) return '';
  if (value.startsWith('Bearer ') || value.startsWith('Token ')) return value;
  if (value.startsWith('vda_')) return 'Token ' + value;
  return value;
}

function maskKey(value) {
  if (!value) return '';
  const s = String(value);
  return s.length <= 12 ? '***' : `${s.slice(0, 10)}...${s.slice(-4)}`;
}

/** 解析 /proxy/{env}/rest...，返回上游 base 与剩余路径。 */
function resolveProxyRoute(reqUrl) {
  const parsed = new URL(reqUrl, 'http://placeholder');
  if (!parsed.pathname.startsWith('/proxy/')) return null;
  const rest = parsed.pathname.slice('/proxy/'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return { error: 'usage: /proxy/{env}/live/...' };
  const env = rest.slice(0, slash);
  const base = ENV_BASES[env];
  if (!base) {
    return { error: `unknown env ${env}, available: ${Object.keys(ENV_BASES).join(', ')}` };
  }
  return { base: new URL(base), upstreamPath: rest.slice(slash), search: parsed.search };
}

/** 从查询串里摘掉 authorization，并返回剩余查询串。 */
function stripAuthFromQuery(search) {
  if (!search) return { query: '', authorization: '' };
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const authorization = params.get('authorization') || '';
  params.delete('authorization');
  const query = params.toString();
  return { query: query ? '?' + query : '', authorization };
}

// ---------------------------------------------------------------- HTTP 反代

function proxyHttp(req, res) {
  const route = resolveProxyRoute(req.url);
  if (!route || route.error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(route ? route.error : 'bad proxy path');
    return;
  }

  const { query, authorization: queryAuth } = stripAuthFromQuery(route.search);
  const auth = normalizeAuth(req.headers.authorization, queryAuth);

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'content-length') continue;
    if (lower === 'origin' || lower === 'referer') continue;
    headers[key] = value;
  }
  headers.host = route.base.host;
  if (auth) headers.authorization = auth;

  const started = Date.now();
  const upstream = https.request({
    protocol: route.base.protocol,
    hostname: route.base.hostname,
    port: route.base.port || 443,
    method: req.method,
    path: route.upstreamPath + query,
    headers,
  }, (upRes) => {
    const out = {};
    for (const [key, value] of Object.entries(upRes.headers)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      out[key] = value;
    }
    out['access-control-allow-origin'] = '*';
    res.writeHead(upRes.statusCode || 502, out);
    upRes.pipe(res);
    upRes.on('end', () => {
      log(`${req.method} ${route.upstreamPath} -> ${upRes.statusCode} ${Date.now() - started}ms`
        + (auth ? ` [${maskKey(auth.replace(/^Token /, ''))}]` : ''));
    });
  });

  upstream.on('error', (err) => {
    log(`proxy error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ code: 502, reason: 'PROXY_ERROR', message: err.message }));
  });

  req.pipe(upstream);
}

// --------------------------------------------------------- WebSocket 隧道

/**
 * 浏览器 -> 本服务的 WS 升级请求，原样转发给上游，只补一个 Authorization 头。
 * 握手成功后两个 socket 直接对接，不解析 WS 帧。
 */
function proxyWebSocket(req, clientSocket, head) {
  const route = resolveProxyRoute(req.url);
  if (!route || route.error) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  const { query, authorization: queryAuth } = stripAuthFromQuery(route.search);
  const auth = normalizeAuth(req.headers.authorization, queryAuth);

  const upstream = tls.connect({
    host: route.base.hostname,
    port: Number(route.base.port) || 443,
    servername: route.base.hostname,
  }, () => {
    const lines = [
      `GET ${route.upstreamPath + query} HTTP/1.1`,
      `Host: ${route.base.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
    ];
    for (const key of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions', 'user-agent']) {
      if (req.headers[key]) lines.push(`${key}: ${req.headers[key]}`);
    }
    if (auth) lines.push(`Authorization: ${auth}`);
    lines.push('', '');
    upstream.write(lines.join('\r\n'));
    if (head && head.length) upstream.write(head);
    log(`WS ${route.upstreamPath} -> upstream${auth ? ` [${maskKey(auth.replace(/^Token /, ''))}]` : ''}`);
  });

  // 上游握手响应原样回给浏览器，之后纯粹做字节搬运。
  let handshakeDone = false;
  let buffer = Buffer.alloc(0);
  upstream.on('data', (chunk) => {
    if (handshakeDone) {
      clientSocket.write(chunk);
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    const idx = buffer.indexOf('\r\n\r\n');
    if (idx === -1) return;
    handshakeDone = true;
    const header = buffer.slice(0, idx + 4);
    const rest = buffer.slice(idx + 4);
    clientSocket.write(header);
    if (rest.length) clientSocket.write(rest);
    const status = header.toString('latin1').split('\r\n')[0];
    log(`WS handshake: ${status}`);
    if (!/HTTP\/1\.[01] 101/.test(status)) {
      clientSocket.end();
      upstream.end();
    }
  });

  clientSocket.on('data', (chunk) => upstream.write(chunk));

  const shutdown = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on('error', (err) => {
    log(`ws upstream error: ${err.message}`);
    if (!handshakeDone) {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
    shutdown();
  });
  upstream.on('close', shutdown);
  clientSocket.on('error', shutdown);
  clientSocket.on('close', shutdown);
}

// ------------------------------------------------------------------ 录像

/**
 * 浏览器 MediaRecorder 每秒吐一块数据，POST 到这里追加到服务器文件，
 * 不在浏览器内存里累积；停止后用 ffmpeg 无损转封装，让文件可拖动进度。
 *
 *   POST   /record/start?ext=mp4&name=xxx   -> { id, file }
 *   POST   /record/{id}/chunk               追加一块（请求体为原始字节）
 *   POST   /record/{id}/stop                收尾并转封装 -> { file, size }
 *   GET    /recordings                      列表
 *   GET    /recordings/{file}               下载 / 播放（支持 Range）
 *   DELETE /recordings/{file}               删除
 */
const activeRecordings = new Map();   // id -> { file, tmp, bytes }
const SAFE_NAME = /^[A-Za-z0-9._-]{1,120}$/;

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function remuxFaststart(src, dst) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-i', src, '-c', 'copy', '-movflags', '+faststart', dst]);
    ff.on('error', () => resolve(false));   // 没装 ffmpeg 就直接用原文件
    ff.on('close', (code) => resolve(code === 0));
  });
}

function handleRecording(req, res) {
  const url = new URL(req.url, 'http://placeholder');
  const parts = url.pathname.split('/').filter(Boolean);   // ['record', ...] / ['recordings', ...]
  fs.mkdirSync(RECORD_DIR, { recursive: true });

  if (parts[0] === 'recordings') {
    if (req.method === 'GET' && parts.length === 1) {
      const items = fs.readdirSync(RECORD_DIR)
        .filter((f) => SAFE_NAME.test(f) && !f.endsWith('.part'))
        .map((f) => { const st = fs.statSync(path.join(RECORD_DIR, f)); return { file: f, size: st.size, mtime: st.mtimeMs }; })
        .sort((a, b) => b.mtime - a.mtime);
      return sendJson(res, 200, { items });
    }
    const file = parts[1];
    if (!file || !SAFE_NAME.test(file)) return sendJson(res, 400, { message: 'bad file name' });
    const full = path.join(RECORD_DIR, file);
    if (req.method === 'DELETE') {
      fs.rm(full, { force: true }, () => sendJson(res, 200, { ok: true }));
      return undefined;
    }
    fs.stat(full, (err, st) => {
      if (err) return sendJson(res, 404, { message: 'not found' });
      const type = file.endsWith('.mp4') ? 'video/mp4' : 'video/webm';
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
      if (url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="${file}"`;
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(full, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { ...headers, 'Content-Length': st.size });
        fs.createReadStream(full).pipe(res);
      }
    });
    return undefined;
  }

  // /record/...
  if (req.method === 'POST' && parts[1] === 'start') {
    const ext = url.searchParams.get('ext') === 'webm' ? 'webm' : 'mp4';
    const name = (url.searchParams.get('name') || 'rec').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'rec';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const file = `${name}-${stamp}.${ext}`;
    const tmp = path.join(RECORD_DIR, `${file}.part`);
    fs.writeFileSync(tmp, '');
    activeRecordings.set(id, { file, tmp, bytes: 0 });
    log(`录像开始 ${file}`);
    return sendJson(res, 200, { id, file });
  }

  const rec = activeRecordings.get(parts[1]);
  if (!rec) return sendJson(res, 404, { message: 'unknown recording id' });

  if (req.method === 'POST' && parts[2] === 'chunk') {
    const out = fs.createWriteStream(rec.tmp, { flags: 'a' });
    let n = 0;
    req.on('data', (c) => { n += c.length; });
    req.pipe(out);
    out.on('finish', () => { rec.bytes += n; sendJson(res, 200, { bytes: rec.bytes }); });
    out.on('error', (err) => sendJson(res, 500, { message: err.message }));
    return undefined;
  }

  if (req.method === 'POST' && parts[2] === 'stop') {
    activeRecordings.delete(parts[1]);
    const finalPath = path.join(RECORD_DIR, rec.file);
    (async () => {
      const ok = rec.file.endsWith('.mp4') ? await remuxFaststart(rec.tmp, finalPath) : false;
      if (ok) fs.rmSync(rec.tmp, { force: true });
      else fs.renameSync(rec.tmp, finalPath);
      const size = fs.statSync(finalPath).size;
      log(`录像完成 ${rec.file} ${(size / 1048576).toFixed(1)}MB${ok ? '（已 faststart 转封装）' : ''}`);
      sendJson(res, 200, { file: rec.file, size, remuxed: ok });
    })().catch((err) => sendJson(res, 500, { message: err.message }));
    return undefined;
  }
  return sendJson(res, 404, { message: 'not found' });
}

// ------------------------------------------------------------ 服务端推流

/**
 *   POST /publish/upload?name=x.mp4   请求体为视频原始字节 -> 转码，返回素材元数据
 *   POST /publish/start               { assetId, rtc, maxSeconds? } -> 服务器 Chrome 入会推流
 *   POST /publish/stop
 *   GET  /publish/status              状态 + 新日志
 */
function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new Error('请求体过大')); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ------------------------------------------------------------ 语音识别 ASR

/**
 *   POST /asr/transcribe?name=&language=   body 就是文件本体
 *   返回 { text, segments[], srt, vtt, duration, n_speakers, chunks, trace_ids }
 *   language 省略或传 auto 时由 MiniMax 自动判断；其余按 BCP-47（zh / en / yue ...）
 */
function handleAsr(req, res) {
  const url = new URL(req.url, 'http://placeholder');
  const action = url.pathname.split('/')[2];
  (async () => {
    if (req.method === 'POST' && action === 'transcribe') {
      const started = Date.now();
      const name = url.searchParams.get('name') || 'media';
      const size = Number(req.headers['content-length']) || 0;
      log(`ASR 收到上传 ${name} ${size ? (size / 1048576).toFixed(1) + 'MB' : '（大小未知）'}`);
      const out = await asr.transcribe(req, {
        name,
        language: url.searchParams.get('language') || 'auto',
      });
      log(`ASR 完成 ${out.meta?.name}：${out.duration}s / ${out.segments.length} 句 / ${out.chunks} 段，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return sendJson(res, 200, out);
    }
    return sendJson(res, 404, { message: 'not found' });
  })().catch((err) => sendJson(res, err.status || 500, { message: err.message, upstreamStatus: err.upstreamStatus }));
}

// ------------------------------------------------------------ AI 动作时间轴

/**
 *   POST /timeline/generate
 *   body: { image, audio?, text?, voice?, duration?, style?, language? }
 *         image 必填：必须结合图片理解人物，识别不到人直接 422，不会凭空编动作
 *   返回 { timeline:{actions}, profile, beats, meta, warnings }
 */
function handleTimeline(req, res) {
  (async () => {
    if (req.method !== 'POST') return sendJson(res, 404, { message: 'not found' });
    let body;
    try {
      body = await readJsonBody(req, 60 * 1024 * 1024);
    } catch (err) {
      return sendJson(res, err.message === '请求体过大' ? 413 : 400, { message: err.message });
    }
    const started = Date.now();
    log(`时间轴生成开始：图片=${body.image ? '有' : '无'} 音频=${body.audio ? '有' : '无'} text=${body.text ? `${String(body.text).length}字` : '无'}`);
    const out = await timeline.generate(body);
    log(`时间轴生成完成：${out.timeline.actions.length} 段 / ${out.meta.duration}s / ${((Date.now() - started) / 1000).toFixed(1)}s · ${out.meta.source}`);
    return sendJson(res, 200, out);
  })().catch((err) => {
    // 带 status 的是可预期的参数/上游错误；没有 status 的才打堆栈，便于排查代码异常
    if (!err.status) log(`时间轴生成失败：${err.stack || err.message}`);
    return sendJson(res, err.status || 500, { message: err.message, upstreamStatus: err.upstreamStatus });
  });
}

function handlePublish(req, res) {
  const url = new URL(req.url, 'http://placeholder');
  const action = url.pathname.split('/')[2];
  const fail = (err) => sendJson(res, err.status || 500, { message: err.message });
  (async () => {
    if (req.method === 'POST' && action === 'upload') {
      const meta = await publisher.prepareUpload(req, { name: url.searchParams.get('name') || 'video', edge: url.searchParams.get('edge') });
      log(`推流素材就绪 ${meta.id} ${meta.width}x${meta.height} ${meta.duration}s ${meta.hasAudio ? '含音频' : '无音频'}`);
      return sendJson(res, 200, meta);
    }
    if (req.method === 'POST' && action === 'start') {
      const body = await readJsonBody(req);
      const proto = useTls ? 'https' : 'http';
      const out = await publisher.start({
        assetId: body.assetId, rtc: body.rtc, maxSeconds: Number(body.maxSeconds) || 0, bitrate: body.bitrate, fps: body.fps, skipProfile: body.skipProfile,
        baseUrl: `${proto}://127.0.0.1:${args.port}`,
      });
      log(`服务端推流已开始 素材=${body.assetId}`);
      return sendJson(res, 200, out);
    }
    if (req.method === 'POST' && action === 'stop') {
      await publisher.stop();
      log('服务端推流已停止');
      return sendJson(res, 200, { running: false });
    }
    if (req.method === 'POST' && action === 'inspect') return sendJson(res, 200, await publisher.inspect());
    if (req.method === 'GET' && action === 'status') return sendJson(res, 200, await publisher.status());
    return sendJson(res, 404, { message: 'not found' });
  })().catch(fail);
}

// -------------------------------------------------- 转推观看 / 服务端录像

/**
 *   POST /relay/create                 -> { key, rtmpUrl, hlsUrl }   创建时塞进 rtmp_urls
 *   GET  /live/{key}/index.m3u8 ...    HLS 反代（浏览器 hls.js 播放）
 *   POST /relay/{key}/record/start     服务端录像（ffmpeg -c copy）
 *   POST /relay/{key}/record/stop      -> { file, size }
 *   GET  /relay/{key}/status           -> { live, recording, ... }
 *   POST /relay/{key}/close            结束会话并停止录像
 */
function publicHost(req) {
  // Vidu 要从公网连进来，必须是公网地址。优先用 --public-host / PUBLIC_HOST；
  // 都没给就取访问页面用的主机名（用 IP 或域名访问时正好就是公网地址）。
  if (args.publicHost) return args.publicHost;
  return String(req.headers.host || '').replace(/:\d+$/, '') || '127.0.0.1';
}

/** 观看用低码率 HLS：直接读 ffmpeg 切好的片，只放行 hls/<key>/ 下的 m3u8 / ts。 */
function serveView(req, res) {
  const m = /^\/view\/([0-9a-f]{24})\/([A-Za-z0-9_.-]+)$/.exec((req.url || '').split('?')[0]);
  const dir = m && relay.viewDir(m[1]);
  if (!dir || !/\.(m3u8|ts)$/.test(m[2])) { res.writeHead(404).end('not found'); return; }
  const file = path.join(dir, m[2]);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Cache-Control': 'no-store' }).end('not ready'); return; }
    res.writeHead(200, {
      'Content-Type': m[2].endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'Cache-Control': m[2].endsWith('.m3u8') ? 'no-store' : 'max-age=30',
    });
    res.end(data);
  });
}

function handleRelay(req, res) {
  const parts = new URL(req.url, 'http://placeholder').pathname.split('/').filter(Boolean);   // ['relay', ...]
  const fail = (err) => sendJson(res, err.status || 500, { message: err.message });
  (async () => {
    if (req.method === 'POST' && parts[1] === 'create') {
      const host = publicHost(req);
      const sess = relay.createSession(host);
      relay.startViewHls(sess.key);
      log(`转推会话创建 ${sess.key.slice(0, 6)}… → ${sess.rtmpUrl.replace(sess.key, '***')}`);
      return sendJson(res, 200, { key: sess.key, rtmpUrl: sess.rtmpUrl, hlsUrl: sess.hlsPath, rtmpHost: host });
    }
    const key = parts[1];
    if (!key || !relay.hasSession(key)) return sendJson(res, 404, { message: '会话不存在或已结束' });
    if (req.method === 'POST' && parts[2] === 'record' && parts[3] === 'start') {
      const body = await readJsonBody(req).catch(() => ({}));
      return sendJson(res, 200, relay.startRecording(key, body.name));
    }
    if (req.method === 'POST' && parts[2] === 'record' && parts[3] === 'stop') {
      const out = await relay.stopRecording(key);
      if (out?.file) log(`录像完成 ${out.file} ${(out.size / 1048576).toFixed(1)}MB`);
      return sendJson(res, 200, out || { file: null });
    }
    if (req.method === 'GET' && parts[2] === 'status') return sendJson(res, 200, relay.recordingState(key));
    if (req.method === 'POST' && parts[2] === 'close') {
      const out = await relay.closeSession(key);
      return sendJson(res, 200, out || { closed: true });
    }
    return sendJson(res, 404, { message: 'not found' });
  })().catch(fail);
}

// ------------------------------------------------------------- 静态文件

function serveStatic(req, res) {
  const parsed = new URL(req.url, 'http://placeholder');
  let pathname = decodeURIComponent(parsed.pathname);

  // /docs/* 直读仓库里的文档 markdown，页面内的「字段说明」会拉它
  let baseDir = PUBLIC_DIR;
  if (pathname.startsWith('/docs/')) {
    baseDir = DOCS_DIR;
    pathname = pathname.slice('/docs'.length);
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const filePath = path.join(baseDir, pathname);
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found: ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ------------------------------------------------------------------ 启动

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function parseArgs(argv) {
  const out = {
    host: '0.0.0.0', port: 28890, apiKey: process.env.VIDU_API_KEY || '', env: 'cn', publicHost: process.env.PUBLIC_HOST || '',
    minimaxKey: process.env.MINIMAX_API_KEY || '', timelineModel: process.env.TIMELINE_MODEL || '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg === '--host') out.host = argv[++i];
    else if (arg === '--api-key') out.apiKey = argv[++i];
    else if (arg === '--env') out.env = argv[++i];
    else if (arg === '--public-host') out.publicHost = argv[++i];
    else if (arg === '--tls-cert') out.tlsCert = argv[++i];
    else if (arg === '--tls-key') out.tlsKey = argv[++i];
    else if (arg === '--minimax-key') out.minimaxKey = argv[++i];
    else if (arg === '--timeline-model') out.timelineModel = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
asr.configure(args.minimaxKey);
timeline.configure({ apiKey: args.minimaxKey, model: args.timelineModel });

// 浏览器只在安全上下文（https 或 localhost）开放摄像头 / 麦克风 / WebRTC，
// 公网 IP 走 http 访问时 AliRTC 会直接判定不支持。传入证书即切到 https。
const useTls = Boolean(args.tlsCert && args.tlsKey);
const handler = (req, res) => {
  if (req.url.startsWith('/proxy/')) {
    proxyHttp(req, res);
    return;
  }
  if (req.url.startsWith('/relay/')) {
    handleRelay(req, res);
    return;
  }
  if (req.url.startsWith('/view/')) {
    serveView(req, res);
    return;
  }
  if (req.url.startsWith('/publish/')) {
    handlePublish(req, res);
    return;
  }
  if (req.url.startsWith('/asr/')) {
    handleAsr(req, res);
    return;
  }
  if (req.url.startsWith('/timeline/')) {
    handleTimeline(req, res);
    return;
  }
  if (req.url.startsWith('/record/') || req.url.startsWith('/recordings')) {
    handleRecording(req, res);
    return;
  }
  // 页面启动时拉这个，用来拿服务端注入的 API Key 与默认环境
  if (req.url.startsWith('/bootstrap')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      apiKey: args.apiKey,
      env: args.env,
      minimaxConfigured: asr.configured(),
      timelineConfigured: timeline.configured(),
      timelineModel: args.timelineModel || timeline.DEFAULT_MODEL,
    }));
    return;
  }
  serveStatic(req, res);
};
const server = useTls
  ? https.createServer({ cert: fs.readFileSync(args.tlsCert), key: fs.readFileSync(args.tlsKey) }, handler)
  : http.createServer(handler);

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/proxy/')) {
    proxyWebSocket(req, socket, head);
  } else {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  }
});

relay.startMediamtx(log);

server.listen(args.port, args.host, () => {
  const shown = args.host === '0.0.0.0' ? '127.0.0.1' : args.host;
  console.log('');
  console.log(`  Vidu S2 调试台  ${useTls ? 'https' : 'http'}://${shown}:${args.port}`);
  console.log(`  代理环境        ${Object.entries(ENV_BASES).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`  API Key         ${args.apiKey ? maskKey(args.apiKey) + '（已从启动参数注入）' : '未注入，请在页面顶部填写'}`);
  console.log(`  MiniMax ASR     ${asr.configured() ? '已配置（speech_to_text）' : '未配置，ASR 不可用（--minimax-key）'}`);
  console.log(`  AI 时间轴       ${timeline.configured() ? `已配置（${args.timelineModel || timeline.DEFAULT_MODEL}）` : '未配置，按钮不可用（--minimax-key）'}`);
  console.log('');
});
