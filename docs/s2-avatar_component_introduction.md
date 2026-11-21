# 整体介绍

此版本面向**自带 RTC 频道、自带实时语音能力** 的客户，Vidu 只负责数字人渲染与推流。你将数字人语音和动作指令给到 Vidu，Vidu 把渲染好的数字人推到对应的 RTC 频道。

<whiteboard token="QCIxwoAlchDf3qbLGjqcFpfenGe"></whiteboard>

## 最小接入流程

1. 创建会话 （HTTP 创建并带上你的 rtc_info）

用你的 [API Key](/vidu-stream/doc/api-key) 调用创建接口，把自己的 RTC 频道信息（`rtc_info`）一起传进去。Vidu 会用这份信息加入你的频道，准备推数字人画面。响应里的 `live.id` 后续 WebSocket、查询都要用；`client_secret` 用于浏览器场景的 WebSocket 建连。

2. 建立 WebSocket 并发送开始信号 （控制链路初始化）

连接 `/live/v1/external-lives/{live_id}/stream`，连上后首帧必须发送 `conn_init`（在此之前发的其他信号都会被忽略）。收到 `conn_init_ack.success=true` 说明渲染侧就绪；若返回 `NOT_READY`，稍等片刻重试 `conn_init` 即可，无需重连 WebSocket。

3. 运行期持续推送数据 （音频、转写与控制信令）

就绪后，一边通过二进制帧发送裸 PCM 音频，一边通过文本帧发送用户转写文本（type=9）和模型回复文本（type=10）。检测到用户开口时，发送 `audio_interrupted`（type=7）打断数字人当前回复。数字人画面由 Vidu 实时推到你自己的 RTC 频道，你在客户端订阅并渲染。

## 接口协议概述

## 接入全流程
- 创建（HTTP，带上你的 `rtc_info`）
- 拿到 `live_id` 和 `client_secret`
- 建立 WebSocket 流并发送 `conn_init`
- 收到 `conn_init_ack.success=true` 后进入直播
- 运行期持续发送 PCM 音频、用户转写文本（type=9）和模型回复文本（type=10），必要时发打断（type=7）
- 结束时发 `call_hangup` 或直接关闭 WebSocket。

## 接口总览

下表列出全部对外接口，可按用途查询入口，所有 HTTP 接口都需 `Authorization: Token vda_xxx`。

| 方法 | 路径 | 用途 |
|-|-|-|
| POST | `/live/s_avatar/component` | 创建（核心入口，返回 `live` 与 `client_secret`） |
| GET | `/live/v1/lives/{live_id}` | 查询单个直播状态 |
| WebSocket | `/live/v1/external-lives/{live_id}/stream` | 喂数据 + 控制信令（音频 / 转写 / 打断 / 挂断） |

## 通用约定

| 项目 | 约定 |
|-|-|
| `{host}` | `{host}` 是域名，不含协议。国内环境为 `api.vidu.cn`，海外环境为 `api.vidu.com`。HTTP 用 `https://{host}`，WebSocket 用 `wss://{host}` |
| 网关前缀 | 下文路径含 `/live` 前缀（网关路径） |
| JSON 字段 | 请求与响应字段使用 snake_case，例如 `image_uri`、`rtc_info`、`client_secret` |
| ID 与时间 | `live_id`、`created_at` 等 int64 字段建议前端按字符串处理，避免 JavaScript number 精度问题 |
| 媒体传输 | 数字人画面由 Vidu 推到**你自己的 RTC 频道**；WebSocket 只承载控制信令、转写文本和你上行的 PCM 音频 |
