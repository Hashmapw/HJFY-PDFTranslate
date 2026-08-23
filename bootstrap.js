/*
 * HJFY-PDFTranslate bootstrap (Zotero 7)
 */
"use strict";

function log(msg) {
	Zotero.debug("HJFY-PDFTranslate: " + msg);
}

async function startup({ id, version, rootURI }) {
	log("startup " + version);
	try {
		if (!Zotero.HJFY) {
			// Gecko's loadSubScript does not reliably expose UMD globals on a plain
			// object scope. Load them here and capture them for plugin code.
			Services.scriptloader.loadSubScript(rootURI + "content/scripts/vendor/pdf-lib.min.js");
			Services.scriptloader.loadSubScript(rootURI + "content/scripts/vendor/pako.min.js");
			const pdfLib = typeof PDFLib !== "undefined" ? PDFLib : globalThis.PDFLib;
			const pakoLib = typeof pako !== "undefined" ? pako : globalThis.pako;
			if (!pdfLib || !pakoLib) throw new Error("PDF cleaning libraries failed to load");
			Zotero.HJFYVendor = Object.freeze({ PDFLib: pdfLib, pako: pakoLib });
			try {
				delete globalThis.PDFLib;
				delete globalThis.pako;
			} catch (e) {
				/* non-configurable globals are harmless after capture */
			}
			// core.js: 纯逻辑 (全局 HJFYCore)
			Services.scriptloader.loadSubScript(rootURI + "content/scripts/core.js");
			// plugin.js: Zotero 胶水 (定义 Zotero.HJFYPlugin)
			Services.scriptloader.loadSubScript(rootURI + "content/scripts/plugin.js");
			Zotero.HJFY = new Zotero.HJFYPlugin(rootURI, Services);
			await Zotero.HJFY.init();
		}
	} catch (e) {
		log("startup error: " + e + "\n" + (e && e.stack ? e.stack : ""));
	}
}

function onMainWindowLoad({ window }) {
	if (Zotero.HJFY) {
		try {
			Zotero.HJFY.onMainWindowLoad(window);
		} catch (e) {
			log("onMainWindowLoad error: " + e);
		}
	}
}

function onMainWindowUnload({ window }) {
	if (Zotero.HJFY) {
		try {
			Zotero.HJFY.onMainWindowUnload(window);
		} catch (e) {
			log("onMainWindowUnload error: " + e);
		}
	}
}

function shutdown() {
	if (Zotero.HJFY) {
		try {
			Zotero.HJFY.shutdown();
		} catch (e) {
			log("shutdown error: " + e);
		}
	}
	Zotero.HJFY = null;
	Zotero.HJFYVendor = null;
}

function install() {
	log("install");
}

function uninstall() {
	log("uninstall");
}
