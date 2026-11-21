# 详细参数

## 创建直播流

创建一条编辑直播流。创建成功后直播进入等待状态，你需要完成 WebSocket 连接与 RTC 入会后开播。

**请求示例**```bash
curl -X POST "https://api.vidu.cn/live/s_editing/realtime" \
  -H "Authorization: vda_<your_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://example.com/reference.png",
    "editing_type": "style_transfer",
    "rtmp_urls": ["rtmp://push.example.com/live/stream1"]
  }'
```**响应示例**```json
{
  "live": {
    "id": "995200676634042368",
    "live_duration": 120,
    "status": "waiting",
    "call_mode": "video",
    "created_at": "1789025863",
    "trace_id": "d17ab29172bef09b3f093b169c233e67"
  },
  "rtc": {
    "app_id": "xxx",
    "channel_id": "xxx",
    "user_id": "xxx",
    "token": "xxx",
    "token_expire_at": "1789033063"
  },
  "render_uid": "xxx",
  "client_secret": "xxx"
}
```**请求头**

| 请求头 | 说明 |
|-|-|
| `Authorization` | `vda_<your_api_key>`，**不带** `Token` 前缀 |
| `Content-Type` | `application/json` |
| `X-Request-ID` | 可选。36 字符内的唯一请求标识（推荐 UUID），仅用于请求追踪与问题排查。 |

**请求参数**

| 参数名称 | 类型 | 说明 |
|-|-|-|
| `image_url` | string | 必填，编辑用参考图。支持三种形式：平台上传 URI（`ssupload:?id=...`）、base64 data URI（`data:image/*;base64,...`）、http(s) URL。 |
| `editing_type` | string | 编辑场景类型，style_transfer（整体风格迁移，默认值）、virtual_tryon（虚拟试穿）、subject_replacement（主体替换）、background_replacement（背景替换） |
| `rtmp_urls` | string[] | RTMP 转推地址，最多 5 个。每项必须以 `rtmp://` 开头且不超过 2048 字符。传入后直播开始时把合成结果单路转推到这些地址；不传或空数组不开启转推。重复地址服务端按原顺序去重。 |

**响应参数**

| 字段 | 类型 | 说明 |
|-|-|-|
| `live` | object | 直播对象，常用字段见下方「`live` 对象字段」。 |
| `rtc` | object | RTC 入会凭证：`app_id`、`channel_id`、`user_id`、`token`、`token_expire_at`（Unix 时间戳，秒）。用阿里云 RTC（AliRTC）SDK 加入频道后发布编辑输入流。 |
| `render_uid` | string | 推送实时渲染流的UID。入会后订阅该用户以获取渲染后的实时流。 |
| `client_secret` | string | 浏览器建立 WebSocket 连接用的短期凭证，有效期与 `rtc.token_expire_at` 一致；在 `/ws/live/connect` 的 query 中传入。服务端集成可改用 `Authorization` 请求头，无需该字段。 |

**live对象字段**

| 字段 | 类型 | 说明 |
|-|-|-|
| `id` | string | 直播 ID（`live_id`），后续建连与信令均使用该值。 |
| `status` | string | 直播状态，见「直播状态」枚举。 |
| `live_duration` | integer | 单场直播最大时长（秒）。 |
| `created_at` / `start_time` / `end_time` | string（Unix 时间戳，秒） | 创建 / 开播 / 结束时间；未开播或未结束时为 `0`。 |
| `close_reason` | string | 直播结束原因，常见值：并发超限、创建下游失败、转推启动失败等。 |
| `trace_id` | string | 链路追踪 ID，排查问题时提供给平台支持人员。 |

**status枚举值**

| 取值 | 说明 |
|-|-|
| `waiting` | 已创建，等待客户端连接与开播。 |
| `prepared` | 连接中（过渡态）。 |
| `on_live` | 直播中，正常计费。 |
| `ending` | 结束中（过渡态）。 |
| `ended` | 已结束。 |

## 建立 WebSocket 连接

创建成功后，建立 WebSocket 控制连接。服务端集成可在握手请求头中携带 `Authorization`；浏览器无法自定义 WebSocket 请求头，改为把创建接口返回的 `client_secret` 作为 query 参数传入。```text
# 浏览器：client_secret 作为 query 参数
wss://api.vidu.cn/live/ws/live/connect?live_id=<live_id>&conn_id=<conn_id>&client_secret=<client_secret>

# 服务端集成：Authorization 请求头
wss://api.vidu.cn/live/ws/live/connect?live_id=<live_id>&conn_id=<conn_id>
Authorization: vda_<your_api_key>
```| 参数 | 位置 | 说明 |
|-|-|-|
| `Authorization` | 请求头 | 可选，服务端集成推荐。`vda_<your_api_key>`，**不带** `Token` 前缀。与 `client_secret` 同时提供时，两者身份必须一致。 |
| `live_id` | Query | 必填，创建接口返回的 `live.id`。 |
| `conn_id` | Query | 客户端生成的连接 ID（建议随机字符串），同一连接内保持不变，用于信令回执关联。不传时由服务端生成，重连须复用首次连接的值。 |
| `client_secret` | Query | 浏览器场景必填（请求头未携带 `Authorization` 时必填）。取创建接口返回的 `client_secret`，有效期与 `rtc.token_expire_at` 一致。 |

连接建立后按「WebSocket 信令」收发消息。连接意外断开后可在宽限时间内重连复用同一 `live_id` 与 `conn_id`；超时未重连直播将结束并停止计费。

## 连接初始化信令（type=1 / type=2）

建连后必须立即发送 `conn_init` 初始化连接，服务端返回 `conn_init_ack`。成功回执返回时直播进入 `on_live` 并开始计费。

**请求示例**```json
{
  "type": 1,
  "live_id": "995200676634042368",
  "conn_id": "conn-xxx",
  "seq_id": 1,
  "payload": { "conn_init": { "version": 1 } }
}
```**成功回执示例**```json
{
  "type": 2,
  "live_id": "995200676634042368",
  "conn_id": "conn-xxx",
  "seq_id": 2,
  "payload": {
    "conn_init_ack": {
      "success": true,
      "error_code": "",
      "error_msg": "",
      "server_timestamp": "1789025863"
    }
  }
}
```失败时 `success=false`，`error_code` 取「WebSocket 业务错误」中的 `NOT_READY` / `SIP_READY_TIMEOUT` / `LIVE_ENDED` / `LIVE_CONN_INIT_FAILED`，按对应说明处理。回执的 `seq_id` 为请求 `seq_id` + 1。

## 换图 / 换场景信令（type=13）

**请求示例**```json
{
  "type": 13,
  "live_id": "995200676634042368",
  "conn_id": "conn-xxx",
  "seq_id": 2,
  "payload": {
    "switch_prompt": {
      "prompts": [{ "type": "image", "content": "https://example.com/new-reference.png" }],
      "editing_type": "virtual_tryon"
    }
  }
}
```| 参数 | 说明 |
|-|-|
| `prompts` | 参考图数组，最多 1 个且必须为 `type=image`。`content` 支持平台上传 URI、base64 data URI、http(s) URL，格式与创建时的 `image_url` 一致。不传时沿用最近一次传入的参考图。
注意, websocket 单条消息大小上限 16MB，使用base64时需要注意发送的帧大小 |
| `editing_type` | 编辑场景类型：`style_transfer`（整体风格迁移）、`virtual_tryon`（虚拟试穿）、`subject_replacement`（主体替换）、`background_replacement`（背景替换）。不传时沿用最近一次传入的场景；仅传 `prompts` 时即为「只换图不换场景」。 |

*直播中更换参考图或编辑场景，`prompts` 与 `editing_type`* ***至少传其一****，可同时传；两者都不传时该信令无效。成功时不返回任何回执，合成画面将在数秒内切换为新参考图 / 新场景；失败时返回 `type=14` 失败回执（`success=false`，携带 `error_code` / `error_msg`），可修正后携带新的 `seq_id` 重发。服务端不对信令去重，重复发送会重复触发切换。*

## 挂断（type=5）

结束时发送挂断信令，服务端停止直播与计费并关闭连接

**请求示例**```json
{
  "type": 5,
  "live_id": "995200676634042368",
  "conn_id": "conn-xxx",
  "seq_id": 3,
  "payload": { "hangup": { "hangup_reason": "user_hangup" } }
}
```## 推流与订阅

使用阿里云 RTC（AliRTC）SDK，以创建返回的 `rtc` 凭证（`app_id` / `channel_id` / `user_id` / `token`）加入频道。客户端需要单独集成 AliRTC SDK，Web 端可参考[阿里云 RTC Web SDK 文档](https://help.aliyun.com/zh/live/quick-use?spm=a2c4g.11186623.help-menu-29949.d_1_1_7_4_1.309729ea6qpZJK)，并在页面中加载对应 SDK。

- 发布编辑输入流：入会后发布摄像头画面（或本地视频文件流），作为编辑输入。
- 订阅合成结果：订阅频道内 render_uid 用户的视频流，即实时编辑合成画面。
- 凭证有效期：在 token_expire_at 前完成入会。直播超过单场最大时长会自动结束。

## RTMP 转推

创建时传入 `rtmp_urls` 即开启转推。直播开始时，服务端把合成结果（即 `render_uid` 的渲染流）原样单路转推到提供的每个地址；你可在对应的直播平台用播放地址（如 FLV / HLS）拉流观看。

- 转推地址必须是你自有直播平台的推流地址（`rtmp://`），推流与播放地址由你的直播平台提供。
- 同一推流地址**不可同时用于多条直播**；直播结束后短时间内（约 10 秒）不可立即复用同一地址。
- 转推为原始流转发，画质、分辨率与频道内 `render_uid` 渲染流一致。
- 若转推启动失败，直播会直接结束（结束原因见 `live.close_reason`），请确认地址有效后重新创建。

## 错误响应

## HTTP 错误

创建接口失败时返回 HTTP 状态码，响应体结构如下：```json
{
  "code": 400,
  "reason": "BAD_REQUEST",
  "message": "参数非法",
  "metadata": {}
}
```失败时 `metadata` 中可能携带 `trace_id`，联系平台支持时请一并提供。

| HTTP 状态码 | 场景 | 说明 |
|-|-|-|
| 400 | `image_url` 缺失或格式不支持 | 仅支持平台上传 URI、base64 data URI、http(s) URL 三种形式。 |
| 400 | `rtmp_urls` 非法 | 存在非 `rtmp://` 前缀、单项超过 2048 字符或地址数超过 5 个的项。 |
| 400 | `editing_type` 非法 | 取值不在枚举范围内。 |
| 400 | 账户积分不足 | 低于创建所需最低积分（错误码 `CreditInsufficient`），请充值后重试。 |
| 429 | 并发直播数超限 | 同一账户同时进行的直播数达到上限，请先结束进行中的直播。 |

## WebSocket 业务错误

连接初始化失败随 `type=2` 回执返回，换图失败随 `type=14` 回执返回（`success=false`），错误原因在 `error_code` 字段中：

| error_code | 说明 |
|-|-|
| `NOT_READY` | 初始化时服务端尚未就绪，随 `type=2` 回执返回。请稍后由客户端重发 `conn_init`；重试有服务端预算上限，超限后直播会结束并返回终态错误，此时应停止重试。 |
| `SIP_READY_TIMEOUT` | 服务端就绪重试超过上限，直播已结束，请重新创建直播流。 |
| `LIVE_ENDED` | 直播已结束（或已被平台关闭），请重新创建直播流。 |
| `LIVE_CONN_INIT_FAILED` | 初始化失败，错误未归类。可稍后重试 `conn_init`；若持续失败请联系平台支持并提供 `trace_id`。 |
| `SWITCH_PROMPT_INVALID` | 参数非法，如缺少图片与场景、图片数量或格式不符合要求。 |
| `LIVE_NOT_ACTIVE` | 直播不在进行中（未开播或已结束）。 |
| `RENDER_NOT_READY` | 渲染服务未就绪，稍后重试。 |
| `SWITCH_PROMPT_EXPIRED` | 信令已过期，请携带新 `seq_id` 重发。 |
| `RENDER_WRITE_FAILED` | 下发渲染服务失败，请重试。 |
| `SWITCH_PROMPT_TIMEOUT` | 处理超时，请重试。 |
| `SWITCH_PROMPT_INTERNAL_ERROR` | 服务内部错误。若持续出现，请联系平台支持并提供 `trace_id`。 |

## 计费说明

直播按实际直播时长（秒）计费，直播结束后结算尾差。每秒1积分（0.03125元）

**计费区间**：从服务端返回 `conn_init_ack.success=true`（直播进入 `on_live`）起算，到发送挂断信令直播结束为止。**仅建立 WebSocket 连接或仅入 RTC 频道不计费**。

直播结束后可通过 `GET /live/v1/lives/{live_id}`（用 `live.id`）查看 `billed_seconds`（已计费秒数）与 `credits_cost`（已消耗积分）。

## FAQ

### Q1：WebSocket 连上了但一直没有任何响应

这是预期行为，不是故障。服务端在握手成功后不会主动发送任何消息，等待客户端发出 `conn_init`。请检查：

1. 建连后是否立即发送了 `type=1` 的 `conn_init` 信令。
2. `live_id` 与 `conn_id` 是否与建连 query 参数完全一致（注意 `live_id` 在 JSON 中必须是字符串，不能传数字）。

### Q2：建连返回 401 Unauthorized

按以下顺序排查：

1. `client_secret` 是否已过期。超时后建连会被直接拒绝。请重新创建直播流，不要在过期凭证上排查网络问题。
2. **`client_secret` 是否属于这条直播。**凭证与 `live_id` 绑定，用 A 场直播的凭证连 B 场会被拒。
3. **API Key 是否与接入环境匹配。**国内 Key 连海外域名（或反之）会被拒。

### Q3：换图没有回执，是失败了吗

不是。`switch_prompt` 成功时**不返回任何回执**，这是设计如此。只有失败时才会收到 `type=14`。此外服务端不对该信令去重，重复发送会重复触发切换，请勿用「没回执就重发」的策略。

### Q4：curl 能测 WebSocket 吗

可以测握手，但不能收发信令。部分系统自带的 curl 未编译 WebSocket 协议，会直接报 `Protocol "wss" not supported`，这与服务端无关。需要真实收发信令时，请使用支持 WebSocket 的客户端（浏览器 DevTools、Node.js 的 `WebSocket`、Python 的 `websockets` 等）。
