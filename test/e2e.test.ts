import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const cliPath = join(dirname(codingAgentEntry), "cli.js");

test("packs and loads the production package without provider credentials", { timeout: 120_000 }, async (t) => {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-read-signatures-e2e-"));
	t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
	const archiveDirectory = join(temporaryDirectory, "archive");
	const installDirectory = join(temporaryDirectory, "install");
	const agentDirectory = join(temporaryDirectory, "agent");
	await Promise.all([mkdir(archiveDirectory), mkdir(installDirectory), mkdir(agentDirectory)]);

	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const { stdout: packOutput } = await execFileAsync(npm, ["pack", "--json", "--pack-destination", archiveDirectory], {
		cwd: projectDirectory,
		encoding: "utf8",
		env: process.env,
		timeout: 30_000,
	});
	const packed = (JSON.parse(packOutput) as Array<{ filename?: unknown; name?: unknown }>)[0];
	if (!packed || typeof packed.filename !== "string" || typeof packed.name !== "string") {
		assert.fail("npm pack returned no package name or archive filename");
	}
	const archivePath = join(archiveDirectory, packed.filename);

	await execFileAsync(
		npm,
		["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "--omit=peer", archivePath],
		{ cwd: installDirectory, encoding: "utf8", env: process.env, timeout: 60_000 },
	);

	const installedPackageDirectory = join(installDirectory, "node_modules", packed.name);
	const manifest = JSON.parse(await readFile(join(installedPackageDirectory, "package.json"), "utf8")) as {
		pi?: { extensions?: unknown };
	};
	assert.deepEqual(manifest.pi?.extensions, ["./src/index.ts"]);

	const { stderr } = await execFileAsync(
		process.execPath,
		[cliPath, "--no-session", "--no-extensions", "--extension", installedPackageDirectory, "--list-models"],
		{
			cwd: installDirectory,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1" },
			timeout: 30_000,
		},
	);

	assert.doesNotMatch(stderr, /Failed to load extension|No API key|Authentication failed/i);
});
