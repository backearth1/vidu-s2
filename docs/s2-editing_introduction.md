# 整体介绍

这是 Vidu S 产品面向 B 端客户提供的实时视频编辑能力：模型持续接收你推送的视频流，实时输出编辑后的视频流。它是流式的——画面边推边改，且可以在不中断视频流的前提下随时更换参考图或切换编辑场景。

| 四种能力 | 介绍 |
|-|-|
| 风格渲染 `style_transfer` | 按参考图风格重绘直播画面，常见于二次元化、艺术风格化直播。 |
| 角色替换 `subject_replacement` | 把画面中的人物替换为参考图角色，保留原有动作、表情与镜头节奏。 |
| 背景替换 `background_replacement` | 替换画面背景为参考图场景，保持主体与前景关系不变。 |
| 虚拟换衣 `virtual_tryon` | 按参考图为画面中的人物换装，保持姿态与身体结构。 |

## 最小接入流程

<live-doc-step step="1" title="创建编辑流" description="HTTP 创建并保存 live_id / rtc 信息">

[获取api key](/vidu-stream/doc/api-key)后，调用创建接口，拿到后续所需的全部凭证。```bash
curl -X POST "https://api.vidu.cn/live/s_editing/realtime" \
  -H "Authorization: vda_<your_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://example.com/reference.png",
    "editing_type": "style_transfer"
  }'
```*`image_url`：参考图，支持 http(s) URL、base64 data URI（本地选图自动转换）、平台上传 URI。服务端返回 `live`、`client_secret`、`rtc`（AliRTC 入会凭证）与 `render_uid`（渲染流用户 ID，入会后订阅该用户的视频流即合成结果）。*

</live-doc-step>
<live-doc-step step="2" title="第二步：建连、入会后开播" description="AliRTC 推送输入并订阅结果">

**先建 WebSocket 控制连接**，建连成功不代表已开播：```text
# 浏览器：client_secret 作为 query 参数
wss://api.vidu.cn/live/ws/live/connect?live_id=<live_id>&conn_id=<conn_id>&client_secret=<client_secret>

# 服务端集成：Authorization 请求头
wss://api.vidu.cn/live/ws/live/connect?live_id=<live_id>&conn_id=<conn_id>
Authorization: vda_<your_api_key>
```**连接建立后立即发送初始化信令**。服务端不会主动说任何话，必须由客户端发出这一帧```json
{
  "type": 1,
  "live_id": "995200676634042368",
  "conn_id": "conn-xxx",
  "seq_id": 1,
  "payload": { "conn_init": { "version": 1 } }
}
```*服务端在「客户端就绪」与「渲染服务就绪」双方都满足后返回 `conn_init_ack.success=true`。若开启了 RTMP 转推，此刻转推已启动。若返回 `error_code: "NOT_READY"`，表示渲染服务尚未就绪，客户端应稍后重发初始化信令；重试有服务端预算上限，超限后直播会结束，需要重新创建。*

**然后加入 RTC 频道**，用创建返回的 `rtc` 凭证调 AliRTC 的 `joinChannel`，发布你的摄像头画面或本地视频流作为编辑输入：```javascript
// 1) 入会；第二参为展示名，可直接用 rtc.user_id
await aliRtc.joinChannel(rtc.token, rtc.user_id);
// 2) 发布编辑输入流（摄像头画面）
await aliRtc.publishLocalVideoStream(true);
// 3) 订阅渲染结果：开启远端视频自动订阅，
//    在 videoSubscribeStateChanged 变为 subscribed(3) 后，
//    用 setRemoteViewConfig 把 render_uid 的摄像头流绑定到播放容器
await aliRtc.setDefaultSubscribeAllRemoteVideoStreams(true);
aliRtc.on("videoSubscribeStateChanged", (userId, oldState, newState) => {
  if (userId === render_uid && newState === 3) {
    aliRtc.setRemoteViewConfig(videoEl, userId, 1); // 1 = 摄像头流
  }
});
```*播放编辑结果前，需等订阅状态变为 `subscribed`，再把远端视频绑定到播放容器。*

</live-doc-step>
<live-doc-step step="3" title="直播中更换参考图 / 场景" description="WebSocket switch_prompt 信令">

需要更换参考图时，在直播过程中发 `switch_prompt` 信令即可，画面会在数秒内切换：```json
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
```*成功时不返回任何回执；失败时返回 `type=14` 失败回执，携带 `error_code` / `error_msg`*

</live-doc-step>

## 接口协议概述

## 接入全流程

1. 调用「创建直播流」接口，获得 `live_id`、WebSocket 凭证 `client_secret`、RTC 入会凭证 `rtc` 与渲染流用户 ID `render_uid`。
2. 用 `client_secret` 建立 WebSocket 控制连接，发送初始化信令，等待服务端就绪确认（收到成功确认后直播开始、计费开始）。
3. 用 `rtc` 凭证加入实时音视频频道（阿里云 RTC，AliRTC），在频道内发布你的视频流（摄像头或本地视频）作为编辑输入。
4. 在频道内订阅 `render_uid` 用户的视频流，即实时编辑合成结果。
5. 直播中按需发送换图信令更换参考图或编辑场景；结束后发送挂断信令，直播结束、计费停止。

## 接口总览

| 接口 | 方法与路径 | 用途 |
|-|-|-|
| POST | `/live/s_editing/realtime` | 创建实时编辑直播流（唯一入口，返回全部凭证） |
| WebSocket | `/live/ws/live/connect` | 控制信令（初始化、换图、挂断） |
| — | AliRTC `joinChannel` | 实时媒体流（发布编辑输入流 / 订阅合成结果） |

## 通用约定

| 约定 | 说明 |
|-|-|
| 接入环境 | 国内 `api.vidu.cn`，海外 `api.vidu.com`。WebSocket 域名白名单为 `api.vidu.cn` / `api.vidu.com` |
| 鉴权 | HTTP 请求头携带 `Authorization: vda_<your_api_key>`（**不带** `Token` 前缀）；WebSocket 建连同样使用该请求头；浏览器无法自定义 WebSocket 请求头时，改用创建接口返回的 `client_secret` 作为 query 参数。API Key 可在[控制台](https://platform.vidu.cn/api-keys)获取。 |
| 数据格式 | `Content-Type: application/json`；时间字段统一为 Unix 时间戳（秒）字符串 |
| 请求标识 | 可选请求头 `X-Request-ID`（36 字符内唯一标识，推荐 UUID），仅用于请求追踪与问题排查。 |
| 错误返回 | 非 2xx 返回 `code` / `reason` / `message` / `metadata` 结构；`metadata` 中可能携带 `trace_id`。账户积分不足返回 `CreditInsufficient`，并发超限返回 429。 |
| 计费 | 按实际直播时长（秒）计费，直播结束后结算尾差。计费从 `conn_init_ack.success=true`（进入 `on_live`）起算，到挂断为止。仅建连或仅入会不计费。换图信令不单独计费。 |
| 断线重连 | 连接意外断开后，可在宽限时间内用**同一 `live_id` 与同一 `conn_id`** 重新建连，重连成功后需重新发送 `conn_init`。超过宽限时间未重连，直播将结束并停止计费。宽限时长请咨询平台支持。 |
