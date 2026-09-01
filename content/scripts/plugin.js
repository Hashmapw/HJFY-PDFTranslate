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
	const ARXIV_INFO_RETRY_INTERVALS = Object.freeze([2500, 5000, 10000]);
	const ARXIV_INFO_RETRY_MAX_MS = 20000;
	const ARXIV_INFO_TIMEOUT_MS = 10000;
	const PLUGIN_ID = "hjfy-pdftranslate@hjfy.top";
	const MENU_ID = "hjfy-pdftranslate-fetch-cn";
	const MENU_ELEMENT_ID = "hjfy-pdftranslate-fetchcn";
	const MENU_FTL = "hjfy-pdftranslate.ftl";
	const LOGIN = HJFYLoginConfig;

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

	function getCookieInterface() {
		try {
			if (typeof Ci !== "undefined" && Ci.nsICookie) return Ci.nsICookie;
		} catch (e) {
			/* Ci is unavailable */
		}
		try {
			if (typeof Components !== "undefined" && Components.interfaces) {
				return Components.interfaces.nsICookie || null;
			}
		} catch (e) {
			/* Components is unavailable */
		}
		return null;
	}

	function getCookiesForHost(cookieManager, host) {
		const result = cookieManager.getCookiesFromHost(host, {});
		if (!result) return [];
		try {
			if (typeof result[Symbol.iterator] === "function") return Array.from(result);
		} catch (e) {
			/* old XPCOM enumerator */
		}
		const cookies = [];
		if (typeof result.hasMoreElements === "function") {
			while (result.hasMoreElements()) cookies.push(result.getNext());
			return cookies;
		}
		if (typeof result.length === "number") {
			for (let index = 0; index < result.length; index++) cookies.push(result[index]);
		}
		return cookies;
	}

	function normalizeCookie(cookie) {
		const cookieInterface = getCookieInterface();
		if (cookieInterface && cookie && typeof cookie.QueryInterface === "function") {
			return cookie.QueryInterface(cookieInterface);
		}
		return cookie;
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

	function openBrowserDialogWindow(rootURI, name, features, onReady, parentWindow) {
		const owner = getMainWindow() || parentWindow;
		const url = "chrome://hjfy-pdftranslate/content/dialogs/loginBrowser.xhtml";
		return openChromeDialogWindow(owner, url, name, features, null, onReady);
	}

	function openChromeDialogWindow(owner, url, name, features, args, onReady) {
		let win = null;
		if (owner && typeof owner.openDialog === "function") {
			win = owner.openDialog(url, name, "chrome," + features, args);
		} else {
			const svc = getServices();
			if (svc && svc.ww && typeof svc.ww.openWindow === "function") {
				win = svc.ww.openWindow(null, url, name, "chrome," + features, args);
			}
		}
		if (!win) throw new Error("Zotero window service is unavailable");
		let initialized = false;
		let attempts = 0;
		let timer = null;
		const closeWithError = (error) => {
			if (initialized) return;
			initialized = true;
			if (timer) clearTimeout(timer);
			log("chrome dialog render error", error);
			try {
				win.close();
			} catch (closeError) {
				/* ignore */
			}
		};
		const ready = () => {
			if (initialized || win.closed) return;
			const doc = win.document;
			let documentURI = "";
			try {
				documentURI = doc && (doc.documentURI || doc.URL || (win.location && win.location.href)) || "";
			} catch (e) {
				/* the target chrome document is still replacing the placeholder */
			}
			if (!doc || doc.readyState === "loading" || documentURI !== url) {
				if (++attempts <= 200) {
					timer = setTimeout(ready, 25);
					return;
				}
				closeWithError(new Error("chrome dialog timed out while loading " + url));
				return;
			}
			try {
				onReady(win);
				initialized = true;
				if (timer) clearTimeout(timer);
			} catch (e) {
				if (++attempts <= 200 && /controls are unavailable/i.test(String(e && e.message || e))) {
					timer = setTimeout(ready, 25);
					return;
				}
				closeWithError(e);
			}
		};
		win.addEventListener("DOMContentLoaded", ready, { once: true });
		win.addEventListener("load", ready, { once: true });
		timer = setTimeout(ready, 0);
		return win;
	}

	let IOUtilsModule = null;
	function getIOUtils() {
		if (!IOUtilsModule) {
			try {
				if (typeof globalThis !== "undefined" && globalThis.IOUtils) {
					IOUtilsModule = globalThis.IOUtils;
				}
			} catch (e) {
				IOUtilsModule = null;
			}
			if (!IOUtilsModule) {
				try {
					IOUtilsModule = ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs").IOUtils;
				} catch (e) {
					IOUtilsModule = null;
				}
			}
		}
		if (!IOUtilsModule) throw new Error("Zotero IOUtils API is unavailable");
		return IOUtilsModule;
	}

	function log(...args) {
		Zotero.debug(
			"HJFY-PDFTranslate: " +
				args.map((x) => (typeof x === "string" ? x : x && x.message ? x.message : JSON.stringify(x))).join(" ")
		);
	}

	function getResponseBodyText(candidate) {
		if (!candidate) return "";
		try {
			const responseType = candidate.responseType;
			if (!responseType || responseType === "text") {
				const responseText = candidate.responseText;
				if (typeof responseText === "string") return responseText;
			}
		} catch (e) {
			/* Some XMLHttpRequest getters throw for non-text response types. */
		}
		try {
			const response = candidate.response;
			if (typeof response === "string") return response;
			const tag = Object.prototype.toString.call(response);
			if (tag === "[object Object]" || tag === "[object Array]") return JSON.stringify(response);
		} catch (e) {
			/* Error reporting must never replace the original request failure. */
		}
		return "";
	}

	function bytesToBinaryString(bytes) {
		const chunkSize = 0x4000;
		let output = "";
		for (let offset = 0; offset < bytes.length; offset += chunkSize) {
			output += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
		}
		return output;
	}

	function binaryStringToBytes(value) {
		const output = new Uint8Array(value.length);
		for (let index = 0; index < value.length; index++) {
			output[index] = value.charCodeAt(index) & 0xff;
		}
		return output;
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
			this._purgeLegacySessionPref();
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
		_purgeLegacySessionPref() {
			try {
				// Versions before 0.1.8 duplicated the session token in prefs.js.
				// Authentication now lives only in the cookie service.
				Zotero.Prefs.set(PREFS + "session", "", true);
			} catch (e) {
				/* preference service unavailable during shutdown */
			}
		}

		async checkLogin() {
			try {
				const u = await this.api.userinfo();
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
			this._removeSessionCookie();
			const expiry = Math.floor(Date.now() / 1000) + 90 * 24 * 3600;
			const cookieInterface = getCookieInterface();
			const sameSite = cookieInterface && cookieInterface.SAMESITE_STRICT !== undefined
				? cookieInterface.SAMESITE_STRICT
				: cookieInterface && cookieInterface.SAMESITE_LAX !== undefined
					? cookieInterface.SAMESITE_LAX
				: 2;
			const schemeHTTPS = cookieInterface && cookieInterface.SCHEME_HTTPS !== undefined
				? cookieInterface.SCHEME_HTTPS
				: 2;
			const baseArgs = [SITE, "/", "session", value, true, true, false, expiry, {}];
			let cookieError = null;
			for (const extraArgs of [[sameSite, schemeHTTPS], [sameSite], []]) {
				try {
					cm.add(...baseArgs, ...extraArgs);
					cookieError = null;
					break;
				} catch (e) {
					cookieError = e;
				}
			}
			if (cookieError) {
				log("saveSession cookie set error", cookieError);
				return { ok: false, msg: "写入 cookie 失败: " + cookieError };
			}
			const u = await this.checkLogin();
			if (u && u.login) {
				return { ok: true, user: u };
			}
			return { ok: false, msg: "会话已保存，但 hjfy.top 验证未通过(可能过期)" };
		}

		_removeSessionCookie() {
			try {
				const services = getServices();
				if (!services || !services.cookies) return;
				const cm = services.cookies;
				for (let cookie of getCookiesForHost(cm, SITE)) {
					cookie = normalizeCookie(cookie);
					if (cookie.name === "session") {
						cm.remove(cookie.host || SITE, cookie.name, cookie.path || "/", cookie.originAttributes || {});
					}
				}
			} catch (e) {
				log("clear session cookie error", e);
			}
		}

		async clearSession() {
			this._removeSessionCookie();
			this._purgeLegacySessionPref();
		}

		// ================= HTTP (Zotero.HTTP, 带 cookie) =================
		async _request(method, url, body) {
			const options = {
				useCookieService: true,
				timeout: 60000,
				responseType: "json",
				successCodes: [200, 201, 204, 302],
			};
			if (method === "GET" && String(url).startsWith(`${BASE}/api/arxivInfo/`)) {
				options.timeout = ARXIV_INFO_TIMEOUT_MS;
				options.errorDelayIntervals = Array.from(ARXIV_INFO_RETRY_INTERVALS);
				options.errorDelayMax = ARXIV_INFO_RETRY_MAX_MS;
			}
			if (body) {
				if (body.headers) options.headers = body.headers;
				if (body.payload !== undefined) options.body = body.payload;
				if (Number.isFinite(body.timeout)) options.timeout = body.timeout;
			}
			try {
				const resp = await Zotero.HTTP.request(method, url, options);
				const value = resp && typeof resp.response !== "undefined" ? resp.response : resp;
				if (value === "" || value === null || value === undefined) return {};
				if (typeof value === "string") {
					try {
						return JSON.parse(value);
					} catch (e) {
						throw this._makeRequestError(method, url, resp, "响应不是有效 JSON");
					}
				}
				return value;
			} catch (error) {
				if (error && error.name === "HJFYRequestError") throw error;
				throw this._makeRequestError(method, url, error, error && error.message ? error.message : "请求失败");
			}
		}

		_makeRequestError(method, url, source, detail) {
			const xhr = source && (source.xmlhttp || source.xhr || source.response);
			const status = Number(source && source.status) || Number(xhr && xhr.status) || 0;
			let contentType = (source && source.contentType) || "unknown";
			if (contentType === "unknown" && xhr && typeof xhr.getResponseHeader === "function") {
				try {
					contentType = xhr.getResponseHeader("Content-Type") || contentType;
				} catch (e) {
					/* Header access is best-effort while reporting a failed request. */
				}
			}
			const raw = getResponseBodyText(source) || (xhr !== source ? getResponseBodyText(xhr) : "");
			const excerpt = raw.replace(/\s+/g, " ").slice(0, 240);
			const error = new Error(
				`${method} ${url} 失败${status ? ` (HTTP ${status})` : ""}: ${detail}` +
					` | Content-Type: ${contentType}${excerpt ? ` | 响应: ${excerpt}` : ""}`
			);
			error.name = "HJFYRequestError";
			error.status = status;
			error.contentType = contentType;
			error.responseExcerpt = excerpt;
			log("HTTP error", error.message);
			return error;
		}

		async downloadToFile(url, destPath) {
			log("download -> " + destPath);
			let resp;
			try {
				resp = await Zotero.HTTP.request("GET", url, {
					useCookieService: true,
					timeout: 180000,
					responseType: "arraybuffer",
					onProgress: (loaded, total) => {
						if (total > 0 && this._onProgress) this._onProgress(loaded, total);
					},
				});
			} catch (error) {
				throw this._makeRequestError("GET", url, error, error && error.message ? error.message : "下载失败");
			}
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
				} else {
					this.notify("纯净 PDF 处理不可用，已保留原始译文", "fail");
				}
			} catch (e) {
				log("cleanPdf error", e);
				this.notify("纯净 PDF 处理失败，已保留原始译文", "fail");
			}
			return destPath;
		}

		async _cleanPdfBytes(bytes) {
			const lib = Zotero.HJFYVendor && Zotero.HJFYVendor.PDFLib;
			if (!lib) {
				log("PDFLib 未加载(纯净PDF 将跳过)");
				return null;
			}
			const pakoLib = Zotero.HJFYVendor && Zotero.HJFYVendor.pako;
			let doc;
			try {
				doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
			} catch (error) {
				const message = error && error.message ? error.message : String(error);
				const isCrossRealmTypeError =
					/`pdf` must be of type[\s\S]*`Uint8Array`[\s\S]*`ArrayBuffer`/.test(message) &&
					bytes != null &&
					typeof bytes.length === "number";
				if (!isCrossRealmTypeError) throw error;
				// IOUtils and the bundled pdf-lib can live in different JS globals in Zotero 9.
				// Copy into this plugin global so pdf-lib's realm-sensitive instanceof check succeeds.
				const normalized = Uint8Array.from(bytes);
				log("纯净PDF: 已兼容跨域 Uint8Array");
				doc = await lib.PDFDocument.load(normalized, { updateMetadata: false });
			}
			// Current translated PDFs mark the URL block as CPDFSTAMP.
			const RE_BLOCK = /q\s*\/CPDFSTAMP\s+BMC[\s\S]*?EMC\s*Q\s*/g;
			// 兜底: 无标记块时, 删除文本运算符里含 hjfy 域名的画字指令(不依赖位置)
			const RE_HJFY_TJ = /\([^()\\]*?hjfy[^()\\]*?\)\s*Tj/g;
			const RE_HJFY_ARRAY = /\[[^\]]*?hjfy[^\]]*?\]\s*TJ/g;
			let removedBlocks = 0;
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
							txt = bytesToBinaryString(pakoLib.inflate(raw));
							compressed = true;
						} catch (e) {
							txt = null;
						}
					}
					if (txt === null) txt = bytesToBinaryString(raw);
					let patched = txt.replace(RE_BLOCK, () => {
						removedBlocks++;
						return "";
					});
					patched = patched.replace(RE_HJFY_TJ, "");
					patched = patched.replace(RE_HJFY_ARRAY, "");
					if (patched !== txt) {
						const enc = binaryStringToBytes(patched);
						s.contents = new Uint8Array(compressed && pakoLib ? pakoLib.deflate(enc) : enc);
						s.dict.set(lib.PDFName.of("Length"), lib.PDFNumber.of(s.contents.length));
					}
				}
				const annotations = page.node.Annots();
				if (annotations && typeof annotations.size === "function") {
					for (let index = annotations.size() - 1; index >= 0; index--) {
						try {
							const annotation = annotations.lookup(index);
							const action = annotation && annotation.lookup(lib.PDFName.of("A"));
							const uri = action && action.lookup(lib.PDFName.of("URI"));
							const text = uri && typeof uri.decodeText === "function" ? uri.decodeText() : "";
							if (/^https?:\/\/(?:www\.)?hjfy\.top\//i.test(text)) annotations.remove(index);
						} catch (e) {
							/* malformed annotation; preserve it */
						}
					}
				}
			}
			// Public pdf-lib drawing APIs are reliably serialized in Zotero. Keep this
			// visual guard even when the internal stream replacement above succeeded.
			const firstPage = doc.getPage(0);
			const { width, height } = firstPage.getSize();
			firstPage.drawRectangle({ x: 0, y: height - 22, width, height: 22, color: lib.rgb(1, 1, 1), opacity: 1 });
			doc.setProducer("HJFY-PDFTranslate");
			log("纯净PDF: CPDFSTAMP blocks removed", removedBlocks);
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
			const existing = await this._findExistingPdfCN(item);
			// importFromFile manages its own transaction in Zotero 9/10. Wrapping it
			// in executeTransaction deadlocks while the nested transaction waits.
			const attachment = await Zotero.Attachments.importFromFile({
				file: filePath,
				parentItemID: item.id,
			});
			attachment.setField("title", title);
			await attachment.saveTx();
			for (const oldAttachment of existing) {
				await oldAttachment.eraseTx();
			}
			return true;
		}

		async getItemPdfPath(item) {
			const attachmentIDs = item.getAttachments() || [];
			if (!attachmentIDs.length) {
				throw new Error("该条目没有附件，请先把原始 PDF 添加到条目后再上传");
			}
			let attachmentCount = 0;
			let pdfCount = 0;
			for (const id of attachmentIDs) {
				const child = Zotero.Items.get(id);
				if (!child || !child.isAttachment()) continue;
				attachmentCount++;
				const fileName = child.getField("filename") || child.attachmentFilename || "";
				let filePath = null;
				try {
					filePath = await child.getFilePathAsync();
				} catch (e) {
					log("读取附件路径失败", id, e);
				}
				let isPdf = child.attachmentContentType === "application/pdf" || /\.pdf$/i.test(fileName);
				if (!isPdf && typeof child.isPDFAttachment === "function") {
					try {
						isPdf = !!child.isPDFAttachment();
					} catch (e) {
						/* fall through to the file extension check */
					}
				}
				if (!isPdf && filePath) isPdf = /\.pdf$/i.test(filePath);
				if (!isPdf) continue;
				pdfCount++;
				if (filePath) return { path: filePath, fileName: fileName || filePath.split(/[\\/]/).pop() || "paper.pdf" };
			}
			log("未找到可上传 PDF", { attachmentCount, pdfCount });
			if (!attachmentCount) throw new Error("该条目没有可上传的文件附件");
			if (!pdfCount) throw new Error("该条目没有 PDF 附件，请先添加原始 PDF");
			throw new Error("PDF 附件没有本地文件，请先下载或同步该附件");
		}

		_joinPath(basePath, fileName) {
			const base = basePath && typeof basePath.path === "string" ? basePath.path : String(basePath);
			try {
				if (typeof PathUtils !== "undefined" && PathUtils && typeof PathUtils.join === "function") {
					return PathUtils.join(base, fileName);
				}
			} catch (e) {
				/* PathUtils is unavailable in older Zotero versions */
			}
			const separator = base.includes("\\") ? "\\" : "/";
			return base.replace(/[\\/]+$/, "") + separator + String(fileName).replace(/^[\\/]+/, "");
		}

		async _downloadArxivFile(arxivId, files, destination, pitem) {
			try {
				return { path: await this.downloadToFile(files.zhCN, destination), url: files.zhCN, files };
			} catch (error) {
				if (!error || error.status !== 403) throw error;
				pitem.setText("下载地址已过期，正在刷新...");
				log("arxiv download URL expired; refreshing arxivFiles", arxivId);
				const refreshed = await this.api.arxivFiles(arxivId);
				if (!refreshed || refreshed.status !== 0 || !refreshed.data || !refreshed.data.zhCN) {
					throw new Error("翻译文件地址刷新失败: " + HJFYCore.responseExcerpt(refreshed));
				}
				return {
					path: await this.downloadToFile(refreshed.data.zhCN, destination),
					url: refreshed.data.zhCN,
					files: refreshed.data,
				};
			}
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
				// The item context menu only contains Zotero.Item objects. Zotero.Item
				// has no isCollection() method, so validate the item by the API used below.
				if (!item || typeof item.getField !== "function") continue;
				try {
					await this.handleItem(item);
				} catch (e) {
					log("handleItem error", e);
					this.notify("获取翻译 PDF 出错: " + (e && e.message ? e.message : e), "fail");
				}
			}
		}

		async handleItem(item) {
			const id = this._getItemArxivId(item);
			if (id) {
				log("item arXiv association found", { itemID: item.id, arxivId: id });
				return await this.runArxiv(item, id);
			}
			log("item has no arXiv association; opening action dialog", { itemID: item.id });
			const choice = await this.openArxivDialog(item);
			log("item action dialog result", { itemID: item.id, mode: choice && choice.mode });
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
				await this._rememberItemArxiv(item, cid);
				return await this.runArxiv(item, cid);
			}
			return null;
		}

		_getItemArxivId(item) {
			try {
				const fromUrl = HJFYCore.parseArxivId(item.getField("url") || "");
				if (fromUrl) return fromUrl;
				const extra = item.getField("extra") || "";
				for (const line of String(extra).split(/\r?\n/)) {
					const match = /^\s*arxiv(?:\s+id)?\s*:\s*(.*?)\s*$/i.exec(line);
					const fromExtra = match && HJFYCore.parseArxivId(match[1]);
					if (fromExtra) return fromExtra;
				}
			} catch (e) {
				log("读取条目 arXiv ID 失败", e);
			}
			return null;
		}

		/** Store the association without replacing the publisher URL. */
		async _rememberItemArxiv(item, arxivId) {
			const normalized = HJFYCore.parseArxivId(arxivId);
			if (!normalized) throw new Error("无效的 arXiv ID: " + arxivId);
			try {
				const extra = String(item.getField("extra") || "");
				const lines = extra ? extra.split(/\r?\n/) : [];
				const index = lines.findIndex((line) => /^\s*arxiv(?:\s+id)?\s*:/i.test(line));
				const association = `arXiv: ${normalized}`;
				if (index >= 0) {
					if (lines[index] === association) return false;
					lines[index] = association;
				} else {
					lines.push(association);
				}
				item.setField("extra", lines.join("\n"));
				await item.saveTx();
			} catch (e) {
				log("_rememberItemArxiv error", e);
				this.notify("未能把 arXiv ID 写入条目“其他”，仍继续获取翻译: " + (e && e.message ? e.message : e), "fail");
				return false;
			}
			log("已更新条目其他字段 -> arXiv:", normalized);
			return true;
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
					onInfoError: (error) => {
						const detail = error && error.message ? error.message : HJFYCore.responseExcerpt(error);
						log("arxivInfo unavailable; falling back to task status", {
							arxivId,
							status: Number(error && error.status) || 0,
							detail,
						});
						pitem.setText(`${arxivId} 信息接口异常，正在直接查询翻译任务...`);
					},
					onStatus: (status, data) => {
						pitem.setText(`${arxivId}: ${status}${data.info ? " | " + data.info : ""}`);
					},
				});

				if (result.stage === "need_login") {
					this._endProgress(pw);
					this.notify(`「${arxivId}」的翻译还没开始，需要登录后才能创建任务。请在 设置→HJFY-PDFTranslate 完成登录`, "fail");
					return null;
				}
				if (result.stage === "not_started") {
					this._endProgress(pw);
					this.notify(`「${arxivId}」尚未创建翻译任务；账号已登录，请稍后重试或在 hjfy.top 发起翻译`, "fail");
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
				if (["info_error", "api_error", "http_error", "timeout"].includes(result.stage)) {
					this._endProgress(pw);
					this.notify("查询失败: " + (result.msg || result.stage), "fail");
					return null;
				}

				let files = result.files || {};
				if (!files.zhCN) {
					this._endProgress(pw);
					this.notify("未获得翻译文件地址", "fail");
					return null;
				}
				const fileName = `hjfy-${(result.plainId || arxivId).replace(/[^\w.\-]/g, "_")}-zh-CN.pdf`;
				const download = await this._downloadArxivFile(
					result.plainId || arxivId,
					files,
					this._joinPath(Zotero.getTempDirectory(), fileName),
					pitem
				);
				const saved = download.path;
				files = download.files;
				// 纯净PDF: 去除译文第1页顶部的水印链接(视觉效果)
				await this._maybeCleanPdf(saved, download.url);
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
			const { pitem, pw } = this._newProgress("正在检查登录状态...");
			this._onProgress = (loaded, total) => pitem.setProgress(Math.round((loaded / total) * 100), 100);
			try {
				const user = await this.checkLogin();
				if (!user.login) {
					this._endProgress(pw);
					this.notify(
						user.error
							? "无法确认登录状态: " + user.error
							: "上传翻译需要登录，请先在 设置→HJFY-PDFTranslate 里登录",
						"fail"
					);
					return null;
				}
				pitem.setText("正在查找条目 PDF...");
				const pdf = optPdfPath
					? { path: optPdfPath, fileName: optPdfPath.split(/[\\/]/).pop() }
					: await this.getItemPdfPath(item);
				pitem.setText("上传 PDF...");
				const upResp = await this.uploadFile(pdf);
				// 服务端用业务状态 302 表示上传件已识别为 arXiv 论文。
				if (upResp && upResp.arxivId) {
					const detectedID = HJFYCore.parseArxivId(upResp.arxivId);
					if (!detectedID) throw new Error("上传返回了无效的 arXiv ID: " + upResp.arxivId);
					await this._rememberItemArxiv(item, detectedID);
					this._endProgress(pw);
					this.notify("检测到 arXiv 论文，改用 arXiv 翻译流程: " + detectedID);
					return await this.runArxiv(item, detectedID);
				}
				if (!upResp || upResp.status !== 0) {
					this._endProgress(pw);
					const msg =
						upResp && upResp.status === 500
							? "上传需要登录，请先在 设置→HJFY-PDFTranslate 里登录"
							: (upResp && upResp.msg) || "上传失败";
					this.notify(msg, "fail");
					return null;
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
					this._joinPath(Zotero.getTempDirectory(), `hjfy-upload-${Date.now()}${ext}`)
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
			if (!fileBytes || fileBytes.length < 5) throw new Error("PDF 文件为空或无法读取");
			if (fileBytes.length > 10 * 1024 * 1024) throw new Error("PDF 文件超过网站允许的 10 MB 上限");
			const signature = String.fromCharCode(
				fileBytes[0], fileBytes[1], fileBytes[2], fileBytes[3], fileBytes[4]
			);
			if (signature !== "%PDF-") throw new Error("所选附件不是有效的 PDF 文件");
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

			log("upload start", { fileName: safeName, bytes: fileBytes.length });
			const response = await this.api.uploadFiles({
				headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
				payload: body.buffer,
				timeout: 120000,
			});
			log("upload response", {
				status: response && response.status,
				message: response && response.msg,
				hasFileKey: !!(response && (response.fileKey || (response.data && response.data.fileKey))),
				arxivId: response && response.arxivId,
			});
			return response;
		}

		// ================= UI: 进度与通知 =================
		_newProgress(text) {
			const pw = new Zotero.ProgressWindow();
			pw.changeHeadline("幻觉翻译");
			const pitem = new pw.ItemProgress("chrome://zotero/skin/treeitem-load.png", text || "处理中...");
			pw.show();
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
				pw.changeHeadline("幻觉翻译");
				const icon = type === "success"
					? "chrome://zotero/skin/tick.png"
					: type === "fail"
						? "chrome://zotero/skin/cross.png"
						: "chrome://zotero/skin/treeitem-load.png";
				new pw.ItemProgress(icon, String(msg || ""));
				pw.show();
				if (!sticky) pw.startCloseTimer(5000);
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
				label: "HJFY翻译插件",
				image: this.rootURI + "content/resources/logo-32-padded.png",
			});
			log("prefs pane registered");
		}

			/**
			 * 由 preferences.xhtml 调用：装配微信、手机号登录与退出。
			 */
			async setupPrefs(win) {
				const doc = win.document;
				const root = doc.getElementById("hjfy-main");
				if (!root || root.getAttribute("data-hjfy-initialized") === "true") return;
				root.setAttribute("data-hjfy-initialized", "true");
				const statusEl = doc.getElementById("hjfy-status");
				const logoutBtn = doc.getElementById("hjfy-logout");
				if (!statusEl) return;

			const render = async () => {
				const u = await this.checkLogin();
				const loggedIn = !!(u && u.login);
				if (loggedIn) {
					statusEl.textContent = "已登录 · " + (u.nickname || "HJFY 用户");
					statusEl.setAttribute("data-state", "success");
				} else {
					statusEl.textContent = u && u.error ? "连接失败" : "未登录";
					statusEl.setAttribute("data-state", u && u.error ? "error" : "idle");
				}
					if (logoutBtn) logoutBtn.disabled = !loggedIn;
				};

				const wxBtn = doc.getElementById("hjfy-wechat-login");
				if (wxBtn) wxBtn.addEventListener("click", () => this.openWechatLogin(() => render(), win));
				const phoneBtn = doc.getElementById("hjfy-phone-login");
				if (phoneBtn) phoneBtn.addEventListener("click", () => this.openPhoneLogin(() => render(), win));

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

			openPhoneLogin(onChanged, parentWindow) {
				// The embedded site and API requests share Zotero's cookie service.
				// Clear the previous account before navigating to the login page.
				this._removeSessionCookie();
				this._purgeLegacySessionPref();
				try {
					const owner = getMainWindow() || parentWindow;
					return openBrowserDialogWindow(
						this.rootURI,
						"hjfy-phone-login",
						"centerscreen,resizable=yes,width=900,height=700",
						(win) => this._renderPhoneWebsiteLogin(win, onChanged),
						owner
					);
				} catch (e) {
					log("openPhoneLogin error", e);
					this.notify("打开手机号登录窗口失败: " + e, "fail");
					return null;
				}
			}

			_renderPhoneWebsiteLogin(win, onLoginSeen) {
				const doc = win.document;
				const browser = doc.getElementById("hjfy-login-browser");
				const status = doc.getElementById("hjfy-login-status");
				const closeButton = doc.getElementById("hjfy-login-close");
				if (!browser || !status || !closeButton) throw new Error("Login browser controls are unavailable");
				doc.title = "手机号登录";
				closeButton.addEventListener("click", () => win.close());

				let completed = false;
				let checking = false;
				const verifyLogin = async () => {
					if (completed || checking || win.closed) return;
					checking = true;
					try {
						const user = await this.checkLogin();
						if (!user || !user.login || completed || win.closed) return;
						completed = true;
						status.textContent = "登录成功";
						this.notify("手机号登录成功: " + (user.nickname || ""), "success");
						if (onLoginSeen) await onLoginSeen();
						if (!win.closed) win.close();
					} finally {
						checking = false;
					}
				};
				const onLoad = () => {
					if (!completed) status.textContent = "请在页面右上角完成手机号登录";
					return verifyLogin();
				};
				browser.addEventListener("load", onLoad, true);
				const timer = setInterval(verifyLogin, 1000);
				win.addEventListener("unload", () => {
					clearInterval(timer);
					browser.removeEventListener("load", onLoad, true);
				}, { once: true });
				status.textContent = "请在页面右上角完成手机号登录";
				browser.setAttribute("src", `${BASE}/?hjfy-login=${Date.now()}`);
				win.focus();
			}

			// ================= 登录: 微信扫码 =================
		_renderWechatDialog(win, onLoginSeen) {
			const doc = win.document;
			const image = doc.getElementById("hjfy-wechat-qr");
			const status = doc.getElementById("hjfy-wechat-status");
			const closeButton = doc.getElementById("hjfy-wechat-close");
			if (!image || !status || !closeButton) throw new Error("WeChat login controls are unavailable");
			closeButton.addEventListener("click", () => win.close());
			this._runWechatLogin(win, image, status, onLoginSeen).catch((e) => {
				log("WeChat login flow error", e);
				if (!win.closed) status.textContent = "微信登录失败，请关闭后重试";
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
			const redirect = encodeURIComponent(BASE + LOGIN.CALLBACK_PATH);
			const pageURL =
				`https://open.weixin.qq.com/connect/qrconnect?appid=${LOGIN.APP_ID}&scope=snsapi_login` +
				"&redirect_uri=" + redirect + `&state=${encodeURIComponent(LOGIN.STATE)}&login_type=jssdk&self_redirect=false`;
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
				let pollResponse;
				try {
					pollResponse = await Zotero.HTTP.request(
						"GET",
						LOGIN.POLL_BASE + "/connect/l/qrconnect?uuid=" +
							encodeURIComponent(uuid) + last + "&_=" + Date.now() + "000",
						{
							useCookieService: true,
							responseType: "text",
							timeout: 40000,
							headers: { Referer: "https://open.weixin.qq.com/" },
						}
					);
				} catch (e) {
					log("WeChat poll retry", e);
					status.textContent = scanned ? "已扫码，正在等待登录确认..." : "微信连接波动，正在重试...";
					await new Promise((resolve) => setTimeout(resolve, 1500));
					continue;
				}
				const poll = this._parseWechatPoll(pollResponse.responseText || pollResponse.response || "");
				if (!poll) throw new Error("Unexpected WeChat poll response");
				if (poll.code === 404) {
					scanned = true;
					status.textContent = "已扫码，请在手机上确认";
				} else if (poll.code === 405 && poll.wxCode) {
					status.textContent = "正在完成登录...";
					await Zotero.HTTP.request(
						"GET",
						`${BASE}${LOGIN.CALLBACK_PATH}&code=${encodeURIComponent(poll.wxCode)}&state=${encodeURIComponent(LOGIN.STATE)}`,
						{
							useCookieService: true,
							responseType: "text",
							timeout: 30000,
							successCodes: [200, 302, 303, 307, 308],
						}
					);
					const session = this._readSessionCookie();
					if (!session) throw new Error("HJFY callback did not create a session");
					const user = await this._request("GET", `${BASE}/api/userinfo`);
					if (!user || !user.login) throw new Error("HJFY callback session was not accepted");
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
			 * 打开微信扫码登录窗口(非模态)。官网完成 OAuth 回调并写入 cookie，
			 * 本函数轮询 Zotero cookie service，验证成功后保存 session。
			 */
		openWechatLogin(onChanged, parentWindow) {
			this.clearSession();
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
			const started = Date.now();
			const timer = setInterval(async () => {
				try {
					const s = this._readSessionCookie();
					if (s) {
						clearInterval(timer);
						onLoginSeen(s);
					} else if (Date.now() - started > 11 * 60 * 1000) {
						clearInterval(timer);
					}
				} catch (e) {
					clearInterval(timer);
				}
			}, 2000);
				try {
					const owner = getMainWindow() || parentWindow;
					dialogWindow = openChromeDialogWindow(
						owner,
						"chrome://hjfy-pdftranslate/content/dialogs/wechatLogin.xhtml",
						"hjfy-wechat-login",
						"centerscreen,resizable=no,width=420,height=430",
						null,
						(win) => this._renderWechatDialog(win, onLoginSeen)
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
			for (let c of getCookiesForHost(services.cookies, SITE)) {
				c = normalizeCookie(c);
				if (c.name === "session") return c.value;
			}
			return null;
		}

		// ================= 登录: 手机号 =================
		async _sendPhoneCode(phone, captchaVerifyParam) {
			try {
				const j = await this.api.sendCode(phone, captchaVerifyParam);
				if (j && j.status === 0) return { ok: true };
				return { ok: false, msg: (j && j.msg) || "发送失败" };
			} catch (e) {
				log("sendPhoneCode error", e);
				return { ok: false, msg: String(e) };
			}
		}

		_renderSiteLoginBrowser(win, mode, phone, onPhoneSent) {
			const doc = win.document;
			const browser = doc.getElementById("hjfy-login-browser");
			const status = doc.getElementById("hjfy-login-status");
			const closeButton = doc.getElementById("hjfy-login-close");
			if (!browser || !status || !closeButton) throw new Error("Login browser controls are unavailable");
			doc.title = mode === "wechat" ? "微信扫码登录" : "人机验证";
			closeButton.addEventListener("click", () => win.close());

			const initialManager = browser.messageManager;
			if (!initialManager || typeof initialManager.loadFrameScript !== "function") {
				throw new Error("Zotero content message manager is unavailable");
			}
			const frameSource = `
				if (!this.__hjfySiteLoginInstalled) {
					this.__hjfySiteLoginInstalled = true;
					(() => {
					const config = ${JSON.stringify({ mode, phone })};
					const report = (kind, text) => sendAsyncMessage("hjfy:login-state", { kind, text });
					const waitFor = async (lookup, timeout = 30000) => {
						const deadline = Date.now() + timeout;
						while (Date.now() < deadline) {
							const value = lookup();
							if (value) return value;
							await new Promise((resolve) => content.setTimeout(resolve, 100));
						}
						return null;
					};
					let preparing = false;
					let preparedDocument = null;
					const prepare = async () => {
						const siteDoc = content.document;
						if (
							preparing ||
							preparedDocument === siteDoc ||
							!siteDoc ||
							!/^https:\\/\\/hjfy\\.top\\//.test(siteDoc.location.href)
						) return;
						preparing = true;
						try {
							report("status", "正在准备登录...");
								const loginButton = await waitFor(() =>
									Array.from(siteDoc.querySelectorAll("button")).find((button) => button.textContent.trim() === "登录")
								);
								if (!loginButton) throw new Error("网站登录页面结构已更新: login-button");
								loginButton.click();
								const sendButton = await waitFor(() => siteDoc.getElementById("send-code"));
								if (!sendButton) throw new Error("网站登录页面结构已更新: send-code");
								const phoneSection = sendButton.parentElement && sendButton.parentElement.parentElement;
								const panel = phoneSection && phoneSection.parentElement;
								if (!panel) throw new Error("网站登录页面结构已更新: login-panel");
							panel.setAttribute("data-hjfy-login-panel", config.mode);
							const isolateStyle = siteDoc.createElement("style");
							isolateStyle.textContent = [
								"body > * { visibility: hidden !important; }",
								"[data-hjfy-login-panel], [data-hjfy-login-panel] * { visibility: visible !important; }",
								"[data-hjfy-login-panel] { top: 16px !important; right: auto !important; left: 50% !important; transform: translateX(-50%) !important; border-radius: 8px !important; }",
								"#aliyunCaptcha-mask, #aliyunCaptcha-mask *, #aliyunCaptcha-window-popup, #aliyunCaptcha-window-popup * { visibility: visible !important; }",
							].join("\\n");
							siteDoc.head.appendChild(isolateStyle);
							const wechatSection = siteDoc.getElementById("wx_qrcode")?.parentElement;
							const divider = phoneSection.previousElementSibling;
							if (config.mode === "wechat") {
								phoneSection.style.display = "none";
								if (divider) divider.style.display = "none";
								report("status", "请使用微信扫码并在手机上确认");
							} else {
								if (wechatSection) wechatSection.style.display = "none";
								if (divider) divider.style.display = "none";
									const phoneInput = siteDoc.getElementById("contactNumber");
									if (!phoneInput) throw new Error("网站登录页面结构已更新: contactNumber");
									const valueSetter = Object.getOwnPropertyDescriptor(content.HTMLInputElement.prototype, "value").set;
									valueSetter.call(phoneInput, config.phone);
									phoneInput.dispatchEvent(new content.Event("input", { bubbles: true }));
									report("status", "请点击发送验证码并完成人机验证");
									const reportIfSent = () => {
										if (/已发送/.test(sendButton.textContent || "")) {
											report("sent", "验证码已发送");
											return true;
										}
										return false;
									};
									if (!reportIfSent()) {
										const observer = new content.MutationObserver(() => {
											if (reportIfSent()) observer.disconnect();
										});
										observer.observe(sendButton, { childList: true, subtree: true, characterData: true });
										content.setTimeout(() => observer.disconnect(), 10 * 60 * 1000);
									}
								}
							preparedDocument = siteDoc;
						} catch (error) {
							report("error", String(error));
						} finally {
							preparing = false;
						}
					};
					addEventListener("DOMContentLoaded", prepare, true);
					addEventListener("pageshow", prepare, true);
					prepare();
					})();
				}
			`;
			const frameURL = "data:application/javascript;charset=utf-8," + encodeURIComponent(frameSource);
			let completed = false;
			const attachedManagers = [];
			const onState = (message) => {
				const data = message && message.data ? message.data : {};
				if (data.kind === "status") {
					status.textContent = data.text || "";
				}
				else if (data.kind === "sent" && !completed) {
					completed = true;
					status.textContent = data.text || "验证码已发送";
					if (onPhoneSent) onPhoneSent({ ok: true });
					setTimeout(() => {
						if (!win.closed) win.close();
					}, 500);
				} else if (data.kind === "error") {
					log("site login browser error", data.text || "unknown frame error");
					status.textContent = /网站登录页面结构已更新/.test(data.text || "")
						? "网站登录页面已更新，请关闭窗口并更新插件"
						: "登录组件加载失败，请关闭后重试";
				}
			};
			const injectFrameScript = () => {
				if (win.closed) return;
				const manager = browser.messageManager;
				if (!manager || typeof manager.loadFrameScript !== "function") return;
				if (!attachedManagers.includes(manager)) {
					manager.addMessageListener("hjfy:login-state", onState);
					attachedManagers.push(manager);
				}
				manager.loadFrameScript(frameURL, false);
			};
			injectFrameScript();
			browser.addEventListener("load", injectFrameScript, true);
			win.addEventListener("unload", () => {
				browser.removeEventListener("load", injectFrameScript, true);
				try {
					for (const manager of attachedManagers) {
						manager.removeMessageListener("hjfy:login-state", onState);
					}
				} catch (e) {
					/* browser process already closed */
				}
			}, { once: true });
			browser.setAttribute("src", `${BASE}/`);
			win.focus();
		}

		openPhoneCaptcha(phone, parentWindow) {
			return new Promise((resolve) => {
				let settled = false;
				const finish = (result) => {
					if (settled) return;
					settled = true;
					resolve(result);
				};
				try {
					const dialogWindow = openBrowserDialogWindow(
							this.rootURI,
							"hjfy-phone-captcha",
							"centerscreen,resizable=yes,width=430,height=440",
						(win) => this._renderSiteLoginBrowser(win, "phone", phone, finish),
						parentWindow
					);
					dialogWindow.addEventListener("unload", () => finish({ ok: false, cancelled: true }), { once: true });
				} catch (e) {
					log("openPhoneCaptcha error", e);
					finish({ ok: false, msg: "打开人机验证窗口失败: " + e });
				}
			});
		}

		async trySendCode(phone, parentWindow) {
			return await this.openPhoneCaptcha(phone, parentWindow);
		}

		/** 手机号 + 验证码登录 -> session -> 保存并验证 */
		async phoneLogin(phone, code) {
			try {
				const j = await this.api.phoneLogin(phone, code);
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
				await this.api.logout();
			} catch (e) {
				log("logout api error", e);
			}
			await this.clearSession();
		}

		// ================= 输入弹窗（无 arXiv 链接时） =================
		_renderArxivDialog(win, args) {
			const doc = win.document;
			const description = doc.getElementById("hjfy-arxiv-description");
			const input = doc.getElementById("hjfy-arxiv-input");
			const fetchButton = doc.getElementById("hjfy-arxiv-fetch");
			const uploadButton = doc.getElementById("hjfy-arxiv-upload");
			const cancelButton = doc.getElementById("hjfy-arxiv-cancel");
			if (!description || !input || !fetchButton || !uploadButton || !cancelButton) {
				throw new Error("arXiv dialog controls are unavailable");
			}
			log("arXiv action dialog ready");
			description.textContent = args.itemTitle || "当前条目没有 arXiv 链接";
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
				let dialogReady = false;
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
					const dialogURL = "chrome://hjfy-pdftranslate/content/dialogs/arxivDialog.xhtml";
					const dialogWindow = openChromeDialogWindow(
						getMainWindow(),
						dialogURL,
						"hjfy-pdftranslate-input",
						"centerscreen,resizable=yes,width=560,height=330",
						args,
						(win) => {
							this._renderArxivDialog(win, args);
							dialogReady = true;
						}
					);
					dialogWindow.addEventListener("unload", () => {
						if (!dialogReady) {
							setTimeout(() => {
								if (dialogWindow.closed && !settled) {
									this.notify("获取翻译窗口加载失败，未执行任何操作", "fail");
									done({ mode: "cancel" });
								}
							}, 0);
							return;
						}
						if (settled) return;
						this.notify("获取翻译窗口已关闭，未执行任何操作", "fail");
						done({ mode: "cancel" });
					});
				} catch (e) {
					log("openArxivDialog error", e);
					this.notify("无法打开获取翻译窗口: " + (e && e.message ? e.message : e), "fail");
					done({ mode: "cancel" });
				}
			});
		}
	}

	Zotero.HJFYPlugin = HJFYPlugin;
	Zotero.HJFY = null;
})();
