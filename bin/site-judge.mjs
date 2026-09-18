#!/usr/bin/env node
/*
 * site-judge — reads your marketing site the way a visitor does and says,
 * on every pull request, where the copy breaks your own rules.
 *
 *   site-judge http://127.0.0.1:8787
 *   site-judge http://127.0.0.1:8787 --rules my-rules.json --json findings.json
 *
 * Two halves, kept apart because they are different kinds of evidence:
 *
 *   1. Code checks. Plain patterns (an em dash, an exclamation mark, "trusted
 *      by 2,000 brands", a certification you do not hold) run over the text of
 *      every page. Before any page is trusted to them, each pattern must fire
 *      on a planted line from the rules file; a pattern that cannot fire is a
 *      bug in the rules, and the run stops.
 *
 *   2. Judged questions. Each page is split into paragraph-sized windows and
 *      a typed-judgment model (TypeSafe's Jev: it answers yes/no with a
 *      probability, it never writes text) is asked every question in the
 *      rules file. Each question first has to pass its own controls: it must
 *      fire on every known-bad example and stay quiet on every known-good
 *      one. A question that fails its controls is reported UNTRUSTED and none
 *      of its answers can become a finding.
 *
 * Advisory. Findings are printed for a person to weigh; the process exits 0
 * on findings. It exits 1 only when it could not do its job: nothing
 * answered at the origin, the rules file is unusable, a check missed the
 * planted line, or the judgment engine could not be reached. Without
 * TYPESAFE_API_KEY the judged half is skipped and says so.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
// A composite action passes an omitted input as "", so empty means unset here.
const env = (name) => process.env[name]?.trim() || undefined;
const ORIGIN = (positional[0] ?? env("SITE_ORIGIN") ?? "").replace(/\/$/, "");
if (!ORIGIN) { console.error("site-judge: give the origin to judge, e.g. site-judge http://127.0.0.1:8787"); process.exit(1); }
const RULES_PATH = flag("--rules") ?? env("SITE_JUDGE_RULES") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "rules", "default.json");
const JSON_OUT = flag("--json") ?? env("SITE_JUDGE_JSON");
const KEY = process.env.TYPESAFE_API_KEY?.trim() || null;
const ENDPOINT = process.env.TYPESAFE_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone";

// ------------------------------------------------------------------ rules
let rules;
try { rules = JSON.parse(await readFile(RULES_PATH, "utf8")); } catch (e) { console.error(`site-judge: could not read rules at ${RULES_PATH}: ${e.message}`); process.exit(1); }
const MAX_PAGES = Number(env("SITE_JUDGE_MAX_PAGES") ?? rules.maxPages ?? 80);
const WINDOW = Number(rules.windowChars ?? 1200);
const MODEL = rules.model ?? "jev-1.13.0";
const FIRE = rules.fire ?? 0.7, CLEAR = rules.clear ?? 0.5;
const skip = new RegExp(rules.skip ?? "\\.(png|jpe?g|svg|webp|gif|ico|css|js|mjs|json|xml|txt|pdf|woff2?)$|mailto:|tel:", "i");
const CHECKS = Object.entries(rules.checks ?? {}).map(([id, c]) => ({ id, re: new RegExp(c.pattern, c.flags ?? ""), rule: c.rule }));
const QUESTIONS = Object.entries(rules.questions ?? {}).map(([id, q]) => ({
  id, rule: q.rule, bad: q.bad ?? [], good: q.good ?? [],
  question: { type: "noul", instructions: q.question, criteria: { true: q.yes, false: q.no } },
}));
if (CHECKS.length === 0 && QUESTIONS.length === 0) { console.error("site-judge: the rules file has no checks and no questions"); process.exit(1); }

// A check that cannot fire is a bug in the rules, not a clean site.
if (rules.planted) {
  const misses = CHECKS.filter((c) => !c.re.test(rules.planted)).map((c) => c.id);
  if (misses.length > 0) { console.error(`site-judge: these checks did not fire on the planted line: ${misses.join(", ")}`); process.exit(1); }
}

// ------------------------------------------------------------------ crawl
const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
// Block boundaries become newlines so the judged windows follow the page's own paragraphs.
const blocksOf = (html) => decode(html
  .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
  .replace(/<\/(p|h[1-6]|li|blockquote|section|article|header|footer|div|tr|dd|dt|figcaption)>|<br\s*\/?>/gi, "\n")
  .replace(/<[^>]+>/g, " "))
  .split("\n").map((b) => b.replace(/\s+/g, " ").trim()).filter(Boolean);
const linksOf = (html, base) => [...html.matchAll(/href=["']([^"'#]+)["']/g)].map((m) => { try { return new URL(m[1], base).toString(); } catch { return null; } }).filter(Boolean);

const pages = new Map();
const queue = [`${ORIGIN}/`];
while (queue.length > 0 && pages.size < MAX_PAGES) {
  const url = queue.shift();
  const key = url.replace(/\/$/, "") || ORIGIN;
  if (pages.has(key) || !url.startsWith(ORIGIN) || skip.test(url)) continue;
  let status = 0, html = "";
  try { const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) }); status = r.status; html = r.ok ? await r.text() : ""; } catch { status = 0; }
  const blocks = blocksOf(html);
  const internal = linksOf(html, url).filter((l) => l.startsWith(ORIGIN));
  pages.set(key, { url, status, blocks, text: blocks.join(" "), links: internal });
  for (const l of internal) if (!skip.test(l)) queue.push(l);
}
if (pages.size === 0 || [...pages.values()].every((p) => p.status === 0)) { console.error(`site-judge: nothing answered at ${ORIGIN}`); process.exit(1); }

// ------------------------------------------------------------------ code checks
const findings = [];
const push = (page, question, rule, excerpt, verdict = "FINDING", trusted = true, p = 1) =>
  findings.push({ page: page.replace(ORIGIN, "") || "/", question, rule, verdict, trusted, p, excerpt: String(excerpt).slice(0, 180) });
const allLinks = new Set();
for (const [key, page] of pages) {
  if (page.status !== 200) { push(key, "page_not_ok", "every linked page answers 200", `status ${page.status}`); continue; }
  for (const c of CHECKS) { const m = page.text.match(c.re); if (m) push(key, c.id, c.rule, page.text.slice(Math.max(0, m.index - 60), m.index + 80)); }
  for (const l of page.links) allLinks.add(l);
}
// Links to pages the crawl already fetched were checked by the crawl (page_not_ok);
// this pass covers the rest. HEAD first; a server that refuses HEAD gets a GET.
let checked = 0;
for (const l of [...allLinks].filter((l) => !skip.test(l) && !pages.has(l.replace(/\/$/, "") || ORIGIN)).slice(0, 300)) {
  checked += 1;
  try {
    let r = await fetch(l, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (r.status === 405 || r.status === 501) r = await fetch(l, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (r.status >= 400) push(l, "broken_link", "every internal link resolves", `${r.status}`);
  } catch { push(l, "broken_link", "every internal link resolves", "no answer"); }
}

// ------------------------------------------------------------------ judged questions
async function ask(state, questions) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const r = await fetch(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ state, model: MODEL, questions }), signal: AbortSignal.timeout(40_000) }).catch(() => null);
    if (!r) { await new Promise((res) => setTimeout(res, 1000 * (attempt + 1))); continue; }
    if (r.status === 429 || r.status === 529) { await new Promise((res) => setTimeout(res, (Number(r.headers.get("retry-after")) || 2 ** attempt) * 1000)); continue; }
    if (!r.ok) throw new Error(`judgment engine answered ${r.status}`);
    return (await r.json()).answers;
  }
  throw new Error("judgment engine: rate limited after four attempts");
}
// Paragraph-sized windows: whole blocks packed up to WINDOW characters, so one bad
// sentence is not diluted by a page of good copy.
const windowsOf = (blocks) => {
  const out = []; let cur = "";
  for (const b of blocks) {
    if (cur && cur.length + b.length + 1 > WINDOW) { out.push(cur); cur = ""; }
    cur = cur ? `${cur} ${b}` : b;
    while (cur.length > WINDOW) { out.push(cur.slice(0, WINDOW)); cur = cur.slice(WINDOW); }
  }
  if (cur) out.push(cur);
  return out;
};
const trusted = {};
let judged = 0;
if (QUESTIONS.length > 0 && !KEY) {
  console.log("site-judge: TYPESAFE_API_KEY is not set; the judged half was skipped (code checks ran)");
} else if (QUESTIONS.length > 0) {
  try {
    for (const q of QUESTIONS) {
      const bad = [], good = [];
      for (const copy of q.bad) bad.push((await ask({ copy, seen_on: ["a marketing page"] }, { [q.id]: q.question }))[q.id].noul);
      for (const copy of q.good) good.push((await ask({ copy, seen_on: ["a marketing page"] }, { [q.id]: q.question }))[q.id].noul);
      trusted[q.id] = bad.every((p) => p >= FIRE) && good.every((p) => p < CLEAR);
    }
    const questions = Object.fromEntries(QUESTIONS.map((q) => [q.id, q.question]));
    for (const [key, page] of pages) {
      if (page.status !== 200 || page.text.length < 40) continue;
      for (const copy of windowsOf(page.blocks)) {
        const answers = await ask({ copy, seen_on: [page.url] }, questions);
        judged += 1;
        for (const q of QUESTIONS) {
          const p = Number(answers[q.id].noul.toFixed(2));
          if (p >= CLEAR) push(key, q.id, q.rule, copy.slice(0, 160), p >= FIRE ? "FINDING" : "UNCLEAR", trusted[q.id] === true, p);
        }
      }
    }
  } catch (e) { console.error(`site-judge: ${e.message}`); process.exit(1); }
}

// ------------------------------------------------------------------ report
const untrusted = Object.entries(trusted).filter(([, t]) => !t).map(([q]) => q);
const real = findings.filter((f) => f.verdict === "FINDING" && f.trusted);
const unclear = findings.filter((f) => f.verdict === "UNCLEAR");
const judgedNote = KEY && QUESTIONS.length > 0
  ? `, ${judged} windows judged by ${MODEL}, questions trusted ${QUESTIONS.length - untrusted.length}/${QUESTIONS.length}${untrusted.length ? ` (untrusted: ${untrusted.join(", ")})` : ""}`
  : "";
console.log(`site-judge: ${pages.size} pages at ${ORIGIN}, ${checked} links checked${judgedNote}`);
for (const f of findings) console.log(`  ${f.verdict.padEnd(8)} ${(f.trusted ? "" : "untrusted ") + f.question}`.padEnd(46) + ` ${f.page.padEnd(28)} ${f.excerpt.slice(0, 90)}`);
console.log(`site-judge: ${real.length} finding(s) to weigh, ${unclear.length} unclear — advisory, exit 0`);
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify({ origin: ORIGIN, pages: pages.size, linksChecked: checked, model: KEY ? MODEL : null, windowsJudged: judged, trusted, findings }, null, 2));
