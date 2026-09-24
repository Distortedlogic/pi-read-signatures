import { readFile } from "node:fs/promises";
import type { SignatureLanguage } from "./languages.ts";

type QueryBuilderConstructor = typeof import("@getgrit/gritql")["QueryBuilder"];

let queryBuilder: Promise<QueryBuilderConstructor> | undefined;

async function loadQueryBuilder(): Promise<QueryBuilderConstructor> {
	queryBuilder ??= import("@getgrit/gritql").then((grit) => grit.QueryBuilder);
	return queryBuilder;
}

export class SignaturePatternCompileError extends Error {
	constructor(language: SignatureLanguage["language"], patternFile: string, cause: unknown) {
		super(`Could not compile the ${language} signature pattern ${patternFile}.`, { cause });
		this.name = "SignaturePatternCompileError";
	}
}

export class SignatureFileFoldError extends Error {
	constructor(path: string, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(`Could not fold callable bodies in ${path}: ${detail}`, { cause });
		this.name = "SignatureFileFoldError";
	}
}

export interface SignatureFile {
	path: string;
	content: string;
	registry: SignatureLanguage;
}

export async function foldSignatures(
	files: readonly SignatureFile[],
	signal?: AbortSignal,
): Promise<Map<string, string>> {
	signal?.throwIfAborted();
	const QueryBuilder = await loadQueryBuilder();
	const builders = new Map<SignatureLanguage["language"], InstanceType<QueryBuilderConstructor>>();
	const folded = new Map<string, string>();

	for (const file of files) {
		signal?.throwIfAborted();
		let builder = builders.get(file.registry.language);
		if (!builder) {
			const patternSource = await readFile(file.registry.patternFile, { encoding: "utf8", signal });
			try {
				builder = new QueryBuilder(patternSource);
			} catch (error) {
				throw new SignaturePatternCompileError(file.registry.language, file.registry.patternFile, error);
			}
			builders.set(file.registry.language, builder);
		}
		try {
			const result = await builder.applyToFile({ path: file.path, content: file.content });
			folded.set(file.path, result?.content ?? file.content);
		} catch (error) {
			throw new SignatureFileFoldError(file.path, error);
		}
	}

	signal?.throwIfAborted();
	return folded;
}
