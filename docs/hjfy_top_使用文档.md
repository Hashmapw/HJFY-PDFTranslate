# hjfy.top 接口契约与维护说明

本文面向插件维护者。接口来自对 hjfy.top 前端与实际请求的观察，不是官方开放 API，服务端可能随时调整。本文最后校验日期为 2026-08-28；实现以 `content/scripts/core.js` 和浏览器 Network 面板为准。

## 1. 插件实际使用的接口

所有 API 位于 `https://hjfy.top`。除 `/api/userinfo` 外，成功响应使用 `{ "status": 0, "data": {...} }`；插件会校验下表中的必要字段。结构不匹配时，日志包含端点名、HTTP 状态、Content-Type 和响应前 240 个字符。

| 方法 | 路径 | 请求 | 成功响应必要字段 | 备注 |
|---|---|---|---|---|
| GET | `/api/userinfo` | - | `login: boolean` | 区分真实登录态 |
| GET | `/api/arxivInfo/{id}` | 路径参数 | `data.hasSrc: boolean` | 无源码时不能翻译 |
| GET | `/api/arxivStatus/{id}` | 路径参数 | `data.status: string` | 状态枚举见下文 |
| GET | `/api/arxivFiles/{id}` | 路径参数 | `data.zhCN: string` | 返回短时效 OSS URL |
| POST | `/api/uploadFiles` | multipart: `file`, `fileName` | `data.fileKey: string` | 需要登录 |
| GET | `/api/fileStatus/{fileKey}` | 路径参数 | `data.status: string` | 上传任务状态 |
| GET | `/api/fileFiles/{fileKey}` | 路径参数 | `data.zhCN: string` | 可能是 PDF 或 Markdown |
| POST | `/api/sendCode` | `{phone,captchaVerifyParam}` | `status: 0` | 验证参数由用户完成人机验证后产生 |
| POST | `/api/phoneLogin` | `{phone,code}` | `data.session: string` | 插件写入 Cookie Service |
| POST | `/api/logout` | - | 服务端响应 | 随后清除本地 session cookie |
| GET | `/api/login/callback/wechat` | OAuth `code`, `state`, `path` | Set-Cookie | 微信扫码回调 |

代码没有调用 `arxivViewHistory`、`callbackSession`，仓库也不包含 `hjfy_client.py`。命令行复现工具是 `tools/simulate.js`。

## 2. arXiv 状态契约

`data.status` 当前允许：

```text
init | start | processing | finished | failed | error | fault
```

- `finished`：立即调用 `arxivFiles` 获取新签名 URL。
- `failed`、`error`、`fault`：终止；带版本号的 ID 会再查询一次无版本号 ID。
- `init`、`start`、`processing`：每 10 秒轮询，最多等待 15 分钟。
- 未知状态：视为接口契约变更，保留响应摘录并停止，不无限轮询。

`arxivInfo` 是源码能力检查，但不应阻断已经完成的翻译。若该接口发生网络错误或返回 HTTP/业务 5xx，插件会降级查询 `arxivStatus`；任务为 `finished` 时直接调用 `arxivFiles` 下载。HTTP 5xx 会按 2.5、5、10 秒最多重试 3 次，累计退避 17.5 秒；单次请求超时为 10 秒，因此最坏路径控制在约 1 分钟内。4xx、响应契约错误及明确的无源码结果仍会终止，避免掩盖登录或服务改版问题。

错误请求使用 `responseType: json` 时，响应摘录从 `XMLHttpRequest.response` 序列化，不读取仅适用于文本响应的 `responseText`，防止错误处理过程覆盖原始 HTTP 状态并阻断降级。

`arxivStatus` 的 `status: 101` 存在二义性。插件先检查无版本号任务，再调用 `userinfo`：

- `login: false`：提示需要登录；
- `login: true`：提示账号已登录但任务尚未创建，不再误导用户重复登录。

## 3. 典型请求和响应

```http
GET /api/arxivInfo/2602.09021
```

```json
{"status":0,"data":{"hasSrc":true,"meta":"..."}}
```

```http
GET /api/arxivStatus/2602.09021
```

```json
{"status":0,"data":{"status":"processing","info":"..."}}
```

```http
GET /api/arxivFiles/2602.09021
```

```json
{
  "status": 0,
  "data": {
    "id": "2602.09021",
    "title": "...",
    "origin": "https://...",
    "zhCN": "https://...",
    "zhCNTar": "https://...",
    "isDeepSeek": false
  }
}
```

中文 PDF 的 OSS 签名 URL 观察到约 6 分钟有效。插件拿到 URL 后立即下载；若第一次下载返回 HTTP 403，会重新调用一次 `arxivFiles` 并仅重试一次，避免使用过期 URL 无限重试。

## 4. 登录实现边界

### 微信

`content/scripts/login_config.js` 是插件与 `tools/wechat_*.js` 的唯一配置源，统一维护 `appid`、OAuth `state`、回调路径和轮询域名。微信官方 qrconnect 页面本身会根据 `usenewdomain` 在 `long.open.weixin.qq.com` 与 `lp.open.weixin.qq.com` 间选择；本项目固定使用已验证的 `long.open.weixin.qq.com`，改动前必须重新检查官方页面和完整回调。

插件解析 qrconnect 页面中的二维码 UUID，轮询状态码：

```text
408 等待扫码
404 已扫码，等待手机确认
405 已确认，必须同时带 wx_code 才算成功
403 用户取消
402 二维码失效
500 服务异常
```

### 手机号

点击手机号登录时，插件先清除 Zotero Cookie Service 中旧的 `session`，再直接加载 hjfy.top 官网。验证码、人机验证和登录都由官网完成；插件不再读取或注入页面 DOM，而是在父进程轮询 `/api/userinfo`，仅当 `login: true` 时关闭窗口并刷新设置页。

### 会话

从 0.1.8 起 session 只保存在 Zotero Cookie Service，不再明文复制到 `prefs.js`；启动时会清空旧版的 `extensions.hjfy-pdftranslate.session`。登录前和退出时只清除 `hjfy.top` 的 `session` cookie，不删除同域其它 cookie。由于 Zotero 的网页和插件请求共享 Cookie Service，退出插件也会退出该 Zotero profile 内的 hjfy.top 网页会话。

## 5. 改版自检

1. 在浏览器 Network 面板逐个检查上表端点的 HTTP 状态、Content-Type 和 JSON 字段。
2. 运行 `node --test tools/*.test.js`，确认契约、登录状态机、菜单与发布元数据测试通过。
3. 用 `HJFY_COOKIE="session=..." node tools/simulate.js arxiv <id>` 跑一条真实链路。不要把 session 写入仓库或日志。
4. 在隔离 Zotero profile 中验证右键菜单、右下角进度通知和 `PDF-CN` 附件。
5. 微信改动同时检查二维码 UUID、404/405 顺序、OAuth callback 的 Set-Cookie 和最终 `userinfo.login === true`。

发布前 `manifest.json` 与 `update.json` 版本必须一致；CI 会执行 `tools/release_metadata.test.js`，tag 也必须严格等于 `v<manifest version>`。
