/**
 * 面板骨架：左边表单，中间请求体/响应，右边日志。
 *
 * 请求体有两种模式：
 *   - 表单模式（默认）：JSON 由表单实时生成，只读
 *   - 原始模式：直接编辑 JSON，以编辑内容为准，表单不再覆盖它
 * 切回表单模式时会把当前 JSON 反填进表单，两边不会对不上。
 */
import { h, clear, card, jsonBlock, copy, toast } from './ui.js';
import { buildForm } from './form.js';
import { createLogPanel } from './log.js';
import { toCurl } from './api.js';

export function createRequestEditor({ schema, values, title = '请求体', endpoint, transform }) {
  let rawMode = false;
  const form = buildForm(schema, { values, onChange: () => refresh() });

  const jsonView = h('div.json-view');
  const rawInput = h('textarea.raw-json', { spellcheck: false, rows: 18, oninput: () => { dirty = true; } });
  rawInput.style.display = 'none';
  let dirty = false;

  const modeBtn = h('button.mini', { type: 'button', onclick: toggleMode }, '切到原始 JSON 编辑');
  const copyBtn = h('button.mini', { type: 'button', onclick: () => copy(JSON.stringify(current(), null, 2), '请求体已复制') }, '复制 JSON');

  function built() {
    const raw = form.collect();
    return transform ? transform(raw) : raw;
  }

  function current() {
    if (!rawMode) return built();
    try {
      return JSON.parse(rawInput.value || '{}');
    } catch (err) {
      throw new Error(`原始 JSON 解析失败：${err.message}`);
    }
  }

  function refresh() {
    if (rawMode) return;
    clear(jsonView).appendChild(jsonBlock(built()));
  }

  function toggleMode() {
    if (!rawMode) {
      rawInput.value = JSON.stringify(built(), null, 2);
      rawInput.style.display = '';
      jsonView.style.display = 'none';
      modeBtn.textContent = '切回表单（会用当前 JSON 反填）';
      form.element.classList.add('shadowed');
      rawMode = true;
      dirty = false;
    } else {
      try {
        const parsed = JSON.parse(rawInput.value || '{}');
        form.apply(parsed);
      } catch (err) {
        toast(`JSON 有语法错误，无法反填：${err.message}`, 'err', 5000);
        return;
      }
      rawInput.style.display = 'none';
      jsonView.style.display = '';
      modeBtn.textContent = '切到原始 JSON 编辑';
      form.element.classList.remove('shadowed');
      rawMode = false;
      refresh();
    }
  }

  refresh();

  const element = card(title, {
    hint: endpoint ? h('code.endpoint', endpoint) : null,
    actions: h('div', modeBtn, copyBtn),
  }, jsonView, rawInput);

  return {
    element,
    formElement: form.element,
    current,
    validate: () => (rawMode ? [] : form.validate()),
    refresh,
    isRawMode: () => rawMode,
    apply(obj) {
      if (rawMode) rawInput.value = JSON.stringify(obj, null, 2);
      else { form.apply(obj); refresh(); }
    },
  };
}

/** 响应展示：状态码 + 耗时 + 原始 JSON + cURL。 */
export function createResponseView({ title = '响应' } = {}) {
  const meta = h('div.resp-meta');
  const body = h('div.json-view', jsonBlock(undefined, { empty: '尚未发起请求' }));
  let lastCall = null;

  const root = card(title, {
    actions: h('button.mini', {
      type: 'button',
      onclick: () => {
        if (!lastCall) { toast('还没有请求可导出', 'warn'); return; }
        copy(toCurl(lastCall), 'cURL 已复制（Key 用 $VIDU_API_KEY 占位）');
      },
    }, '导出 cURL'),
  }, meta, body);

  return {
    element: root,
    show(call) {
      lastCall = call;
      clear(meta);
      if (!call) return;
      const ok = call.status >= 200 && call.status < 300;
      meta.appendChild(h(`span.pill.${ok ? 'ok' : 'err'}`, `HTTP ${call.status ?? '-'}`));
      meta.appendChild(h('span.resp-time', `${call.durationMs} ms`));
      meta.appendChild(h('code.endpoint', `${call.method} ${call.path}`));
      clear(body).appendChild(jsonBlock(call.responseBody ?? call.error));
    },
    clear() {
      lastCall = null;
      clear(meta);
      clear(body).appendChild(jsonBlock(undefined, { empty: '尚未发起请求' }));
    },
  };
}

/** 三栏布局外壳。 */
export function createPanelLayout({ intro, left, middle, right }) {
  return h('div.panel',
    intro ? h('div.panel-intro', intro) : null,
    h('div.panel-cols',
      h('div.col.col-left', left),
      h('div.col.col-mid', middle),
      h('div.col.col-right', right),
    ),
  );
}

export { createLogPanel };
