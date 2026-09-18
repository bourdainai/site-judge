# site-judge

**A CI check that reads your marketing site like a sceptical customer and flags every claim that arrives without its evidence.**

It doesn't know your facts. It knows what a claim without proof looks like — "trusted by 2,000 brands", "runs on autopilot", "enterprise-grade security", "SOC 2 certified" — and prints each one on the pull request, before it ships.

This is the real output against the fixture site in [`test/fixture`](test/fixture), whose pricing page says *"Trusted by 2,000 brands! Put your support on autopilot and never touch a ticket again — enterprise-grade security you can trust, SOC 2 certified."*:

```
site-judge: 4 pages at http://127.0.0.1:62171, 4 links checked, 3 windows judged by jev-1.13.0, questions trusted 6/6
  FINDING  em_dash                    /bad.html      …never touch a ticket again — enterprise-grade security…
  FINDING  exclamation                /bad.html      …Trusted by 2,000 brands! Put your support on autopil…
  FINDING  social_proof_number        /bad.html      …Trusted by 2,000 brands! Put your support…
  FINDING  certification              /bad.html      …security you can trust, SOC 2 certified.
  FINDING  page_not_ok                /missing.html  status 404
  FINDING  autonomy_language          /bad.html      …Put your support on autopilot and never touch a ticket…
  UNCLEAR  replaces_people_or_tools   /bad.html      …
  FINDING  claim_without_evidence     /bad.html      …Trusted by 2,000 brands!…
  UNCLEAR  one_punch                  /bad.html      …
site-judge: 7 finding(s) to weigh, 2 unclear — advisory, exit 0
```

The first five are code. The last four are the judgment model, and two of them are UNCLEAR on purpose (see below). The home and about pages, which follow the rules, produced nothing.

## See it run

```sh
git clone https://github.com/bourdainai/site-judge && cd site-judge
node test/run.mjs
```

That serves the fixture site and runs the code checks against it (no key needed). Add `TYPESAFE_API_KEY` to the environment and run `node bin/site-judge.mjs <origin>` for the judged half.

## Why

Every company writes down rules for its copy: no invented numbers, no badges we don't hold, no promising the customer they'll never have to think again. Then a launch week happens, a tired reviewer waves a paragraph through, and the site says something nobody can back up.

The rules were only ever enforced by whoever happened to be reading the pull request. site-judge makes the same reader show up every time. It doesn't get tired and it doesn't get flattered by good prose.

It is **not** a fact-checker. It cannot verify that you have 2,000 customers. It can tell you that you claimed it with nothing beside it, and make you either put the proof next to the claim or cut the claim. That is the whole idea: **a claim carries its evidence, or it goes.**

## How it works

Two halves, kept apart because they are different kinds of evidence.

**1. Code checks — deterministic.** Plain patterns run over the text of every page: an em dash, an exclamation mark, "trusted by N brands", a certification name. Before any page is trusted to them, every pattern must fire on a *planted line* in the rules file. A pattern that cannot fire is a bug in the rules and the run stops — a check that never fires is not coverage, it is the appearance of coverage.

**2. Judged questions — a typed-judgment model, with controls.** Each page is split into paragraph-sized windows and a judgment model is asked a fixed set of narrow yes/no questions about each one: does this promise autonomy, is this AI theatre, is this reassurance with no mechanism, is this proof claimed without evidence, is this page throwing more than one punch. The model is [TypeSafe's Jev](https://docs.typesafe.ai): it returns a probability of *yes*, it never writes text, so there is nothing to prompt-inject and nothing to hallucinate — it can only answer the question it was asked.

Every question has to earn its place on every run. Each carries **known-bad and known-good examples**; the question is asked those first and must fire on every bad one (≥ 0.7) and stay quiet on every good one (< 0.5). A question that fails its controls is reported **UNTRUSTED** and none of its answers can become a finding. So "no findings" means "no findings from questions that were proven to work today", never "the model felt fine".

**Advisory, always.** It exits 0 on findings. It prints them for a person to weigh; it never blocks a merge and it never edits anything. It exits 1 only when it could not do its job: nothing answered at the origin, the rules file is unusable, a check missed the planted line, or the judgment engine could not be reached.

**Honest about uncertainty.** Answers between 0.5 and 0.7 print as **UNCLEAR**, not rounded to yes or no. That band is the model saying "I can't tell", and that is a better answer to record than a coin flip.

## Use it

Serve a build of your site on localhost, then point site-judge at it. No dependencies; Node 20+.

```sh
npx github:bourdainai/site-judge http://127.0.0.1:8787
```

With your own rules and a JSON report:

```sh
npx github:bourdainai/site-judge http://127.0.0.1:8787 --rules copy-rules.json --json findings.json
```

Without `TYPESAFE_API_KEY` in the environment the judged half is skipped and says so; the code checks still run. Get a key at [typesafe.ai](https://typesafe.ai). The judged half makes one request per window plus one per control example: on a 39-page site that was 89 windows and 30 controls, about 120 requests a run. Pricing is TypeSafe's to state, not this README's.

### As a GitHub Action

```yaml
site-judge:
  runs-on: ubuntu-latest
  needs: build
  steps:
    - uses: actions/checkout@v4
    - uses: actions/download-artifact@v4
      with: { name: site-output, path: dist }
    - name: Serve the build
      run: |
        npx --yes serve dist -l 8787 &
        for _ in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:8787/ && break; sleep 1; done
    - uses: bourdainai/site-judge@v0.1.0
      with:
        url: http://127.0.0.1:8787
        typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
        # rules: copy-rules.json
```

Serve the site however your stack does (static server, `wrangler dev`, `next start`) — the action only needs a URL that answers.

## Write your own rules

Copy [`rules/default.json`](rules/default.json) and edit it. It is the whole contract:

| Key | What it is |
| --- | --- |
| `checks` | Regex checks. Each has a `pattern`, optional `flags`, and the `rule` it enforces, in your words. |
| `planted` | One line every check must fire on. Add a phrase here whenever you add a check; the run refuses to start if any check misses it. |
| `questions` | Judged questions. `question` is asked over `copy`; `yes`/`no` define the two answers (a definition and examples); `bad`/`good` are the controls. |
| `windowChars` | How much page text is judged at once (default 1200, roughly a paragraph or two). Smaller windows catch one bad sentence in a page of good ones; larger windows catch page-level problems like "more than one punch". |
| `skip` | Regex of URLs not to crawl — assets, `mailto:`, and any section you judge elsewhere. |
| `fire` / `clear` | The thresholds: a finding at or above `fire`, unclear between `clear` and `fire`, quiet below `clear`. |

Two things to hold onto when writing a question:

- **Name the thing in the question.** The model never sees your question's ID, only its text. "Does `copy` promise autonomy?" beats "Does this violate rule 1?"
- **Write the controls before the question.** If you can't write three sentences it must catch and three it must leave alone, you don't yet know what you're asking. The controls are what turn "the model said so" into "the question was proven to work on this run".

The defaults encode one company's copy rules: never sell autonomy, no AI theatre, the product is not an employee, no reassurance without the mechanism, every claim carries its evidence, one punch per page. Yours will differ. Change the wording, keep the shape.

## What it is not

- **Not a fact-checker.** It flags claims made without evidence; it cannot check whether the claim is true.
- **Not a gate.** It prints; a person decides. If you want a blocking check, the code half is deterministic enough to gate on — the judged half is not, by design.
- **Not a style guide.** It won't make your copy good. It will stop it lying.
- **Not free of false positives.** A judged question can misread a window. That is why every finding carries the excerpt and the probability, and why nothing is hidden behind a summary number.

## Design notes

- The judged model is pinned (`model` in the rules) because the controls were measured against that version. Bump it deliberately and watch the controls.
- Windows follow the page's own block elements (`<p>`, `<h2>`, `<li>` …) so a paragraph is judged as a paragraph. A single 1,200-character window sometimes dilutes one bad sentence with good copy around it; if a finding you expected comes back UNCLEAR, make `windowChars` smaller.
- Findings are printed in full and, with `--json`, written as data — page, question, rule, verdict, probability, excerpt, and whether the question was trusted — so you can post them as a PR comment, chart them over time, or feed them to whatever weighs them next.

## Licence

MIT.
