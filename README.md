# HJFY-PDFTranslate（Zotero 7 插件）

自动获取 **arXiv 中文翻译 PDF**（来自 https://hjfy.top/ 的翻译服务），并把翻译结果作为名为 **`PDF-CN`** 的附件挂到当前条目下。

配套文档：[hjfy_top_使用文档.md](./hjfy_top_使用文档.md)（接口逆向全过程）。

---

## 功能

| 场景 | 行为 |
|---|---|
| 条目「网址」字段含 arXiv 链接（`arxiv.org/abs|pdf` / `alphaxiv.org` / 裸 ID） | 右键 → **获取翻译 PDF (HJFY-PDFTranslate)** → 自动走 查询→轮询→取文件→下载→挂 `PDF-CN` 附件 |
| 条目「网址」字段为空或不是 arXiv | 右键后弹出对话框：**输入 arXiv 链接** 或 **上传条目已有 PDF 翻译** |
| 已存在 `PDF-CN` 附件 | 重新获取时**自动替换**旧附件 |
| 翻译需要登录（新论文 / 上传 PDF） | 在 `Zotero → 设置 → HJFY-PDFTranslate` 里登录一次即可（会话 90 天有效） |

---

## 安装

1. 打开 Zotero 7 → 菜单 `工具 → 插件`（或 `编辑 → 设置 → 高级 → 插件`）。
2. 点右上角齿轮 ⚙ → **Install Plugin From File...** → 选择 `hjfy-pdftranslate-0.1.0.xpi`。
3. 按提示**重启 Zotero**。
4. 安装后在条目上右键，菜单里出现 **「获取翻译 PDF (HJFY-PDFTranslate)」**。

> 卸载：插件页面 → 齿轮 → 禁用/移除后重启。

---

## 配置：登录（只有翻译「新论文」或上传 PDF 才需要）

1. **浏览器**打开 https://hjfy.top/ ，用微信扫码或手机号登录。
2. 登录后按 **F12** → 切到 **Console（控制台）** → 输入：
   ```js
   copy(document.cookie)
   ```
   回车后复制到剪贴板。
3. 回到 Zotero → `编辑/设置 → 高级 → HJFY-PDFTranslate` 设置面板 → 把内容**粘贴到输入框** → 点 **保存并验证**。
   - 侧栏名称显示为 `HJFY-PDFTranslate`；打开面板后顶部显示品牌标题 **「幻觉翻译 Zotero 版 PDF 翻译」**。
   - 显示「已登录: xxx」即成功（插件会把 session 写进 Zotero 的 cookie 库，之后请求自动携带）。
   - 也可以点「打开登录页面」在默认浏览器打开 hjfy.top。
4. 随时可「验证当前状态 / 清除登录」。

> 手机号登录中间的**阿里云滑块验证码**只能人工过，所以登录这一步在浏览器里手动完成由插件保存会话，是最省事且合规的方式。

---

## 使用

- **有 arXiv 链接的条目**：选中条目 → 右键 → 「获取翻译 PDF (HJFY-PDFTranslate)」。
  - 已翻译过的论文：直接下载中文 PDF，几秒完成。
  - 未翻译的新论文：插件每 10 秒轮询，翻译通常 1~10 分钟，完成后自动挂附件。
- **无 arXiv 链接的条目**：右键后弹窗，可：
  - 手动输入 arXiv 链接/ID（走相同链路）；
  - 或一键上传条目自带的 PDF 附件去翻译（需要登录，输出可能是 PDF 或 Markdown，仍挂为 `PDF-CN`）。

附件标题固定为 **`PDF-CN`**，便于识别与批量处理；重复获取会先删旧附件再导入新文件。

---

## 目录结构

```
HJFY-PDFTranslate/                                  # ★ 开发目录名（产品/显示名统一为 HJFY-PDFTranslate）
├── hjfy-pdftranslate-0.1.0.xpi              # 可直接安装的插件包
├── manifest.json               # 插件清单 (id: hjfy-pdftranslate@hjfy.top)
├── chrome.manifest             # 内容注册 + 右键菜单 overlay
├── bootstrap.js                # Zotero 启动入口
├── hjfy_top_使用文档.md         # 接口逆向/流程文档
└── content/
    ├── scripts/core.js         # 纯逻辑: arXiv解析 + API + 流程编排 (可 Node 测试)
    ├── scripts/plugin.js       # Zotero 胶水: 菜单/面板/会话/附件
    ├── preferences/preferences.xhtml  # 设置面板(登录)
    ├── dialogs/arxivInput.xhtml        # 无URL时的输入弹窗
    └── itemTreeMenuPopup.xhtml         # 右键菜单项
```

---

## 已验证 / 待验证

**已在真实接口上验证（含真实登录会话）**：
- [x] `parseArxivId`：新式/旧式/带版本号/URL 各种格式
- [x] `arxivInfo / arxivStatus / arxivFiles` 匿名可用（已翻译论文无需登录）
- [x] 已翻译论文全流程（2506.17310）→ 下载中文 PDF / 原版 PDF / LaTeX 包成功
- [x] 未翻译论文匿名返回 `need_login`，带版本号自动降级到无版本号
- [x] **登录会话有效**：`/api/userinfo` 返回 `login:true`（真实账号验证）
- [x] **新论文翻译（需登录）**：`arxivStatus` 带会话自动创建任务 `start` → 轮询约 2 分钟 → `finished` → 下载中文 PDF + LaTeX 源码成功
- [x] **上传 PDF 翻译（需登录）**：`uploadFiles` → `fileKey` → `fileStatus` 轮询 → `finished` → `fileFiles` 返回 `translate_zh_CN.md`（**Markdown 产物**，内容为真实中文翻译，已验证）
  - 注：上传翻译产物是 Markdown（非 PDF）；站点自身标注该功能「处于实验阶段」，超大/复杂 PDF 可能失败（实测 26 页 arXiv 原版 PDF 失败，小型 PDF 成功）
- [x] **微信扫码登录全自动模拟**：`qrconnect` 生成二维码 → 扫码/确认 → `errcode=405+wx_code` → 自动导航 `callback/wechat` → 捕获新 session → `userinfo` 验证 `login:true`（state 由 `tools/wechat_qr_state.js` 严格解析，注意与网页登录码表不同：405=成功/404=已扫/408=等待）
- [ ] Zotero 插件本体（右键菜单/面板/弹窗/附件挂载）——需在装好插件后由你确认

> 说明：模拟使用的会话为真实登录的 hjfy.top 账号，流程与插件 `core.js` 完全一致
> （`tools/simulate.js` 可复现：`HJFY_COOKIE="session=..." node tools/simulate.js arxiv <id>`）。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 右键菜单里没有该菜单项 | 确认已重启 Zotero；查看 `帮助 → 调试输出日志` 里有无 `HJFY-PDFTranslate` 及报错 |
| 提示需要登录 | 到设置面板完成登录（见上），登录后重试 |
| 新论文一直 101 | 未登录；或服务端当晚/当次才建任务，登录后即建 |
| 上传提示「需要登录」 | 上传接口强制登录，设置面板登录后再试 |
| `error`（无源码） | arXiv 部分论文不公开 LaTeX 源码，无法翻译 |
| `fault`（编译失败） | 翻译 OK 但重编译回 PDF 失败，服务端定期修复，可稍后重试 |

---

## 安全提示

- `session` 等价于你在 hjfy.top 的登录凭证，**不要泄露/分享**；用完可在面板「清除登录」并到网站退出登录。
- 本插件仅在本地请求 hjfy.top 官方接口，与网站自身的反爬约定一致，请合理控制频率、自用为主。
