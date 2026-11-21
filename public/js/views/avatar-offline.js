/**
 * S2-Avatar 非实时视频文件版。
 * POST /ent/s_avatar/offline 创建任务 -> 轮询 GET /ent/v2/tasks/{id}/creations。
 */
import { h, clear, card, toast, statusPill, jsonBlock, copy } from '../core/ui.js';
import { post, get, ApiError } from '../core/api.js';
import { loadDraft, saveDraft } from '../core/state.js';
import { createRequestEditor, createResponseView, createPanelLayout, createLogPanel } from '../core/panel.js';
import { buildForm } from '../core/form.js';
import { offlineCreateSchema, timelineSchema, TIMELINE_EXAMPLE, TASK_STATES } from '../schema/avatar-offline.js';
import { voicePicker } from './voice-picker.js';

const DRAFT = 'avatar-offline';
const HISTORY_KEY = DRAFT + ':history';
const HISTORY_MAX = 30;
/** 轮询总超时：文档要求用挂钟时间判断，而不是 progress。 */
const POLL_TIMEOUT_MS = 20 * 60 * 1000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const AUDIO_MAX_BYTES = 15 * 1024 * 1024;
/** 中文合成语速：文档给的是约 2-3 字/秒，取中值估算。 */
const CHARS_PER_SECOND = 2.5;

const PRESETS = [
  {
    label: '音频 + 动作时间轴',
    values: {
      model: 'vidu-s2',
      image: 'https://scene.vidu.zone/media-asset/084945-xpk47RWYcBgJ27nJ.png',
      audio: 'https://scene.vidu.zone/media-asset/085244-FrJjNf5tKjiZHQkf.mp3',
      text: '', voice: '', resolution: '720p',
    },
    timeline: {
      actions: [
        { text: '直视镜头，右手轻抬到胸口，头部轻点打招呼，表情自然地说话', time_range: [0, 5] },
        { text: '左手把薄荷绿护肤品举到胸前，右手食指轻指产品，眉毛微扬，视线保持看向镜头', time_range: [5, 10] },
        { text: '看向镜头，双手在胸前做展示手势，表情专注，头部微微侧倾', time_range: [10, 15] },
        { text: '点头强调卖点，身体略前倾，眼神真诚，认真收尾', time_range: [15, 18] },
      ],
    },
  },
  {
    label: '文本 + 音色（最省）',
    values: {
      model: 'vidu-s2',
      image: 'https://scene.vidu.zone/media-asset/084945-xpk47RWYcBgJ27nJ.png',
      audio: '', text: '大家好，今天给大家介绍一款很棒的产品。', voice: 'female-shaonv', resolution: '720p',
    },
    timeline: null,
  },
];

function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 读音频时长（秒）。URL 跨域时 metadata 可能拿不到，超时就放弃。 */
function probeAudioDuration(src) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const timer = setTimeout(() => resolve(null), 6000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve(Number.isFinite(audio.duration) ? audio.duration : null);
    };
    audio.onerror = () => { clearTimeout(timer); resolve(null); };
    audio.src = src;
  });
}

/** 校验 timeline 动作，返回 { errors, warnings }。 */
function checkActions(actions) {
  const errors = [];
  const warnings = [];
  const sorted = [...actions].sort((a, b) => a.time_range[0] - b.time_range[0]);
  sorted.forEach((a, i) => {
    const [start, end] = a.time_range;
    if (end <= start) errors.push(`动作 ${i + 1}「${a.text.slice(0, 12)}」结束时间必须大于开始时间`);
    if (end - start < 5) warnings.push(`动作 ${i + 1} 只有 ${end - start} 秒，建议每段不小于 5 秒（AI 生成会按整句自动合并到 ≥5 秒）`);
    if (i > 0) {
      const prev = sorted[i - 1];
      if (start < prev.time_range[1]) errors.push(`动作 ${i} 与动作 ${i + 1} 的时间段重叠`);
    }
  });
  return { errors, warnings };
}

export function avatarOfflineView() {
  const log = createLogPanel({ title: '任务日志' });

  let polling = null;
  let taskId = '';
  let pollStartedAt = 0;
  let elapsedTimer = null;
  let history = loadDraft(HISTORY_KEY) || [];

  // timeline 单独收集，提交时序列化成 JSON 字符串塞进 body.timeline
  // 兼容旧草稿（结构化 actions）→ 新的 JSON 文本
  function timelineDraft() {
    const saved = loadDraft(DRAFT + ':timeline') || {};
    if (saved.raw !== undefined) return saved;
    const actions = (saved.actions || [])
      .filter((a) => a.text)
      .map((a) => ({ text: a.text, time_range: [Number(a.start) || 0, Number(a.end) || 0] }));
    return actions.length ? { raw: JSON.stringify({ actions }, null, 2) } : {};
  }

  const timelineForm = buildForm(timelineSchema, { values: timelineDraft() });
  const timelineEnabled = h('input', { type: 'checkbox', onchange: () => { refreshTimelinePreview(); editor.refresh(); } });
  // 只做状态提示，不再放第二个「预览 JSON」框——时间轴只有一个输入框
  const timelinePreview = h('div.note');

  /** 解析输入框里的 JSON；格式不对时抛出可读的错误。 */
  function parseTimeline() {
    const raw = String(timelineForm.collect().raw || '').trim();
    if (!raw) throw new Error('时间轴为空：填 {"actions":[...]}，或点右上角「填入示例」');
    let data;
    try { data = JSON.parse(raw); }
    catch (err) { throw new Error(`JSON 解析失败：${err.message}`); }
    if (Array.isArray(data)) data = { actions: data };
    if (!data || typeof data !== 'object' || !Array.isArray(data.actions)) {
      throw new Error('格式应为 {"actions":[{"text":"...","time_range":[开始秒,结束秒]}, ...]}');
    }
    if (!data.actions.length) throw new Error('actions 不能为空');
    return data.actions.map((a, i) => {
      const text = String(a?.text || '').trim();
      if (!text) throw new Error(`第 ${i + 1} 个动作缺少 text`);
      const range = a?.time_range;
      if (!Array.isArray(range) || range.length !== 2) {
        throw new Error(`第 ${i + 1} 个动作的 time_range 必须是 [开始秒, 结束秒]`);
      }
      const [start, end] = range;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0) {
        throw new Error(`第 ${i + 1} 个动作的 time_range 必须是两个非负整数（单位：秒）`);
      }
      if (end <= start) throw new Error(`第 ${i + 1} 个动作结束时间必须大于开始时间`);
      return { text, time_range: [start, end] };
    });
  }

  /** 已启用但输入框是空的——不当作错误，本次提交按「不传 timeline」处理。 */
  function timelineIsBlank() {
    return timelineEnabled.checked && !String(timelineForm.collect().raw || '').trim();
  }

  function timelineActions() {
    if (!timelineEnabled.checked) return [];
    if (timelineIsBlank()) return [];
    return parseTimeline();
  }

  function timelineString() {
    if (!timelineEnabled.checked) return undefined;
    try {
      const actions = parseTimeline();
      return actions.length ? JSON.stringify({ actions }) : undefined;
    } catch { return undefined; } // 输入中的 JSON 不完整时不打断编辑，提交时再报错
  }

  function refreshTimelinePreview() {
    if (!timelineEnabled.checked) {
      timelinePreview.textContent = '（未启用，系统将基于音频自动生成动作）';
      timelinePreview.style.color = '';
      return;
    }
    if (timelineIsBlank()) {
      timelinePreview.textContent = '（已启用但内容为空：本次提交不会发送 timeline，系统会基于音频自动生成动作。点「填入示例」或「AI 生成」可直接填充）';
      timelinePreview.style.color = 'var(--warn, #d29922)';
      return;
    }
    try {
      const actions = parseTimeline();
      const start = Math.min(...actions.map((a) => a.time_range[0]));
      const end = Math.max(...actions.map((a) => a.time_range[1]));
      timelinePreview.textContent = `✓ 时间轴有效：${actions.length} 段动作 · ${start}–${end}s，提交时会序列化进 timeline 字段`;
      timelinePreview.style.color = '';
    } catch (err) {
      timelinePreview.textContent = `时间轴有误：${err.message}`;
      timelinePreview.style.color = 'var(--red, #e5534b)';
    }
  }

  function fillTimelineExample() {
    timelineForm.apply({ raw: TIMELINE_EXAMPLE });
    timelineEnabled.checked = true;
    refreshTimelinePreview();
    editor.refresh();
    toast('已填入 30 秒示例，按实际音频时长调整每段的结束时间', 'ok');
  }

  // ---------------------------------------------------------- AI 生成时间轴
  let aiBusy = false;
  let aiAbort = null;
  let aiPrev = null;
  let aiPrevEnabled = false;

  const aiStyle = h('select', {},
    h('option', { value: '专业讲解', selected: true }, '专业讲解'),
    h('option', { value: '亲切带货' }, '亲切带货'),
    h('option', { value: '活力种草' }, '活力种草'),
  );
  const aiRunBtn = h('button.mini.primary', { type: 'button', onclick: runAiTimeline }, '开始生成');
  const aiCancelBtn = h('button.mini.danger', { type: 'button', onclick: () => aiAbort?.abort() }, '取消');
  const aiUndoBtn = h('button.mini', { type: 'button', onclick: undoAiTimeline }, '撤销生成');
  const aiStatus = h('div.note', '用当前图片 + 音频（或 text）生成时间轴：先做 word 级 ASR，再理解图片里的人物，最后编排动作。分段按 ASR 整句时间切，边界只在句首，每段至少 5 秒；图片里没有识别到人会直接报错；图片里没有产品时不会生成任何拿/举/指产品的动作。');
  const aiWarning = h('div.note');
  aiWarning.style.whiteSpace = 'pre-wrap';
  const aiPanel = h('div', {
    style: { display: 'none', borderTop: '1px dashed var(--border)', marginTop: '10px', paddingTop: '10px' },
  },
    h('div.row.wrap',
      h('span.muted', '风格'), aiStyle,
      aiRunBtn, aiCancelBtn, aiUndoBtn,
    ),
    aiStatus, aiWarning,
  );
  aiCancelBtn.style.display = 'none';
  aiUndoBtn.style.display = 'none';

  const aiToggleBtn = h('button.mini', {
    type: 'button',
    onclick: () => { aiPanel.style.display = aiPanel.style.display === 'none' ? '' : 'none'; },
  }, 'AI 生成');

  async function runAiTimeline() {
    if (aiBusy) return;
    let body;
    try { body = editor.current(); } catch (err) { toast(err.message, 'err', 5000); return; }
    if (!body.image) {
      toast('请先上传或填写角色图片：AI 时间轴必须结合图片理解人物', 'warn', 5000);
      return;
    }
    if (!body.audio && !body.text) {
      toast('请先填写音频或 text', 'warn', 5000);
      return;
    }

    aiBusy = true;
    aiRunBtn.disabled = true;
    aiCancelBtn.style.display = '';
    aiStatus.className = 'note';
    aiStatus.textContent = '准备中…';
    aiWarning.textContent = '';
    const started = Date.now();
    const tick = setInterval(() => {
      if (!aiBusy) return;
      aiStatus.textContent = `服务端处理中… ${((Date.now() - started) / 1000).toFixed(0)}s（识别语音 → 理解图片 → 编排动作）`;
    }, 1000);
    aiAbort = new AbortController();

    try {
      const res = await fetch('/timeline/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: body.image,
          audio: body.audio,
          text: body.text,
          voice: body.voice,
          duration: audioDuration || undefined,
          style: aiStyle.value,
          use_image: true,
          language: 'auto',
        }),
        signal: aiAbort.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      const actions = data.timeline?.actions || [];
      if (!actions.length) throw new Error('生成结果为空');

      aiPrev = String(timelineForm.collect().raw || '');
      aiPrevEnabled = timelineEnabled.checked;
      // 展示层的问题不能伪装成「生成失败」：服务端已经成功返回了，这里单独兜底
      try {
        timelineForm.apply({ raw: JSON.stringify({ actions }, null, 2) });
        timelineEnabled.checked = true;
        refreshTimelinePreview();
        editor.refresh();
      } catch (err) {
        toast(`时间轴已生成 ${actions.length} 段，但预览刷新失败：${err.message}`, 'warn', 6000);
      }
      aiUndoBtn.style.display = '';

      const p = data.profile;
      const profileLine = p
        ? `人物理解：${p.shot || '—'}；可见 ${(p.visible_parts || []).join('、') || '—'}；手持 ${(p.held_objects || []).join('、') || '—'}；限制 ${(p.constraints || []).join('、') || '—'}`
        : '';
      aiStatus.className = 'note ok';
      aiStatus.textContent = `已生成 ${actions.length} 段 · ${data.meta.duration}s · ${data.meta.source === 'asr' ? 'ASR 时间戳' : '文本估算'} · 用时 ${(data.meta.latency_ms / 1000).toFixed(1)}s`;
      aiWarning.className = 'note';
      aiWarning.textContent = [profileLine, ...(data.warnings || [])].filter(Boolean).join('\n');
      toast(`已生成 ${actions.length} 段时间轴，请检查后提交`, 'ok', 6000);
    } catch (err) {
      if (err.name === 'AbortError') {
        aiStatus.textContent = '已取消';
        aiStatus.className = 'note';
      } else {
        aiStatus.className = 'note err';
        aiStatus.textContent = `生成失败：${err.message}`;
        toast(`生成失败：${err.message}`, 'err', 8000);
      }
    } finally {
      clearInterval(tick);
      aiBusy = false;
      aiRunBtn.disabled = false;
      aiCancelBtn.style.display = 'none';
      aiAbort = null;
    }
  }

  function undoAiTimeline() {
    if (aiPrev === null) return;
    timelineForm.apply({ raw: aiPrev });
    timelineEnabled.checked = aiPrevEnabled;
    refreshTimelinePreview();
    editor.refresh();
    aiPrev = null;
    aiUndoBtn.style.display = 'none';
    aiStatus.textContent = '已恢复生成前的时间轴';
    aiStatus.className = 'note';
    toast('已恢复生成前的时间轴', 'ok');
  }

  const timelineBox = card('动作时间轴 timeline', {
    hint: '只有一个输入框：直接手填 JSON，或点「AI 生成」/「填入示例」写入同一个框。相邻动作首尾相接、不要重叠。',
    collapsible: true, open: true,
    actions: h('div.row',
      aiToggleBtn,
      h('button.mini', { type: 'button', onclick: fillTimelineExample }, '填入示例'),
      h('label.toggle', timelineEnabled, h('span', '启用')),
    ),
  },
    timelineForm.element,
    timelinePreview,
    aiPanel,
  );

  timelineForm.element.addEventListener('input', () => { refreshTimelinePreview(); editor.refresh(); });
  timelineForm.element.addEventListener('change', () => { refreshTimelinePreview(); editor.refresh(); });

  // ---------------------------------------------------------- 创建表单
  const editor = createRequestEditor({
    schema: offlineCreateSchema,
    values: loadDraft(DRAFT) || {},
    title: '创建请求体',
    endpoint: 'POST /ent/s_avatar/offline',
    transform: (raw) => {
      const out = { ...raw };
      const tl = timelineString();
      if (tl) out.timeline = tl;
      return out;
    },
  });
  const response = createResponseView({ title: '创建响应' });
  const pollResponse = createResponseView({ title: '查询响应（最近一次轮询）' });

  refreshTimelinePreview();

  // ---------------------------------------------------------- 任务状态
  const statePill = statusPill('未提交', 'idle');
  const progressBar = h('div.progress-fill');
  const progressText = h('span.muted', '—');
  const elapsedText = h('span.muted', '');
  const creations = h('div.creations');

  const taskBox = card('任务状态', {
    hint: 'progress 是非线性的，会长时间停在 99，这是正常现象，不要用它判断卡死。',
    actions: h('div',
      h('button.mini', { type: 'button', onclick: doQueryOnce }, '手动查一次'),
      h('button.mini.danger', { type: 'button', onclick: stopPolling }, '停止轮询'),
    ),
  },
    h('div.row', statePill, progressText, elapsedText),
    h('div.progress', progressBar),
    creations,
  );

  // ---------------------------------------------------------- 操作
  const submitBtn = h('button.primary', { type: 'button', onclick: doSubmit }, '提交任务并轮询');
  const taskIdInput = h('input', { type: 'text', placeholder: '已有 task_id，直接查' });
  const attachBtn = h('button.secondary', {
    type: 'button',
    onclick: () => {
      const id = taskIdInput.value.trim();
      if (!id) { toast('请先填入 task_id', 'warn'); return; }
      taskId = id;
      startPolling();
    },
  }, '查询已有任务');

  // ---------------------------------------------------------- 预设 / 上传 / 预估
  const estimateBox = h('div.note', '费用预估：—');
  let audioDuration = null;
  let estimateSeq = 0;

  async function refreshEstimate() {
    const seq = ++estimateSeq;
    let body;
    try { body = editor.current(); } catch { return; }
    const duration = audioDuration;
    let line;
    if (body.audio && duration) {
      line = `音频时长约 ${duration.toFixed(1)}s，向上取整后约 ${Math.ceil(duration)} 积分（${(Math.ceil(duration) / 32).toFixed(2)} 元）`;
    } else if (body.audio) {
      line = body.audio.startsWith('http')
        ? '音频为 URL，浏览器未能读取时长，实际以查询返回的 credits 为准（每秒 1 积分）'
        : '音频时长按实际长度向上取整，每秒 1 积分';
    } else if (body.text) {
      const secs = Math.ceil(body.text.length / CHARS_PER_SECOND);
      line = `文本 ${body.text.length} 字，按约 2-3 字/秒估算合成约 ${secs}s，约 ${secs} 积分（${(secs / 32).toFixed(2)} 元）`;
    } else {
      line = '填写 audio 或 text 后显示预估';
    }
    if (seq === estimateSeq) estimateBox.textContent = `费用预估：${line}。余额低于 45 积分无法发起任务。`;
  }

  async function updateAudioDuration() {
    let body;
    try { body = editor.current(); } catch { return; }
    audioDuration = body.audio ? await probeAudioDuration(body.audio) : null;
    refreshEstimate();
  }

  const presetSelect = h('select', {},
    h('option', { value: '' }, '选择预设模板…'),
    ...PRESETS.map((p, i) => h('option', { value: String(i) }, p.label)),
  );
  presetSelect.addEventListener('change', () => {
    const preset = PRESETS[Number(presetSelect.value)];
    if (!preset) return;
    editor.apply({ ...preset.values });
    if (preset.timeline) {
      timelineForm.apply({ raw: JSON.stringify(preset.timeline, null, 2) });
      timelineEnabled.checked = true;
    } else {
      timelineForm.apply({ raw: '' });
      timelineEnabled.checked = false;
    }
    refreshTimelinePreview();
    editor.refresh();
    refreshPreviews();
    updateAudioDuration();
    toast(`已套用预设：${preset.label}`, 'ok');
    presetSelect.value = '';
  });

  function uploadButton(label, accept, maxBytes, field) {
    // 透明 input 覆盖按钮，点击即原生点击；display:none + input.click() 在部分 WebView 会被拦截
    const input = h('input', {
      type: 'file', accept,
      style: { position: 'absolute', inset: '0', width: '100%', height: '100%', opacity: '0', cursor: 'pointer', zIndex: '2' },
    });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      if (file.size > maxBytes) {
        toast(`文件 ${(file.size / 1048576).toFixed(1)}MB 超过 ${maxBytes / 1048576}MB，请缩小或改用公网 URL（请求体有大小上限）`, 'err', 6000);
        return;
      }
      try {
        const uri = await fileToDataUri(file);
        editor.apply({ ...editor.current(), [field]: uri });
        // apply 只写控件值，不会触发表单的 input/change 事件，这里必须手动刷新预览
        refreshPreviews();
        refreshEstimate();
        toast(`${label}已转成 base64（${(file.size / 1024).toFixed(0)}KB）填入 ${field}`, 'ok');
        if (field === 'audio') updateAudioDuration();
      } catch (err) { toast(`读取文件失败：${err.message}`, 'err'); }
    });
    return h('span', { style: { position: 'relative', display: 'inline-block' } },
      input,
      h('button.mini', { type: 'button' }, label),
    );
  }

  const imagePreview = h('img.thumb', {
    style: { display: 'none', maxHeight: '140px', maxWidth: '100%', borderRadius: '6px', border: '1px solid var(--border)' },
  });
  const audioPreview = h('audio', { controls: true, style: { display: 'none', width: '100%' } });
  const imageNote = h('div.note', '图片：暂无');
  const audioNote = h('div.note', '音频：暂无');
  const previewBox = h('div', {
    style: { border: '1px solid var(--border)', borderRadius: '8px', padding: '10px', marginBottom: '10px' },
  },
    h('div', { style: { fontSize: '12px', color: 'var(--text-2)', marginBottom: '6px' } }, '素材预览'),
    imagePreview, imageNote,
    audioPreview, audioNote,
  );

  function refreshPreviews() {
    let body = {};
    try { body = editor.current(); } catch { /* 原始 JSON 写坏时忽略 */ }
    const image = body.image;
    if (image) {
      if (imagePreview.getAttribute('src') !== image) imagePreview.src = image;
      imagePreview.style.display = '';
      imageNote.textContent = image.startsWith('data:')
        ? `图片：本地文件（base64，约 ${(image.length * 0.75 / 1024).toFixed(0)}KB）`
        : `图片：${image.length > 80 ? image.slice(0, 80) + '…' : image}`;
    } else {
      imagePreview.style.display = 'none';
      imageNote.textContent = '图片：暂无（填写 image 后显示）';
    }

    const audio = body.audio;
    if (audio) {
      if (audioPreview.getAttribute('src') !== audio) audioPreview.src = audio;
      audioPreview.style.display = '';
      audioNote.textContent = audio.startsWith('data:')
        ? `音频：本地文件（base64，约 ${(audio.length * 0.75 / 1048576).toFixed(1)}MB）`
        : `音频：${audio.length > 80 ? audio.slice(0, 80) + '…' : audio}`;
    } else {
      audioPreview.style.display = 'none';
      audioNote.textContent = body.text
        ? `音频：TTS 模式（文本 ${String(body.text).length} 字${body.voice ? `，voice=${body.voice}` : ''}）— 语音由 Vidu 服务端合成，生成视频后才能试听`
        : '音频：暂无（填写 audio 或 text 后显示）';
    }
  }

  // 表单变化时刷新预览与预估（audio 变化才重新探测时长）
  let lastAudio;
  const formEl = editor.formElement;
  const onFormChange = () => {
    refreshPreviews();
    let body = {};
    try { body = editor.current(); } catch { /* ignore */ }
    if (body.audio !== lastAudio) { lastAudio = body.audio; updateAudioDuration(); } else refreshEstimate();
  };
  formEl.addEventListener('input', onFormChange);
  formEl.addEventListener('change', onFormChange);

  // ---------------------------------------------------------- 历史任务
  const historyList = h('div.history');
  function saveHistory(entry) {
    history = [entry, ...history.filter((x) => x.task_id !== entry.task_id)].slice(0, HISTORY_MAX);
    saveDraft(HISTORY_KEY, history);
    renderHistory();
  }
  function updateHistory(id, patch) {
    const item = history.find((x) => x.task_id === id);
    if (!item) return;
    Object.assign(item, patch);
    saveDraft(HISTORY_KEY, history);
    renderHistory();
  }
  function renderHistory() {
    clear(historyList);
    if (!history.length) { historyList.appendChild(h('div.note', '暂无历史。提交过的任务会记在浏览器本地。')); return; }
    for (const item of history) {
      const expired = Date.now() - item.created > 24 * 3600 * 1000;
      historyList.appendChild(h('div.row.wrap',
        h('code', item.task_id),
        h(`span.pill.${item.state === 'success' ? 'ok' : item.state === 'failed' ? 'err' : 'idle'}`, item.state || '未知'),
        h('span.muted', new Date(item.created).toLocaleString() + (item.credits ? ` · ${item.credits}积分` : '') + (expired ? ' · 地址已过期' : '')),
        h('button.mini', { type: 'button', onclick: () => { taskId = item.task_id; taskIdInput.value = taskId; startPolling(); } }, '查询'),
        h('button.mini', { type: 'button', onclick: () => { editor.apply(item.request); toast('已回填该任务的请求体（timeline 以原始 JSON 为准）', 'ok'); refreshPreviews(); refreshEstimate(); } }, '复用参数'),
      ));
    }
  }
  const historyBox = card('历史任务', {
    hint: '最近 30 条，仅存浏览器本地。base64 素材不会写入历史。',
    collapsible: true, open: false,
    actions: h('button.mini.danger', { type: 'button', onclick: () => { history = []; saveDraft(HISTORY_KEY, history); renderHistory(); } }, '清空'),
  }, historyList);

  const actionBox = card('操作', {},
    h('div.row.wrap', presetSelect, uploadButton('上传本地图片', 'image/png,image/jpeg,image/webp', IMAGE_MAX_BYTES, 'image'),
      uploadButton('上传本地音频', 'audio/*', AUDIO_MAX_BYTES, 'audio')),
    previewBox, estimateBox,
    h('div.row.wrap', submitBtn),
    h('div.row', taskIdInput, attachBtn),
    h('div.note', '计费提示：按视频时长每秒 1 积分（0.03125 元）。创建只做余额预检不扣分，排队时按预估时长预扣，失败会退还，最终以查询返回的 credits 为准。生成物地址 24 小时过期，需要长期保存请及时转存。'),
  );

  // ---------------------------------------------------------- 动作
  async function doSubmit() {
    let body;
    try {
      body = editor.current();
    } catch (err) { toast(err.message, 'err', 5000); return; }

    const errors = editor.validate();
    if (errors.length) { toast(errors[0], 'err', 5000); return; }
    if (!body.audio && !body.text) {
      toast('audio 与 text 至少传一个', 'err', 5000);
      return;
    }
    if (body.audio && body.text) {
      toast('audio 与 text 都传了，服务端会以 audio 为准', 'warn', 5000);
    }

    let actions;
    try { actions = timelineActions(); }
    catch (err) { toast(`时间轴有误：${err.message}`, 'err', 8000); return; }
    if (timelineIsBlank()) {
      log.info('⚠ 时间轴已启用但内容为空，本次不发送 timeline，由系统按音频自动生成动作');
      toast('时间轴已启用但内容为空，本次不发送 timeline（可用「填入示例」或「AI 生成」填充）', 'warn', 7000);
    }
    const tlCheck = checkActions(actions);
    if (tlCheck.errors.length) { toast(tlCheck.errors[0], 'err', 6000); return; }
    for (const w of tlCheck.warnings) log.info(`⚠ ${w}`);
    if (body.voice && body.audio) log.info('⚠ 同时传了 audio 与 voice，voice 不会生效');

    saveDraft(DRAFT, body.audio?.startsWith('data:') || body.image?.startsWith('data:') ? { ...body, image: body.image?.startsWith('data:') ? '' : body.image, audio: body.audio?.startsWith('data:') ? '' : body.audio } : body);
    saveDraft(DRAFT + ':timeline', timelineForm.collect());
    submitBtn.disabled = true;
    setState('提交中…', 'warn');

    // 余额预检：低于 45 积分服务端会直接拒绝，提前给出明确提示
    try {
      const credits = await get('/ent/v2/credits');
      const remain = (credits.data?.general_remains || credits.data?.remains || [])
        .reduce((sum, r) => sum + Number(r.credit_remain_int64 || r.credit_remain || 0), 0);
      log.info(`账户可用积分约 ${remain}`);
      if (remain < 45) { toast(`余额 ${remain} 积分，低于 45 无法发起任务`, 'err', 6000); setState('余额不足', 'err'); submitBtn.disabled = false; return; }
    } catch (err) { log.info(`余额预检失败，继续提交：${err.message}`); }

    const shown = { ...body };
    for (const k of ['image', 'audio']) if (shown[k]?.startsWith('data:')) shown[k] = `${shown[k].slice(0, 40)}…（base64 已省略）`;
    log.http('POST /ent/s_avatar/offline', shown);

    try {
      const result = await post('/ent/s_avatar/offline', body);
      response.show(result.call);
      taskId = result.data?.task_id || '';
      taskIdInput.value = taskId;
      log.http(`任务已创建 task_id=${taskId} state=${result.data?.state}`, result.data);
      saveHistory({
        task_id: taskId, state: result.data?.state, created: Date.now(),
        request: { ...shown, ...(body.timeline ? { timeline: body.timeline } : {}) },
      });
      toast(`任务已创建：${taskId}`, 'ok');
      startPolling();
    } catch (err) {
      if (err instanceof ApiError) response.show(err.call);
      setState('创建失败', 'err');
      log.error(err.message, err.body);
      toast(err.message, 'err', 6000);
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function doQueryOnce() {
    if (!taskId) { toast('还没有 task_id', 'warn'); return; }
    try {
      const result = await get(`/ent/v2/tasks/${taskId}/creations`);
      pollResponse.show(result.call);
      renderTask(result.data);
      return result.data;
    } catch (err) {
      if (err instanceof ApiError) pollResponse.show(err.call);
      log.error(err.message, err.body);
      return null;
    }
  }

  /** 文档建议 3~5 秒起步并逐步退避，不要低于 2 秒，否则可能触发 TooManyRequests。 */
  function startPolling() {
    stopPolling();
    pollStartedAt = Date.now();
    elapsedTimer = setInterval(() => {
      elapsedText.textContent = `已等待 ${Math.round((Date.now() - pollStartedAt) / 1000)}s`;
    }, 1000);
    let delay = 3000;
    const tick = async () => {
      const data = await doQueryOnce();
      const stateName = data?.state;
      if (data?.state) updateHistory(taskId, { state: data.state, credits: data.credits || undefined });
      if (Date.now() - pollStartedAt > POLL_TIMEOUT_MS) {
        stopPolling();
        toast('轮询超过 20 分钟仍未结束，已停止（任务可能仍在处理，可稍后手动查询）', 'warn', 8000);
        log.error('轮询总超时 20 分钟');
        return;
      }
      if (stateName && TASK_STATES[stateName]?.terminal) {
        stopPolling();
        if (stateName === 'success') {
          toast('任务完成', 'ok');
          log.info(`任务成功，消耗 ${data.credits} 积分，视频时长 ${data.duration}s`);
        } else {
          toast(`任务失败：${data.err_code}`, 'err', 8000);
          log.error(`任务失败 ${data.err_code}：${data.err_msg}`, data);
        }
        return;
      }
      delay = Math.min(delay * 1.3, 15000);
      polling = setTimeout(tick, delay);
    };
    polling = setTimeout(tick, 1200);
    log.info('开始轮询任务状态（3 秒起步，逐步退避到 15 秒）');
  }

  function stopPolling() {
    if (polling) clearTimeout(polling);
    polling = null;
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = null;
  }

  function setState(text, kind) {
    statePill.textContent = text;
    statePill.className = `pill ${kind}`;
  }

  function renderTask(data) {
    if (!data) return;
    const info = TASK_STATES[data.state];
    setState(`${info?.label || data.state}`, data.state === 'success' ? 'ok' : data.state === 'failed' ? 'err' : 'warn');
    const pct = Number(data.progress) || 0;
    progressBar.style.width = `${Math.min(pct, 100)}%`;
    progressText.textContent = `progress ${pct}%`
      + (data.credits ? ` · ${data.credits} 积分` : '')
      + (data.duration ? ` · ${data.duration}s` : '')
      + (data.err_code ? ` · ${data.err_code}` : '');

    clear(creations);
    if (data.err_msg) {
      creations.appendChild(h('div.note.err', `err_msg：${data.err_msg}`));
    }
    for (const item of data.creations || []) {
      const box = h('div.creation',
        h('div.creation-head', h('code', item.id)),
        item.url ? h('video', { src: item.url, controls: true, playsinline: true }) : null,
        h('div.row.wrap',
          item.url ? linkBtn('无水印 url', item.url) : null,
          item.watermarked_url ? linkBtn('带水印 watermarked_url', item.watermarked_url) : null,
          item.cover_url ? linkBtn('封面 cover_url', item.cover_url) : null,
        ),
        h('div.note', `这些地址 24 小时后失效（约 ${new Date(Date.now() + 86400000).toLocaleString()}），需要长期留存请及时转存。`),
        item.url ? h('a.mini', { href: item.url, download: `${item.id}.mp4`, target: '_blank', rel: 'noopener' }, '下载视频') : null,
      );
      creations.appendChild(box);
    }
  }

  function linkBtn(label, url) {
    return h('span.row',
      h('a.mini', { href: url, target: '_blank', rel: 'noopener' }, label),
      h('button.mini', { type: 'button', onclick: () => copy(url, '地址已复制') }, '复制'),
    );
  }

  renderHistory();
  refreshPreviews();
  refreshEstimate();

  const intro = h('div',
    h('h2', 'S2-Avatar 非实时视频文件版'),
    h('p', '图片 + 音频（或文本）+ 动作时间轴，异步生成 MP4。纯 HTTP 任务，不需要 WebSocket 和 RTC，成本最低，适合先用它验证 API Key 与出片效果。'),
  );

  return createPanelLayout({
    intro,
    left: [
      actionBox,
      historyBox,
      voicePicker({
        title: '音色速查（选「Avatar 非实时版」分组）',
        onPick: (id) => { editor.apply({ ...editor.current(), voice: id }); toast(`已填入音色 ${id}`, 'ok'); },
      }),
      editor.formElement,
    ],
    middle: [editor.element, timelineBox, response.element],
    right: [taskBox, pollResponse.element, log.element],
  });
}
