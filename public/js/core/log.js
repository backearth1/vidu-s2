/** 日志面板：时间线 + 可展开的结构化数据。WS 帧、HTTP 调用、RTC 事件都往这里写。 */
import { h, clear, copy } from './ui.js';

export function createLogPanel({ title = '日志' } = {}) {
  const list = h('div.log-list');
  let entries = [];
  let autoScroll = true;
  let filter = 'all';

  const filterSelect = h('select.mini-select', {
    onchange: () => { filter = filterSelect.value; render(); },
  },
    h('option', { value: 'all' }, '全部'),
    h('option', { value: 'ws-in' }, 'WS 收'),
    h('option', { value: 'ws-out' }, 'WS 发'),
    h('option', { value: 'http' }, 'HTTP'),
    h('option', { value: 'rtc' }, 'RTC'),
    h('option', { value: 'error' }, '错误'),
  );

  const head = h('div.log-head',
    h('div.log-title', title),
    filterSelect,
    h('button.mini', { type: 'button', onclick: () => copy(asText(), '日志已复制') }, '复制'),
    h('button.mini', { type: 'button', onclick: () => { entries = []; render(); } }, '清空'),
  );

  const root = h('div.log-panel', head, list);

  list.addEventListener('scroll', () => {
    autoScroll = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  });

  function render() {
    clear(list);
    const shown = entries.filter((e) => filter === 'all' || e.kind === filter);
    for (const entry of shown) list.appendChild(renderEntry(entry));
    if (autoScroll) list.scrollTop = list.scrollHeight;
  }

  function renderEntry(entry) {
    const time = new Date(entry.at).toTimeString().slice(0, 8);
    const row = h(`div.log-entry.${entry.kind}`,
      h('div.log-row',
        h('span.log-time', time),
        h('span.log-kind', KIND_LABEL[entry.kind] || entry.kind),
        h('span.log-msg', entry.message),
      ),
    );
    if (entry.data !== undefined) {
      const pre = h('pre.log-data', typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2));
      pre.style.display = 'none';
      row.querySelector('.log-row').addEventListener('click', () => {
        pre.style.display = pre.style.display === 'none' ? 'block' : 'none';
      });
      row.querySelector('.log-row').classList.add('expandable');
      row.appendChild(pre);
    }
    return row;
  }

  function asText() {
    return entries.map((e) => {
      const time = new Date(e.at).toISOString();
      const data = e.data === undefined ? '' : '\n' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2));
      return `[${time}] [${e.kind}] ${e.message}${data}`;
    }).join('\n');
  }

  function push(kind, message, data) {
    entries.push({ kind, message, data, at: Date.now() });
    if (entries.length > 800) entries = entries.slice(-600);
    render();
  }

  return {
    element: root,
    info: (msg, data) => push('info', msg, data),
    error: (msg, data) => push('error', msg, data),
    http: (msg, data) => push('http', msg, data),
    rtc: (msg, data) => push('rtc', msg, data),
    wsIn: (msg, data) => push('ws-in', msg, data),
    wsOut: (msg, data) => push('ws-out', msg, data),
    clear: () => { entries = []; render(); },
    text: asText,
  };
}

const KIND_LABEL = {
  info: '信息',
  error: '错误',
  http: 'HTTP',
  rtc: 'RTC',
  'ws-in': 'WS↓',
  'ws-out': 'WS↑',
};
