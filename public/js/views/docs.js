/** 文档面板：直接渲染仓库里 docs/*.md 的官方文档原文，省得来回翻官网。 */
import { h, clear, card, toast } from '../core/ui.js';

const DOCS = [
  { file: 's2-avatar_realtime_parameters.md', label: 'S2-Avatar 实时交互 · 详细参数' },
  { file: 's2-avatar_realtime_introduction.md', label: 'S2-Avatar 实时交互 · 介绍' },
  { file: 's2-avatar_realtime_quick-start.md', label: 'S2-Avatar 实时交互 · 快速开始' },
  { file: 's2-editing_parameters.md', label: 'S2-Editing 实时编辑 · 详细参数' },
  { file: 's2-editing_introduction.md', label: 'S2-Editing 实时编辑 · 介绍' },
  { file: 's2-editing_quick-start.md', label: 'S2-Editing 实时编辑 · 快速开始' },
  { file: 's2-avatar_component_parameters.md', label: 'S2-Avatar 组件版 · 详细参数' },
  { file: 's2-avatar_component_introduction.md', label: 'S2-Avatar 组件版 · 介绍' },
  { file: 's2-avatar_async_parameters.md', label: 'S2-Avatar 非实时 · 详细参数' },
  { file: 's2-avatar_async_introduction.md', label: 'S2-Avatar 非实时 · 介绍' },
  { file: 'image-upload.md', label: '图片上传' },
  { file: 'voice-list.md', label: '音色列表（717 个）' },
];

export function docsView() {
  const body = h('div.doc-body', h('div.muted', '选择左侧文档'));
  const nav = h('div.doc-nav');

  async function load(item) {
    for (const btn of nav.children) btn.classList.toggle('active', btn.dataset.file === item.file);
    clear(body).appendChild(h('div.muted', '加载中…'));
    try {
      const res = await fetch(`/docs/${item.file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const md = await res.text();
      clear(body).appendChild(renderMarkdown(md));
      body.scrollTop = 0;
    } catch (err) {
      clear(body).appendChild(h('div.muted', `加载失败：${err.message}`));
    }
  }

  for (const item of DOCS) {
    nav.appendChild(h('button.doc-tab', { dataset: { file: item.file }, onclick: () => load(item) }, item.label));
  }
  load(DOCS[0]);

  return h('div.panel',
    h('div.panel-intro',
      h('h2', 'API 文档原文'),
      h('p', '这些是从 platform.vidu.cn/vidu-stream/doc 抓取并还原的官方文档，随本项目一起存在 docs/ 目录下，离线可读。'),
    ),
    h('div.doc-layout', nav, body),
  );
}

/**
 * 够用的 Markdown 子集渲染：标题、表格、代码块、列表、粗体、行内代码、链接。
 * 文档里表格和代码块最多，这两块做对了就可读。
 */
function renderMarkdown(md) {
  const root = h('div.md');
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块（文档里常出现 ```json 紧贴在上一段文字后面的情况）
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3);
      const buf = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      const pre = h('pre.md-code', h('code', buf.join('\n')));
      if (lang) pre.dataset.lang = lang;
      root.appendChild(pre);
      continue;
    }

    // 表格
    if (line.includes('|') && lines[i + 1] && /^\s*\|?[\s:|-]+\|/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      root.appendChild(h('table.md-table',
        h('thead', h('tr', ...header.map((c) => h('th', inline(c))))),
        h('tbody', ...rows.map((r) => h('tr', ...r.map((c) => h('td', inline(c)))))),
      ));
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      root.appendChild(h(`h${Math.min(heading[1].length + 1, 6)}`, inline(heading[2])));
      i += 1;
      continue;
    }

    // 列表
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
        i += 1;
      }
      root.appendChild(h(ordered ? 'ol' : 'ul', ...items.map((t) => h('li', inline(t)))));
      continue;
    }

    if (!line.trim()) { i += 1; continue; }

    // 普通段落
    const buf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#')
      && !lines[i].trimStart().startsWith('```') && !lines[i].includes('|')
      && !/^\s*[-*]\s+/.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    root.appendChild(h('p', inline(buf.join(' '))));
  }

  return root;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** 行内标记：`code`、**bold**、[text](url)、<br>。返回 DOM 节点数组。 */
function inline(text) {
  const frag = document.createDocumentFragment();
  const normalized = String(text).replace(/<br\s*\/?>/gi, '\n');
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  while ((m = pattern.exec(normalized)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(normalized.slice(last, m.index)));
    const token = m[0];
    if (token.startsWith('`')) {
      frag.appendChild(h('code', token.slice(1, -1)));
    } else if (token.startsWith('**')) {
      frag.appendChild(h('strong', token.slice(2, -2)));
    } else {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(token);
      frag.appendChild(h('a', { href: link[2], target: '_blank', rel: 'noopener' }, link[1]));
    }
    last = m.index + token.length;
  }
  if (last < normalized.length) frag.appendChild(document.createTextNode(normalized.slice(last)));
  return frag;
}
