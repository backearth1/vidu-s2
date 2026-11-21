/**
 * AliRTC Web SDK 封装（SDK 由 index.html 用 script 标签加载，全局 window.AliRtcEngine）。
 *
 * 流程与官方 demo 一致：用创建接口返回的 rtc.token（base64 authInfo）入会，
 * 发布本端音视频，订阅远端并渲染。
 *
 * 输入源垫片：S2-Editing 需要往频道里推一路视频作为编辑输入。AliRTC 7.1.9
 * 没有公开的自定义视频源 API（核查过：无 publishCustomVideoStream /
 * setExternalVideoSource / createCustomVideoTrack），所以「本地视频文件」和
 * 「屏幕共享」这两种输入靠临时替换 navigator.mediaDevices.getUserMedia 实现——
 * SDK 照常按摄像头流程走，拿到的是我们喂的轨道。摄像头仍是官方文档背书的默认路径。
 */

export const STREAM_TYPE = { CAMERA: 1, SCREEN: 2 };

export function isSdkLoaded() {
  return typeof window.AliRtcEngine !== 'undefined';
}

/**
 * SDK 给每个远端用户单独建一个 <audio> 播放声音，远端 <video> 的流里没有音轨。
 * 录像想要声音，就得把这些 <audio> 的轨道捞出来。这里钩住 srcObject 的 setter 记录下来。
 */
const seenAudioTracks = new Set();
let audioHooked = false;

function hookAudioElements() {
  if (audioHooked) return;
  audioHooked = true;
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  if (!desc?.set) return;
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    enumerable: desc.enumerable,
    get() { return desc.get.call(this); },
    set(value) {
      if (this.nodeName === 'AUDIO' && value instanceof MediaStream) {
        value.getAudioTracks().forEach((t) => seenAudioTracks.add(t));
        value.addEventListener('addtrack', (ev) => { if (ev.track.kind === 'audio') seenAudioTracks.add(ev.track); });
      }
      return desc.set.call(this, value);
    },
  });
}

/** 当前仍在播放的远端音轨（可能为空：服务端没回音频，或还没订阅到）。 */
export function liveRemoteAudioTracks() {
  for (const t of seenAudioTracks) if (t.readyState === 'ended') seenAudioTracks.delete(t);
  return [...seenAudioTracks];
}

export class RtcSession {
  constructor({ log, remoteContainer, localVideoEl, remoteLabel = '数字人画面' }) {
    this.log = log;
    this.remoteContainer = remoteContainer;
    this.localVideoEl = localVideoEl;
    this.remoteLabel = remoteLabel;
    this.engine = null;
    this.remoteViews = new Map();
    this.joined = false;
  }

  async join(rtc, { publishVideo = true, publishAudio = true } = {}) {
    hookAudioElements();
    if (!isSdkLoaded()) throw new Error('AliRTC Web SDK 未加载，请检查网络能否访问 g.alicdn.com');

    if (!window.isSecureContext || !navigator.mediaDevices) {
      throw new Error(`当前页面不是安全上下文（${location.origin}），浏览器不开放 WebRTC / 媒体设备。请改用 https:// 或 http://localhost 访问`);
    }

    const support = await window.AliRtcEngine.isSupported();
    if (!support.support) {
      throw new Error(`当前浏览器不支持 AliRTC：${support.reason || '未知原因'}`);
    }

    window.AliRtcEngine.setLogLevel(0);
    this.engine = window.AliRtcEngine.getInstance();
    this.bindEvents();

    await this.call('setChannelProfile', 'communication');
    await this.call('setDefaultPublishLocalAudioStream', publishAudio);
    await this.call('setDefaultPublishLocalVideoStream', publishVideo);
    await this.call('setDefaultSubscribeAllRemoteAudioStreams', true);
    await this.call('setDefaultSubscribeAllRemoteVideoStreams', true);

    this.log?.rtc('AliRTC joinChannel', {
      app_id: rtc.app_id,
      channel_id: rtc.channel_id,
      user_id: rtc.user_id,
      token_expire_at: rtc.token_expire_at,
      tokenType: 'base64 authInfo',
    });

    // SDK 直接吃创建接口返回的 base64 token，不需要自己拼 appId/channelId
    await this.engine.joinChannel(rtc.token, rtc.user_id);
    this.joined = true;
    this.log?.rtc('已加入 RTC 频道');

    if (publishVideo) {
      if (this.localVideoEl) await this.call('setLocalViewConfig', this.localVideoEl, STREAM_TYPE.CAMERA);
      await this.call('startPreview', STREAM_TYPE.CAMERA);
      await this.call('publishLocalVideoStream', true);
    }
    if (publishAudio) {
      await this.call('publishLocalAudioStream', true);
    }
  }

  bindEvents() {
    const engine = this.engine;
    engine.on('bye', (code) => this.log?.rtc(`RTC bye code=${code}`));
    engine.on('remoteUserOnLineNotify', (userId) => this.log?.rtc(`远端用户上线 ${userId}`));
    engine.on('remoteUserOffLineNotify', (userId, reason) => {
      this.log?.rtc(`远端用户离线 ${userId} reason=${reason}`);
      this.dropRemote(userId, 'camera');
      this.dropRemote(userId, 'screen');
    });
    engine.on('videoSubscribeStateChanged', (userId, oldState, newState) => {
      this.log?.rtc(`远端摄像头流状态 ${userId}: ${oldState} -> ${newState}`);
      this.handleRemote(userId, 'camera', newState, STREAM_TYPE.CAMERA);
    });
    engine.on('screenShareSubscribeStateChanged', (userId, oldState, newState) => {
      this.log?.rtc(`远端屏幕流状态 ${userId}: ${oldState} -> ${newState}`);
      this.handleRemote(userId, 'screen', newState, STREAM_TYPE.SCREEN);
    });
    engine.on('authInfoWillExpire', () => this.log?.rtc('RTC token 即将过期'));
    engine.on('authInfoExpired', () => this.log?.error('RTC token 已过期，需要重新创建会话'));
  }

  handleRemote(userId, kind, newState, streamType) {
    if (newState === 3) this.showRemote(userId, kind, streamType);
    else if (newState === 1) this.dropRemote(userId, kind);
  }

  showRemote(userId, kind, streamType) {
    const key = `${kind}:${userId}`;
    if (this.remoteViews.has(key) || !this.remoteContainer) return;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.controls = true;
    // 先静音保证自动播放不被拦；标签栏上给用户一个「取消静音」按钮
    video.muted = true;

    const box = document.createElement('div');
    box.className = 'remote-box';

    const label = document.createElement('div');
    label.className = 'remote-label';
    const name = document.createElement('span');
    name.textContent = kind === 'camera' ? this.remoteLabel : '屏幕流';
    name.title = userId;
    label.appendChild(name);

    const unmute = document.createElement('button');
    unmute.className = 'mini';
    unmute.textContent = '取消静音';
    unmute.onclick = () => {
      video.muted = !video.muted;
      unmute.textContent = video.muted ? '取消静音' : '静音';
    };
    label.appendChild(unmute);

    box.appendChild(video);
    box.appendChild(label);
    this.remoteContainer.appendChild(box);

    this.remoteViews.set(key, box);
    this.engine.setRemoteViewConfig(video, userId, streamType);
    video.play().catch((err) => this.log?.rtc('远端画面自动播放被拦截，请点击视频播放', err.message));
    this.log?.rtc(`开始渲染远端 ${kind} 流：${userId}`);
  }

  dropRemote(userId, kind) {
    const key = `${kind}:${userId}`;
    const box = this.remoteViews.get(key);
    if (!box) return;
    try {
      this.engine?.setRemoteViewConfig(null, userId, kind === 'camera' ? STREAM_TYPE.CAMERA : STREAM_TYPE.SCREEN);
    } catch { /* 引擎可能已销毁 */ }
    box.remove();
    this.remoteViews.delete(key);
  }

  async setMicEnabled(enabled) {
    await this.call('publishLocalAudioStream', enabled);
  }

  async setCameraEnabled(enabled) {
    await this.call('publishLocalVideoStream', enabled);
  }

  async call(method, ...args) {
    if (!this.engine || typeof this.engine[method] !== 'function') return undefined;
    const result = await this.engine[method](...args);
    this.log?.rtc(`engine.${method}()`, args.map((a) => (a instanceof Node ? '<element>' : a)));
    return result;
  }

  async leave() {
    for (const key of Array.from(this.remoteViews.keys())) {
      const [kind, userId] = key.split(':');
      this.dropRemote(userId, kind);
    }
    if (this.engine && this.joined) {
      try {
        await this.engine.leaveChannel();
        this.log?.rtc('已离开 RTC 频道');
      } catch (err) {
        this.log?.rtc('leaveChannel 异常', err.message);
      }
    }
    this.joined = false;
    this.engine = null;
  }
}
