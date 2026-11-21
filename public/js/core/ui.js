/** DOM 小工具 + JSON 展示 + 提示条。没有框架，就这些够用了。 */

/** h('div.card', { onclick }, child, child...) */
export function h(spec, props, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');

  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'html') el.innerHTML = value;
      else if (key in el && key !== 'list') el[key] = value;
      else el.setAttribute(key, value);
    }
  } else if (props !== undefined && props !== null) {
    children.unshift(props);
  }

  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/**
 * 预览最多渲染多少字符。base64 图片/音频动辄几 MB，
 * 高亮正则扫过超长字符串会抛 RangeError: Maximum call stack size exceeded（实测 ~5MB 就炸），
 * 所以先用原生 slice 截断，再上正则。
 */
const MAX_PREVIEW_CHARS = 400000;
/** 预览里超过这个长度的 data URL / http URL 直接折叠。 */
const LONG_URI_CHARS = 512;

function foldLongUri(str) {
  if (str.length <= LONG_URI_CHARS || !/^(?:data:|https?:\/\/)/i.test(str)) return str;
  return `${str.slice(0, 120)}…（共 ${str.length} 字符，预览已折叠）`;
}

/** 深拷贝一份用于展示的 JSON：长 data URL / URL 换成短提示，避免请求体预览撑爆页面。 */
function compactForDisplay(value) {
  if (typeof value === 'string') return foldLongUri(value);
  if (Array.isArray(value)) return value.map(compactForDisplay);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = compactForDisplay(val);
    return out;
  }
  return value;
}

function clipPreview(text) {
  return text.length <= MAX_PREVIEW_CHARS
    ? text
    : `${text.slice(0, MAX_PREVIEW_CHARS)}\n…（预览已截断，共 ${text.length} 字符；完整内容请用「复制 JSON」或原始 JSON 编辑查看）`;
}

/** 语法高亮的 JSON 块。undefined / 空值统一显示成占位文本。 */
export function jsonBlock(value, { empty = '（暂无）' } = {}) {
  if (value === undefined || value === null) {
    return h('div.json-empty', empty);
  }
  const text = typeof value === 'string'
    ? clipPreview(value)
    : clipPreview(JSON.stringify(compactForDisplay(value), null, 2));
  const pre = h('pre.json');
  pre.innerHTML = highlight(text);
  return pre;
}

function highlight(text) {
  const escaped = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 兜底：理论上 clipPreview 已经截断，这里再挡一次，绝不让正则跑在超长字符串上
  if (escaped.length > MAX_PREVIEW_CHARS) return escaped;
  return escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'num';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'key' : 'str';
      else if (/true|false/.test(match)) cls = 'bool';
      else if (/null/.test(match)) cls = 'null';
      return `<span class="tok-${cls}">${match}</span>`;
    },
  );
}

/** 右上角浮层提示。type: ok | warn | err */
let toastHost = null;
export function toast(message, type = 'ok', timeout = 3600) {
  if (!toastHost) {
    toastHost = h('div.toast-host');
    document.body.appendChild(toastHost);
  }
  const el = h(`div.toast.${type}`, message);
  toastHost.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }, timeout);
}

export async function copy(text, okMessage = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage, 'ok', 1600);
  } catch {
    toast('复制失败，请手动选中', 'err');
  }
}

/** 统一的分区卡片：标题 + 可选说明 + 内容。 */
export function card(title, { hint, actions, collapsible = false, open = true } = {}, ...children) {
  const body = h('div.card-body', ...children);
  const head = h('div.card-head',
    h('div.card-title', title),
    hint ? h('div.card-hint', hint) : null,
    actions ? h('div.card-actions', actions) : null,
  );
  const root = h('section.card', head, body);
  if (collapsible) {
    root.classList.add('collapsible');
    if (!open) root.classList.add('closed');
    head.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions')) return;
      root.classList.toggle('closed');
    });
  }
  return root;
}

/** 带文档说明的字段行。 */
export function field(label, control, { doc, required } = {}) {
  return h('label.field',
    h('div.field-label',
      h('span', label),
      required ? h('span.req', '必填') : null,
    ),
    control,
    doc ? h('div.field-doc', doc) : null,
  );
}

export function statusPill(text, kind = 'idle') {
  return h(`span.pill.${kind}`, text);
}
