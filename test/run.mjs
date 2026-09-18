// Serves the fixture site and runs site-judge against it with no API key, so the
// run is deterministic: the code checks must fire on the planted paragraph in
// /bad.html and on the broken link, and nowhere else. Exits 1 on any mismatch.
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
const out = path.join(here, "findings.json");

const env = { ...process.env };
delete env.TYPESAFE_API_KEY;
// spawn, not spawnSync: the fixture server lives in this process and must keep answering.
const run = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(here, "..", "bin", "site-judge.mjs"), origin, "--json", out], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("close", (status) => resolve({ status, stdout, stderr }));
});
server.close();
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);

const fail = (msg) => { console.error(`test: ${msg}`); process.exit(1); };
if (run.status !== 0) fail(`site-judge exited ${run.status}`);
if (!run.stdout.includes("TYPESAFE_API_KEY is not set")) fail("expected the judged half to say it was skipped");

const { findings, pages } = JSON.parse(await readFile(out, "utf8"));
if (pages !== 4) fail(`expected 4 crawled pages (/, /about.html, /bad.html, /missing.html), got ${pages}`);
const got = new Set(findings.map((f) => `${f.page} ${f.question}`));
// /missing.html is crawled (it is linked from /), so it reports once, as page_not_ok, not again as broken_link.
const want = ["/bad.html em_dash", "/bad.html exclamation", "/bad.html social_proof_number", "/bad.html certification", "/missing.html page_not_ok"];
for (const w of want) if (!got.has(w)) fail(`missing finding: ${w}`);
for (const g of got) if (!want.includes(g)) fail(`unexpected finding: ${g}`);
if (findings.some((f) => f.excerpt.includes("9,999"))) fail("script text was read as copy");
console.log(`test: ${want.length}/${want.length} expected findings, nothing else — ok`);
