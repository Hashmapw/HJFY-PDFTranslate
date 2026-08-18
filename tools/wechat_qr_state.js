"use strict";

// 微信 qrconnect 轮询接口返回的是一段 JavaScript，而不是 JSON。
// 注意：这是开放平台 qrconnect 的码表，和微信网页登录接口的码表不同。
// 405 会触发 redirect，404 只是扫码提示，408 是长轮询超时后继续等待。
const STATE = Object.freeze({
	405: "确认成功",
	404: "已扫码,请在手机确认",
	408: "等待扫码",
	403: "用户取消授权",
	402: "二维码失效/被占用",
	500: "微信服务异常",
});

function unescapeJsString(value) {
	return value
		.replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
		.replace(/\\(['"\\])/g, "$1");
}

/**
 * Parse the response from lp.open.weixin.qq.com/connect/l/qrconnect.
 * The endpoint has used both single and double quotes over time.
 */
function parsePollResponse(body) {
	if (typeof body !== "string") return null;
	const err = /(?:window\.)?wx_errcode\s*=\s*(-?\d+)/.exec(body);
	if (!err) return null;

	const code = Number.parseInt(err[1], 10);
	if (!Number.isFinite(code)) return null;

	const codeMatch = /(?:window\.)?wx_code\s*=\s*(['"])([\s\S]*?)\1/.exec(body);
	const wxCode = codeMatch ? unescapeJsString(codeMatch[2]) : "";
	return { code, wxCode };
}

function isAuthorizationSuccess(state) {
	return !!state && state.code === 405 && typeof state.wxCode === "string" && state.wxCode.length > 0;
}

function isScanned(state) {
	return !!state && state.code === 404;
}

function isTerminalFailure(state) {
	return !!state && (state.code === 403 || state.code === 402 || state.code === 500);
}

module.exports = { STATE, parsePollResponse, isAuthorizationSuccess, isScanned, isTerminalFailure };
