// Drives the real smartbash tool execute() from ~/.pi/agent/extensions/smartbash.ts
// against real processes via jiti. Usage: node test-smartbash.mjs <piAgentDir> <workDir>
import { createJiti } from "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const [, , agentDir, workDir] = process.argv;
const jiti = createJiti(pathToFileURL(path.join(agentDir, "extensions", "smartbash.ts")).href);
const mod = await jiti.import(pathToFileURL(path.join(agentDir, "extensions", "smartbash.ts")).href);

let tool;
const pi = {
	registerTool: (t) => (tool = t),
	registerCommand: () => {},
	on: () => {},
};
mod.default(pi);
if (!tool) throw new Error("bash tool was not registered");

const updates = [];
const ctx = { cwd: workDir, mode: "json", hasUI: false, ui: {} };
const onUpdate = (partial) => updates.push(partial.details);

let pass = 0;
let fail = 0;
const check = (label, cond, extra) => {
	if (cond) {
		pass++;
		console.log(`PASS ${label}`);
	} else {
		fail++;
		console.log(`FAIL ${label}${extra ? ` — ${JSON.stringify(extra).slice(0, 400)}` : ""}`);
	}
};

// 1. fast command, done path
{
	updates.length = 0;
	const r = await tool.execute("t1", { name: "echo hello world", command: "echo hello; echo err >&2" }, undefined, onUpdate, ctx);
	const d = r.details;
	check("1 done exit=0", d.status === "done" && d.exit === 0, d);
	check("1 output captured", r.content[0].text.includes("hello") && r.content[0].text.includes("err"), r.content[0].text);
	check("1 run dir in .pi/smartbash", d.log.includes(`${workDir}/.pi/smartbash/`), d.log);
	check("1 meta written", fs.existsSync(path.join(path.dirname(d.log), "meta.json")));
	check("1 cmd.sh written", fs.existsSync(path.join(path.dirname(d.log), "cmd.sh")));
	check("1 ui updates streamed", updates.length >= 1, updates.length);
}

// 2. failing command preserves exit code
{
	const r = await tool.execute("t2", { name: "expect failure here", command: "false" }, undefined, onUpdate, ctx);
	check("2 exit=1", r.details.exit === 1, r.details);
	check("2 status done", r.details.status === "done");
}

// 3. multi-line command sequence
{
	updates.length = 0;
	const r = await tool.execute("t3", { name: "three step sequence", command: "echo one\necho two\necho three" }, undefined, onUpdate, ctx);
	const text = r.content[0].text;
	check("3 all lines ran", text.includes("one") && text.includes("two") && text.includes("three"), text);
}

// 4. directory param + invalid directory
{
	fs.mkdirSync(path.join(workDir, "sub"), { recursive: true });
	fs.writeFileSync(path.join(workDir, "sub", "marker.txt"), "x");
	const r = await tool.execute("t4", { name: "run inside subdir", command: "pwd", directory: path.join(workDir, "sub") }, undefined, onUpdate, ctx);
	check("4 cwd honored", r.content[0].text.includes(`${workDir}/sub`), r.content[0].text);
	let threw = "";
	try {
		await tool.execute("t4b", { name: "bad directory test", command: "true", directory: "/nope/nothing" }, undefined, onUpdate, ctx);
	} catch (e) {
		threw = String(e.message ?? e);
	}
	check("4 bad dir throws", threw.includes("directory does not exist"), threw);
}

// 5. timeout: returns fast, process keeps running
{
	updates.length = 0;
	const t0 = Date.now();
	const r = await tool.execute("t5", { name: "long sleep test", command: "echo started; sleep 6; echo late-done", timeout: 2 }, undefined, onUpdate, ctx);
	const wall = (Date.now() - t0) / 1000;
	const d = r.details;
	check("5 status timeout", d.status === "timeout", d);
	check("5 returned fast", wall < 4, wall);
	check("5 has pid", typeof d.pid === "number" && d.pid > 0, d.pid);
	check("5 report mentions tail/poll", r.content[0].text.includes("tail -n 200") && r.content[0].text.includes("kill"), r.content[0].text);
	// process should complete on its own; poll the log
	await new Promise((r2) => setTimeout(r2, 5500));
	const log = fs.readFileSync(d.log, "utf8");
	check("5 process finished after return", log.includes("late-done"), log);
	const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(d.log), "meta.json"), "utf8"));
	check("5 meta records timeout", meta.status === "timeout", meta.status);
	try { process.kill(-d.pid, "SIGKILL"); } catch {}
}

// 6. elision of huge output
{
	const r = await tool.execute("t6", { name: "generate huge output", command: "seq 1 5000" }, undefined, onUpdate, ctx);
	const text = r.content[0].text;
	check("6 elided", r.details.elided === true, r.details.totalLines);
	check("6 head+tail kept", text.includes("1\n2") && text.includes("4999\n5000"), text.slice(0, 80));
	check("6 marker present", text.includes("lines elided"), text.slice(-200));
	check("6 line count", r.details.totalLines === 5000, r.details.totalLines);
}

// 7. slug + name in run dir
{
	const r = await tool.execute("t7", { name: "Check Test Failures!", command: "true" }, undefined, onUpdate, ctx);
	check("7 slug in path", r.details.run.endsWith("check-test-failures"), r.details.run);
}

// 8. catastrophic guard
{
	const r = await tool.execute("t8", { name: "try bad command", command: "rm -rf /" }, undefined, onUpdate, ctx);
	check("8 blocked", r.details.status === "blocked", r.details);
}

// 9. abort via signal kills the process
{
	const ctrl = new AbortController();
	const p = tool.execute("t9", { name: "abort sleep test", command: "sleep 30" }, ctrl.signal, onUpdate, ctx);
	await new Promise((r2) => setTimeout(r2, 800));
	ctrl.abort();
	const r = await p;
	check("9 aborted status", r.details.status === "aborted", r.details);
	await new Promise((r2) => setTimeout(r2, 400));
	let dead = false;
	try { process.kill(r.details.pid, 0); } catch { dead = true; }
	check("9 process killed", dead, r.details.pid);
}

// 10. exported helpers
{
	check("10 slugify", mod.slugify("Fix DB Pool Overflow NOW Please") === "fix-db-pool-overflow-now", mod.slugify("Fix DB Pool Overflow NOW Please"));
	check("10 denyReason", mod.denyReason("mkfs.ext4 /dev/sda") !== undefined);
	check("10 expandDir", mod.expandDir("~").length > 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
