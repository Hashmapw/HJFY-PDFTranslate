"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Core = require("../content/scripts/core");

test("parses query-bearing and export.arxiv.org URLs", () => {
	assert.equal(Core.parseArxivId("https://arxiv.org/pdf/2602.09021v2.pdf?download=1#page=2"), "2602.09021v2");
	assert.equal(Core.parseArxivId("https://export.arxiv.org/abs/cs/0501001v1?context=cs"), "cs/0501001v1");
	assert.equal(Core.parseArxivId("https://example.com/abs/2602.09021"), null);
});

test("validates API response contracts and includes a response excerpt", async () => {
	const api = Core.createApi(async () => ({ status: 0, data: { hasSrc: "yes" } }));
	await assert.rejects(
		api.arxivInfo("2602.09021"),
		(error) => error.name === "HJFYContractError" && /data\.hasSrc/.test(error.message) && /\"yes\"/.test(error.message)
	);
});

test("validates both upload success response shapes", async () => {
	const fileApi = Core.createApi(async () => ({ status: 0, data: { fileKey: "file-key" } }));
	assert.equal((await fileApi.uploadFiles({})).data.fileKey, "file-key");

	const arxivApi = Core.createApi(async () => ({ status: 302, arxivId: "2602.09021" }));
	assert.equal((await arxivApi.uploadFiles({})).arxivId, "2602.09021");

	const invalidApi = Core.createApi(async () => ({ status: 302, msg: "detected" }));
	await assert.rejects(
		invalidApi.uploadFiles({}),
		(error) => error.name === "HJFYContractError" && /status=302.*arxivId/.test(error.message)
	);
});

test("distinguishes status 101 for logged-in and logged-out users", async () => {
	const responses = {
		arxivInfo: { status: 0, data: { hasSrc: true } },
		arxivStatus: { status: 101, msg: "required login" },
	};
	const makeApi = (login) => ({
		arxivInfo: async () => responses.arxivInfo,
		arxivStatus: async () => responses.arxivStatus,
		userinfo: async () => ({ login }),
	});
	assert.equal((await Core.flowArxiv(makeApi(false), "2602.09021", {})).stage, "need_login");
	assert.equal((await Core.flowArxiv(makeApi(true), "2602.09021", {})).stage, "not_started");
});

test("falls back to finished task files when arxivInfo returns HTTP 5xx", async () => {
	const calls = [];
	const requestError = new Error("upstream socket closed");
	requestError.name = "HJFYRequestError";
	requestError.status = 500;
	let observedError = null;
	const result = await Core.flowArxiv({
		arxivInfo: async () => {
			calls.push("info");
			throw requestError;
		},
		arxivStatus: async () => {
			calls.push("status");
			return { status: 0, data: { status: "finished" } };
		},
		arxivFiles: async () => {
			calls.push("files");
			return { status: 0, data: { zhCN: "https://example.com/translated.pdf" } };
		},
	}, "2405.14867", {
		onInfoError: (error) => {
			observedError = error;
		},
	});

	assert.equal(result.stage, "finished");
	assert.equal(result.infoFallback, true);
	assert.equal(result.files.zhCN, "https://example.com/translated.pdf");
	assert.equal(observedError, requestError);
	assert.deepEqual(calls, ["info", "status", "files"]);
});

test("falls back when arxivInfo returns a server-error envelope", async () => {
	const result = await Core.flowArxiv({
		arxivInfo: async () => ({ status: 500, msg: "upstream unavailable" }),
		arxivStatus: async () => ({ status: 0, data: { status: "finished" } }),
		arxivFiles: async () => ({ status: 0, data: { zhCN: "https://example.com/translated.pdf" } }),
	}, "2311.18828", {});

	assert.equal(result.stage, "finished");
	assert.equal(result.infoFallback, true);
});

test("does not hide non-server arxivInfo failures", async () => {
	const requestError = new Error("not authorized");
	requestError.name = "HJFYRequestError";
	requestError.status = 401;
	let statusCalled = false;
	await assert.rejects(
		Core.flowArxiv({
			arxivInfo: async () => { throw requestError; },
			arxivStatus: async () => {
				statusCalled = true;
				return { status: 0, data: { status: "finished" } };
			},
		}, "2405.14867", {}),
		(error) => error === requestError
	);
	assert.equal(statusCalled, false);
});

test("polling has a total timeout", async () => {
	const result = await Core.pollStatus(
		async () => ({ status: 0, data: { status: "processing" } }),
		{ wait: true, pollInterval: 1, maxWaitMs: 0 }
	);
	assert.equal(result.stage, "timeout");
});
