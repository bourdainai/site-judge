# site-judge

**A CI check that reads your marketing site like a sceptical customer and flags every claim that arrives without its evidence.**

It doesn't know your facts. It knows what a claim without proof looks like — "trusted by 2,000 brands", "runs on autopilot", "enterprise-grade security", "SOC 2 certified" — and prints each one on the pull request, naming the sentence, before it ships.

This is the real output against the fixture site in [`test/fixture`](test/fixture), whose pricing page says *"Trusted by 2,000 brands! Put your support on autopilot and never touch a ticket again — enterprise-grade security you can trust, SOC 2 certified."*:

```
site-judge: 4 pages at http://127.0.0.1:8787, 0 links checked, 3 windows judged by jev-1.13.0 (+6 sentences located), questions trusted 6/6
  FINDING  em_dash                        /bad.html      Put your support on autopilot and never touch a ticket again — enterprise-grade…
  FINDING  exclamation                    /bad.html      Trusted by 2,000 brands!
  FINDING  social_proof_number            /bad.html      Trusted by 2,000 brands!
  FINDING  certification                  /bad.html      …enterprise-grade security you can trust, SOC 2 certified.
  FINDING  page_not_ok                    /missing.html  status 404
  FINDING  autonomy_language              /bad.html      Put your support on autopilot and never touch a ticket again — … p=0.98
  UNCLEAR  replaces_people_or_tools       /bad.html      Pricing Home Pricing Plans start at $29 a month. Trusted by… p=0.59
  UNCLEAR  reassurance_without_mechanism  /bad.html      Pricing Home Pricing Plans start at $29 a month. Trusted by… p=0.52
  FINDING  claim_without_evidence         /bad.html      Trusted by 2,000 brands! p=0.97
  UNCLEAR  one_punch                      /bad.html      Pricing Home Pricing Plans start at $29 a month. Trusted by… p=0.61
site-judge: 7 finding(s) to weigh, 3 unclear — advisory, exit 0
```

The first five are code. The rest are the judgment model, and three of them are UNCLEAR on purpose (see below). The home and about pages, which follow the rules, produced nothing. On a pull request the same table arrives as a comment.

## Why

Every company writes down rules for its copy: no invented numbers, no badges we don't hold, no promising the customer they'll never have to think again. Then a launch week happens, a tired reviewer waves a paragraph through, and the site says something nobody can back up.

The rules were only ever enforced by whoever happened to be reading the pull request. site-judge makes the same reader show up every time. It doesn't get tired and it doesn't get flattered by good prose.

It is **not** a fact-checker. It cannot verify that you have 2,000 customers. It can tell you that you claimed it with nothing beside it, and make you either put the proof next to the claim or cut the claim. That is the whole idea: **a claim carries its evidence, or it goes.**

## How it works

Two halves, kept apart because they are different kinds of evidence.

**1. Code checks — deterministic.** Plain patterns run over the text of every page: an em dash, an exclamation mark, "trusted by N brands", a certification name. Before any page is trusted to them, every pattern must fire on a *planted line* in the rules file. A pattern that cannot fire is a bug in the rules and the run stops — a check that never fires is not coverage, it is the appearance of coverage.

**2. Judged questions — a typed-judgment model, with controls.** Each page is split into paragraph-sized windows and a judgment model is asked a fixed set of narrow yes/no questions about each one: does this promise autonomy, is this AI theatre, is this reassurance with no mechanism, is this proof claimed without evidence, is this page throwing more than one punch. The model is [TypeSafe's Jev](https://docs.typesafe.ai): it returns a probability of *yes*, it never writes text, so there is nothing to prompt-inject and nothing to hallucinate — it can only answer the question it was asked.

Every question has to earn its place on every run. Each carries **known-bad and known-good examples**; the question is asked those first and must fire on every bad one (≥ 0.7) and stay quiet on every good one (< 0.5). A question that fails its controls is reported **UNTRUSTED**, the run says which example it failed on, and none of its answers can become a finding. So "no findings" means "no findings from questions that were proven to work today", never "the model felt fine".

**The finding names the sentence — when a sentence is the problem.** When a window fires, the same question is asked of each sentence in it; if one clears the threshold on its own, the finding carries that sentence and its probability. That is what turns "something on the pricing page" into *"Trusted by 2,000 brands!" p=0.97* — a line someone can change. If no single sentence clears it, the problem is the paragraph (a pile-up, a register) and the finding keeps the window as its excerpt, marked `scope: window`. Page-level questions like `one_punch` opt out of location entirely.

**Advisory, always.** It exits 0 on findings. It prints them for a person to weigh; it never blocks a merge and it never edits anything. If you want a gate, `--gate code` fails the run on the deterministic half only (code checks and broken links, and only new ones when a baseline is given); judged findings never gate, by design. It exits 1 only when it could not do its job: nothing answered at the origin, the rules file is unusable, a check missed the planted line, or the judgment engine could not be reached.

**Honest about uncertainty.** Answers between 0.5 and 0.7 print as **UNCLEAR**, not rounded to yes or no. That band is the model saying "I can't tell", and that is a better answer to record than a coin flip.

**New versus known.** Give it last run's findings as a `--baseline` and every finding is marked NEW or known, so a site with six legacy findings doesn't show the same six on every PR.

## See it run

```sh
git clone https://github.com/bourdainai/site-judge && cd site-judge
node test/run.mjs
```

That serves the fixture site and runs the code checks against it (no key needed). Add `TYPESAFE_API_KEY` to the environment and run `node bin/site-judge.mjs <origin>` for the judged half.

## Use it

Serve a build of your site on localhost, then point site-judge at it. No dependencies; Node 20+.

```sh
npx github:bourdainai/site-judge http://127.0.0.1:8787
```

All the switches:

```sh
npx github:bourdainai/site-judge http://127.0.0.1:8787 \
  --rules copy-rules.json \        # your rules (defaults to rules/default.json)
  --json findings.json \           # findings as data; also next run's --baseline
  --markdown findings.md \         # the table a PR comment carries
  --baseline main-findings.json \  # mark findings NEW or known
  --gate code                      # exit 2 on new code findings; judged findings never gate
```

Without `TYPESAFE_API_KEY` in the environment the judged half is skipped and says so; the code checks still run. Get a key at [typesafe.ai](https://typesafe.ai). The judged half makes one request per window, one per control example, and one per sentence of a window that fired: on a 39-page site that was 89 windows and 30 controls, about 120 requests before locating. Pricing is TypeSafe's to state, not this README's.

### As a GitHub Action

```yaml
site-judge:
  runs-on: ubuntu-latest
  needs: build
  permissions:
    contents: read
    pull-requests: write      # for the sticky PR comment; drop it and set comment: "false"
  steps:
    - uses: actions/checkout@v4
    - uses: actions/download-artifact@v4
      with: { name: site-output, path: dist }
    - name: Serve the build
      run: |
        npx --yes serve dist -l 8787 &
        for _ in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:8787/ && break; sleep 1; done
    - uses: bourdainai/site-judge@v0.2.0
      with:
        url: http://127.0.0.1:8787
        typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
        # rules: copy-rules.json
        # baseline: site-judge-baseline.json   # commit a main-branch findings.json to get NEW/known
        # gate: code                           # fail the step on new code findings only
```

Serve the site however your stack does (static server, `wrangler dev`, `next start`) — the action only needs a URL that answers. The findings table goes to the job summary on every run and, on a pull request, to one sticky comment that is updated in place. The action's `json` output is the path of the findings file; upload it as an artifact or commit it from `main` to use as the next baseline.

## Write your own rules

Copy [`rules/default.json`](rules/default.json) and edit it. It is the whole contract:

| Key | What it is |
| --- | --- |
| `checks` | Regex checks. Each has a `pattern`, optional `flags`, and the `rule` it enforces, in your words. |
| `planted` | One line every check must fire on. Add a phrase here whenever you add a check; the run refuses to start if any check misses it. |
| `questions` | Judged questions. `question` is asked over `copy`; `yes`/`no` define the two answers (a definition and examples); `bad`/`good` are the controls, and both are required. A question may set its own `fire`/`clear`, and `"locate": false` for a question that is about the paragraph, not a sentence (the default `one_punch`). |
| `windowChars` | How much page text is judged at once (default 1200, roughly a paragraph or two). Smaller windows catch one bad sentence in a page of good ones; larger windows catch page-level problems like "more than one punch". |
| `skip` | Regex of URLs not to crawl — assets, `mailto:`, and any section you judge elsewhere. |
| `fire` / `clear` | The thresholds: a finding at or above `fire`, unclear between `clear` and `fire`, quiet below `clear`. |

Two things to hold onto when writing a question:

- **Name the thing in the question.** The model never sees your question's ID, only its text. "Does `copy` promise autonomy?" beats "Does this violate rule 1?"
- **Write the controls before the question.** If you can't write three sentences it must catch and three it must leave alone, you don't yet know what you're asking. The controls are what turn "the model said so" into "the question was proven to work on this run".

The defaults encode one company's copy rules: never sell autonomy, no AI theatre, the product is not an employee, no reassurance without the mechanism, every claim carries its evidence, one punch per page. Yours will differ. Change the wording, keep the shape.

## What it is not

- **Not a fact-checker.** It flags claims made without evidence; it cannot check whether the claim is true.
- **Not a gate on judgment.** It prints; a person decides. `--gate code` gates only the deterministic half.
- **Not a style guide.** It won't make your copy good. It will stop it lying.
- **Not free of false positives.** A judged question can misread a window. That is why every finding carries the sentence and the probability, and why nothing is hidden behind a summary number.

## Design notes

- The judged model is pinned (`model` in the rules) because the controls were measured against that version. Bump it deliberately and watch the controls.
- Windows follow the page's own block elements (`<p>`, `<h2>`, `<li>` …) so a paragraph is judged as a paragraph. Page-level questions like `one_punch` sit in the UNCLEAR band on a short page for the same reason; give them a larger `windowChars` or their own lower `fire` if they matter to you.
- A finding's `key` (page, question, first words) is what a baseline compares on, so rewording a sentence makes it new again — which is what you want.
- Only `text/html` responses are read as copy; everything else the crawl reaches is ignored, whatever its extension.

## Licence

MIT.
