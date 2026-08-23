<p align="center">
  <img src="content/resources/logo.svg" width="96" alt="HJFY-PDFTranslate"/>
</p>

<h1 align="center">HJFY-PDFTranslate · 幻觉翻译 Zotero 版 PDF 翻译</h1>

<p align="center">
  <b>在 Zotero 里，一条快捷键把 arXiv 论文变成中文 PDF。</b><br/>
  <img src="https://img.shields.io/badge/Zotero-7%20%2F%208%20%2F%209-blue?style=flat-square" alt="Zotero 7 / 8 / 9"/>
  <a href="https://arxiv.org" target="_blank">
    <img src="https://img.shields.io/badge/支持-ArXiv%20%2F%20PDF%20上传-3366FF?style=flat-square" alt="ArXiv/PDF"/>
  </a>
  <a href="https://hjfy.top" target="_blank">
    <img src="https://img.shields.io/badge/翻译服务-hjfy.top-22CCEE?style=flat-square" alt="hjfy.top"/>
  </a>
</p>


> **兼容 Zotero 7 / 8 / 9**：插件清单未设版本上限，升级 Zotero 也不影响使用，未来版本计划持续支持。

---

## 这个插件是干什么的？

读论文最大的坎不是难，而是**英文**。这个插件把你 Zotero 里的 arXiv 论文一键翻译成中文，并把结果**自动挂回原条目**——不用打开网站、不用复制粘贴。

- 它背后的翻译服务是 [幻觉翻译（hjfy.top）](https://hjfy.top/)，本插件是它的 **Zotero 第三方客户端**。
- 翻译结果会作为一个标题为 **`PDF-CN`** 的附件出现在论文条目下，和原 PDF 并排，方便对照阅读。
- 整个过程（翻译排队、进度、完成）都在 Zotero 右下角有提示，不用守着网页。

## 它能做什么

| 场景 | 你只需要 | 结果 |
|---|---|---|
| 条目「网址」里有 arXiv 链接 | 右键 → **获取幻觉翻译PDF** | 自动翻译并挂上 `PDF-CN` 附件，几秒到几分钟 |
| 条目「网址」是空的/不是 arXiv | 右键后弹窗里**补一个 arXiv 链接**（会在「其他」写入 `arXiv: ID`，保留原网址），或**选择上传条目自带的 PDF** | 走翻译流程，完成后同样挂 `PDF-CN` |
| 想再拿一份 | 重复右键 | **自动替换**旧的 `PDF-CN`，不产生重复附件 |
| 想要更"干净"的译文 | 设置里勾选 **纯净 PDF** | 下载时**直接删除**译文第 1 页顶部的水印链接（hjfy.top 网址），不是简单遮盖 |

另外它还内置了微信扫码和手机号两种登录方式，支持退出后重新登录——只在你第一次让网站翻译**新论文或上传 PDF** 时才需要，平时用不上。

## 和直接打开 hjfy.top 网页比？

| | 网页版 | 本插件 |
|---|---|---|
| 入口 | 打开浏览器 → 输链接 → 等网页 | Zotero 里右键一下 |
| 结果落位 | 手动下载、手动整理 | 自动挂成条目附件 `PDF-CN` |
| 进度 | 盯网页 | 右下角弹窗 + 完成通知 |
| 无网址的论文 | 无解 | 弹窗补链接 / 直接上传条目 PDF |

**一句话**：网页版是"翻译完你自己折腾"，插件是"翻译完自己进 Zotero"。

---

## 快速上手

### 1️⃣ 安装插件

1. 拿到插件包 `hjfy-pdftranslate-0.1.10.xpi`（仓库 Release 或 Actions Artifact 里下载，找不到就问维护者要）。
2. 打开 Zotero → 菜单 **工具 → 插件**。
3. 点右上角 **齿轮 ⚙ → Install Plugin From File...**，选这个 `.xpi`。
4. **重启 Zotero**。完成后，右键任意条目，菜单里会出现 **「获取幻觉翻译PDF」**。

### 2️⃣ 登录（可选，翻译“新论文/上传 PDF”才需要）

Zotero → **编辑/设置 → 高级 → HJFY-PDFTranslate**，选择一种登录方式：

- **微信扫码登录**：点按钮弹出二维码，手机微信扫一扫并确认；登录成功后弹窗自动关闭；
- **手机号登录**：点按钮后插件会清除旧会话并打开 hjfy.top；在页面右上角完成手机号登录，接口验证成功后窗口自动关闭。

登录成功后设置页顶部会显示 **「已登录: 你的昵称」**。会话 90 天内都有效；想退出就点 **「退出登录」**，之后随时可用上面任一方式重新登录。

### 3️⃣ 开始使用

- **有条目网址 = arXiv 链接**：选中条目 → 右键 → **获取幻觉翻译PDF**。
  - 已翻译过 → 几秒直接拿到中文 PDF；
  - 还没翻译过 → 右下角显示进度，1～10 分钟后完成并自动挂附件。
- **条目网址为空/不合法**：右键 → 弹窗二选一——
	- **输入 arXiv 链接**：粘贴链接或 ID，插件会在条目「其他」中写入 `arXiv: ID` 再翻译，不覆盖出版社网址；
	- **上传条目 PDF 翻译**：直接用条目里已有、且不超过 10 MB 的 PDF 附件发起翻译（需要已登录）。

## 常见问题

<details>
<summary><b>一定要登录吗？</b></summary>

下载**已经翻译过**的论文不需要登录；登录只在你**发起新的翻译**（没翻译过的新论文、或上传 PDF）时才需要。未登录时遇到新论文，插件会提示你先去设置里登录。
</details>

<details>
<summary><b>翻译要等多久？</b></summary>

一般 1～10 分钟。新论文的翻译任务在网站那边排队+翻译，插件每 10 秒自动查看一次进度，完成会在右下角通知你。
</details>

<details>
<summary><b>为什么上传翻译后的附件不是 PDF，而是 Markdown？</b></summary>

这是 hjfy.top 对"上传文档"翻译的产出格式（`translate_zh_CN.md`）。插件会如实按产物类型挂为 `PDF-CN` 附件。**arXiv 论文**的翻译产出一律是正经 PDF，不受影响。
</details>

<details>
<summary><b>提示 error / fault / failed 是什么意思？</b></summary>

- `error`：这篇论文没公开 LaTeX 源码，网站没法翻译；
- `fault`：翻译成功但合成 PDF 失败，通常网站会定期修复，稍后重试即可；
- `failed`：翻译失败。arXiv 论文网站会自动复查重试，可稍后再试。
</details>

<details>
<summary><b>插件会不会乱动我的数据？</b></summary>

插件只做三件事：读条目的「网址」或「其他」字段识别 arXiv ID、调用 hjfy.top 翻译、把结果以 `PDF-CN` 附件写回条目。它只和 hjfy.top 通信，不会上传你的其它数据；上传翻译时也只用你选择的那份 PDF。
</details>

<details>
<summary><b>行为和隐私上有啥要注意？</b></summary>

登录 `session` 只保存在 Zotero Cookie Service，等价于你的 hjfy.top 登录凭证，**不要分享给别人**；不用时可在设置页「退出登录」。退出也会结束同一 Zotero profile 中的 hjfy.top 网页会话。也请合理频率使用，别拿它批量刷翻译服务。
</details>

<details>
<summary><b>支持哪些 Zotero 版本？</b></summary>

支持 Zotero 7-10；本次修复已在 Zotero 9.0.6 与隔离的 Zotero 10 运行环境验证。超出 manifest 声明范围的版本需重新测试。
</details>

---

## 开发者 / 进阶

- **接口与流程细节**：见 [docs/hjfy_top_使用文档.md](./docs/hjfy_top_使用文档.md)（逆向分析 + 全链路说明）。
- **开发调试工具**：仓库 `tools/` 下提供了流程模拟器、微信扫码登录调试脚本、qrconnect 状态机及单测，便于复现与排查。
- **在线构建**：本仓库已配置 GitHub Actions，push/PR 自动打 `.xpi` 构建产物，打 `v*` 标签自动发 Release。
- 本地构建：`zip -rq hjfy-pdftranslate-0.1.10.xpi manifest.json chrome.manifest bootstrap.js content locale icon.png`

## 致谢

翻译能力来自 [幻觉翻译 hjfy.top](https://hjfy.top/)。本插件只是把它装进 Zotero 的一个壳，请支持原站。
