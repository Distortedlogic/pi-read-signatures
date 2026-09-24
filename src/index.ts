import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { foldSignatures } from "./fold.ts";
import { signatureLanguage } from "./languages.ts";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

const ReadSignaturesParametersSchema = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		offset: Type.Optional(Type.Integer({ minimum: 1 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_LINES })),
	},
	{ additionalProperties: false },
);

function resolveSourcePath(cwd: string, path: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function foldedLines(source: string): string[] {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

export default function registerReadSignatures(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_signatures",
		label: "Read Signatures",
		description:
			"Read a supported source file with callable bodies folded. Use this for imports, types, functions, classes, methods, and file structure. Use read when implementation details are required.",
		promptSnippet: "Read source signatures without loading implementation bodies",
		promptGuidelines: [
			"Use read_signatures when declarations and file structure are sufficient.",
			"Use read for implementation details, documentation, data, configuration, binary files, or unsupported languages.",
		],
		parameters: ReadSignaturesParametersSchema,
		async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
			const path = resolveSourcePath(ctx.cwd, parameters.path);
			const registry = signatureLanguage(path);
			if (!registry) {
				throw new Error(`Signature reading does not support ${parameters.path}. Use read for the full file.`);
			}

			signal?.throwIfAborted();
			const details = await stat(path);
			if (!details.isFile()) throw new Error(`Not a regular file: ${parameters.path}`);
			if (details.size > MAX_SOURCE_BYTES) {
				throw new Error(
					`${parameters.path} is ${formatSize(details.size)}; the signature source limit is ${formatSize(MAX_SOURCE_BYTES)}.`,
				);
			}

			const bytes = await readFile(path, { signal });
			if (bytes.length > MAX_SOURCE_BYTES) {
				throw new Error(`${parameters.path} grew beyond ${formatSize(MAX_SOURCE_BYTES)}.`);
			}
			let source: string;
			try {
				source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
			} catch {
				throw new Error(`Signature reading requires UTF-8 text: ${parameters.path}. Use read for the full file.`);
			}

			const folded = await foldSignatures([{ path, content: source, registry }], signal);
			signal?.throwIfAborted();
			const output = folded.get(path);
			if (output === undefined) throw new Error(`Signature folding returned no output for ${parameters.path}.`);

			const lines = foldedLines(output);
			const offset = parameters.offset ?? 1;
			if (offset > Math.max(1, lines.length)) {
				throw new Error(`Offset ${offset} is beyond the folded output of ${lines.length} lines.`);
			}
			const limit = parameters.limit ?? DEFAULT_MAX_LINES;
			const page = truncateHead(lines.slice(offset - 1).join("\n"), {
				maxBytes: DEFAULT_MAX_BYTES,
				maxLines: limit,
			});
			const returnedLines = page.content === "" ? 0 : page.content.split("\n").length;
			const nextOffset = offset + returnedLines;
			const truncated = page.truncated || nextOffset <= lines.length;
			const continuation = truncated
				? `\n\n[Signature output truncated. Continue with read_signatures path=${JSON.stringify(parameters.path)} offset=${nextOffset}.]`
				: "";

			return {
				content: [
					{
						type: "text" as const,
						text: `File: ${JSON.stringify(parameters.path)} (signatures; ${registry.language})\n\n${page.content}${continuation}`,
					},
				],
				details: {
					path,
					language: registry.language,
					sourceBytes: bytes.length,
					foldedBytes: Buffer.byteLength(output),
					offset,
					returnedLines,
					truncated,
					...(truncated ? { nextOffset } : {}),
				},
			};
		},
	});
}
