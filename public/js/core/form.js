/**
 * Schema 驱动的表单。
 *
 * 一份 schema 同时喂给三个地方：控件渲染、取值范围校验、请求体组装。
 * 这样「文档里写的每个参数都能调」只需要维护 schema 一处。
 *
 * 字段类型：
 *   text / textarea / number / select / bool / string-list / object-list / group
 *
 * 每个字段都有 `enabled` 开关（除非 required）——不勾选就不往请求体里放这个 key，
 * 这点很重要：Vidu 很多字段「不传」和「传默认值」的语义不一样（比如
 * idle_motion 对象存在但省略 enabled 视为 true）。
 */
import { h, field as fieldRow, card } from './ui.js';

/** 按 schema 建一个表单控制器。 */
export function buildForm(schema, { values = {}, onChange } = {}) {
  const controls = [];
  const root = h('div.form');

  for (const node of schema) {
    root.appendChild(renderNode(node, values, controls, onChange));
  }

  const api = {
    element: root,
    /** 收集当前表单值，未启用的字段直接不出现在结果里。 */
    collect() {
      const out = {};
      for (const control of controls) control.write(out);
      return prune(out);
    },
    /** 用一个 JSON 对象反向填充表单（原始 JSON 编辑模式切回表单时用）。 */
    apply(obj) {
      for (const control of controls) control.read(obj);
    },
    /** 校验，返回错误信息数组。 */
    validate() {
      const errors = [];
      for (const control of controls) {
        const err = control.validate?.();
        if (err) errors.push(err);
      }
      return errors;
    },
  };
  return api;
}

function renderNode(node, values, controls, onChange) {
  if (node.type === 'group') {
    const inner = h('div.form');
    const childControls = [];
    for (const child of node.fields) {
      inner.appendChild(renderNode(child, values, childControls, onChange));
    }

    // 分组本身可以带开关：关掉就整个对象都不传
    let groupToggle = null;
    if (node.optional) {
      groupToggle = h('input', {
        type: 'checkbox',
        checked: getPath(values, node.path) !== undefined || node.enabledByDefault === true,
        onchange: () => { inner.classList.toggle('disabled', !groupToggle.checked); onChange?.(); },
      });
      inner.classList.toggle('disabled', !groupToggle.checked);
    }

    controls.push({
      write(out) {
        if (groupToggle && !groupToggle.checked) return;
        const sub = {};
        for (const c of childControls) c.write(sub);
        // 子控件写的是完整路径（如 avatar.persona），sub 已经是正确的嵌套结构，
        // 这里只能合并，不能再 setPath 一层，否则会变成 avatar.avatar.persona
        deepMerge(out, prune(sub));
        // 分组显式启用但子字段全空时，保证对象本身存在——Vidu 有些字段「对象存在」
        // 本身就有语义（例如 idle_motion 对象存在但省略 enabled 视为 true）
        if (groupToggle && node.path && getPath(out, node.path) === undefined) {
          setPath(out, node.path, {});
        }
      },
      read(obj) {
        if (groupToggle) {
          groupToggle.checked = getPath(obj, node.path) !== undefined;
          inner.classList.toggle('disabled', !groupToggle.checked);
        }
        for (const c of childControls) c.read(obj);
      },
      validate() {
        if (groupToggle && !groupToggle.checked) return null;
        for (const c of childControls) {
          const err = c.validate?.();
          if (err) return err;
        }
        return null;
      },
    });

    return card(
      h('span', node.label, node.path ? h('code.path', node.path) : null),
      {
        hint: node.doc,
        collapsible: true,
        open: node.open !== false,
        actions: groupToggle ? h('label.toggle', groupToggle, h('span', '启用')) : null,
      },
      inner,
    );
  }

  const control = makeControl(node, values, onChange);
  controls.push(control);
  return control.element;
}

function makeControl(node, values, onChange) {
  const initial = getPath(values, node.path);
  const start = initial !== undefined ? initial : node.default;
  const fire = () => onChange?.();

  // 可选字段前面有个小开关，决定这个 key 是否进请求体。
  // schema 里给了 default 就默认勾选——这样页面初始状态就是一份能直接发的请求，
  // 同时又保留「取消勾选 = 不传这个 key」的能力（Vidu 很多字段「不传」和「传默认值」语义不同）。
  // noToggle：不渲染这个开关（用于「空 = 不传」这种语义，避免界面上出现多余的勾选框）。
  const toggle = (node.required || node.noToggle) ? null : h('input.field-toggle', {
    type: 'checkbox',
    checked: initial !== undefined || node.default !== undefined || node.always === true,
    onchange: () => { sync(); fire(); },
  });

  let input;
  let getValue;
  let setValue;

  switch (node.type) {
    case 'textarea': {
      input = h('textarea', { rows: node.rows || 4, placeholder: node.placeholder || '', value: start ?? '', oninput: fire });
      getValue = () => input.value;
      setValue = (v) => { input.value = v ?? ''; };
      break;
    }
    case 'number': {
      input = h('input', {
        type: 'number', value: start ?? '', placeholder: node.placeholder || '',
        step: node.step ?? (node.integer ? 1 : 'any'),
        min: node.min, max: node.max, oninput: fire,
      });
      getValue = () => (input.value === '' ? undefined : Number(input.value));
      setValue = (v) => { input.value = v ?? ''; };
      break;
    }
    case 'select': {
      input = h('select', { onchange: fire },
        ...node.options.map((opt) => {
          const value = typeof opt === 'string' ? opt : opt.value;
          const label = typeof opt === 'string' ? opt : opt.label;
          return h('option', { value, selected: value === start }, label);
        }),
      );
      getValue = () => input.value;
      setValue = (v) => { input.value = v ?? ''; };
      break;
    }
    case 'bool': {
      // bool 字段有两个勾选框，容易混淆，所以值勾选框自带 true/false 文字说明：
      // 标签前的小勾是「这个 key 传不传」，这里的勾才是「传 true 还是 false」
      const box = h('input', { type: 'checkbox', checked: Boolean(start), onchange: () => { syncBoolText(); fire(); } });
      const text = h('span.bool-text');
      const syncBoolText = () => { text.textContent = box.checked ? 'true' : 'false'; };
      syncBoolText();
      input = h('label.bool-control', box, text);
      getValue = () => box.checked;
      setValue = (v) => { box.checked = Boolean(v); syncBoolText(); };
      break;
    }
    case 'string-list': {
      const list = h('div.list');
      const add = (value = '') => {
        const row = h('div.list-row',
          h('input', { type: 'text', value, placeholder: node.placeholder || '', oninput: fire }),
          h('button.mini.danger', { type: 'button', onclick: () => { row.remove(); fire(); } }, '删除'),
        );
        list.appendChild(row);
      };
      input = h('div',
        list,
        h('button.mini', { type: 'button', onclick: () => { add(); fire(); } }, `+ 添加${node.itemLabel || '一项'}`),
      );
      (Array.isArray(start) ? start : []).forEach((v) => add(v));
      getValue = () => Array.from(list.querySelectorAll('input')).map((el) => el.value).filter(Boolean);
      setValue = (v) => {
        list.innerHTML = '';
        (Array.isArray(v) ? v : []).forEach((item) => add(item));
      };
      break;
    }
    case 'object-list': {
      const list = h('div.list');
      const add = (item = {}) => {
        const row = h('div.list-item');
        const inputs = {};
        for (const sub of node.item) {
          let el;
          if (sub.type === 'select') {
            el = h('select', { onchange: fire }, ...sub.options.map((o) => {
              const value = typeof o === 'string' ? o : o.value;
              const label = typeof o === 'string' ? o : o.label;
              return h('option', { value, selected: value === (item[sub.key] ?? sub.default) }, label);
            }));
          } else if (sub.type === 'number') {
            el = h('input', { type: 'number', step: sub.step ?? 'any', min: sub.min, max: sub.max, value: item[sub.key] ?? sub.default ?? '', oninput: fire });
          } else if (sub.type === 'textarea') {
            el = h('textarea', { rows: 2, value: item[sub.key] ?? sub.default ?? '', placeholder: sub.placeholder || '', oninput: fire });
          } else {
            el = h('input', { type: 'text', value: item[sub.key] ?? sub.default ?? '', placeholder: sub.placeholder || '', oninput: fire });
          }
          inputs[sub.key] = { el, spec: sub };
          row.appendChild(h('label.sub-field',
            h('span', sub.label, sub.required ? h('span.req', '必填') : null),
            el,
            sub.doc ? h('div.field-doc', sub.doc) : null,
          ));
        }
        row.appendChild(h('button.mini.danger', { type: 'button', onclick: () => { row.remove(); fire(); } }, '删除本项'));
        row._inputs = inputs;
        list.appendChild(row);
      };

      input = h('div',
        list,
        h('button.mini', { type: 'button', onclick: () => { add(); fire(); } }, `+ 添加${node.itemLabel || '一项'}`),
      );
      (Array.isArray(start) ? start : []).forEach((item) => add(item));

      getValue = () => Array.from(list.children).map((row) => {
        const obj = {};
        for (const [key, { el, spec }] of Object.entries(row._inputs)) {
          const raw = el.value;
          if (raw === '' || raw === undefined) continue;
          obj[key] = spec.type === 'number' ? Number(raw) : raw;
        }
        return obj;
      }).filter((o) => Object.keys(o).length);
      setValue = (v) => {
        list.innerHTML = '';
        (Array.isArray(v) ? v : []).forEach((item) => add(item));
      };
      break;
    }
    default: {
      input = h('input', { type: 'text', value: start ?? '', placeholder: node.placeholder || '', oninput: fire });
      getValue = () => input.value;
      setValue = (v) => { input.value = v ?? ''; };
    }
  }

  const element = fieldRow(
    h('span',
      toggle ? h('label.toggle', toggle) : null,
      node.label,
      node.path ? h('code.path', node.path) : null,
    ),
    input,
    { doc: node.doc, required: node.required },
  );

  function sync() {
    element.classList.toggle('off', Boolean(toggle) && !toggle.checked);
  }
  sync();

  return {
    element,
    write(out) {
      if (toggle && !toggle.checked) return;
      let value = getValue();
      if (value === undefined || value === '') {
        if (!node.required) return;
        value = node.type === 'number' ? undefined : '';
      }
      if (Array.isArray(value) && value.length === 0 && !node.required) return;
      setPath(out, node.path, value);
    },
    read(obj) {
      const value = getPath(obj, node.path);
      if (toggle) {
        toggle.checked = value !== undefined;
        sync();
      }
      if (value !== undefined) setValue(value);
    },
    validate() {
      if (toggle && !toggle.checked) return null;
      const value = getValue();
      if (node.required && (value === undefined || value === '' || (Array.isArray(value) && !value.length))) {
        return `${node.label}（${node.path}）是必填项`;
      }
      if (node.type === 'number' && value !== undefined) {
        if (node.min !== undefined && value < node.min) return `${node.path} 不能小于 ${node.min}`;
        if (node.max !== undefined && value > node.max) return `${node.path} 不能大于 ${node.max}`;
        if (node.integer && !Number.isInteger(value)) return `${node.path} 必须是整数`;
      }
      if (node.maxItems && Array.isArray(value) && value.length > node.maxItems) {
        return `${node.path} 最多 ${node.maxItems} 项`;
      }
      return null;
    },
  };
}

// ------------------------------------------------------------ 路径读写

export function getPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (typeof cursor[keys[i]] !== 'object' || cursor[keys[i]] === null) cursor[keys[i]] = {};
    cursor = cursor[keys[i]];
  }
  cursor[keys[keys.length - 1]] = value;
}

/** 分组内的子对象合并回 out。子控件用完整路径，所以只能合并不能再套一层。 */
function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof target[key] !== 'object' || target[key] === null || Array.isArray(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/** 去掉空对象，避免请求体里出现 "vad": {} 这种噪音。 */
function prune(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj === null || typeof obj !== 'object') return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const sub = prune(value);
      out[key] = sub;
    } else {
      out[key] = value;
    }
  }
  return out;
}
