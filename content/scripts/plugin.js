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
	const PLUGIN_ID = "hjfy-pdftranslate@hjfy.top";
	const MENU_ID = "hjfy-pdftranslate-fetch-cn";
	const MENU_ELEMENT_ID = "hjfy-pdftranslate-fetchcn";
	const MENU_FTL = "hjfy-pdftranslate.ftl";
	const HTML_NS = "http://www.w3.org/1999/xhtml";

	let ServicesModule = null;
	function getServices() {
		if (ServicesModule) return ServicesModule;
		// Zotero 8+ exposes Services to bootstrap scripts. A sub-script does not
		// always inherit that lexical binding, so use it when available before
		// trying the Gecko module imports used by older Zotero versions.
		try {
			if (typeof Services !== "undefined" && Services) return (ServicesModule = Services);
		} catch (e) {
			/* global Services is unavailable */
		}
		try {
			if (typeof ChromeUtils !== "undefined" && ChromeUtils.importESModule) {
				ServicesModule = ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs").Services;
			}
		} catch (e) {
			try {
				if (typeof ChromeUtils !== "undefined" && ChromeUtils.import) {
					ServicesModule = ChromeUtils.import("resource://gre/modules/Services.jsm").Services;
				}
			} catch (e2) {
				ServicesModule = null;
			}
		}
		if (!ServicesModule) {
			try {
				if (typeof Components !== "undefined" && Components.utils && Components.utils.import) {
					ServicesModule = Components.utils.import("resource://gre/modules/Services.jsm", {}).Services;
				}
			} catch (e) {
				ServicesModule = null;
			}
		}
		return ServicesModule;
	}

	function getMainWindow() {
		try {
			if (typeof Zotero.getMainWindow === "function") {
				const win = Zotero.getMainWindow();
				if (win) return win;
			}
			if (typeof Zotero.getMainWindows === "function") return Zotero.getMainWindows()[0] || null;
		} catch (e) {
			log("get main window error", e);
		}
		return null;
	}

	function openExternalURL(url) {
		if (typeof Zotero.launchURL === "function") return Zotero.launchURL(url);
		const svc = getServices();
		if (svc && svc.externalProtocolService && svc.io && svc.io.newURI) {
			return svc.externalProtocolService.loadURI(svc.io.newURI(url));
		}
		// Zotero 7 fallback; only call it when the function really exists.
		if (Zotero.Utilities && Zotero.Utilities.Internal && typeof Zotero.Utilities.Internal.openURL === "function") {
			return Zotero.Utilities.Internal.openURL(url);
		}
		throw new Error("Zotero does not provide an external URL opener");
	}

	function appendHTMLElement(doc, parent, tag, options = {}) {
		const element = doc.createElementNS(HTML_NS, tag);
		if (options.className) element.className = options.className;
		if (options.text !== undefined) element.textContent = options.text;
		for (const [name, value] of Object.entries(options.attributes || {})) {
			element.setAttribute(name, value);
		}
		parent.appendChild(element);
		return element;
	}

	function prepareDialogDocument(win, title, styles) {
		const doc = win.document;
		doc.title = title;
		doc.documentElement.setAttribute("lang", "zh-CN");
		doc.head.replaceChildren();
		doc.body.replaceChildren();
		appendHTMLElement(doc, doc.head, "meta", { attributes: { charset: "utf-8" } });
		appendHTMLElement(doc, doc.head, "title", { text: title });
		appendHTMLElement(doc, doc.head, "style", { text: styles });
		return doc;
	}

	function openDialogWindow(name, features, args, onReady, parentWindow) {
		const owner = getMainWindow() || parentWindow;
		let win = null;
		if (owner && typeof owner.openDialog === "function") {
			win = owner.openDialog("about:blank", name, features, args);
		} else {
			const svc = getServices();
			if (svc && svc.ww && typeof svc.ww.openWindow === "function") {
				win = svc.ww.openWindow(null, "about:blank", name, features, args);
			}
		}
		if (!win) throw new Error("Zotero window service is unavailable");

		const ready = () => {
			try {
				onReady(win);
			} catch (e) {
				log("dialog render error", e);
				try {
					win.close();
				} catch (closeError) {
					/* ignore */
				}
			}
		};
		if (win.document && (win.document.readyState === "interactive" || win.document.readyState === "complete")) {
			setTimeout(ready, 0);
		} else {
			win.addEventListener("DOMContentLoaded", ready, { once: true });
		}
		return win;
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
		constructor(rootURI, services) {
			if (services) ServicesModule = services;
			this.rootURI = rootURI;
			this.api = HJFYCore.createApi((method, url, body) => this._request(method, url, body));
			this._onProgress = null;
			this._menuRegistrationID = null;
		}

		// ================= 生命周期 =================
		async init() {
			try {
				this._registerMenu();
			} catch (e) {
				log("menu init error", e);
			}
			try {
				await this._registerPrefsPane();
			} catch (e) {
				log("prefs init error", e);
			}
			log("init done");
		}

		onMainWindowLoad(win) {
			this._prepareMenuWindow(win);
		}

		onMainWindowUnload(win) {
			this._removeMenuFromWindow(win);
		}

		shutdown() {
			if (this._menuRegistrationID && Zotero.MenuManager) {
				try {
					Zotero.MenuManager.unregisterMenu(this._menuRegistrationID);
				} catch (e) {
					log("menu unregister error", e);
				}
			}
			this._menuRegistrationID = null;
			for (const win of Zotero.getMainWindows()) {
				this._removeMenuFromWindow(win);
			}
		}

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
			const services = getServices();
			if (!services || !services.cookies) return { ok: false, msg: "Zotero cookie 服务不可用" };
			const cm = services.cookies;
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
				const services = getServices();
				if (services && services.cookies) services.cookies.remove(SITE, "session", "/", {});
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
			const pakoLib =
				(typeof globalThis !== "undefined" && globalThis.pako) ||
				(typeof pako !== "undefined" ? pako : null);
			const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
			// 水印是 hjfy 翻译管线的标记块: q /CPDFSTAMP BMC ... ET EMC Q
			const RE_BLOCK = /q\s*\/CPDFSTAMP\s*BMC[\s\S]*?ET\s*EMC\s*Q\s*/;
			// 兜底: 无标记块时, 删除文本运算符里含 hjfy 域名的画字指令(不依赖位置)
			const RE_HJFY_TJ = /\([^()\\]*?hjfy[^()\\]*?\)\s*Tj/g;
			const RE_HJFY_ARRAY = /\[[^\]]*?hjfy[^\]]*?\]\s*TJ/g;
			let removed = false;
			const pageCount = doc.getPageCount();
			for (let p = 0; p < pageCount; p++) {
				const page = doc.getPage(p);
				let contents = null;
				try {
					contents = page.node.Contents();
				} catch (e) {
					continue;
				}
				if (contents === null || contents === undefined) continue;
				// /Contents 可能是数组或多流; 统一转成可遍历数组
				let streams = [];
				if (typeof contents.size === "function") {
					const n = contents.size();
					for (let i = 0; i < n; i++) {
						try {
							streams.push(contents.lookup(i));
						} catch (e) {
							/* ignore */
						}
					}
				} else if (typeof contents.getContents === "function") {
					streams.push(contents);
				}
				for (const s of streams) {
					if (!s || !s.contents) continue;
					const raw = new Uint8Array(s.contents);
					let txt = null;
					let compressed = false;
					if (pakoLib) {
						try {
							txt = new TextDecoder("latin1").decode(pakoLib.inflate(raw));
							compressed = true;
						} catch (e) {
							txt = null;
						}
					}
					if (txt === null) txt = new TextDecoder("latin1").decode(raw);
					let patched = txt.replace(RE_BLOCK, "");
					patched = patched.replace(RE_HJFY_TJ, "");
					patched = patched.replace(RE_HJFY_ARRAY, "");
					if (patched !== txt) {
						const enc = Uint8Array.from(patched, (c) => c.charCodeAt(0) & 0xff);
						s.contents = new Uint8Array(compressed && pakoLib ? pakoLib.deflate(enc) : enc);
						s.dict.set(lib.PDFName.of("Length"), lib.PDFNumber.of(s.contents.length));
						removed = true;
					}
				}
			}
			if (!removed) {
				// 最后手段: 第1页顶部覆盖白色条带(只对"第1页顶部水印"这一已知布局有效, 非保底保证)
				log("未检测到可删除的水印文本, 使用白色条带兜底(非保底保证)");
				const page = doc.getPage(0);
				const { width, height } = page.getSize();
				page.drawRectangle({ x: 0, y: height - 22, width, height: 22, color: lib.rgb(1, 1, 1) });
			}
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
				// 用户输入的 arXiv 链接写入条目「网址」字段(仅当该字段当前无效时)
				await this._ensureItemUrl(item, cid);
				return await this.runArxiv(item, cid);
			}
			return null;
		}

		/**
		 * 把有效的 arXiv ID 写入条目「网址」字段(已有有效链接则跳过)
		 */
		async _ensureItemUrl(item, arxivId) {
			try {
				const cur = item.getField("url") || "";
				if (HJFYCore.parseArxivId(cur)) return; // 已是有效 arXiv 链接, 不改
				item.setField("url", `https://arxiv.org/abs/${arxivId}`);
				await item.saveTx();
				log("已更新条目网址 ->", `https://arxiv.org/abs/${arxivId}`);
			} catch (e) {
				log("_ensureItemUrl error", e);
			}
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
			for (const win of Zotero.getMainWindows()) {
				this._prepareMenuWindow(win);
			}

			if (Zotero.MenuManager && typeof Zotero.MenuManager.registerMenu === "function") {
				this._menuRegistrationID = Zotero.MenuManager.registerMenu({
					menuID: MENU_ID,
					pluginID: PLUGIN_ID,
					target: "main/library/item",
					menus: [
						{
							menuType: "menuitem",
							l10nID: "hjfy-pdftranslate-menu-fetch-cn",
							onShowing: (_event, context) => {
								const hasItems = !!(context.items && context.items.length);
								context.setVisible(hasItems);
								context.setEnabled(hasItems);
							},
							onCommand: (_event, context) => {
								this.handleSelectedItems(context.items || []);
							},
						},
					],
				});
			}
			log("menu registered");
		}

		_prepareMenuWindow(win) {
			if (!win || !win.document) return;
			if (win.MozXULElement && !win.document.querySelector(`[href="${MENU_FTL}"]`)) {
				win.MozXULElement.insertFTLIfNeeded(MENU_FTL);
			}
			if (!Zotero.MenuManager || typeof Zotero.MenuManager.registerMenu !== "function") {
				this._addMenuToWindow(win);
			}
		}

		_addMenuToWindow(win) {
			const doc = win.document;
			const popup = doc.getElementById("zotero-itemmenu");
			if (!popup || doc.getElementById(MENU_ELEMENT_ID)) return;

			const menuitem = doc.createXULElement("menuitem");
			menuitem.id = MENU_ELEMENT_ID;
			menuitem.setAttribute("data-l10n-id", "hjfy-pdftranslate-menu-fetch-cn");
			menuitem.addEventListener("command", () => {
				const items = win.ZoteroPane ? win.ZoteroPane.getSelectedItems() : [];
				this.handleSelectedItems(items);
			});
			popup.appendChild(menuitem);

			const onPopupShowing = () => {
				const items = win.ZoteroPane ? win.ZoteroPane.getSelectedItems() : [];
				menuitem.hidden = !items.length;
				menuitem.disabled = !items.length;
			};
			popup.addEventListener("popupshowing", onPopupShowing);
			menuitem._hjfyPopup = popup;
			menuitem._hjfyPopupShowing = onPopupShowing;
		}

		_removeMenuFromWindow(win) {
			if (!win || !win.document) return;
			const menuitem = win.document.getElementById(MENU_ELEMENT_ID);
			if (menuitem) {
				if (menuitem._hjfyPopup && menuitem._hjfyPopupShowing) {
					menuitem._hjfyPopup.removeEventListener("popupshowing", menuitem._hjfyPopupShowing);
				}
				menuitem.remove();
			}
			win.document.querySelector(`[href="${MENU_FTL}"]`)?.remove();
		}

		// ================= 设置面板 =================
		async _registerPrefsPane() {
			await Zotero.PreferencePanes.register({
				id: "hjfy-pdftranslate-preferences",
				pluginID: PLUGIN_ID,
				src: this.rootURI + "content/preferences/preferences.xhtml",
				stylesheets: [this.rootURI + "content/preferences/preferences.css"],
				label: "HJFY 翻译",
				image: this.rootURI + "content/resources/logo-64.png",
			});
			log("prefs pane registered");
		}

		/**
		 * 由 preferences.xhtml 的内联脚本调用：装配 微信/手机号/粘贴 登录与退出
		 */
		async setupPrefs(win) {
			const doc = win.document;
			const root = doc.getElementById("hjfy-main");
			if (!root || root.dataset.hjfyInitialized === "true") return;
			root.dataset.hjfyInitialized = "true";
			const statusEl = doc.getElementById("hjfy-status");
			const sessionInput = doc.getElementById("hjfy-session-input");
			const logoutBtn = doc.getElementById("hjfy-logout");

			const render = async () => {
				const u = await this.checkLogin();
				const loggedIn = !!(u && u.login);
				if (loggedIn) {
					statusEl.textContent = "已登录 · " + (u.nickname || "HJFY 用户");
					statusEl.dataset.state = "success";
				} else {
					statusEl.textContent = u && u.error ? "连接失败" : "未登录";
					statusEl.dataset.state = u && u.error ? "error" : "idle";
				}
				if (logoutBtn && logoutBtn.parentElement) logoutBtn.parentElement.hidden = !loggedIn;
				sessionInput.value = this.getSessionPref() ? "session=" + this.getSessionPref() : "";
			};

			// --- ① 微信扫码 ---
			const wxBtn = doc.getElementById("hjfy-wechat-login");
			if (wxBtn) wxBtn.addEventListener("click", () => this.openWechatLogin(() => render(), win));

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
						? "验证码已发送"
						: r.needCaptcha
							? "请在网页完成人机验证"
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
			if (openBtn) openBtn.addEventListener("click", () => openExternalURL("https://hjfy.top/"));

			// --- 退出登录 ---
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
		_renderWechatDialog(win, onLoginSeen) {
			const doc = prepareDialogDocument(
				win,
				"微信扫码登录",
				`body {
					box-sizing: border-box;
					margin: 0;
					padding: 20px;
					font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
					color: CanvasText;
					background: Canvas;
				}
				h1 { margin: 0 0 6px; font-size: 18px; }
				p { margin: 0 0 14px; color: GrayText; }
				.qr-stage { display: grid; place-items: center; box-sizing: border-box; width: 100%; height: 320px; border: 1px solid rgba(127, 127, 127, .3); }
				.qr-stage img { display: block; width: 280px; height: 280px; object-fit: contain; }
				footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
				.status { color: GrayText; font-size: 12px; }
				button { min-height: 31px; padding: 4px 14px; font: inherit; }`
			);
			appendHTMLElement(doc, doc.body, "h1", { text: "微信扫码登录" });
			appendHTMLElement(doc, doc.body, "p", { text: "使用微信扫码并在手机上确认" });
			const stage = appendHTMLElement(doc, doc.body, "div", { className: "qr-stage" });
			const image = appendHTMLElement(doc, stage, "img", { attributes: { alt: "微信登录二维码" } });
			image.hidden = true;
			const footer = appendHTMLElement(doc, doc.body, "footer");
			const status = appendHTMLElement(doc, footer, "span", { className: "status", text: "二维码加载中..." });
			const closeButton = appendHTMLElement(doc, footer, "button", { text: "关闭", attributes: { type: "button" } });
			closeButton.addEventListener("click", () => win.close());
			this._runWechatLogin(win, image, status, onLoginSeen).catch((e) => {
				log("WeChat login flow error", e);
				if (!win.closed) status.textContent = "微信登录服务连接失败";
			});
			win.focus();
		}

		_parseWechatPoll(body) {
			if (typeof body !== "string") return null;
			const errorMatch = /(?:window\.)?wx_errcode\s*=\s*(-?\d+)/.exec(body);
			if (!errorMatch) return null;
			const codeMatch = /(?:window\.)?wx_code\s*=\s*(['"])([\s\S]*?)\1/.exec(body);
			return {
				code: Number.parseInt(errorMatch[1], 10),
				wxCode: codeMatch ? codeMatch[2].replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\(['"\\])/g, "$1") : "",
			};
		}

		async _runWechatLogin(win, image, status, onLoginSeen) {
			const redirect = encodeURIComponent("https://hjfy.top/api/login/callback/wechat?path=%2F");
			const pageURL =
				"https://open.weixin.qq.com/connect/qrconnect?appid=wxd7885e86e52192fe&scope=snsapi_login" +
				"&redirect_uri=" + redirect + "&state=HJFYZT&login_type=jssdk&self_redirect=false";
			const pageResponse = await Zotero.HTTP.request("GET", pageURL, {
				useCookieService: true,
				responseType: "text",
				timeout: 30000,
			});
			const page = pageResponse.responseText || pageResponse.response || "";
			const uuidMatch = /(?:uuid=|\/connect\/qrcode\/)([A-Za-z0-9_-]+)/.exec(page);
			if (!uuidMatch) throw new Error("WeChat response did not contain a QR code");
			const uuid = uuidMatch[1];

			image.addEventListener("load", () => {
				status.textContent = "请扫码并确认登录";
			});
			image.addEventListener("error", () => {
				status.textContent = "二维码加载失败";
			});
			image.src = "https://open.weixin.qq.com/connect/qrcode/" + encodeURIComponent(uuid);
			image.hidden = false;

			const deadline = Date.now() + 10 * 60 * 1000;
			let scanned = false;
			while (!win.closed && Date.now() < deadline) {
				const last = scanned ? "&last=404" : "";
				const pollResponse = await Zotero.HTTP.request(
					"GET",
					"https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=" +
						encodeURIComponent(uuid) + last + "&_=" + Date.now() + "000",
					{
						useCookieService: true,
						responseType: "text",
						timeout: 40000,
						headers: { Referer: "https://open.weixin.qq.com/" },
					}
				);
				const poll = this._parseWechatPoll(pollResponse.responseText || pollResponse.response || "");
				if (!poll) throw new Error("Unexpected WeChat poll response");
				if (poll.code === 404) {
					scanned = true;
					status.textContent = "已扫码，请在手机上确认";
				} else if (poll.code === 405 && poll.wxCode) {
					status.textContent = "正在完成登录...";
					await Zotero.HTTP.request(
						"GET",
						`${BASE}/api/login/callback/wechat?code=${encodeURIComponent(poll.wxCode)}&state=HJFYZT`,
						{ useCookieService: true, responseType: "text", timeout: 30000, successCodes: [200, 302] }
					);
					const session = this._readSessionCookie();
					if (!session) throw new Error("HJFY callback did not create a session");
					await onLoginSeen(session);
					return;
				} else if (poll.code === 403) {
					status.textContent = "已取消授权";
					return;
				} else if (poll.code === 402) {
					status.textContent = "二维码已失效，请重新打开";
					return;
				} else if (poll.code === 500) {
					status.textContent = "微信服务异常";
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			if (!win.closed) status.textContent = "二维码已过期，请重新打开";
		}

		/**
		 * 打开微信扫码登录窗口(非模态)。窗口内走完回调后 onSuccess 会带回 session。
		 * 兜底: 若二维码窗口被顶层跳转导航走, 本函数会轮询本地 cookie 直到登录完成或超时。
		 */
		openWechatLogin(onChanged, parentWindow) {
			let done = false;
			let dialogWindow = null;
			const onLoginSeen = async (sessionValue) => {
				if (done) return;
				done = true;
				try {
					if (dialogWindow && !dialogWindow.closed) dialogWindow.close();
				} catch (e) {
					/* ignore */
				}
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
				services: getServices(),
				onSuccess: (sessionValue) => {
					clearInterval(timer);
					onLoginSeen(sessionValue);
				},
			};
			try {
				dialogWindow = openDialogWindow(
					"hjfy-wechat-login",
					"centerscreen,resizable=yes,width=480,height=560",
					args,
					(win) => this._renderWechatDialog(win, onLoginSeen),
					parentWindow
				);
				dialogWindow.addEventListener("unload", () => clearInterval(timer), { once: true });
			} catch (e) {
				clearInterval(timer);
				log("openWechatLogin error", e);
				this.notify("打开微信登录窗口失败: " + e, "fail");
			}
		}

		_readSessionCookie() {
			const services = getServices();
			if (!services || !services.cookies) throw new Error("Zotero cookie service is unavailable");
			const cm = services.cookies.getCookiesFromHost(SITE, {});
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
					openExternalURL("https://hjfy.top/");
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
		_renderArxivDialog(win, args) {
			const doc = prepareDialogDocument(
				win,
				"获取翻译 PDF",
				`body {
					box-sizing: border-box;
					margin: 0;
					padding: 22px;
					font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
					color: CanvasText;
					background: Canvas;
				}
				h1 { margin: 0 0 6px; font-size: 18px; }
				p { margin: 0 0 18px; color: GrayText; }
				label { display: block; margin-bottom: 7px; font-weight: 600; }
				input { box-sizing: border-box; width: 100%; height: 34px; padding: 5px 8px; font: inherit; }
				footer { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 18px; }
				button { min-height: 31px; padding: 4px 13px; font: inherit; }`
			);
			appendHTMLElement(doc, doc.body, "h1", { text: "获取翻译 PDF" });
			appendHTMLElement(doc, doc.body, "p", { text: args.itemTitle || "当前条目没有 arXiv 链接" });
			const inputID = "hjfy-arxiv-input";
			appendHTMLElement(doc, doc.body, "label", { text: "arXiv 链接或 ID", attributes: { for: inputID } });
			const input = appendHTMLElement(doc, doc.body, "input", {
				attributes: { id: inputID, type: "text", placeholder: "2506.17310" },
			});
			const footer = appendHTMLElement(doc, doc.body, "footer");
			const fetchButton = appendHTMLElement(doc, footer, "button", { text: "获取翻译", attributes: { type: "button" } });
			const uploadButton = appendHTMLElement(doc, footer, "button", { text: "上传 PDF", attributes: { type: "button" } });
			const cancelButton = appendHTMLElement(doc, footer, "button", { text: "取消", attributes: { type: "button" } });
			const finish = (choice) => {
				args.done(choice);
				win.close();
			};
			fetchButton.addEventListener("click", () => finish({ mode: "arxiv", text: input.value.trim() }));
			uploadButton.addEventListener("click", () => finish({ mode: "upload" }));
			cancelButton.addEventListener("click", () => finish({ mode: "cancel" }));
			input.addEventListener("keydown", (event) => {
				if (event.key === "Enter") finish({ mode: "arxiv", text: input.value.trim() });
				if (event.key === "Escape") finish({ mode: "cancel" });
			});
			input.focus();
			win.focus();
		}

		openArxivDialog(item) {
			return new Promise((resolve) => {
				let settled = false;
				const done = (choice) => {
					if (settled) return;
					settled = true;
					resolve(choice || { mode: "cancel" });
				};
				const args = {
					itemTitle: "",
					done,
				};
				try {
					args.itemTitle = item.getField("title") || "";
				} catch (e) {
					/* ignore */
				}
				try {
					const dialogWindow = openDialogWindow(
						"hjfy-pdftranslate-input",
						"centerscreen,resizable=yes,width=560,height=330",
						args,
						(win) => this._renderArxivDialog(win, args)
					);
					dialogWindow.addEventListener("unload", () => done({ mode: "cancel" }), { once: true });
				} catch (e) {
					log("openArxivDialog error", e);
					done({ mode: "cancel" });
				}
			});
		}
	}

	Zotero.HJFYPlugin = HJFYPlugin;
	Zotero.HJFY = null;
})();
