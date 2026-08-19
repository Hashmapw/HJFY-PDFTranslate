"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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
		HJFYCore: { createApi: () => ({}) },
		ChromeUtils: {},
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

test("unregisters the menu during shutdown", () => {
	const { Plugin, unregistrations } = loadPlugin();
	const plugin = new Plugin("file:///addon/");
	plugin._registerMenu();
	plugin.shutdown();

	assert.deepEqual(unregistrations, ["hjfy-pdftranslate-fetch-cn"]);
});

test("bootstrap starts with the Services global provided by Zotero 8", () => {
	const loadedScripts = [];
	const Zotero = { debug() {}, HJFY: null };
	class Plugin {
		init() {
			this.initialized = true;
		}
	}
	const context = {
		Zotero,
		Services: {
			scriptloader: {
				loadSubScript(url) {
					loadedScripts.push(url);
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
	context.startup({ id: "hjfy-pdftranslate@hjfy.top", version: "0.1.0", rootURI: "file:///addon/" });

	assert.equal(loadedScripts.length, 4);
	assert.equal(Zotero.HJFY.initialized, true);
});
