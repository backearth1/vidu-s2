/**
 * 麦克风采集 -> 24kHz 单声道 s16le 裸 PCM 分帧。
 *
 * 组件版的 WebSocket 要求上行「PCM 16-bit 有符号小端 / 24000 Hz / 单声道 /
 * 48 字节每毫秒」，建议帧大小 20ms(960B) 或 100ms(4800B)。
 *
 * AudioContext 直接按 24000 采样率开，浏览器会自己做重采样，不用手写。
 * 处理节点用 AudioWorklet（模块代码走 Blob URL，免得多一个文件）。
 */

const WORKLET_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // 拷一份再传，底层 buffer 会被复用
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

export const PCM_SAMPLE_RATE = 24000;
export const PCM_BYTES_PER_MS = 48;

export class PcmCapture {
  /**
   * @param {object} opts
   * @param {number} opts.frameMs   分帧大小，20 或 100
   * @param {(buf: ArrayBuffer)=>void} opts.onFrame
   */
  constructor({ frameMs = 20, onFrame, log } = {}) {
    this.frameMs = frameMs;
    this.onFrame = onFrame;
    this.log = log;
    this.context = null;
    this.stream = null;
    this.node = null;
    this.pending = new Int16Array(0);
    this.running = false;
    this.sentBytes = 0;
  }

  get frameSamples() {
    return (PCM_SAMPLE_RATE * this.frameMs) / 1000;
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    this.context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
    if (this.context.sampleRate !== PCM_SAMPLE_RATE) {
      this.log?.error(`浏览器未采纳 ${PCM_SAMPLE_RATE}Hz，实际 ${this.context.sampleRate}Hz，音频可能变调`);
    }

    const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    await this.context.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'pcm-tap');
    this.node.port.onmessage = (event) => this.consume(event.data);
    source.connect(this.node);
    // 不连到 destination，避免自己听到自己；Worklet 不接输出也会正常 process
    this.running = true;
    this.log?.info(`麦克风采集已启动：${PCM_SAMPLE_RATE}Hz 单声道 s16le，帧长 ${this.frameMs}ms（${this.frameSamples * 2} 字节）`);
  }

  consume(float32) {
    if (!this.running) return;

    // float [-1,1] -> int16 小端
    const converted = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i += 1) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      converted[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    const merged = new Int16Array(this.pending.length + converted.length);
    merged.set(this.pending, 0);
    merged.set(converted, this.pending.length);

    const size = this.frameSamples;
    let offset = 0;
    while (merged.length - offset >= size) {
      const frame = merged.slice(offset, offset + size);
      offset += size;
      this.sentBytes += frame.byteLength;
      this.onFrame?.(frame.buffer);
    }
    this.pending = merged.slice(offset);
  }

  stop() {
    this.running = false;
    this.node?.port && (this.node.port.onmessage = null);
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.context?.close();
    this.node = null;
    this.stream = null;
    this.context = null;
    this.pending = new Int16Array(0);
  }
}
