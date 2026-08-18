/*
 * HJFY-PDFTranslate / content/scripts/core.js
 * 纯逻辑层：arXiv ID 解析 + hjfy.top API 封装 + 翻译流程编排。
 * 不依赖 Zotero：通过注入的 requestFn 发请求，可在 Node 里直接测试。
 * （Zotero 环境由 plugin.js 注入基于 Zotero.HTTP 的 requestFn）
 */
(function (root, factory) {
	if (typeof module !== "undefined" && module.exports) {
		module.exports = factory(); // Node 测试
	} else {
		root.HJFYCore = factory();
	}
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	const BASE = "https://hjfy.top";

	// ---------------- arXiv ID 解析 ----------------
	// 新式: 2506.17310 / 2506.17310v2 / 2506.17310.pdf
	const RE_NEW = /^(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/;
	// 旧式: cs.LG/2506.17310 / cs/0501001 / cs/0501001v1
	const RE_OLD = /^([a-zA-Z][a-zA-Z.\-]*\/\d{4,7})(?:v\d+)?(?:\.pdf)?$/;
	// URL: arxiv.org / alphaxiv.org 的 abs|pdf 页面
	const RE_URL =
		/https?:\/\/(?:www\.)?(?:arxiv|alphaxiv)\.org\/(?:abs|pdf)\/([a-zA-Z0-9.\-\/]+?)(?:v\d+)?(?:\.pdf)?\/?$/i;

	function parseArxivId(input) {
		if (!input) return null;
		let s = String(input).trim();
		let m = RE_URL.exec(s);
		if (m) return m[1].replace(/\/$/, "");
		// 兜底: 从 URL 末尾取一段
		if (/^https?:/i.test(s)) {
			s = s.replace(/\/$/, "").split("/").pop();
		}
		if (RE_NEW.test(s)) return s;
		m = RE_OLD.exec(s);
		if (m) return m[1];
		return null;
	}

	// ---------------- API 对象 ----------------
	// requestFn(method, url, body?) -> Promise<JSON>
	function createApi(requestFn) {
		const get = (url) => requestFn("GET", url);
		return {
			// 论文元数据: {status:0, data:{hasSrc, meta}}
			arxivInfo: (id) => get(`${BASE}/api/arxivInfo/${encodeURIComponent(id)}`),
			// 任务状态: {status:0, data:{status,info}} | {status:101,msg:"required login"}
			arxivStatus: (id) => get(`${BASE}/api/arxivStatus/${encodeURIComponent(id)}`),
			// 文件直链: {status:0, data:{id,title,origin,zhCN,zhCNTar,isDeepSeek}}
			arxivFiles: (id) => get(`${BASE}/api/arxivFiles/${encodeURIComponent(id)}`),
			// 上传文档任务
			fileStatus: (key) => get(`${BASE}/api/fileStatus/${encodeURIComponent(key)}`),
			fileFiles: (key) => get(`${BASE}/api/fileFiles/${encodeURIComponent(key)}`),
			// 上传 PDF: body 由调用方构造 multipart (field: file)
			uploadFiles: (body) => requestFn("POST", `${BASE}/api/uploadFiles`, body),
			// 登录态: {login:bool, nickname}
			userinfo: () => get(`${BASE}/api/userinfo`),
		};
	}

	// ---------------- 流程编排 ----------------
	// 统一状态: init/start/processing/finished/failed/error/fault
	// status:101 -> need_login
	const TERMINAL_FAIL = ["failed", "error", "fault"];
	const SLEEP = (ms) => new Promise((res) => setTimeout(res, ms));

	/**
	 * arXiv 翻译流程: info -> status(轮询) -> files
	 * @returns {Promise<{stage:string, msg?:string, data?:object, files?:object}>}
	 *   stage: info_error | no_src | need_login | finished | finished_via_plain |
	 *          failed | error | fault | init | start | processing
	 */
	async function flowArxiv(api, arxivId, opts) {
		const o = opts || {};
		const pollInterval = o.pollInterval || 10000;

		const info = await api.arxivInfo(arxivId);
		if (!info || info.status !== 0) return { stage: "info_error", msg: (info && info.msg) || "arxivInfo 查询失败" };
		if (!info.data || !info.data.hasSrc) {
			return { stage: "no_src", msg: "该论文没有提供 LaTeX 源码，无法翻译", data: info.data };
		}

		// 101(未登录/未建任务)时: 若带版本号, 先查无版本号任务是否已完成
		const onNeedLogin = async () => {
			const plain = arxivId.replace(/v\d+$/, "");
			if (plain === arxivId) return null;
			const alt = await api.arxivStatus(plain);
			if (alt && alt.status === 0 && alt.data && alt.data.status === "finished") {
				return { stage: "finished_via_plain", plainId: plain, files: (await api.arxivFiles(plain)).data };
			}
			return null;
		};

		return await pollStatus(() => api.arxivStatus(arxivId), {
			pollInterval,
			onStatus: o.onStatus,
			wait: o.wait,
			onFinished: async () => api.arxivFiles(arxivId),
			onFailed: o.onFailed,
			onNeedLogin: o.allowVersionFallback !== false ? onNeedLogin : null,
			fallbackCheck: async (status) => {
				// 带版本号失败时, 查无版本号任务是否已完成
				const plain = arxivId.replace(/v\d+$/, "");
				if (plain === arxivId) return null;
				const alt = await api.arxivStatus(plain);
				if (alt && alt.status === 0 && alt.data && alt.data.status === "finished") {
					return { altStatus: alt.data, plain, files: await api.arxivFiles(plain) };
				}
				return null;
			},
		});
	}

	/**
	 * 上传文档翻译流程: 轮询 fileStatus -> fileFiles
	 */
	async function flowFile(api, fileKey, opts) {
		return await pollStatus(() => api.fileStatus(fileKey), {
			pollInterval: (opts && opts.pollInterval) || 10000,
			onStatus: opts && opts.onStatus,
			wait: opts && opts.wait,
			onFinished: async () => api.fileFiles(fileKey),
			onFailed: opts && opts.onFailed,
		});
	}

	/**
	 * 通用任务轮询器
	 */
	async function pollStatus(fetchStatus, ctx) {
		for (;;) {
			const st = await fetchStatus();
			if (!st) return { stage: "http_error", msg: "网络请求失败" };
			if (st.status === 101) {
				if (ctx.onNeedLogin) {
					const fb = await ctx.onNeedLogin();
					if (fb) return fb;
				}
				return { stage: "need_login", msg: st.msg || "需要登录" };
			}
			if (st.status !== 0) return { stage: "api_error", msg: JSON.stringify(st) };

			const data = st.data || {};
			const s = data.status || "";
			if (ctx.onStatus) ctx.onStatus(s, data);
			ctx.lastStatus = data;

			if (s === "finished") {
				const files = await ctx.onFinished();
				return { stage: "finished", data, files: files && files.data ? files.data : files };
			}
			if (TERMINAL_FAIL.includes(s)) {
				if (ctx.fallbackCheck) {
					const fb = await ctx.fallbackCheck(data);
					if (fb) return { stage: "finished_via_plain", alt: fb.altStatus, files: fb.files ? fb.files.data : fb.files, plainId: fb.plain };
				}
				if (ctx.onFailed) ctx.onFailed(s, data);
				return { stage: s, data };
			}
			// init/start/processing
			if (!ctx.wait) return { stage: s, data };
			await SLEEP(ctx.pollInterval);
		}
	}

	return {
		BASE,
		parseArxivId,
		createApi,
		flowArxiv,
		flowFile,
	};
});
