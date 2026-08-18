/*
 * HJFY-PDFTranslate bootstrap (Zotero 7)
 */
"use strict";

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

function log(msg) {
	Zotero.debug("HJFY-PDFTranslate: " + msg);
}

function startup({ id, version, rootURI }) {
	log("startup " + version);
	try {
		if (!Zotero.HJFY) {
			// vendor: pdf-lib (PDF处理) / pako (zlib解压), 挂到全局 PDFLib / pako
			Services.scriptloader.loadSubScript(rootURI + "content/scripts/vendor/pdf-lib.min.js");
			Services.scriptloader.loadSubScript(rootURI + "content/scripts/vendor/pako.min.js");
			// core.js: 纯逻辑 (全局 HJFYCore)
			Services.scriptloader.loadSubScript(rootURI + "content/scripts/core.js");
			// plugin.js: Zotero 胶水 (定义 Zotero.HJFYPlugin)
			Services.scriptloader.loadSubScript(rootURI + "content/scripts/plugin.js");
			Zotero.HJFY = new Zotero.HJFYPlugin(rootURI);
			Zotero.HJFY.init();
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
}

function install() {
	log("install");
}

function uninstall() {
	log("uninstall");
}
