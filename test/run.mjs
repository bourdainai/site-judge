// Serves the fixture site and runs site-judge against it with no API key, so the
// run is deterministic: the code checks must fire on the planted paragraph in
// /bad.html and on the missing page, and nowhere else. Then runs again with the
// first run as baseline and the code gate on, and checks the report, the
// markdown and the exit code. Exits 1 on any mismatch.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixture");
const server = createServer(async (req, res) => {
  const file = path.join(fixture, req.url === "/" ? "index.html" : req.url);
  let body;
  try { body = await readFile(file); } catch { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const bin = path.join(here, "..", "bin", "site-judge.mjs");
const env = { ...process.env };
delete env.TYPESAFE_API_KEY;

// spawn, not spawnSync: the fixture server lives in this process and must keep answering.
const judge = (args, extraEnv = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [bin, origin, ...args], { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});
const fail = (msg) => { server.close(); console.error(`test: ${msg}`); process.exit(1); };

// --- run 1: plain
const out1 = path.join(here, "findings.json"), md1 = path.join(here, "findings.md");
const r1 = await judge(["--json", out1, "--markdown", md1]);
process.stdout.write(r1.stdout); process.stderr.write(r1.stderr);
if (r1.status !== 0) fail(`site-judge exited ${r1.status}`);
if (!r1.stdout.includes("TYPESAFE_API_KEY is not set")) fail("expected the judged half to say it was skipped");
const { findings, pages } = JSON.parse(await readFile(out1, "utf8"));
if (pages !== 4) fail(`expected 4 crawled pages (/, /about.html, /bad.html, /missing.html), got ${pages}`);
const got = new Set(findings.map((f) => `${f.page} ${f.question}`));
// /missing.html is crawled (it is linked from /), so it reports once, as page_not_ok, not again as broken_link.
const want = ["/bad.html em_dash", "/bad.html exclamation", "/bad.html social_proof_number", "/bad.html certification", "/missing.html page_not_ok"];
for (const w of want) if (!got.has(w)) fail(`missing finding: ${w}`);
for (const g of got) if (!want.includes(g)) fail(`unexpected finding: ${g}`);
if (findings.some((f) => f.excerpt.includes("9,999"))) fail("script text was read as copy");
if (findings.some((f) => f.new !== null)) fail("without a baseline, new must be null");
const md = await readFile(md1, "utf8");
if (!md.includes("### site-judge: 5 finding(s) to weigh") || !md.includes("| finding | `/bad.html` | `social_proof_number` |")) fail(`markdown did not carry the findings:\n${md}`);

// --- run 2: the first run as baseline, code gate on. Nothing is new, so the gate must not fire.
const r2 = await judge(["--baseline", out1, "--gate", "code"]);
if (r2.status !== 0) fail(`with everything known the gate fired: exit ${r2.status}\n${r2.stdout}${r2.stderr}`);
if (!r2.stdout.includes("(0 new, 5 known)")) fail(`expected 0 new, 5 known:\n${r2.stdout}`);

// --- run 3: an empty baseline, code gate on. Everything is new, so the gate must fire with exit 2.
const empty = path.join(here, "empty-baseline.json");
await (await import("node:fs/promises")).writeFile(empty, JSON.stringify({ findings: [] }));
const r3 = await judge(["--baseline", empty, "--gate", "code"]);
if (r3.status !== 2) fail(`with everything new the code gate should exit 2, got ${r3.status}\n${r3.stdout}${r3.stderr}`);
if (!r3.stdout.includes("(5 new, 0 known)")) fail(`expected 5 new, 0 known:\n${r3.stdout}`);

// --- the action's shape: every input arrives as "" when omitted
const r4 = await judge([], { SITE_JUDGE_RULES: "", SITE_JUDGE_JSON: "", SITE_JUDGE_MARKDOWN: "", SITE_JUDGE_BASELINE: "", SITE_JUDGE_GATE: "", SITE_JUDGE_MAX_PAGES: "80" });
if (r4.status !== 0) fail(`empty env inputs broke the run: ${r4.stderr}`);

server.close();
console.log(`test: ${want.length}/${want.length} expected findings and nothing else; markdown, baseline (known/new) and code gate (0 → exit 0, 5 new → exit 2) — ok`);
