/** POST /ent/s_avatar/offline —— 非实时数字人，异步出 MP4。 */

export const offlineCreateSchema = [
  {
    type: 'group', label: '素材与内容', path: '', open: true,
    fields: [
      {
        path: 'model', label: '模型', type: 'select', default: 'vidu-s2', always: true,
        options: [
          { value: 'vidu-s2', label: 'vidu-s2（默认）' },
          { value: 'vidu-s1', label: 'vidu-s1' },
        ],
        doc: '默认 vidu-s2。旧版文档默认是 vidu-s1。',
      },
      {
        path: 'image', label: '角色图片', type: 'textarea', rows: 2, required: true,
        default: 'https://scene.vidu.zone/media-asset/084945-xpk47RWYcBgJ27nJ.png',
        doc: '必填，仅支持 1 张【单人】图片。两种形式任选：公网 URL、base64（须含 data:image/png;base64, 前缀）。当前参数页已不再列 ssupload:?id= 形式。人脸/人体检测不通过任务会失败。',
      },
      {
        path: 'audio', label: '语音音频', type: 'textarea', rows: 2,
        default: 'https://scene.vidu.zone/media-asset/085244-FrJjNf5tKjiZHQkf.mp3',
        doc: '与 text 至少传一个，两者都传时以 audio 为准。支持 URL / base64。',
      },
      {
        path: 'text', label: '说话文本', type: 'textarea', rows: 3,
        doc: '与 audio 至少传一个。UTF-8，≤ 10000 字符。传 text 时系统合成语音，按合成时长计费（约 2-3 字/秒）。',
      },
      {
        path: 'voice', label: '音色', type: 'text', placeholder: 'female-shaonv',
        doc: '仅 text 模式（未传 audio）生效。传了 audio 再设 voice 不会有效果。',
      },
      {
        path: 'resolution', label: '分辨率', type: 'select', default: '720p',
        options: [
          { value: '720p', label: '720P（默认）' },
          { value: '1080p', label: '1080P' },
          { value: '2k', label: '2K' },
        ],
        doc: '默认 720P，可选 1080P / 2K。官方表格写作 720P/1080P/2K，请求示例用小写 720p；若 2K 报 FieldInvalid，可改试 2K。',
      },
    ],
  },
  {
    type: 'group', label: '水印与透传', path: '', open: false,
    fields: [
      {
        path: 'watermark', label: '加水印', type: 'bool', default: true,
        doc: '不传默认加水印。加了之后查询接口的 watermarked_url 才有值；要无水印视频取 url 字段。显式传 false 时 watermarked_url 为空。',
      },
      {
        path: 'wm_position', label: '合规标识位置', type: 'select', default: 'bottom_right',
        options: ['top_left', 'top_right', 'bottom_left', 'bottom_right'],
        doc: '仅 watermark=true 时生效，控制「内容由 AI 生成」标识的位置。Vidu 品牌水印固定在右下角，不受此字段影响。',
      },
      { path: 'wm_url', label: '自定义水印图 URL', type: 'text' },
      {
        path: 'callback_url', label: '回调地址', type: 'text', placeholder: 'https://api.example.com/vidu/callback',
        doc: '任务状态变化时 POST 过来，请求体与查询接口返回一致。采用 HMAC-SHA256 签名，业务侧应校验签名后再信任内容。',
      },
      {
        path: 'payload', label: '透传参数 payload', type: 'text', placeholder: 'biz-order-20260903-001',
        doc: '原样返回，常用于关联业务订单号。',
      },
      {
        path: 'meta_data', label: '透传元数据 meta_data', type: 'text', placeholder: '{"Label":"your_label"}',
        doc: 'JSON 格式字符串。为空时使用 Vidu 生成的默认元数据标识。',
      },
    ],
  },
];

/** 时间轴示例：直接粘贴到输入框即可改。视线只看镜头或产品，商品讲解表情克制不轻易微笑。 */
export const TIMELINE_EXAMPLE = `{
  "actions": [
    { "text": "直视镜头，右手轻抬到胸口，头部轻点打招呼，表情自然", "time_range": [0, 5] },
    { "text": "左手把产品举到胸前，右手食指轻指产品，眉毛微扬，视线保持看向镜头", "time_range": [5, 10] },
    { "text": "双手在胸前做展示手势，表情专注，头部微微侧倾，目光始终看向镜头", "time_range": [10, 15] },
    { "text": "右手轻拍胸口强调，身体略前倾，眼神真诚，说到关键词时点头", "time_range": [15, 20] },
    { "text": "左手缓慢转动产品展示侧面，表情认真，右手自然下垂，视线保持看向镜头", "time_range": [20, 25] },
    { "text": "双手放下自然交叠，直视镜头点头致意收尾", "time_range": [25, 30] }
  ]
}`;

/**
 * timeline 动作时间轴。文档反复强调：它是序列化后的 JSON **字符串**，不是对象。
 * 整个面板只有这一个输入框：用户手填，或由「AI 生成」/「填入示例」写进同一个框，
 * 提交前统一序列化。noToggle 去掉字段前的「传不传」勾选框（空 = 不传）。
 */
export const timelineSchema = [
  {
    path: 'raw', label: '时间轴 JSON', type: 'textarea', rows: 12, noToggle: true,
    placeholder: TIMELINE_EXAMPLE,
    doc: '可选：留空 = 不传 timeline，由系统基于音频自动生成动作。可粘贴 {"actions":[...]} 或 actions 数组；每项含 text 与 time_range（两个整数秒），相邻动作首尾相接、不要重叠，建议每段 ≥5 秒。',
  },
];

export const TASK_STATES = {
  created: { label: '已创建', terminal: false },
  queueing: { label: '排队中', terminal: false },
  processing: { label: '处理中', terminal: false },
  success: { label: '成功', terminal: true },
  failed: { label: '失败', terminal: true },
};
