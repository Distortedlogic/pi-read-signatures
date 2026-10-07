import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldSignatures } from "../src/fold.ts";
import registerReadSignatures from "../src/index.ts";
import { signatureLanguage } from "../src/languages.ts";

type RegisteredExecute = (...args: unknown[]) => Promise<unknown>;

function registeredExecute(): RegisteredExecute {
	let registeredTool: unknown;
	registerReadSignatures({
		registerTool: (tool: unknown) => {
			registeredTool = tool;
		},
	} as unknown as ExtensionAPI);
	const execute = (registeredTool as { execute?: RegisteredExecute }).execute;
	if (!execute) throw new Error("read_signatures was not registered");
	return execute;
}

test("folds callable bodies across supported languages", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "pi-read-signatures-"));
	t.after(async () => rm(project, { recursive: true, force: true }));
	const sourceDirectory = join(project, "src");
	await mkdir(sourceDirectory);
	const fixtures = [
		["fixture.js", 'export function javascriptFunction() { return "JAVASCRIPT_IMPLEMENTATION"; }\n'],
		["fixture.ts", 'export class TypeScriptBox { method(): string { return "TYPESCRIPT_IMPLEMENTATION"; } }\n'],
		["fixture.py", 'def python_function():\n    return "PYTHON_IMPLEMENTATION"\n'],
		["fixture.rs", 'fn rust_function() -> &\'static str { "RUST_IMPLEMENTATION" }\n'],
		["fixture.go", 'package fixture\nfunc goFunction() string { return "GO_IMPLEMENTATION" }\n'],
	] as const;
	const files = await Promise.all(
		fixtures.map(async ([name, content]) => {
			const path = join(sourceDirectory, name);
			await writeFile(path, content);
			const registry = signatureLanguage(path);
			if (!registry) assert.fail(`Missing language for ${name}`);
			return { path, content, registry };
		}),
	);

	const folded = await foldSignatures(files, AbortSignal.timeout(5_000));
	const output = [...folded.values()].join("\n");
	for (const declaration of [
		"function javascriptFunction()",
		"class TypeScriptBox",
		"method(): string",
		"def python_function():",
		"fn rust_function()",
		"func goFunction()",
	]) {
		assert.ok(output.includes(declaration), declaration);
	}
	assert.doesNotMatch(output, /(?:JAVASCRIPT|TYPESCRIPT|PYTHON|RUST|GO)_IMPLEMENTATION/);
});

test("read_signatures folds the complete file before bounded output", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "pi-read-signatures-"));
	t.after(async () => rm(project, { recursive: true, force: true }));
	const payload = "x".repeat(80 * 1024);
	await writeFile(
		join(project, "api.ts"),
		`export function first() { return "${payload}"; }\nexport function second() { return 2; }\n`,
	);

	const execute = registeredExecute();
	const firstResult = (await execute(
		"signature-read-1",
		{ path: "api.ts", limit: 1 },
		AbortSignal.timeout(5_000),
		undefined,
		{ cwd: project },
	)) as {
		content: Array<{ text: string }>;
		details: { nextOffset?: number; truncated: boolean };
	};
	assert.match(firstResult.content[0]?.text ?? "", /function first/);
	assert.doesNotMatch(firstResult.content[0]?.text ?? "", /x{100}/);
	assert.equal(firstResult.details.truncated, true);
	assert.equal(firstResult.details.nextOffset, 2);

	const secondResult = (await execute(
		"signature-read-2",
		{ path: "api.ts", offset: firstResult.details.nextOffset },
		AbortSignal.timeout(5_000),
		undefined,
		{ cwd: project },
	)) as { content: Array<{ text: string }> };
	assert.match(secondResult.content[0]?.text ?? "", /function second/);
});

test("read_signatures rejects unsafe or invalid sources", async (t) => {
	const project = await mkdtemp(join(tmpdir(), "pi-read-signatures-"));
	t.after(async () => rm(project, { recursive: true, force: true }));
	await Promise.all([
		writeFile(join(project, "invalid.ts"), Buffer.from([0xff])),
		writeFile(join(project, "oversized.ts"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)),
		writeFile(join(project, "small.ts"), "export const value = 1;\n"),
		mkdir(join(project, "directory.ts")),
	]);
	const execute = registeredExecute();
	const run = (path: string, parameters: Record<string, unknown> = {}) =>
		execute("signature-read-safety", { path, ...parameters }, AbortSignal.timeout(5_000), undefined, {
			cwd: project,
		});

	await assert.rejects(run("unsupported.txt"), /does not support.*Use read/);
	await assert.rejects(run("directory.ts"), /Not a regular file/);
	await assert.rejects(run("invalid.ts"), /requires UTF-8 text/);
	await assert.rejects(run("oversized.ts"), /source limit/);
	await assert.rejects(run("small.ts", { offset: 99 }), /beyond the folded output/);
});
