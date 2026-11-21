# 详细参数

## 创建会话

创建一次会话，Vidu 会用你传入的 `rtc_info` 加入你的 RTC 频道，准备推送数字人画面。

**请求头：**```http
POST /live/s_avatar/component
Authorization: Token vda_xxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```**请求体示例**```json
{
  "model": "vidu-s2",
  "image_uri": "https://example.com/avatar.jpg",
  "rtc_info": {
    "provider": "artc",
    "app_id": "your-rtc-app-id",
    "channel_id": "your-channel-id",
    "user_id": "uid-123",
    "token": "your-rtc-token"
  }
}
```**响应体示例**```json
{
  "live": {
    "id": "1234567890",
    "status": "waiting",
    "call_mode": "video",
    "avatar": {
      "image_uri": "https://signed-url/avatar.jpg"
    },
    "created_at": "1710000000",
    "start_time": "0",
    "end_time": "0",
    "trace_id": "abc123",
    "creator_id": "10000"
  },
  "client_secret": "v1.xxxx.yyyy"
}
```**请求字段说明**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | String | 枚举值：
`vidu-s1`（默认，稳定性好，不支持 `prompt_operation`）
`vidu-s2`（最新模型，灰度测试中） |
| `image_uri` | string | 条件必填，`image_uri` 和 `avatar_id` 二选一，数字人形象图片地址，支持图片 URL 和 base64。仅支持 1 张【单人】图片，支持全身 / 半身、各种风格。格式：PNG / JPG / JPEG / WEBP；图片大小 ≤ 50MB；base64 decode 后字节长度 < 20M，且需包含内容类型前缀，例如 `data:image/png;base64,{base64_encode}` |
| `avatar_id` | String | 条件必填，`image_uri` 和 `avatar_id` 二选一，具体见 [图片上传](/vidu-stream/doc/image-upload) |
| `rtc_info` | object | 必填，你的 RTC 频道信息 |
| `rtc_info.provider` | enum | 必填，`artc`（阿里）/ `trtc`（腾讯）/ `agora`（声网）/ `volcengine`（火山引擎） |
| `rtc_info.app_id` | string | 条件必填，RTC 应用 ID，与服务端配置不同时传入覆盖（provider 是 artc 时可不填） |
| `rtc_info.channel_id` | string | 条件必填，RTC 频道 ID，token 内已包含时可省略 |
| `rtc_info.user_id` | string | 条件必填，推流用户 ID，token 内已包含时可省略 |
| `rtc_info.token` | string | 必填，RTC 鉴权 token（ARTC Base64 Token / TRTC UserSig / Agora Token / 火山 RTC AccessToken） |

**响应字段说明**

| 字段 | 说明 |
| --- | --- |
| `live.id` | 直播 ID |
| `live.status` | `waiting`（数字人未就绪）；全部取值：`prepared` / `on_live` / `ending` / `ended` |
| `live.trace_id` | 链路 ID |
| `client_secret` | WebSocket 建连的短期签名 token（有效期 24h） |

## 查询直播```http
GET /live/v1/lives/{live_id}
Authorization: Token vda_xxxxxxxxxxxxxxxxxxxx
```*响应体为 `{"live": { ... }}`，结构同创建响应中的 `live` 对象。*

## WebSocket 流协议

WebSocket 是核心通道：既发控制信令，也上行 PCM 音频和转写文本。

### 建立连接```http
GET /live/v1/external-lives/{live_id}/stream?conn_id={conn_id}&client_secret={client_secret}
Connection: Upgrade
Upgrade: websocket
```*浏览器场景用 `client_secret` query 参数；服务端场景用 `Authorization` Header，二者任一即可；若同时提供，二者必须属于同一用户与同一 live，否则返回 403。*

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `live_id` | string | 必填，路径参数，创建时返回 |
| `conn_id` | string | 客户端生成的连接 ID；缺省时服务端生成 |
| `client_secret` | string | 创建下发的短期签名 token（有效期 24h） |

**连接约定**

| 项 | 约定 |
|-|-|
| 文本帧 | TextMessage + JSON（WsSignal），最大 16 MiB |
| 二进制帧 | BinaryMessage（裸 PCM 音频），最大 16 MiB |
| 首帧要求 | 必须为 `conn_init`；成功回执前上行的音频与控制信令会被丢弃（详见「信号类型」） |
| 心跳 | 服务端约每 5s 发送 ping；约 15s 未回 pong 即断开（普通数据帧不续期） |

### 通用消息格式

**请求体示例**```json
{
  "type": 1,
  "live_id": "1234567890",
  "conn_id": "app-conn-1",
  "seq_id": 1,
  "payload": { }
}
```| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | int | 信号类型，见「信号类型」 |
| `live_id` | string | 须与路径一致 |
| `user_id` | string | 用户 ID；服务端下发的回执中会携带，客户端可不传 |
| `conn_id` | string | 客户端生成的连接 ID（与建连参数一致） |
| `seq_id` | int | 客户端自增序号；`conn_init_ack` 的 `seq_id` 为请求 `seq_id + 1`（其他回执不适用） |
| `payload` | object | 按 `type` 不同携带对应子结构 |

### 信号类型

**客户端 → MaaS：**

| type | 名称 | 说明 |
|-|-|-|
| 1 | `conn_init` | 必填，连接初始化；首帧必须发送。成功回执前，上行 PCM 音频帧、`audio_interrupted`、`prompt_operation` 会被丢弃，`call_hangup` 与 `type=9/10` 仍会处理 |
| 5 | `call_hangup` | 主动挂断；直接关闭 WS 等效 |
| 7 | `audio_interrupted` | 打断数字人当前回复，最佳时机为每次 VAD 检测到用户开口时 |
| 9 | `input_transcription` | 驱动数字人动作的文本，content 为空则忽略 |
| 10 | `output_transcription` | 模型生成的回复文本；content 为空则忽略 |

**MaaS → 客户端：**

| type | 名称 | 说明 |
|-|-|-|
| 2 | `conn_init_ack` | 初始化回执 |
| 6 | `force_hangup` | 服务端强制挂断，随后服务端关闭 WS |

### 信令示例

**conn_init（type=1）**```json
{
  "type": 1,
  "seq_id": 1,
  "payload": {
    "conn_init": { "version": 1 }
  }
}
```**conn_init_ack（type=2）— 成功**```json
{
  "type": 2,
  "seq_id": 2,
  "payload": {
    "conn_init_ack": {
      "success": true,
      "error_code": "",
      "error_msg": "",
      "server_timestamp": 1710000000
    }
  }
}
```**input_transcription（type=9）** — 驱动数字人动作的文本，或者你的 ASR 识别出的用户话：```json
{
  "type": 9,
  "seq_id": 10,
  "payload": {
    "text_msg": {
      "msg_id": "msg-001",
      "content": "比个心",
      "timestamp": 1710000000000
    }
  }
}
```**output_transcription（type=10）** — 你的 LLM 生成的回复话：```json
{
  "type": 10,
  "seq_id": 11,
  "payload": {
    "text_msg": {
      "msg_id": "msg-002",
      "content": "你好！很高兴见到你。",
      "timestamp": 1710000001000
    }
  }
}
```**audio_interrupted（type=7）**```json
{
  "type": 7,
  "seq_id": 12,
  "payload": { }
}
```**call_hangup（type=5）**```json
{
  "type": 5,
  "seq_id": 13,
  "payload": {
    "hangup": { "hangup_reason": "client_hangup" }
  }
}
```**force_hangup（type=6）**```json
{
  "type": 6,
  "payload": {
    "hangup": { "hangup_reason": "timeout" }
  }
}
```### 音频二进制帧

通过 WebSocket BinaryMessage 发送，无 JSON 封装，直接传输原始 PCM 字节流。

| 参数 | 值 |
|-|-|
| 编码 | PCM 16-bit 有符号小端（s16le） |
| 采样率 | 24,000 Hz |
| 声道 | 单声道（mono） |
| 数据速率 | 48 字节 / 毫秒 |
| 建议帧大小 | 20ms（960 字节）或 100ms（4,800 字节） |

## 错误响应及说明

建连被拒绝时返回 HTTP 状态码：

| HTTP 状态码 | 场景 | 处理建议 |
|-|-|-|
| `401` | header 与 `client_secret` 均缺失，或 `client_secret` 无效 / 过期 | 补充或更新相关信息 |
| `403` | live 不属于当前用户 | 更换 live 或者 API key |
| `400` | 非外接 live、live 已结束、`live_id` 非法 | 确认 live 信息 |
| `409` | 该 live 已有活跃连接 | 查阅 live 状态 |

建连成功后，初始化结果通过 `conn_init_ack` 返回，其中的 `error_code` 取值如下：

| error_code | 场景 | 处理建议 |
|-|-|-|
| `NOT_READY` | 渲染服务未就绪 | 稍后重试 `conn_init`，**无需重连 WS** |
| `LIVE_ENDED` | live 已结束 | 需重新创建 |
| `LIVE_CONN_INIT_FAILED` | 其他初始化失败 | 关闭当前 WS，重新创建；仍失败则带 `live_id` / `trace_id` 反馈 |

## 接入要点

- 首帧必须是 `conn_init`；`NOT_READY` 属正常现象，重试 `conn_init` 即可，不要重连 WS。
- 保持心跳：及时响应服务端 ping；约 15s 未回 pong 会被判定为死连接并断开。
- 建议服务端代理 WebSocket 鉴权，避免 Vidu API Key 泄漏到浏览器端。
- 目前已支持阿里（artc）、腾讯（trtc）、声网（agora）和火山引擎（volcengine）的 RTC。

## 定价信息

- 按秒计费，每秒 1 积分（0.03125 元）
- 如果用户账户余额的最小积分数小于 45 积分（约 1.4 元），则无法发起任务

## FAQ

### Q1：阿里的ARTC入口在哪里。

使用阿里RTC，容易进错入口，请使用这个地址：[https://live.console.aliyun.com/#/liveRtc/list](https://live.console.aliyun.com/#/liveRtc/list)。具体操作为在**视频直播控制台** → 左侧导航栏的 **直播+ &gt; 实时音视频 &gt; 应用管理** &gt; **创建应用**。

创建完成后点「管理」，在基本信息页获取 **AppID** 与 **AppKey**。

### Q2：在linux环境接入腾讯的TRTC，但无法连通

Linux服务端不能使用体验包，需要购买旗舰版且找客服开通权限才可使用。以下环境可以使用体验包且不需要客服：iOS、Android、HarmonyOS、Mac、Windows、Web、Electron、Flutter、uni-app、微信小程序
