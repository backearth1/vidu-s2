/**
 * S2-Avatar 实时交互模型面板。
 *
 * 完整链路：
 *   POST /live/s_avatar/realtime  ->  WS /live/ws/live/connect  ->  AliRTC joinChannel
 * 三条链路缺一不可：HTTP 只是拿凭证，WS 管控制信令，RTC 管音视频。
 */
import { h, clear, card, field, toast, jsonBlock, statusPill } from '../core/ui.js';
import { post, wsUrl, ApiError } from '../core/api.js';
import { state, loadDraft, saveDraft } from '../core/state.js';
import { createRequestEditor, createResponseView, createPanelLayout, createLogPanel } from '../core/panel.js';
import { createMediaStage } from '../core/media.js';
import { buildForm } from '../core/form.js';
import { LiveSocket, SIGNAL, newConnId } from '../core/ws.js';
import { RtcSession, isSdkLoaded } from '../core/rtc.js';
import { avatarRealtimeSchema, sessionUpdateSchema, promptOperationSchema } from '../schema/avatar-realtime.js';
import { voicePicker } from './voice-picker.js';

const DRAFT = 'avatar-realtime';

export function avatarRealtimeView() {
  const log = createLogPanel({ title: '链路日志' });

  let live = null;
  let rtcInfo = null;
  let socket = null;
  let rtc = null;
  let billingTimer = null;
  let billingStart = 0;

  // ---------------------------------------------------------- 创建表单
  const editor = createRequestEditor({
    schema: avatarRealtimeSchema,
    values: loadDraft(DRAFT) || {},
    title: '创建请求体',
    endpoint: 'POST /live/s_avatar/realtime',
  });
  const response = createResponseView({ title: '创建响应' });

  // ---------------------------------------------------------- 状态栏
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

  function setPill(pill, text, kind) {
    pill.textContent = text;
    pill.className = `pill ${kind}`;
  }

  // ---------------------------------------------------------- 媒体
  const stage = createMediaStage({
    title: '数字人画面',
    localLabel: '我的摄像头',
    localHint: '本端预览默认隐藏，只影响显示不影响推流——video 模式下摄像头照常发布给数字人。',
    placeholder: '等待数字人画面…\n创建会话并完成 AliRTC 入会后，订阅到的远端流会显示在这里',
  });
  const localVideo = stage.localVideo;
  const remoteContainer = stage.remoteContainer;
  const mediaBox = stage.element;

  // ---------------------------------------------------------- 字幕
  const transcriptList = h('div.transcript');
  const transcriptBox = card('实时字幕', {
    hint: '需要在创建时开启 audio.enable_transcription；type=9 是你说的，type=10 是数字人说的',
    actions: h('button.mini', { type: 'button', onclick: () => clear(transcriptList) }, '清空'),
  }, transcriptList);

  function pushTranscript(who, text) {
    if (!text) return;
    transcriptList.appendChild(h(`div.bubble.${who}`,
      h('span.bubble-who', who === 'user' ? '用户' : '数字人'),
      h('span.bubble-text', text),
    ));
    transcriptList.scrollTop = transcriptList.scrollHeight;
  }

  // ---------------------------------------------------------- 运行时控制
  const textInput = h('input', { type: 'text', placeholder: '发送文本给数字人（type=99 text_msg）' });
  const sendTextBtn = h('button', { type: 'button', disabled: true, onclick: doSendText }, '发送文本');
  const interruptBtn = h('button.secondary', { type: 'button', disabled: true, onclick: doInterrupt }, '打断（type=7）');
  const micBtn = h('button.secondary', { type: 'button', disabled: true, onclick: toggleMic }, '静音麦克风');
  const camBtn = h('button.secondary', { type: 'button', disabled: true, onclick: toggleCam }, '关闭摄像头');
  const hangupBtn = h('button.danger', { type: 'button', disabled: true, onclick: () => teardown('user_end') }, '挂断并结束计费');
  let micOn = true;
  let camOn = true;

  const runtimeBox = card('运行时控制', { hint: '会话进行中可用。挂断后才停止计费。' },
    h('div.row', textInput, sendTextBtn),
    h('div.row.wrap', interruptBtn, micBtn, camBtn, hangupBtn),
  );

  // ---------------------------------------------------------- session_update
  const sessionForm = buildForm(sessionUpdateSchema, { values: {} });
  const sessionSendBtn = h('button.primary', { type: 'button', disabled: true, onclick: doSessionUpdate }, '发送 session_update（type=97）');
  const sessionBox = card('会话热更新 session_update', {
    hint: '无需挂断重建即可改音色、人设、vad、llm、检索配置。整体校验：任一字段非法则本次全部不生效。',
    collapsible: true, open: false,
  }, sessionForm.element, sessionSendBtn,
    h('div.note', '需要先创建会话并连接后才能发送。勾选要更新的字段即可，不勾的保持原值。'));

  // ---------------------------------------------------------- prompt_operation
  const promptEditor = createRequestEditor({
    schema: promptOperationSchema,
    values: {},
    title: '换参考图请求体',
    endpoint: 'WS type=11 prompt_operation',
    transform: (raw) => {
      const out = { op_type: raw.op_type || 'switch' };
      const images = (raw.images || []).map((img) => {
        const item = {};
        if (img.image_uri) item.image_uri = img.image_uri;
        if (img.image_id) item.image_id = img.image_id;
        if (img.kind) item.kind = img.kind;
        if (img.user_text) item.user_text = img.user_text;
        return item;
      }).filter((i) => Object.keys(i).length);
      // remove 且不传 images = 清除最近一张，这是文档定义的合法用法
      if (images.length) out.images = images;
      return out;
    },
  });
  const promptSendBtn = h('button.primary', { type: 'button', disabled: true, onclick: doPromptOperation }, '发送 prompt_operation（type=11）');

  /** 三个场景的快捷预设：填好 kind 和示例描述，保留已填的图片地址。 */
  function applyPreset(kind, sampleText) {
    let cur = {};
    try { cur = promptEditor.current(); } catch { /* 原始 JSON 有语法错就从空开始 */ }
    const first = (cur.images || [])[0] || {};
    promptEditor.apply({
      op_type: 'switch',
      images: [{
        image_uri: first.image_uri || '',
        image_id: first.image_id || `ref-${Date.now().toString(36)}`,
        kind,
        user_text: sampleText,
      }],
    });
    toast(`已套用「${PRESET_LABELS[kind]}」预设，填入参考图地址后发送`, 'ok', 4000);
  }

  const presetRow = h('div.row.wrap',
    h('button.mini', { type: 'button', onclick: () => applyPreset('object', '让数字人拿起这个物品并介绍') }, '持品互动'),
    h('button.mini', { type: 'button', onclick: () => applyPreset('garment', '让数字人换上这件衣服') }, '换装'),
    h('button.mini', { type: 'button', onclick: () => applyPreset('background', '把背景换成参考图中的场景') }, '换背景'),
    h('button.mini', {
      type: 'button',
      onclick: () => {
        promptEditor.apply({ op_type: 'remove' });
        toast('已切到「清除最近一张参考图」，直接发送即可', 'ok', 4000);
      },
    }, '清除参考图'),
  );

  const promptHelp = h('div.note', '需要先创建会话并连接（conn_init 成功）后才能发送。仅 vidu-s2 模型支持，vidu-s1 会返回 PROMPT_OP_MODEL_NOT_SUPPORTED。');

  const promptBox = card('换参考图 prompt_operation', {
    hint: '这就是文档里的持品互动 / 换装 / 换背景能力：直播中换参考图，无需中断推流，画面数秒内切换。',
  }, presetRow, promptEditor.formElement, promptEditor.element, promptSendBtn, promptHelp);

  // ---------------------------------------------------------- 操作按钮
  const createBtn = h('button.primary', { type: 'button', onclick: doCreateAndConnect }, '创建会话并连接');
  const createOnlyBtn = h('button.secondary', { type: 'button', onclick: () => doCreate({ connect: false }) }, '仅创建（不连接、不计费）');

  const actionBox = card('操作', {
    hint: '「仅创建」只做 HTTP 调用，用来核对参数与响应；不发 conn_init 就不会计费。',
  },
    h('div.row.wrap', createBtn, createOnlyBtn),
    h('div.note', '计费提示：实时交互版每 2 秒 3 积分（约 0.094 元），从 conn_init_ack 成功那一刻起算，到挂断为止。账户余额低于 45 积分无法发起。'),
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
    if (errors.length) {
      toast(errors[0], 'err', 5000);
      return null;
    }
    if (!body.avatar?.image_uri && !body.avatar?.id) {
      toast('avatar.image_uri 与 avatar.id 必须二选一', 'err', 5000);
      return null;
    }

    saveDraft(DRAFT, body);
    setPill(httpPill, '创建中…', 'warn');
    log.http('POST /live/s_avatar/realtime', body);

    try {
      const result = await post('/live/s_avatar/realtime', body);
      response.show(result.call);
      live = result.data?.live || null;
      rtcInfo = result.data?.rtc || null;
      setPill(httpPill, `已创建 ${live?.id || ''}`, 'ok');
      log.http(`创建成功 live_id=${live?.id} status=${live?.status} 最长 ${live?.live_duration}s`, result.data);
      if (!connect) {
        toast('会话已创建但未连接。注意：未发 conn_init 不计费，但会占用并发额度，记得在「资产管理 → Live 管理」里确认状态。', 'warn', 7000);
      }
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
      await connectWs();
      await joinRtc();
    } catch (err) {
      log.error(err.message);
      toast(err.message, 'err', 6000);
    } finally {
      createBtn.disabled = false;
      createOnlyBtn.disabled = false;
    }
  }

  async function connectWs() {
    const connId = newConnId('app');
    setPill(wsPill, '连接中…', 'warn');

    socket = new LiveSocket({
      // 浏览器无法给 WebSocket 设请求头，API Key 走 query，由本地代理转成 Authorization
      url: wsUrl('/live/ws/live/connect', { live_id: String(live.id), conn_id: connId, authorization: state.apiKey }),
      liveId: live.id,
      connId,
      log,
      onSignal: handleSignal,
      onClose: () => {
        setPill(wsPill, '已关闭', 'idle');
        stopBilling();
        setRuntimeEnabled(false);
      },
    });

    await socket.connect();
    setPill(wsPill, '已连接，发送 conn_init', 'warn');

    await socket.connInit();
    setPill(wsPill, '已就绪', 'ok');
    startBilling();
    setRuntimeEnabled(true);
  }

  async function joinRtc() {
    if (!isSdkLoaded()) {
      setPill(rtcPill, 'SDK 未加载', 'err');
      log.error('AliRTC Web SDK 未加载，无法进行音视频。请检查能否访问 g.alicdn.com');
      return;
    }
    setPill(rtcPill, '入会中…', 'warn');
    rtc = new RtcSession({ log, remoteContainer, localVideoEl: localVideo });
    const isVideo = (live?.call_mode || 'video') === 'video';
    try {
      await rtc.join(rtcInfo, { publishVideo: isVideo, publishAudio: true });
      setPill(rtcPill, '已入会', 'ok');
    } catch (err) {
      setPill(rtcPill, '入会失败', 'err');
      log.error(`AliRTC 入会失败：${err.message}`);
      toast(`AliRTC 入会失败：${err.message}`, 'err', 6000);
    }
  }

  function handleSignal(msg) {
    switch (msg.type) {
      case SIGNAL.INPUT_TRANSCRIPTION:
        pushTranscript('user', msg.payload?.text_msg?.content || msg.payload?.content);
        break;
      case SIGNAL.OUTPUT_TRANSCRIPTION:
        pushTranscript('bot', msg.payload?.text_msg?.content || msg.payload?.content);
        break;
      case SIGNAL.FORCE_HANGUP: {
        const reason = msg.payload?.hangup?.hangup_reason || 'unknown';
        log.error(`服务端强制挂断：${reason}（${HANGUP_REASONS[reason] || '未知原因'}）`);
        toast(`会话被服务端挂断：${HANGUP_REASONS[reason] || reason}`, 'err', 8000);
        teardown(null);
        break;
      }
      case SIGNAL.PROMPT_OPERATION_ACK: {
        const ack = msg.payload?.prompt_operation_ack || {};
        if (ack.success) {
          toast('换参考图成功，画面将在数秒内切换', 'ok');
        } else {
          const code = ack.error_code;
          toast(`换参考图失败：${code} ${PROMPT_OP_ERRORS[code] || ack.error_msg || ''}`, 'err', 8000);
        }
        break;
      }
      case SIGNAL.SESSION_UPDATE_ACK: {
        const ack = msg.payload?.session_update_ack || {};
        toast(ack.success ? 'session_update 已生效' : `session_update 失败：${ack.error_code} ${ack.error_msg || ''}`, ack.success ? 'ok' : 'err', 6000);
        break;
      }
      default:
        break;
    }
  }

  function doSendText() {
    const content = textInput.value.trim();
    if (!content) { toast('请先输入文本', 'warn'); return; }
    try {
      socket.send(SIGNAL.TEXT_MSG, {
        text_msg: { msg_id: `msg-${Date.now()}`, content, timestamp: Date.now() },
      });
      pushTranscript('user', content);
      textInput.value = '';
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function doInterrupt() {
    try {
      socket.send(SIGNAL.AUDIO_INTERRUPTED, {}, { note: '打断当前 AI 输出' });
      toast('已发送打断信令（该信令无独立回执）', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function doSessionUpdate() {
    const payload = sessionForm.collect();
    if (!Object.keys(payload).length) {
      toast('请至少勾选并填写一个要更新的字段', 'warn');
      return;
    }
    const errors = sessionForm.validate();
    if (errors.length) { toast(errors[0], 'err', 5000); return; }
    try {
      socket.send(SIGNAL.SESSION_UPDATE, { session_update: payload });
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function doPromptOperation() {
    let payload;
    try {
      payload = promptEditor.current();
    } catch (err) {
      toast(err.message, 'err', 5000);
      return;
    }
    if (payload.op_type === 'switch' && !payload.images?.length) {
      toast('switch 操作至少需要 1 张参考图', 'err', 5000);
      return;
    }
    if (payload.op_type === 'switch' && payload.images.some((i) => !i.image_uri)) {
      toast('switch 时每张参考图都必须填 image_uri', 'err', 5000);
      return;
    }
    const ids = (payload.images || []).map((i) => i.image_id);
    if (new Set(ids).size !== ids.length) {
      toast('同一次操作内 image_id 不能重复', 'err', 5000);
      return;
    }
    try {
      socket.send(SIGNAL.PROMPT_OPERATION, { prompt_operation: payload });
      toast('已发送，等待 type=12 回执', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function toggleMic() {
    micOn = !micOn;
    await rtc?.setMicEnabled(micOn);
    micBtn.textContent = micOn ? '静音麦克风' : '恢复麦克风';
  }

  async function toggleCam() {
    camOn = !camOn;
    await rtc?.setCameraEnabled(camOn);
    camBtn.textContent = camOn ? '关闭摄像头' : '开启摄像头';
  }

  function setRuntimeEnabled(enabled) {
    for (const btn of [sendTextBtn, interruptBtn, micBtn, camBtn, hangupBtn, sessionSendBtn, promptSendBtn]) {
      btn.disabled = !enabled;
    }
  }

  function startBilling() {
    billingStart = Date.now();
    stopBilling(false);
    billingTimer = setInterval(() => {
      const seconds = Math.floor((Date.now() - billingStart) / 1000);
      // 文档：每 2 秒 3 积分，时长不能被 2 整除时向上取整
      const credits = Math.ceil(seconds / 2) * 3;
      setPill(billPill, `计费中 ${seconds}s ≈ ${credits} 积分`, 'warn');
    }, 1000);
  }

  function stopBilling(reset = true) {
    if (billingTimer) clearInterval(billingTimer);
    billingTimer = null;
    if (reset && billingStart) {
      const seconds = Math.floor((Date.now() - billingStart) / 1000);
      setPill(billPill, `已结束 · 约 ${seconds}s / ${Math.ceil(seconds / 2) * 3} 积分`, 'idle');
      billingStart = 0;
    }
  }

  async function teardown(reason) {
    if (socket && reason) socket.hangup(reason);
    setRuntimeEnabled(false);
    stopBilling();
    // 文档建议：先关 WebSocket，再 leaveChannel
    socket?.close();
    socket = null;
    await rtc?.leave();
    rtc = null;
    setPill(wsPill, '已关闭', 'idle');
    setPill(rtcPill, '已离开', 'idle');
  }

  window.addEventListener('beforeunload', () => {
    if (socket) socket.hangup('user_end');
  });

  // ---------------------------------------------------------- 组装
  const intro = h('div',
    h('h2', 'Vidu S2-Avatar 实时交互模型'),
    h('p', '支持实时语音交互、复杂动作控制，并可结合参考图完成物品互动、服装更换和背景切换。接入需要三条链路并行：HTTP 创建拿凭证 → WebSocket 收发控制信令 → AliRTC 收发音视频。'),
    statusBar,
  );

  return createPanelLayout({
    intro,
    left: [
      actionBox,
      voicePicker({
        title: '音色速查',
        onPick: (voiceId) => {
          editor.apply({ ...editor.current(), avatar: { ...editor.current().avatar, voice: voiceId } });
          toast(`已填入音色 ${voiceId}`, 'ok');
        },
      }),
      editor.formElement,
    ],
    middle: [editor.element, response.element],
    // 右栏 = 所有实时的东西：画面、字幕、运行时信令、日志
    right: [mediaBox, runtimeBox, transcriptBox, promptBox, sessionBox, log.element],
  });
}

const PRESET_LABELS = {
  object: '持品互动',
  garment: '换装',
  background: '换背景',
};

const HANGUP_REASONS = {
  user_end: '用户主动断开',
  timeout: '会话超时',
  audit_violation: '触发风控',
  credit_insufficient: '积分不足',
  sip_closed: 'SIP / provider 侧关闭',
  provider_closed: 'provider 主动关闭',
  sip_reconnect_timeout: 'SIP 断连超过重连宽限',
  client_reconnect_timeout: '客户端断线超过重连宽限',
  prepared_sip_disconnected: '未开播时 SIP 断开',
  owner_taken_over: 'owner 被其他节点接管',
  owner_lease_lost: 'owner 续租失败',
  ai_output_closed: 'AI 输出通道关闭',
  external: '服务端广播关闭',
};

const PROMPT_OP_ERRORS = {
  PROMPT_OP_PARAM_INVALID: '参数不合法（images 缺失或超 3 张、image_uri 格式不支持、image_id 为空/超长/重复）',
  PROMPT_OP_MODEL_NOT_SUPPORTED: '当前直播不是 vidu-s2 模型，不支持换参考图',
  PROMPT_OP_LIVE_NOT_ACTIVE: '直播不在进行中',
  PROMPT_OP_IMAGE_TRANSFER_FAILED: '参考图获取失败，地址可能不可访问',
  PROMPT_OP_SIP_NOT_CONNECTED: '渲染链路未就绪，稍后重试',
  PROMPT_OP_FAILED: '其他内部错误',
};
