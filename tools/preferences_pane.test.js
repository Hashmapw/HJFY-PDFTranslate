"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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
		HJFYCore: { createApi: () => ({}) },
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
	assert.equal(registrations[0].pluginID, "hjfy-pdftranslate@hjfy.top");
	assert.equal(registrations[0].src, "file:///addon/content/preferences/preferences.xhtml");
	assert.equal(registrations[0].label, "HJFY 翻译");
	assert.deepEqual(Array.from(registrations[0].stylesheets), [
		"file:///addon/content/preferences/preferences.css",
	]);
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
	assert.doesNotMatch(source, /<html:style>/);
	for (const id of [
		"hjfy-status",
		"hjfy-wechat-login",
		"hjfy-phone",
		"hjfy-phone-code",
		"hjfy-clean-pdf",
		"hjfy-logout",
	]) {
		assert.match(source, new RegExp(`id="${id}"`));
	}
	assert.doesNotMatch(source, /①|②|基于 hjfy\.top|人机验证|不是简单遮盖/);
});

test("preference layout uses readable spacing", () => {
	const source = fs.readFileSync(path.join(__dirname, "../content/preferences/preferences.css"), "utf8");

	assert.match(source, /line-height:\s*1\.55/);
	assert.match(source, /row-gap:\s*12px/);
	assert.match(source, /\.hjfy-section\s*\{/);
});
