# 整体介绍

非实时交互数字人（视频文件版）：输入一张角色图 + 一段音频（或说话文本），生成一段口型、动作对齐的说话视频。整个过程是**异步任务制**，不涉及 RTC、WebSocket 和实时链路。

## 最小接入流程

<live-doc-step step="1" title="创建任务" description="HTTP 提交生成任务">

在工作台获取 [API Key](/vidu-stream/doc/api-key) 后，即可创建任务。

**请求示例**```Plain
POST https://{host}/ent/s_avatar/offline
Authorization: Token vda_xxx
Content-Type: application/json
``````json
{
  "image": "https://你的角色图地址.png",
  "audio": "https://你的音频地址.mp3",
  "timeline": "{\"actions\":[{\"text\":\"比个心\",\"time_range\":[2,10]}]}"
}
````image` 必填；`audio` 和 `text` 至少传一个，两者都传时以 `audio` 为准。

`timeline`是动作时间轴，可以传入文本和时间的数组，用来控制数字人动作。

</live-doc-step>
<live-doc-step step="2" title="轮询查询任务" description="按 task_id 查询状态">

用第 1 步返回的 `task_id` 查询任务状态```Plain
GET https://{host}/ent/v2/tasks/{task_id}/creations
Authorization: Token vda_xxx
```- `state` 共 5 个取值：`created` / `queueing` / `processing` 为中间态，需继续轮询；`success`（成功）与 `failed`（失败）为终态。**务必实现 `failed` 分支**，失败原因见 `err_code` 与 `err_msg`。
- 轮询间隔建议 3～5 秒起步并逐步退避，不要高频空转，否则可能触发 `TooManyRequests`。`state=success` 后再读 `creations[]`；提前读取可能拿到空数组。
- 实测出片耗时约 40 秒～2 分钟（详见「详细参数」的「任务耗时与轮询建议」），建议总超时设为 5 分钟。**不要用 `progress` 判断任务是否卡死**，它会阶梯式上升并长时间停在 **99**，只有进入 `success`/`failed` 才会变成 **100**。

</live-doc-step>

3. 下载生成物 （获取视频与封面地址）

`creations[].url` 是视频下载地址，`cover_url` 是封面，`watermarked_url` 是带水印版本。生成物地址**有效期 24 小时**。

## 接口协议概述

## 接入全流程

- 获取 API Key
- 准备角色图和音频（或说话文本）
- 调用「创建任务」拿到 `task_id`
- 轮询「查询任务」直到 `state` 进入终态
- `state=success` 时从 `creations[].url` 下载视频；`state=failed` 时读取 `err_code` 与 `err_msg` 判断失败原因。

## 接口总览

下表是本版本涉及的全部对外接口，所有接口都需 `Authorization: Token vda_xxx`。

| 方法 | 路径 | 用途 |
|-|-|-|
| POST | `/ent/s_avatar/offline` | 创建数字人视频生成任务 |
| GET | `/ent/v2/tasks/{task_id}/creations` | 查询任务状态与生成物 |
| POST | 业务方自建 `callback_url` | 可选。任务状态变化时由 Vidu 回调通知 |

## 通用约定

| 项目 | 约定 |
|-|-|
| `{host}` | `{host}` 是域名，不包含协议。国内环境为 `api.vidu.cn`，海外环境为 `api.vidu.com`。全部接口使用 `https://{host}`。 |
| 认证 | 所有 HTTP 接口都需要 `Authorization: Token vda_xxx`。 |
| JSON 字段 | 请求与响应字段使用 snake_case，例如 `task_id`、`callback_url`、`wm_position`、`created_at`。 |
| 素材传入 | `image` 与 `audio` 均支持公网 URL、base64（需含 MIME 前缀）和 `ssupload:?id=<素材ID>` 三种形式，任选其一。 |
| 生成物时效 | `creations[]` 中的 `url`、`cover_url`、`watermarked_url` 均为 24 小时有效期，需自行转存。 |
