/**
 * S2-Editing 实时编辑模型面板。
 *
 * 链路与实时交互版一致：HTTP 创建 -> WS conn_init -> AliRTC。
 * 差别在于：你往频道里推一路视频作为编辑输入，订阅 render_uid 拿回编辑后的画面。
 */
import { h, clear, card, toast, statusPill } from '../core/ui.js';
import { post, wsUrl, ApiError } from '../core/api.js';
import { loadDraft, saveDraft } from '../core/state.js';
import { createRequestEditor, createResponseView, createPanelLayout, createLogPanel } from '../core/panel.js';
import { createMediaStage } from '../core/media.js';
import { LiveSocket, SIGNAL, newConnId } from '../core/ws.js';
import { editingCreateSchema, switchPromptSchema } from '../schema/editing.js';

const DRAFT = 'editing';

/** 优先 mp4（Chrome 126+，下载后直接能在任何播放器里拖动），否则回退 webm。 */
const REC_TYPES = [
  'video/mp4;codecs=avc1', 'video/mp4',
  'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
];
const pickRecType = () => REC_TYPES.find((t) => window.MediaRecorder?.isTypeSupported(t)) || '';
const fmtTime = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
/** 参考图压缩上限：WS 单条消息 16MB，base64 会膨胀 1/3，压到最长边 1280 的 JPEG 足够模型用。 */
const REF_MAX_EDGE = 1280;
const SWITCH_COOLDOWN_MS = 3000;

const SCENES = [
  { value: 'virtual_tryon', label: '虚拟试穿', hint: '参考图是衣服，穿到画面人物身上' },
  { value: 'subject_replacement', label: '主体替换', hint: '参考图是新人物，替换画面主体' },
  { value: 'background_replacement', label: '背景替换', hint: '参考图是新背景，保留人物' },
  { value: 'style_transfer', label: '风格迁移', hint: '参考图是风格，整体重绘' },
];

/** 本地图片 -> 压缩后的 JPEG data URI。 */
async function fileToRefImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, REF_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';   // 透明 PNG 转 JPEG 会变黑，先铺白底
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.9);
}

export function editingView() {
  const log = createLogPanel({ title: '链路日志' });

  let live = null;
  let rtcInfo = null;
  let renderUid = '';
  let clientSecret = '';
  let socket = null;
  let rtc = null;
  let relayKey = '';
  let hlsUrl = '';
  let hls = null;
  let billingTimer = null;
  let billingStart = 0;

  const editor = createRequestEditor({
    schema: editingCreateSchema,
    values: loadDraft(DRAFT) || {},
    title: '创建请求体',
    endpoint: 'POST /live/s_editing/realtime',
  });
  const response = createResponseView({ title: '创建响应' });

  // ---------------------------------------------------------- 状态
  const httpPill = statusPill('未创建', 'idle');
  const wsPill = statusPill('未连接', 'idle');
  const rtcPill = statusPill('未入会', 'idle');
  const billPill = statusPill('未计费', 'idle');

  const statusBar = h('div.status-bar',
    h('div.status-item', h('span.status-name', 'HTTP'), httpPill),
    h('div.status-item', h('span.status-name', 'WebSocket'), wsPill),
    h('div.status-item', h('span.status-name', 'AliRTC'), rtcPill),
    h('div.status-item', h('span.status-name', '计费'), billPill),
  );

  const setPill = (pill, text, kind) => { pill.textContent = text; pill.className = `pill ${kind}`; };

  // ---------------------------------------------------------- 输入源：服务端推流
  // 视频上传到服务器，由服务器上的无头 Chrome 当「摄像头 + 麦克风」入会推流，
  // 浏览器只负责上传、控制和看结果，不再碰视频，因此不受本机性能和标签页前后台影响。
  const MAX_SECONDS = 60;
  let asset = null;           // 服务端转码好的素材元数据
  let pubTimer = null;

  const fileInput = h('input', { type: 'file', accept: 'video/*' });
  const assetInfo = h('div.note', `尚未选择视频。时长上限 ${MAX_SECONDS} 秒，上传后服务器会转成 30fps 推流素材。`);
  const uploadBar = h('div.progress', h('div.progress-fill'));
  uploadBar.style.display = 'none';
  // 输入越大 Vidu 输出的重复帧越多（实测 1280 边约 11%，960 边约 4%，640 边约 3%）；
  // Vidu 输出固定约 544 宽，所以 960 边（≈540×960）几乎不损失细节。
  const edgeSelect = h('select', {},
    h('option', { value: '640' }, '640 边（最流畅，细节较少）'),
    h('option', { value: '960', selected: true }, '960 边（推荐，≈Vidu 输出尺寸）'),
    h('option', { value: '1280' }, '1280 边（原画，实测明显更卡）'),
  );
  // 码率留空 = 按分辨率自动（960 边约 900kbps）。服务器上行窄时调低，宁可糊一点也别让帧率掉下去。
  const kbpsInput = h('input', { type: 'number', min: 300, max: 3000, step: 100, placeholder: '自动' });
  edgeSelect.addEventListener('change', () => { if (fileInput.files?.[0]) fileInput.dispatchEvent(new Event('change')); });
  const loopSelect = h('select', {},
    h('option', { value: '0' }, '循环推流，直到手动挂断'),
    h('option', { value: '1' }, '播完一遍自动挂断'),
  );

  function uploadVideo(file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/publish/upload?name=${encodeURIComponent(file.name)}&edge=${edgeSelect.value}`);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) uploadBar.firstChild.style.width = `${Math.round((ev.loaded / ev.total) * 90)}%`;
      };
      xhr.upload.onload = () => { uploadBar.firstChild.style.width = '95%'; assetInfo.textContent = '上传完成，服务器转码中…'; };
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status === 200) resolve(body);
        else reject(new Error(body.message || `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(file);
    });
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    asset = null;
    uploadBar.style.display = '';
    uploadBar.firstChild.style.width = '0%';
    assetInfo.textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)}MB，上传中…`;
    try {
      asset = await uploadVideo(file);
      uploadBar.firstChild.style.width = '100%';
      assetInfo.textContent = `${asset.name} · ${asset.width}×${asset.height} · ${asset.duration}s · ${asset.hasAudio ? '含音频' : '无音频（推送静音）'}`;
      toast('视频已就绪，可以创建直播流并连接', 'ok');
    } catch (err) {
      assetInfo.textContent = `上传失败：${err.message}`;
      toast(`上传失败：${err.message}`, 'err', 7000);
    } finally {
      setTimeout(() => { uploadBar.style.display = 'none'; }, 800);
    }
  });

  const sourceBox = card('编辑输入源（服务端推流）', {
    hint: '上传一段视频，由服务器推进直播频道，你在浏览器里实时编辑、看结果。',
  },
    h('div.row', fileInput),
    uploadBar,
    assetInfo,
    h('label.field', h('div.field-label', '输入分辨率（最长边）'), edgeSelect),
    h('label.field', h('div.field-label', '推流码率 kbps（留空自动）'), kbpsInput),
    h('label.field', h('div.field-label', '播放方式'), loopSelect),
    h('div.note', '推流在服务器上完成：视频先转成固定 30fps 的素材，再由服务器上的 Chrome 当作摄像头 / 麦克风推出。因此推流过程不能暂停、拖动或调倍速。视频的声音与画面同源一起推送。'),
  );

  // ---------------------------------------------------------- 媒体
  const stage = createMediaStage({
    title: '实时编辑结果',
    localLabel: '编辑输入',
    localHint: '主画面是订阅到的 render_uid 渲染流（编辑结果）。本端推上去的编辑输入默认隐藏，只影响显示不影响推流。',
    placeholder: '等待编辑结果…\n创建直播流并完成 AliRTC 入会后，render_uid 的渲染流会显示在这里',
  });
  const localVideo = stage.localVideo;
  const remoteContainer = stage.remoteContainer;
  const mediaBox = stage.element;

  // ---------------------------------------------------------- switch_prompt
  const switchEditor = createRequestEditor({
    schema: switchPromptSchema,
    values: { prompts: [{ type: 'image', content: '' }] },
    title: '换图 / 换场景请求体',
    endpoint: 'WS type=13 switch_prompt',
    transform: (raw) => {
      const out = {};
      const prompts = (raw.prompts || []).filter((p) => p.content);
      if (prompts.length) out.prompts = prompts.map((p) => ({ type: p.type || 'image', content: p.content }));
      if (raw.editing_type) out.editing_type = raw.editing_type;
      return out;
    },
  });
  const switchBtn = h('button.primary', { type: 'button', disabled: true, onclick: doSwitchPrompt }, '发送 switch_prompt（type=13）');
  const switchBox = card('高级：手写 switch_prompt 请求体', {
    collapsible: true, open: false,
    hint: '成功时服务端不返回任何回执，画面数秒内自行切换；只有失败才会收到 type=14。别用「没回执就重发」的策略，服务端不去重，重发会重复触发切换。',
  }, switchEditor.formElement, switchEditor.element, switchBtn,
    h('div.note', '需要先创建直播流并连接（conn_init 成功）后才能发送。prompts 与 editing_type 至少传其一。'));

  // ---------------------------------------------------------- 直播中切换（场景 + 参考图库）
  const gallery = [];            // { id, src, name }
  let selectedId = '';
  let activeId = '';             // 当前正在直播中生效的那张
  let lastSwitchAt = 0;

  const sceneRadios = SCENES.map((sc, i) => {
    const input = h('input', { type: 'radio', name: 'edit-scene', value: sc.value, checked: i === 0 });
    return { sc, input, el: h('label.toggle', input, h('span', { title: sc.hint }, sc.label)) };
  });
  const sceneHint = h('div.note', SCENES[0].hint);
  for (const r of sceneRadios) r.input.addEventListener('change', () => { sceneHint.textContent = r.sc.hint; });
  const currentScene = () => sceneRadios.find((r) => r.input.checked)?.sc.value;
  const setScene = (value) => {
    const r = sceneRadios.find((x) => x.sc.value === value);
    if (r) { r.input.checked = true; sceneHint.textContent = r.sc.hint; }
  };

  const galleryEl = h('div.ref-gallery');
  const bigPreview = h('img.ref-preview', { alt: '' });
  bigPreview.style.display = 'none';
  const previewCaption = h('div.muted', '选择图库中的图片可预览');
  const instantBox = h('input', { type: 'checkbox' });
  const doSwitchBtn = h('button.primary', { type: 'button', disabled: true, onclick: () => switchTo(selectedId) }, '切换到选中图片');
  const sceneOnlyBtn = h('button.secondary', { type: 'button', disabled: true, onclick: () => switchTo('') }, '只切换场景');

  function renderGallery() {
    clear(galleryEl);
    for (const item of gallery) {
      const thumb = h('div.ref-thumb', {
        class: [item.id === selectedId ? 'selected' : '', item.id === activeId ? 'active' : ''].join(' '),
        onclick: () => { select(item.id); if (instantBox.checked && socket) switchTo(item.id); },
      },
        h('img', { src: item.src, alt: item.name }),
        item.id === activeId ? h('span.ref-badge', '当前') : null,
        h('button.ref-del', { type: 'button', title: '移除', onclick: (ev) => { ev.stopPropagation(); removeRef(item.id); } }, '×'),
      );
      galleryEl.appendChild(thumb);
    }
    if (!gallery.length) galleryEl.appendChild(h('div.note', '图库为空：上传本地图片，或粘贴图片 URL 添加。'));
  }

  function select(id) {
    selectedId = id;
    const item = gallery.find((x) => x.id === id);
    bigPreview.style.display = item ? '' : 'none';
    if (item) { bigPreview.src = item.src; previewCaption.textContent = item.name; }
    else previewCaption.textContent = '选择图库中的图片可预览';
    renderGallery();
  }

  function addRef(src, name) {
    const item = { id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, src, name };
    gallery.push(item);
    select(item.id);
    return item;
  }

  function removeRef(id) {
    const i = gallery.findIndex((x) => x.id === id);
    if (i < 0) return;
    gallery.splice(i, 1);
    if (selectedId === id) select(gallery[Math.max(0, i - 1)]?.id || '');
    else renderGallery();
  }

  const refFileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
  refFileInput.addEventListener('change', async () => {
    const files = Array.from(refFileInput.files || []);
    refFileInput.value = '';
    for (const file of files) {
      try {
        const uri = await fileToRefImage(file);
        addRef(uri, `${file.name}（压缩后 ${(uri.length * 0.75 / 1024).toFixed(0)}KB）`);
      } catch (err) { toast(`读取 ${file.name} 失败：${err.message}`, 'err', 5000); }
    }
  });
  const urlInput = h('input', { type: 'text', placeholder: 'https://… 图片地址，回车添加' });
  const addUrl = () => {
    const url = urlInput.value.trim();
    if (!/^https?:\/\//.test(url)) { toast('请输入 http(s) 图片地址', 'warn'); return; }
    addRef(url, url);
    urlInput.value = '';
  };
  urlInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') addUrl(); });

  function setSwitchEnabled(enabled) {
    doSwitchBtn.disabled = !enabled;
    sceneOnlyBtn.disabled = !enabled;
  }

  /** id 为空表示只切场景，沿用当前参考图。 */
  function switchTo(id) {
    if (!socket) { toast('请先创建直播流并连接', 'warn'); return; }
    const wait = SWITCH_COOLDOWN_MS - (Date.now() - lastSwitchAt);
    if (wait > 0) { toast(`服务端不去重，请等 ${Math.ceil(wait / 1000)} 秒再切换`, 'warn'); return; }
    const payload = { editing_type: currentScene() };
    const item = id ? gallery.find((x) => x.id === id) : null;
    if (id && !item) { toast('请先在图库里选一张图片', 'warn'); return; }
    if (item) payload.prompts = [{ type: 'image', content: item.src }];
    try {
      socket.send(SIGNAL.SWITCH_PROMPT, { switch_prompt: payload });
    } catch (err) { toast(err.message, 'err'); return; }
    lastSwitchAt = Date.now();
    if (item) activeId = item.id;
    renderGallery();
    const shown = item?.src.startsWith('data:') ? `${item.src.slice(0, 30)}…(${(item.src.length / 1024).toFixed(0)}KB)` : item?.src;
    log.info(`切换 → 场景=${payload.editing_type}${item ? `，图片=${shown}` : '（沿用当前图）'}`);
    toast('已发送切换，画面数秒内生效；失败才会回报错误', 'ok', 4000);
    setSwitchEnabled(false);
    setTimeout(() => { if (socket) setSwitchEnabled(true); }, SWITCH_COOLDOWN_MS);
  }

  renderGallery();

  const liveSwitchBox = card('直播中切换：场景 + 参考图', {
    hint: '虚拟试穿 / 主体替换 / 背景替换 / 风格迁移都可以在直播过程中随时切换，选图即可预览。',
  },
    h('div.field-label', '编辑场景'),
    h('div.row.wrap', sceneRadios.map((r) => r.el)),
    sceneHint,
    h('div.field-label', '参考图库'),
    galleryEl,
    h('div.row.wrap',
      h('button.mini', { type: 'button', onclick: () => refFileInput.click() }, '上传本地图片（可多选）'),
      refFileInput,
    ),
    h('div.row', urlInput, h('button.mini', { type: 'button', onclick: addUrl }, '添加')),
    h('div.ref-preview-box', bigPreview, previewCaption),
    h('div.row.wrap', doSwitchBtn, sceneOnlyBtn),
    h('label.toggle', instantBox, h('span', '点击缩略图立即切换（默认关，防止误触）')),
    h('div.note', `本地图片会压缩到最长边 ${REF_MAX_EDGE}px 的 JPEG 再发送。切换有 ${SWITCH_COOLDOWN_MS / 1000} 秒冷却，因为服务端不去重，重复发送会重复触发。`),
  );

  // ---------------------------------------------------------- 录像（服务端）
  // 服务器上的 ffmpeg 直接从本机 RTMP 流 -c copy 封装为 MP4：不解码、不重编码，
  // 画质与 Vidu 转推的一致，也不经过浏览器，所以不受浏览器性能和网络影响。
  let recTimer = null;
  let recStartedAt = 0;

  const recPill = statusPill('未录制', 'idle');
  const recStartBtn = h('button.primary', { type: 'button', disabled: true, onclick: () => startRecording() }, '开始录像');
  const recStopBtn = h('button.danger', { type: 'button', disabled: true, onclick: () => stopRecording() }, '停止并保存');
  const autoRecBox = h('input', { type: 'checkbox', checked: true });
  const recList = h('div.rec-list');

  async function refreshRecordings() {
    clear(recList);
    let items = [];
    try { items = (await (await fetch('/recordings')).json()).items || []; } catch (err) {
      recList.appendChild(h('div.note.err', `读取录像列表失败：${err.message}`)); return;
    }
    if (!items.length) { recList.appendChild(h('div.note', '服务器上还没有录像。')); return; }
    for (const rec of items.slice(0, 20)) {
      recList.appendChild(h('div.rec-item',
        h('div.row.wrap',
          h('code', rec.file),
          h('span.muted', `${(rec.size / 1048576).toFixed(1)}MB · ${new Date(rec.mtime).toLocaleString()}`),
          h('a.mini', { href: `/recordings/${rec.file}?download=1` }, '下载'),
          h('button.mini.danger', { type: 'button', onclick: async () => {
            if (!confirm(`删除服务器上的 ${rec.file}？`)) return;
            await fetch(`/recordings/${rec.file}`, { method: 'DELETE' });
            refreshRecordings();
          } }, '删除'),
        ),
        h('video', { src: `/recordings/${rec.file}`, controls: true, preload: 'metadata', style: 'width:100%;max-height:180px;background:#000;border-radius:6px' }),
      ));
    }
  }

  function setRecUi(recording) {
    recStartBtn.disabled = recording || !relayKey;
    recStopBtn.disabled = !recording;
  }

  async function startRecording() {
    if (!relayKey) { toast('还没有转推会话，请先创建直播流', 'warn'); return; }
    if (recTimer) return;
    try {
      const res = await fetch(`/relay/${relayKey}/record/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `edit-${live?.id || 'live'}` }) });
      const info = await res.json();
      if (!res.ok) throw new Error(info.message || `HTTP ${res.status}`);
      recStartedAt = Date.now();
      setRecUi(true);
      recTimer = setInterval(() => {
        recPill.textContent = `录制中 ${fmtTime(Math.round((Date.now() - recStartedAt) / 1000))}`;
        recPill.className = 'pill err';
      }, 500);
      log.info(`服务端开始录像 → recordings/${info.file}（ffmpeg -c copy，无二次编码）`);
    } catch (err) {
      toast(`开始录像失败：${err.message}`, 'err', 6000);
      log.error(`开始录像失败：${err.message}`);
    }
  }

  async function stopRecording() {
    if (!relayKey || !recTimer) return;
    clearInterval(recTimer); recTimer = null;
    recPill.textContent = '保存中…'; recPill.className = 'pill warn';
    try {
      const res = await fetch(`/relay/${relayKey}/record/stop`, { method: 'POST' });
      const info = await res.json();
      if (info.file) {
        log.info(`录像已保存：recordings/${info.file} · ${(info.size / 1048576).toFixed(1)}MB`);
        toast(`录像已保存到服务器：${info.file}`, 'ok', 6000);
      } else {
        log.error(`录像未保存：${info.error || '没有可录制的内容'}`);
        toast(`录像未保存：${info.error || '没有可录制的内容'}`, 'warn', 7000);
      }
    } catch (err) {
      log.error(`录像收尾失败：${err.message}`);
    }
    setRecUi(false);
    recPill.textContent = '未录制'; recPill.className = 'pill idle';
    refreshRecordings();
  }

  const recBox = card('录像（编辑结果）', {
    hint: '服务器直接从 Vidu 的转推流封装保存，不重编码、不经浏览器。',
    collapsible: true, open: true,
    actions: recPill,
  },
    h('div.row.wrap', recStartBtn, recStopBtn, h('button.mini', { type: 'button', onclick: refreshRecordings }, '刷新列表')),
    h('label.toggle', autoRecBox, h('span', '转推画面到达后自动开始录像')),
    h('div.note', '录像的画质就是 Vidu 转推的画质（实测约 952×544 / 24fps，含 AAC 音频），这是 Vidu 服务端的输出规格。挂断时自动停止并保存。'),
    recList,
  );
  refreshRecordings();

  // ---------------------------------------------------------- 画面诊断
  const statsEl = h('div.note', '连接后显示编辑结果的实际帧率与丢帧');
  let statsTimer = null;
  let lastQuality = null;

  function startStats() {
    stopStats();
    lastQuality = null;
    statsTimer = setInterval(() => {
      const remote = remoteContainer.querySelector('video');
      const parts = [];
      if (remote?.getVideoPlaybackQuality && remote.videoWidth) {
        const q = remote.getVideoPlaybackQuality();
        if (lastQuality) {
          const dt = (q.creationTime - lastQuality.t) / 1000;
          const fps = dt > 0 ? (q.totalVideoFrames - lastQuality.total) / dt : 0;
          parts.push(`编辑结果 ${fps.toFixed(1)} fps`, `${remote.videoWidth}×${remote.videoHeight}`, `丢帧 ${q.droppedVideoFrames - lastQuality.dropped}`);
        }
        lastQuality = { t: q.creationTime, total: q.totalVideoFrames, dropped: q.droppedVideoFrames };
        // 直播延迟：播放位置距离 HLS 直播边缘的秒数
        if (hls && Number.isFinite(hls.latency)) parts.push(`延迟 ${hls.latency.toFixed(1)}s`);
      } else parts.push('尚无编辑结果画面');
      statsEl.textContent = parts.join(' · ');
    }, 1000);
  }

  function stopStats() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
  }

  // ---------------------------------------------------------- 操作
  const createBtn = h('button.primary', { type: 'button', onclick: doCreateAndConnect }, '创建直播流并连接');
  const createOnlyBtn = h('button.secondary', { type: 'button', onclick: () => doCreate({ connect: false }) }, '仅创建（不连接、不计费）');
  const hangupBtn = h('button.danger', { type: 'button', disabled: true, onclick: () => teardown('user_hangup') }, '挂断并结束计费');

  const actionBox = card('操作', {},
    h('div.row.wrap', createBtn, createOnlyBtn, hangupBtn),
    h('div.note', '计费提示：实时编辑版每秒 1 积分（0.03125 元），从 conn_init_ack 成功起算，到挂断为止。仅建 WebSocket 或仅入 RTC 频道不计费。余额低于 45 积分无法发起。'),
  );

  // ---------------------------------------------------------- 动作
  async function doCreate({ connect }) {
    let body;
    try {
      body = editor.current();
    } catch (err) {
      toast(err.message, 'err', 5000);
      return null;
    }
    const errors = editor.validate();
    if (errors.length) { toast(errors[0], 'err', 5000); return null; }

    for (const url of body.rtmp_urls || []) {
      if (!url.startsWith('rtmp://')) {
        toast(`RTMP 地址必须以 rtmp:// 开头：${url}`, 'err', 5000);
        return null;
      }
      if (url.length > 2048) {
        toast('单个 RTMP 地址不能超过 2048 字符', 'err', 5000);
        return null;
      }
    }

    if (connect && !asset) {
      toast('请先上传一段视频（≤ 60 秒）', 'err', 5000);
      return null;
    }

    // 转推会话：rtc 凭证只有一份（推流端占用），浏览器没法再入会观看，
    // 所以让 Vidu 把编辑结果转推到本服务器，浏览器通过 HLS 观看。
    if (connect) {
      let relay;
      try {
        const res = await fetch('/relay/create', { method: 'POST' });
        relay = await res.json();
        if (!res.ok) throw new Error(relay.message || `HTTP ${res.status}`);
      } catch (err) {
        toast(`创建转推会话失败：${err.message}`, 'err', 6000);
        return null;
      }
      if (/^(127\.|localhost|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(relay.rtmpHost)) {
        toast(`转推地址是内网地址（${relay.rtmpHost}），Vidu 连不上。请用公网 IP / 域名打开页面，或用 --public-host 指定`, 'err', 9000);
        return null;
      }
      relayKey = relay.key;
      hlsUrl = relay.hlsUrl;
      body = { ...body, rtmp_urls: [...new Set([relay.rtmpUrl, ...(body.rtmp_urls || [])])] };
    }

    const mask = (list) => (list || []).map((u) => u.replace(/\/live\/[0-9a-f]{24}/, '/live/***'));
    saveDraft(DRAFT, { ...body, rtmp_urls: (body.rtmp_urls || []).filter((u) => !relayKey || !u.includes(relayKey)) });
    setPill(httpPill, '创建中…', 'warn');
    log.http('POST /live/s_editing/realtime', { ...body, rtmp_urls: mask(body.rtmp_urls) });

    try {
      const result = await post('/live/s_editing/realtime', body);
      response.show(result.call);
      live = result.data?.live || null;
      rtcInfo = result.data?.rtc || null;
      renderUid = result.data?.render_uid || '';
      clientSecret = result.data?.client_secret || '';
      setPill(httpPill, `已创建 ${live?.id || ''}`, 'ok');
      log.http(`创建成功 live_id=${live?.id} render_uid=${renderUid} ${live?.live_duration ? `最长 ${live.live_duration}s` : ''}`, result.data);
      if (!connect) toast('直播流已创建但未连接（未发 conn_init 不计费）', 'warn', 6000);
      return result.data;
    } catch (err) {
      if (err instanceof ApiError) response.show(err.call);
      setPill(httpPill, '创建失败', 'err');
      log.error(err.message, err.body);
      toast(err.message, 'err', 6000);
      return null;
    }
  }

  async function doCreateAndConnect() {
    createBtn.disabled = true;
    createOnlyBtn.disabled = true;
    try {
      const data = await doCreate({ connect: true });
      if (!data) return;
      // 顺序很重要：必须先让推流端入会并发布输入流，再发 conn_init。
      // 反过来的话渲染服务启动时频道里没有输入，直播会以 LIVE_ENDED 结束。
      const published = await joinRtc();
      if (!published) return;
      await connectWs();
    } catch (err) {
      log.error(err.message);
      toast(err.message, 'err', 6000);
    } finally {
      createBtn.disabled = false;
      createOnlyBtn.disabled = false;
    }
  }

  async function connectWs() {
    const connId = newConnId('edit');
    setPill(wsPill, '连接中…', 'warn');

    // 编辑版用创建返回的 client_secret 建连，有效期与 rtc.token_expire_at 一致
    socket = new LiveSocket({
      url: wsUrl('/live/ws/live/connect', { live_id: String(live.id), conn_id: connId, client_secret: clientSecret }),
      liveId: live.id,
      connId,
      log,
      onSignal: handleSignal,
      onClose: () => {
        setPill(wsPill, '已关闭', 'idle');
        stopBilling();
        switchBtn.disabled = true;
        setSwitchEnabled(false);
        hangupBtn.disabled = true;
      },
    });

    await socket.connect();
    setPill(wsPill, '已连接，发送 conn_init', 'warn');
    await socket.connInit();
    setPill(wsPill, '已就绪', 'ok');
    startBilling();
    // conn_init 成功后 Vidu 才开始转推；观看端 AliRTC 凭证已被推流端占用，改为播放转推的 HLS
    setPill(rtcPill, '等待转推画面…', 'warn');
    startHlsPlayback();
    switchBtn.disabled = false;
    setSwitchEnabled(true);
    hangupBtn.disabled = false;

    // 创建时的参考图作为图库第一项，标记为当前生效
    const initial = editor.current();
    if (initial.image_url) {
      const item = addRef(initial.image_url, `创建时的参考图`);
      activeId = item.id;
      renderGallery();
    }
    if (initial.editing_type) setScene(initial.editing_type);
  }

  async function joinRtc() {
    // 推流端：服务器上的 Chrome 用 rtc 凭证入会，把素材当摄像头 / 麦克风发布
    setPill(rtcPill, '服务器入会中…', 'warn');
    log.rtc('请求服务器推流（转码素材 → 服务器 Chrome 入会并发布）');
    let started;
    try {
      const res = await fetch('/publish/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId: asset.id,
          rtc: rtcInfo,
          bitrate: Number(kbpsInput.value) || undefined,
          // 选了「播完一遍自动挂断」就按素材时长兜底；循环模式不设上限，直到手动挂断
          maxSeconds: loopSelect.value === '1' ? Math.ceil(asset.duration) + 2 : 0,
        }),
      });
      started = await res.json();
      if (!res.ok) throw new Error(started.message || `HTTP ${res.status}`);
    } catch (err) {
      setPill(rtcPill, '服务器推流失败', 'err');
      log.error(`服务器推流失败：${err.message}`);
      toast(`服务器推流失败：${err.message}`, 'err', 8000);
      // 此时还没发 conn_init，不计费；只需把转推会话和服务端推流收掉
      await teardown(null);
      return false;
    }
    log.rtc(`服务器已开始推流：${asset.width}×${asset.height} ${asset.duration}s，${asset.hasAudio ? '含音频' : '静音'}`, started.page);
    startPubPolling();

    setPill(rtcPill, '推流端已入会', 'ok');
    return true;
  }

  /** 转推到达前 HLS 清单是 404，反复重试直到出现，再交给 hls.js 播放。 */
  function startHlsPlayback() {
    stopHls();
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true; video.controls = true; video.muted = true;
    const box = h('div.remote-box', video,
      h('div.remote-label', h('span', '编辑结果'),
        h('button.mini', { type: 'button', onclick: (ev) => { video.muted = !video.muted; ev.target.textContent = video.muted ? '取消静音' : '静音'; } }, '取消静音')));
    clear(remoteContainer).appendChild(box);

    const Hls = window.Hls;
    if (!Hls?.isSupported()) { toast('当前浏览器不支持 hls.js（MSE）', 'err'); return; }
    const started = Date.now();
    const WAIT_LIMIT_MS = 90000;
    let arrived = false;

    const attach = () => {
      try { hls?.destroy(); } catch { /* ignore */ }
      hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5, backBufferLength: 10 });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        arrived = true;
        setPill(rtcPill, '转推已到达', 'ok');
        log.rtc(`转推画面已到达（等待 ${Math.round((Date.now() - started) / 1000)}s）`);
        video.play().catch(() => {});
        startStats();
        if (autoRecBox.checked && !recTimer) startRecording();
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        // 转推还没到达时清单是 404，这是预期情况：隔一秒重新加载，直到出现或超时
        if (!arrived && Date.now() - started < WAIT_LIMIT_MS) {
          setTimeout(() => { if (hls && !arrived) attach(); }, 1000);
          return;
        }
        if (!arrived) {
          log.error(`等待转推画面超时（${WAIT_LIMIT_MS / 1000}s）：${data.details}`);
          setPill(rtcPill, '转推未到达', 'err');
          toast('90 秒内没有收到 Vidu 的转推。请确认服务器 19350 端口对公网开放', 'err', 9000);
          return;
        }
        log.error(`HLS 播放错误：${data.type} / ${data.details}`);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad(); else hls.recoverMediaError();
      });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
    };
    attach();
  }

  function stopHls() {
    try { hls?.destroy(); } catch { /* ignore */ }
    hls = null;
    clear(remoteContainer);
  }

  /** 轮询服务端推流状态，把页面里的日志搬到日志面板；服务端推流意外结束时同步挂断。 */
  function startPubPolling() {
    stopPubPolling();
    let missed = 0;
    pubTimer = setInterval(async () => {
      try {
        const res = await fetch('/publish/status');
        const st = await res.json();
        missed = 0;
        for (const l of st.logs || []) log.rtc(`[推流端] ${l.message}`, l.extra);
        if (!st.running && socket) {
          log.error('服务端推流已结束，自动挂断');
          toast('服务端推流已结束（素材播完或推流端异常），已自动挂断', 'warn', 6000);
          teardown('publish_ended');
        } else if (st.page?.error) {
          log.error(`推流端异常：${st.page.error}`);
        } else if (st.page && st.page.joined === false && socket) {
          log.error('推流端已离会（可能被服务端踢出）');
        }
      } catch (err) {
        if (++missed >= 3) log.error(`无法获取推流状态：${err.message}`);
      }
    }, 2000);
  }

  function stopPubPolling() {
    if (pubTimer) clearInterval(pubTimer);
    pubTimer = null;
  }

  function handleSignal(msg) {
    if (msg.type === SIGNAL.SWITCH_PROMPT_ACK) {
      const ack = msg.payload?.switch_prompt_ack || {};
      const code = ack.error_code;
      toast(`switch_prompt 失败：${code} ${EDIT_WS_ERRORS[code] || ack.error_msg || ''}`, 'err', 8000);
      log.error(`switch_prompt 失败 ${code}`, msg);
    }
    if (msg.type === SIGNAL.FORCE_HANGUP) {
      log.error('服务端强制挂断', msg);
      toast('直播被服务端结束', 'err', 6000);
      teardown(null);
    }
  }

  function doSwitchPrompt() {
    let payload;
    try {
      payload = switchEditor.current();
    } catch (err) { toast(err.message, 'err', 5000); return; }

    if (!payload.prompts?.length && !payload.editing_type) {
      toast('prompts 与 editing_type 至少传其一，都不传该信令无效', 'err', 6000);
      return;
    }
    try {
      socket.send(SIGNAL.SWITCH_PROMPT, { switch_prompt: payload });
      toast('已发送。成功时没有回执，画面数秒内切换；失败才会回 type=14。', 'ok', 5000);
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function startBilling() {
    billingStart = Date.now();
    stopBilling(false);
    billingTimer = setInterval(() => {
      const seconds = Math.floor((Date.now() - billingStart) / 1000);
      setPill(billPill, `计费中 ${seconds}s ≈ ${seconds} 积分`, 'warn');
    }, 1000);
  }

  function stopBilling(reset = true) {
    if (billingTimer) clearInterval(billingTimer);
    billingTimer = null;
    if (reset && billingStart) {
      const seconds = Math.floor((Date.now() - billingStart) / 1000);
      setPill(billPill, `已结束 · 约 ${seconds}s / ${seconds} 积分`, 'idle');
      billingStart = 0;
    }
  }

  async function teardown(reason) {
    if (socket && reason) socket.hangup(reason);
    switchBtn.disabled = true;
    setSwitchEnabled(false);
    stopStats();
    hangupBtn.disabled = true;
    stopBilling();
    socket?.close();
    socket = null;
    stopPubPolling();
    fetch('/publish/stop', { method: 'POST' }).catch(() => {});
    stopHls();
    if (relayKey) {
      // 停止转推会话并收尾录像（服务端 ffmpeg）
      stopRecording().finally(() => fetch(`/relay/${relayKey}/close`, { method: 'POST' }).catch(() => {}));
      relayKey = '';
    }
    setPill(wsPill, '已关闭', 'idle');
    setPill(rtcPill, '已离开', 'idle');
  }

  window.addEventListener('beforeunload', () => {
    if (socket) socket.hangup('user_hangup');
    navigator.sendBeacon?.('/publish/stop');
  });

  const intro = h('div',
    h('h2', 'Vidu S2-Editing 实时编辑模型'),
    h('p', '基于风格、服装、主体及背景参考图，对输入视频流进行实时编辑。你往 RTC 频道推一路视频作为输入，订阅 render_uid 的流拿回编辑结果，还可以同时转推到自有直播平台。'),
    statusBar,
  );

  return createPanelLayout({
    intro,
    left: [actionBox, sourceBox, editor.formElement],
    middle: [editor.element, response.element],
    // 右栏 = 所有实时的东西：编辑结果画面、换图换场景、日志
    right: [mediaBox, statsEl, recBox, liveSwitchBox, switchBox, log.element],
  });
}

const EDIT_WS_ERRORS = {
  NOT_READY: '服务端尚未就绪，稍后重发 conn_init',
  SIP_READY_TIMEOUT: '服务端就绪重试超限，直播已结束，请重新创建',
  LIVE_ENDED: '直播已结束或已被平台关闭，请重新创建',
  LIVE_CONN_INIT_FAILED: '初始化失败，错误未归类',
  SWITCH_PROMPT_INVALID: '参数非法：缺少图片与场景，或图片数量/格式不符合要求',
  LIVE_NOT_ACTIVE: '直播不在进行中（未开播或已结束）',
  RENDER_NOT_READY: '渲染服务未就绪，稍后重试',
  SWITCH_PROMPT_EXPIRED: '信令已过期，请携带新 seq_id 重发',
  RENDER_WRITE_FAILED: '下发渲染服务失败，请重试',
  SWITCH_PROMPT_TIMEOUT: '处理超时，请重试',
  SWITCH_PROMPT_INTERNAL_ERROR: '服务内部错误，持续出现请联系平台并提供 trace_id',
};
