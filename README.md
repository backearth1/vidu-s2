# Vidu S2 调试台

一个覆盖 Vidu S2 系列模型全部能力、所有输入输出参数都可调的本地 Web 调试台。

零依赖：不需要 `npm install`，没有构建步骤。

```bash
node server.js --api-key vda_xxx
# 或
VIDU_API_KEY=vda_xxx node server.js
# 然后打开 http://127.0.0.1:28890
```

不带 `--api-key` 也能启动，在页面顶部手填即可（存 localStorage，日志里一律打码）。

| 参数 | 默认值 | 说明 |
|-|-|-|
| `--port` | `28890` | 监听端口 |
| `--host` | `127.0.0.1` | 监听地址 |
| `--api-key` | `$VIDU_API_KEY` | 注入到页面，省得每次手填 |
| `--env` | `cn` | `cn` = api.vidu.cn，`ovs` = api.vidu.com |
| `--public-host` | 取访问页面的 Host | 转推用的公网 IP / 域名 |
| `--tls-cert` / `--tls-key` | 无 | 传入证书即启用 HTTPS（WebRTC 需要安全上下文） |
| `--minimax-key` | `$MINIMAX_API_KEY` | MiniMax Key：ASR + AI 时间轴共用（与 Vidu Key 不通用） |
| `--timeline-model` | `$TIMELINE_MODEL` / `MiniMax-M3.1-Flash` | AI 时间轴使用的多模态模型 |

## 为什么需要这个本地服务

浏览器不能直连 `api.vidu.cn`：一是跨域被拦，二是 WebSocket 构造函数没法自定义 `Authorization` 请求头。
所以 `server.js` 同时做三件事——托管静态页、反代 HTTP、隧道 WebSocket，把查询参数里的
`authorization` / `client_secret` 在服务端转成上游请求头。这与官方 quickstart 的做法一致。

## 六个面板

**S2-Avatar 实时交互**　`POST /live/s_avatar/realtime`
完整链路：HTTP 创建拿凭证 → WebSocket 收发控制信令 → AliRTC 收发音视频，三条缺一不可。
创建参数全覆盖（75 个字段）：`model` / `call_mode` / `avatar.*` / `voice_model.*` / `audio` /
`vad.*` / `idle_motion.*` / `action.*` / `llm.*` / `memory_retrieval.*` / `knowledge_retrieval.*`。
运行时信令：`text_msg`(99)、`audio_interrupted`(7)、`session_update`(97 热改音色人设)、
`prompt_operation`(11 换参考图 —— 这就是持品互动 / 换装 / 换背景)、`call_hangup`(5)。
`conn_init` 收到 `NOT_READY` 时按文档做指数退避重试，不重连 WS。

**S2-Editing 实时编辑**　`POST /live/s_editing/realtime`
`image_url` + `editing_type`（风格迁移 / 虚拟试穿 / 主体替换 / 背景替换）+ `rtmp_urls[]` 转推。
运行时 `switch_prompt`(13) 换图换场景。推一路视频进频道作为编辑输入，订阅 `render_uid` 拿编辑结果。

**S2-Avatar 组件版**　`POST /live/s_avatar/component`
你自带 artc / trtc / agora / volcengine 的频道凭证。麦克风经 AudioWorklet 采集成
24kHz 单声道 s16le 裸 PCM，按 20ms/100ms 分帧走 WebSocket 二进制帧上行。

**S2-Avatar 非实时**　`POST /ent/s_avatar/offline`
图片 + 音频（或文本）+ 动作时间轴，异步出 MP4。时间轴是一个 JSON 输入框（自动序列化成
JSON **字符串** —— 文档强调它不是对象），也可以点「AI 生成」由 ASR 文本 + 图片理解自动编排。
按 3 秒起步、逐步退避到 15 秒轮询任务。纯 HTTP，不需要 WebSocket 和 RTC，成本最低，
适合先用它验证 API Key。

**语音识别 ASR**
上传视频或音频，服务端用 ffmpeg 抽 16kHz 单声道音轨，再调 MiniMax `/v1/speech_to_text`
（模型 `asr-1.0`）。输出纯文本、逐句时间戳、说话人标签，可导出 SRT / VTT。
超过 500 秒自动按 480 秒切片识别后拼接时间戳。

**资产管理**
形象图片资产、音色克隆与列表、动作库、长期记忆、知识库与文档、Live 账单与录播、积分余额。
外加 717 个内置音色的可搜索速查表（从官方音色文档解析而来）。

## 每个面板的共同设计

- **左栏**：schema 驱动的参数表单。每个字段带文档原文的取值范围、默认值、枚举说明。
- **中栏**：请求体 JSON 实时预览，可一键切到原始 JSON 直接编辑（切回表单时会反填）；响应原样展示，可导出 cURL。
- **右栏**：所有**实时**的东西集中在这里 —— 数字人画面、实时字幕、运行时信令（发文本 / 打断 / 换参考图 / 热更新 / 挂断）、WS 收发帧与 HTTP / RTC 全量日志。

画面以数字人为主：远端流铺满舞台，舞台高度固定、宽度按画面真实比例反推，所以竖屏数字人是「变窄」
而不是「把右栏撑高」。本端摄像头预览是右下角的小浮窗，**默认隐藏**，标题栏可切换显示。
隐藏的只是显示，不影响推流 —— video 模式下摄像头照常发布给数字人，否则对面就没有输入了。

字段标签前的小勾选框控制**这个 key 传不传**，这点很重要 —— Vidu 不少字段「不传」和「传默认值」
语义不同（例如 `idle_motion` 对象存在但省略 `enabled` 视为 `true`）。schema 里给了默认值的字段
默认勾选，所以页面初始状态就是一份能直接发出去的请求。

## 实时编辑：服务端推流 + 转推观看 + 服务端录像

实时编辑版的 `rtc` 入会凭证只有一份，绑定了唯一的 `user_id`：谁先入会谁占着，第二个客户端用同一份凭证
入会会把前一个踢下线（实测 `RTC bye code=3`）。Vidu 没有单独签发观众端凭证，所以「推」和「看」必须拆开：

```
上传视频(≤60s) → ffmpeg 转 30fps MJPEG+WAV → 服务器 Chrome(假摄像头/麦克风) ─AliRTC→ Vidu 编辑
                                                                                   │ rtmp_urls 转推
浏览器 hls.js ←HLS← server.js 反代 ←── mediamtx(:19350) ←──────────────────────────┘
                                         └─ ffmpeg -c copy → recordings/*.mp4（录像，不重编码）
```

- **推流在服务器上做**：不再用浏览器 `captureStream` 垫片，不受本机性能、标签页前后台影响。
- **观看是 HLS**：创建直播时自动往 `rtmp_urls` 注入 `rtmp://<公网地址>:19350/live/<随机口令>`，口令 24 位随机，
  mediamtx 只放行这个格式的路径。浏览器端延迟约 2~4 秒。
- **录像是服务端 `ffmpeg -c copy`**：直接封装 Vidu 转推的流，不解码不重编码，画质等于 Vidu 的输出。

需要的东西：

| 项 | 说明 |
|-|-|
| `bin/mediamtx` | RTMP 接收 + HLS 输出，v1.9.3，随 `server.js` 自动拉起。二进制不入仓库，[下载 v1.9.3](https://github.com/bluenviron/mediamtx/releases/tag/v1.9.3) 后放到 `bin/mediamtx`（Linux amd64 单文件，`chmod +x`）；`bin/mediamtx.yml` 已带配置 |
| `public/vendor/hls.min.js` | hls.js 1.5.15，本地托管 |
| 公网放行 TCP **19350** | Vidu 要从公网连进来推流。云厂商安全组需放行 |
| `--public-host` | 转推地址里的公网 IP / 域名，不给则取你访问页面用的主机名 |
| 服务器 Chrome | 自动找 `~/.cache/ms-playwright/chromium-*`，也可设 `CHROME_PATH` |
| HTTPS | 浏览器只在安全上下文开放 WebRTC；用 `--tls-cert/--tls-key`（自签即可） |

```bash
node server.js --host 0.0.0.0 --public-host <公网IP> --tls-cert certs/cert.pem --tls-key certs/key.pem
```

**限制（实测得出）：**

- 视频 ≤ 60 秒，循环推流，**推流中不能暂停 / 拖动 / 调倍速**（Chrome 假设备按固定节奏循环读文件）。
- Vidu 转推的规格是固定的：实测输入 1280×720 输出 **952×544 / 24fps**，竖屏 720×1280 输出 544×952。
  这是 Vidu 服务端的输出，录像质量上限由它决定，我们这边无法提高。
- 转推含 AAC 音频（48kHz 单声道）。纯音（如 440Hz 正弦）会被 AliRTC 的降噪压低，真实人声不受影响。
- 顺序必须是「先推流入会，再 `conn_init`」，反过来渲染服务启动时频道里没有输入，直播会以 `LIVE_ENDED` 结束。

## 语音识别（ASR / MiniMax）

```
浏览器上传视频/音频 ──POST /asr/transcribe──► server.js
                                                ├─ ffmpeg 抽音轨 → 16kHz 单声道 mp3
                                                ├─ >500s 时按 480s 切片
                                                └─ POST https://api.minimax.cn/v1/speech_to_text
                                                     Authorization: Bearer <MiniMax Key>
```

| 项 | 说明 |
|-|-|
| MiniMax Key | `--minimax-key <key>` 或环境变量 `MINIMAX_API_KEY`。**与 Vidu 的 `vda_` Key 不通用** |
| 接口 | `POST /asr/transcribe?name=<文件名>&language=zh`，请求体就是文件本体 |
| 输出 | JSON：`text` / `segments[]`（起止时间、speaker、text）/ `srt` / `vtt` / `duration` / `trace_ids` |
| 语言 | 不传或 `auto` 自动检测；也支持 `zh yue en ja ko th vi id ms fil fr de es it pt pl ru uk ar tr` |
| 限制 | 单次音频 ≤ 500 秒、≤ 50MB（官方）；上传文件 ≤ 600MB。超长自动切片 |
| 临时文件 | 写在系统临时目录，请求结束即删；结果不落盘 |

没有配置 Key 时，`/bootstrap` 会返回 `minimaxConfigured: false`，面板顶部会直接提示。
MiniMax 返回 401 说明 Key 不对（常见原因是误用了 Vidu 的 `vda_` Key）。

## AI 动作时间轴（非实时版）

```
图片 + 音频/文本 ──POST /timeline/generate──► server.js
                                              ├─ 音频：MiniMax ASR（timestamp_level=word）
                                              ├─ 字级时间戳 → 合并成 ASR 整句（起止时间）
                                              ├─ 整句分组：边界只在句首，每段 ≥5 秒，不拆句
                                              ├─ 图片：MiniMax-M3.1-Flash 视觉理解
                                              └─ 整句分段 + 人物档案 → 模型逐段写动作
```

时间由本地算法绑定：模型只输出每段的动作描述，`time_range` 由整句分段算法逐段赋值，
所以不会出现模型算错时间、留空档、重叠或把一句话拆到两段里。分段不按「平均 N 秒」，
只按 ASR 整句时间：一句不够 5 秒就并入下一整句；最后一段不足 5 秒并入上一段；
整段素材不足 5 秒时只能出一段动作并在 `warnings` 里提示。

| 项 | 说明 |
|-|-|
| 按钮 | 非实时版「动作时间轴 timeline」卡片 →「AI 生成」 |
| 输入 | 界面只有一个时间轴输入框：手填、「填入示例」、「AI 生成」都写进同一个框 |
| 接口 | `POST /timeline/generate`，JSON；图片/音频支持公网 URL 或 base64 data URL |
| 请求 | `{ image, audio?, text?, voice?, duration?, style?, language? }`（`image` 必填） |
| 风格 | 默认 `专业讲解`；另有 `亲切带货` / `活力种草`，三种风格都不轻易微笑 |
| 分段 | 以 ASR 整句时间为准，动作边界只落在句首，每段 ≥5 秒；不使用「平均 N 秒」 |
| 表情 | 商品讲解场景默认表情自然、专注。提示词禁止默认微笑/笑容加深；台词没有明确开心、感谢、惊喜线索时，生成后也会把「微笑 / 笑容 / 嘴角上扬」改成中性表情 |
| 手势 | 按直播环节分配不同手势（欢迎 / 上新 / 讲成分质地 / 报价格优惠 / 引导下单 / 收尾），并要求每条动作有收势（手放回胸前、垂放身侧或交叠）。**禁止招手/挥手**——数字人会持续摆动停不下来；生成后本地再兜底替换一次 |
| 输出 | `{ timeline:{actions}, profile, beats, meta, warnings }` |
| ASR | 内部以 `timestamp_level=word` 调用，中文按字返回时间戳；页面上仍显示句级结果 |
| 限制 | 素材 ≤ 10 分钟；图片 ≤ 10MB；音频 ≤ 50MB；URL 素材有超时和内网地址拦截（防 SSRF） |
| 人物校验 | 图片里没有识别到人（只有产品/风景/纯色背景等）→ 直接 422 报错，**不会跳过图片理解凭空编动作**；图片理解调用失败同样报错 |
| 产品一致 | 动作只允许使用图片里识别到的产品/道具。图片里没有产品时，提示词禁止一切产品描述，生成后本地还会把「拿/举/指/看产品」的动作替换为空手手势，**绝不凭空生成虚假商品** |
| 视线约束 | 视线只允许落在镜头／观众或手中产品／道具上；禁止看向一侧、别处、背景、镜头外，禁止游移躲闪。提示词约束 + 模型重写 + 本地删句三重保证 |
| 兜底 | 动作编排失败时才用关键词模板（仍然基于已识别的人物档案）；不会在没有人物的前提下生成 |
| 配置 | 复用 `--minimax-key`；`--timeline-model` 默认 `MiniMax-M3.1-Flash` |
| 成本 | 示例 17.7 秒素材：视觉理解约 2k tokens + 编排约 1k tokens，端到端约 10 秒 |

text + voice 模式没有音轨，时间轴按 2.5 字/秒估算，和 TTS 实际时长可能有偏差，
页面会明确提示；要精确卡点请用音频模式。

## 计费提醒

页面上每个实时面板都有实时计费计时器，但请以 `GET /live/v1/lives/{live_id}` 返回的
`billed_seconds` / `credits_cost` 为准。

- 实时交互版：每 2 秒 3 积分（约 0.094 元），时长向上取整到偶数秒
- 实时编辑版 / 组件版：每秒 1 积分（0.03125 元）
- 非实时版：按视频时长每秒 1 积分
- 音色克隆：每次 899 积分（约 28 元），每客户前十次免费
- 余额低于 45 积分无法发起任何任务

计费从 `conn_init_ack.success=true` 那一刻起算，到挂断为止。**仅建 WebSocket 或仅入 RTC 频道不计费**，
所以每个实时面板都有「仅创建（不连接、不计费）」按钮，用来单独核对请求参数与响应结构。

## 目录

```
server.js              静态服务 + HTTP 反代 + WebSocket 隧道（Node 内置模块）
public/
  index.html           外壳，用 script 标签加载 AliRTC Web SDK 7.1.9
  css/app.css
  js/app.js            顶栏、导航、面板切换
  js/core/             api / ws / rtc / pcm / media / form / panel / log / ui / state
  js/schema/           四个创建接口的字段定义（取值范围照搬文档）
  js/views/            六个面板 + 音色速查 + 文档阅读器
  js/data/voices.json  717 个内置音色
lib/                   publisher（服务端推流）/ relay（转推与录像）/ asr（语音识别）/ timeline（AI 动作时间轴）
docs/                  从官方文档站还原的 Markdown 原文，页面内可直接阅读
ref/                   官方两份 quickstart demo，作接入对照
```

`docs/` 里的内容是从 `platform.vidu.cn/vidu-stream/doc` 的 RSC 载荷里解出来还原的 ——
那个文档站是客户端渲染的，直接抓 HTML 拿不到正文。页面的「API 文档」面板直接渲染这些文件，离线可读。

## 已验证

用真实 API Key 跑通的：

- `GET /live/v1/lives`、`/live/v1/voices`、`/ent/v2/credits` —— 只读接口与代理链路
- `POST /live/s_avatar/realtime` —— 表单默认请求体原样发送成功，`idle_motion` / `vad` / `llm` 正确回显
- `POST /live/s_editing/realtime` —— 返回 `render_uid` 与 `client_secret`
- `POST /ent/s_avatar/offline` —— created → processing → success，4 积分 / 4 秒视频，拿到三个生成物地址
- `POST /timeline/generate` —— 17.7 秒音频 + 示例图，word 级 ASR → 4 段节拍 → 图片理解 → 动作描述，
  端到端约 10 秒；无音频的 text 模式与兜底模板也验证过
- WebSocket 隧道 —— 握手 → `conn_init` → `conn_init_ack success=true` → `call_hangup` → `force_hangup` 回执
- 六个面板在 headless Chrome 下全部渲染无报错

尚未端到端验证的是需要真实摄像头/麦克风的部分（AliRTC 入会后的音视频收发、组件版 PCM 上行），
这些在无头环境里没法测，需要你在浏览器里实际点一次。

## 注意

「实时编辑」面板的输入源除摄像头外还提供了「本地视频文件」和「屏幕共享」。AliRTC Web SDK 7.1.9
没有公开的自定义视频源接口（已核查：无 `publishCustomVideoStream` / `setExternalVideoSource` /
`createCustomVideoTrack`），这两种输入是用 `getUserMedia` 垫片把轨道伪装成摄像头实现的，属于本调试台
的取巧手段。摄像头是官方文档唯一背书的路径，效果对不上时请先用摄像头复测。
