# 快速开始

1. 准备 （环境和账号要求）

- Python 3.10 或更高版本。
- Chrome / Edge 等支持 WebRTC 的浏览器。
- 一个可用的 Vidu MaaS [API Key](/vidu-stream/doc/api-key)，格式通常是 vda\_...。
- 本机麦克风；体验 video 模式时还需要摄像头。

<live-doc-step step="2" title="快速启动" description="下载 Demo 并启动本地服务">

Demo 文件：

[index.html](/live-doc/files/s2-avatar/realtime/quick-start/index.html)

[quickstart.py](/live-doc/files/s2-avatar/realtime/quick-start/quickstart.py)

- 2个Demo文件下载后，cd进入到文件所在目录，把 vda_xxx 替换成你的 API Key后执行此代码```Bash
python quickstart.py --api-key vda_xxx
```- 启动后会自动打开 `http://127.0.0.1:28890/`，默认使用国内环境（`api.vidu.cn`）。如需海外环境（`api.vidu.com`）可在页面中切换。

</live-doc-step>

3. 页面操作 （创建并连接）

- 检查页面中环境和 API Key 是否已填好，国内环境用国内Key，国外环境用国外Key。
- 点击「创建并连接」。
- 浏览器弹出权限提示时，允许使用麦克风和摄像头。
- 看到 `API live ...`、`WS init ack`、`RTC joined` 后，说明链路已连通。
- 体验结束后点击「挂断」。

## 常见问题

### Q1：报401 / 403/ 400错误，怎么办

检查 API Key 是否有效，是否属于当前环境。`vda_...` 会被 quick start 自动转换为 `Authorization: Token vda_...`。检查是否积分不足，如果积分不足需要充值购买资源包。

### Q2：页面为什么显示WS NOT_READY

`video` 模式下，video provider 需要先回连 live。如果页面短时间显示 `WS NOT_READY` 是正常现象，demo 会自动重试。

### Q3：浏览器提示麦克风或摄像头不可用

检查浏览器地址栏左侧权限、系统隐私设置，以及设备是否被其他软件占用。

### Q4：AliRTC Web SDK 为什么加载失败

确认本机能访问 `https://g.alicdn.com/apsara-media-box/imp-web-rtc/7.1.9/aliyun-rtc-sdk.js`。如果公司网络拦截了外部 CDN，需要切换网络或配置代理。

### Q5：页面会泄漏API key吗

页面日志会脱敏展示 API Key，但浏览器地址栏里仍可能包含启动时注入的参数，请注意不要把真实 API Key 泄漏出去。
