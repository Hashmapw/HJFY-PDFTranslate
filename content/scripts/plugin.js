/*
 * HJFY-PDFTranslate / content/scripts/plugin.js
 * Zotero 插件主体：右键菜单、设置面板、会话 cookie、arXiv/上传流程、PDF-CN 附件挂载。
 * 依赖: core.js (全局 HJFYCore)。bootstrap 需先 loadSubScript core.js。
 */
"use strict";

(function () {
	const PREFS = "extensions.hjfy-pdftranslate.";
	const SITE = "hjfy.top";
	const BASE = "https://hjfy.top";
	const VERSION_FALLBACK = true;

	let Services = null;
	function getServices() {
		if (!Services) {
			try {
				Services = ChromeUtils.import("resource://gre/modules/Services.jsm").Services;
			} catch (e) {
				Services = null;
			}
		}
		return Services;
	}

	let IOUtils = null;
	function getIOUtils() {
		if (!IOUtils) {
			try {
				IOUtils = ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs").IOUtils;
			} catch (e) {
				IOUtils = null;
			}
		}
		return IOUtils;
	}

	function log(...args) {
		Zotero.debug(
			"HJFY-PDFTranslate: " +
				args.map((x) => (typeof x === "string" ? x : x && x.message ? x.message : JSON.stringify(x))).join(" ")
		);
	}

	class HJFYPlugin {
		constructor(rootURI) {
			this.rootURI = rootURI;
			this.api = HJFYCore.createApi((method, url, body) => this._request(method, url, body));
			this._onProgress = null;
		}

		// ================= 生命周期 =================
		init() {
			try {
				this._registerMenu();
				this._registerPrefsPane();
				log("init done");
			} catch (e) {
				log("init error", e);
			}
		}

		onMainWindowLoad(win) {}

		onMainWindowUnload(win) {}

		shutdown() {}

		// ================= 会话 (session cookie) =================
		getSessionPref() {
			try {
				return Zotero.Prefs.get(PREFS + "session", true) || "";
			} catch (e) {
				return "";
			}
		}

		async checkLogin() {
			try {
				const u = await this._request("GET", `${BASE}/api/userinfo`);
				return u && u.login ? u : { login: false };
			} catch (e) {
				log("checkLogin error", e);
				return { login: false, error: String(e) };
			}
		}

		/**
		 * 保存会话: 接受 "session=xxx" 或裸 "xxx"
		 * 写入 Zotero cookie service, 使 Zotero.HTTP(useCookieService) 请求自动携带
		 */
		async saveSession(rawValue) {
			let value = "";
			if (rawValue) {
				const s = String(rawValue).trim();
				const m = s.match(/(?:^|;\s*)session=([^;]+)/i);
				if (m) value = m[1];
				else value = s;
			}
			if (!value) {
				return { ok: false, msg: "内容为空，请输入 document.cookie 的输出" };
			}
			const cm = getServices().cookies;
			try {
				cm.remove(SITE, "session", "/", {});
			} catch (e) {
				/* ignore */
			}
			const expiry = Math.floor(Date.now() / 1000) + 90 * 24 * 3600;
			try {
				// 新签名(带 sameSite)
				cm.add(SITE, "/", "session", value, true, true, false, expiry, {}, Ci.nsICookie.SAMESITE_LAX);
			} catch (e) {
				// 老签名(9 参数)
				try {
					cm.add(SITE, "/", "session", value, true, true, false, expiry, {});
				} catch (e2) {
					log("saveSession cookie set error", e2);
					return { ok: false, msg: "写入 cookie 失败: " + e2 };
				}
			}
			Zotero.Prefs.set(PREFS + "session", value, true);
			const u = await this.checkLogin();
			if (u && u.login) {
				return { ok: true, user: u };
			}
			return { ok: false, msg: "会话已保存，但 hjfy.top 验证未通过(可能过期)" };
		}

		async clearSession() {
			try {
				getServices().cookies.remove(SITE, "session", "/", {});
			} catch (e) {
				/* ignore */
			}
			Zotero.Prefs.set(PREFS + "session", "", true);
		}

		// ================= HTTP (Zotero.HTTP, 带 cookie) =================
		async _request(method, url, body) {
			const options = {
				useCookieService: true,
				timeout: 60000,
				responseType: "json",
				successCodes: [200, 201, 204, 302],
			};
			if (body) {
				if (body.headers) options.headers = body.headers;
				if (body.payload !== undefined) options.body = body.payload;
			}
			const resp = await Zotero.HTTP.request(method, url, options);
			return resp && typeof resp.response !== "undefined" ? resp.response : resp;
		}

		async downloadToFile(url, destPath) {
			log("download -> " + destPath);
			const resp = await Zotero.HTTP.request("GET", url, {
				useCookieService: true,
				timeout: 180000,
				responseType: "arraybuffer",
				onProgress: (loaded, total) => {
					if (total > 0 && this._onProgress) this._onProgress(loaded, total);
				},
			});
			const bytes = new Uint8Array(resp.response);
			await getIOUtils().write(destPath, bytes, { tmpPath: destPath + ".tmp" });
			return destPath;
		}

		// ================= 纯净 PDF =================
		isCleanPdfEnabled() {
			try {
				return !!Zotero.Prefs.get("extensions.hjfy-pdftranslate.cleanPdf", true);
			} catch (e) {
				return false;
			}
		}

		setCleanPdfEnabled(value) {
			Zotero.Prefs.set("extensions.hjfy-pdftranslate.cleanPdf", !!value, true);
			log("纯净PDF ->", !!value);
		}

		/**
		 * 开启"纯净PDF"且产物为 PDF 时, 去掉译文第1页顶部的 hjfy 水印链接(视觉)
		 * 用白色矩形覆盖顶部区域, 由 pdf-lib 重写 PDF
		 */
		async _maybeCleanPdf(destPath, origUrl) {
			if (!this.isCleanPdfEnabled()) return destPath;
			if (!/\.pdf($|[?#])/i.test(origUrl || "")) return destPath;
			try {
				const bytes = await getIOUtils().read(destPath);
				const cleaned = await this._cleanPdfBytes(bytes);
				if (cleaned && cleaned.length > 0) {
					await getIOUtils().write(destPath, cleaned, { tmpPath: destPath + ".tmp" });
					log("纯净PDF: 已去除首页水印");
				}
			} catch (e) {
				// 清理失败时沿用原文件, 不影响主流程
				log("cleanPdf error", e);
			}
			return destPath;
		}

		async _cleanPdfBytes(bytes) {
			const lib =
				(typeof globalThis !== "undefined" && globalThis.PDFLib) ||
				(typeof PDFLib !== "undefined" ? PDFLib : null);
			if (!lib) {
				log("PDFLib 未加载(纯净PDF 将跳过)");
				return null;
			}
			const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
			const page = doc.getPage(0);
			const { width, height } = page.getSize();
			// 水印位于译文第1页顶部(y≈6~18pt), 覆盖顶部 22pt 条带
			const strip = 22;
			page.drawRectangle({ x: 0, y: height - strip, width, height: strip, color: lib.rgb(1, 1, 1) });
			const out = await doc.save({ useObjectStreams: false });
			return new Uint8Array(out);
		}

		// ================= 附件 =================
		_attachmentTitle() {
			return "PDF-CN";
		}

		async _findExistingPdfCN(item) {
			const out = [];
			for (const id of item.getAttachments() || []) {
				const child = Zotero.Items.get(id);
				if (child && child.isAttachment() && child.getField("title") === this._attachmentTitle()) {
					out.push(child);
				}
			}
			return out;
		}

		async addPdfCNAttachment(item, filePath) {
			const title = this._attachmentTitle();
			await Zotero.DB.executeTransaction(async () => {
				for (const a of await this._findExistingPdfCN(item)) {
					await a.eraseTx();
				}
				const attachment = await Zotero.Attachments.importFromFile({
					file: filePath,
					parentItemID: item.id,
				});
				attachment.setField("title", title);
				await attachment.saveTx();
			});
			return true;
		}

		async getItemPdfPath(item) {
			for (const id of item.getAttachments() || []) {
				const child = Zotero.Items.get(id);
				if (!child || !child.isAttachment()) continue;
				if (child.attachmentContentType !== "application/pdf") continue;
				const p = await child.getFilePathAsync();
				if (p) {
					return { path: p, fileName: child.getField("filename") || "paper.pdf" };
				}
			}
			return null;
		}

		// ================= 流程入口 =================
		async handleSelectedItems(items) {
			for (const raw of items || []) {
				let item = raw;
				try {
					if (item.isAttachment() || item.isNote()) {
						const parent = item.parentItem;
						if (!parent) continue;
						item = parent;
					}
				} catch (e) {
					continue;
				}
				if (item.isCollection()) continue;
				try {
					await this.handleItem(item);
				} catch (e) {
					log("handleItem error", e);
					this.notify("获取翻译 PDF 出错: " + (e && e.message ? e.message : e), "fail");
				}
			}
		}

		async handleItem(item) {
			const url = item.getField("url");
			const id = HJFYCore.parseArxivId(url || "");
			if (id) {
				return await this.runArxiv(item, id);
			}
			const choice = await this.openArxivDialog(item);
			if (!choice || choice.mode === "cancel") return null;
			if (choice.mode === "upload") {
				return await this.runUpload(item, null);
			}
			if (choice.mode === "arxiv") {
				const cid = HJFYCore.parseArxivId(choice.text || "");
				if (!cid) {
					this.notify("未识别到有效的 arXiv 链接", "fail");
					return null;
				}
				return await this.runArxiv(item, cid);
			}
			return null;
		}

		/**
		 * arXiv 翻译流程: 查询 -> 状态 -> 取文件 -> 下载 -> 挂 PDF-CN
		 */
		async runArxiv(item, arxivId) {
			const { pitem, pw } = this._newProgress(`${arxivId} 查询中...`);
			this._onProgress = (loaded, total) => pitem.setProgress(Math.round((loaded / total) * 100), 100);
			try {
				const result = await HJFYCore.flowArxiv(this.api, arxivId, {
					wait: true,
					pollInterval: 10000,
					allowVersionFallback: VERSION_FALLBACK,
					onStatus: (status, data) => {
						pitem.setText(`${arxivId}: ${status}${data.info ? " | " + data.info : ""}`);
					},
				});

				if (result.stage === "need_login") {
					this._endProgress(pw);
					this.notify(`「${arxivId}」的翻译还没开始，需要登录后才能创建任务。请在 设置→HJFY-PDFTranslate 完成登录`, "fail");
					return null;
				}
				if (result.stage === "no_src") {
					this._endProgress(pw);
					this.notify(`${arxivId} 没有 LaTeX 源码，无法翻译`, "fail");
					return null;
				}
				if (["failed", "error", "fault"].includes(result.stage)) {
					this._endProgress(pw);
					this.notify(`${arxivId} 翻译${result.stage === "fault" ? "编译失败" : "失败"}`, "fail");
					return null;
				}
				if (["info_error", "api_error", "http_error"].includes(result.stage)) {
					this._endProgress(pw);
					this.notify("查询失败: " + (result.msg || result.stage), "fail");
					return null;
				}

				const files = result.files || {};
				if (!files.zhCN) {
					this._endProgress(pw);
					this.notify("未获得翻译文件地址", "fail");
					return null;
				}
				const fileName = `hjfy-${(result.plainId || arxivId).replace(/[^\w.\-]/g, "_")}-zh-CN.pdf`;
				const saved = await this.downloadToFile(
					files.zhCN,
					Zotero.File.pathJoin(Zotero.getTempDirectory(), fileName)
				);
				// 纯净PDF: 去除译文第1页顶部的水印链接(视觉效果)
				await this._maybeCleanPdf(saved, files.zhCN);
				pitem.setText("写入附件...");
				await this.addPdfCNAttachment(item, saved);
				this._endProgress(pw);
				this.notify(`已添加 PDF-CN 附件: ${files.title || arxivId}`, "success");
				return true;
			} catch (e) {
				this._endProgress(pw);
				log("runArxiv error", e);
				this.notify("获取翻译失败: " + (e && e.message ? e.message : e), "fail");
				return null;
			} finally {
				this._onProgress = null;
			}
		}

		/**
		 * 上传 PDF 翻译流程: 上传 -> 轮询 -> 取文件 -> 下载 -> 挂 PDF-CN
		 */
		async runUpload(item, optPdfPath) {
			let pdf = null;
			if (optPdfPath) {
				pdf = { path: optPdfPath, fileName: optPdfPath.split(/[\\/]/).pop() };
			} else {
				pdf = await this.getItemPdfPath(item);
			}
			if (!pdf) {
				this.notify("该条目没有可上传的 PDF 附件", "fail");
				return null;
			}

			const { pitem, pw } = this._newProgress("上传 PDF 翻译中...");
			this._onProgress = (loaded, total) => pitem.setProgress(Math.round((loaded / total) * 100), 100);
			try {
				pitem.setText("上传 PDF...");
				const upResp = await this.uploadFile(pdf);
				if (!upResp || upResp.status !== 0) {
					this._endProgress(pw);
					const msg =
						upResp && upResp.status === 500
							? "上传需要登录，请先在 设置→HJFY-PDFTranslate 里登录"
							: (upResp && upResp.msg) || "上传失败";
					this.notify(msg, "fail");
					return null;
				}
				// 上传的 PDF 被识别为 arXiv 论文(302 -> arxivId)，自动改走 arXiv 流程
				if (upResp.arxivId) {
					this._endProgress(pw);
					this.notify("检测到 arXiv 论文，改用 arXiv 翻译流程: " + upResp.arxivId);
					return await this.runArxiv(item, upResp.arxivId);
				}
				const fileKey = (upResp.data && upResp.data.fileKey) || upResp.fileKey;
				if (!fileKey) {
					this._endProgress(pw);
					this.notify("上传返回缺少 fileKey", "fail");
					return null;
				}

				pitem.setText("翻译中...");
				const result = await HJFYCore.flowFile(this.api, fileKey, {
					wait: true,
					pollInterval: 10000,
					onStatus: (status, data) => {
						pitem.setText(`翻译 ${status}${data.info ? " | " + data.info : ""}`);
					},
				});
				if (result.stage === "need_login") {
					this._endProgress(pw);
					this.notify("上传翻译需要登录，请先在 设置→HJFY-PDFTranslate 里登录", "fail");
					return null;
				}
				if (result.stage !== "finished") {
					this._endProgress(pw);
					this.notify(`翻译未完成 (${result.stage}${result.msg ? " " + result.msg : ""})`, "fail");
					return null;
				}

				const files = result.files || {};
				if (!files.zhCN) {
					this._endProgress(pw);
					this.notify("未获得翻译文件地址", "fail");
					return null;
				}
				pitem.setText("下载翻译结果...");
				const isPdf = /\.pdf($|[?#])/i.test(files.zhCN);
				const ext = isPdf ? ".pdf" : ".md";
				const saved = await this.downloadToFile(
					files.zhCN,
					Zotero.File.pathJoin(Zotero.getTempDirectory(), `hjfy-upload-${Date.now()}${ext}`)
				);
				// 纯净PDF: 上传翻译产物若为 PDF 同样去除首页水印
				await this._maybeCleanPdf(saved, files.zhCN);
				await this.addPdfCNAttachment(item, saved);
				this._endProgress(pw);
				this.notify(`已添加 PDF-CN 附件 (${isPdf ? "PDF" : "Markdown"})`, "success");
				return true;
			} catch (e) {
				this._endProgress(pw);
				log("runUpload error", e);
				this.notify("上传翻译失败: " + (e && e.message ? e.message : e), "fail");
				return null;
			} finally {
				this._onProgress = null;
			}
		}

		/** 手动构造 multipart/form-data 上传 PDF (field: file / fileName) */
		async uploadFile(pdf) {
			const fileBytes = await getIOUtils().read(pdf.path);
			const boundary =
				"----HJFYBoundary" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
			const enc = new TextEncoder();
			const safeName = String(pdf.fileName || "paper.pdf").replace(/["\r\n]/g, "_");
			const head = enc.encode(
				`--${boundary}\r\n` +
					`Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
					`Content-Type: application/pdf\r\n\r\n`
			);
			const tail = enc.encode(
				`\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${safeName}\r\n--${boundary}--\r\n`
			);
			const body = new Uint8Array(head.length + fileBytes.length + tail.length);
			body.set(head, 0);
			body.set(fileBytes, head.length);
			body.set(tail, head.length + fileBytes.length);

			const resp = await Zotero.HTTP.request("POST", `${BASE}/api/uploadFiles`, {
				useCookieService: true,
				timeout: 120000,
				responseType: "json",
				headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
				body: body.buffer, // ArrayBuffer
			});
			return resp && typeof resp.response !== "undefined" ? resp.response : resp;
		}

		// ================= UI: 进度与通知 =================
		_newProgress(text) {
			const pw = new Zotero.ProgressWindow();
			const pitem = new pw.ItemProgress("chrome://zotero/skin/treeitem-load.png", text || "处理中...");
			pw.show();
			pw.startCloseTimer(3000);
			return { pw, pitem };
		}

		_endProgress(pw) {
			if (pw) {
				try {
					pw.close();
				} catch (e) {
					/* ignore */
				}
			}
		}

		notify(msg, type, sticky) {
			try {
				const pw = new Zotero.ProgressWindow();
				pw.changeHeadline("HJFY-PDFTranslate");
				pw.addLines([msg]);
				if (type === "success") pw.ItemProgress("chrome://zotero/skin/tick.png", "");
				else if (type === "fail") pw.ItemProgress("chrome://zotero/skin/cross.png", "");
				if (!sticky) pw.startCloseTimer(5000);
				pw.show();
			} catch (e) {
				log("notify error", e);
			}
		}

		// ================= 右键菜单 =================
		_registerMenu() {
			Zotero.ItemTreeManager.register({
				type: "menu",
				name: "hjfy-pdftranslate.fetchCN",
				onMenuPopup: (menu) => {
					try {
						const items = Zotero.getActiveZoteroPane().getSelectedItems();
						menu.disabled = !items || items.length === 0;
						menu.hidden = !items || items.length === 0;
					} catch (e) {
						menu.disabled = true;
					}
				},
				onCommand: (command, selectedItems) => {
					const items =
						selectedItems && selectedItems.length
							? selectedItems
							: Zotero.getActiveZoteroPane().getSelectedItems();
					this.handleSelectedItems(items);
				},
			});
			log("menu registered");
		}

		// ================= 设置面板 =================
		_registerPrefsPane() {
			Zotero.PreferencePanes.register({
				pluginID: "hjfy-pdftranslate@hjfy.top",
				src: this.rootURI + "content/preferences/preferences.xhtml",
				label: "HJFY-PDFTranslate",
				onLoad: (win) => {},
			});
			log("prefs pane registered");
		}

		/**
		 * 由 preferences.xhtml 的内联脚本调用：装配 微信/手机号/粘贴 登录与退出
		 */
		async setupPrefs(win) {
			const doc = win.document;
			const statusEl = doc.getElementById("hjfy-status");
			const sessionInput = doc.getElementById("hjfy-session-input");

			const render = async () => {
				const u = await this.checkLogin();
				if (u && u.login) {
					statusEl.textContent = "已登录: " + (u.nickname || "未知用户");
					statusEl.style.color = "#2e7d32";
				} else {
					statusEl.textContent = "未登录" + (u && u.error ? "（网络异常）" : "—— 请用微信扫码或手机号登录");
					statusEl.style.color = "#c62828";
				}
				sessionInput.value = this.getSessionPref() ? "session=" + this.getSessionPref() : "";
			};

			// --- ① 微信扫码 ---
			const wxBtn = doc.getElementById("hjfy-wechat-login");
			if (wxBtn) wxBtn.addEventListener("click", () => this.openWechatLogin(() => render()));

			// --- ② 手机号 ---
			const phoneInput = doc.getElementById("hjfy-phone");
			const codeInput = doc.getElementById("hjfy-phone-code");
			const sendBtn = doc.getElementById("hjfy-send-code");
			const phoneBtn = doc.getElementById("hjfy-phone-login");
			const sendStatus = doc.getElementById("hjfy-send-status");
			if (sendBtn) {
				sendBtn.addEventListener("click", async () => {
					const phone = (phoneInput.value || "").trim();
					if (!/^1\d{10}$/.test(phone)) {
						this.notify("请输入正确的 11 位手机号", "fail");
						return;
					}
					sendStatus.textContent = "发送中...";
					const r = await this.trySendCode(phone);
					sendStatus.textContent = r.ok
						? "验证码已发送，请查收短信"
						: r.needCaptcha
							? "请在打开的网页中过滑块发送验证码，再把验证码填到这里"
							: r.msg || "发送失败";
				});
			}
			if (phoneBtn) {
				phoneBtn.addEventListener("click", async () => {
					const phone = (phoneInput.value || "").trim();
					const code = (codeInput.value || "").trim();
					if (!/^1\d{10}$/.test(phone) || !/^\d{4,6}$/.test(code)) {
						this.notify("请填写正确的手机号和验证码", "fail");
						return;
					}
					const r = await this.phoneLogin(phone, code);
					if (r && r.ok) {
						codeInput.value = "";
						this.notify("手机号登录成功: " + (r.user.nickname || ""), "success");
					} else {
						this.notify((r && r.msg) || "登录失败", "fail");
					}
					await render();
				});
			}

			// --- 高级: 粘贴会话 ---
			const saveBtn = doc.getElementById("hjfy-save");
			const clearBtn = doc.getElementById("hjfy-clear");
			const openBtn = doc.getElementById("hjfy-openlogin");
			const verifyBtn = doc.getElementById("hjfy-verify");
			if (saveBtn) {
				saveBtn.addEventListener("click", async () => {
					const r = await this.saveSession(sessionInput.value);
					if (r && r.ok) this.notify("已保存并验证: " + (r.user.nickname || ""), "success");
					else this.notify((r && r.msg) || "保存失败", "fail");
					await render();
				});
			}
			if (verifyBtn) verifyBtn.addEventListener("click", () => render());
			if (clearBtn) {
				clearBtn.addEventListener("click", async () => {
					await this.clearSession();
					await render();
				});
			}
			if (openBtn) openBtn.addEventListener("click", () => Zotero.Utilities.Internal.openURL("https://hjfy.top/"));

			// --- 退出登录 ---
			const logoutBtn = doc.getElementById("hjfy-logout");
			if (logoutBtn) {
				logoutBtn.addEventListener("click", async () => {
					await this.logout();
					await render();
					this.notify("已退出登录", "success");
				});
			}

			// --- 下载设置: 纯净 PDF ---
			const cleanCb = doc.getElementById("hjfy-clean-pdf");
			if (cleanCb) {
				cleanCb.checked = this.isCleanPdfEnabled();
				cleanCb.addEventListener("change", () => {
					this.setCleanPdfEnabled(cleanCb.checked);
					this.notify("纯净 PDF " + (cleanCb.checked ? "已开启" : "已关闭"), "success");
				});
			}

			await render();
		}

		// ================= 登录: 微信扫码 =================
		/**
		 * 打开微信扫码登录窗口(非模态)。窗口内走完回调后 onSuccess 会带回 session。
		 * 兜底: 若二维码窗口被顶层跳转导航走, 本函数会轮询本地 cookie 直到登录完成或超时。
		 */
		openWechatLogin(onChanged) {
			const svc = getServices();
			let done = false;
			const onLoginSeen = async (sessionValue) => {
				if (done) return;
				done = true;
				const r = await this.saveSession(sessionValue);
				if (r && r.ok) this.notify("微信登录成功: " + (r.user.nickname || ""), "success");
				else this.notify("微信登录失败: " + ((r && r.msg) || "会话无效"), "fail");
				if (onChanged) onChanged();
			};
			// 兜底检测: 某些情况下二维码窗口被顶层跳转导航走导致内部脚本失效, 这里从 cookie 库轮询
			const pre = (() => {
				try {
					return this._readSessionCookie();
				} catch (e) {
					return null;
				}
			})();
			const started = Date.now();
			const timer = setInterval(async () => {
				try {
					const s = this._readSessionCookie();
					if (s && (!pre || s !== pre)) {
						clearInterval(timer);
						onLoginSeen(s);
					} else if (Date.now() - started > 11 * 60 * 1000) {
						clearInterval(timer);
					}
				} catch (e) {
					clearInterval(timer);
				}
			}, 2000);
			const args = {
				onSuccess: (sessionValue) => {
					clearInterval(timer);
					onLoginSeen(sessionValue);
				},
			};
			try {
				svc.ww.openWindow(
					null,
					"chrome://hjfy-pdftranslate/content/dialogs/wechatLogin.xhtml",
					"hjfy-wechat-login",
					"chrome,centerscreen,resizable,width=480,height=580",
					args
				);
			} catch (e) {
				clearInterval(timer);
				log("openWechatLogin error", e);
				this.notify("打开微信登录窗口失败: " + e, "fail");
			}
		}

		_readSessionCookie() {
			const cm = getServices().cookies.getCookiesFromHost(SITE, {});
			while (cm.hasMoreElements()) {
				const c = cm.getNext().QueryInterface(Ci.nsICookie);
				if (c.name === "session") return c.value;
			}
			return null;
		}

		// ================= 登录: 手机号 =================
		/** 发送验证码: 先尝试直连接口; 若要求人机识别则打开网站由用户过滑块 */
		async trySendCode(phone) {
			try {
				const j = await this._request("POST", `${BASE}/api/sendCode`, {
					headers: { "Content-Type": "application/json" },
					payload: JSON.stringify({ phone }),
				});
				if (j && j.status === 0) return { ok: true };
				if (j && j.status === 400) {
					Zotero.Utilities.Internal.openURL("https://hjfy.top/");
					return { ok: false, needCaptcha: true, msg: j.msg };
				}
				return { ok: false, msg: (j && j.msg) || "发送失败" };
			} catch (e) {
				log("trySendCode error", e);
				return { ok: false, msg: String(e) };
			}
		}

		/** 手机号 + 验证码登录 -> session -> 保存并验证 */
		async phoneLogin(phone, code) {
			try {
				const j = await this._request("POST", `${BASE}/api/phoneLogin`, {
					headers: { "Content-Type": "application/json" },
					payload: JSON.stringify({ phone, code }),
				});
				if (!j || j.status !== 0) {
					return { ok: false, msg: (j && j.msg) || "登录失败" };
				}
				const session = j.data && j.data.session;
				if (!session) return { ok: false, msg: "接口未返回 session" };
				return await this.saveSession(session);
			} catch (e) {
				log("phoneLogin error", e);
				return { ok: false, msg: String(e) };
			}
		}

		// ================= 退出登录 =================
		async logout() {
			try {
				await this._request("POST", `${BASE}/api/logout`);
			} catch (e) {
				log("logout api error", e);
			}
			await this.clearSession();
		}

		// ================= 输入弹窗（无 arXiv 链接时） =================
		openArxivDialog(item) {
			return new Promise((resolve) => {
				const svc = getServices();
				const args = {
					itemTitle: "",
					done: (choice) => resolve(choice || { mode: "cancel" }),
				};
				try {
					args.itemTitle = item.getField("title") || "";
				} catch (e) {
					/* ignore */
				}
				try {
					svc.ww.openWindow(
						null,
						"chrome://hjfy-pdftranslate/content/dialogs/arxivInput.xhtml",
						"hjfy-pdftranslate-input",
						"chrome,centerscreen,modal,resizable,width=560,height=460",
						args
					);
					// 模态窗口关闭后仍未选择则取消
					setTimeout(() => resolve({ mode: "cancel" }), 0);
				} catch (e) {
					log("openArxivDialog error", e);
					resolve({ mode: "cancel" });
				}
			});
		}
	}

	Zotero.HJFYPlugin = HJFYPlugin;
	Zotero.HJFY = null;
})();
