# 快速开始

1. 准备 （环境和账号要求）

- Python 3.10 或更高版本。
- Chrome / Edge 等支持 WebRTC 的浏览器。
- 一个可用的 Vidu MaaS API Key，格式通常是 `vda_...`。
- 本机摄像头与麦克风。

<live-doc-step step="2" title="一键启动" description="在仓库根目录启动本地服务">

Demo 文件：

[index.html](/live-doc/files/s2-editing/quick-start/index.html)

[quickstart.py](/live-doc/files/s2-editing/quick-start/quickstart.py)

- 2 个 Demo 文件下载后，cd 进入到文件所在目录，把 `vda_xxx` 替换成你的 API Key 后执行此代码```Bash
python3 quickstart.py --api-key vda_xxx
```- 启动后会自动打开 `http://127.0.0.1:28891/`，默认使用国内环境。

</live-doc-step>

3. 页面操作 （创建并连接）

- 检查页面中环境和 API Key 是否已填好，国内环境用国内 Key，海外环境用海外 Key。
- 提供参考图（粘贴图片 URL 或本地选图），并选择编辑场景。
- 点击「创建并连接」。
- 浏览器弹出权限提示时，允许使用摄像头和麦克风。
- 看到 `API live ...`、`WS init ack`、`RTC joined` 后，说明链路已连通：左边是本地预览（编辑输入），右边是实时编辑合成结果。
- 直播中可换参考图或换编辑场景，点击「发送 switch_prompt」；成功无回执，画面数秒内切换，失败会在日志中显示 error_code。
- 体验结束后点击「挂断」。

## 四种能力

创建时通过 `editing_type` 指定，直播中可用 switch_prompt 切换：

| 四种能力 | 场景 | 参考图的作用 |
|-|-|-|
| `style_transfer` | 风格迁移（默认） | 提供目标画面风格 |
| `virtual_tryon` | 虚拟试穿 | 提供要穿上的服装 |
| `subject_replacement` | 主体替换 | 提供替换后的主体 |
| `background_replacement` | 背景替换 | 提供替换后的背景 |

## 常见问题

### Q1：报 401 / 403 / 400 错误，怎么办

检查 API Key 是否有效，是否属于当前环境。检查是否积分不足，如果积分不足需要充值购买资源包。

### Q2：页面为什么显示 WS NOT_READY

渲染服务需要先就绪。页面短时间内显示 `WS NOT_READY` 是正常现象，demo 会自动重试（由客户端重新发送初始化信令）。重试有服务端预算上限，若长时间未就绪，直播会结束，需要重新创建。

### Q3：浏览器提示摄像头或麦克风不可用

检查浏览器地址栏左侧权限、系统隐私设置，以及设备是否被其他软件占用。

### Q4：AliRTC Web SDK 为什么加载失败

确认本机能访问 `https://g.alicdn.com/apsara-media-box/imp-web-rtc/7.1.9/aliyun-rtc-sdk.js`。如果公司网络拦截了外部 CDN，需要切换网络或配置代理。

### Q5：为什么看不到合成结果画面

先确认页面日志里已出现 `RTC joined`，再等待渲染服务推流，右侧画面会出现渲染流的远端画面。换图后画面需要数秒切换。

### Q6：本地选图提示过大怎么办

base64 编码会放大数据，单张图片请控制在 4MB 以内，或改用图片 URL。

### Q7：换图没有回执，是失败了吗

不是。成功时**不返回任何回执**，这是设计如此。只有失败时才会收到 `type=14` 失败回执。服务端不对该信令去重，重复发送会重复触发切换，请勿用「没回执就重发」的策略。
