'use strict';

/**
 * 编辑结果转推接收 + 观看 + 录像。
 *
 * Vidu 的 rtc 凭证只发了「主播」这一个身份，浏览器没法再入会观看。官方给第三方观看的途径是
 * 创建时传 rtmp_urls：Vidu 把合成结果（render_uid 的流）转推到我们的地址。
 *
 *   Vidu --RTMP--> mediamtx(:19350) --RTMP--> ffmpeg 缩到 ~600kbps --> HLS --> 浏览器 hls.js
 *                         |
 *                         +--RTMP--> ffmpeg -c copy --> recordings/*.mp4   （录像，原画质、写本地盘，不占出口）
 *
 * 浏览器观看单独转一路低码率：服务器公网出口很小，原画质 2Mbps 的 HLS 会和推流抢带宽，
 * 把推流端的拥塞控制逼崩（实测 conn_init 后约 17 秒丢包 16~22%，帧率掉到 14fps）。
 *
 * 推流路径 live/<随机串>：mediamtx 只放行这个格式，随机串即推流口令，每条直播现生成。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin');
const RECORD_DIR = path.join(__dirname, '..', 'recordings');
const RTMP_PORT = 19350;
const HLS_DIR = path.join(__dirname, '..', 'hls');
/** 观看用 HLS 的目标视频码率(kbps)；音频另加 48k。可用环境变量 VIEW_KBPS 调整。 */
const VIEW_KBPS = Math.max(200, Number(process.env.VIEW_KBPS) || 600);

let mtx = null;
const sessions = new Map();   // key -> { key, startedAt, rec: { proc, file, tmp } | null }

function startMediamtx(log) {
  const exe = path.join(BIN, 'mediamtx');
  if (!fs.existsSync(exe)) { log('未找到 bin/mediamtx，转推观看不可用'); return false; }
  mtx = spawn(exe, [path.join(BIN, 'mediamtx.yml')], { stdio: ['ignore', 'pipe', 'pipe'] });
  mtx.stdout.on('data', () => {});
  mtx.stderr.on('data', () => {});
  mtx.on('exit', (code) => { log(`mediamtx 退出 code=${code}`); mtx = null; });
  return true;
}

/** 新建一条观看会话，返回 Vidu 该推到的 RTMP 地址。 */
function createSession(publicHost) {
  const key = crypto.randomBytes(12).toString('hex');   // 24 位十六进制，满足 mediamtx 路径白名单
  sessions.set(key, { key, startedAt: Date.now(), rec: null, view: null });
  return { key, rtmpUrl: `rtmp://${publicHost}:${RTMP_PORT}/live/${key}`, hlsPath: `/view/${key}/index.m3u8` };
}

function hasSession(key) { return sessions.has(key); }

/**
 * 观看用低码率 HLS：从本机 RTMP 拉流，缩到最长边 480 / 15fps / ~600kbps 再切片。
 * 转推还没到达时 ffmpeg 会拉流失败退出，这里带重试，直到会话结束。
 */
function startViewHls(key) {
  const s = sessions.get(key);
  if (!s || s.view) return;
  const dir = path.join(HLS_DIR, key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const view = { proc: null, stopped: false, restarts: 0, startedAt: 0 };
  s.view = view;
  const launch = () => {
    if (view.stopped) return;
    view.startedAt = Date.now();
    const proc = spawn('ffmpeg', ['-y', '-v', 'error', '-rw_timeout', '10000000', '-i', `rtmp://127.0.0.1:${RTMP_PORT}/live/${key}`,
      // 最长边 480、15fps：Vidu 本身只出 544 宽、24fps，观看画面不需要更高；码率靠 maxrate 钳死
      '-vf', "scale='if(gte(iw,ih),480,-2)':'if(gte(iw,ih),-2,480)':flags=bilinear,fps=15",
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
      '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
      '-b:v', `${VIEW_KBPS}k`, '-maxrate', `${Math.round(VIEW_KBPS * 1.15)}k`, '-bufsize', `${VIEW_KBPS * 2}k`,
      '-c:a', 'aac', '-b:a', '48k', '-ac', '1',
      '-f', 'hls', '-hls_time', '1', '-hls_list_size', '6',
      '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
      '-hls_segment_filename', path.join(dir, 's%d.ts'), path.join(dir, 'index.m3u8')], { stdio: ['pipe', 'ignore', 'pipe'] });
    view.proc = proc;
    proc.stderr.on('data', () => {});
    proc.on('exit', () => {
      if (view.stopped) return;
      view.restarts += 1;
      setTimeout(launch, 1000);   // 转推未到达 / 中途断开：1 秒后重拉
    });
  };
  launch();
}

function stopViewHls(key) {
  const s = sessions.get(key);
  if (!s?.view) return;
  s.view.stopped = true;
  try { s.view.proc?.kill('SIGKILL'); } catch { /* ignore */ }
  s.view = null;
  setTimeout(() => fs.rm(path.join(HLS_DIR, key), { recursive: true, force: true }, () => {}), 1500);
}

function viewDir(key) { return hasSession(key) ? path.join(HLS_DIR, key) : ''; }

/** 开始服务端录像：直接从本机 RTMP 流 copy 封装，不解码不重编码，画质与 Vidu 转推的一致。 */
function startRecording(key, nameHint = 'edit') {
  const s = sessions.get(key);
  if (!s) throw Object.assign(new Error('会话不存在'), { status: 404 });
  if (s.rec) throw Object.assign(new Error('已在录像'), { status: 409 });
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const file = `${String(nameHint).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'edit'}-${stamp}.mp4`;
  const tmp = path.join(RECORD_DIR, `${file}.part.mp4`);
  // 录成分片 MP4：进程被杀或断电也能保留已录内容，停止后再转成普通 faststart MP4
  const proc = spawn('ffmpeg', ['-y', '-v', 'error', '-rw_timeout', '15000000', '-i', `rtmp://127.0.0.1:${RTMP_PORT}/live/${key}`,
    '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', tmp], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d.toString(); });
  s.rec = { proc, file, tmp, startedAt: Date.now(), getErr: () => err.trim().slice(-300), exited: false };
  proc.on('exit', () => { s.rec && (s.rec.exited = true); });
  return { file };
}

function remux(src, dst) {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-i', src, '-c', 'copy', '-movflags', '+faststart', dst], (e) => resolve(!e));
  });
}

async function stopRecording(key) {
  const s = sessions.get(key);
  if (!s?.rec) return null;
  const { proc, file, tmp } = s.rec;
  const errText = s.rec.getErr();
  s.rec = null;
  if (!proc.killed && proc.exitCode === null) {
    try { proc.stdin.write('q'); } catch { /* ignore */ }
    await new Promise((r) => { proc.once('exit', r); setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } r(); }, 4000); });
  }
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) {
    fs.rmSync(tmp, { force: true });
    return { file: null, error: errText || '没有收到可录制的流（Vidu 是否已开始转推？）' };
  }
  const finalPath = path.join(RECORD_DIR, file);
  const ok = await remux(tmp, finalPath);
  if (ok) fs.rmSync(tmp, { force: true }); else fs.renameSync(tmp, finalPath);
  return { file, size: fs.statSync(finalPath).size, remuxed: ok };
}

async function closeSession(key) {
  stopViewHls(key);
  const out = await stopRecording(key);
  sessions.delete(key);
  return out;
}

function recordingState(key) {
  const s = sessions.get(key);
  return s?.rec ? { recording: true, file: s.rec.file, seconds: Math.round((Date.now() - s.rec.startedAt) / 1000), exited: s.rec.exited } : { recording: false };
}

function shutdown() {
  for (const s of sessions.values()) { try { s.rec?.proc.kill('SIGKILL'); } catch { /* ignore */ } try { s.view?.proc?.kill('SIGKILL'); } catch { /* ignore */ } }
  fs.rmSync(HLS_DIR, { recursive: true, force: true });
  try { mtx?.kill('SIGTERM'); } catch { /* ignore */ }
}
process.on('exit', shutdown);

module.exports = { startMediamtx, createSession, hasSession, startViewHls, viewDir, VIEW_KBPS, startRecording, stopRecording, closeSession, recordingState, RTMP_PORT };
