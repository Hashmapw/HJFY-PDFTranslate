#!/usr/bin/env node
/*
 * HJFY-PDFTranslate / tools/wechat_chrome.js
 * 真实浏览器(CDP) 微信扫码登录——稳健版:
 *   - 二维码由 headless Chrome 完整渲染, 截图为 PNG 供用户扫描
 *   - 轮询微信状态(在页面上下文内用 fetch, 携带浏览器 cookie), 不依赖页面自身跳转
 *   - 拿到授权码后, 主动导航到 hjfy.top 回调, 读取 session 并验证
 * 前置: 本机已启动 chrome:
 *   google-chrome --headless=new --no-sandbox --remote-debugging-port=9333 --user-data-dir=<dir> about:blank
 * 用法: node tools/wechat_chrome.js [等待分钟数=10]
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
const WAIT_MIN = parseInt(process.argv[2] || "10", 10);

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
			this.ws.onerror = (e) => rej(new Error("ws error"));
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

async function evalJs(cdp, expression, awaitPromise = false) {
	const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
	if (r.exceptionDetails) return null;
	return r.result && r.result.value;
}

async function main() {
	console.log("[1/5] 连接 Chrome", PORT);
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
		console.error("未找到 Chrome 页面, 请先启动调试端口 " + PORT);
		process.exit(2);
	}
	const cdp = new CDP(page.webSocketDebuggerUrl);
	await cdp.open();
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");
	await cdp.send("Network.enable");
	const preSession = await readSession(cdp);
	console.log(preSession ? `[i] 运行前已有旧 session: ${preSession.value.slice(0, 16)}...` : "[i] 运行前无 session");

	console.log("[2/5] 打开 qrconnect 页面并截取二维码");
	await cdp.send("Page.navigate", { url: QR_URL });
	let qrRect = null;
	let uuid = null;
	for (let i = 0; i < 24; i++) {
		await sleep(500);
		const obj = await evalJs(
			cdp,
			`(()=>{
				const els=Array.from(document.querySelectorAll('img[src*="/qrcode/"]'));
				let best=null;
				for(const el of els){
					const r=el.getBoundingClientRect();
					if(r.width>50 && (!best || r.width>best.w)) best={x:r.x,y:r.y,w:r.width,h:r.height,src:el.src};
				}
				return best;
			})()`
		);
		if (obj && obj.w > 100) {
			qrRect = obj;
			const mu = /qrcode\/([A-Za-z0-9_\-]+)/.exec(obj.src || "");
			if (mu) uuid = mu[1];
			break;
		}
	}
	if (!qrRect || !uuid) {
		console.error("二维码未渲染或未取到 uuid");
		process.exit(3);
	}
	const shot = await cdp.send("Page.captureScreenshot", {
		format: "png",
		clip: { x: qrRect.x, y: qrRect.y, width: qrRect.w, height: qrRect.h, scale: 2 },
	});
	fs.writeFileSync(QR_OUT, Buffer.from(shot.data, "base64"));
	console.log(`二维码已保存: ${QR_OUT} (${Math.round(qrRect.w)}x${Math.round(qrRect.h)}) uuid=${uuid}`);
	console.log("请用微信扫一扫并点「确认登录」");

	console.log(`[3/5] 页面上下文内轮询微信状态(最长 ${WAIT_MIN} 分钟)`);
	const deadline = Date.now() + WAIT_MIN * 60 * 1000;
	let last = -1;
	let scanned = false;
	while (Date.now() < deadline) {
		await sleep(1200);
		const lastParam = scanned ? "&last=404" : "";
		const text = await evalJs(
			cdp,
			`fetch('https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${uuid}${lastParam}&_='+Date.now()).then(r=>r.text())`,
			true
		);
		if (!text) continue;
		const poll = parsePollResponse(text);
		if (!poll) {
			console.log("(格式异常)", text.slice(0, 100));
			continue;
		}
		const { code, wxCode } = poll;
		if (isScanned(poll)) scanned = true;
		if (code !== last) {
			const label = code === 408 && scanned ? STATE[404] : STATE[code] || "未知";
			console.log(`[${new Date().toTimeString().slice(0, 8)}] errcode=${code} ${label}${wxCode ? " code=" + wxCode : ""}`);
			last = code;
		}
		if (isAuthorizationSuccess(poll)) {
			console.log("[4/5] 授权码已确认");
			return await completeLogin(cdp, wxCode, preSession);
		}
		if (code === 405 && !wxCode) {
			console.log("微信返回确认成功但未携带授权码，继续等待页面回调");
		}
		if (isTerminalFailure(poll)) {
			if (code === 403) {
				console.log("用户已在手机端取消授权");
				process.exit(3);
			}
			const href = await evalJs(cdp, "location.href");
			const ok = await tryFinishAfterTerminal(cdp, href, preSession);
			if (ok) process.exit(0);
			console.log(STATE[code] || "二维码登录失败", "，需重新运行");
			process.exit(3);
		}
	}
	console.log("超时未完成");
	process.exit(1);
}

async function readSession(cdp) {
	const cks = await cdp.send("Network.getCookies", { urls: ["https://hjfy.top/"] });
	return (cks.cookies || []).find((c) => c.name === "session") || null;
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

function getUserInfo(sessionValue) {
	return new Promise((resolve) => {
		https
			.get(
				"https://hjfy.top/api/userinfo",
				{ headers: { "User-Agent": "Mozilla/5.0", Cookie: `session=${sessionValue}` } },
				(res) => {
					let body = "";
					res.on("data", (chunk) => (body += chunk));
					res.on("end", () => {
						try {
							const parsed = JSON.parse(body);
							resolve(parsed && parsed.login ? parsed : null);
						} catch (e) {
							resolve(null);
						}
					});
				}
			)
			.on("error", () => resolve(null));
	});
}

async function tryFinishAfterTerminal(cdp, href, preSession) {
	const result = await waitForSession(cdp, preSession, 6000);
	const currentHref = (await evalJs(cdp, "location.href")) || href || "";
	const callbackReached = /hjfy\.top\/api\/login\/callback\/wechat/.test(currentHref) && /[?&]code=[^&]+/.test(currentHref);
	if (!result.session || (!result.changed && !callbackReached)) return false;
	const user = await getUserInfo(result.session.value);
	if (!user) return false;
	console.log("回读确认: 页面已完成微信回调 -> SESSION_OK", result.session.value);
	console.log("userinfo:", JSON.stringify(user).slice(0, 160));
	return true;
}

async function completeLogin(cdp, wxCode, preSession) {
	// 在浏览器内导航到 hjfy.top 回调(与微信跳转一致), 让站点种 session cookie。
	await cdp.send("Page.navigate", {
		url: `https://hjfy.top/api/login/callback/wechat?code=${encodeURIComponent(wxCode)}&state=HJFYTEST`,
	});
	console.log("[5/5] 读取并验证 hjfy.top 会话 cookie");
	const result = await waitForSession(cdp, preSession, 10000);
	if (!result.session) {
		console.error("回调后未找到 session cookie");
		process.exit(4);
	}
	const user = await getUserInfo(result.session.value);
	if (!user) {
		console.error("session 存在但 userinfo 未确认 login:true");
		process.exit(4);
	}
	if (!result.changed) console.log("提示: 服务端沿用了原 session，但授权码已确认");
	console.log("SESSION_OK", result.session.value);
	console.log("userinfo:", JSON.stringify(user).slice(0, 160));
	process.exit(0);
}

main().catch((e) => {
	console.error("出错:", e.message);
	process.exit(1);
});
