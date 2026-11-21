/**
 * Vidu live WebSocket 信令客户端。
 *
 * 三个实时面板（实时交互 / 组件版 / 实时编辑）共用这一套：外层报文结构
 * { type, live_id, conn_id, seq_id, payload } 是一致的，只是 type 枚举不同。
 *
 * 几个文档里强调、容易踩的点，都在这里兜住了：
 *  - 建连后服务端不会主动说话，必须客户端先发 conn_init，否则永远静默
 *  - 客户端 15 秒内必须有任何消息，否则被判定死连接强制断开
 *  - conn_init 失败回 NOT_READY 时应重试 conn_init，而不是重连 WS
 */

/** 信令类型 -> 可读名。收发都靠它解码展示。 */
export const SIGNAL_NAMES = {
  1: 'conn_init',
  2: 'conn_init_ack',
  5: 'call_hangup',
  6: 'force_hangup',
  7: 'audio_interrupted',
  9: 'input_transcription',
  10: 'output_transcription',
  11: 'prompt_operation',
  12: 'prompt_operation_ack',
  13: 'switch_prompt',
  14: 'switch_prompt_ack',
  97: 'session_update',
  98: 'session_update_ack',
  99: 'text_msg',
};

export const SIGNAL = {
  CONN_INIT: 1,
  CONN_INIT_ACK: 2,
  CALL_HANGUP: 5,
  FORCE_HANGUP: 6,
  AUDIO_INTERRUPTED: 7,
  INPUT_TRANSCRIPTION: 9,
  OUTPUT_TRANSCRIPTION: 10,
  PROMPT_OPERATION: 11,
  PROMPT_OPERATION_ACK: 12,
  SWITCH_PROMPT: 13,
  SWITCH_PROMPT_ACK: 14,
  SESSION_UPDATE: 97,
  SESSION_UPDATE_ACK: 98,
  TEXT_MSG: 99,
};

export function newConnId(prefix = 'conn') {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export class LiveSocket {
  /**
   * @param {object} opts
   * @param {string} opts.url            完整 ws(s) 地址（已含 query）
   * @param {string} opts.liveId
   * @param {string} opts.connId
   * @param {object} opts.log            日志面板
   * @param {(msg)=>void} opts.onSignal  收到任意信令
   * @param {()=>void}   opts.onClose
   */
  constructor({ url, liveId, connId, log, onSignal, onOpen, onClose, onBinary }) {
    this.url = url;
    this.liveId = String(liveId);
    this.connId = connId;
    this.log = log;
    this.onSignal = onSignal;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onBinary = onBinary;
    this.seq = 0;
    this.socket = null;
    this.ready = false;
    this.heartbeatTimer = null;
    this.lastSentAt = 0;
    this.connInitRetries = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.log?.info('建立 WebSocket 连接', { url: this.url.replace(/authorization=[^&]+/, 'authorization=***') });
      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (err) {
        reject(err);
        return;
      }
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      socket.addEventListener('open', () => {
        this.log?.info('WebSocket 已连接。服务端在收到 conn_init 之前不会主动发消息，这是预期行为');
        this.startHeartbeat();
        this.onOpen?.();
        resolve();
      });

      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
          this.onBinary?.(event.data);
          return;
        }
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          this.log?.wsIn('收到非 JSON 文本帧', event.data);
          return;
        }
        const name = SIGNAL_NAMES[msg.type] || `type=${msg.type}`;
        this.log?.wsIn(`${name} (type=${msg.type})`, msg);
        if (msg.type === SIGNAL.CONN_INIT_ACK) {
          this.ready = Boolean(msg.payload?.conn_init_ack?.success);
        }
        this.dispatchExtra(msg);
        this.onSignal?.(msg);
      });

      socket.addEventListener('error', () => {
        this.log?.error('WebSocket 错误。若是 401，检查 API Key 是否匹配当前环境、client_secret 是否过期或属于本场 live');
      });

      socket.addEventListener('close', (event) => {
        this.stopHeartbeat();
        this.ready = false;
        this.log?.info(`WebSocket 已关闭 code=${event.code} reason=${event.reason || '(无)'}`);
        this.onClose?.(event);
        reject(new Error(`WebSocket 关闭：${event.code}`));
      });
    });
  }

  /** 发一条信令，自动补 live_id / conn_id / 自增 seq_id。 */
  send(type, payload = {}, { note } = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接');
    }
    this.seq += 1;
    const msg = {
      type,
      live_id: this.liveId,   // 文档明确：必须是字符串，传数字会出问题
      conn_id: this.connId,
      seq_id: this.seq,
      payload,
    };
    this.socket.send(JSON.stringify(msg));
    this.lastSentAt = Date.now();
    const name = SIGNAL_NAMES[type] || `type=${type}`;
    this.log?.wsOut(`${name} (type=${type})${note ? ' · ' + note : ''}`, msg);
    return msg;
  }

  sendBinary(buffer) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(buffer);
    this.lastSentAt = Date.now();
    return true;
  }

  /**
   * 发 conn_init 并等回执。NOT_READY 是 video 模式下的正常现象（渲染侧还没回连），
   * 按文档做指数退避重试 conn_init 本身，不重连 WS。
   */
  connInit({ version = 1, maxRetries = 8 } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let attempt = 0;

      const onAck = (msg) => {
        if (msg.type !== SIGNAL.CONN_INIT_ACK || settled) return;
        const ack = msg.payload?.conn_init_ack || {};
        if (ack.success) {
          settled = true;
          this.offSignal(onAck);
          this.log?.info('conn_init 成功，直播进入 on_live —— 从这一刻开始计费');
          resolve(ack);
          return;
        }
        const code = ack.error_code || 'UNKNOWN';
        if (code === 'NOT_READY' && attempt < maxRetries) {
          const delay = Math.min(800 * 2 ** attempt, 6000);
          attempt += 1;
          this.log?.info(`conn_init 返回 NOT_READY（渲染侧尚未就绪，属正常现象），${delay}ms 后第 ${attempt} 次重试`);
          setTimeout(() => {
            if (!settled) this.send(SIGNAL.CONN_INIT, { conn_init: { version } });
          }, delay);
          return;
        }
        settled = true;
        this.offSignal(onAck);
        reject(new Error(`conn_init 失败：${code} ${ack.error_msg || ''}`));
      };

      this.onSignalExtra = this.onSignalExtra || [];
      this.onSignalExtra.push(onAck);
      this.send(SIGNAL.CONN_INIT, { conn_init: { version } });

      setTimeout(() => {
        if (!settled) {
          settled = true;
          this.offSignal(onAck);
          reject(new Error('conn_init 超时未收到回执'));
        }
      }, 60000);
    });
  }

  offSignal(fn) {
    if (!this.onSignalExtra) return;
    this.onSignalExtra = this.onSignalExtra.filter((f) => f !== fn);
  }

  /** LiveSocket 内部把额外监听者也派发一遍。 */
  dispatchExtra(msg) {
    for (const fn of this.onSignalExtra || []) fn(msg);
  }

  /** 15 秒静默会被踢，这里 10 秒发一次轻量信令保活。 */
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastSentAt < 10000) return;
      // 浏览器无法主动发 ping 帧；用一条无副作用的信令续期。
      // conn_init 是幂等的，重发只会再拿一次回执，不会重复计费。
      if (this.ready) {
        try {
          this.socket.send(JSON.stringify({
            type: SIGNAL.CONN_INIT,
            live_id: this.liveId,
            conn_id: this.connId,
            seq_id: ++this.seq,
            payload: { conn_init: { version: 1 } },
          }));
          this.lastSentAt = Date.now();
        } catch { /* 连接正在关，无所谓 */ }
      }
    }, 5000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  hangup(reason = 'user_end') {
    try {
      this.send(SIGNAL.CALL_HANGUP, { hangup: { hangup_reason: reason } }, { note: '主动挂断，停止计费' });
    } catch { /* 已经断了 */ }
  }

  close() {
    this.stopHeartbeat();
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      this.socket.close();
    }
    this.socket = null;
    this.ready = false;
  }
}
