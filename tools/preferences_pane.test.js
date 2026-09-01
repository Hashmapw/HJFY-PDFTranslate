"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const HJFYLoginConfig = require("../content/scripts/login_config");

function loadPlugin() {
	const registrations = [];
	const Zotero = {
		debug() {},
		getMainWindows: () => [],
		PreferencePanes: {
			async register(options) {
				registrations.push(options);
				return options.id;
			},
		},
	};
	const context = {
		Zotero,
		HJFYCore: { createApi: () => ({ userinfo: async () => ({ login: false }) }) },
		HJFYLoginConfig,
		ChromeUtils: {},
		console,
	};
	const source = fs.readFileSync(path.join(__dirname, "../content/scripts/plugin.js"), "utf8");
	vm.runInNewContext(source, context);
	return { Plugin: Zotero.HJFYPlugin, registrations };
}

test("registers a stable Zotero preference pane and waits for completion", async () => {
	const { Plugin, registrations } = loadPlugin();
	const plugin = new Plugin("file:///addon/");
	await plugin._registerPrefsPane();

	assert.equal(registrations.length, 1);
	assert.equal(registrations[0].id, "hjfy-pdftranslate-preferences");
	assert.equal(registrations[0].label, "HJFY翻译插件");
	assert.equal(registrations[0].pluginID, "hjfy-pdftranslate@hjfy.top");
	assert.equal(registrations[0].src, "file:///addon/content/preferences/preferences.xhtml");
	assert.equal(registrations[0].image, "file:///addon/content/resources/logo-32-padded.png");
	assert.equal(registrations[0].stylesheets, undefined);
});

test("a menu registration error does not prevent preference registration", async () => {
	const { Plugin, registrations } = loadPlugin();
	const plugin = new Plugin("file:///addon/");
	plugin._registerMenu = () => {
		throw new Error("menu API unavailable");
	};
	await plugin.init();

	assert.equal(registrations.length, 1);
});

test("preference markup is an XHTML fragment accepted by Zotero", () => {
	const source = fs
		.readFileSync(path.join(__dirname, "../content/preferences/preferences.xhtml"), "utf8")
		.trim();

	assert.match(source, /^<vbox\b/);
	assert.doesNotMatch(source, /<!DOCTYPE|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>)/i);
	assert.match(source, /xmlns:html="http:\/\/www\.w3\.org\/1999\/xhtml"/);
	assert.match(source, /onload="Zotero\.HJFY\.setupPrefs\(window\)"/);
	assert.match(source, /<html:style><!\[CDATA\[/);
	assert.doesNotMatch(source, /html:(?:header|section|h2|details|summary)\b/);
	assert.doesNotMatch(source, /\.dataset\b/);
	for (const id of [
		"hjfy-status",
		"hjfy-wechat-login",
		"hjfy-phone-login",
		"hjfy-clean-pdf",
		"hjfy-logout",
	]) {
		assert.match(source, new RegExp(`id="${id}"`));
	}
	for (const removedID of ["hjfy-phone", "hjfy-phone-code", "hjfy-advanced-toggle", "hjfy-session-input"]) {
		assert.doesNotMatch(source, new RegExp(`id="${removedID}"`));
	}
	assert.doesNotMatch(source, /①|②|基于 hjfy\.top|人机验证|不是简单遮盖/);
});

test("preference layout keeps styles inside the pane", () => {
	const source = fs.readFileSync(path.join(__dirname, "../content/preferences/preferences.xhtml"), "utf8");

	assert.match(source, /font:\s*13px\/1\.55/);
	assert.match(source, /\.hjfy-brand\s*\{[^}]*font-size:\s*14px;[^}]*font-weight:\s*700;/);
	assert.match(source, /<html:div class="hjfy-brand">幻觉翻译账号登录<\/html:div>/);
	assert.match(source, /\.hjfy-block/);
	assert.match(source, /margin:\s*10px 0/);
	assert.match(source, /id="hjfy-wechat-login"[\s\S]*id="hjfy-phone-login"[\s\S]*id="hjfy-logout"/);
	assert.doesNotMatch(source, /hjfy-phone-form|hjfy-advanced/);
});

test("manifest uses padded icons at their declared sizes", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
	assert.equal(manifest.description, "幻觉翻译Zotero插件");
	for (const [size, relativePath] of Object.entries(manifest.icons)) {
		const png = fs.readFileSync(path.join(__dirname, "..", relativePath));
		assert.equal(png.toString("ascii", 1, 4), "PNG");
		assert.equal(png.readUInt32BE(16), Number(size));
		assert.equal(png.readUInt32BE(20), Number(size));
	}
});
