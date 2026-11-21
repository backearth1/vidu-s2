/** 应用外壳：顶栏（环境 / API Key / 余额）+ 侧边导航 + 面板容器。 */
import { h, clear, toast, statusPill } from './core/ui.js';
import { state, setApiKey, setEnv } from './core/state.js';
import { get, maskKey, ApiError } from './core/api.js';
import { avatarRealtimeView } from './views/avatar-realtime.js';
import { editingView } from './views/editing.js';
import { avatarComponentView } from './views/avatar-component.js';
import { avatarOfflineView } from './views/avatar-offline.js';
import { asrView } from './views/asr.js';
import { assetsView } from './views/assets.js';
import { docsView } from './views/docs.js';

const VIEWS = [
  { key: 'realtime', label: 'S2-Avatar 实时交互', sub: '语音对话 · 换参考图', build: avatarRealtimeView },
  { key: 'editing', label: 'S2-Editing 实时编辑', sub: '风格 / 试穿 / 换主体 / 换背景', build: editingView },
  { key: 'component', label: 'S2-Avatar 组件版', sub: '自带 RTC · PCM 上行', build: avatarComponentView },
  { key: 'offline', label: 'S2-Avatar 非实时', sub: '异步出 MP4', build: avatarOfflineView },
  { key: 'asr', label: '语音识别 ASR', sub: '视频 / 音频 → 文字 · 字幕', build: asrView },
  { key: 'assets', label: '资产管理', sub: '形象 / 音色 / 动作 / 记忆 / 知识库', build: assetsView },
  { key: 'docs', label: 'API 文档', sub: '官方文档原文', build: docsView },
];

const container = document.getElementById('view');
const navEl = document.getElementById('nav');
const cache = new Map();

// ------------------------------------------------------------------ 顶栏

const keyInput = h('input.key-input', {
  type: 'password',
  placeholder: 'vda_...',
  value: state.apiKey,
  oninput: () => setApiKey(keyInput.value),
});

const revealBtn = h('button.mini', {
  type: 'button',
  onclick: () => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    revealBtn.textContent = keyInput.type === 'password' ? '显示' : '隐藏';
  },
}, '显示');

const envSelect = h('select.mini-select', {
  onchange: () => { setEnv(envSelect.value); creditPill.textContent = '未查询'; creditPill.className = 'pill idle'; },
},
  h('option', { value: 'cn', selected: state.env === 'cn' }, '国内 api.vidu.cn'),
  h('option', { value: 'ovs', selected: state.env === 'ovs' }, '海外 api.vidu.com'),
);

const creditPill = statusPill('未查询', 'idle');
const creditBtn = h('button.mini', { type: 'button', onclick: checkCredits }, '查余额');

async function checkCredits() {
  if (!state.apiKey) { toast('请先填写 API Key', 'warn'); return; }
  creditPill.textContent = '查询中…';
  creditPill.className = 'pill warn';
  try {
    const result = await get('/ent/v2/credits');
    const data = result.data || {};
    // 实际返回结构：{ remains: [{credit_remain, concurrency_limit, current_concurrency}],
    //                general_remains: [...], exclusive_remains: [...], packages: [...] }
    const buckets = [...(data.remains || []), ...(data.general_remains || []), ...(data.exclusive_remains || [])];
    const total = buckets.reduce((sum, b) => sum + (Number(b.credit_remain) || 0), 0);
    const concurrency = buckets.reduce(
      (acc, b) => ({
        used: acc.used + (Number(b.current_concurrency) || 0),
        limit: Math.max(acc.limit, Number(b.concurrency_limit) || 0),
      }),
      { used: 0, limit: 0 },
    );

    if (buckets.length) {
      const low = total < 45;
      creditPill.textContent = `${total.toLocaleString()} 积分 · 并发 ${concurrency.used}/${concurrency.limit}`
        + (low ? '（不足 45，无法发起任务）' : '');
      creditPill.className = `pill ${low ? 'err' : 'ok'}`;
      creditPill.title = buckets
        .map((b) => `${b.type || 'metered'}：${b.credit_remain} 积分，并发 ${b.current_concurrency}/${b.concurrency_limit}`)
        .join('\n');
    } else {
      creditPill.textContent = '已返回，见响应';
      creditPill.className = 'pill ok';
      toast('余额接口返回了非预期结构，详情见「资产管理 → Live 管理 → 查询积分余额」', 'warn', 6000);
    }
  } catch (err) {
    creditPill.textContent = '查询失败';
    creditPill.className = 'pill err';
    toast(err.message, 'err', 6000);
  }
}

document.getElementById('topbar-right').append(
  h('div.top-field', h('span.top-label', '环境'), envSelect),
  h('div.top-field', h('span.top-label', 'API Key'), keyInput, revealBtn),
  h('div.top-field', h('span.top-label', '余额'), creditPill, creditBtn),
);

// ------------------------------------------------------------------ 导航

function select(key) {
  for (const btn of navEl.children) btn.classList.toggle('active', btn.dataset.key === key);
  clear(container);
  if (!cache.has(key)) {
    const view = VIEWS.find((v) => v.key === key);
    cache.set(key, view.build());
  }
  container.appendChild(cache.get(key));
  location.hash = key;
}

for (const view of VIEWS) {
  navEl.appendChild(h('button.nav-item', { dataset: { key: view.key }, onclick: () => select(view.key) },
    h('div.nav-label', view.label),
    h('div.nav-sub', view.sub),
  ));
}

// ------------------------------------------------------------------ 启动

(async function boot() {
  // 服务端可以用 --api-key / VIDU_API_KEY 注入，省得每次手填
  try {
    const res = await fetch('/bootstrap');
    const data = await res.json();
    if (data.apiKey && !state.apiKey) {
      setApiKey(data.apiKey);
      keyInput.value = data.apiKey;
      toast(`已从启动参数载入 API Key（${maskKey(data.apiKey)}）`, 'ok', 4000);
    }
  } catch { /* 直接开静态文件时没有这个接口，忽略 */ }

  const initial = location.hash.replace('#', '');
  select(VIEWS.some((v) => v.key === initial) ? initial : 'realtime');

  if (state.apiKey) checkCredits();
})();
