"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const manifest = require("../manifest.json");
const updates = require("../update.json");

test("update metadata matches the manifest release", () => {
	const pluginID = manifest.applications.zotero.id;
	const entries = updates.addons[pluginID].updates;
	assert.equal(entries.length, 1);
	assert.equal(entries[0].version, manifest.version);
	assert.equal(
		entries[0].update_link,
		`https://github.com/Hashmapw/HJFY-PDFTranslate/releases/download/v${manifest.version}/hjfy-pdftranslate-${manifest.version}.xpi`
	);
});
