"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const HJFYLoginConfig = require("../content/scripts/login_config");
const HJFYCore = require("../content/scripts/core");

function loadPlugin(overrides = {}) {
	const registrations = [];
	const unregistrations = [];
	const Zotero = {
		debug() {},
		getMainWindows: () => [],
		MenuManager: {
			registerMenu(options) {
				registrations.push(options);
				return options.menuID;
			},
			unregisterMenu(id) {
				unregistrations.push(id);
			},
		},
		...overrides,
	};
	const context = {
		Zotero,
		HJFYCore: { ...HJFYCore, createApi: () => ({ userinfo: async () => ({ login: false }) }) },
		HJFYLoginConfig,
		ChromeUtils: {},
		IOUtils: overrides.IOUtils,
		clearTimeout,
		setTimeout,
		TextDecoder: overrides.TextDecoder || TextDecoder,
		TextEncoder,
		console,
	};
	const source = fs.readFileSync(path.join(__dirname, "../content/scripts/plugin.js"), "utf8");
	vm.runInNewContext(source, context);
	return { Plugin: Zotero.HJFYPlugin, registrations, unregistrations };
}

test("registers the translated PDF action for the item context menu", () => {
	const { Plugin, registrations } = loadPlugin();
	const plugin = new Plugin("file:///addon/");
	plugin._registerMenu();

	assert.equal(registrations.length, 1);
	assert.equal(registrations[0].pluginID, "hjfy-pdftranslate@hjfy.top");
	assert.equal(registrations[0].target, "main/library/item");
	assert.equal(registrations[0].menus[0].l10nID, "hjfy-pdftranslate-menu-fetch-cn");
});

test("shows the action for selected items and passes them to the workflow", () => {
	const { Plugin, registrations } = loadPlugin();
	const plugin = new Plugin("file:///addon/");
	plugin._registerMenu();
	const action = registrations[0].menus[0];
	const states = {};
	const items = [{ id: 42 }];
	plugin.handleSelectedItems = (selectedItems) => {
		states.selectedItems = selectedItems;
	};

	action.onShowing({}, {
		items,
		setVisible: (value) => (states.visible = value),
		setEnabled: (value) => (states.enabled = value),
	});
	action.onCommand({}, { items });

	assert.equal(states.visible, true);
	assert.equal(states.enabled, true);
	assert.equal(states.selectedItems, items);
});

test("handles a regular Zotero item without calling a nonexistent isCollection method", async () => {
	const { Plugin } = loadPlugin();
	const plugin = new Plugin("file:///addon/");
	const item = {
		id: 42,
		isAttachment: () => false,
		isNote: () => false,
		getField: () => "https://arxiv.org/abs/2602.09021",
	};
	const handled = [];
	plugin.handleItem = async (selectedItem) => handled.push(selectedItem);

	await plugin.handleSelectedItems([item]);

	assert.deepEqual(handled, [item]);
});

test("creates progress items with new and keeps active work visible", () => {
	const events = [];
	function ItemProgress(icon, text) {
		assert.ok(new.target, "ItemProgress must be called with new");
		events.push({ kind: "item", icon, text });
		this.setText = () => {};
		this.setProgress = () => {};
	}
	class ProgressWindow {
		constructor() {
			this.ItemProgress = ItemProgress;
		}
		changeHeadline(text) {
			events.push({ kind: "headline", text });
		}
		show() {
			events.push({ kind: "show" });
		}
		startCloseTimer(ms) {
			events.push({ kind: "timer", ms });
		}
	}
	const { Plugin } = loadPlugin({ ProgressWindow });
	const plugin = new Plugin("file:///addon/");

	plugin.notify("获取成功", "success");
	const active = plugin._newProgress("2602.09021 查询中...");

	assert.ok(active.pitem);
	assert.equal(events.filter((event) => event.kind === "timer").length, 1);
	assert.deepEqual(events.find((event) => event.kind === "timer"), { kind: "timer", ms: 5000 });
	assert.ok(events.some((event) => event.kind === "item" && event.text === "获取成功"));
	assert.ok(events.some((event) => event.kind === "item" && event.text === "2602.09021 查询中..."));
});

test("joins download paths without the removed Zotero.File.pathJoin API", () => {
	const { Plugin } = loadPlugin();
	const plugin = new Plugin("file:///addon/");

	assert.equal(plugin._joinPath("/tmp/zotero", "translated.pdf"), "/tmp/zotero/translated.pdf");
	assert.equal(plugin._joinPath({ path: "/tmp/zotero" }, "translated.pdf"), "/tmp/zotero/translated.pdf");
	assert.equal(plugin._joinPath("C:\\Temp\\", "translated.pdf"), "C:\\Temp\\translated.pdf");
});

test("writes downloads with Zotero 9 and 10 global IOUtils", async () => {
	const writes = [];
	const IOUtils = {
		async write(path, bytes, options) {
			writes.push({ path, bytes: Array.from(bytes), options });
		},
	};
	const HTTP = {
		async request() {
			return { response: Uint8Array.from([37, 80, 68, 70]).buffer };
		},
	};
	const { Plugin } = loadPlugin({ HTTP, IOUtils });
	const plugin = new Plugin("file:///addon/");

	const result = await plugin.downloadToFile("https://example.test/file.pdf", "/tmp/file.pdf");

	assert.equal(result, "/tmp/file.pdf");
	assert.equal(writes.length, 1);
	assert.equal(writes[0].path, "/tmp/file.pdf");
	assert.deepEqual(writes[0].bytes, [37, 80, 68, 70]);
	assert.equal(writes[0].options.tmpPath, "/tmp/file.pdf.tmp");
});

test("limits arxivInfo to three retries without changing other API requests", async () => {
	const requests = [];
	const HTTP = {
		async request(method, url, options) {
			requests.push({ method, url, options });
			return { response: { status: 0, data: {} } };
		},
	};
	const { Plugin } = loadPlugin({ HTTP });
	const plugin = new Plugin("file:///addon/");

	await plugin._request("GET", "https://hjfy.top/api/arxivInfo/2405.14867");
	await plugin._request("GET", "https://hjfy.top/api/arxivStatus/2405.14867");

	assert.equal(requests[0].options.timeout, 10000);
	const retryIntervals = Array.from(requests[0].options.errorDelayIntervals);
	assert.deepEqual(retryIntervals, [2500, 5000, 10000]);
	assert.equal(requests[0].options.errorDelayMax, 20000);
	const worstCaseMs = requests[0].options.timeout * (retryIntervals.length + 1)
		+ retryIntervals.reduce((total, delay) => total + delay, 0);
	assert.equal(worstCaseMs, 57500);
	assert.ok(worstCaseMs < 60000);
	assert.equal(requests[1].options.timeout, 60000);
	assert.equal(requests[1].options.errorDelayIntervals, undefined);
	assert.equal(requests[1].options.errorDelayMax, undefined);
});

test("falls back from a JSON XHR error without reading responseText", async () => {
	let responseTextReads = 0;
	const jsonXHR = {
		status: 500,
		responseType: "json",
		response: { status: 500, msg: "upstream socket closed" },
		get responseText() {
			responseTextReads++;
			throw new Error('responseText is only available if responseType is "" or "text"');
		},
		getResponseHeader(name) {
			return name === "Content-Type" ? "application/json;charset=utf-8" : null;
		},
	};
	const HTTP = {
		async request(_method, url) {
			if (url.includes("/api/arxivInfo/")) {
				const error = new Error("HTTP 500");
				error.status = 500;
				error.xmlhttp = jsonXHR;
				throw error;
			}
			if (url.includes("/api/arxivStatus/")) {
				return { response: { status: 0, data: { status: "finished" } } };
			}
			if (url.includes("/api/arxivFiles/")) {
				return { response: { status: 0, data: { zhCN: "https://example.com/translated.pdf" } } };
			}
			throw new Error("unexpected URL: " + url);
		},
	};
	const { Plugin } = loadPlugin({ HTTP });
	const plugin = new Plugin("file:///addon/");
	const api = HJFYCore.createApi((method, url, body) => plugin._request(method, url, body));

	const result = await HJFYCore.flowArxiv(api, "2405.14867", {});

	assert.equal(responseTextReads, 0);
	assert.equal(result.stage, "finished");
	assert.equal(result.infoFallback, true);
	assert.equal(result.files.zhCN, "https://example.com/translated.pdf");
});

test("imports PDF-CN without nesting Zotero attachment transactions", async () => {
	const events = [];
	const attachment = {
		setField(field, value) {
			events.push(["setField", field, value]);
		},
		async saveTx() {
			events.push(["saveTx"]);
		},
	};
	const Attachments = {
		async importFromFile(options) {
			events.push(["import", options]);
			return attachment;
		},
	};
	const DB = {
		async executeTransaction() {
			throw new Error("importFromFile must not be wrapped in executeTransaction");
		},
	};
	const { Plugin } = loadPlugin({ Attachments, DB, Items: { get: () => null } });
	const plugin = new Plugin("file:///addon/");
	const item = { id: 42, getAttachments: () => [] };

	await plugin.addPdfCNAttachment(item, "/tmp/translated.pdf");

	assert.equal(events[0][0], "import");
	assert.equal(events[0][1].file, "/tmp/translated.pdf");
	assert.equal(events[0][1].parentItemID, 42);
	assert.deepEqual(events.slice(1), [["setField", "title", "PDF-CN"], ["saveTx"]]);
});

test("unregisters the menu during shutdown", () => {
	const { Plugin, unregistrations } = loadPlugin();
	const plugin = new Plugin("file:///addon/");
	plugin._registerMenu();
	plugin.shutdown();

	assert.deepEqual(unregistrations, ["hjfy-pdftranslate-fetch-cn"]);
});

test("bootstrap starts with the Services global provided by Zotero 8", async () => {
	const loadedScripts = [];
	const Zotero = { debug() {}, HJFY: null };
	class Plugin {
		constructor(rootURI, services) {
			this.rootURI = rootURI;
			this.services = services;
		}

		init() {
			this.initialized = true;
		}
	}
	const context = {
		Zotero,
		Components: {
			classes: {
				"@mozilla.org/addons/addon-manager-startup;1": {
					getService() {
						return { registerChrome: () => ({ destruct() {} }) };
					},
				},
			},
			interfaces: { amIAddonManagerStartup: {} },
		},
		Services: {
			io: { newURI: (url) => url },
			scriptloader: {
				loadSubScript(url) {
					loadedScripts.push(url);
					if (url.endsWith("pdf-lib.min.js")) context.PDFLib = {};
					if (url.endsWith("pako.min.js")) context.pako = {};
					if (url.endsWith("content/scripts/plugin.js")) Zotero.HJFYPlugin = Plugin;
				},
			},
		},
		ChromeUtils: {
			import() {
				throw new Error("Services.jsm is unavailable in Zotero 8");
			},
		},
	};
	const source = fs.readFileSync(path.join(__dirname, "../bootstrap.js"), "utf8");
	vm.runInNewContext(source, context);
	await context.startup({ id: "hjfy-pdftranslate@hjfy.top", version: "0.1.0", rootURI: "file:///addon/" });

	assert.equal(loadedScripts.length, 5);
	assert.ok(loadedScripts.some((url) => url.endsWith("content/scripts/login_config.js")));
	assert.equal(Zotero.HJFY.initialized, true);
	assert.equal(Zotero.HJFY.services, context.Services);
	assert.ok(Zotero.HJFYVendor.PDFLib);
	assert.ok(Zotero.HJFYVendor.pako);
	assert.equal(context.PDFLib, undefined);
	assert.equal(context.pako, undefined);
});

test("waits for the target chrome document instead of binding to the complete placeholder", async () => {
	const controls = {};
	for (const id of [
		"hjfy-arxiv-description",
		"hjfy-arxiv-input",
		"hjfy-arxiv-fetch",
		"hjfy-arxiv-upload",
		"hjfy-arxiv-cancel",
	]) {
		controls[id] = {
			value: "",
			textContent: "",
			listeners: {},
			addEventListener(name, listener) {
				this.listeners[name] = listener;
			},
			focus() {},
		};
	}
	const windowListeners = {};
	const dialogWindow = {
		closed: false,
		document: {
			readyState: "complete",
			documentURI: "about:blank",
			getElementById: (id) => controls[id] || null,
		},
		addEventListener(name, listener) {
			windowListeners[name] = listener;
		},
		focus() {},
		close() {
			this.closed = true;
		},
	};
	const opened = [];
	const mainWindow = {
		openDialog(...args) {
			opened.push(args);
			return dialogWindow;
		},
	};
	const { Plugin } = loadPlugin({ getMainWindow: () => mainWindow });
	const plugin = new Plugin("file:///addon/");
	const resultPromise = plugin.openArxivDialog({ getField: () => "IEEE paper" });

	assert.equal(opened[0][0], "chrome://hjfy-pdftranslate/content/dialogs/arxivDialog.xhtml");
	assert.match(opened[0][2], /^chrome,/);
	assert.notEqual(opened[0][0], "about:blank");
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(controls["hjfy-arxiv-fetch"].listeners.click, undefined);
	windowListeners.unload();
	await new Promise((resolve) => setTimeout(resolve, 5));
	dialogWindow.document.documentURI = opened[0][0];
	await new Promise((resolve) => setTimeout(resolve, 35));
	assert.equal(controls["hjfy-arxiv-description"].textContent, "IEEE paper");
	controls["hjfy-arxiv-input"].value = "2303.12501";
	controls["hjfy-arxiv-fetch"].listeners.click();

	const result = await resultPromise;
	assert.equal(result.mode, "arxiv");
	assert.equal(result.text, "2303.12501");
	assert.equal(dialogWindow.closed, true);
});

test("notifies when the non-arXiv action dialog cannot be opened", async () => {
	const mainWindow = {
		openDialog() {
			throw new Error("window service failed");
		},
	};
	const { Plugin } = loadPlugin({ getMainWindow: () => mainWindow });
	const plugin = new Plugin("file:///addon/");
	const notifications = [];
	plugin.notify = (message, type) => notifications.push([message, type]);

	const result = await plugin.openArxivDialog({ getField: () => "IEEE paper" });

	assert.equal(result.mode, "cancel");
	assert.ok(notifications.some(([message, type]) => /无法打开.*window service failed/.test(message) && type === "fail"));
});

test("ships fixed controls for the non-arXiv action dialog", () => {
	const source = fs.readFileSync(path.join(__dirname, "../content/dialogs/arxivDialog.xhtml"), "utf8");
	for (const id of ["hjfy-arxiv-input", "hjfy-arxiv-fetch", "hjfy-arxiv-upload", "hjfy-arxiv-cancel"]) {
		assert.match(source, new RegExp(`id="${id}"`));
	}
});

for (const enteredValue of ["2303.12501", "https://arxiv.org/abs/2303.12501"]) {
	test(`stores an arXiv association without replacing the item URL for ${enteredValue}`, async () => {
		const { Plugin } = loadPlugin();
		const plugin = new Plugin("file:///addon/");
		const fields = {
			url: "https://ieeexplore.ieee.org/document/10204874/",
			extra: "DOI: 10.1109/example",
			title: "IEEE paper",
		};
		let saves = 0;
		const item = {
			getField: (field) => fields[field] || "",
			setField(field, value) {
				fields[field] = value;
			},
			async saveTx() {
				saves++;
			},
		};
		plugin.openArxivDialog = async () => ({ mode: "arxiv", text: enteredValue });
		const arxivCalls = [];
		plugin.runArxiv = async (selectedItem, id) => arxivCalls.push([selectedItem, id]);

		await plugin.handleItem(item);

		assert.equal(fields.url, "https://ieeexplore.ieee.org/document/10204874/");
		assert.equal(fields.extra, "DOI: 10.1109/example\narXiv: 2303.12501");
		assert.equal(saves, 1);
		assert.deepEqual(arxivCalls, [[item, "2303.12501"]]);
	});
}

test("reads a persisted arXiv association from Extra", async () => {
	const { Plugin } = loadPlugin();
	const plugin = new Plugin("file:///addon/");
	const item = {
		getField(field) {
			return field === "url" ? "https://publisher.example/paper" : field === "extra" ? "PMID: 42\narXiv: 2602.09021v3" : "";
		},
	};
	const calls = [];
	plugin.runArxiv = async (_item, id) => calls.push(id);

	await plugin.handleItem(item);

	assert.deepEqual(calls, ["2602.09021v3"]);
});

test("continues translation when the arXiv association cannot be saved", async () => {
	const { Plugin } = loadPlugin();
	const plugin = new Plugin("file:///addon/");
	const item = {
		getField: (field) => (field === "url" ? "https://ieeexplore.ieee.org/document/10204874/" : ""),
		setField() {},
		async saveTx() {
			throw new Error("database is read-only");
		},
	};
	plugin.openArxivDialog = async () => ({ mode: "arxiv", text: "2303.12501" });
	const calls = [];
	const notifications = [];
	plugin.runArxiv = async (_item, id) => calls.push(id);
	plugin.notify = (message, type) => notifications.push([message, type]);

	await plugin.handleItem(item);

	assert.deepEqual(calls, ["2303.12501"]);
	assert.ok(notifications.some(([message, type]) => /仍继续获取翻译.*database is read-only/.test(message) && type === "fail"));
});

test("upload selection immediately opens progress and reports a missing PDF", async () => {
	const events = [];
	function ItemProgress(_icon, value) {
		this.setText = (text) => events.push(["text", text]);
		this.setProgress = () => {};
		events.push(["item", value]);
	}
	class ProgressWindow {
		constructor() {
			this.ItemProgress = ItemProgress;
		}
		changeHeadline() {}
		show() {
			events.push(["show"]);
		}
		close() {
			events.push(["close"]);
		}
	}
	const { Plugin } = loadPlugin({ ProgressWindow, Items: { get: () => null } });
	const plugin = new Plugin("file:///addon/");
	plugin.checkLogin = async () => ({ login: true });
	plugin.notify = (message, type) => events.push(["notify", message, type]);

	const result = await plugin.runUpload({ getAttachments: () => [] }, null);

	assert.equal(result, null);
	assert.deepEqual(events[0], ["item", "正在检查登录状态..."]);
	assert.ok(events.some((event) => event[0] === "show"));
	assert.ok(events.some((event) => event[0] === "notify" && /没有附件/.test(event[1]) && event[2] === "fail"));
});

test("handles an arXiv-detected upload before treating business status 302 as failure", async () => {
	const { Plugin } = loadPlugin();
	const plugin = new Plugin("file:///addon/");
	plugin._newProgress = () => ({
		pitem: { setText() {}, setProgress() {} },
		pw: { close() {} },
	});
	plugin.checkLogin = async () => ({ login: true });
	plugin.getItemPdfPath = async () => ({ path: "/tmp/paper.pdf", fileName: "paper.pdf" });
	plugin.uploadFile = async () => ({ status: 302, arxivId: "2303.12501" });
	const savedIDs = [];
	plugin._rememberItemArxiv = async (_item, id) => savedIDs.push(id);
	const arxivCalls = [];
	plugin.runArxiv = async (_item, id) => arxivCalls.push(id);
	plugin.notify = () => {};

	await plugin.runUpload({}, null);

	assert.deepEqual(savedIDs, ["2303.12501"]);
	assert.deepEqual(arxivCalls, ["2303.12501"]);
});

test("builds the upload multipart body with validated PDF bytes", async () => {
	const input = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 1, 2, 3]);
	let request = null;
	const { Plugin } = loadPlugin({ IOUtils: { read: async () => input } });
	const plugin = new Plugin("file:///addon/");
	plugin.api.uploadFiles = async (body) => {
		request = body;
		return { status: 0, data: { fileKey: "file-key" } };
	};

	const response = await plugin.uploadFile({ path: "/tmp/paper.pdf", fileName: "paper.pdf" });

	assert.equal(response.data.fileKey, "file-key");
	assert.match(request.headers["Content-Type"], /^multipart\/form-data; boundary=/);
	assert.equal(request.timeout, 120000);
	const body = Buffer.from(request.payload);
	assert.ok(body.includes(Buffer.from('name="file"; filename="paper.pdf"')));
	assert.ok(body.includes(Buffer.from('name="fileName"')));
	assert.ok(body.includes(Buffer.from(input)));
});

test("rejects invalid or oversized upload attachments before the API call", async () => {
	let calls = 0;
	const invalid = loadPlugin({ IOUtils: { read: async () => Uint8Array.from([1, 2, 3, 4, 5]) } });
	const invalidPlugin = new invalid.Plugin("file:///addon/");
	invalidPlugin.api.uploadFiles = async () => calls++;
	await assert.rejects(invalidPlugin.uploadFile({ path: "/tmp/not-pdf.pdf" }), /不是有效的 PDF/);

	const oversized = loadPlugin({
		IOUtils: {
			read: async () => ({ length: 10 * 1024 * 1024 + 1, 0: 37, 1: 80, 2: 68, 3: 70, 4: 45 }),
		},
	});
	const oversizedPlugin = new oversized.Plugin("file:///addon/");
	oversizedPlugin.api.uploadFiles = async () => calls++;
	await assert.rejects(oversizedPlugin.uploadFile({ path: "/tmp/large.pdf" }), /超过网站允许的 10 MB/);
	assert.equal(calls, 0);
});

test("does not ship the obsolete command-based overlay menu", () => {
	const chromeManifest = fs.readFileSync(path.join(__dirname, "../chrome.manifest"), "utf8");
	assert.doesNotMatch(chromeManifest, /^overlay\s/m);
	assert.equal(fs.existsSync(path.join(__dirname, "../content/itemTreeMenuPopup.xhtml")), false);
});

test("refreshes an expired signed arXiv URL once", async () => {
	const { Plugin } = loadPlugin();
	const plugin = new Plugin("file:///addon/");
	const calls = [];
	plugin.downloadToFile = async (url) => {
		calls.push(url);
		if (calls.length === 1) {
			const error = new Error("expired");
			error.status = 403;
			throw error;
		}
		return "/tmp/translated.pdf";
	};
	plugin.api.arxivFiles = async () => ({ status: 0, data: { zhCN: "https://oss/new.pdf" } });
	const progress = { setText() {} };
	const result = await plugin._downloadArxivFile(
		"2602.09021",
		{ zhCN: "https://oss/expired.pdf" },
		"/tmp/translated.pdf",
		progress
	);

	assert.deepEqual(calls, ["https://oss/expired.pdf", "https://oss/new.pdf"]);
	assert.equal(result.url, "https://oss/new.pdf");
});

test("uses the concise Chinese item-menu label", () => {
	const locale = fs.readFileSync(path.join(__dirname, "../locale/zh-CN/hjfy-pdftranslate.ftl"), "utf8");
	assert.match(locale, /\.label = 获取幻觉翻译PDF/);
	assert.doesNotMatch(locale, /\(HJFY-PDFTranslate\)/);
});

test("removes the marked HJFY URL and replaces URL producer metadata", async () => {
	const PDFLib = require("../content/scripts/vendor/pdf-lib.min.js");
	const pako = require("../content/scripts/vendor/pako.min.js");
	const source = await PDFLib.PDFDocument.create();
	const page = source.addPage([612, 792]);
	const stamp = source.context.flateStream(
		"q/CPDFSTAMP BMC 1 0 0 1 15 777 cm BT /F0 10 Tf(https://hjfy.top/arxiv/2602.09021)Tj ET EMC Q"
	);
	page.node.addContentStream(source.context.register(stamp));
	source.setProducer("https://hjfy.top/");
	const input = await source.save({ useObjectStreams: false });
	const { Plugin } = loadPlugin({ HJFYVendor: { PDFLib, pako } });
	const output = await new Plugin("file:///addon/")._cleanPdfBytes(input);
	const cleaned = await PDFLib.PDFDocument.load(Buffer.from(output), { updateMetadata: false });

	assert.equal(cleaned.getProducer(), "HJFY-PDFTranslate");
	const streams = cleaned.getPage(0).node.Contents();
	let decoded = "";
	for (let index = 0; index < streams.size(); index++) {
		const stream = streams.lookup(index);
		let bytes = new Uint8Array(stream.contents);
		try {
			bytes = pako.inflate(bytes);
		} catch (e) {
			/* uncompressed pdf-lib drawing stream */
		}
		decoded += new TextDecoder("latin1").decode(bytes);
	}
	assert.doesNotMatch(decoded, /hjfy\.top\/arxiv\/2602\.09021/);
});

test("preserves high-bit PDF glyph codes when Gecko treats latin1 as Windows-1252", async () => {
	const PDFLib = require("../content/scripts/vendor/pdf-lib.min.js");
	const pako = require("../content/scripts/vendor/pako.min.js");
	const glyphBytes = Uint8Array.from([
		0x80, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
		0x89, 0x8a, 0x8b, 0x8c, 0x8e, 0x91, 0x92, 0x93,
		0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b,
		0x9c, 0x9e, 0x9f,
	]);
	const prefix = new TextEncoder().encode("BT /F0 10 Tf(");
	const suffix = new TextEncoder().encode(
		")Tj ET\nq/CPDFSTAMP BMC BT /F0 10 Tf(https://hjfy.top/arxiv/2311.18828)Tj ET EMC Q"
	);
	const content = new Uint8Array(prefix.length + glyphBytes.length + suffix.length);
	content.set(prefix);
	content.set(glyphBytes, prefix.length);
	content.set(suffix, prefix.length + glyphBytes.length);

	const source = await PDFLib.PDFDocument.create();
	const page = source.addPage([612, 792]);
	page.node.addContentStream(source.context.register(source.context.flateStream(content)));
	const input = await source.save({ useObjectStreams: false });

	const windows1252 = new Map([
		[0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
		[0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
		[0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
		[0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
		[0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
		[0x9e, 0x017e], [0x9f, 0x0178],
	]);
	class GeckoTextDecoder {
		decode(bytes) {
			return Array.from(bytes, (byte) => String.fromCodePoint(windows1252.get(byte) || byte)).join("");
		}
	}

	const { Plugin } = loadPlugin({ HJFYVendor: { PDFLib, pako }, TextDecoder: GeckoTextDecoder });
	const output = await new Plugin("file:///addon/")._cleanPdfBytes(input);
	const cleaned = await PDFLib.PDFDocument.load(Buffer.from(output), { updateMetadata: false });
	const streams = cleaned.getPage(0).node.Contents();
	let preserved = false;
	for (let index = 0; index < streams.size(); index++) {
		const stream = streams.lookup(index);
		let bytes = new Uint8Array(stream.contents);
		try {
			bytes = pako.inflate(bytes);
		} catch (e) {
			/* pdf-lib's white rectangle stream is not compressed */
		}
		for (let offset = 0; offset <= bytes.length - glyphBytes.length; offset++) {
			if (glyphBytes.every((byte, glyphIndex) => bytes[offset + glyphIndex] === byte)) {
				preserved = true;
				break;
			}
		}
	}

	assert.equal(preserved, true);
});

test("normalizes IOUtils bytes after pdf-lib rejects a cross-realm Uint8Array", async () => {
	const PDFLib = require("../content/scripts/vendor/pdf-lib.min.js");
	const source = await PDFLib.PDFDocument.create();
	source.addPage([612, 792]);
	const input = await source.save({ useObjectStreams: false });
	const calls = [];
	const PDFDocument = {
		async load(bytes, options) {
			calls.push(bytes);
			if (calls.length === 1) {
				throw new TypeError(
					"`pdf` must be of type `string` or `Uint8Array` or `ArrayBuffer`, but was actually of type `NaN`"
				);
			}
			assert.equal(Object.getPrototypeOf(bytes).constructor.name, "Uint8Array");
			assert.notEqual(bytes, input);
			assert.deepEqual(Array.from(bytes), Array.from(input));
			return PDFLib.PDFDocument.load(Buffer.from(bytes), options);
		},
	};
	const vendor = { ...PDFLib, PDFDocument };
	const { Plugin } = loadPlugin({ HJFYVendor: { PDFLib: vendor } });

	const output = await new Plugin("file:///addon/")._cleanPdfBytes(input);

	assert.equal(calls.length, 2);
	assert.ok(output.length > 0);
});

test("does not retry malformed PDF errors as cross-realm input errors", async () => {
	let calls = 0;
	const parseError = new Error("Failed to parse PDF document");
	const PDFLib = {
		PDFDocument: {
			async load() {
				calls++;
				throw parseError;
			},
		},
	};
	const { Plugin } = loadPlugin({ HJFYVendor: { PDFLib } });

	await assert.rejects(new Plugin("file:///addon/")._cleanPdfBytes(new Uint8Array([1, 2, 3])), parseError);
	assert.equal(calls, 1);
});
