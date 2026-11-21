/**
 * HTTP 调用封装。所有请求都经本地 /proxy/{env}/ 转发，浏览器不直连 Vidu。
 * 每次调用都完整留存请求与响应，供面板原样展示 + 导出 cURL。
 */
import { state } from './state.js';

/** 把接口路径拼成本地代理地址。path 形如 /live/s_avatar/realtime */
export function apiUrl(path) {
  return `/proxy/${state.env}${path}`;
}

/** 同上，但给 WebSocket 用；API Key 只能走查询参数，由代理转成请求头。 */
export function wsUrl(path, query) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams(query || {});
  return `${proto}//${location.host}/proxy/${state.env}${path}?${params}`;
}

export function upstreamBase() {
  return state.env === 'ovs' ? 'https://api.vidu.com' : 'https://api.vidu.cn';
}

export class ApiError extends Error {
  constructor(message, { status, body, call }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.call = call;
  }
}

/**
 * 发一个请求。
 * @returns {{ok, status, data, raw, call}} call 里带着完整的请求/响应快照
 */
export async function request(method, path, { body, query, headers } = {}) {
  if (!state.apiKey) {
    throw new ApiError('请先在页面顶部填写 API Key', { status: 0, body: null, call: null });
  }

  const search = query ? '?' + new URLSearchParams(query) : '';
  const url = apiUrl(path) + search;
  const reqHeaders = {
    Authorization: state.apiKey,
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(headers || {}),
  };

  const call = {
    method,
    path: path + search,
    url: upstreamBase() + path + search,
    requestHeaders: { ...reqHeaders, Authorization: maskKey(state.apiKey) },
    requestBody: body,
    startedAt: Date.now(),
  };

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: reqHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    call.durationMs = Date.now() - call.startedAt;
    call.error = err.message;
    throw new ApiError(`网络错误：${err.message}`, { status: 0, body: null, call });
  }

  const raw = await response.text();
  call.durationMs = Date.now() - call.startedAt;
  call.status = response.status;

  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = null; }
  }
  call.responseBody = data ?? raw;

  if (!response.ok) {
    const reason = data?.reason || data?.message || response.statusText;
    throw new ApiError(`HTTP ${response.status} ${reason}`, { status: response.status, body: data ?? raw, call });
  }

  return { ok: true, status: response.status, data, raw, call };
}

export const get = (path, opts) => request('GET', path, opts);
export const post = (path, body, opts) => request('POST', path, { ...opts, body });
export const patch = (path, body, opts) => request('PATCH', path, { ...opts, body });
export const del = (path, opts) => request('DELETE', path, opts);

/** 把一次调用还原成可直接粘进终端的 cURL（Key 用占位符，不泄漏）。 */
export function toCurl(call) {
  if (!call) return '';
  const lines = [`curl -X ${call.method} "${call.url}"`];
  lines.push(`  -H "Authorization: Token $VIDU_API_KEY"`);
  if (call.requestBody !== undefined) {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d '${JSON.stringify(call.requestBody, null, 2)}'`);
  }
  return lines.join(' \\\n');
}

export function maskKey(value) {
  const s = String(value || '');
  if (!s) return '';
  return s.length <= 12 ? '***' : `${s.slice(0, 10)}...${s.slice(-4)}`;
}
