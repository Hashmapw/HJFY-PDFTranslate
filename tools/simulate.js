#!/usr/bin/env node
/*
 * HJFY-PDFTranslate / tools/simulate.js
 * 开发用模拟器：用真实 hjfy.top 会话 模拟「新论文翻译」与「上传 PDF 翻译」两条完整链路。
 *
 * 用法:
 *   HJFY_COOKIE="session=xxxx" node tools/simulate.js arxiv 2507.01000
 *   HJFY_COOKIE="session=xxxx" node tools/simulate.js upload ./test.pdf
 *
 * 与 Zotero 插件行为一一对应: core.js 同一流程 + 手工 multipart 上传。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const C = require("../content/scripts/core.js");

// ---------- requestFn: 底层 https，可携带 Cookie（模拟插件 useCookieService） ----------
function rawRequest(method, url, { cookie, headers = {}, body = null } = {}) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const h = { "User-Agent": "HJFY-PDFTranslate-Sim/0.1", ...headers };
		if (cookie) h["Cookie"] = cookie;
		let payload = null;
		if (body) {
			payload = body;
			if (!h["Content-Length"]) h["Content-Length"] = Buffer.byteLength(body);
		}
		const req = https.request(
			u,
			{ method, headers: h, timeout: 60000 },
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					if (res.statusCode >= 400 && res.statusCode !== 302) {
						return resolve({ error: res.statusCode + " " + text.slice(0, 200) });
					}
					try {
						resolve(JSON.parse(text));
					} catch (e) {
						resolve({ raw: text.slice(0, 500), statusCode: res.statusCode });
					}
				});
			}
		);
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error("timeout")));
		if (payload) req.write(payload);
		req.end();
	});
}

// ---------- 构造 multipart（与插件 uploadFile 一致） ----------
function buildMultipart(filePath, fileName) {
	const boundary = "----HJFYBoundary" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
	const fileBytes = fs.readFileSync(filePath);
	const head = Buffer.from(
		`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
			`Content-Type: application/pdf\r\n\r\n`,
		"utf8"
	);
	const tail = Buffer.from(
		`\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${fileName}\r\n--${boundary}--\r\n`,
		"utf8"
	);
	return { boundary, body: Buffer.concat([head, fileBytes, tail]) };
}

function download(url, dest, cookie) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const h = { "User-Agent": "HJFY-PDFTranslate-Sim/0.1" };
		if (cookie) h["Cookie"] = cookie;
		https
			.get(u, { headers: h }, (res) => {
				const out = fs.createWriteStream(dest);
				res.pipe(out);
				out.on("finish", () => {
					out.close();
					const size = fs.statSync(dest).size;
					console.log(`  [ok] 已下载 -> ${dest} (${(size / 1024 / 1024).toFixed(2)} MB)`);
					resolve(dest);
				});
			})
			.on("error", reject);
	});
}

async function main() {
	const [mode, arg2] = process.argv.slice(2);
	const cookie = process.env.HJFY_COOKIE || (fs.existsSync("session.txt") ? fs.readFileSync("session.txt", "utf8").trim() : "");

	if (!cookie) {
		console.error("缺少会话: 设置环境变量 HJFY_COOKIE 或把 session=... 写入 ./session.txt");
		process.exit(2);
	}
	if (!mode || !arg2) {
		console.error("用法: simulate.js arxiv <id> | upload <pdf路径>");
		process.exit(2);
	}

	const requestFn = async (method, url, body) => {
		if (body && body.headers && body.boundary) {
			// uploadFiles 由 upload 流程自己处理
			throw new Error("upload 请走 upload 流程");
		}
		return rawRequest(method, url, { cookie });
	};
	const api = C.createApi(requestFn);

	// 1) 先验证登录
	const u = await api.userinfo();
	console.log("[i] userinfo:", JSON.stringify(u));
	if (!u || !u.login) {
		console.error("[!] 会话无效(未登录)，请重新获取 document.cookie");
		process.exit(2);
	}

	if (mode === "arxiv") {
		const id = arg2;
		console.log(`\n=== 模拟 arXiv 新论文翻译: ${id} ===`);
		const result = await C.flowArxiv(api, id, {
			wait: true,
			pollInterval: 10000,
			onStatus: (status, data) => {
				console.log(`    [${new Date().toTimeString().slice(0, 8)}] 状态=${status}${data.info ? " | " + data.info : ""}`);
			},
		});
		console.log("结果 stage =", result.stage);
		if (result.stage === "need_login") {
			console.log("  需要登录（会话可能无效或未建任务权限）");
			process.exit(1);
		}
		if (result.files && result.files.zhCN) {
			console.log("  标题:", result.files.title);
			console.log("  zhCN 已就绪");
			await download(result.files.zhCN, `./sim-${id}-zh-CN.pdf`, cookie);
			if (result.files.zhCNTar) await download(result.files.zhCNTar, `./sim-${id}-zh-CN.tgz`, cookie);
		} else {
			console.log("  无文件:", JSON.stringify(result).slice(0, 300));
		}
	}

	if (mode === "upload") {
		const fp = arg2;
		const fileName = path.basename(fp);
		console.log(`\n=== 模拟 上传 PDF 翻译: ${fileName} ===`);
		const mb = buildMultipart(fp, fileName);
		const uploadHeaders = { "Content-Type": `multipart/form-data; boundary=${mb.boundary}` };
		const up = await rawRequest("POST", C.BASE + "/api/uploadFiles", { cookie, headers: uploadHeaders, body: mb.body });
		console.log("上传响应:", JSON.stringify(up).slice(0, 300));
		const fileKey = up && up.data && up.data.fileKey;
		if (!fileKey) {
			console.error("  没有得到 fileKey", up);
			process.exit(1);
		}
		const result = await C.flowFile(api, fileKey, {
			wait: true,
			pollInterval: 10000,
			onStatus: (status, data) => {
				console.log(`    [${new Date().toTimeString().slice(0, 8)}] 状态=${status}${data.info ? " | " + data.info : ""}`);
			},
		});
		console.log("结果 stage =", result.stage);
		if (result.files && result.files.zhCN) {
			console.log("  zhCN:", result.files.zhCN.slice(0, 90), "...");
			const ext = /\.pdf($|[?#])/i.test(result.files.zhCN) ? ".pdf" : ".md";
			await download(result.files.zhCN, `./sim-upload-${fileKey}${ext}`, cookie);
		} else {
			console.log("  无文件:", JSON.stringify(result).slice(0, 300));
		}
	}
}

main().catch((e) => {
	console.error("出错:", e.message || e);
	process.exit(1);
});
