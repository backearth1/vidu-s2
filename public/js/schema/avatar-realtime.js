/**
 * POST /live/s_avatar/realtime 的完整字段定义。
 * 取值范围、默认值、枚举全部照搬官方文档（docs/s2-avatar_realtime_parameters.md）。
 */

export const avatarRealtimeSchema = [
  {
    type: 'group', label: '基础', path: '', open: true,
    fields: [
      {
        path: 'model', label: '模型版本', type: 'select', default: 'vidu-s2', always: true,
        options: [
          { value: 'vidu-s2', label: 'vidu-s2（最新，支持 prompt_operation 换参考图）' },
          { value: 'vidu-s1', label: 'vidu-s1（默认，稳定，不支持 prompt_operation）' },
        ],
        doc: '只有 vidu-s2 支持运行时换参考图（持品互动 / 换装 / 换背景）。用 vidu-s1 发 prompt_operation 会回 PROMPT_OP_MODEL_NOT_SUPPORTED。',
      },
      {
        path: 'call_mode', label: '交互方式', type: 'select', default: 'video', always: true,
        options: [
          { value: 'video', label: 'video（音视频，默认）' },
          { value: 'audio', label: 'audio（纯语音）' },
        ],
        doc: 'video 模式下创建成功不代表渲染侧就绪，conn_init 可能先回 NOT_READY，属正常现象。',
      },
      {
        path: 'enable_recording', label: '开启录播', type: 'bool', default: false,
        doc: '为 true 时会话结束后可通过录播查询接口拿 MP4 下载地址（异步生成，通常 2 分钟内，地址有效期 24 小时）。',
      },
      {
        path: 'idle_timeout_seconds', label: '无输入断开时间（秒）', type: 'number', integer: true,
        min: 10, max: 7200, default: 7200,
        doc: '范围 10 ~ 7200 秒，默认 7200。单场会话最长也是 7200 秒，到上限服务端主动关闭。',
      },
    ],
  },

  {
    type: 'group', label: '数字人形象与人设', path: 'avatar', open: true,
    fields: [
      {
        path: 'avatar.persona', label: '人设', type: 'textarea', rows: 5, required: true,
        default: '你是甜甜 Tina，我的声音像温热的奶茶，甜甜的、暖暖的，但解决问题可一点都不含糊哦！',
        doc: '必填，5 万字以内。描述性格、语气、话题范围与表达方式。',
      },
      {
        path: 'avatar.image_uri', label: '形象图片地址', type: 'textarea', rows: 2,
        default: 'https://scene.cf.vidu.studio/media-asset/070302-ZFkgvJxBTM0ZQJoO.png',
        placeholder: 'https://... 或 data:image/png;base64,...',
        doc: '与 avatar.id 二选一。仅支持 1 张【单人】图片，全身/半身、各种风格均可。PNG/JPG/JPEG/WEBP，≤ 50MB；base64 需含 data:image/png;base64, 前缀且解码后 < 20MB。',
      },
      {
        path: 'avatar.id', label: '形象资产 ID', type: 'text',
        placeholder: '在「资产管理 → 形象图片」里创建后得到',
        doc: '与 avatar.image_uri 二选一。用预上传的资产 ID 可以极大缩短创建耗时，推荐反复测试时使用。',
      },
      {
        path: 'avatar.voice', label: '音色', type: 'text', default: 'Tina',
        doc: '不填用默认音色 Tina。可填内置音色 ID 或克隆出来的音色名。生效优先级：voice_model 分支 voice > avatar.voice > 供应商默认。',
      },
      {
        path: 'avatar.greeting_instruction', label: '开场问候语提示词', type: 'textarea', rows: 2,
        doc: '≤ 200 字符。数字人接通后的第一句话由它引导。',
      },
      {
        path: 'avatar.farewell_enabled', label: '自动生成告别视频', type: 'bool', default: false,
        doc: '默认 false。为 true 时结束前会有几秒离开动作视频，需要持续拉 RTC 流才能看到。',
      },
      {
        path: 'avatar.persona_enhance', label: '人设自动优化', type: 'bool', default: false,
        doc: '默认 false。为 true 时服务端会对人设提示词做扩写和优化。',
      },
    ],
  },

  {
    type: 'group', label: '实时语音模型 voice_model', path: 'voice_model', optional: true, open: false,
    doc: '选择实时语音供应商。创建后不可更换。复刻音色与供应商绑定，只能用于同一 provider 的会话。',
    fields: [
      {
        path: 'voice_model.provider', label: '供应商', type: 'select', default: 'qwen_omni', always: true,
        options: [
          { value: 'qwen_omni', label: 'qwen_omni（默认，支持 session_update 热换音色）' },
          { value: 'doubao', label: 'doubao（暂不支持 session_update 换音色）' },
        ],
        doc: '分支必须与 provider 一致：provider=doubao 时只能传 doubao 分支。',
      },
      { path: 'voice_model.qwen.voice', label: 'qwen 分支音色', type: 'text', doc: 'provider=qwen_omni 时生效。' },
      { path: 'voice_model.qwen.language', label: 'qwen 分支语言', type: 'text', doc: '预留字段，本期传入不生效。' },
      { path: 'voice_model.doubao.voice', label: 'doubao 分支音色', type: 'text', doc: 'provider=doubao 时生效。' },
      { path: 'voice_model.doubao.language', label: 'doubao 分支语言', type: 'text', doc: '预留字段，本期传入不生效。' },
    ],
  },

  {
    type: 'group', label: '音频转写 audio', path: 'audio', optional: true, open: false, enabledByDefault: true,
    fields: [
      {
        path: 'audio.enable_transcription', label: '开启转写', type: 'bool', default: true, always: true,
        doc: '默认 false。为 true 时 WebSocket 会多出 type=9（用户说话文本）和 type=10（数字人输出文本）两类事件，右侧面板能看到实时字幕。',
      },
    ],
  },

  {
    type: 'group', label: '打断控制 vad', path: 'vad', optional: true, open: false,
    doc: '控制什么时候算用户说完了一轮、什么时候允许打断数字人。',
    fields: [
      {
        path: 'vad.type', label: '打断策略', type: 'select', default: 'server', always: true,
        options: [
          { value: 'server', label: 'server（默认，过滤附和与背景音）' },
          { value: 'semantic', label: 'semantic（用户一开口就打断）' },
        ],
      },
      {
        path: 'vad.threshold', label: '屏蔽力度', type: 'number', min: 0, max: 1, step: 0.05, default: 0.5,
        doc: '范围 [0, 1.0]，默认 0.5，越低屏蔽越少。仅 vad.type=server 时生效。',
      },
      {
        path: 'vad.silence_duration_ms', label: '静音触发时长（ms）', type: 'number', integer: true,
        min: 200, max: 6000, default: 400,
        doc: '语音结束后静音多久触发响应。范围 [200, 6000]，默认 400。仅 vad.type=server 时生效。',
      },
      {
        path: 'vad.idle_timeout_ms', label: '主动搭话间隔（ms）', type: 'number', integer: true, min: 0, max: 30000, default: 0,
        doc: '静默多久后模型主动发起对话。取 0 或 [500, 30000]，默认 0 表示不主动搭话。',
      },
    ],
  },

  {
    type: 'group', label: '静默小动作 idle_motion', path: 'idle_motion', optional: true, open: false,
    doc: '数字人在非交互状态下自动做的小动作。创建时写入并生效，会话中不可热更新。参数越界会直接 400 且不创建会话。',
    fields: [
      {
        path: 'idle_motion.enabled', label: '启用', type: 'bool', default: true, always: true,
        doc: '对象存在但省略本字段视为 true；显式 false 时其余字段被忽略。',
      },
      {
        path: 'idle_motion.source', label: '动作来源', type: 'select', default: 'default', always: true,
        options: [
          { value: 'default', label: 'default（平台默认动作库）' },
          { value: 'custom', label: 'custom（只用下面的自定义列表）' },
          { value: 'mixed', label: 'mixed（两者合并，同名保留自定义）' },
        ],
      },
      {
        path: 'idle_motion.recommend', label: '挑选方式', type: 'select', default: 'random',
        options: [
          { value: 'random', label: 'random（加权随机）' },
          { value: 'intelligent', label: 'intelligent（按人设与近两轮对话推荐）' },
        ],
      },
      {
        path: 'idle_motion.motions', label: '自定义动作列表', type: 'object-list', itemLabel: '动作', maxItems: 50,
        doc: 'source 为 custom / mixed 时必填且非空，最多 50 条。',
        item: [
          { key: 'name', label: '展示名', type: 'text', required: true, doc: '≤ 200 字符。mixed 下按最终 name 去重。' },
          { key: 'content', label: '执行文本', type: 'textarea', required: true, doc: '1 ~ 200 字符，实际下发给模型的动作描述。' },
          { key: 'weight', label: '权重', type: 'number', min: 0.1, max: 10, step: 0.1, default: 1, doc: '抽取权重，范围 [0.1, 10]，默认 1。' },
          { key: 'description', label: '适用场景', type: 'text', doc: '≤ 100 字符，仅 recommend=intelligent 时起作用。' },
        ],
        default: [{ name: '点头', content: '轻轻点头', weight: 2 }],
      },
      {
        path: 'idle_motion.scheduling.motion_interval', label: '动作间隔（秒）', type: 'number', integer: true,
        min: 5, max: 60, default: 10, doc: '两次动作之间的等待秒数，范围 [5, 60]，默认 10。',
      },
      {
        path: 'idle_motion.scheduling.rest_after_motion', label: '动作后静止（秒）', type: 'number', integer: true,
        min: 1, max: 60, default: 5, doc: '动作后回落静止的等待秒数，范围 [1, 60]，默认 5。',
      },
    ],
  },

  {
    type: 'group', label: '运行时动作匹配 action', path: 'action', optional: true, open: false,
    doc: '是否根据用户发言实时匹配动作。自建动作库在「资产管理 → 动作库」里维护。',
    fields: [
      { path: 'action.enabled', label: '启用动作匹配', type: 'bool', default: true, always: true, doc: '默认 false。省略整个 action 或为 false 则不匹配。' },
      {
        path: 'action.library_id', label: '动作库 ID', type: 'text', default: '0',
        doc: '"0" 或不传表示平台默认库。库不存在返回 400，库不属于本账号返回 403，均不创建会话。',
      },
    ],
  },

  {
    type: 'group', label: '语言模型 llm', path: 'llm', optional: true, open: false,
    fields: [
      { path: 'llm.temperature', label: '创意度 temperature', type: 'number', min: 0, max: 1.999, step: 0.05, default: 0.7, doc: '范围 [0.0, 2.0)，默认 0.7。' },
      { path: 'llm.top_p', label: 'top_p', type: 'number', min: 0.001, max: 1, step: 0.05, default: 0.8, doc: '范围 (0.0, 1.0]，默认 0.8。' },
      { path: 'llm.top_k', label: 'top_k', type: 'number', integer: true, min: 0, max: 100, default: 20, doc: '范围 [0, 100]，默认 20。' },
      { path: 'llm.frequency_penalty', label: '重复惩罚 frequency_penalty', type: 'number', min: 0.001, step: 0.1, default: 1, doc: '范围 > 0。默认 1.0 不惩罚；< 1 鼓励重复；> 1 惩罚重复，越大越不容易嘴瓢。' },
      { path: 'llm.presence_penalty', label: '话题广度 presence_penalty', type: 'number', min: 0, max: 2, step: 0.1, default: 0.3, doc: '范围 [0, 2]，默认 0.3。' },
      { path: 'llm.seed', label: 'seed', type: 'number', integer: true, min: -1, max: 2147483647, default: -1, doc: '范围 0 ~ 2³¹−1，默认 -1 表示随机。' },
      { path: 'llm.max_tokens', label: '最大输出 max_tokens', type: 'number', integer: true, min: 1, max: 65536, default: 50, doc: '范围 1 ~ 64K，默认 50。默认值偏小，想要长回复记得调大。' },
    ],
  },

  {
    type: 'group', label: '记忆检索 memory_retrieval', path: 'memory_retrieval', optional: true, open: false,
    doc: 'provider=vidu 用平台内置长期记忆（在「资产管理 → 记忆」里维护）；provider=self 调你自己的 HTTP 检索服务。',
    fields: [
      { path: 'memory_retrieval.enabled', label: '启用', type: 'bool', default: true, always: true, doc: '默认 false。' },
      {
        path: 'memory_retrieval.provider', label: '来源', type: 'select', default: 'vidu', always: true,
        options: [
          { value: 'vidu', label: 'vidu（平台内置）' },
          { value: 'self', label: 'self（默认，自建 HTTP 服务）' },
        ],
      },
      { path: 'memory_retrieval.user_id', label: '最终用户标识 user_id', type: 'text', default: 'console-user-001', doc: 'provider=vidu 且启用时必填。长度 1~64，记忆按该标识隔离。' },
      { path: 'memory_retrieval.agent_id', label: '记忆分区 agent_id', type: 'text', doc: '可选，最长 64 字符。' },
      { path: 'memory_retrieval.enable_write', label: '自动回写记忆', type: 'bool', default: true, doc: '仅 provider=vidu 有效。true 时把已完成的对话自动写成长期记忆，run_id 用 live_id。' },
      { path: 'memory_retrieval.endpoint', label: '自建服务地址', type: 'text', doc: 'provider=self 时必填。必须是 Vidu 服务端可访问的 http(s) 绝对 URL。' },
      { path: 'memory_retrieval.authorization', label: '自建服务鉴权', type: 'text', doc: 'provider=self 时必填，会作为外部 API 的 Authorization 头转发。' },
      { path: 'memory_retrieval.timeout_ms', label: '超时（ms）', type: 'number', integer: true, min: 1, max: 30000, default: 3000, doc: '最大 30000，仅 provider=self 生效，不传默认 3000。' },
      { path: 'memory_retrieval.tool_instruction', label: '附加工具指令', type: 'textarea', rows: 2, doc: '追加到内置工具说明后，最长 2000 字符。' },
    ],
  },

  {
    type: 'group', label: '知识检索 knowledge_retrieval', path: 'knowledge_retrieval', optional: true, open: false,
    doc: 'provider=vidu 用平台内置知识库（在「资产管理 → 知识库」里维护）；provider=self 调你自己的检索服务。',
    fields: [
      { path: 'knowledge_retrieval.enabled', label: '启用', type: 'bool', default: true, always: true, doc: '默认 false。' },
      {
        path: 'knowledge_retrieval.provider', label: '来源', type: 'select', default: 'vidu', always: true,
        options: [
          { value: 'vidu', label: 'vidu（平台内置）' },
          { value: 'self', label: 'self（默认，自建 HTTP 服务）' },
        ],
      },
      { path: 'knowledge_retrieval.knowledge_base_id', label: '知识库 ID', type: 'text', doc: 'provider=vidu 且启用时必填。引用不存在或已删除的知识库，创建 Live 返回 404。' },
      { path: 'knowledge_retrieval.force_search', label: '强制检索', type: 'bool', default: false, doc: '是否每轮都必然触发知识库检索。' },
      { path: 'knowledge_retrieval.endpoint', label: '自建服务地址', type: 'text', doc: 'provider=self 时必填。' },
      { path: 'knowledge_retrieval.authorization', label: '自建服务鉴权', type: 'text', doc: 'provider=self 时必填。' },
      { path: 'knowledge_retrieval.timeout_ms', label: '超时（ms）', type: 'number', integer: true, min: 1, max: 30000, default: 3000, doc: '最大 30000，仅 provider=self 生效。' },
      { path: 'knowledge_retrieval.tool_instruction', label: '附加工具指令', type: 'textarea', rows: 2, doc: '最长 2000 字符。' },
    ],
  },
];

/** session_update（type=97）可热更新的字段，约束沿用创建时的定义。 */
export const sessionUpdateSchema = [
  {
    type: 'group', label: '可热更新字段', path: '', open: true,
    doc: '服务端整体校验：任一字段非法则本次更新全部不生效。knowledge_retrieval / memory_retrieval 是整组替换，其余字段只传要改的部分。',
    fields: [
      { path: 'avatar.voice', label: '音色', type: 'text', doc: '当前播报结束后生效（无播报时立即）。doubao 供应商暂不支持热换音色。' },
      { path: 'avatar.persona', label: '人设', type: 'textarea', rows: 4, doc: '≤ 5 万字，当前播报结束后生效。' },
      { path: 'vad.type', label: 'vad.type', type: 'select', options: ['server', 'semantic'], default: 'server', doc: '下一轮生效。' },
      { path: 'vad.threshold', label: 'vad.threshold', type: 'number', min: 0, max: 1, step: 0.05, doc: '[0, 1.0]，仅 type=server 生效。' },
      { path: 'vad.silence_duration_ms', label: 'vad.silence_duration_ms', type: 'number', integer: true, min: 200, max: 6000, doc: '[200, 6000] ms，仅 type=server 生效。' },
      { path: 'llm.temperature', label: 'llm.temperature', type: 'number', min: 0, max: 1.999, step: 0.05 },
      { path: 'llm.top_p', label: 'llm.top_p', type: 'number', min: 0.001, max: 1, step: 0.05 },
      { path: 'llm.top_k', label: 'llm.top_k', type: 'number', integer: true, min: 0, max: 100 },
      { path: 'llm.frequency_penalty', label: 'llm.frequency_penalty', type: 'number', min: 0.001, step: 0.1 },
      { path: 'llm.presence_penalty', label: 'llm.presence_penalty', type: 'number', min: 0, max: 2, step: 0.1 },
      { path: 'llm.seed', label: 'llm.seed', type: 'number', integer: true, min: -1, max: 2147483647 },
      { path: 'llm.max_tokens', label: 'llm.max_tokens', type: 'number', integer: true, min: 1, max: 65536 },
      { path: 'memory_retrieval.enabled', label: 'memory_retrieval.enabled', type: 'bool' },
      { path: 'memory_retrieval.endpoint', label: 'memory_retrieval.endpoint', type: 'text' },
      { path: 'memory_retrieval.authorization', label: 'memory_retrieval.authorization', type: 'text' },
      { path: 'memory_retrieval.timeout_ms', label: 'memory_retrieval.timeout_ms', type: 'number', integer: true, max: 30000 },
      { path: 'knowledge_retrieval.enabled', label: 'knowledge_retrieval.enabled', type: 'bool' },
      { path: 'knowledge_retrieval.endpoint', label: 'knowledge_retrieval.endpoint', type: 'text' },
      { path: 'knowledge_retrieval.authorization', label: 'knowledge_retrieval.authorization', type: 'text' },
      { path: 'knowledge_retrieval.timeout_ms', label: 'knowledge_retrieval.timeout_ms', type: 'number', integer: true, max: 30000 },
    ],
  },
];

/** prompt_operation（type=11）换参考图。只有 vidu-s2 支持。 */
export const promptOperationSchema = [
  {
    type: 'group', label: '参数', path: '', open: true,
    doc: '直播中切换或清除数字人画面的参考图，无需中断推流。切换后画面生效需要数秒渲染，期间音频对话不受影响。单条 WebSocket 消息上限 16MB，多张 base64 图会一起计入。',
    fields: [
      {
        path: 'op_type', label: '操作类型', type: 'select', default: 'switch', always: true,
        options: [
          { value: 'switch', label: 'switch（切换参考图，默认）' },
          { value: 'remove', label: 'remove（清除参考图）' },
        ],
        doc: 'remove 不传 images 时清除最近一张；传 images 时按 image_id 定点清除，一次最多 3 张。',
      },
      {
        path: 'images', label: '参考图列表', type: 'object-list', itemLabel: '参考图', maxItems: 3,
        doc: 'switch 时 1~3 张，数组内任一张地址或 image_id 非法则整次操作失败。remove 定点清除时每项只需填 image_id。',
        item: [
          { key: 'image_uri', label: '图片地址 image_uri', type: 'textarea', placeholder: 'https://... 或 ssupload:?id=... 或 data:image/png;base64,...', doc: 'switch 时必填。支持平台上传 URI、base64 data URI、http(s) URL。' },
          { key: 'image_id', label: '稳定标识 image_id', type: 'text', required: true, doc: '1~128 字符，单次操作内不可重复。定点清除时凭它定位，建议跨操作不复用。' },
          {
            key: 'kind', label: '场景类型 kind', type: 'select',
            options: [
              { value: '', label: '（不传，自动识别）' },
              { value: 'object', label: 'object（手持物）' },
              { value: 'garment', label: 'garment（换装）' },
              { value: 'background', label: 'background（换背景）' },
            ],
            doc: '不传时自动识别。若单张图里同时有服饰、物品、背景等多个可能目标，建议显式指定，否则识别结果可能不符合预期。',
          },
          { key: 'user_text', label: '自然语言描述 user_text', type: 'textarea', placeholder: '让数字人手持一个钴蓝色陶瓷杯', doc: '可选，描述期望的画面变化。' },
        ],
        default: [{ image_uri: '', image_id: 'ref-001', kind: 'object', user_text: '' }],
      },
    ],
  },
];
