/** POST /live/s_editing/realtime —— S2-Editing 实时编辑模型。 */

export const EDITING_TYPES = [
  { value: 'style_transfer', label: 'style_transfer（整体风格迁移，默认）' },
  { value: 'virtual_tryon', label: 'virtual_tryon（虚拟试穿）' },
  { value: 'subject_replacement', label: 'subject_replacement（主体替换）' },
  { value: 'background_replacement', label: 'background_replacement（背景替换）' },
];

export const editingCreateSchema = [
  {
    type: 'group', label: '创建编辑直播流', path: '', open: true,
    doc: '创建成功后直播进入 waiting，需要完成 WebSocket 连接与 RTC 入会才开播。计费从 conn_init_ack 成功那一刻起算，每秒 1 积分。',
    fields: [
      {
        path: 'image_url', label: '编辑参考图', type: 'textarea', rows: 2, required: true,
        placeholder: 'https://example.com/reference.png',
        doc: '必填。支持三种形式：平台上传 URI（ssupload:?id=...）、base64 data URI（data:image/*;base64,...）、http(s) URL。缺失或格式不支持会返回 400。',
      },
      {
        path: 'editing_type', label: '编辑场景', type: 'select', default: 'style_transfer', always: true,
        options: EDITING_TYPES,
        doc: '决定参考图怎么用：迁移画面风格、换人物服装、替换人物主体、还是换背景环境。取值不在枚举内返回 400。',
      },
      {
        path: 'rtmp_urls', label: 'RTMP 转推地址', type: 'string-list', itemLabel: '地址', maxItems: 5,
        placeholder: 'rtmp://push.example.com/live/stream1',
        doc: '可选，最多 5 个，每项必须以 rtmp:// 开头且不超过 2048 字符。传入后开播时把合成结果单路转推到这些地址。同一地址不可同时用于多条直播，直播结束后约 10 秒内不可复用。转推启动失败会直接结束直播。',
      },
    ],
  },
];

/** switch_prompt（type=13）：直播中换图 / 换场景。 */
export const switchPromptSchema = [
  {
    type: 'group', label: '参数', path: '', open: true,
    doc: 'prompts 与 editing_type 至少传其一，可同时传；都不传该信令无效。成功时服务端不返回任何回执，画面数秒内切换；失败才会收到 type=14。服务端不去重，重复发送会重复触发切换。',
    fields: [
      {
        path: 'prompts', label: '参考图', type: 'object-list', itemLabel: '参考图', maxItems: 1,
        doc: '最多 1 个且必须为 type=image。不传时沿用最近一次的参考图（即「只换场景不换图」）。注意 WebSocket 单条消息上限 16MB，用 base64 时留意帧大小。',
        item: [
          { key: 'type', label: 'type', type: 'select', options: ['image'], default: 'image', required: true },
          { key: 'content', label: '图片地址 content', type: 'textarea', required: true, placeholder: 'https://example.com/new-reference.png', doc: '支持平台上传 URI、base64 data URI、http(s) URL，格式与创建时的 image_url 一致。' },
        ],
      },
      {
        path: 'editing_type', label: '编辑场景', type: 'select', options: [{ value: '', label: '（不传，沿用当前场景）' }, ...EDITING_TYPES],
        doc: '不传时沿用最近一次传入的场景；仅传 prompts 即为「只换图不换场景」。',
      },
    ],
  },
];
