'use strict';

/**
 * AI 动作时间轴生成。
 *
 * 流程：
 *   音频 → ASR（word 级时间戳）→ 按停顿/标点合并成短语 → 4–6 秒节拍
 *   图片 → MiniMax 多模态模型描述人物（景别/可见部位/手持物/限制）
 *   节拍 + 人物档案 → 模型为每段写一句动作描述
 *   时间由本地算法绑定，不依赖模型算时间
 *
 * 依赖：MINIMAX_API_KEY（与 ASR 共用）。模型默认 MiniMax-M3.1-Flash。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const crypto = require('crypto');
const asr = require('./asr');

const API_BASE = process.env.MINIMAX_API_BASE || 'https://api.minimax.cn';
const DEFAULT_MODEL = process.env.TIMELINE_MODEL || 'MiniMax-M3.1-Flash';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_DURATION = 600; // 10 分钟，超过就让用户先分段
const MAX_BEATS = 90;
const CHARS_PER_SECOND = 2.5;

const STYLES = {
  '专业讲解': '商品专业讲解：动作克制、手势清晰，表情专注认真，强调重点时点头',
  '亲切带货': '亲切带货：口语化、语速自然，表情友好但不轻易微笑，动作自然不夸张',
  '活力种草': '活力种草：节奏轻快，手势更丰富，表情有活力但不夸张，不轻易微笑',
};

let apiKey = '';
let model = DEFAULT_MODEL;

function configure(opts = {}) {
  if (opts.apiKey !== undefined) apiKey = String(opts.apiKey || '').trim();
  if (opts.model) model = String(opts.model).trim() || DEFAULT_MODEL;
}

function configured() {
  return Boolean(apiKey);
}

// ---------------------------------------------------------------- 素材读取

function parseDataUrl(raw, maxBytes, label) {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(raw);
  if (!m) throw Object.assign(new Error(`${label} 的 data URL 格式不正确`), { status: 400 });
  const mime = m[1] || 'application/octet-stream';
  let buffer;
  try {
    buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  } catch {
    throw Object.assign(new Error(`${label} 的 data URL 无法解码`), { status: 400 });
  }
  if (!buffer.length) throw Object.assign(new Error(`${label} 内容为空`), { status: 400 });
  if (buffer.length > maxBytes) {
    throw Object.assign(new Error(`${label} 超过 ${(maxBytes / 1048576).toFixed(0)}MB`), { status: 413 });
  }
  return { buffer, mime, origin: 'data-url' };
}

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return false;
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd')
      || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')
      || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
  }
  const p = ip.split('.').map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127
    || (p[0] === 169 && p[1] === 254)
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168)
    || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

/** 只允许公网 http(s)，挡住 localhost / 内网 / 云元数据地址，防 SSRF。 */
async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw Object.assign(new Error(`无效的 URL：${raw}`), { status: 400 }); }
  if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('只支持 http/https 素材地址'), { status: 400 });
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw Object.assign(new Error('不允许访问内网地址'), { status: 400 });
  }
  let records = [];
  if (net.isIP(host)) records = [{ address: host }];
  else {
    try { records = await dns.lookup(host, { all: true }); }
    catch { throw Object.assign(new Error(`域名解析失败：${host}`), { status: 400 }); }
  }
  if (!records.length) throw Object.assign(new Error(`域名解析失败：${host}`), { status: 400 });
  for (const r of records) {
    if (isPrivateIp(r.address)) throw Object.assign(new Error(`不允许访问内网地址（${host} → ${r.address}）`), { status: 400 });
  }
  return url;
}

async function fetchPublic(raw, maxBytes, label) {
  let current = raw;
  for (let hop = 0; hop < 4; hop += 1) {
    const url = await assertPublicUrl(current);
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': 'vidu-s2-timeline/1.0' },
      });
    } catch (err) {
      throw Object.assign(new Error(`${label} 下载失败：${err.message}`), { status: 502 });
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw Object.assign(new Error(`${label} 重定向缺少 Location`), { status: 502 });
      current = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`${label} 下载失败：HTTP ${res.status}`), { status: 502 });
    const len = Number(res.headers.get('content-length')) || 0;
    if (len > maxBytes) throw Object.assign(new Error(`${label} 超过 ${(maxBytes / 1048576).toFixed(0)}MB`), { status: 413 });
    let buffer;
    try { buffer = Buffer.from(await res.arrayBuffer()); }
    catch (err) { throw Object.assign(new Error(`${label} 读取失败：${err.message}`), { status: 502 }); }
    if (buffer.length > maxBytes) throw Object.assign(new Error(`${label} 超过 ${(maxBytes / 1048576).toFixed(0)}MB`), { status: 413 });
    if (!buffer.length) throw Object.assign(new Error(`${label} 内容为空`), { status: 422 });
    return { buffer, mime: (res.headers.get('content-type') || '').split(';')[0].trim(), origin: url.toString() };
  }
  throw Object.assign(new Error(`${label} 重定向过多`), { status: 502 });
}

async function loadAsset(value, { maxBytes, label }) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('data:')) return parseDataUrl(raw, maxBytes, label);
  if (!/^https?:\/\//i.test(raw)) {
    throw Object.assign(new Error(`${label} 只支持公网 URL 或 base64 data URL`), { status: 400 });
  }
  return fetchPublic(raw, maxBytes, label);
}

function extFromMime(mime) {
  const map = {
    'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
    'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac', 'audio/ogg': '.ogg',
    'audio/opus': '.opus', 'audio/aiff': '.aiff', 'video/mp4': '.mp4', 'video/quicktime': '.mov',
  };
  return map[mime] || '.bin';
}

// ---------------------------------------------------------------- 模型调用

async function chat(messages, { maxTokens = 1500, temperature = 0.4 } = {}) {
  if (!apiKey) {
    throw Object.assign(new Error('服务端未配置 MiniMax API Key：启动时加 --minimax-key 或设置 MINIMAX_API_KEY 环境变量'), { status: 400 });
  }
  let res;
  try {
    res = await fetch(`${API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        max_completion_tokens: maxTokens,
        reasoning_effort: 'low',
        temperature,
      }),
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    throw Object.assign(new Error(`请求 MiniMax 失败：${err.message}`), { status: 502 });
  }
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const detail = data?.error?.message || raw.slice(0, 300) || res.statusText;
    const hint = res.status === 401
      ? '（MiniMax 需要自己的 API Key，Vidu 的 vda_ 开头 key 不能用于此接口）'
      : res.status === 402 ? '（MiniMax 账户余额或资源包不足）'
        : res.status === 429 ? '（触发限流，请稍后重试）' : '';
    throw Object.assign(new Error(`MiniMax ${res.status} ${data?.error?.type || ''}：${detail}${hint}`), {
      status: 502,
      upstreamStatus: res.status,
    });
  }
  if (!data) throw Object.assign(new Error(`MiniMax 返回了非 JSON 内容：${raw.slice(0, 300)}`), { status: 502 });
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw Object.assign(new Error('MiniMax 返回内容为空'), { status: 502 });
  }
  return { content, usage: data.usage || null, model: data.model || model };
}

function extractJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/,'').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

const IMAGE_SYSTEM = `你是数字人视频的视觉分析师。根据用户提供的角色图，只输出一个 JSON 对象，不要解释、不要 markdown。字段：
{
  "has_person": true/false,
  "person_count": 画面中的人物数量,
  "shot": "景别，如 特写/近景/中景/半身/全身",
  "visible_parts": ["画面中可见的身体部位"],
  "has_product": true/false,   // 画面里是否出现可展示、可拿持的产品/道具（人物本身、衣服、首饰不算）
  "held_objects": ["画面里实际出现、可拿持的产品/道具，写清在左手还是右手；没有就是空数组"],
  "outfit": "服装描述",
  "posture": "姿态描述",
  "constraints": ["根据构图推断不能做的动作，如 不能走动、不能转身、手部被裁切"]
}
has_person 必须如实判断：画面里没有清晰可辨的人物（只有产品、风景、物体、纯色背景等）时填 false，其余字段留空或空数组，不要硬凑。有一个人及以上填 true。
has_product 必须如实判断：画面里确实出现产品或道具才填 true；纯人像、只有衣服首饰时填 false。
held_objects 只写物品，不要把手、手臂、手指、身体部位或「右手平放在桌面」这类姿势写进来；画面里没有物品时必须是 []。has_product 为 false 时 held_objects 必须为空数组。
描述用中文，具体、客观，不要编造画面里没有的东西。`;

async function visionProfile(asset) {
  const mime = /^image\//.test(asset.mime) ? asset.mime : 'image/png';
  const dataUrl = `data:${mime};base64,${asset.buffer.toString('base64')}`;
  const messages = [
    { role: 'system', content: IMAGE_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请分析这张数字人角色图，输出人物档案 JSON。' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ];
  // M3.1-Flash 的思考 token 也算在 max_tokens 里，给少了会被截断成半截 JSON
  let { content, usage } = await chat(messages, { maxTokens: 2000, temperature: 0.2 });
  let data;
  try {
    data = extractJson(content);
  } catch (err) {
    const retry = await chat([
      ...messages,
      { role: 'assistant', content },
      { role: 'user', content: '上面的 JSON 被截断或无法解析，请重新输出完整、合法、可直接 JSON.parse 的单个对象，不要省略任何字段。' },
    ], { maxTokens: 3000, temperature: 0 });
    content = retry.content;
    usage = retry.usage || usage;
    data = extractJson(content);
  }
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : []);
  const profile = {
    has_person: data.has_person === true,
    person_count: Number(data.person_count) || 0,
    has_product: typeof data.has_product === 'boolean' ? data.has_product : null,
    shot: String(data.shot || '').trim(),
    visible_parts: arr(data.visible_parts),
    held_objects: arr(data.held_objects),
    outfit: String(data.outfit || '').trim(),
    posture: String(data.posture || '').trim(),
    constraints: arr(data.constraints),
    usage,
  };
  // 模型没给 has_person 时，用「有没有可见部位/景别」兜底判断；两者都空视为没识别到人
  if (typeof data.has_person !== 'boolean') {
    profile.has_person = Boolean(profile.shot || profile.visible_parts.length);
  }
  // 模型没给 has_product 时，用滤掉纯姿势描述后的道具列表兜底
  if (typeof data.has_product !== 'boolean') {
    profile.has_product = usableObjects(profile).length > 0;
  }
  return profile;
}

const PLAN_SYSTEM = `你是直播间数字人短视频的动作导演。用户会给你人物档案、直播场景和按时间切好的语音节拍，你要为每个节拍写一条动作描述。

硬性要求：
1. 输出必须是 JSON：{"actions":[{"text":"..."}]}，不要 markdown，不要解释。
2. actions 的数量和顺序必须与输入的 beats 完全一致，每个 beat 对应一条。
3. 一条动作 = 一个主动作 + 表情/视线/头部等伴随微动作，描述具体（表情+视线+头部+手部+道具）。
4. 动作必须跟着这一段台词的实际内容走，全片要有明显变化：
   欢迎新观众 → 点头致意、掌心向上轻抬示意、手放胸前；
   介绍新品 → 托举产品、翻转展示瓶身/侧面、指向产品；
   讲成分/质地 → 手指轻点产品、比划质地、轻捏产品；
   讲效果/数据 → 食指轻点强调、手掌下压；
   报价格/优惠 → 手指比数字、掌心向下压；
   引导下单 → 掌心向上指向画面下方/购物车方向；
   答疑 → 手轻抬停顿、点头；
   收尾 → 双手自然交叠、点头致意。
   不要不管台词是什么都写同一个动作。
5. 只写人物档案里做得到的动作；构图限制（不能走动/转身、手部不可见）必须遵守。
6. 不要写运镜、镜头移动、换装、场景变化。
7. 只写动作、表情、视线、头部和手部，不要复述或引用台词，不要写"说……"的内容。
8. 全部使用简体中文，不要夹杂英文单词。
9. 每条 20–80 个汉字，避免空泛的"自然说话"。
10. 视线是硬性约束：视线只允许看向两处——镜头／观众，或手中正在展示的产品／道具。展示产品时可以自然地看向产品，再看向镜头也允许。除此之外哪里都不能看：不能看向一侧、旁边、别处、背景、身后、镜头外、画外，不能写视线游移、躲闪、飘忽，也不要写「视线从镜头移向一侧又收回」。如果人物档案里没有手持物，说明画面里没有产品，视线只能看向镜头／观众，不能写看向产品。
11. 表情要克制：这是商品讲解场景，默认表情自然、专注、认真，像在认真介绍产品。不要默认微笑、不要每段都笑，不要写「面带微笑」「微笑点头」「笑容加深」「露出笑容」「嘴角上扬」。只有台词本身明确表达开心、感谢、惊喜时，才可以写「嘴角轻微上扬」，其余一律保持自然或专注的表情。
12. 绝对禁止「招手」「挥手」「摆手」「挥手打招呼」以及任何来回摆动的手势：这类动作在数字人上会持续摆动、停不下来。需要欢迎观众时，用「点头致意」「右手掌心向上轻抬到胸前示意」代替。
13. 每条动作都必须有收势：结尾让手回到明确位置（放回胸前、自然垂放身侧、双手交叠），不要把手停在半空，也不要把上一段的动作原样延续到下一段。
14. 相邻两段不能使用同一个主手势，同一手势不要连续重复。展示产品可以持续持握，但要换手、换展示角度或换手指动作。
15. 产品限制：只能用人物档案里已有的手持物，不要凭空增加别的产品。如果人物档案里没有任何手持物（画面里没有产品），所有动作只能用表情、视线、头部和空手手势表达，绝对禁止出现「产品」「商品」「道具」「瓶身」「包装」「手持」「举起」「托起」「拿起」「握着」等描述，也不要模拟拿产品——否则会生成不存在的虚假商品。`;

/**
 * 视线只允许落在「镜头/观众」或「手中产品/道具」上；看向其他任何地方都算违规，
 * 例如「视线从镜头移向一侧又收回」「目光看向背景」「眼神游移」。
 * 生成后先让模型重写，仍出现就本地删句。
 */
/** 允许的视线落点。 */
const GAZE_ALLOWED = '(?:镜头|观众|前方|正前方|屏幕|产品|商品|道具|手中|手里|手上|护肤品|包装)';
/** 明确不允许的落点。 */
const GAZE_FORBIDDEN = '(?:一侧|旁边|别处|侧面|他处|远处|四周|周围|背景|身后|窗外|地面|天花板|镜头外|画外|屏幕外|观众席|别人|他人)';
const GAZE_VERB = '看向|望向|移向|转向|飘向|瞥向|扫向|瞟向|投向|跟随|追着|落到|落在';
const GAZE_SUBJECT = '(?:视线|目光|眼神)';

const GAZE_VIOLATION = new RegExp(
  // 落点明确是非允许区域
  `${GAZE_SUBJECT}[^，。；！？\\n]{0,14}(?:${GAZE_VERB})[^，。；！？\\n]{0,10}${GAZE_FORBIDDEN}`
  // 游移 / 躲闪 / 飘忽
  + `|${GAZE_SUBJECT}[^，。；！？\\n]{0,10}(?:游移|躲闪|飘忽|乱瞟)`
  // 移开 / 离开，但同句里没说明是否看产品
  + `|${GAZE_SUBJECT}[^，。；！？\\n]{0,10}(?:移开|离开)(?![^，。；！？\\n]{0,10}${GAZE_ALLOWED})`
  // 方向性动词，但同句里看不到镜头/观众/产品等允许落点
  + `|${GAZE_SUBJECT}[^，。；！？\\n]{0,14}(?:${GAZE_VERB})(?![^，。；！？\\n]{0,10}${GAZE_ALLOWED})`
  // 「再收回视线」这类来回移动的残句
  + '|(?:再|又|重新)(?:收回视线|移回视线|转回视线)',
);

/** 已经有一句合法的视线描述（看向镜头 / 看向手中产品），就不用再补。 */
function hasGazeStatement(text) {
  return /视线|目光|眼神|直视/.test(text)
    || new RegExp(`看(?:向|回|着)?[^，。；]{0,10}${GAZE_ALLOWED}`).test(text)
    || new RegExp(`注视[^，。；]{0,10}${GAZE_ALLOWED}`).test(text);
}

/**
 * 商品讲解默认不笑：台词里没有明确的开心/感谢/惊喜线索时，
 * 把「微笑 / 笑容 / 嘴角上扬」改成中性、专注的表情。
 */
const WARM_CUE = /开心|高兴|喜欢|谢谢|感谢|惊喜|恭喜|太棒|太好了|爱了/;
function softenSmiles(text, contextText) {
  if (WARM_CUE.test(String(contextText || ''))) return text;
  const out = String(text || '')
    .replace(/嘴角(?:微微|轻微)?上扬/g, '表情自然')
    .replace(/面带微笑/g, '表情自然')
    .replace(/露出?[^，。；]{0,4}笑容/g, '表情自然')
    .replace(/露出?(?:灿烂|浅浅|淡淡的?)?微笑/g, '表情自然')
    .replace(/微微一笑/g, '')
    .replace(/笑容(?:加深|灿烂|满面|洋溢)/g, '表情专注')
    .replace(/笑容/g, '表情')
    .replace(/微笑着/g, '')
    .replace(/微笑/g, '')
    .replace(/笑(?:了|着)(?:一下)?/g, '')
    .replace(/眼神带笑/g, '表情自然')
    .replace(/表情自然[，,]?表情自然/g, '表情自然')
    .replace(/，{2,}/g, '，')
    .replace(/^[，,\s]+/, '')
    .replace(/[，,]\s*$/, '');
  return out || '表情自然地看向镜头';
}

/** 删掉含违规视线的短句；删光了就补一句「视线保持看向镜头」。 */
function stripGazeViolations(text) {
  const parts = String(text || '').split(/([，,。；;！!？?])/);
  const kept = [];
  let removed = false;
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i];
    const punct = parts[i + 1] || '';
    if (GAZE_VIOLATION.test(clause)) { removed = true; continue; }
    if (clause.trim()) kept.push(clause + punct);
  }
  let out = kept.join('').trim().replace(/^[，,。；;！!？?]+/, '').replace(/[，,；;]+$/, '')
    .replace(/^(?:随后|然后|接着|之后)[，,]?\s*/, '');
  if (removed && !hasGazeStatement(out)) out = out ? `${out}，视线保持看向镜头` : '视线保持看向镜头，面部表情自然';
  return out || '视线保持看向镜头，面部表情自然';
}

/**
 * 模型偶尔不按 {"text":"..."} 输出：可能写成 {"action":"..."}，或整个元素是对象。
 * 尽量取出字符串；取不到返回空串，交给调用方触发重试，绝不让 "[object Object]" 进时间轴。
 */
function actionText(a) {
  if (typeof a === 'string') return a.trim();
  if (a && typeof a === 'object') {
    for (const key of ['text', 'action', 'description', 'content', 'desc']) {
      if (typeof a[key] === 'string' && a[key].trim()) return a[key].trim();
    }
    const values = Object.values(a).filter((v) => typeof v === 'string' && v.trim());
    if (values.length === 1) return values[0].trim();
  }
  return '';
}

function profileText(profile) {
  if (!profile) return '（没有可用的人物档案，请只写保守的上半身/面部动作）';
  return JSON.stringify({
    景别: profile.shot,
    可见部位: profile.visible_parts,
    画面有产品: Boolean(profile.has_product) && usableObjects(profile).length > 0,
    手持物: usableObjects(profile),
    服装: profile.outfit,
    姿态: profile.posture,
    限制: profile.constraints,
  });
}

async function planActions({ profile, beats, style, duration }) {
  const styleText = STYLES[style] || STYLES['专业讲解'];
  const beatsText = beats.map((b, i) => `[${i}] ${b.start}-${b.end}s：${b.text}`).join('\n');
  const held = usableObjects(profile);
  const productRule = held.length
    ? `产品限制：画面里识别到的可用道具只有「${held.join('、')}」，只能用这些，不要凭空增加别的产品。`
    : '产品限制：这张人物图里没有任何产品/道具。所有动作只能用表情、视线、头部和空手手势表达；禁止出现「产品」「商品」「道具」「瓶身」「包装」「手持」「举起」「托起」「拿起」「握着」等描述，禁止模拟拿产品；画面里没有产品，视线也不能看向产品，只能看向镜头/观众。';
  const userText = `人物档案：${profileText(profile)}

场景：直播间商品讲解/带货。观众是直播间里的观众，台词通常包含欢迎新观众、介绍新品、讲成分/质地、演示用法、报价格优惠、引导下单、答疑、收尾等环节。动作要贴着每一段台词的具体内容走，全片手势要有变化。

${productRule}

风格：${styleText}
总时长：${duration} 秒
节拍（共 ${beats.length} 段，必须输出 ${beats.length} 条动作，按顺序一一对应）：
${beatsText}

可用手势参考（不要全片只用一种；招手/挥手禁止使用）：
- 欢迎：点头致意、掌心向上轻抬、手放胸前
- 展示产品：双手托举、单手翻转瓶身、食指轻点产品、比划大小/质地
- 强调卖点：食指轻点两下、手掌下压、握拳轻顿、加重语气时点头
- 价格优惠：手指比数字、掌心向下压、轻拍胸口
- 引导下单：掌心向上指向画面下方、朝购物车方向轻点
- 收尾：双手交叠、自然垂放、点头致意

只输出 {"actions":[{"text":"..."}]}。`;

  const messages = [
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: userText },
  ];
  // 思考 token 与正文共用 max_tokens，base 给足，避免 JSON 被截断
  const maxTokens = Math.min(8000, 1500 + beats.length * 150);
  let lastErr = null;
  let usage = null;
  let gazeRetried = false;

  // 第 1 次：正常编排；后续：JSON/数量纠错、视线违规重写，留足机会避免落到模板兜底
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { content, usage: u } = await chat(messages, { maxTokens, temperature: 0.5 });
    if (u) usage = u;
    if (process.env.TIMELINE_DEBUG) console.error(`[timeline] 第 ${attempt + 1} 次编排原始输出：\n${content}`);
    let actions;
    try {
      const data = extractJson(content);
      if (!Array.isArray(data.actions)) throw new Error('缺少 actions 数组');
      actions = data.actions.map(actionText);
      if (actions.some((t) => !t)) throw new Error('存在空的动作描述');
    } catch (err) {
      lastErr = err;
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `输出无法解析：${err.message}。请重新输出严格的 JSON，数量必须正好是 ${beats.length} 条。`,
      });
      continue;
    }
    if (actions.length === beats.length && actions.every(Boolean)) {
      const cleaned = actions.map((t) => t.slice(0, 240));
      const bad = cleaned.map((t, i) => (GAZE_VIOLATION.test(t) ? i : -1)).filter((i) => i >= 0);
      if (bad.length && !gazeRetried) {
        gazeRetried = true;
        messages.push({ role: 'assistant', content });
        messages.push({
          role: 'user',
          content: `第 ${bad.map((i) => i + 1).join('、')} 条出现了看向「产品与镜头以外地方」的视线描述，这是绝对禁止的（例如「视线从镜头移向一侧又收回」「目光看向背景」「眼神游移」）。`
            + `请重写全部 ${beats.length} 条动作：视线只允许看向镜头／观众，或手中正在展示的产品／道具；绝不能看向一侧、旁边、别处、背景、镜头外。只输出 {"actions":[{"text":"..."}]}。`,
        });
        continue;
      }
      // 模型重写后仍有残留时，本地删掉违规短句，保证输出里绝对不出现
      return { actions: cleaned.map(stripGazeViolations), usage };
    }
    lastErr = new Error(`动作数量不对：需要 ${beats.length} 条，返回 ${actions.length} 条`);
    messages.push({ role: 'assistant', content });
    messages.push({
      role: 'user',
      content: `数量不对：需要正好 ${beats.length} 条，当前 ${actions.length} 条。请只输出修正后的 JSON。`,
    });
  }
  throw lastErr || new Error('编排失败');
}

// ---------------------------------------------------------------- 节拍算法

function joinTextParts(parts) {
  return parts.reduce((acc, t) => {
    const s = String(t || '').trim();
    if (!s) return acc;
    if (!acc) return s;
    return /[A-Za-z0-9]$/.test(acc) && /^[A-Za-z0-9]/.test(s) ? `${acc} ${s}` : acc + s;
  }, '');
}

const SENTENCE_END = /[。！？!?；;\n]$/;

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function estimateDuration(text) {
  const chars = String(text || '').replace(/\s/g, '').length;
  return Math.min(MAX_DURATION, Math.max(2, +(chars / CHARS_PER_SECOND).toFixed(1)));
}

/** text + voice 模式没有音轨：按句末标点拆句，按字数估算每句时间。 */
function sentencesFromText(text, duration) {
  const sentences = splitSentences(text);
  if (!sentences.length) return [];
  const totalChars = sentences.reduce((n, s) => n + s.length, 0) || 1;
  const out = [];
  let cursor = 0;
  for (const [i, s] of sentences.entries()) {
    const isLast = i === sentences.length - 1;
    const len = isLast ? duration - cursor : Math.max(0.6, duration * (s.length / totalChars));
    out.push({ start: cursor, end: Math.min(duration, cursor + len), text: s });
    cursor += len;
  }
  return out;
}

/** ASR 句段 → 句单位。ASR 返回的已经是整句及其起止时间，直接沿用。 */
function sentencesFromSegments(segments) {
  return (segments || [])
    .map((s) => ({
      start: Math.max(0, Number(s.start) || 0),
      end: Math.max(0, Number(s.end) || 0),
      text: String(s.text || '').trim(),
    }))
    .filter((s) => s.text);
}

/** 每段动作的最短时长（秒），文档级硬约束。 */
const MIN_ACTION_SECONDS = 5;

/**
 * 以 ASR 整句为单位切动作段：
 *  - 边界只能落在句首，绝不把一句话拆到两段里；
 *  - 每段至少 5 秒，不够就向后并入下一整句；
 *  - 最后一段不足 5 秒时并入上一段；
 *  - 不再用「平均 N 秒」做目标时长。
 * @returns {{start:number,end:number,text:string}[]} 整数秒、首尾相接
 */
function buildSentenceBeats(sentences, duration, warnings = []) {
  const list = (sentences || [])
    .map((s) => ({
      start: Math.max(0, Number(s.start) || 0),
      end: Math.max(0, Number(s.end) || 0),
      text: String(s.text || '').trim(),
    }))
    .filter((s) => s.text);
  if (!list.length) return [];

  const total = Math.max(1, Math.ceil(duration));
  const n = list.length;
  const whole = () => [{ start: 0, end: total, text: joinTextParts(list.map((s) => s.text)) }];

  if (total <= MIN_ACTION_SECONDS) {
    warnings.push(`素材总时长 ${total} 秒，不足 ${MIN_ACTION_SECONDS} 秒，只能生成一段动作`);
    return whole();
  }

  // 句首取整为整数秒；保证严格递增，边界不会落在同一秒
  const starts = [];
  for (const s of list) {
    let v = Math.round(s.start);
    if (starts.length) v = Math.max(v, starts[starts.length - 1] + 1);
    starts.push(v);
  }
  // 极端情况下（句子密度高于秒数）退回整段一段动作
  if (starts[n - 1] >= total) return whole();

  const boundary = (i) => (i === 0 ? 0 : starts[i]);
  const endAt = (j) => (j + 1 < n ? starts[j + 1] : total);

  // 贪心：从当前句开始，向后并整句，直到这一段 ≥ 5 秒
  let cuts = [0];
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && endAt(j) - boundary(i) < MIN_ACTION_SECONDS) j += 1;
    i = j + 1;
    if (i < n) cuts.push(i);
  }

  // 最后一段不足 5 秒：并入上一段（并入的也是完整句子）
  if (cuts.length > 1) {
    const last = cuts[cuts.length - 1];
    if (total - boundary(last) < MIN_ACTION_SECONDS) cuts.pop();
  }
  // 只剩一段且不足 5 秒
  if (cuts.length === 1 && total < MIN_ACTION_SECONDS) {
    warnings.push(`素材总时长 ${total} 秒，不足 ${MIN_ACTION_SECONDS} 秒，只能生成一段动作`);
  }

  // 段数过多时按整句两两合并，边界仍然只在句首
  while (cuts.length > MAX_BEATS) {
    cuts = cuts.filter((_, idx) => idx % 2 === 0);
    warnings.push('动作段数过多，已按整句合并相邻段（仍以句首为边界）');
  }

  const beats = [];
  for (let k = 0; k < cuts.length; k += 1) {
    const from = cuts[k];
    const to = k + 1 < cuts.length ? cuts[k + 1] : n;
    const start = boundary(from);
    const end = to < n ? starts[to] : total;
    if (end <= start) continue;
    beats.push({ start, end, text: joinTextParts(list.slice(from, to).map((s) => s.text)) });
  }
  return beats;
}

// ---------------------------------------------------------------- 兜底模板

/** 招手/挥手在数字人上会持续摆动，任何一条出现都改用有收势的兜底动作。 */
const WAVE_GESTURE = /招手|挥手|摆手|挥手打招呼|挥了?挥?手/;

/** 画面里没有产品时，这些词一律不能出现在动作描述里，否则会生成虚假商品。 */
const PRODUCT_MENTION = /产品|商品|道具|瓶身|瓶子|瓶|软管|面霜|精华|口红|护肤|化妆品|包装|盒子|盒|罐子|罐|东西|物品|物件|膏体|乳液|面膜|粉底|眉笔|唇釉|唇膏|眼霜|水乳|手持|手中拿|拿起|举起|托起|托举|托住|举到|举至|握着|握住/;

/** 「右手平放在桌面」这类姿势会被视觉模型误塞进 held_objects，这里滤掉。 */
const HAND_POSTURE_ONLY = /^(?:左|右|双)?手(?:臂|指|掌)?(?:自然|平放|放|放回|放于|轻放|轻扶|扶着|叉腰|交叠|垂|按住|支撑|托住)/;
const OBJECT_NOUN = /瓶|管|盒|罐|杯|机|包|书|笔|伞|花|产品|商品|道具|物品|物件|玩具|食品/;

function usableObjects(profile) {
  return (Array.isArray(profile?.held_objects) ? profile.held_objects : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .filter((s) => !(HAND_POSTURE_ONLY.test(s) && !OBJECT_NOUN.test(s)));
}

/** 只有「画面明确有产品」且「有可用的手持物」时才允许写产品动作。 */
function hasHeldProduct(profile) {
  if (profile?.has_product === false) return false;
  return usableObjects(profile).length > 0;
}

function fallbackAction(beatText, profile, index = 0) {
  const t = String(beatText || '');
  const product = hasHeldProduct(profile) ? usableObjects(profile)[0] : '';
  const pick = (variants) => variants[Math.abs(index) % variants.length];
  if (/欢迎|大家好|哈喽|hello|嗨/i.test(t)) {
    return pick([
      '看向镜头点头致意，右手掌心向上轻抬到胸前示意，随后手自然放回胸前，表情自然',
      '面向镜头轻点两下头，双手在胸前自然摊开做欢迎手势，随后收回身前，表情专注自然',
      '面向镜头微微前倾，右手轻放胸口点头致意，随后双手自然放回身前，表情自然专注',
    ]);
  }
  if (/优惠|下单|购买|链接|购物车|关注|点赞|领券|拍下|库存/i.test(t)) {
    return pick([
      '面向镜头，右手掌心向上朝画面下方轻指示意，点头强调，随后把手收回身侧，表情专注，视线保持在镜头上',
      '右手轻拍胸口强调优惠，随后双手自然交叠放在身前，视线看向镜头，表情认真',
      '右手食指比出数字后掌心向下轻压，随后手收回胸前，点头强调，视线保持在镜头上',
    ]);
  }
  if (/产品|款|质地|成分|效果|使用|试一下|面霜|精华|口红|护肤|瓶|管/i.test(t)) {
    // 画面里没有产品时，讲产品只能用空手手势，绝不能写拿/举/指产品
    if (!product) {
      return pick([
        '看向镜头，右手掌心向上轻抬到胸前做说明手势，随后手自然放回胸前，表情专注',
        '面向镜头，双手在胸前做小幅手势说明，随后自然收回身前，轻轻点头，视线保持看向镜头',
        '右手食指轻点两下强调，随后手掌自然放下，表情认真，视线保持在镜头上',
      ]);
    }
    return pick([
      `双手把${product}托到胸前展示，随后单手翻转展示瓶身侧面，最后双手把产品放回胸前，视线在产品和镜头之间自然切换，表情专注`,
      `左手把${product}举到胸前，右手食指轻指产品细节，随后手放回产品旁，眉毛微扬，视线保持看向镜头`,
      `双手将${product}端到胸前，右手食指沿瓶身轮廓轻划一圈，随后双手收回身前，视线保持看向镜头，表情认真`,
    ]);
  }
  if (/[0-9一二三四五六七八九十百千万%％]|两周|明显|改善|百分之/i.test(t)) {
    return pick([
      '右手食指轻点两下强调，随后手掌自然放回胸前，轻轻点头，视线保持在镜头上',
      '右手比出对应数字，随后手掌向下轻压强调，点头，视线保持看向镜头',
      '右手食指朝前方轻点两下，随后手自然放回身侧，头部轻点，视线保持在镜头上',
    ]);
  }
  if (/谢谢|再见|拜拜|下次|收尾/i.test(t)) {
    return pick([
      '轻轻点头，双手自然交叠放在身前，视线看向镜头收尾',
      '面向镜头点头致意，双手自然垂放身侧，表情平和，视线落在镜头上',
      '右手轻抬到胸前做告别手势后自然放下，同时点头致意，视线看向镜头',
    ]);
  }
  return pick([
    '看向镜头自然说话，配合小幅手势，说完手自然放回胸前，头部轻微点动，表情自然',
    '面向镜头，右手轻抬做小幅说明手势，随后自然放下，头部轻点，视线保持在镜头上',
    '双手在胸前做小幅说明手势，随后自然放下，头部轻点两下，视线看向镜头，表情自然',
  ]);
}

/**
 * 动作落地前的本地清理：
 *  - 招手/挥手 / 空文本 / "[object Object]" → 语义兜底动作（触发词来自该段台词）
 *  - 相邻两段完全相同 → 换一个兜底动作，避免数字人保持同一姿势
 *  - 最后过滤违规视线和默认微笑
 */
function finalizeActions(beats, actionTexts, profile, warnings = []) {
  const actions = [];
  const noProduct = !hasHeldProduct(profile);
  let waveFixed = 0;
  let productFixed = 0;
  let dupFixed = 0;
  for (const [i, b] of beats.entries()) {
    let text = String(actionTexts[i] || '').trim();
    if (!text || text === '[object Object]' || WAVE_GESTURE.test(text)) {
      if (text && WAVE_GESTURE.test(text)) waveFixed += 1;
      text = fallbackAction(b.text, profile, i);
    }
    // 画面里没有产品：任何拿/举/指/看产品的描述都要拿掉，否则会凭空生成商品
    if (noProduct && PRODUCT_MENTION.test(text)) {
      productFixed += 1;
      text = fallbackAction(b.text, profile, i);
    }
    if (i > 0 && text === actions[i - 1].text) {
      dupFixed += 1;
      text = fallbackAction(b.text, profile, i + 1);
    }
    actions.push({
      text: softenSmiles(stripGazeViolations(text.slice(0, 240)), b.text),
      time_range: [b.start, b.end],
    });
  }
  if (waveFixed) warnings.push(`有 ${waveFixed} 段动作写了「招手/挥手」，已替换为其他手势（这类动作在数字人上会持续摆动）`);
  if (productFixed) warnings.push(`图片里没有识别到产品，已把 ${productFixed} 段提到产品/手持物的动作替换为空手手势，避免生成不存在的虚假商品`);
  if (dupFixed) warnings.push(`有 ${dupFixed} 段动作与上一段完全相同，已替换为不同的手势`);
  return actions;
}

// ---------------------------------------------------------------- 入口

async function generate(input = {}) {
  if (!apiKey) {
    throw Object.assign(new Error('服务端未配置 MiniMax API Key：启动时加 --minimax-key 或设置 MINIMAX_API_KEY 环境变量'), { status: 400 });
  }
  const started = Date.now();
  const warnings = [];
  const style = STYLES[input.style] ? input.style : '专业讲解';
  const language = String(input.language || 'auto');

  // 动作必须建立在图片理解之上：不允许关掉图片理解，也不允许拿不到图片就编排
  if (input.use_image === false) {
    throw Object.assign(new Error('AI 时间轴必须结合图片理解人物，不能关闭「参考图片理解」'), { status: 400 });
  }
  const imageAsset = await loadAsset(input.image, { maxBytes: MAX_IMAGE_BYTES, label: '角色图片' });
  if (!imageAsset) {
    throw Object.assign(new Error('请先上传或填写角色图片（image）：没有图片理解就无法生成动作'), { status: 400 });
  }
  if (imageAsset && !/^image\//.test(imageAsset.mime || '')) {
    // 部分 CDN 不返回 content-type，按扩展名兜底
    const name = String(input.image || '');
    if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) {
      throw Object.assign(new Error(`角色图片类型不正确：${imageAsset.mime || 'unknown'}`), { status: 422 });
    }
  }

  const audioAsset = await loadAsset(input.audio, { maxBytes: MAX_AUDIO_BYTES, label: '音频' });
  let asrResult = null;
  let text = String(input.text || '').trim();
  let source = 'estimate';
  let dir = null;

  try {
    if (audioAsset) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidu-timeline-'));
      const audioFile = path.join(dir, `audio${extFromMime(audioAsset.mime)}`);
      fs.writeFileSync(audioFile, audioAsset.buffer);
      asrResult = await asr.transcribeFile(audioFile, {
        name: input.audio_name || 'timeline-audio',
        language,
        timestampLevel: 'word',
      });
      source = 'asr';
      text = asrResult.text;
    } else if (!text) {
      throw Object.assign(new Error('音频和 text 至少传一个'), { status: 400 });
    }

    const duration = asrResult?.duration || Number(input.duration) || estimateDuration(text);
    if (!duration || duration < 0.5) throw Object.assign(new Error('读不出有效时长'), { status: 422 });
    if (duration > MAX_DURATION) {
      throw Object.assign(new Error(`素材 ${duration.toFixed(1)} 秒，超过 ${MAX_DURATION} 秒上限，请先分段`), { status: 422 });
    }
    if (!asrResult) warnings.push('没有音频，时间轴按文本和 2.5 字/秒估算，可能与 TTS 实际时长有偏差');

    // 动作段以 ASR 的整句时间为准：整句分组、边界只在句首、每段 ≥5 秒
    const sentences = asrResult ? sentencesFromSegments(asrResult.segments) : sentencesFromText(text, duration);
    if (!sentences.length) throw Object.assign(new Error('没有可用的语音内容'), { status: 422 });

    const beats = buildSentenceBeats(sentences, duration, warnings);
    if (!beats.length) throw Object.assign(new Error('动作分段失败'), { status: 500 });

    let profile;
    let imageUsage = null;
    try {
      profile = await visionProfile(imageAsset);
    } catch (err) {
      // 不做「纯文本编排」兜底：没有图片理解就不生成动作
      throw Object.assign(new Error(`图片理解失败，无法生成动作：${err.message}`), { status: 502 });
    }
    imageUsage = profile.usage || null;
    delete profile.usage;
    // 回传/展示时只保留真正可用的道具，滤掉「右手平放在桌面」这类姿势噪音
    profile.held_objects = usableObjects(profile);
    if (!profile.has_person) {
      throw Object.assign(new Error('图片里没有识别到人物，无法生成数字人动作。请换一张含清晰人物的单人图片。'), { status: 422 });
    }

    let actionTexts;
    try {
      const plan = await planActions({ profile, beats, style, duration });
      actionTexts = plan.actions;
    } catch (err) {
      warnings.push(`AI 编排失败，已使用关键词模板兜底：${err.message}`);
      actionTexts = beats.map((b, i) => fallbackAction(b.text, profile, i));
    }
    if (actionTexts.length !== beats.length) {
      actionTexts = beats.map((b, i) => actionTexts[i] || fallbackAction(b.text, profile, i));
    }

    // 最后过一遍本地清理：招手/挥手、相邻重复、违规视线、默认微笑都在这里收口
    const actions = finalizeActions(beats, actionTexts, profile, warnings);

    const latency = Date.now() - started;
    return {
      timeline: { actions },
      profile,
      beats: beats.map((b) => ({ start: b.start, end: b.end, text: b.text })),
      meta: {
        duration: +duration.toFixed(3),
        source,
        style,
        model,
        latency_ms: latency,
        chunks: asrResult?.chunks || 0,
        trace_ids: asrResult?.trace_ids || [],
        image_usage: imageUsage,
      },
      warnings,
    };
  } finally {
    if (dir) fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

module.exports = {
  configure,
  configured,
  generate,
  DEFAULT_MODEL,
  MAX_DURATION,
  MAX_IMAGE_BYTES,
  MAX_AUDIO_BYTES,
  STYLES,
  _internals: { sentencesFromSegments, sentencesFromText, buildSentenceBeats, estimateDuration, stripGazeViolations, softenSmiles, fallbackAction, actionText, finalizeActions, usableObjects, hasHeldProduct, WAVE_GESTURE, PRODUCT_MENTION, GAZE_VIOLATION },
};
