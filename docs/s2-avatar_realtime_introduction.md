# 整体介绍

这是全球领先的视频数字人产品，面向 B 端企业提供准实时、可交互、具备双向感知能力的新一代企业级数字人服务。帮助客户在社交、电商、游戏、教育等场景中，快速落地“能互动、会表演、可感知、可长期陪伴”的视频 AI 角色。

## 最小接入流程

<live-doc-step step="1" title="创建会话" description="HTTP 创建 Live 并保存 live_id / rtc 信息">

获取 [API Key](/vidu-stream/doc/api-key) 后，就可以创建会话。

**请求示例**```text
POST https://{host}/live/s_avatar/realtime
Authorization: Token vda_xxx
Content-Type: application/json
``````json
{
  "call_mode": "video",
  "avatar": {
    "persona": "你是一个友好的客服，请自然地与用户实时互动",
    "image_uri": "https://你的数字人图片地址.png",
    "voice": ""
  }
}
```保存响应里的 `live.id`，后续 WebSocket、查询账单和发送文本都会用到。保存响应里的 `rtc.token` 和 `rtc.user_id`，第 3 步加入 AliRTC 会用到。

</live-doc-step>
<live-doc-step step="2" title="发送开始信号" description="WebSocket 控制链路初始化">

首先建立链接```text
wss://{host}/live/ws/live/connect?live_id={live_id}
Authorization: Token vda_xxx
```连接建立后立刻发送 `conn_init`：```json
{
  "type": 1,
  "live_id": "123456789",
  "seq_id": 1,
  "payload": { "conn_init": { "version": 1 } }
}
```收到 `conn_init_ack.success=true` 后，说明控制链路初始化完成。`video` 模式如果收到 `NOT_READY`，等待 3 秒后重试 `conn_init`。

</live-doc-step>
<live-doc-step step="3" title="接入 RTC" description="AliRTC 收发实时音视频">

阿里云 RTC SDK 用于音视频传输，下载地址见 [阿里云 RTC SDK 文档](https://help.aliyun.com/zh/live/introduction-to-real-time-audio-and-video-artc-sdk)。```javascript
await aliRtc.joinChannel(rtc.token, rtc.user_id);
await aliRtc.publishLocalAudioStream(true);

if (callMode === 'video') {
  await aliRtc.publishLocalVideoStream(true);
}
```播放数字人还需要订阅远端音视频，并在订阅状态变为 `subscribed` 后绑定远端视频容器。

</live-doc-step>

## 接口协议概述

## 接入全流程

- 创建 Live 会话（HTTP）
- 拿到 rtc 入会信息和 live_id
- 同时建立两条链路：WebSocket 发送开始信号（控制）+ AliRTC 入会收发音视频（媒体）
- 双方就绪后开始互动
- 结束时发挂断信号并离开频道

## 接口总览

下表列出全部对外接口，所有接口都需 `Authorization: Token vda_xxx`。

| 方法 | 路径 | 用途 |
|-|-|-|
| POST | `/live/s_avatar/realtime` | 创建 Live 会话（核心入口，返回 RTC 入会与 WS 初始化信息） |
| GET | `/live/v1/lives/{live_id}` | 查询单个 Live 会话状态与账单 |
| GET | `/live/v1/lives` | 列表查询 Live 会话 |
| GET | `/live/v1/lives/{live_id}/recording` | 查询整场通话的录播文件下载地址（新增） |
| WebSocket | `/live/ws/live/connect` | App 控制信令（开始 / 文字 / 打断 / 挂断） |
| — | AliRTC `joinChannel` | 实时媒体流（麦克风 / 摄像头 / 数字人音视频） |
| POST | `/live/v1/voices/clone` | 音色克隆，创建自定义音色 |
| GET | `/live/v1/voices` | 查询自定义音色列表 |
| POST / PUT | `/tools/v2/files/uploads` | 图片上传 |

## 通用约定

| 项目 | 约定 |
|-|-|
| `{host}` | `{host}` 是域名，不包含协议。国内环境为 `api.vidu.cn`，海外环境为 `api.vidu.com`。HTTP 请求使用 `https://{host}`，WebSocket 使用 `wss://{host}`。 |
| 认证 | 所有 App 侧 HTTP 与 WebSocket 接口都需要 `Authorization: Token vda_xxx`。API Key 可在[工作台](https://platform.vidu.cn/api-keys)获取。 |
| JSON 字段 | 请求与响应字段使用 snake_case，例如 `call_mode`、`live_id`、`token_expire_at`。 |
| ID 与时间 | `live_id`、`character_id`、`created_at`、`token_expire_at` 等 int64 字段建议前端按字符串处理，避免 JavaScript number 精度问题。 |
| 媒体传输 | App WebSocket 只承载控制信令；麦克风、摄像头、数字人音视频都通过 AliRTC 传输。 |
