"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	STATE,
	parsePollResponse,
	isAuthorizationSuccess,
	isScanned,
	isTerminalFailure,
} = require("./wechat_qr_state");

test("uses the qrconnect status-code mapping", () => {
	assert.equal(STATE[408], "等待扫码");
	assert.equal(STATE[404], "已扫码,请在手机确认");
	assert.equal(STATE[405], "确认成功");
	assert.equal(STATE[403], "用户取消授权");
	assert.equal(STATE[402], "二维码失效/被占用");
});

test("parses the JavaScript poll response", () => {
	assert.deepEqual(parsePollResponse("window.wx_errcode=408;window.wx_code='';"), {
		code: 408,
		wxCode: "",
	});
	assert.deepEqual(parsePollResponse('window.wx_errcode = 405; window.wx_code = "oauth-code";'), {
		code: 405,
		wxCode: "oauth-code",
	});
	assert.equal(parsePollResponse("not a poll response"), null);
});

test("does not confuse scanning with authorization", () => {
	const waiting = parsePollResponse("window.wx_errcode=408;window.wx_code='';");
	const scanned = parsePollResponse("window.wx_errcode=404;window.wx_code='';");
	const authorized = parsePollResponse("window.wx_errcode=405;window.wx_code='abc123';");

	assert.equal(isScanned(waiting), false);
	assert.equal(isScanned(scanned), true);
	assert.equal(isAuthorizationSuccess(scanned), false);
	assert.equal(isAuthorizationSuccess(authorized), true);
	assert.equal(isAuthorizationSuccess({ code: 405, wxCode: "" }), false);
	assert.equal(isAuthorizationSuccess({ code: 0, wxCode: "legacy-code" }), false);
});

test("only cancellation, expiry and service errors are terminal failures", () => {
	assert.equal(isTerminalFailure({ code: 404 }), false);
	assert.equal(isTerminalFailure({ code: 408 }), false);
	assert.equal(isTerminalFailure({ code: 403 }), true);
	assert.equal(isTerminalFailure({ code: 402 }), true);
	assert.equal(isTerminalFailure({ code: 500 }), true);
});
