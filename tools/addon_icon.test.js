"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");

function readPngSize(relativePath) {
	const data = fs.readFileSync(path.join(ROOT, relativePath));
	assert.equal(data.subarray(1, 4).toString("ascii"), "PNG");
	return {
		width: data.readUInt32BE(16),
		height: data.readUInt32BE(20),
	};
}

test("manifest icon sizes match the actual PNG dimensions", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

	assert.deepEqual(manifest.icons, {
		48: "icon.png",
		96: "icon@2x.png",
	});
	assert.deepEqual(readPngSize(manifest.icons[48]), { width: 48, height: 48 });
	assert.deepEqual(readPngSize(manifest.icons[96]), { width: 96, height: 96 });
});
