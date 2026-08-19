"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPlugin(zoteroOverrides = {}) {
	const launchedURLs = [];
	const openedWindows = [];
	const Zotero = {
		debug() {},
		getMainWindows: () => [],
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
		HJFYCore: { createApi: () => ({}) },
		ChromeUtils: {},
		clearInterval() {},
		setInterval: () => 1,
		console,
	};
	const source = fs.readFileSync(path.join(__dirname, "../content/scripts/plugin.js"), "utf8");
	vm.runInNewContext(source, context);
	return { Plugin: Zotero.HJFYPlugin, Services, launchedURLs, openedWindows };
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
	assert.equal(openedDialogs[0][0], "about:blank");
	assert.equal(openedDialogs[0][1], "hjfy-wechat-login");
	assert.doesNotMatch(openedDialogs[0][2], /(?:^|,)chrome(?:,|$)/);
	assert.equal(typeof openedDialogs[0][3].onSuccess, "function");
	assert.equal(openedDialogs[0][3].services, Services);
});

test("uses Zotero.launchURL for the phone-login captcha page", async () => {
	const { Plugin, Services, launchedURLs } = loadPlugin();
	const plugin = new Plugin("file:///addon/", Services);
	plugin._request = async () => ({ status: 400, msg: "captcha required" });

	const result = await plugin.trySendCode("13800138000");

	assert.equal(result.needCaptcha, true);
	assert.deepEqual(launchedURLs, ["https://hjfy.top/"]);
});

test("uses the Services instance supplied by bootstrap for cookies", () => {
	const { Plugin, Services } = loadPlugin();
	const plugin = new Plugin("file:///addon/", Services);

	assert.equal(plugin._readSessionCookie(), null);
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
