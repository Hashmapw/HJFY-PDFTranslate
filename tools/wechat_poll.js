#!/usr/bin/env node
/*
 * HJFY-PDFTranslate / tools/wechat_poll.js
 * 微信扫码登录全流程（自包含，无需参数）：
 *   1) GET qrconnect 页面，捕获页面 cookie，提取 uuid
 *   2) 下载二维码 -> tools/wechat-login-qr.jpg
 *   3) 带 cookie 轮询状态（408等待/404已扫待确认/405确认成功）
 *   4) errcode=405 拿到 wx_code 后，访问 hjfy.top 回调，捕获 session 并验证 userinfo
 * 用法: node tools/wechat_poll.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const {
	STATE,
	parsePollResponse,
	isAuthorizationSuccess,
	isScanned,
	isTerminalFailure,
} = require("./wechat_qr_state");

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151 Safari/537.36";
const APPID = "wxd7885e86e52192fe";
const REDIRECT = encodeURIComponent("https://hjfy.top/api/login/callback/wechat?path=%2F");
const QR_OUT = path.join(__dirname, "wechat-login-qr.jpg");

let cookieJar = [];

function request(url, { method = "GET", referer, binary = false } = {}) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const headers = {
			"User-Agent": UA,
			Accept: "*/*",
			"Accept-Language": "zh-CN,zh;q=0.9",
			Connection: "keep-alive",
		};
		if (referer) headers["Referer"] = referer;
		if (cookieJar.length) {
			headers["Cookie"] = cookieJar.map((c) => `${c.name}=${c.value}`).join("; ");
		}
		const req = https.request(u, { method, headers }, (res) => {
			for (const sc of res.headers["set-cookie"] || []) {
				const seg = sc.split(";")[0];
				const eq = seg.indexOf("=");
				if (eq < 0) continue;
				const name = seg.slice(0, eq).trim();
				const value = seg.slice(eq + 1).trim();
				const idx = cookieJar.findIndex((c) => c.name === name);
				if (idx >= 0) cookieJar[idx] = { name, value };
				else cookieJar.push({ name, value });
			}
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const buf = Buffer.concat(chunks);
				resolve({ status: res.statusCode, headers: res.headers, buffer: buf, text: buf.toString("utf8") });
			});
		});
		req.on("error", (e) => reject(new Error(e.message)));
		req.end();
	});
}

async function main() {
	console.log("[1/4] 请求 qrconnect 页面(捕获cookie) -> 提取 uuid");
	const page = await request(
		`https://open.weixin.qq.com/connect/qrconnect?appid=${APPID}&scope=snsapi_login` +
			`&redirect_uri=${REDIRECT}&state=HJFYTEST&login_type=jssdk&self_redirect=false`
	);
	if (page.status !== 200) {
		console.error("qrconnect 页面失败:", page.status, page.text.slice(0, 160));
		process.exit(2);
	}
	const mU = /uuid=([A-Za-z0-9_\-]+)/.exec(page.text);
	if (!mU) {
		console.error("未找到 uuid", page.text.slice(0, 200));
		process.exit(2);
	}
	const uuid = mU[1];
	console.log("uuid =", uuid, "| cookies:", cookieJar.map((c) => c.name).join(","));

	console.log("[2/4] 下载二维码 -> " + QR_OUT);
	const img = await request(`https://open.weixin.qq.com/connect/qrcode/${uuid}`);
	if (img.status !== 200) {
		console.error("二维码下载失败:", img.status);
		process.exit(2);
	}
	fs.writeFileSync(QR_OUT, img.buffer);
	console.log("二维码已保存");

	console.log("[3/4] 带cookie轮询扫码状态");
	const deadline = Date.now() + 7 * 60 * 1000;
	let last = -1;
	let scanned = false;
	while (Date.now() < deadline) {
		const ts = Date.now() + "000";
		const lastParam = scanned ? "&last=404" : "";
		const r = await request(`https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${uuid}${lastParam}&_=${ts}`, {
			referer: "https://open.weixin.qq.com/",
		});
		const poll = parsePollResponse(r.text || "");
		if (poll) {
			const { code, wxCode } = poll;
			if (isScanned(poll)) scanned = true;
			if (code !== last) {
				const label = code === 408 && scanned ? STATE[404] : STATE[code] || "未知";
				console.log(
					`[${new Date().toTimeString().slice(0, 8)}] errcode=${code} ${label}${wxCode ? " code=" + wxCode : ""}`
				);
				last = code;
			}
			if (isAuthorizationSuccess(poll)) {
				console.log("[4/4] 授权码已确认");
				const cb = await request(
					`https://hjfy.top/api/login/callback/wechat?code=${encodeURIComponent(wxCode)}&state=HJFYTEST`
				);
				console.log("回调 HTTP:", cb.status);
				const session = cookieJar.find((cookie) => cookie.name === "session");
				if (!session) {
					console.error("回调未种 session, body:", cb.text.slice(0, 200));
					process.exit(4);
				}
				const ui = await request("https://hjfy.top/api/userinfo");
				let user = null;
				try {
					user = JSON.parse(ui.text);
				} catch (e) {
					/* handled below */
				}
				if (!user || !user.login) {
					console.error("session 存在但 userinfo 未确认 login:true");
					process.exit(4);
				}
				console.log("SESSION_OK", session.value);
				console.log("userinfo:", JSON.stringify(user).slice(0, 160));
				process.exit(0);
			}
			if (code === 405 && !wxCode) {
				console.log("微信返回确认成功但未携带授权码，继续轮询");
			}
			if (isTerminalFailure(poll)) {
				console.log(STATE[code] || "二维码登录失败", "，重新运行本脚本生成新码");
				process.exit(3);
			}
		} else if (r.text && r.text.length) {
			console.log("(格式异常)", r.text.slice(0, 120));
		}
		await new Promise((res) => setTimeout(res, 1200));
	}
	console.log("超时(7分钟)未完成");
	process.exit(1);
}

main().catch((e) => {
	console.error("出错:", e.message);
	process.exit(1);
});
