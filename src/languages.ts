import { extname } from "node:path";
import { fileURLToPath } from "node:url";

export interface SignatureLanguage {
	language: "javascript" | "python" | "rust" | "go";
	patternFile: string;
}

const javascript: SignatureLanguage = {
	language: "javascript",
	patternFile: fileURLToPath(new URL("../grit/fold-javascript.grit", import.meta.url)),
};
const python: SignatureLanguage = {
	language: "python",
	patternFile: fileURLToPath(new URL("../grit/fold-python.grit", import.meta.url)),
};
const rust: SignatureLanguage = {
	language: "rust",
	patternFile: fileURLToPath(new URL("../grit/fold-rust.grit", import.meta.url)),
};
const go: SignatureLanguage = {
	language: "go",
	patternFile: fileURLToPath(new URL("../grit/fold-go.grit", import.meta.url)),
};

const languages = new Map<string, SignatureLanguage>([
	[".js", javascript],
	[".jsx", javascript],
	[".mjs", javascript],
	[".cjs", javascript],
	[".ts", javascript],
	[".tsx", javascript],
	[".mts", javascript],
	[".cts", javascript],
	[".py", python],
	[".rs", rust],
	[".go", go],
]);

export function signatureLanguage(path: string): SignatureLanguage | undefined {
	return languages.get(extname(path));
}
