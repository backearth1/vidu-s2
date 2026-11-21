'use strict';

/**
 * 服务端伪推流。
 *
 * 浏览器端 captureStream 的链路是 解码 -> 重绘 -> 再编码，帧率受标签页前后台和本机性能影响。
 * 这里改成：上传的视频先用 ffmpeg 转成规整素材（30fps MJPEG + 48kHz WAV），
 * 再由服务器上的无头 Chrome 把它们当作「摄像头 + 麦克风」入会推流
 * （--use-file-for-fake-video-capture / --use-file-for-fake-audio-capture），
 * 对 AliRTC SDK 来说就是一个真实设备，不需要任何垫片。
 *
 * 零依赖：Chrome 的 CDP 调试协议用 Node 22 自带的全局 WebSocket 讲。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..', 'publish');
const MAX_SECONDS = 60;
const MAX_UPLOAD_BYTES = 600 * 1024 * 1024;
/** Chromium 假摄像头固定按 30fps 读文件，素材帧率必须与之一致，否则会变速。 */
const FPS = 30;
const KEEP_ASSETS = 5;
const SAFE_ID = /^[a-z0-9]{6,24}$/;

let current = null;   // { chrome, cdp, sessionId, assetId, startedAt, timer, logs, pageState }

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} 失败：${(stderr || err.message).toString().trim().slice(-400)}`));
      else resolve(stdout.toString());
    });
  });
}

// ------------------------------------------------------------------ 素材

function assetPath(id, ext) {
  if (!SAFE_ID.test(id)) throw new Error('非法素材 id');
  return path.join(ROOT, `${id}.${ext}`);
}

function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(assetPath(id, 'json'), 'utf8')); } catch { return null; }
}

function pruneAssets() {
  const metas = fs.readdirSync(ROOT).filter((f) => f.endsWith('.json'))
    .map((f) => ({ id: f.slice(0, -5), mtime: fs.statSync(path.join(ROOT, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of metas.slice(KEEP_ASSETS)) {
    if (current?.assetId === old.id) continue;
    for (const ext of ['json', 'mjpeg', 'wav']) fs.rmSync(assetPath(old.id, ext), { force: true });
  }
}

/** 把请求体写到临时文件，再转码成推流素材。返回素材元数据。 */
async function prepareUpload(req, { name = 'video', edge = 960 } = {}) {
  edge = Math.min(1920, Math.max(240, Math.round(Number(edge) || 960)));
  fs.mkdirSync(ROOT, { recursive: true });
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const src = path.join(ROOT, `${id}.upload`);

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(src);
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) { req.destroy(); out.destroy(); reject(new Error(`文件超过 ${MAX_UPLOAD_BYTES / 1048576}MB`)); }
    });
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  });

  try {
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src]));
    const video = (probe.streams || []).find((s) => s.codec_type === 'video');
    const hasAudio = (probe.streams || []).some((s) => s.codec_type === 'audio');
    if (!video) throw new Error('文件里没有视频流');
    const duration = Number(probe.format?.duration) || 0;
    if (duration > MAX_SECONDS + 0.5) throw new Error(`视频时长 ${duration.toFixed(1)} 秒，超过 ${MAX_SECONDS} 秒上限`);

    // 最长边不超过 1280，宽高取偶数；竖屏视频保持竖屏
    const even = (e) => `trunc(${e}/2)*2`;
    const vf = [
      `fps=${FPS}`,
      `scale='if(gte(iw,ih),${even(`min(${edge},iw)`)},-2)':'if(gte(iw,ih),-2,${even(`min(${edge},ih)`)})':flags=lanczos`,
      'format=yuvj420p',
    ].join(',');
    const mjpeg = assetPath(id, 'mjpeg');
    await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-an', '-vf', vf, '-c:v', 'mjpeg', '-q:v', '2', '-f', 'mjpeg', mjpeg]);

    const info = JSON.parse(await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'json', mjpeg])).streams[0];
    const nFrames = Number(info.nb_read_frames);
    if (!nFrames) throw new Error('转码后没有视频帧');
    // 音频时长严格对齐视频帧数：假音频与假视频各自循环，长度一致才不会越循环越错位
    const loopSeconds = nFrames / FPS;

    const wav = assetPath(id, 'wav');
    const audioArgs = hasAudio
      ? ['-i', src, '-vn', '-af', 'aresample=async=1:first_pts=0,apad']
      : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono'];
    await run('ffmpeg', ['-y', '-v', 'error', ...audioArgs, '-t', loopSeconds.toFixed(3), '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav]);

    const meta = {
      id, name: String(name).slice(0, 80), duration: +loopSeconds.toFixed(2), frames: nFrames, fps: FPS,
      width: Number(info.width), height: Number(info.height), hasAudio,
      bytes: fs.statSync(mjpeg).size + fs.statSync(wav).size,
    };
    fs.writeFileSync(assetPath(id, 'json'), JSON.stringify(meta));
    pruneAssets();
    return meta;
  } catch (err) {
    for (const ext of ['mjpeg', 'wav', 'json']) fs.rmSync(assetPath(id, ext), { force: true });
    throw err;
  } finally {
    fs.rmSync(src, { force: true });
  }
}

// ------------------------------------------------------------------ Chrome / CDP

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    const dirs = fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const p = path.join(cache, d, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* 没装 playwright */ }
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const waiter = msg.id && this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
    });
    this.ws.addEventListener('close', () => {
      for (const w of this.pending.values()) w.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function pageEval(expression, { awaitPromise = false } = {}) {
  const res = await current.cdp.send('Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true }, current.sessionId);
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || '页面脚本异常');
  }
  return res.result?.value;
}

function launchChrome(chromePath, userDir, files) {
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${files.video}`,
    `--use-file-for-fake-audio-capture=${files.audio}`,
    '--autoplay-policy=no-user-gesture-required',
    '--ignore-certificate-errors',   // 只访问本机的自签证书页面
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1280,720',
    // Ubuntu 23.10+ 的 AppArmor 禁了非特权用户命名空间，Chrome 沙箱起不来（Playwright 也是默认关沙箱）。
    // 这个 Chrome 只加载本机的 publisher.html，不浏览任意外部页面。
    '--no-sandbox',
    'about:blank',
  ];
  const chrome = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome 启动超时')), 20000);
    chrome.stderr.on('data', (d) => {
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome 提前退出 code=${code}：${buf.slice(-300)}`)); });
    chrome.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
  return { chrome, wsUrl };
}

// ------------------------------------------------------------------ 对外接口

function pushLog(entries) {
  if (!current || !Array.isArray(entries)) return;
  for (const e of entries) {
    current.logs.push(e);
    if (current.logs.length > 500) current.logs.shift();
  }
}

async function start({ assetId, rtc, baseUrl, maxSeconds, bitrate, fps, skipProfile }) {
  if (current) throw Object.assign(new Error('已有推流在运行，请先停止'), { status: 409 });
  const meta = readMeta(assetId);
  if (!meta) throw Object.assign(new Error('素材不存在或已被清理，请重新上传'), { status: 404 });
  if (!rtc?.token || !rtc?.user_id) throw Object.assign(new Error('缺少 rtc.token / rtc.user_id'), { status: 400 });
  const chromePath = findChrome();
  if (!chromePath) throw Object.assign(new Error('服务器上找不到 Chrome，可设置 CHROME_PATH 环境变量'), { status: 500 });

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidu-pub-'));
  const { chrome, wsUrl } = launchChrome(chromePath, userDir, { video: assetPath(assetId, 'mjpeg'), audio: assetPath(assetId, 'wav') });
  const state = { chrome, userDir, cdp: null, sessionId: '', assetId, meta, startedAt: Date.now(), logs: [], timer: null, error: '' };
  current = state;
  chrome.on('exit', () => { if (current === state) { state.error = state.error || 'Chrome 已退出'; cleanup(state); } });

  try {
    state.cdp = new Cdp(await wsUrl);
    await state.cdp.opened;
    const { targetId } = await state.cdp.send('Target.createTarget', { url: `${baseUrl}/publisher.html` });
    ({ sessionId: state.sessionId } = await state.cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await state.cdp.send('Runtime.enable', {}, state.sessionId);

    for (let i = 0; i < 60; i += 1) {
      if (await pageEval("typeof window.__pub === 'object'").catch(() => false)) break;
      if (i === 59) throw new Error('推流页面加载超时');
      await new Promise((r) => setTimeout(r, 250));
    }
    // token 只经 CDP 进页面内存，不写日志
    const enriched = { ...rtc, width: meta.width, height: meta.height, bitrate: Number(bitrate) || Math.min(1400, Math.max(500, Math.round(meta.width * meta.height / 1000 * 1.7))), fps: Number(fps) || 30, skipProfile: Boolean(skipProfile) };
    const result = await pageEval(`window.__pub.start(${JSON.stringify(enriched)})`, { awaitPromise: true });
    pushLog(await pageEval('window.__pub.drain()').catch(() => []));
    if (maxSeconds > 0) state.timer = setTimeout(() => { stop().catch(() => {}); }, maxSeconds * 1000);
    return { ...publicState(), page: result };
  } catch (err) {
    pushLog(await pageEval('window.__pub.drain()').catch(() => []));
    const logs = state.logs.slice(-5).map((l) => l.message).join(' | ');
    await stop().catch(() => {});
    throw new Error(`${err.message}${logs ? `（页面日志：${logs}）` : ''}`);
  }
}

function cleanup(state) {
  if (state.timer) clearTimeout(state.timer);
  try { state.cdp?.close(); } catch { /* ignore */ }
  try { state.chrome.kill('SIGKILL'); } catch { /* ignore */ }
  setTimeout(() => fs.rm(state.userDir, { recursive: true, force: true }, () => {}), 1500);
  if (current === state) current = null;
}

async function stop() {
  const state = current;
  if (!state) return { running: false };
  try {
    // 先让页面礼貌地离会，SDK 会通知服务端；2 秒内没完成就强杀
    await Promise.race([
      pageEval('window.__pub.stop()', { awaitPromise: true }),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  } catch { /* 页面已经没了 */ }
  cleanup(state);
  return { running: false };
}

async function inspect() {
  if (!current) throw Object.assign(new Error('没有运行中的推流'), { status: 409 });
  return JSON.parse(await pageEval('window.__pub.inspect().then((r) => JSON.stringify(r))', { awaitPromise: true }));
}

function publicState() {
  if (!current) return { running: false };
  return {
    running: true,
    assetId: current.assetId,
    asset: current.meta,
    startedAt: current.startedAt,
    uptimeSeconds: Math.round((Date.now() - current.startedAt) / 1000),
  };
}

/** 状态 + 页面里新产生的日志（调用即消费）。 */
async function status() {
  if (!current) return { running: false };
  let page = null;
  try {
    page = JSON.parse(await pageEval('JSON.stringify(window.__pub.status())'));
    await pageEval('window.__pub.sampleSend().then(() => 0)', { awaitPromise: true }).catch(() => {});
    page = JSON.parse(await pageEval('JSON.stringify(window.__pub.status())'));
    pushLog(await pageEval('window.__pub.drain()'));
  } catch (err) { page = { error: err.message }; }
  const out = { ...publicState(), page, logs: current.logs.splice(0) };
  return out;
}

process.on('exit', () => { if (current) { try { current.chrome.kill('SIGKILL'); } catch { /* ignore */ } } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (current) cleanup(current); process.exit(0); });

module.exports = { prepareUpload, start, stop, status, inspect, readMeta, MAX_SECONDS };
