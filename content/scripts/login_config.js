(function (root, factory) {
	if (typeof module !== "undefined" && module.exports) {
		module.exports = factory();
	} else {
		root.HJFYLoginConfig = factory();
	}
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	const APP_ID = "wxd7885e86e52192fe";
	const STATE = "HJFYZT";
	const CALLBACK_PATH = "/api/login/callback/wechat?path=%2F";
	// The official qrconnect page can select lp or long through usenewdomain.
	// Keep one tested endpoint across the plugin and diagnostic tools.
	const POLL_BASE = "https://long.open.weixin.qq.com";

	return Object.freeze({ APP_ID, STATE, CALLBACK_PATH, POLL_BASE });
});
