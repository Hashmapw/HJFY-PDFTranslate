/*
 * HJFY-PDFTranslate / content/scripts/core.js
 * Pure logic: arXiv parsing, validated hjfy.top API contracts, and polling flows.
 */
(function (root, factory) {
	if (typeof module !== "undefined" && module.exports) {
		module.exports = factory();
	} else {
		root.HJFYCore = factory();
	}
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	const BASE = "https://hjfy.top";
	const TASK_STATES = Object.freeze(["init", "start", "processing", "finished", "failed", "error", "fault"]);
	const TERMINAL_FAIL = new Set(["failed", "error", "fault"]);
	const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	class ContractError extends Error {
		constructor(endpoint, detail, response) {
			const excerpt = responseExcerpt(response);
			super(`${endpoint} 接口契约不匹配: ${detail}${excerpt ? ` | 响应: ${excerpt}` : ""}`);
			this.name = "HJFYContractError";
			this.endpoint = endpoint;
			this.responseExcerpt = excerpt;
		}
	}

	function responseExcerpt(value) {
		if (value === undefined || value === null) return "";
		let text;
		try {
			text = typeof value === "string"
				? value
				: value && typeof value.message === "string"
					? value.message
					: JSON.stringify(value);
		} catch (e) {
			text = String(value);
		}
		return text.replace(/\s+/g, " ").slice(0, 240);
	}

	function isArxivInfoAvailabilityError(value) {
		if (!value || typeof value !== "object") return false;
		const status = Number(value.status);
		if (Number.isFinite(status) && status >= 500) return true;
		return value.name === "HJFYRequestError" && status === 0;
	}

	function normalizeArxivId(value) {
		let candidate = String(value || "").trim().replace(/^arxiv:/i, "");
		candidate = candidate.replace(/[?#].*$/, "").replace(/\/$/, "").replace(/\.pdf$/i, "");
		const modern = /^(\d{4}\.\d{4,5})(v\d+)?$/i.exec(candidate);
		if (modern) return modern[1] + (modern[2] || "");
		const legacy = /^([a-z][a-z.\-]*\/\d{4,7})(v\d+)?$/i.exec(candidate);
		if (legacy) return legacy[1] + (legacy[2] || "");
		return null;
	}

	function parseArxivId(input) {
		if (!input) return null;
		const source = String(input).trim();
		if (/^https?:\/\//i.test(source)) {
			try {
				const parsed = new URL(source);
				const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
				if (!["arxiv.org", "export.arxiv.org", "alphaxiv.org"].includes(host)) return null;
				const match = /^\/(?:abs|pdf)\/(.+?)\/?$/i.exec(parsed.pathname);
				return match ? normalizeArxivId(decodeURIComponent(match[1])) : null;
			} catch (e) {
				return null;
			}
		}
		return normalizeArxivId(source);
	}

	function validateEnvelope(endpoint, response, validateData) {
		if (!response || typeof response !== "object" || Array.isArray(response)) {
			throw new ContractError(endpoint, "响应不是 JSON 对象", response);
		}
		if (!Number.isFinite(response.status)) {
			throw new ContractError(endpoint, "缺少数值 status", response);
		}
		if (response.status !== 0) return response;
		if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
			throw new ContractError(endpoint, "status=0 但缺少 data 对象", response);
		}
		validateData(response.data, response);
		return response;
	}

	function validateStatusResponse(endpoint, response, validateSuccess) {
		if (!response || typeof response !== "object" || Array.isArray(response)) {
			throw new ContractError(endpoint, "响应不是 JSON 对象", response);
		}
		if (!Number.isFinite(response.status)) {
			throw new ContractError(endpoint, "缺少数值 status", response);
		}
		if (response.status === 0 && validateSuccess) validateSuccess(response);
		return response;
	}

	function requireField(endpoint, data, field, type, response) {
		if (typeof data[field] !== type) {
			throw new ContractError(endpoint, `data.${field} 应为 ${type}`, response);
		}
	}

	function createApi(requestFn) {
		if (typeof requestFn !== "function") throw new TypeError("requestFn must be a function");
		const call = async (endpoint, method, path, body, validator) => {
			const response = await requestFn(method, BASE + path, body);
			return validator(response, endpoint);
		};
		const envelope = (dataValidator) => (response, endpoint) =>
			validateEnvelope(endpoint, response, (data) => dataValidator(endpoint, data, response));
		const statusValidator = envelope((endpoint, data, response) => {
			requireField(endpoint, data, "status", "string", response);
			if (!TASK_STATES.includes(data.status)) {
				throw new ContractError(endpoint, `未知任务状态 ${data.status}`, response);
			}
		});
		const filesValidator = envelope((endpoint, data, response) => {
			requireField(endpoint, data, "zhCN", "string", response);
		});

		return {
			arxivInfo: (id) => call("arxivInfo", "GET", `/api/arxivInfo/${encodeURIComponent(id)}`, null,
				envelope((endpoint, data, response) => requireField(endpoint, data, "hasSrc", "boolean", response))),
			arxivStatus: (id) => call("arxivStatus", "GET", `/api/arxivStatus/${encodeURIComponent(id)}`, null, statusValidator),
			arxivFiles: (id) => call("arxivFiles", "GET", `/api/arxivFiles/${encodeURIComponent(id)}`, null, filesValidator),
			fileStatus: (key) => call("fileStatus", "GET", `/api/fileStatus/${encodeURIComponent(key)}`, null, statusValidator),
			fileFiles: (key) => call("fileFiles", "GET", `/api/fileFiles/${encodeURIComponent(key)}`, null, filesValidator),
			uploadFiles: (body) => call("uploadFiles", "POST", "/api/uploadFiles", body, (response, endpoint) => {
				const validated = validateStatusResponse(endpoint, response, (success) => {
					const fileKey = success.fileKey || (success.data && success.data.fileKey);
					if (typeof success.arxivId !== "string" && typeof fileKey !== "string") {
						throw new ContractError(endpoint, "成功响应缺少 fileKey 或 arxivId", success);
					}
				});
				if (validated.status === 302 && typeof validated.arxivId !== "string") {
					throw new ContractError(endpoint, "status=302 但缺少 arxivId", validated);
				}
				return validated;
			}),
			sendCode: (phone, captchaVerifyParam) => call("sendCode", "POST", "/api/sendCode", {
				headers: { "Content-Type": "application/json" },
				payload: JSON.stringify({ phone, captchaVerifyParam }),
			}, (response, endpoint) => validateStatusResponse(endpoint, response)),
			phoneLogin: (phone, code) => call("phoneLogin", "POST", "/api/phoneLogin", {
				headers: { "Content-Type": "application/json" },
				payload: JSON.stringify({ phone, code }),
			}, (response, endpoint) => validateStatusResponse(endpoint, response, (success) => {
				if (!success.data || typeof success.data.session !== "string") {
					throw new ContractError(endpoint, "成功响应缺少 data.session", success);
				}
			})),
			logout: () => call("logout", "POST", "/api/logout", null,
				(response, endpoint) => validateStatusResponse(endpoint, response)),
			userinfo: () => call("userinfo", "GET", "/api/userinfo", null, (response, endpoint) => {
				if (!response || typeof response !== "object" || typeof response.login !== "boolean") {
					throw new ContractError(endpoint, "缺少布尔 login", response);
				}
				return response;
			}),
		};
	}

	async function flowArxiv(api, arxivId, opts) {
		const options = opts || {};
		let infoFailure = null;
		try {
			const info = await api.arxivInfo(arxivId);
			if (info.status !== 0) {
				if (!isArxivInfoAvailabilityError(info)) {
					return { stage: "info_error", msg: info.msg || responseExcerpt(info) };
				}
				infoFailure = info;
			} else if (!info.data.hasSrc) {
				return { stage: "no_src", msg: "该论文没有提供 LaTeX 源码，无法翻译", data: info.data };
			}
		} catch (error) {
			if (!isArxivInfoAvailabilityError(error)) throw error;
			infoFailure = error;
		}
		if (infoFailure && options.onInfoError) options.onInfoError(infoFailure);

		const onStatus101 = async () => {
			if (options.allowVersionFallback !== false) {
				const plain = arxivId.replace(/v\d+$/i, "");
				if (plain !== arxivId) {
					const alternate = await api.arxivStatus(plain);
					if (alternate.status === 0 && alternate.data.status === "finished") {
						return { stage: "finished_via_plain", plainId: plain, files: (await api.arxivFiles(plain)).data };
					}
				}
			}
			const user = await api.userinfo();
			if (user.login) {
				return { stage: "not_started", msg: "账号已登录，但服务端尚未创建该论文的翻译任务" };
			}
			return null;
		};

		const result = await pollStatus(() => api.arxivStatus(arxivId), {
			pollInterval: options.pollInterval || 10000,
			maxWaitMs: options.maxWaitMs,
			onStatus: options.onStatus,
			wait: options.wait,
			onFinished: async () => api.arxivFiles(arxivId),
			onFailed: options.onFailed,
			onStatus101,
			fallbackCheck: async () => {
				const plain = arxivId.replace(/v\d+$/i, "");
				if (plain === arxivId) return null;
				const alternate = await api.arxivStatus(plain);
				if (alternate.status === 0 && alternate.data.status === "finished") {
					return { altStatus: alternate.data, plain, files: await api.arxivFiles(plain) };
				}
				return null;
			},
		});
		return infoFailure ? Object.assign({}, result, { infoFallback: true }) : result;
	}

	async function flowFile(api, fileKey, opts) {
		const options = opts || {};
		return pollStatus(() => api.fileStatus(fileKey), {
			pollInterval: options.pollInterval || 10000,
			maxWaitMs: options.maxWaitMs,
			onStatus: options.onStatus,
			wait: options.wait,
			onFinished: async () => api.fileFiles(fileKey),
			onFailed: options.onFailed,
		});
	}

	async function pollStatus(fetchStatus, ctx) {
		const startedAt = Date.now();
		const maxWaitMs = Number.isFinite(ctx.maxWaitMs) ? ctx.maxWaitMs : 15 * 60 * 1000;
		for (;;) {
			const statusResponse = await fetchStatus();
			if (!statusResponse) return { stage: "http_error", msg: "网络请求失败" };
			if (statusResponse.status === 101) {
				if (ctx.onStatus101) {
					const resolved = await ctx.onStatus101(statusResponse);
					if (resolved) return resolved;
				}
				return { stage: "need_login", msg: statusResponse.msg || "需要登录" };
			}
			if (statusResponse.status !== 0) {
				return { stage: "api_error", msg: responseExcerpt(statusResponse) };
			}

			const data = statusResponse.data;
			const state = data.status;
			if (ctx.onStatus) ctx.onStatus(state, data);
			if (state === "finished") {
				const files = await ctx.onFinished();
				return { stage: "finished", data, files: files.data || files };
			}
			if (TERMINAL_FAIL.has(state)) {
				if (ctx.fallbackCheck) {
					const fallback = await ctx.fallbackCheck(data);
					if (fallback) {
						return {
							stage: "finished_via_plain",
							alt: fallback.altStatus,
							files: fallback.files.data || fallback.files,
							plainId: fallback.plain,
						};
					}
				}
				if (ctx.onFailed) ctx.onFailed(state, data);
				return { stage: state, data };
			}
			if (!ctx.wait) return { stage: state, data };
			if (Date.now() - startedAt >= maxWaitMs) {
				return { stage: "timeout", msg: `等待翻译超过 ${Math.round(maxWaitMs / 60000)} 分钟`, data };
			}
			await SLEEP(ctx.pollInterval);
		}
	}

	return {
		BASE,
		TASK_STATES,
		ContractError,
		responseExcerpt,
		parseArxivId,
		createApi,
		flowArxiv,
		flowFile,
		pollStatus,
	};
});
