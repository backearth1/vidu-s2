'use strict';

/**
 * 语音识别（ASR）：上传视频 / 音频 → ffmpeg 抽音轨 → MiniMax speech_to_text。
 *
 * MiniMax 接口：POST https://api.minimax.cn/v1/speech_to_text
 *   Authorization: Bearer <MINIMAX_API_KEY>
 *   multipart: model=asr-1.0, file=<audio>, response_format=verbose_json
 *   可选请求头：language: zh / en / ...
 * 限制：单个音频 ≤ 500 秒、≤ 50MB；超长文件这里自动切段后拼接。
 *
 * 注意：MiniMax 的 key 和 Vidu 的 vda_ key 不是一回事，用错了会 401。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const API_BASE = process.env.MINIMAX_API_BASE || 'https://api.minimax.cn';
const MODEL = 'asr-1.0';
/** 官方单次上限 500 秒，留一点余量。 */
const CHUNK_SECONDS = 480;
const MAX_SECONDS_PER_REQUEST = 500;
const MAX_UPLOAD_BYTES = 600 * 1024 * 1024;
const SAMPLE_RATE = 16000;

let apiKey = '';

function configure(key) {
  apiKey = String(key || '').trim();
}

function configured() {
  return Boolean(apiKey);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} 失败：${(stderr || err.message).toString().trim().slice(-500)}`));
      else resolve(stdout.toString());
    });
  });
}

function saveUpload(req, file) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        req.destroy();
        out.destroy();
        reject(Object.assign(new Error(`文件超过 ${MAX_UPLOAD_BYTES / 1048576}MB`), { status: 413 }));
      }
    });
    req.pipe(out);
    out.on('finish', () => resolve(bytes));
    out.on('error', reject);
    req.on('error', reject);
  });
}

async function probe(file) {
  const json = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  const streams = json.streams || [];
  const audio = streams.find((s) => s.codec_type === 'audio');
  const video = streams.find((s) => s.codec_type === 'video');
  return {
    duration: Number(json.format?.duration) || 0,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    audioCodec: audio?.codec_name || '',
  };
}

/** 抽出 16kHz 单声道 mp3；MiniMax 文档要求单声道，容器封装，不接受裸 PCM。 */
async function extractAudio(src, dst) {
  await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-c:a', 'libmp3lame', '-b:a', '64k', dst]);
  const st = fs.statSync(dst);
  if (!st.size) throw Object.assign(new Error('音轨抽取结果为空，文件可能没有声音'), { status: 422 });
  return st.size;
}

function splitAudio(src, dir, duration) {
  const chunks = [];
  const total = Math.ceil(duration / CHUNK_SECONDS);
  for (let i = 0; i < total; i += 1) {
    const start = i * CHUNK_SECONDS;
    const len = Math.min(CHUNK_SECONDS, duration - start);
    chunks.push({ index: i, start, duration: len, file: path.join(dir, `chunk-${i}.mp3`) });
  }
  return chunks;
}

async function transcribeChunk(file, { language, timestampLevel }) {
  const form = new FormData();
  form.append('model', MODEL);
  // verbose_json 同时返回 text + duration + n_speakers + segments[]，后续 SRT/VTT 自己拼
  form.append('response_format', 'verbose_json');
  // word：中文按字 / 英文按词返回时间戳；不传则是句段级（可能整段只有一头一尾）
  if (timestampLevel === 'word' || timestampLevel === 'sentence') form.append('timestamp_level', timestampLevel);
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), path.basename(file));

  const headers = { Authorization: `Bearer ${apiKey}` };
  // BCP-47 标签白名单式校验，顺便挡掉换行等非法 header 字符
  if (language && language !== 'auto' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language)) headers.language = language;

  let res;
  try {
    res = await fetch(`${API_BASE}/v1/speech_to_text`, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(300000),
    });
  } catch (err) {
    throw Object.assign(new Error(`请求 MiniMax 失败：${err.message}`), { status: 502 });
  }

  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* srt/vtt 或空响应 */ }

  if (!res.ok) {
    const detail = data?.error?.message || raw.slice(0, 300) || res.statusText;
    const hint = res.status === 401
      ? '（MiniMax 需要自己的 API Key，Vidu 的 vda_ 开头 key 不能用于此接口）'
      : res.status === 402 ? '（MiniMax 账户余额或资源包不足）'
        : res.status === 413 ? '（音频超过 50MB）'
          : res.status === 429 ? '（触发限流，请稍后重试）' : '';
    throw Object.assign(new Error(`MiniMax ${res.status} ${data?.error?.type || ''}：${detail}${hint}`), { status: 502, upstreamStatus: res.status });
  }
  if (!data) throw Object.assign(new Error(`MiniMax 返回了非 JSON 内容：${raw.slice(0, 300)}`), { status: 502 });

  return {
    text: String(data.text || ''),
    duration: Number(data.duration) || 0,
    nSpeakers: Number(data.n_speakers) || 0,
    segments: Array.isArray(data.segments) ? data.segments : [],
    traceId: data.trace_id || '',
  };
}

function joinText(segments, fallback) {
  if (!segments.length) return fallback || '';
  // 中文句子直接相连，英文/数字之间补空格
  return segments.map((s) => String(s.text || '').trim()).filter(Boolean).reduce((acc, t) => {
    if (!acc) return t;
    return /[A-Za-z0-9]$/.test(acc) && /^[A-Za-z0-9]/.test(t) ? `${acc} ${t}` : acc + t;
  }, '');
}

function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
}

function buildSrt(segments) {
  return segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text || ''}\n`).join('\n');
}

function buildVtt(segments) {
  const body = segments.map((s) => `${srtTime(s.start).replace(',', '.')} --> ${srtTime(s.end).replace(',', '.')}\n${s.text || ''}\n`).join('\n');
  return `WEBVTT\n\n${body}`;
}

/** 句末标点（不含逗号）：用于把字级时间戳拼回句子。 */
function isSentenceEnd(text) {
  return /[。！？!?；;\n]$/.test(String(text || '').trim());
}

/**
 * 把 word 级时间戳按句末标点 + 长停顿合并成句子级 segments。
 * MiniMax 的标点会粘在前一个字上，所以直接拼接文本即可。
 */
function mergeWords(words) {
  const out = [];
  let cur = null;
  for (const w of words) {
    const text = String(w.text || '');
    if (!text) continue;
    const start = Number(w.start) || 0;
    const end = Number(w.end) || start;
    // 字与字之间停顿超过 1.2 秒，视为断句
    if (cur && start - cur.end > 1.2) {
      out.push(cur);
      cur = null;
    }
    if (!cur) {
      cur = { start, end, speaker: w.speaker || '', text };
    } else {
      cur.end = end;
      cur.text += text;
      if (!cur.speaker && w.speaker) cur.speaker = w.speaker;
    }
    if (isSentenceEnd(text)) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur && cur.text.trim()) out.push(cur);
  return out.map((s, i) => ({
    id: i,
    start: +s.start.toFixed(3),
    end: +s.end.toFixed(3),
    speaker: s.speaker,
    text: s.text,
  }));
}

/**
 * 识别本地文件。ASR 接口和 timeline 生成都走这里。
 * @param {string} file 音视频文件路径
 * @param {{name?: string, language?: string, timestampLevel?: 'sentence'|'word'}} opts
 */
async function transcribeFile(file, { name = 'media', language = 'auto', timestampLevel = 'sentence' } = {}) {
  if (!apiKey) {
    throw Object.assign(new Error('服务端未配置 MiniMax API Key：启动时加 --minimax-key 或设置 MINIMAX_API_KEY 环境变量'), { status: 400 });
  }
  fs.mkdirSync(path.join(os.tmpdir(), 'vidu-asr'), { recursive: true });
  const id = crypto.randomBytes(8).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vidu-asr-${id}-`));
  const audio = path.join(dir, 'audio.mp3');

  try {
    const info = await probe(file);
    if (!info.hasAudio) throw Object.assign(new Error('文件里没有音轨，无法识别'), { status: 422 });
    if (!info.duration) throw Object.assign(new Error('读不出文件时长'), { status: 422 });

    await extractAudio(file, audio);
    const audioInfo = await probe(audio);
    const duration = audioInfo.duration || info.duration;

    const chunks = duration > CHUNK_SECONDS ? splitAudio(audio, dir, duration) : [{ index: 0, start: 0, duration, file: audio }];
    const results = [];
    for (const chunk of chunks) {
      if (chunks.length > 1) {
        // 从已抽好的音频里按时间切，避免每次重新解码原视频
        await run('ffmpeg', ['-y', '-v', 'error', '-i', audio, '-ss', String(chunk.start), '-t', String(chunk.duration),
          '-c:a', 'libmp3lame', '-b:a', '64k', chunk.file]);
      }
      results.push(await transcribeChunk(chunk.file, { language, timestampLevel }));
    }

    const units = [];
    let offset = 0;
    for (const [i, r] of results.entries()) {
      for (const s of r.segments) {
        units.push({
          id: units.length,
          start: +(offset + (Number(s.start) || 0)).toFixed(3),
          end: +(offset + (Number(s.end) || 0)).toFixed(3),
          speaker: s.speaker || '',
          text: String(s.text || ''),
        });
      }
      offset += chunks[i].duration;
    }

    const words = timestampLevel === 'word' ? units : [];
    const segments = timestampLevel === 'word' ? mergeWords(units) : units;
    const text = joinText(segments, results.map((r) => r.text).join('\n'));
    return {
      text,
      duration: +duration.toFixed(3),
      n_speakers: Math.max(0, ...results.map((r) => r.nSpeakers)),
      segments,
      words,
      srt: buildSrt(segments),
      vtt: buildVtt(segments),
      chunks: results.length,
      trace_ids: results.map((r) => r.traceId).filter(Boolean),
      audio: { sample_rate: SAMPLE_RATE, channels: 1, duration: +duration.toFixed(2), size: fs.statSync(audio).size },
      meta: {
        name: String(name).slice(0, 120),
        language,
        model: MODEL,
        timestamp_level: timestampLevel,
        source: { ...info, duration: +info.duration.toFixed(2) },
      },
    };
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

/**
 * 入口：读取上传流，返回识别结果。
 * @param {import('http').IncomingMessage} req
 * @param {{name?: string, language?: string, timestampLevel?: 'sentence'|'word'}} opts
 */
async function transcribe(req, { name = 'media', language = 'auto', timestampLevel = 'sentence' } = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vidu-asr-upload-${id}-`));
  const src = path.join(dir, `${id}.upload`);
  try {
    await saveUpload(req, src);
    return await transcribeFile(src, { name, language, timestampLevel });
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { configure, configured, transcribe, transcribeFile, MODEL, MAX_SECONDS_PER_REQUEST };
