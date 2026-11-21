# 详细参数

## 创建任务

创建一次数字人视频生成任务，返回任务 ID 与初始状态，生成结果通过「查询任务」接口或回调获取。

**请求**```plaintext
POST https://{host}/ent/s_avatar/offline
Authorization: Token vda_xxx
Content-Type: application/json
```**请求体示例**```json
{
  "model": "vidu-s2",
  "image": "https://scene.vidu.zone/media-asset/084945-xpk47RWYcBgJ27nJ.png",
  "audio": "https://scene.vidu.zone/media-asset/085244-FrJjNf5tKjiZHQkf.mp3",
  "timeline": "{\"actions\":[{\"text\":\"比个心\",\"time_range\":[2,10]}]}",
  "resolution": "720p",
  "callback_url": "https://api.example.com/vidu/callback",
  "payload": "biz-order-20260903-001",
  "watermark": true,
  "wm_position": "bottom_right",
  "wm_url": "https://你的水印图地址.png",
  "meta_data": "{\"Label\":\"your_label\"}"
}
```**响应示例**```json
{
  "task_id": "123456789",
  "state": "created",
  "model": "vidu-s2",
  "resolution": "720p",
  "created_at": "2026-08-03T03:00:00Z"
}
```### 基础字段说明

| 字段 | 类型 | 必填 | 说明 |
|-|-|-|-|
| `model` | string | 否 | 模型，默认值：`vidu-s2` |
| `image` | string | 是 | 角色图片，支持两种形式：公网 URL、base64（须含 MIME 前缀，例如 `data:image/png;base64,{base64_encode}`） |
| `audio` | string | 条件必填 | 语音音频，支持 URL / base64。与 `text` **至少传一个**；两者都传时以 `audio` 为准 |
| `text` | string | 条件必填 | 说话文本，与 `audio` 至少传一个（两者都传时以 `audio` 为准）。UTF-8 编码，≤ 10000 字符；传 `text` 时系统将其合成为语音 |
| `voice` | string | 否 | 音色，不传时使用默认音色。仅 text 模式（未传 `audio`）生效；可选值见[音色列表](/vidu-stream/doc/voice-list) |
| `timeline` | string | 否 | 动作时间轴，序列化后的 ActionContent JSON 字符串，格式见[timeline]章节。不传时由系统基于音频自动生成 |
| `resolution` | string | 否 | 分辨率。可选值：720P（默认）、1080P、2K |
| `callback_url` | string | 否 | 任务状态变化时的回调地址，详见「回调协议」章节 |
| `payload` | string | 否 | 透传参数，不做任何处理，在响应与查询结果中原样返回，常用于关联业务订单号 |
| `watermark` | bool | 否 | 是否加水印，不传时默认加水印（传 `false` 才不加水印）；加水印后可通过查询接口的 `watermarked_url` 获取带水印视频 |
| `wm_position` | enum | 否 | 「内容由 AI 生成」标识在画面中的位置，仅在 watermark=true 时生效。可选值：top_left、top_right、bottom_left、bottom_right；默认 bottom_right。注意：该字段控制的是 AI 生成合规标识的位置，Vidu 品牌水印固定在右下角，不受此字段影响。枚举名不合法时请求会返回 400；未传时按默认位置处理 |
| `wm_url` | string | 否 | 自定义水印图片 URL。 |
| `meta_data` | string | 否 | 透传元数据，JSON 格式字符串。为空时使用 Vidu 生成的默认元数据标识 |

### image / audio：素材传入方式

`image` 与 `audio` 都接受两种形式，任选其一，不能混写在同一字段里。

| 形式 | 说明 |
|-|-|
| 公网 URL | 最常用。须是服务端可访问的 HTTP(S) 地址；下载失败会返回 `ImageDownloadFailure` |
| base64 | 须包含内容类型前缀，例如 `data:image/png;base64,{base64_encode}`。注意 HTTP 请求体本身有大小上限，大文件建议改用 URL |

> 注：旧版文档还列过 `ssupload:?id=<素材ID>`，当前参数页已不再列出；「简介」页仍写着三种形式，两页不一致。本项目上传仍按 base64 直传，不依赖该形式。

*`image` 仅支持 **1 张单人图片**，全身 / 半身、各种风格均可。图片人体或人脸检测不通过时任务会失败，对应 `ImageCheckBodyJointsFailed`、`ImageCheckFaceFailed`、`ImageObjectsUndetected` 等错误码，此时需更换角色图重试。*

### timeline：动作时间轴格式

`timeline` 的值是**序列化后的 JSON 字符串**，不是 JSON 对象，在请求体中需要对内部引号转义。

| 字段 | 类型 | 说明 |
|-|-|-|
| `actions` | Array | 动作列表，按时间段描述数字人的动作 |
| `actions[].text` | string | 动作描述文本。可以是「比个心」这类短指令，也可以是包含表情、视线、肢体位置的详细描述，描述越具体动作越可控 |
| `actions[].time_range` | Array[uint32] | 动作起止时间（秒），**必须包含 2 个 uint32**，依次为开始时间、结束时间，建议动作间隔不要小于5秒 |

*注意：不传 `timeline` 时，系统基于音频自动生成动作时间轴，适合不需要精确控制动作的场景。*

**调用示例**

**audio 模式：**传入音频 + 详细动作描述```bash {wrap}
curl -X POST "https://api.vidu.cn/ent/s_avatar/offline" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Token {your_api_key}' \
  -d '{
    "image": "https://scene.vidu.zone/media-asset/084945-xpk47RWYcBgJ27nJ.png",
    "audio": "https://scene.vidu.zone/media-asset/085244-FrJjNf5tKjiZHQkf.mp3",
    "timeline": "{\"actions\":[{\"text\":\"女主播面带微笑看向镜头，左手自然举着薄荷绿色护肤品在胸前位置，头部轻轻点动打招呼，嘴巴自然张开说话，眼神亲切柔和\",\"time_range\":[0,4]}]}"
  }'
```**text + voice 模式：**不传 `audio`，系统把说话文本合成为语音，并自动生成动作时间轴```bash
curl -X POST "https://api.vidu.cn/ent/s_avatar/offline" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Token {your_api_key}' \
  -d '{
    "image": "https://example.com/input/avatar.png",
    "text": "大家好，今天给大家介绍一款很棒的产品",
    "voice": "female-shaonv"
  }'
```### 响应字段说明

| 字段 | 类型 | 说明 |
|-|-|-|
| `task_id` | int64 | 任务 ID，用于查询任务状态，务必保存 |
| `state` | enum | 任务状态，复用平台现有 State 枚举；创建成功时通常为 `created` |
| `model` | string | 模型标识 |
| `resolution` | string | 分辨率 |
| `payload` | string | 透传参数原样返回 |
| `created_at` | timestamp | 任务创建时间 |

*说明：本接口不返回积分消耗；积分的预扣与退还时机见「定价信息」。*

*注意：创建成功只代表任务已受理，**不代表视频已生成**。必须用返回的 `task_id` 轮询查询接口，或配置 `callback_url` 等待回调。*

## 查询任务

按任务 ID 返回状态、积分消耗、错误信息与生成物列表。

**请求示例**```plaintext
GET https://{host}/ent/v2/tasks/{task_id}/creations
Authorization: Token vda_xxx
Content-Type: application/json
```**响应示例**```json
{
  "id": "995640066728538112",
  "state": "success",
  "progress": 100,
  "err_code": "",
  "err_msg": "",
  "credits": 18,
  "duration": 18,
  "type": "offline_avatar",
  "model": "vidu-s1",
  "resolution": "720p",
  "payload": "",
  "blocked_resources": [],
  "creations": [
    {
      "id": "995640297138438144",
      "url": "https://.../video.mp4?X-Amz-Expires=86400&...",
      "cover_url": "https://.../cover.jpeg?X-Amz-Expires=86400&...",
      "watermarked_url": "https://.../watermarked.mp4?X-Amz-Expires=86400&..."
    }
  ]
}
```### 响应体字段说明

| 字段 | 子字段 | 类型 | 说明 |
|-|-|-|-|
| `id` | | String | 任务 ID |
| `state` | | String | 处理状态，取值见下方「state 枚举」 |
| `progress` | | Number | 任务进度百分比，**可能是小数**（如 33.05）。**该值非线性推进：排队与处理阶段会阶梯式上升并长时间停在 99，只有进入 `success`/`failed` 才会变成 100，属正常现象**。仅供展示，**不要用它判断任务是否卡死**——超时判断请用挂钟时间 |
| `err_code` | | String | 错误码，取值见「错误码」章节；无错误时为空串 |
| `err_msg` | | String | 错误的详细描述，无错误时为空串。**排障时以该字段为准**：`err_code` 只给出错误分类，具体原因（哪个字段、哪张图不合格）在这里 |
| `credits` | | Int | 该任务实际消耗的积分数量，数值等于 `duration`（1 秒 1 积分）。实际扣费以本接口为准，积分扣除时机见「定价信息」 |
| `duration` | | Int | 生成视频的时长，单位：秒。计费依据 |
| `type` | | String | 任务类型，非实时数字人固定为 `offline_avatar` |
| `model` | | String | 实际使用的模型标识。 |
| `resolution` | | String | 实际输出分辨率 |
| `payload` | | String | 本次任务调用时传入的透传参数 |
| `blocked_resources` | | Array | 被风控拦截的资源列表，正常为空数组 |
| `creations` | | Array | 生成物结果。**仅在 `state=success` 后读取** |
| | `id` | String | 生成物 ID，用来标识不同的生成物 |
| | `url` | String | 生成物视频 URL（无水印），**24 小时有效期** |
| | `cover_url` | String | 生成物封面，24 小时有效期 |
| | `watermarked_url` | String | 带水印的生成物 URL，24 小时有效期。**默认加水印**：未传 `watermark` 时该字段有值；显式传 `watermark=false` 时该字段为空。需要无水印视频请取 `url` |

*注意：`url`、`cover_url`、`watermarked_url` 都是**临时地址，24 小时后失效**。请在拿到后及时转存到自己的存储，不要直接落库当作永久链接对外分发*

### state 枚举

| 取值 | 含义 | 是否终态 |
|-|-|-|
| `created` | 创建成功 | 否，继续轮询 |
| `queueing` | 任务排队中 | 否，继续轮询 |
| `processing` | 任务处理中 | 否，继续轮询 |
| `success` | 任务成功 | 是，读取 `creations[]` |
| `failed` | 任务失败 | 是，读取 `err_code` |

*轮询间隔建议 **3～5 秒**起步并逐步退避，不要低于 2 秒，否则可能触发 `TooManyRequests`*

**调用示例**```bash
curl -X GET "https://api.vidu.cn/ent/v2/tasks/{your_task_id}/creations" \
  -H "Authorization: Token {your_api_key}"
```## 回调协议

创建任务时传入 `callback_url` 后，任务状态变化时 Vidu 会向该地址发起 **POST** 请求，可用于替代轮询。

- 回调请求体结构与「查询任务」接口的返回体一致。
- 回调触发的状态包括：`processing`（任务处理中）、`success`（任务完成）、`failed`（任务失败）。
- `success` 与 `failed` 的回调如发送失败会重试，最多投递 4 次（首次 + 最多 3 次重试，重试间隔 3s / 5s / 10s）。
- 回调采用 HMAC-SHA256 签名认证，业务侧应校验签名后再信任回调内容。

### 签名算法```plaintext
signature = base64(HMAC-SHA256(secret_key, signingString))

signingString = http_method + "\n"
              + http_uri + "\n"
              + canonical_query_string + "\n"
              + access_key + "\n"
              + Date + "\n"
              + signed_headers_string
```| 参数 | 说明 |
|-|-|
| `secret_key` | 创建任务时使用的 token |
| `http_method` | HTTP 请求方法，必须全大写，回调为 `POST` |
| `http_uri` | 从 `callback_url` 中用标准 URL 解析提取的路径部分，必须以 `/` 开头，空路径为 `/` |
| `canonical_query_string` | 从 `callback_url` 中提取的查询参数部分，无查询参数则为空字符串 |
| `access_key` | API 标识符，固定为 `vidu` |
| `Date` | 请求头中的 `Date`，GMT 格式 |
| `signed_headers_string` | 按 `X-HMAC-SIGNED-HEADERS` 指定的顺序，把对应请求头拼成 `Key:Value\n` 的多行字符串（末尾保留换行符） |

### 回调请求头

| 请求头 | 说明 |
|-|-|
| `Date` | GMT 格式时间，例如 `Tue, 06 May 2025 12:09:42 GMT` |
| `x-request-nonce` | 随机字符串，用于防止重放攻击 |
| `X-HMAC-SIGNED-HEADERS` | 签名中使用的头部字段列表，用分号分隔，例如 `Date;x-request-nonce` |
| `X-HMAC-SIGNATURE` | 最终计算出的签名 |
| `X-HMAC-ALGORITHM` | 签名算法，固定为 `hmac-sha256` |
| `X-HMAC-ACCESS-KEY` | 访问密钥标识符，固定为 `vidu` |

以回调地址 `http://127.0.0.1:8080/vidu/callback?name=james&age=36` 为例，生成的签名字符串为：```http
POST
/vidu/callback
name=james&age=36
vidu
Tue, 06 May 2025 12:09:42 GMT
Date:Tue, 06 May 2025 12:09:42 GMT
x-request-nonce:123e4567-e89b-12d3-a456-426614174000
```*签名字符串**末尾有一个换行符**；路径与查询参数都用标准 URL 解析库从 `callback_url` 中提取，不要手工拼接。*

## 错误码

任务失败时 `err_code` 的常见取值如下，其中[素材类]错误需更换角色图或音频后重试，[配额类]错误需调整调用节奏或联系商务。其后列出的错误由请求本身触发，出现在 HTTP 响应体的 `reason` 字段中，不是任务的 `err_code`。

| 错误码 | 错误描述 | 处理建议 |
|-|-|-|
| `FieldInvalid` | 传入参数未通过合法性校验 | 检查 `resolution`、`timeline` 等字段取值与格式 |
| `ImageDownloadFailure` | 下载图片 URL 失败 | 确认图片地址服务端可访问、未鉴权、未过期 |
| `ImageFormatInvalid` | 图像格式不符合要求 | 改用 PNG / JPG / JPEG / WEBP 格式 |
| `ImageSizeInvalid` | 图片尺寸过大或过小 | 调整图片尺寸后重试 |
| `ImageCheckFaceFailed` | 输入图人脸检测失败 | 更换正面清晰、人脸完整的单人图 |
| `ImageCheckBodyJointsFailed` | 输入图人体检测失败 | 更换人体关键部位可见的角色图 |
| `ImageObjectsUndetected` | 输入图的人体或人脸有遮挡 | 更换无遮挡的角色图 |
| `NoFaceDetected` | 检测不到人脸 | 更换含清晰人脸的角色图 |
| `MultiFaceDetected` | 多人检测失败 | 仅支持单人图，裁剪为单人后重试 |
| `AuditSubmitIllegal` | 输入没有通过安全审核 | 调整输入素材或文本内容 |
| `CreationPolicyViolation` | 生成物触发风控 | 调整输入后重试 |
| `CreditInsufficient` | 积分不足 | 充值后重试 |
| `UserCancelled` | 用户手动终止任务执行 | 无需处理 |
| `InternalServiceFailure` | 服务器内部错误 | 可短暂重试；持续失败请带上 `task_id` 与请求时间反馈排查 |

**请求错误（由请求本身触发的 HTTP 错误，字段是 `reason`，不是任务的 `err_code`）**

| reason | 错误描述 | 处理建议 |
|-|-|-|
| `BadRequest` | 不合法的请求 | 对照本页字段说明修正请求 |
| `FieldLacking` | 缺少字段，具体字段见错误信息 | 补齐必填字段；注意 `audio` 与 `text` 至少传一个 |
| `QuotaExceeded` | 超过并发限制 | 降低并发；需提升配额请联系商务 |
| `TooManyRequests` | 请求太频繁 | 降低轮询频率，采用退避重试 |
| `TaskNotFound` | task_id 没找到 | 确认 `task_id` 正确，且属于当前 API Key 对应账号 |
| `Unauthorized` | 未鉴权 | 检查 `Authorization: Token vda_xxx` 是否正确 |
| `Forbidden` | 请求没有权限 | 确认使用创建该任务时的同一个 API Key |

## 接入要点

- `image` 必填且仅支持 1 张单人图；`audio` 与 `text` 至少传一个，双传时 `audio` 优先。
- `voice` 只在未传 `audio` 的 text 模式下生效，传了 `audio` 时设置 `voice` 不会有效果。
- `timeline` 是序列化后的 JSON **字符串**，不是 JSON 对象，注意引号转义；`time_range` 必须是 2 个 uint32。
- 轮询要有退避、总超时和取消；只在 `state=success` 后读 `creations[]`。
- 生成物地址 24 小时过期，需长期留存必须及时转存。
- 配置 `callback_url` 时务必校验 HMAC 签名，不要无条件信任回调内容。
- 任务是异步的，必须实现轮询或回调。
- 只有 `state=success` 才读 `creations[]`；`failed` 时以 `err_code` 为准判断是参数问题、审核问题还是积分问题。

## 定价信息

- 按视频时长计费，每秒 1 积分（0.03125 元），时长按输入音频实际时长向上取整；传 `text` 时按合成语音的时长计费（约 2-3 个字/秒）。
- 余额低于 45 积分（约 1.4 元）就不能发起任务
- **积分扣除时机**：创建接口只做余额预检，不扣积分；任务进入排队时按预估时长一次性预扣。任务失败或未产出生成物时，未实际消耗的部分会自动退还；最终扣减结果以查询接口返回的 `credits` 为准（`failed` 时为 0）。
