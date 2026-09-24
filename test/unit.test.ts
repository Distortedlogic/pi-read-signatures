import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldSignatures } from "../src/fold.ts";
import registerReadSignatures from "../src/index.ts";
import { signatureLanguage } from "../src/languages.ts";

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

	let registeredTool: unknown;
	registerReadSignatures({
		registerTool: (tool: unknown) => {
			registeredTool = tool;
		},
	} as unknown as ExtensionAPI);
	const execute = (
		registeredTool as {
			execute?: (...args: unknown[]) => Promise<unknown>;
		}
	).execute;
	if (!execute) assert.fail("read_signatures was not registered");

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
	await assert.rejects(
		execute("signature-read-unsupported", { path: "unsupported.txt" }, AbortSignal.timeout(5_000), undefined, {
			cwd: project,
		}),
		/does not support.*Use read/,
	);
});
