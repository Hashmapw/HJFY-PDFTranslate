"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const HJFYLoginConfig = require("../content/scripts/login_config");

function loadPlugin(zoteroOverrides = {}) {
	const launchedURLs = [];
	const openedWindows = [];
	const addedCookies = [];
	const removedCookies = [];
	const preferences = new Map();
	const intervalCallbacks = [];
	const clearedIntervals = [];
	const Zotero = {
		debug() {},
		getMainWindows: () => [],
		Prefs: {
			get(key) {
				return preferences.get(key);
			},
			set(key, value) {
				preferences.set(key, value);
			},
		},
		launchURL(url) {
			launchedURLs.push(url);
		},
		...zoteroOverrides,
	};
	const Services = {
		cookies: {
			getCookiesFromHost() {
				return { hasMoreElements: () => false };
			},
			add(...args) {
				addedCookies.push(args);
			},
			remove(...args) {
				removedCookies.push(args);
			},
		},
		ww: {
			openWindow(...args) {
				openedWindows.push(args);
			},
		},
	};
	const context = {
		Zotero,
		Services,
		HJFYCore: { createApi: () => ({ userinfo: async () => ({ login: false }) }) },
		HJFYLoginConfig,
		ChromeUtils: {},
		Components: {
			interfaces: { nsICookie: { SAMESITE_LAX: 2, SCHEME_HTTPS: 2 } },
		},
		clearInterval(id) {
			clearedIntervals.push(id);
		},
		setInterval(callback) {
			intervalCallbacks.push(callback);
			return intervalCallbacks.length;
		},
		setTimeout(callback) {
			callback();
			return 1;
		},
		console,
	};
	const source = fs.readFileSync(path.join(__dirname, "../content/scripts/plugin.js"), "utf8");
	vm.runInNewContext(source, context);
	return {
		Plugin: Zotero.HJFYPlugin,
		Services,
		launchedURLs,
		openedWindows,
		addedCookies,
		removedCookies,
		preferences,
		intervalCallbacks,
		clearedIntervals,
	};
}

test("opens the WeChat dialog through Zotero's main window", () => {
	const openedDialogs = [];
	const dialogWindow = {
		document: { readyState: "loading" },
		addEventListener() {},
	};
	const { Plugin, Services } = loadPlugin({
		getMainWindow: () => ({
			openDialog(...args) {
				openedDialogs.push(args);
				return dialogWindow;
			},
		}),
	});
	const embeddedPreferencesWindow = {};
	const plugin = new Plugin("file:///addon/", Services);

	plugin.openWechatLogin(() => {}, embeddedPreferencesWindow);

	assert.equal(openedDialogs.length, 1);
	assert.equal(openedDialogs[0][0], "chrome://hjfy-pdftranslate/content/dialogs/wechatLogin.xhtml");
	assert.equal(openedDialogs[0][1], "hjfy-wechat-login");
	assert.match(openedDialogs[0][2], /(?:^|,)chrome(?:,|$)/);
	assert.match(openedDialogs[0][2], /width=420,height=430/);
});

test("clears only the HJFY session before opening WeChat login", () => {
	const openedDialogs = [];
	const dialogWindow = { document: { readyState: "loading" }, addEventListener() {} };
	const { Plugin, Services, removedCookies, preferences } = loadPlugin({
		getMainWindow: () => ({
			openDialog(...args) {
				openedDialogs.push(args);
				return dialogWindow;
			},
		}),
	});
	const cookies = [
		{ host: "hjfy.top", name: "session", path: "/", originAttributes: {} },
		{ host: ".hjfy.top", name: "csrf", path: "/", originAttributes: {} },
	];
	Services.cookies.getCookiesFromHost = () => cookies;
	const plugin = new Plugin("file:///addon/", Services);

	plugin.openWechatLogin(() => {});

	assert.deepEqual(removedCookies.map((args) => args.slice(0, 3)), [
		["hjfy.top", "session", "/"],
	]);
	assert.equal(preferences.get("extensions.hjfy-pdftranslate.session"), "");
	assert.equal(openedDialogs.length, 1);
});

test("clears the old session before opening the website phone login", () => {
	const openedDialogs = [];
	const dialogWindow = {
		document: { readyState: "loading" },
		addEventListener() {},
	};
	const { Plugin, Services, removedCookies, preferences } = loadPlugin({
		getMainWindow: () => ({
			openDialog(...args) {
				openedDialogs.push(args);
				return dialogWindow;
			},
		}),
	});
	Services.cookies.getCookiesFromHost = () => [
		{ host: ".hjfy.top", name: "session", path: "/", originAttributes: {} },
		{ host: ".hjfy.top", name: "csrf", path: "/", originAttributes: {} },
	];
	const plugin = new Plugin("file:///addon/", Services);

	plugin.openPhoneLogin(() => {});

	assert.deepEqual(removedCookies.map((args) => args.slice(0, 3)), [[".hjfy.top", "session", "/"]]);
	assert.equal(preferences.get("extensions.hjfy-pdftranslate.session"), "");
	assert.equal(openedDialogs.length, 1);
	assert.equal(openedDialogs[0][0], "chrome://hjfy-pdftranslate/content/dialogs/loginBrowser.xhtml");
	assert.equal(openedDialogs[0][1], "hjfy-phone-login");
	assert.match(openedDialogs[0][2], /(?:^|,)chrome(?:,|$)/);
	assert.match(openedDialogs[0][2], /width=900,height=700/);
});

test("ships fixed controls and an opaque background for WeChat login", () => {
	const source = fs.readFileSync(path.join(__dirname, "../content/dialogs/wechatLogin.xhtml"), "utf8");

	assert.match(source, /id="hjfy-wechat-qr"/);
	assert.match(source, /id="hjfy-wechat-status"/);
	assert.match(source, /id="hjfy-wechat-close"/);
	assert.match(source, /background:\s*Canvas/);
});

test("uses the Services instance supplied by bootstrap for cookies", () => {
	const { Plugin, Services } = loadPlugin();
	const plugin = new Plugin("file:///addon/", Services);

	assert.equal(plugin._readSessionCookie(), null);
});

test("reads a session cookie even when the Ci global is unavailable", () => {
	const { Plugin, Services } = loadPlugin();
	const plugin = new Plugin("file:///addon/", Services);
	let hasCookie = true;
	Services.cookies.getCookiesFromHost = () => ({
		hasMoreElements() {
			return hasCookie;
		},
		getNext() {
			hasCookie = false;
			return { name: "session", value: "wechat-session" };
		},
	});

	assert.equal(plugin._readSessionCookie(), "wechat-session");
});

test("reads a session cookie from Zotero 10's iterable cookie result", () => {
	const { Plugin, Services } = loadPlugin();
	const plugin = new Plugin("file:///addon/", Services);
	Services.cookies.getCookiesFromHost = () => [
		{ name: "csrf", value: "ignored" },
		{ name: "session", value: "modern-session" },
	];

	assert.equal(plugin._readSessionCookie(), "modern-session");
});

test("writes a session cookie with Zotero 10's 11-argument signature", async () => {
	const { Plugin, Services, addedCookies, preferences } = loadPlugin();
	const plugin = new Plugin("file:///addon/", Services);
	plugin.checkLogin = async () => ({ login: true, nickname: "tester" });

	const result = await plugin.saveSession("phone-session");

	assert.equal(result.ok, true);
	assert.equal(addedCookies.length, 1);
	assert.equal(addedCookies[0].length, 11);
	assert.equal(addedCookies[0][9], 2);
	assert.equal(addedCookies[0][10], 2);
	assert.notEqual(preferences.get("extensions.hjfy-pdftranslate.session"), "phone-session");
});

test("parses WeChat scan and authorization responses in the plugin flow", () => {
	const { Plugin, Services } = loadPlugin();
	const plugin = new Plugin("file:///addon/", Services);

	const scanned = plugin._parseWechatPoll("window.wx_errcode=404;window.wx_code='';");
	const authorized = plugin._parseWechatPoll('window.wx_errcode=405;window.wx_code="oauth-code";');

	assert.equal(scanned.code, 404);
	assert.equal(scanned.wxCode, "");
	assert.equal(authorized.code, 405);
	assert.equal(authorized.wxCode, "oauth-code");
});

test("exchanges a confirmed WeChat code with the original callback path", async () => {
	const requests = [];
	const { Plugin, Services } = loadPlugin({
		HTTP: {
			async request(method, url, options) {
				requests.push({ method, url, options });
				if (url.includes("open.weixin.qq.com/connect/qrconnect")) {
					return { responseText: '<img src="/connect/qrcode/test-uuid">' };
				}
				if (url.includes("long.open.weixin.qq.com")) {
					return { responseText: "window.wx_errcode=405;window.wx_code='oauth-code';" };
				}
				return { responseText: "" };
			},
		},
	});
	const plugin = new Plugin("file:///addon/", Services);
	plugin._readSessionCookie = () => "wechat-session";
	plugin._request = async () => ({ login: true });
	const win = { closed: false };
	const image = { addEventListener() {}, hidden: true, src: "" };
	const status = { textContent: "" };
	let sessionSeen = null;

	await plugin._runWechatLogin(win, image, status, async (session) => {
		sessionSeen = session;
	});

	const callback = requests.find((request) => request.url.includes("hjfy.top/api/login/callback/wechat"));
	assert.equal(sessionSeen, "wechat-session");
	assert.match(callback.url, /callback\/wechat\?path=%2F&code=oauth-code&state=HJFYZT$/);
	assert.deepEqual(Array.from(callback.options.successCodes), [200, 302, 303, 307, 308]);
});

test("updates the WeChat status after the QR code is scanned", async () => {
	const pollBodies = [
		"window.wx_errcode=408;window.wx_code='';",
		"window.wx_errcode=404;window.wx_code='';",
		"window.wx_errcode=405;window.wx_code='oauth-code';",
	];
	const { Plugin, Services } = loadPlugin({
		HTTP: {
			async request(method, url) {
				if (url.includes("open.weixin.qq.com/connect/qrconnect")) {
					return { responseText: '<img src="/connect/qrcode/test-uuid">' };
				}
				if (url.includes("long.open.weixin.qq.com")) {
					return { responseText: pollBodies.shift() };
				}
				return { responseText: "" };
			},
		},
	});
	const plugin = new Plugin("file:///addon/", Services);
	plugin._readSessionCookie = () => "wechat-session";
	plugin._request = async () => ({ login: true });
	const states = [];
	const status = {
		set textContent(value) {
			states.push(value);
		},
	};

	await plugin._runWechatLogin(
		{ closed: false },
		{ addEventListener() {}, hidden: true, src: "" },
		status,
		async () => {}
	);

	assert.ok(states.includes("已扫码，请在手机上确认"));
});

test("ships a remote content browser for the website login flow", () => {
	const source = fs.readFileSync(path.join(__dirname, "../content/dialogs/loginBrowser.xhtml"), "utf8");

	assert.match(source, /<browser\b/);
	assert.match(source, /type="content"/);
	assert.match(source, /remote="true"/);
	assert.match(source, /id="hjfy-login-browser"/);
});

test("bootstrap registers the chrome content package used by the login window", () => {
	const source = fs.readFileSync(path.join(__dirname, "../bootstrap.js"), "utf8");

	assert.match(source, /registerChrome\(/);
	assert.match(source, /\["content",\s*"hjfy-pdftranslate",\s*rootURI \+ "content\/"\]/);
	assert.match(source, /chromeHandle\.destruct\(\)/);
});

test("website phone login polls the authenticated API instead of using frame scripts", () => {
	const source = fs.readFileSync(path.join(__dirname, "../content/scripts/plugin.js"), "utf8");

	assert.match(source, /_renderPhoneWebsiteLogin\(win, onChanged\)/);
	assert.match(source, /const user = await this\.checkLogin\(\)/);
	assert.match(source, /setInterval\(verifyLogin, 1000\)/);
});

test("uses one shared WeChat app, state, and polling endpoint", () => {
	const config = require("../content/scripts/login_config");
	assert.equal(config.APP_ID, "wxd7885e86e52192fe");
	assert.equal(config.STATE, "HJFYZT");
	assert.equal(config.POLL_BASE, "https://long.open.weixin.qq.com");
	for (const file of ["wechat_login.js", "wechat_poll.js", "wechat_chrome.js"]) {
		const source = fs.readFileSync(path.join(__dirname, file), "utf8");
		assert.match(source, /content\/scripts\/login_config/);
		assert.doesNotMatch(source, /HJFYTEST|wxd7885e86e52192fe|https:\/\/lp\.open\.weixin\.qq\.com/);
	}
});

test("closes the website login window only after userinfo confirms login", async () => {
	const { Plugin, Services, intervalCallbacks, clearedIntervals } = loadPlugin();
	const plugin = new Plugin("file:///addon/", Services);
	const browserListeners = {};
	const windowListeners = {};
	const browser = {
		addEventListener(name, listener) {
			browserListeners[name] = listener;
		},
		removeEventListener() {},
		setAttribute(name, value) {
			this[name] = value;
		},
	};
	const status = { textContent: "" };
	const closeButton = { addEventListener() {} };
	const win = {
		closed: false,
		document: {
			title: "",
			getElementById(id) {
				return { "hjfy-login-browser": browser, "hjfy-login-status": status, "hjfy-login-close": closeButton }[id];
			},
		},
		addEventListener(name, listener) {
			windowListeners[name] = listener;
		},
		focus() {},
		close() {
			this.closed = true;
		},
	};
	const loginStates = [{ login: false }, { login: true, nickname: "tester" }];
	plugin.checkLogin = async () => loginStates.shift();
	let refreshed = false;
	plugin.notify = () => {};
	plugin._renderPhoneWebsiteLogin(win, async () => {
		refreshed = true;
	});

	assert.match(browser.src, /^https:\/\/hjfy\.top\/\?hjfy-login=/);
	assert.equal(status.textContent, "请在页面右上角完成手机号登录");
	await browserListeners.load();
	assert.equal(status.textContent, "请在页面右上角完成手机号登录");
	await intervalCallbacks[0]();

	assert.equal(refreshed, true);
	assert.equal(win.closed, true);
	windowListeners.unload();
	assert.deepEqual(clearedIntervals, [1]);
});
