/** 全局状态：API Key、环境、以及各面板共享的一点点上下文。 */

const STORAGE_KEY = 'vidu-s2-console';

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

const saved = load();

export const state = {
  apiKey: saved.apiKey || '',
  env: saved.env || 'cn',
  /** 面板间传递用：比如资产面板创建了形象，实时面板可以直接取 avatar id */
  lastAvatarId: saved.lastAvatarId || '',
};

export function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    apiKey: state.apiKey,
    env: state.env,
    lastAvatarId: state.lastAvatarId,
  }));
}

export function setApiKey(value) {
  state.apiKey = value.trim();
  persist();
}

export function setEnv(value) {
  state.env = value;
  persist();
}

/** 面板表单值的草稿存档，刷新页面不丢参数。 */
export function saveDraft(name, value) {
  try {
    localStorage.setItem(`${STORAGE_KEY}:draft:${name}`, JSON.stringify(value));
  } catch { /* 配额满了就算了，不影响主流程 */ }
}

export function loadDraft(name) {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}:draft:${name}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
