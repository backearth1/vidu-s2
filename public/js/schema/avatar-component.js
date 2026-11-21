/** POST /live/s_avatar/component —— 组件版：你自带 RTC 频道，Vidu 把数字人推进来。 */

export const componentCreateSchema = [
  {
    type: 'group', label: '基础', path: '', open: true,
    fields: [
      {
        path: 'model', label: '模型版本', type: 'select', default: 'vidu-s2', always: true,
        options: [
          { value: 'vidu-s2', label: 'vidu-s2（最新，灰度测试中）' },
          { value: 'vidu-s1', label: 'vidu-s1（默认，稳定，不支持 prompt_operation）' },
        ],
      },
      {
        path: 'image_uri', label: '形象图片地址', type: 'textarea', rows: 2,
        placeholder: 'https://example.com/avatar.jpg 或 data:image/png;base64,...',
        doc: '与 avatar_id 二选一。仅支持 1 张【单人】图片，PNG/JPG/JPEG/WEBP，≤ 50MB；base64 解码后 < 20MB 且需含内容类型前缀。',
      },
      {
        path: 'avatar_id', label: '形象资产 ID', type: 'text',
        doc: '与 image_uri 二选一，在「资产管理 → 形象图片」里预上传可显著缩短创建耗时。',
      },
    ],
  },
  {
    type: 'group', label: '你的 RTC 频道 rtc_info', path: 'rtc_info', open: true,
    doc: '必填。Vidu 会拿这组凭证加入你的频道并推送数字人画面。目前支持阿里 artc、腾讯 trtc、声网 agora、火山引擎 volcengine。',
    fields: [
      {
        path: 'rtc_info.provider', label: '供应商', type: 'select', default: 'artc', required: true,
        options: [
          { value: 'artc', label: 'artc（阿里云 RTC）' },
          { value: 'trtc', label: 'trtc（腾讯云 TRTC）' },
          { value: 'agora', label: 'agora（声网）' },
          { value: 'volcengine', label: 'volcengine（火山引擎）' },
        ],
      },
      { path: 'rtc_info.app_id', label: 'app_id', type: 'text', doc: 'RTC 应用 ID。provider=artc 时可不填（与服务端配置一致时）。' },
      { path: 'rtc_info.channel_id', label: 'channel_id', type: 'text', doc: 'RTC 频道 ID。token 内已包含时可省略。' },
      { path: 'rtc_info.user_id', label: 'user_id', type: 'text', doc: '数字人推流用的用户 ID。token 内已包含时可省略。' },
      {
        path: 'rtc_info.token', label: 'token', type: 'textarea', rows: 3, required: true,
        doc: '必填。ARTC Base64 Token / TRTC UserSig / Agora Token / 火山 RTC AccessToken。',
      },
    ],
  },
];

/**
 * 组件版 WebSocket 上行音频参数。文档写死的，不可调，这里只用于展示与校验。
 * 编码 PCM s16le / 24000 Hz / 单声道 / 48 字节每毫秒。
 */
export const COMPONENT_AUDIO = {
  sampleRate: 24000,
  channels: 1,
  bytesPerMs: 48,
  frames: [
    { label: '20ms（960 字节，推荐）', ms: 20 },
    { label: '100ms（4800 字节）', ms: 100 },
  ],
};
