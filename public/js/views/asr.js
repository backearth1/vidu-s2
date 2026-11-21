/**
 * 语音识别（ASR）：上传视频 / 音频 → 服务端抽音轨 → MiniMax speech_to_text。
 *
 * 文件本体直接 POST 到 /asr/transcribe，服务端用 ffmpeg 转成 16kHz 单声道 mp3，
 * 超过 500 秒会自动切片后顺序识别再拼接。密钥只在服务端（--minimax-key）。
 */
import { h, clear, card, toast, statusPill, copy, jsonBlock } from '../core/ui.js';

const LANGUAGES = [
  { value: 'auto', label: '自动检测' },
  { value: 'zh', label: '中文 zh' },
  { value: 'yue', label: '粤语 yue' },
  { value: 'en', label: '英语 en' },
  { value: 'ja', label: '日语 ja' },
  { value: 'ko', label: '韩语 ko' },
  { value: 'th', label: '泰语 th' },
  { value: 'vi', label: '越南语 vi' },
  { value: 'id', label: '印尼语 id' },
  { value: 'ms', label: '马来语 ms' },
  { value: 'fil', label: '菲律宾语 fil' },
  { value: 'fr', label: '法语 fr' },
  { value: 'de', label: '德语 de' },
  { value: 'es', label: '西班牙语 es' },
  { value: 'it', label: '意大利语 it' },
  { value: 'pt', label: '葡萄牙语 pt' },
  { value: 'pl', label: '波兰语 pl' },
  { value: 'ru', label: '俄语 ru' },
  { value: 'uk', label: '乌克兰语 uk' },
  { value: 'ar', label: '阿拉伯语 ar' },
  { value: 'tr', label: '土耳其语 tr' },
];

const FORMATS = [
  { value: 'text', label: '纯文本' },
  { value: 'timestamped', label: '带时间戳 / 说话人' },
  { value: 'srt', label: 'SRT 字幕' },
  { value: 'vtt', label: 'VTT 字幕' },
];

const MAX_BYTES = 600 * 1024 * 1024;

function clock(sec) {
  const ms = Math.max(0, Math.round(Number(sec || 0) * 1000));
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

function humanSize(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}

function renderText(result, mode) {
  if (!result) return '';
  if (mode === 'srt') return result.srt || '';
  if (mode === 'vtt') return result.vtt || '';
  if (mode === 'timestamped') {
    return (result.segments || [])
      .map((s) => `[${clock(s.start)} → ${clock(s.end)}]${s.speaker ? ` ${s.speaker}:` : ''} ${s.text || ''}`)
      .join('\n');
  }
  return result.text || '';
}

function download(name, content, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function asrView() {
  let file = null;
  let result = null;
  let busy = false;
  let xhr = null;

  // 注意：不用 display:none + input.click()，某些内置浏览器（微信 / 部分手机 WebView）
  // 会拦截对隐藏 input 的程序化点击，表现就是「选了文件没反应」。
  // 这里让 input 透明铺满整个拖拽区，点击就是原生点击，最稳。
  const input = h('input', {
    type: 'file',
    accept: 'video/*,audio/*,.mp4,.mov,.mkv,.webm,.m4v,.avi,.wmv,.flv,.mpeg,.mpg,.ts,.m2ts,.mts,.3gp,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.aiff,.alac',
    style: {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      opacity: '0', cursor: 'pointer', zIndex: '2',
    },
  });

  const status = statusPill('待选择文件', 'idle');
  const fileName = h('div.note', '还没有选择文件');
  const fileMsg = h('div.note');
  const drop = h('div', {
    style: {
      position: 'relative', border: '1px dashed var(--border-2)', borderRadius: '8px', padding: '18px',
      textAlign: 'center', cursor: 'pointer', marginBottom: '10px', color: 'var(--text-2)',
    },
  },
    input,
    h('div', { style: { fontSize: '13px', marginBottom: '4px' } }, '点击选择，或把视频 / 音频拖到这里'),
    h('div', { style: { fontSize: '11.5px', color: 'var(--text-3)' } }, '支持 mp4 / mov / mkv / webm / avi / mts / mp3 / wav / m4a / flac 等；单文件 ≤ 600MB'),
  );

  const language = h('select', {},
    ...LANGUAGES.map((l) => h('option', { value: l.value }, l.label)),
  );
  const format = h('select', { onchange: () => refreshTextarea() }, ...FORMATS.map((f) => h('option', { value: f.value }, f.label)));

  const progress = h('div.progress', h('div.progress-fill'));
  progress.style.display = 'none';
  const progressFill = progress.firstChild;
  const progressText = h('div.note');

  const runBtn = h('button.mini', { type: 'button', onclick: () => start() }, '开始识别');
  const pickBtn = h('button.mini', { type: 'button', onclick: () => input.click() }, '选择文件');
  const cancelBtn = h('button.mini.danger', { type: 'button', onclick: () => { if (xhr) xhr.abort(); } }, '取消上传');
  cancelBtn.style.display = 'none';
  const cancelHint = h('div.note', '选择文件后会自动开始识别；要指定语言，请先选语言再选文件。识别在服务端完成，视频越长等待越久，期间请不要关闭页面。');

  const textarea = h('textarea', { rows: 14, readOnly: true, placeholder: '识别结果会显示在这里' });
  const metaLine = h('div.note');
  const segBox = h('div', { style: { maxHeight: '300px', overflow: 'auto', marginTop: '10px' } });
  const rawBox = h('div');

  const resultCard = card('识别结果', { hint: '字幕时间戳以音轨起点为 0，可直接用于剪辑；说话人标签由 MiniMax 自动分离。' },
    h('div.row.wrap',
      h('span.muted', '显示格式'), format,
      h('button.mini', { type: 'button', onclick: () => refreshTextarea() }, '切换'),
      h('button.mini', { type: 'button', onclick: () => copy(textarea.value, '已复制识别结果') }, '复制'),
      h('button.mini', { type: 'button', onclick: () => download(downloadName('txt'), textarea.value) }, '下载文本'),
      h('button.mini', { type: 'button', onclick: () => result && download(downloadName('srt'), renderText(result, 'srt'), 'application/x-subrip;charset=utf-8') }, '下载 SRT'),
      h('button.mini', { type: 'button', onclick: () => result && download(downloadName('vtt'), renderText(result, 'vtt'), 'text/vtt;charset=utf-8') }, '下载 VTT'),
    ),
    metaLine,
    textarea,
    segBox,
    rawBox,
  );
  resultCard.style.display = 'none';

  function downloadName(ext) {
    const base = (file?.name || 'transcript').replace(/\.[^.]+$/, '').replace(/[^\w一-龥-]+/g, '_').slice(0, 60) || 'transcript';
    return `${base}.${ext}`;
  }

  function refreshTextarea() {
    if (!result) return;
    textarea.value = renderText(result, format.value);
  }

  function fileError(msg) {
    file = null;
    fileName.textContent = '未选择文件';
    fileMsg.className = 'note err';
    fileMsg.textContent = msg;
    status.textContent = '文件不可用';
    status.className = 'pill err';
    runBtn.disabled = true;
    toast(msg, 'err', 6000);
  }

  function setFile(f) {
    if (!f) return;
    fileMsg.className = 'note';
    fileMsg.textContent = '';
    if (f.size > MAX_BYTES) {
      fileError(`文件 ${humanSize(f.size)} 超过 600MB 上限。请先压缩视频，或用 ffmpeg 只导出音轨：ffmpeg -i input.mp4 -vn -ac 1 -ar 16000 out.mp3`);
      return;
    }
    const extOk = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpeg|mpg|ts|m2ts|mts|3gp|mp3|wav|m4a|aac|flac|ogg|opus|aiff|alac)$/i.test(f.name);
    const mimeOk = /^(video|audio)\//.test(f.type);
    // type 为空时（部分系统/浏览器不提供）交给服务端 ffprobe 判断，不在这里卡死
    if (!extOk && !mimeOk && f.type) {
      fileError(`「${f.name}」看起来不是音视频文件（type=${f.type}）。支持 mp4 / mov / mkv / webm / mp3 / wav 等。`);
      return;
    }
    file = f;
    fileName.textContent = `${f.name} · ${humanSize(f.size)}${f.type ? ` · ${f.type}` : ''}`;
    fileMsg.textContent = `已选择 ${f.name}，即将自动开始识别…`;
    status.textContent = '准备识别';
    status.className = 'pill idle';
    runBtn.disabled = false;
    // 选择即开始，避免「选完没反应」；换语言的话先选语言再选文件
    setTimeout(() => { if (file === f && !busy) start(); }, 250);
  }

  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.value = '';
    setFile(f);
  });

  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; });
  }
  for (const ev of ['dragleave', 'drop']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = 'var(--border-2)'; });
  }
  drop.addEventListener('drop', (e) => setFile(e.dataTransfer?.files?.[0]));

  function setBusy(on, text) {
    busy = on;
    runBtn.disabled = on || !file;
    runBtn.textContent = on ? '识别中…' : '开始识别';
    cancelBtn.style.display = on ? '' : 'none';
    if (text) { status.textContent = text; status.className = `pill ${on ? 'warn' : 'idle'}`; }
    progress.style.display = on ? '' : 'none';
    if (!on) progressFill.style.width = '0%';
  }

  function showResult(data) {
    result = data;
    format.value = 'text';
    refreshTextarea();
    const speakers = data.n_speakers ? ` · ${data.n_speakers} 位说话人` : '';
    metaLine.textContent = `时长 ${data.duration.toFixed(2)}s · ${data.segments.length} 句${speakers}`
      + ` · 切片 ${data.chunks} 段 · 音频 ${data.audio.sample_rate}Hz/${data.audio.channels}ch`
      + (data.trace_ids?.length ? ` · trace ${data.trace_ids[0]}` : '');
    metaLine.className = 'note ok';

    clear(segBox);
    if (data.segments.length) {
      segBox.appendChild(h('div.note', '逐句时间戳（可选中复制）：'));
      for (const s of data.segments) {
        segBox.appendChild(h('div.row.wrap',
          h('code', clock(s.start)),
          h('span.muted', '→'),
          h('code', clock(s.end)),
          s.speaker ? h('span.pill.idle', s.speaker) : null,
          h('span', s.text || ''),
        ));
      }
    }

    clear(rawBox);
    rawBox.appendChild(h('details',
      h('summary', '原始 JSON（含 segments / trace_id）'),
      jsonBlock(data),
    ));
    resultCard.style.display = '';
    status.textContent = '识别完成';
    status.className = 'pill ok';
  }

  function start() {
    if (busy) return;
    if (!file) { toast('请先选择文件', 'warn'); return; }
    setBusy(true, '上传中…');
    progressText.className = 'note';
    progressText.textContent = '正在上传…';
    const started = Date.now();
    const params = new URLSearchParams({ name: file.name, language: language.value });
    xhr = new XMLHttpRequest();
    xhr.open('POST', `/asr/transcribe?${params}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `上传 ${pct}%（${humanSize(e.loaded)} / ${humanSize(e.total)}）`;
      if (pct >= 100) {
        setBusy(true, '识别中…');
        progressText.textContent = '已上传，服务端抽音轨并调用 MiniMax…';
      }
    };

    const tick = setInterval(() => {
      if (xhr.readyState !== 4) {
        progressText.textContent = `服务端处理中… ${((Date.now() - started) / 1000).toFixed(0)}s`;
      }
    }, 1000);

    xhr.onload = () => {
      clearInterval(tick);
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* 非 JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && data) {
        progressFill.style.width = '100%';
        progressText.textContent = `完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`;
        showResult(data);
        toast(`识别完成：${data.text.length} 字`, 'ok');
      } else {
        const msg = data?.message || xhr.responseText?.slice(0, 300) || `HTTP ${xhr.status}`;
        progressText.textContent = `失败：${msg}`;
        setBusy(false, '识别失败');
        status.className = 'pill err';
        toast(msg, 'err', 8000);
      }
      setBusy(false);
      runBtn.disabled = !file;
      xhr = null;
    };
    xhr.onerror = () => {
      clearInterval(tick);
      progressText.textContent = '网络错误：请求没有到达服务端';
      setBusy(false, '网络错误');
      status.className = 'pill err';
      toast('网络错误，请检查服务是否在运行', 'err');
      xhr = null;
    };
    xhr.onabort = () => {
      clearInterval(tick);
      progressText.textContent = '已取消上传';
      setBusy(false, '已取消');
      status.className = 'pill idle';
      xhr = null;
    };
    xhr.send(file);
  }

  const uploadCard = card('上传视频 / 音频', {
    hint: '视频不需要先转音频，服务端会用 ffmpeg 抽 16kHz 单声道音轨（ASR 只接受音频流）。超过 500 秒会自动切片。',
    actions: status,
  },
    drop,
    fileName,
    fileMsg,
    h('div.row.wrap',
      pickBtn,
      h('span.muted', '语言'), language,
      h('span.muted', '显示'), format,
      runBtn,
      cancelBtn,
    ),
    progress,
    progressText,
    cancelHint,
  );

  const howCard = card('说明', { collapsible: true, open: false },
    h('ul.md', { style: { margin: 0, paddingLeft: '20px', color: 'var(--text-2)' } },
      h('li', '接口：POST /v1/speech_to_text（MiniMax），模型 asr-1.0，服务端以 Bearer Key 调用。'),
      h('li', '单个音频上限 500 秒 / 50MB；这里转码成 64kbps mp3，长视频按 480 秒切片后合并时间戳。'),
      h('li', '说话人分离：verbose_json 自动返回 speaker 标签，无需额外开关。'),
      h('li', '识别结果只在内存里返回，不落盘；音频临时文件随请求结束删除。'),
      h('li', 'MiniMax Key 与 Vidu Key 不通用；服务端未配置时接口会直接报错。'),
    ),
  );

  // 服务端有没有配 MiniMax Key，提前告诉用户，省得传完文件才报错
  fetch('/bootstrap').then((r) => r.json()).then((d) => {
    if (d && d.minimaxConfigured === false) {
      progressText.textContent = '提示：服务端未配置 MiniMax API Key，识别会返回 400。请用 --minimax-key / MINIMAX_API_KEY 启动服务。';
      progressText.className = 'note err';
    }
  }).catch(() => {});

  return h('div.panel',
    h('div.panel-intro',
      h('h2', '语音识别 ASR'),
      h('p', '上传一段视频或音频，服务端抽音轨后调用 MiniMax speech_to_text，输出文字、逐句时间戳、说话人标签，并可导出 SRT / VTT 字幕。'),
    ),
    h('div.panel-cols',
      h('div.col.col-wide', uploadCard, howCard),
      h('div.col.col-right', resultCard),
    ),
  );
}
