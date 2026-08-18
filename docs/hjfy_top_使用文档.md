# 幻觉翻译（hjfy.top）程序化使用文档：登录 → arXiv 翻译 → 下载中文 PDF

> 目标：用脚本打通「登录 -> 输入 arXiv -> 获取翻译 -> 下载中文 PDF / LaTeX 源码」的完整流程。
> 本文档基于对 hjfy.top 前端源码与实际 HTTP 请求的逆向分析（2026-08-16 验证），所有接口均实测可用。
> 配套脚本：`hjfy_client.py`（同目录），可直接 `python3 hjfy_client.py <arxiv_id>` 使用。

---

## 0. 结论速览（先看这段）

| 环节 | 是否需要登录 | 说明 |
|---|---|---|
| 查论文元数据 `arxivInfo` | ❌ 不需要 | 服务端代理 arXiv 官方 API，返回摘要、PDF 链接、`hasSrc` |
| 查/轮询翻译任务 `arxivStatus` | 已翻译的论文 ❌ / **新论文 ✅ 需要** | 未翻译的新论文返回 `status:101 required login`，此时不会建任务 |
| 取文件地址 `arxivFiles` | ❌ 不需要（任务 finished 后） | 返回 3 个 OSS 签名 URL，**每次实时生成** |
| 下载中文 PDF / LaTeX 包 | ❌ 不需要 | OSS 直链，`zhCN`(中文PDF) 6 分钟有效，`origin`/`zhCNTar` 1 小时有效 |

**一句话**：被翻译过的论文全链路匿名可用；想让网站翻译一篇**新论文**才需要登录（手机号+验证码 或 微信扫码）。登录只卡"创建翻译任务"这一步。

---

## 1. 接口速查表

所有接口均位于 `https://hjfy.top` 同域，返回 JSON，`status:0` 表示成功。

| 方法 | 路径 | 参数 | 返回要点 | 登录 |
|---|---|---|---|---|
| GET | `/api/userinfo` | - | `{"login":bool,"nickname":..}` | 否 |
| GET | `/api/arxivInfo/{id}` | id = arXiv ID | `data.hasSrc`(有无LaTeX源码) + `data.meta`(arXiv官方Atom XML，含摘要) | 否 |
| GET | `/api/arxivStatus/{id}` | id = arXiv ID | `status:0` + `data.status`(init/start/processing/finished/failed/error/fault)；`status:101` = 需登录 | 新论文要 |
| GET | `/api/arxivFiles/{id}` | id = arXiv ID | `data.{id,title,origin,zhCN,zhCNTar,isDeepSeek}`，文件为 OSS 签名 URL | 否(任务完成后) |
| GET | `/api/arxivViewHistory?limit=N` | - | 近期访问的论文列表 | 否 |
| POST | `/api/sendCode` | JSON `{phone, captchaVerifyParam}` | 发送短信验证码（**需先过阿里云滑块验证码**） | - |
| POST | `/api/phoneLogin` | JSON `{phone, code}` | `data.session` → 跳 `/api/callbackSession?session=..` 种 cookie | - |
| GET | `/api/login/callback/wechat?code=..&path=..` | 微信扫码回调 | 服务端种 session cookie | - |
| POST | `/api/uploadFiles` | multipart `file`,`fileName` | 本地 PDF 翻译，成功给 `fileKey` | 要 |

**历史上传/版本处理**：任务 id 带 `v2` 等版本号时若翻译失败，脚本会把版本号去掉再查一次（网站前端同款逻辑）。

---

## 2. 登录打通（两种方式）

网站只提供两种登录：**手机号 + 短信** 和 **微信扫码**。共通点：登录成功后 session 存在 hjfy.top 域名的 Cookie 里（`HttpOnly; Secure; SameSite=Strict; Max-Age=90天`）。程序里要做的就是把 cookie 保存下来、随请求带上。

### 方式 A：微信扫码（推荐，最省事）

1. 任意浏览器打开 `https://hjfy.top/`，点右上角"登录"。
2. 弹出微信二维码（是微信官方 `open.weixin.qq.com/connect/qrconnect` 的二维码，appid `wxd7885e86e52192fe`），用手机微信扫码确认。
3. 登录完成后浏览器里已经持有 session cookie。

### 方式 B：手机号 + 短信

1. 前端流程（`index-*.js` 实现）：输手机号 → 点"发送验证码"触发**阿里云滑块验证码**（`AliyunCaptcha`，SceneId `1vljhm6u`）→ 人机验证通过后 `POST /api/sendCode {phone, captchaVerifyParam}` → 收短信 → `POST /api/phoneLogin {phone, code}` → 拿到 `session` → 跳 `/api/callbackSession?session=<session>&path=/` 种 cookie。
2. **注意**：滑块验证码是"人"才能过的（阿里云的风控，没有合法途径自动解）。所以手机号登录这一步必须在浏览器里手动完成，程序只负责"借用"登录后的 cookie。

### 把"已登录"的 cookie 导入脚本（关键操作）

两种办法二选一：

**办法 1：浏览器控制台导出（推荐）**
登录后，在 hjfy.top 页面按 F12 → Console，执行：

```js
document.cookie
```

把输出的 `session=xxxxx; ...` 字符串存到本地文件 `hjfy_cookies.txt`，脚本会自动读取并带上。

**办法 2：浏览器插件导出**
用 EditThisCookie 之类的插件导出 hjfy.top 的 cookies 为 Netscape 格式 / 手动拼成 `session=xxx`。

之后脚本的用法就统一了：

```bash
# 未登录：也能查已翻译论文、下载
python3 hjfy_client.py 2506.17310

# 已登录（把 session 写进 hjfy_cookies.txt）：可触发新论文翻译
python3 hjfy_client.py 2506.17310 --wait --download
```

> 说明：脚本默认自动读取工作目录下 `hjfy_cookies.txt`（纯文本 `session=...`）作为 Cookie 头。

---

## 3. arXiv 完整流程（逐步拆解）

以 `https://arxiv.org/abs/2506.17310` 为例，对应脚本内部执行的步骤：

```
第 1 步  从 URL 或直接 ID 解析出 arXiv ID          （客户端正则，支持 arxiv.org/alphaxiv 的 abs|pdf 链接）
第 2 步  GET /api/arxivInfo/2506.17310             → 论文存在性 + 是否有 LaTeX 源码(hasSrc)
         {status:0, data:{hasSrc:true, meta:"<arXiv Atom XML 摘要>"}}
         说明: hasSrc=false 的论文无法翻译(没有源码), 提前提示
第 3 步  GET /api/arxivStatus/2506.17310           → 查翻译任务状态
         返回几种情况:
           {"status":101,"msg":"required login"}      → 未登录 & 未翻译 → 提示"需要登录/还没人翻译过"
           {"status":0,"data":{"status":"init|start|processing",...}} → 任务进行中 → 轮询
           {"status":0,"data":{"status":"finished"}}  → 已完成 → 进入第 4 步
           {"status":0,"data":{"status":"failed|error|fault"}}       → 失败
第 4 步  GET /api/arxivFiles/2506.17310             → 拿文件直链
         {status:0, data:{
            id, title,
            origin:  "<OSS签名URL 原版PDF>",
            zhCN:    "<OSS签名URL 中文PDF>",
            zhCNTar: "<OSS签名URL 中文LaTeX源码tgz>",
            isDeepSeek: false }}
第 5 步  直接 GET 上面的 URL 下载                     → 落盘 中文PDF / LaTeX包 / 原版PDF
```

**轮询策略**（网站前端同款）：状态为 `start/processing` 时每 **10 秒**查一次，直到 `finished`；`failed` 时如果 id 带版本号（如 `2506.17310v2`），去掉版本号（`2506.17310`）再查一次，如果无版本号任务已完成就引导用户用无版本号的结果（因为无版本号的任务往往覆盖所有版本）。

**OSS 签名 URL 有效期**：`origin`(原版PDF) 与 `zhCNTar`(LaTeX源码) 1 小时，`zhCN`(中文PDF) 只有 **6 分钟**。所以务必"先调 `arxivFiles` 拿到新链接，立刻下载"，不要缓存 URL。

---

## 4. 配套脚本 `hjfy_client.py` 用法

```bash
# 基本用法：查一篇论文，若非 finished 就轮询，可下载
python3 hjfy_client.py 2506.17310

# 常用参数
python3 hjfy_client.py 2506.17310 --download          # 下载 origin/zhCN/zhCNTar 三件套
python3 hjfy_client.py 2506.17310 --download --only zhCN   # 只下中文 PDF
python3 hjfy_client.py 2506.17310 --wait              # 新任务时阻塞轮询直到完成(需已登录)
python3 hjfy_client.py 2506.17310 --json              # 只打印原始 JSON
python3 hjfy_client.py "https://arxiv.org/abs/2506.17310"  # 直接贴 URL 也行
python3 hjfy_client.py 2506.17310 --cookies cookies.txt    # 指定 cookie 文件
```

脚本行为：
- 默认只查询+打印信息，**不下载**（加 `--download` 才下载，避免误操作）。
- 未登录且论文未翻译时明确提示"需要登录才能创建翻译任务"，并给出登录指引。
- 已登录 + 论文未翻译：`--wait` 会轮询直到任务完成再自动下载；不轮询时打印当前状态。
- 全流程用 `requests`，超时、重试、状态日志都做了基本处理，可直接改造成批量脚本。

---

## 5. 直接拼接口的极简示例（不依赖脚本）

```bash
ID=2506.17310
BASE=https://hjfy.top

# 1 元数据
curl -s "$BASE/api/arxivInfo/$ID"

# 2 任务状态
curl -s "$BASE/api/arxivStatus/$ID"
#  {"status":0,"data":{"status":"finished","info":...}}   → 可下载
#  {"status":101,"msg":"required login"}                  → 未翻译, 需登录

# 3 取文件直链(每次实时签名的 URL)
FILES=$(curl -s "$BASE/api/arxivFiles/$ID")

# 4 用 python 从返回里抽出中文 PDF 地址并下载
python3 - "$FILES" <<'EOF'
import json,sys,urllib.request
d=json.loads(sys.argv[1])["data"]
for k in ("id","title"):
    print(k,"=",d[k])
url=d["zhCN"]                       # 中文PDF, 6分钟有效
urllib.request.urlretrieve(url,"out_zh_CN.pdf")
print("saved out_zh_CN.pdf")
EOF

# 登录后(带 cookie)可触发新论文:
# curl -s -b "session=你的session" "$BASE/api/arxivStatus/2507.00001"
```

---

## 6. 常见问题 / 限制

1. **为什么新论文要登录？** 网站防机器人刷任务的措施（接口返回 `101 required login`），只挡"建任务"这一步，不挡查询和下载。
2. **登录无法自动化？** 微信扫码和阿里云滑块都要求真人，正规做法是浏览器登录一次 → 导出 cookie → 脚本复用（cookie 有效期 90 天），不必每天登录。
3. **`status:failed / error / fault` 区别**：failed=翻译失败，error=没有 LaTeX 源码，fault=编译（tex 重新编译回 PDF）失败——fault 时网页会给 `zhCNTar` 源码链接，仍可下载源码，但中文 PDF 没有。
4. **批量/高频使用注意**：接口无客户端签名、实测无显式限流，但这是个人站（阿里云 FC + OSS），请控制频率、自用为主，别把人家带宽打爆。
5. **OSS 直链有效期短**（中文 PDF 6 分钟），批量下载请"边取边下"，不要存 URL。
6. **`isDeepSeek` 字段**：表示该任务是否用 DeepSeek 模型翻译（网站另有 DeepSeek 通道，可能涉及会员/计费），普通任务为 `false`。本文档只覆盖默认通道。

---

## 7. 接口调用时序图

```
浏览器/脚本                          hjfy.top (阿里云FC)                 arXiv官方API / OSS
   │ ① GET /api/arxivInfo/{id} ───→ │ ── 代理查询 id_list ────────→ │
   │  ← {"hasSrc":true, meta:XML} ← │ ←  Atom XML 摘要  ←───────── │
   │ ② GET /api/arxivStatus/{id} ─→ │                              │
   │  ← finished / processing / 101 │                              │
   │   (未翻译+未登录 → 101,不建任务)  │                              │
   │   (未翻译+已登录 → 服务端建任务)   │                              │
   │ ③ GET /api/arxivFiles/{id} ──→ │ ── 生成3个OSS签名URL ───────→ │
   │  ← origin/zhCN/zhCNTar URL ←  │ ←                          ← │
   │ ④ GET OSS签名URL ────────────→│──────────────────────────────→│ (下载PDF/tgz)
```

---

*文档与脚本同步维护。接口若日后改动，以浏览器 Network 面板实际请求为准。*
