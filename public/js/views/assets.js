/**
 * 资产管理：实时/非实时面板要引用的各种 ID 都从这里来。
 *
 * 覆盖 形象图片 / 音色 / 动作库 / 记忆 / 知识库 / Live 管理 六组接口。
 * 每个操作都是一张卡：填参数 -> 发请求 -> 原样看响应。
 */
import { h, clear, card, toast, jsonBlock, copy } from '../core/ui.js';
import { request, ApiError } from '../core/api.js';
import { state, persist } from '../core/state.js';
import { createLogPanel } from '../core/log.js';
import { createResponseView } from '../core/panel.js';
import { voicePicker } from './voice-picker.js';

export function assetsView() {
  const log = createLogPanel({ title: '调用日志' });
  const response = createResponseView({ title: '响应' });

  /**
   * 一个可执行的接口操作。
   * @param {object} spec
   * @param {string} spec.label
   * @param {string} spec.method
   * @param {(v)=>string} spec.path   由表单值生成路径
   * @param {Array} spec.fields       [{key,label,type,doc,required,default,placeholder,rows}]
   * @param {(v)=>object} [spec.body] 由表单值生成请求体；不给就是无 body
   * @param {(v)=>object} [spec.query]
   * @param {(data)=>void} [spec.onSuccess]
   */
  function operation(spec) {
    const inputs = {};
    const rows = [];

    for (const f of spec.fields || []) {
      let el;
      if (f.type === 'textarea') el = h('textarea', { rows: f.rows || 3, placeholder: f.placeholder || '', value: f.default ?? '' });
      else if (f.type === 'number') el = h('input', { type: 'number', value: f.default ?? '', placeholder: f.placeholder || '' });
      else if (f.type === 'bool') el = h('input', { type: 'checkbox', checked: Boolean(f.default) });
      else if (f.type === 'select') el = h('select', {}, ...f.options.map((o) => {
        const value = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return h('option', { value, selected: value === f.default }, label);
      }));
      else el = h('input', { type: 'text', value: f.default ?? '', placeholder: f.placeholder || '' });

      inputs[f.key] = { el, spec: f };
      rows.push(h('label.field',
        h('div.field-label', h('span', f.label), f.required ? h('span.req', '必填') : null),
        el,
        f.doc ? h('div.field-doc', f.doc) : null,
      ));
    }

    function values() {
      const out = {};
      for (const [key, { el, spec: f }] of Object.entries(inputs)) {
        if (f.type === 'bool') out[key] = el.checked;
        else if (f.type === 'number') out[key] = el.value === '' ? undefined : Number(el.value);
        else out[key] = el.value.trim() === '' ? undefined : el.value.trim();
      }
      return out;
    }

    const runBtn = h('button', { type: 'button', onclick: run }, spec.runLabel || '发送请求');
    const resultBox = h('div.op-result');

    async function run() {
      const v = values();
      for (const f of spec.fields || []) {
        if (f.required && (v[f.key] === undefined || v[f.key] === '')) {
          toast(`${f.label} 是必填项`, 'err', 4000);
          return;
        }
      }
      runBtn.disabled = true;
      try {
        const path = spec.path(v);
        const body = spec.body ? spec.body(v) : undefined;
        const query = spec.query ? spec.query(v) : undefined;
        log.http(`${spec.method} ${path}`, body);
        const result = await request(spec.method, path, { body, query });
        response.show(result.call);
        clear(resultBox).appendChild(jsonBlock(result.data));
        spec.onSuccess?.(result.data, v);
        toast(`${spec.label} 成功`, 'ok');
      } catch (err) {
        if (err instanceof ApiError) response.show(err.call);
        clear(resultBox).appendChild(jsonBlock(err.body ?? err.message));
        log.error(err.message, err.body);
        toast(err.message, 'err', 6000);
      } finally {
        runBtn.disabled = false;
      }
    }

    return card(spec.label, {
      hint: spec.hint,
      collapsible: true,
      open: spec.open === true,
      actions: h('code.endpoint', `${spec.method} ${spec.endpointLabel || ''}`),
    }, ...rows, h('div.row', runBtn), resultBox);
  }

  // ------------------------------------------------------ 形象图片资产
  const avatarSection = h('div.section',
    h('h3', '形象图片资产　/live/v1/avatars'),
    h('p.section-doc', '把形象图片预上传成资产，拿到 id 后在创建会话时用 avatar.id 传入，能极大节省创建耗时。图片 90 天后自动删除。'),
    operation({
      label: '创建形象资产', method: 'POST', endpointLabel: '/live/v1/avatars', open: true,
      path: () => '/live/v1/avatars',
      fields: [
        { key: 'image_uri', label: 'image_uri', type: 'textarea', required: true, placeholder: 'https://example.com/avatar.png 或 data:image/png;base64,...', doc: '仅支持 1 张【单人】图片，全身/半身、各种风格均可。PNG/JPG/JPEG/WEBP，≤ 50MB；base64 解码后 < 20MB 且需含内容类型前缀。' },
        { key: 'name', label: 'name', type: 'text', doc: '可选展示名。' },
      ],
      body: (v) => ({ image_uri: v.image_uri, ...(v.name ? { name: v.name } : {}) }),
      hint: '首次创建会异步生成图片描述，status 走 created(1) → processing(6) → success(11)；failed(12) 是终态需重建。重复提交同一张图会新建记录并直接复用已有描述。',
      onSuccess: (data) => {
        if (data?.id) {
          state.lastAvatarId = data.id;
          persist();
          toast(`资产 ID ${data.id} 已记住，可在实时面板 avatar.id 里使用`, 'ok', 6000);
        }
      },
    }),
    operation({
      label: '查询单个形象资产', method: 'GET', endpointLabel: '/live/v1/avatars/{id}',
      path: (v) => `/live/v1/avatars/${v.id}`,
      fields: [{ key: 'id', label: '资产 ID', type: 'text', required: true }],
    }),
    operation({
      label: '形象资产列表', method: 'GET', endpointLabel: '/live/v1/avatars',
      path: () => '/live/v1/avatars',
      fields: [
        { key: 'page', label: 'pager.page', type: 'number', default: 0, doc: '页码，从 0 开始，默认 0。' },
        { key: 'pagesz', label: 'pager.pagesz', type: 'number', default: 10, doc: '每页数量，默认 10，最大 100。' },
      ],
      query: (v) => ({ 'pager.page': v.page ?? 0, 'pager.pagesz': v.pagesz ?? 10 }),
    }),
    operation({
      label: '删除形象资产', method: 'DELETE', endpointLabel: '/live/v1/avatars/{id}',
      path: (v) => `/live/v1/avatars/${v.id}`,
      fields: [{ key: 'id', label: '资产 ID', type: 'text', required: true }],
      hint: '已引用该资产的内容不受影响。删除成功返回空对象。',
    }),
  );

  // ------------------------------------------------------ 音色
  const voiceSection = h('div.section',
    h('h3', '音色　/live/v1/voices'),
    h('p.section-doc', '音色克隆每次 899 积分（约 28 元），每个客户前十次免费。复刻出的音色与供应商绑定，只能用于同一 voice_model.provider 的会话。'),
    operation({
      label: '克隆音色', method: 'POST', endpointLabel: '/live/v1/voices/clone',
      path: () => '/live/v1/voices/clone',
      fields: [
        { key: 'audio_url', label: 'audio_url', type: 'textarea', required: true, placeholder: 'https://example.com/reference.wav 或 data URI', doc: '必填。WAV(16bit)/MP3/M4A，时长推荐 10~20 秒最长 60 秒，文件 < 10MB，长度 1~2048。' },
        { key: 'voice', label: 'voice（音色名）', type: 'text', required: true, placeholder: 'my_custom_voice', doc: '必填，长度 1~16，仅允许数字、大小写字母和下划线。音色名不要重复。创建 live 时填入 avatar.voice。' },
        { key: 'text', label: 'text', type: 'textarea', doc: '可选，参考音频对应的文本，便于服务端校验一致性，最长 4096。' },
        { key: 'language', label: 'language', type: 'text', default: 'zh', doc: '可选，如 zh / en / ja / ko，最长 16。中文方言可填 Sichuan、Dongbei、Henan 等。' },
        {
          key: 'provider', label: 'provider', type: 'select', default: 'qwen_omni',
          options: ['qwen_omni', 'doubao'],
          doc: '复刻音色与供应商绑定。使用国外服务时 doubao 不支持复刻。',
        },
      ],
      body: (v) => ({
        audio_url: v.audio_url, voice: v.voice,
        ...(v.text ? { text: v.text } : {}),
        ...(v.language ? { language: v.language } : {}),
        ...(v.provider ? { provider: v.provider } : {}),
      }),
      hint: '⚠️ 这个接口会扣 899 积分（前十次免费），点之前确认参数无误。',
    }),
    operation({
      label: '我的自定义音色列表', method: 'GET', endpointLabel: '/live/v1/voices',
      path: () => '/live/v1/voices', fields: [],
      hint: '返回 { "voices": [{ "voice": "my_custom_voice" }] }。这个接口只读不计费，很适合用来验证 API Key 是否可用。',
    }),
    operation({
      label: '删除自定义音色', method: 'DELETE', endpointLabel: '/live/v1/voices/{voice}',
      path: (v) => `/live/v1/voices/${encodeURIComponent(v.voice)}`,
      fields: [{ key: 'voice', label: '音色名', type: 'text', required: true }],
    }),
    voicePicker({ title: '内置音色列表（717 个，点击复制 ID）' }),
  );

  // ------------------------------------------------------ 动作库
  const actionSection = h('div.section',
    h('h3', '动作库　/live/v1/action-libraries'),
    h('p.section-doc', '自建动作库供创建会话时用 action.library_id 绑定。每账号最多 20 个库，每库最多 100 条动作。同一用户下多个 API Key 共用一套库。'),
    operation({
      label: '创建动作库', method: 'POST', endpointLabel: '/live/v1/action-libraries',
      path: () => '/live/v1/action-libraries',
      fields: [
        { key: 'name', label: 'name', type: 'text', required: true, placeholder: '默认手势库', doc: '1~50 字符，同账号未删除范围内唯一。重名或超配额返回 400。' },
        { key: 'description', label: 'description', type: 'text', doc: '≤ 200 字符，可空。' },
      ],
      body: (v) => ({ name: v.name, ...(v.description ? { description: v.description } : {}) }),
    }),
    operation({
      label: '动作库列表', method: 'GET', endpointLabel: '/live/v1/action-libraries',
      path: () => '/live/v1/action-libraries',
      fields: [
        { key: 'page', label: 'pager.page', type: 'number', default: 0 },
        { key: 'pagesz', label: 'pager.pagesz', type: 'number', default: 10 },
      ],
      query: (v) => ({ 'pager.page': v.page ?? 0, 'pager.pagesz': v.pagesz ?? 10 }),
      hint: '创建时间倒序，只含本账号未删除的库。',
    }),
    operation({
      label: '动作库详情', method: 'GET', endpointLabel: '/live/v1/action-libraries/{id}',
      path: (v) => `/live/v1/action-libraries/${v.id}`,
      fields: [{ key: 'id', label: '库 ID', type: 'text', required: true }],
      hint: '他人的库或不存在的库均返回 404。',
    }),
    operation({
      label: '修改动作库', method: 'PATCH', endpointLabel: '/live/v1/action-libraries/{id}',
      path: (v) => `/live/v1/action-libraries/${v.id}`,
      fields: [
        { key: 'id', label: '库 ID', type: 'text', required: true },
        { key: 'name', label: 'name', type: 'text' },
        { key: 'description', label: 'description', type: 'text' },
      ],
      body: (v) => ({ ...(v.name ? { name: v.name } : {}), ...(v.description ? { description: v.description } : {}) }),
    }),
    operation({
      label: '删除动作库', method: 'DELETE', endpointLabel: '/live/v1/action-libraries/{id}',
      path: (v) => `/live/v1/action-libraries/${v.id}`,
      fields: [{ key: 'id', label: '库 ID', type: 'text', required: true }],
      hint: '库内动作一并删除；进行中的会话不受影响。',
    }),
    operation({
      label: '新增动作', method: 'POST', endpointLabel: '/live/v1/action-libraries/{id}/actions',
      path: (v) => `/live/v1/action-libraries/${v.id}/actions`,
      fields: [
        { key: 'id', label: '库 ID', type: 'text', required: true },
        { key: 'name', label: '动作 name', type: 'text', required: true, placeholder: '挥手', doc: '1~20 字符，库内未删除范围内唯一。' },
        { key: 'description', label: '动作 description', type: 'textarea', required: true, placeholder: '双手向镜头挥手打招呼', doc: '请求侧 5~500 字符。服务端会同步改写后再入库，改写后仍校验 5~500；改写失败则不入库，可重发同一请求重试。' },
      ],
      body: (v) => ({ name: v.name, description: v.description }),
      hint: '这个接口是同步改写后入库的，常见耗时数秒。',
    }),
    operation({
      label: '动作列表 / 详情', method: 'GET', endpointLabel: '/live/v1/action-libraries/{id}/actions[/{action_id}]',
      path: (v) => `/live/v1/action-libraries/${v.id}/actions${v.action_id ? '/' + v.action_id : ''}`,
      fields: [
        { key: 'id', label: '库 ID', type: 'text', required: true },
        { key: 'action_id', label: '动作 ID（留空则列表）', type: 'text' },
      ],
      hint: '可以在这里查看服务端改写后的 description。',
    }),
    operation({
      label: '修改动作', method: 'PATCH', endpointLabel: '/live/v1/action-libraries/{id}/actions/{action_id}',
      path: (v) => `/live/v1/action-libraries/${v.id}/actions/${v.action_id}`,
      fields: [
        { key: 'id', label: '库 ID', type: 'text', required: true },
        { key: 'action_id', label: '动作 ID', type: 'text', required: true },
        { key: 'name', label: 'name', type: 'text', doc: '改 name 不触发改写。' },
        { key: 'description', label: 'description', type: 'textarea', doc: '改 description 会先走改写，失败则原记录不变。' },
      ],
      body: (v) => ({ ...(v.name ? { name: v.name } : {}), ...(v.description ? { description: v.description } : {}) }),
    }),
    operation({
      label: '删除动作', method: 'DELETE', endpointLabel: '/live/v1/action-libraries/{id}/actions/{action_id}',
      path: (v) => `/live/v1/action-libraries/${v.id}/actions/${v.action_id}`,
      fields: [
        { key: 'id', label: '库 ID', type: 'text', required: true },
        { key: 'action_id', label: '动作 ID', type: 'text', required: true },
      ],
    }),
  );

  // ------------------------------------------------------ 记忆
  const memorySection = h('div.section',
    h('h3', '长期记忆　/live/v1/memories'),
    h('p.section-doc', '平台内置长期记忆，供 memory_retrieval.provider=vidu 使用。按 API Key 所属账号隔离。记忆正文由系统从对话中自动提取，一次请求可能产生多条，也可能一条都不产生（results 为空数组）。'),
    operation({
      label: '创建记忆（从对话提取）', method: 'POST', endpointLabel: '/live/v1/memories',
      path: () => '/live/v1/memories',
      fields: [
        { key: 'user_id', label: 'user_id', type: 'text', required: true, default: 'console-user-001', doc: '必填，长度 1~64。记忆按该标识隔离。' },
        { key: 'messages', label: 'messages（JSON 数组）', type: 'textarea', rows: 6, required: true, doc: '必填，至少一条，元素含 role 和 content。', default: JSON.stringify([{ role: 'user', content: '我叫阿澈，常用 Go 开发，喜欢简洁的代码风格' }, { role: 'assistant', content: '好的，我记住了' }], null, 2) },
        { key: 'agent_id', label: 'agent_id', type: 'text', doc: '可选记忆分区，最长 64。' },
        { key: 'run_id', label: 'run_id', type: 'text', doc: '可选会话/运行标识。会话自动回写时用 live_id。' },
        { key: 'metadata', label: 'metadata（JSON 对象）', type: 'textarea', rows: 2, doc: '可选，业务自定义元数据。' },
      ],
      body: (v) => ({
        user_id: v.user_id,
        messages: JSON.parse(v.messages),
        ...(v.agent_id ? { agent_id: v.agent_id } : {}),
        ...(v.run_id ? { run_id: v.run_id } : {}),
        ...(v.metadata ? { metadata: JSON.parse(v.metadata) } : {}),
      }),
    }),
    operation({
      label: '搜索记忆', method: 'POST', endpointLabel: '/live/v1/memories/search',
      path: () => '/live/v1/memories/search',
      fields: [
        { key: 'query', label: 'query', type: 'text', required: true, default: '用户叫什么，常用什么语言', doc: '必填，非空自然语言查询。' },
        { key: 'user_id', label: 'user_id', type: 'text', required: true, default: 'console-user-001' },
        { key: 'agent_id', label: 'agent_id', type: 'text' },
        { key: 'run_id', label: 'run_id', type: 'text' },
        { key: 'limit', label: 'limit', type: 'number', default: 5 },
      ],
      body: (v) => ({
        query: v.query, user_id: v.user_id,
        ...(v.agent_id ? { agent_id: v.agent_id } : {}),
        ...(v.run_id ? { run_id: v.run_id } : {}),
        ...(v.limit ? { limit: v.limit } : {}),
      }),
      hint: '返回 { "results": [带 score 的记忆对象] }。',
    }),
    operation({
      label: '记忆列表', method: 'POST', endpointLabel: '/live/v1/memories/list',
      path: () => '/live/v1/memories/list',
      fields: [
        { key: 'user_id', label: 'user_id', type: 'text', required: true, default: 'console-user-001' },
        { key: 'agent_id', label: 'agent_id', type: 'text' },
        { key: 'run_id', label: 'run_id', type: 'text' },
        { key: 'page', label: 'page', type: 'number', default: 1 },
        { key: 'page_size', label: 'page_size', type: 'number', default: 20 },
      ],
      body: (v) => ({
        user_id: v.user_id,
        ...(v.agent_id ? { agent_id: v.agent_id } : {}),
        ...(v.run_id ? { run_id: v.run_id } : {}),
        page: v.page ?? 1, page_size: v.page_size ?? 20,
      }),
    }),
    operation({
      label: '删除用户记忆', method: 'DELETE', endpointLabel: '/live/v1/memories?user_id=',
      path: () => '/live/v1/memories',
      fields: [
        { key: 'user_id', label: 'user_id', type: 'text', required: true, doc: '必填，清空该用户范围内的记忆。' },
        { key: 'agent_id', label: 'agent_id', type: 'text', doc: '可选，按附加范围删除。' },
        { key: 'run_id', label: 'run_id', type: 'text' },
      ],
      query: (v) => ({
        user_id: v.user_id,
        ...(v.agent_id ? { agent_id: v.agent_id } : {}),
        ...(v.run_id ? { run_id: v.run_id } : {}),
      }),
      hint: '成功返回空对象。删除后该 user_id 释放记忆用户配额。',
    }),
  );

  // ------------------------------------------------------ 知识库
  const knowledgeSection = h('div.section',
    h('h3', '知识库　/live/v1/knowledge-bases'),
    h('p.section-doc', '平台内置知识库，供 knowledge_retrieval.provider=vidu 使用。默认每账号最多 100 个知识库，每库最多 1000 个文档。创建 Live 时只校验知识库存在且属于当前账号，不校验里面有没有文档。'),
    operation({
      label: '创建知识库', method: 'POST', endpointLabel: '/live/v1/knowledge-bases',
      path: () => '/live/v1/knowledge-bases',
      fields: [{ key: 'name', label: 'name', type: 'text', placeholder: '产品 FAQ', doc: '可选，去除首尾空格后最长 256 字符。' }],
      body: (v) => ({ ...(v.name ? { name: v.name } : {}) }),
      hint: '同步创建并完成索引，实测耗时约 2 秒。',
    }),
    operation({
      label: '知识库列表', method: 'GET', endpointLabel: '/live/v1/knowledge-bases',
      path: () => '/live/v1/knowledge-bases',
      fields: [
        { key: 'page', label: 'pager.page', type: 'number', default: 0 },
        { key: 'pagesz', label: 'pager.pagesz', type: 'number', default: 20 },
      ],
      query: (v) => ({ 'pager.page': v.page ?? 0, 'pager.pagesz': v.pagesz ?? 20 }),
    }),
    operation({
      label: '知识库详情', method: 'GET', endpointLabel: '/live/v1/knowledge-bases/{id}',
      path: (v) => `/live/v1/knowledge-bases/${v.id}`,
      fields: [{ key: 'id', label: '知识库 ID', type: 'text', required: true }],
    }),
    operation({
      label: '删除知识库', method: 'DELETE', endpointLabel: '/live/v1/knowledge-bases/{id}',
      path: (v) => `/live/v1/knowledge-bases/${v.id}`,
      fields: [{ key: 'id', label: '知识库 ID', type: 'text', required: true }],
    }),
    operation({
      label: '添加知识文档', method: 'POST', endpointLabel: '/live/v1/knowledge-bases/{id}/documents',
      path: (v) => `/live/v1/knowledge-bases/${v.id}/documents`,
      fields: [
        { key: 'id', label: '知识库 ID', type: 'text', required: true },
        { key: 'file_uri', label: 'file_uri', type: 'text', required: true, placeholder: 'https://example.com/product-faq.txt', doc: '必填，平台可访问的文件地址。' },
        { key: 'name', label: 'name', type: 'text', doc: '可选，最长 256 字符，省略时从文件地址推导。' },
      ],
      body: (v) => ({ file_uri: v.file_uri, ...(v.name ? { name: v.name } : {}) }),
      hint: '同步添加并完成灌库，成功后可立即检索。',
    }),
    operation({
      label: '文档列表 / 详情', method: 'GET', endpointLabel: '/live/v1/knowledge-bases/{id}/documents[/{doc_id}]',
      path: (v) => `/live/v1/knowledge-bases/${v.id}/documents${v.doc_id ? '/' + v.doc_id : ''}`,
      fields: [
        { key: 'id', label: '知识库 ID', type: 'text', required: true },
        { key: 'doc_id', label: '文档 ID（留空则列表）', type: 'text' },
        { key: 'page', label: 'pager.page', type: 'number', default: 0 },
        { key: 'pagesz', label: 'pager.pagesz', type: 'number', default: 20 },
      ],
      query: (v) => (v.doc_id ? undefined : { 'pager.page': v.page ?? 0, 'pager.pagesz': v.pagesz ?? 20 }),
      hint: '查询单个文档返回的 file_uri 是带签名的临时地址，有有效期，不要长期保存。',
    }),
    operation({
      label: '删除知识文档', method: 'DELETE', endpointLabel: '/live/v1/knowledge-bases/{id}/documents/{doc_id}',
      path: (v) => `/live/v1/knowledge-bases/${v.id}/documents/${v.doc_id}`,
      fields: [
        { key: 'id', label: '知识库 ID', type: 'text', required: true },
        { key: 'doc_id', label: '文档 ID', type: 'text', required: true },
      ],
    }),
  );

  // ------------------------------------------------------ Live 管理
  const liveSection = h('div.section',
    h('h3', 'Live 管理　/live/v1/lives'),
    h('p.section-doc', '查会话状态、账单和录播。这几个接口只读不计费，是验证 API Key 和代理链路最安全的方式。'),
    operation({
      label: 'Live 列表', method: 'GET', endpointLabel: '/live/v1/lives', open: true,
      path: () => '/live/v1/lives',
      fields: [
        { key: 'page', label: 'pager.page', type: 'number', default: 0, doc: '页码，从 0 开始。' },
        { key: 'pagesz', label: 'pager.pagesz', type: 'number', default: 10, doc: '每页数量，≤0 时默认 10，>100 截断为 100。' },
      ],
      query: (v) => ({ 'pager.page': v.page ?? 0, 'pager.pagesz': v.pagesz ?? 10 }),
      hint: '👉 先跑这个。能正常返回就说明 API Key、环境、代理链路都通了。',
    }),
    operation({
      label: 'Live 详情与账单', method: 'GET', endpointLabel: '/live/v1/lives/{live_id}',
      path: (v) => `/live/v1/lives/${v.live_id}`,
      fields: [{ key: 'live_id', label: 'live_id', type: 'text', required: true }],
      hint: '关注 billed_seconds（计费秒数）与 credits_cost（消耗积分）——实际扣费以这里为准。另有 trace_id，反馈问题时带上。',
    }),
    operation({
      label: '查询录播文件', method: 'GET', endpointLabel: '/live/v1/lives/{live_id}/recording',
      path: (v) => `/live/v1/lives/${v.live_id}/recording`,
      fields: [{ key: 'live_id', label: 'live_id', type: 'text', required: true }],
      hint: '需要创建会话时传 enable_recording=true。录播会话结束后异步生成，通常 2 分钟内可查到。下载地址有效期 24 小时，格式 MP4。error_code 取值：unspecified / start_failed / stop_failed / query_failed / transfer_failed。',
    }),
    operation({
      label: '查询积分余额', method: 'GET', endpointLabel: '/ent/v2/credits',
      path: () => '/ent/v2/credits',
      fields: [],
      hint: '余额低于 45 积分（约 1.4 元）时无法发起任何 S2 任务。',
    }),
  );

  // ------------------------------------------------------ 组装
  const tabs = [
    { key: 'live', label: 'Live 管理', node: liveSection },
    { key: 'avatar', label: '形象图片', node: avatarSection },
    { key: 'voice', label: '音色', node: voiceSection },
    { key: 'action', label: '动作库', node: actionSection },
    { key: 'memory', label: '记忆', node: memorySection },
    { key: 'knowledge', label: '知识库', node: knowledgeSection },
  ];

  const body = h('div.assets-body');
  const nav = h('div.sub-nav');

  function select(key) {
    clear(body);
    const tab = tabs.find((t) => t.key === key);
    body.appendChild(tab.node);
    for (const btn of nav.children) btn.classList.toggle('active', btn.dataset.key === key);
  }

  for (const tab of tabs) {
    nav.appendChild(h('button.sub-tab', { dataset: { key: tab.key }, onclick: () => select(tab.key) }, tab.label));
  }
  select('live');

  return h('div.panel',
    h('div.panel-intro',
      h('h2', '资产管理'),
      h('p', '实时与非实时面板要用到的各种 ID 都在这里创建和查询：形象资产 ID、克隆音色名、动作库 ID、知识库 ID，以及会话账单与录播。'),
      nav,
    ),
    h('div.panel-cols',
      h('div.col.col-wide', body),
      h('div.col.col-right', response.element, log.element),
    ),
  );
}
