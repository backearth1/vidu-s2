/**
 * S2-Avatar 组件版。
 *
 * 与实时交互版的根本区别：Vidu 不给你 RTC 频道，而是拿你给的 rtc_info 加入
 * 你自己的频道推数字人画面。对话闭环也在你这边——你自己做 ASR 和 LLM，
 * 通过 WebSocket 把文本发过来驱动口型，音频走二进制帧上行。
 */
import { h, card, toast, statusPill } from '../core/ui.js';
import { post, wsUrl, ApiError } from '../core/api.js';
import { state, loadDraft, saveDraft } from '../core/state.js';
import { createRequestEditor, createResponseView, createPanelLayout, createLogPanel } from '../core/panel.js';
import { LiveSocket, SIGNAL, newConnId } from '../core/ws.js';
import { PcmCapture, PCM_SAMPLE_RATE } from '../core/pcm.js';
import { componentCreateSchema, COMPONENT_AUDIO } from '../schema/avatar-component.js';

const DRAFT = 'avatar-component';

export function avatarComponentView() {
  const log = createLogPanel({ title: '链路日志' });

  let live = null;
  let clientSecret = '';
  let socket = null;
  let capture = null;
  let billingTimer = null;
  let billingStart = 0;
  let framesSent = 0;

  const editor = createRequestEditor({
    schema: componentCreateSchema,
    values: loadDraft(DRAFT) || {},
    title: '创建请求体',
    endpoint: 'POST /live/s_avatar/component',
  });
  const response = createResponseView({ title: '创建响应' });

  const httpPill = statusPill('未创建', 'idle');
  const wsPill = statusPill('未连接', 'idle');
  const audioPill = statusPill('未采集', 'idle');
  const billPill = statusPill('未计费', 'idle');

  const statusBar = h('div.status-bar',
    h('div.status-item', h('span.status-name', 'HTTP'), httpPill),
    h('div.status-item', h('span.status-name', 'WebSocket'), wsPill),
    h('div.status-item', h('span.status-name', '音频上行'), audioPill),
    h('div.status-item', h('span.status-name', '计费'), billPill),
  );

  const setPill = (pill, text, kind) => { pill.textContent = text; pill.className = `pill ${kind}`; };

  // ---------------------------------------------------------- 音频上行
  const frameSelect = h('select', {},
    ...COMPONENT_AUDIO.frames.map((f) => h('option', { value: String(f.ms) }, f.label)),
  );
  const micBtn = h('button', { type: 'button', disabled: true, onclick: toggleCapture }, '开始上行麦克风音频');

  const audioBox = card('音频上行（二进制帧）', {
    hint: `格式由文档写死，不可调：PCM 16-bit 有符号小端 / ${PCM_SAMPLE_RATE} Hz / 单声道 / ${COMPONENT_AUDIO.bytesPerMs} 字节每毫秒。`,
  },
    h('label.field', h('div.field-label', '分帧大小'), frameSelect),
    h('div.row', micBtn),
    h('div.note', '通过 WebSocket BinaryMessage 发送，无 JSON 封装。conn_init 成功回执之前上行的音频帧会被服务端丢弃。'),
  );

  // ---------------------------------------------------------- 文本信令
  const inputText = h('input', { type: 'text', placeholder: '驱动数字人动作的文本，或你的 ASR 识别结果' });
  const inputBtn = h('button', { type: 'button', disabled: true, onclick: () => sendTranscription(SIGNAL.INPUT_TRANSCRIPTION, inputText) }, '发 input_transcription（type=9）');
  const outputText = h('input', { type: 'text', placeholder: '你的 LLM 生成的回复文本' });
  const outputBtn = h('button', { type: 'button', disabled: true, onclick: () => sendTranscription(SIGNAL.OUTPUT_TRANSCRIPTION, outputText) }, '发 output_transcription（type=10）');
  const interruptBtn = h('button.secondary', { type: 'button', disabled: true, onclick: doInterrupt }, '打断（type=7）');
  const hangupBtn = h('button.danger', { type: 'button', disabled: true, onclick: () => teardown('client_hangup') }, '挂断（type=5）');

  const signalBox = card('文本信令', {
    hint: 'type=9 是喂给数字人的输入（驱动动作），type=10 是你的模型生成的回复（驱动口型播报）。content 为空会被忽略。',
  },
    h('div.row', inputText, inputBtn),
    h('div.row', outputText, outputBtn),
    h('div.row.wrap', interruptBtn, hangupBtn),
  );

  // ---------------------------------------------------------- 操作
  const createBtn = h('button.primary', { type: 'button', onclick: doCreateAndConnect }, '创建会话并连接');
  const createOnlyBtn = h('button.secondary', { type: 'button', onclick: () => doCreate({ connect: false }) }, '仅创建（不连接、不计费）');

  const actionBox = card('操作', {},
    h('div.row.wrap', createBtn, createOnlyBtn),
    h('div.note', '计费提示：按秒计费，每秒 1 积分（0.03125 元）。余额低于 45 积分无法发起。'),
    h('div.note', '数字人画面会被推进你自己的 RTC 频道，需要你用对应厂商的 SDK 自行订阅观看，本调试台不代管你的频道。'),
  );

  // ---------------------------------------------------------- 动作
  async function doCreate({ connect }) {
    let body;
    try { body = editor.current(); } catch (err) { toast(err.message, 'err', 5000); return null; }

    const errors = editor.validate();
    if (errors.length) { toast(errors[0], 'err', 5000); return null; }
    if (!body.image_uri && !body.avatar_id) {
      toast('image_uri 与 avatar_id 必须二选一', 'err', 5000);
      return null;
    }
    if (!body.rtc_info?.token) {
      toast('rtc_info.token 必填', 'err', 5000);
      return null;
    }

    saveDraft(DRAFT, body);
    setPill(httpPill, '创建中…', 'warn');
    log.http('POST /live/s_avatar/component', body);

    try {
      const result = await post('/live/s_avatar/component', body);
      response.show(result.call);
      live = result.data?.live || null;
      clientSecret = result.data?.client_secret || '';
      setPill(httpPill, `已创建 ${live?.id || ''}`, 'ok');
      log.http(`创建成功 live_id=${live?.id} status=${live?.status}`, result.data);
      if (!connect) toast('会话已创建但未连接', 'warn', 5000);
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
    } catch (err) {
      log.error(err.message);
      toast(err.message, 'err', 6000);
    } finally {
      createBtn.disabled = false;
      createOnlyBtn.disabled = false;
    }
  }

  async function connectWs() {
    const connId = newConnId('comp');
    setPill(wsPill, '连接中…', 'warn');

    // 组件版走的是另一条 WS 路径：/live/v1/external-lives/{live_id}/stream
    socket = new LiveSocket({
      url: wsUrl(`/live/v1/external-lives/${live.id}/stream`, {
        conn_id: connId,
        client_secret: clientSecret,
        authorization: clientSecret ? undefined : state.apiKey,
      }),
      liveId: live.id,
      connId,
      log,
      onSignal: handleSignal,
      onClose: () => {
        setPill(wsPill, '已关闭', 'idle');
        stopBilling();
        stopCapture();
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

  function handleSignal(msg) {
    if (msg.type === SIGNAL.FORCE_HANGUP) {
      log.error('服务端强制挂断', msg);
      toast('会话被服务端挂断', 'err', 6000);
      teardown(null);
    }
  }

  function sendTranscription(type, input) {
    const content = input.value.trim();
    if (!content) { toast('内容为空会被服务端忽略', 'warn'); return; }
    try {
      socket.send(type, {
        text_msg: { msg_id: `msg-${Date.now()}`, content, timestamp: Date.now() },
      });
      input.value = '';
    } catch (err) { toast(err.message, 'err'); }
  }

  function doInterrupt() {
    try {
      socket.send(SIGNAL.AUDIO_INTERRUPTED, {}, { note: '最佳时机是你的 VAD 检测到用户开口时' });
    } catch (err) { toast(err.message, 'err'); }
  }

  async function toggleCapture() {
    if (capture) { stopCapture(); return; }
    try {
      capture = new PcmCapture({
        frameMs: Number(frameSelect.value),
        log,
        onFrame: (buffer) => {
          if (socket?.sendBinary(buffer)) {
            framesSent += 1;
            if (framesSent % 25 === 0) {
              setPill(audioPill, `上行中 · ${framesSent} 帧`, 'ok');
            }
          }
        },
      });
      await capture.start();
      micBtn.textContent = '停止上行';
      setPill(audioPill, '上行中', 'ok');
    } catch (err) {
      capture = null;
      log.error(`麦克风采集失败：${err.message}`);
      toast(`麦克风采集失败：${err.message}`, 'err', 6000);
    }
  }

  function stopCapture() {
    if (!capture) return;
    capture.stop();
    capture = null;
    framesSent = 0;
    micBtn.textContent = '开始上行麦克风音频';
    setPill(audioPill, '已停止', 'idle');
  }

  function setRuntimeEnabled(enabled) {
    for (const btn of [micBtn, inputBtn, outputBtn, interruptBtn, hangupBtn]) btn.disabled = !enabled;
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

  function teardown(reason) {
    if (socket && reason) socket.hangup(reason);
    setRuntimeEnabled(false);
    stopCapture();
    stopBilling();
    socket?.close();
    socket = null;
    setPill(wsPill, '已关闭', 'idle');
  }

  window.addEventListener('beforeunload', () => {
    if (socket) socket.hangup('client_hangup');
  });

  const intro = h('div',
    h('h2', 'S2-Avatar 组件版（自带 RTC）'),
    h('p', '你提供 RTC 频道凭证，Vidu 加入你的频道推送数字人画面。ASR 与 LLM 由你自己实现：音频走 WebSocket 二进制帧上行，文本用 type=9 / type=10 驱动动作与口型。'),
    statusBar,
  );

  return createPanelLayout({
    intro,
    left: [actionBox, editor.formElement],
    middle: [editor.element, response.element],
    // 右栏 = 所有实时的东西：音频上行、文本信令、日志
    right: [audioBox, signalBox, log.element],
  });
}
