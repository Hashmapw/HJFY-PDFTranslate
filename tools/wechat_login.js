#!/usr/bin/env node
/*
 * HJFY-PDFTranslate / tools/wechat_login.js
 * 微信扫码登录(综合版):
 *   - Tab 停留在 qrconnect 页面(页面自身的JS轮询保持活跃)
 *   - 截取二维码 PNG 供用户扫描
 *   - 双重检测扫码结果:
 *       A) 监听该 Tab 的 location.href 跳转到 hjfy.top 回调(页面自己完成的跳转)
 *       B) 用浏览器 cookie 从外部轮询 lp 状态接口(errcode=405 拿到 wx_code)
 *   - 拿到 code 后主动导航回调 -> 读取 session -> 验证 userinfo
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

const PORT = 9333;
const APPID = "wxd7885e86e52192fe";
const REDIRECT = encodeURIComponent("https://hjfy.top/api/login/callback/wechat?path=%2F");
const QR_URL =
	`https://open.weixin.qq.com/connect/qrconnect?appid=${APPID}&scope=snsapi_login` +
	`&redirect_uri=${REDIRECT}&state=HJFYTEST&login_type=jssdk&self_redirect=false`;
const QR_OUT = path.join(__dirname, "wechat-login-qr.png");
const WAIT_MIN = parseInt(process.argv[2] || "15", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
	constructor(wsUrl) {
		this.wsUrl = wsUrl;
		this.id = 0;
		this.pending = new Map();
	}
	async open() {
		this.ws = new WebSocket(this.wsUrl);
		await new Promise((res, rej) => {
			this.ws.onopen = res;
			this.ws.onerror = () => rej(new Error("ws error"));
		});
		this.ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.id) {
				const p = this.pending.get(msg.id);
				if (p) {
					this.pending.delete(msg.id);
					msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
				}
			}
		};
	}
	send(method, params = {}) {
		const id = ++this.id;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}
}

async function evalJs(cdp, expression) {
	const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
	if (r.exceptionDetails) return null;
	return r.result && r.result.value;
}

function httpGet(url, cookie) {
	return new Promise((resolve) => {
		https
			.get(url, { headers: { "User-Agent": "Mozilla/5.0", ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
				let d = "";
				res.on("data", (c) => (d += c));
				res.on("end", () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
			})
			.on("error", (e) => resolve({ error: e.message }));
	});
}

async function main() {
	console.log("[1/4] 连接 Chrome", PORT);
	let targets = null;
	for (let i = 0; i < 30; i++) {
		try {
			targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
			if (targets && targets.some((t) => t.type === "page")) break;
		} catch (e) {
			/* retry */
		}
		await sleep(400);
	}
	const page = targets && targets.find((t) => t.type === "page");
	if (!page) {
		console.error("未找到 Chrome 页面, 请启动调试端口 " + PORT);
		process.exit(2);
	}
	const cdp = new CDP(page.webSocketDebuggerUrl);
	await cdp.open();
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");
	await cdp.send("Network.enable");

	// 记录运行前的旧 session, 用于区分"本轮新登录"与"历史遗留 cookie"
	const preSession = await readSession(cdp);
	console.log(preSession ? `[i] 运行前已有旧 session: ${preSession.value.slice(0, 16)}...` : "[i] 运行前无 session");

	console.log("[2/4] 打开 qrconnect 并截取二维码");
	await cdp.send("Page.navigate", { url: QR_URL });
	let qrRect = null;
	let uuid = null;
	for (let i = 0; i < 24; i++) {
		await sleep(500);
		const obj = await evalJs(
			cdp,
			`(()=>{const els=Array.from(document.querySelectorAll('img[src*="/qrcode/"]'));let b=null;for(const el of els){const r=el.getBoundingClientRect();if(r.width>50&&(!b||r.width>b.w))b={x:r.x,y:r.y,w:r.width,h:r.height,src:el.src};}return b;})()`
		);
		if (obj && obj.w > 100) {
			qrRect = obj;
			const mu = /qrcode\/([A-Za-z0-9_\-]+)/.exec(obj.src || "");
			if (mu) uuid = mu[1];
			break;
		}
	}
	if (!qrRect || !uuid) {
		console.error("二维码未渲染");
		process.exit(3);
	}
	const shot = await cdp.send("Page.captureScreenshot", {
		format: "png",
		clip: { x: qrRect.x, y: qrRect.y, width: qrRect.w, height: qrRect.h, scale: 2 },
	});
	fs.writeFileSync(QR_OUT, Buffer.from(shot.data, "base64"));
	console.log(`二维码: ${QR_OUT} uuid=${uuid} —— 请用微信扫码并在手机确认`);

	console.log(`[3/4] 双重检测扫码结果(最长 ${WAIT_MIN} 分钟)`);
	const deadline = Date.now() + WAIT_MIN * 60 * 1000;
	let last = -1;
	let scanned = false;
	while (Date.now() < deadline) {
		await sleep(1500);

		// 检测A: 页面自身跳转到 hjfy.top 回调
		const href = await evalJs(cdp, "location.href");
		if (href && /hjfy\.top\/api\/login\/callback\/wechat/.test(href)) {
			console.log("检测A: 页面已跳转到回调");
			return await finishLogin(cdp, null, preSession, href);
		}

		// 检测B: 用浏览器 cookie 从外部轮询 lp 接口
		try {
			const cks = await cdp.send("Network.getCookies", {
				urls: ["https://open.weixin.qq.com/", "https://lp.open.weixin.qq.com/"],
			});
			const cookieStr = (cks.cookies || [])
				.map((c) => `${c.name}=${c.value}`)
				.join("; ");
			const lastParam = scanned ? "&last=404" : "";
			const r = await httpGet(
				`https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${uuid}${lastParam}&_=${Date.now()}000`,
				cookieStr
			);
			const poll = parsePollResponse(r.body || "");
			if (poll) {
				const { code, wxCode } = poll;
				if (isScanned(poll)) scanned = true;
				if (code !== last) {
					const label = code === 408 && scanned ? STATE[404] : STATE[code] || "未知";
					console.log(`[${new Date().toTimeString().slice(0, 8)}] errcode=${code} ${label}${wxCode ? " code=" + wxCode : ""}`);
					last = code;
				}
				if (isAuthorizationSuccess(poll)) {
					console.log("检测B: 拿到授权码");
					return await finishLogin(cdp, wxCode, preSession);
				}
				if (code === 405 && !wxCode) {
					console.log("检测B: 微信返回确认成功但缺少授权码，继续等待页面回调");
				}
				if (isTerminalFailure(poll)) {
					if (code === 403) {
						console.log("用户已在手机端取消授权");
						process.exit(3);
					}
					// 页面自身也在轮询，授权码可能已被页面消费；退出前回读一次新 session。
					console.log("检测B: uuid 返回", code, "，先检查页面回调是否已完成");
					const ok = await tryFinishAfterTerminal(cdp, href, preSession);
					if (ok) process.exit(0);
					console.log(STATE[code] || "二维码登录失败", "，需重新运行");
					process.exit(3);
				}
			}
		} catch (e) {
			/* 检测B失败不影响检测A */
		}
	}
	console.log("超时未完成");
	process.exit(1);
}

async function readSession(cdp) {
	const cks = await cdp.send("Network.getCookies", { urls: ["https://hjfy.top/"] });
	return (cks.cookies || []).find((c) => c.name === "session") || null;
}

/** 终态返回时，判断页面轮询是否已经完成了回调并写入新 session。 */
async function tryFinishAfterTerminal(cdp, href, preSession) {
	console.log("  当前页面地址:", href);
	const callbackHref = typeof href === "string" && /[?&]code=[^&]+/.test(href);
	const result = await waitForSession(cdp, preSession, 6000);
	if (!result.session) {
		console.log("  未检测到 session, 确认未完成");
		return false;
	}
	if (!result.changed && !callbackHref) {
		console.log("  检测到的是运行前的旧 session（本轮未产生新登录）");
		return false;
	}
	const user = await verifySession(result.session.value);
	if (!user) {
		console.log("  session 未通过 userinfo 校验");
		return false;
	}
	console.log("回读确认: 本轮微信扫码登录已完成 -> SESSION_OK", result.session.value);
	console.log("userinfo:", JSON.stringify(user).slice(0, 160));
	return true;
}

async function waitForSession(cdp, preSession, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		last = await readSession(cdp);
		if (last && (!preSession || last.value !== preSession.value)) {
			return { session: last, changed: true };
		}
		await sleep(300);
	}
	return { session: last, changed: false };
}

async function verifySession(value) {
	const ui = await httpGet("https://hjfy.top/api/userinfo", `session=${value}`);
	try {
		const parsed = JSON.parse(ui.body || "");
		return parsed && parsed.login ? parsed : null;
	} catch (e) {
		return null;
	}
}

async function finishLogin(cdp, wxCode, preSession, callbackHref = "") {
	if (wxCode) {
		console.log("[4/4] 导航到回调完成登录");
		await cdp.send("Page.navigate", {
			url: `https://hjfy.top/api/login/callback/wechat?code=${encodeURIComponent(wxCode)}&state=HJFYTEST`,
		});
		await sleep(500);
	}
	const result = await waitForSession(cdp, preSession, 10000);
	if (!result.session) {
		const cks = await cdp.send("Network.getCookies", { urls: ["https://hjfy.top/"] });
		console.error("未找到 session cookie:", (cks.cookies || []).map((c) => c.name).join(","));
		const dc = await evalJs(cdp, "document.cookie");
		console.log("document.cookie:", dc);
		process.exit(4);
	}
	if (!result.changed && !callbackHref && !wxCode) {
		console.error("回调后 session 未变化, 未确认本轮登录");
		process.exit(4);
	}
	const user = await verifySession(result.session.value);
	if (!user) {
		console.error("session 存在但 userinfo 未确认 login:true");
		process.exit(4);
	}
	if (!result.changed) console.log("提示: 服务端沿用了原 session，但授权码/回调已确认");
	console.log("SESSION_OK", result.session.value);
	console.log("userinfo:", JSON.stringify(user).slice(0, 160));
	process.exit(0);
}

main().catch((e) => {
	console.error("出错:", e.message);
	process.exit(1);
});
