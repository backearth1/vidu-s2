/** 音色速查：717 个内置音色，来自官方音色列表文档，可搜索、点选填入表单。 */
import { h, clear, card, toast } from '../core/ui.js';

let cache = null;

async function loadVoices() {
  if (cache) return cache;
  const res = await fetch('/js/data/voices.json');
  cache = await res.json();
  return cache;
}

export function voicePicker({ title = '音色速查', onPick } = {}) {
  const groupSelect = h('select.mini-select', { onchange: render });
  const search = h('input', { type: 'text', placeholder: '搜名字、ID、场景或语种…', oninput: render });
  const list = h('div.voice-list', h('div.muted', '加载中…'));
  const count = h('span.muted');

  const root = card(title, {
    hint: '点任意一行把音色 ID 填进上面的表单。实时版与非实时版音色不通用，注意选对分组。',
    collapsible: true, open: false,
    actions: count,
  },
    h('div.row', groupSelect),
    h('div.row', search),
    list,
  );

  let groups = [];

  loadVoices().then((data) => {
    groups = data;
    clear(groupSelect);
    data.forEach((g, i) => groupSelect.appendChild(h('option', { value: String(i) }, `${g.group}（${g.voices.length}）`)));
    render();
  }).catch((err) => {
    clear(list).appendChild(h('div.muted', `音色列表加载失败：${err.message}`));
  });

  function render() {
    const group = groups[Number(groupSelect.value) || 0];
    if (!group) return;
    const q = search.value.trim().toLowerCase();
    const items = group.voices.filter((v) => !q
      || v.id.toLowerCase().includes(q)
      || v.name.toLowerCase().includes(q)
      || (v.desc || '').toLowerCase().includes(q)
      || (v.lang || '').toLowerCase().includes(q));

    count.textContent = `${items.length} / ${group.voices.length}`;
    clear(list);
    if (!items.length) {
      list.appendChild(h('div.muted', '没有匹配的音色'));
      return;
    }
    for (const voice of items.slice(0, 200)) {
      list.appendChild(h('div.voice-row', {
        onclick: () => {
          if (onPick) onPick(voice.id);
          else {
            navigator.clipboard?.writeText(voice.id);
            toast(`已复制音色 ID：${voice.id}`, 'ok');
          }
        },
      },
        h('div.voice-main',
          h('code.voice-id', voice.id),
          h('span.voice-name', voice.name),
        ),
        voice.desc ? h('div.voice-desc', voice.desc) : null,
      ));
    }
    if (items.length > 200) {
      list.appendChild(h('div.muted', `仅显示前 200 条，共 ${items.length} 条，请继续输入关键词缩小范围`));
    }
  }

  return root;
}
