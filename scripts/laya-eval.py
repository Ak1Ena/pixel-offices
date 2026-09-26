#!/usr/bin/env python3
"""Measure Laya on the office's own decision questions and suggest thresholds.

Laya's `confidence` is not P(answer), so the office gates each kind of question
with a per-checkpoint threshold (DECISION_THRESHOLDS in server/src/constants.ts).
This script asks every case with each checkpoint and prints, per kind:
  top-1 accuracy, and the lowest threshold that lets NO wrong answer through
  (with how many right answers that keeps).

Run with the office's own Laya (Settings -> Decision model):
  HF_HOME=~/.pixel-agents/laya/hf ~/.pixel-agents/laya/venv/bin/python \
    scripts/laya-eval.py english multilingual typed-decisions

Add your own cases with --cases FILE.jsonl, one JSON object per line:
  {"kind": "ending", "text": "…agent reply…", "gold": "question"}
  {"kind": "textIdle", "text": "…", "gold": "continuing"}
  {"kind": "addressed", "text": "…paragraph…", "name": "scout", "gold": true}
  {"kind": "card", "text": "[feature] title", "question": "team", "gold": "frontend-crew"}
Real replies from your own agents are what make the thresholds trustworthy;
these built-in cases are only a start. The question wording below mirrors the
server's — keep them in sync when either changes.
"""
import argparse
import json

from laya import Router

ENDING = {"type": "choice", "instructions": "How did the coding agent end its turn on this card?",
  "criteria": {"finished": "says the work is done or reports what it changed",
               "question": "asks the user a question, or asks them to choose or confirm before going on",
               "blocked": "cannot go on because of an error, a failing command or missing access"}}
ending_cases = [
 ("I've added the retry logic to fetchUser and all 42 tests pass. The change is in src/api.ts.", "finished"),
 ("Done. Renamed the config key and updated the three call sites.", "finished"),
 ("The login page now validates email format. I also added two unit tests.", "finished"),
 ("Implemented pagination for /orders; the endpoint now takes ?page and ?limit.", "finished"),
 ("Should I keep the old API endpoint for backwards compatibility, or remove it?", "question"),
 ("I found two ways to fix this: A) cache in memory, B) use Redis. Which do you prefer?", "question"),
 ("Before I delete the migrations folder, can you confirm that's okay?", "question"),
 ("Do you want the button on the left or the right of the header?", "question"),
 ("I can't continue: npm install fails with EACCES permission denied on /usr/lib/node_modules.", "blocked"),
 ("The build fails with 'Cannot find module @prisma/client' and I don't have network access to install it.", "blocked"),
 ("I don't have access to the staging database, so I can't run the migration.", "blocked"),
 ("Tests keep failing with a segfault in the native addon; I can't get past this.", "blocked"),
]
IDLE = {"type": "choice", "instructions": "Is this coding agent's message its final reply for now, or does it announce work it is about to do?",
  "criteria": {"finished": "answers the question, reports what was done, or asks the user something",
               "continuing": 'says what it will do next, like "Let me check the tests first"'}}
idle_cases = [
 ("Let me check the tests first.", "continuing"),
 ("I'll look at the router config next.", "continuing"),
 ("Now I'm going to run the build to see if it compiles.", "continuing"),
 ("Next, I'll update the README.", "continuing"),
 ("Let me search for where this function is called.", "continuing"),
 ("The function returns null when the list is empty, which is why the page crashes.", "finished"),
 ("Yes, React 19 supports that. You can use the `use` hook for it.", "finished"),
 ("All done — the typo is fixed in the header.", "finished"),
 ("Which database should I use for this, Postgres or SQLite?", "finished"),
 ("That error means the port is already in use; stop the other server and retry.", "finished"),
]
def addr(name): return {"type": "noul", "instructions": f"Does this paragraph ask @{name} to do something or to answer a question? A status note or a plan that only names them is not a request."}
addr_cases = [
 ("Can you review the auth changes, @scout? The diff is in server/auth.ts.", "scout", True),
 ("@dev please run the migration on staging when you get a chance.", "dev", True),
 ("Also, @tester, write e2e tests for the checkout flow.", "tester", True),
 ("What do you think about using zod here, @reviewer?", "reviewer", True),
 ("@scout is still searching the codebase, so I'll wait.", "scout", False),
 ("Plan: I'll do the API, and @dev handles the UI later.", "dev", False),
 ("Thanks to @tester's fix, the suite is green now.", "tester", False),
 ("I merged what @reviewer approved yesterday.", "reviewer", False),
]
TEAMS = {"solo": "one agent alone is enough; the card is small or focused",
 "frontend-crew": "Frontend crew — UI work. Members: lead (plans), designer (CSS and layout), dev (React components)",
 "backend-crew": "Backend crew — APIs and data. Members: lead (plans), api (endpoints), db (schema and migrations)",
 "qa-squad": "QA squad. Members: lead (test plan), tester (e2e tests), fixer (fixes failures)"}
WF = {"freeform": "none of these workflows fits the card",
 "tdd": "TDD: 1. write a failing test 2. make it pass 3. refactor",
 "bug-hunt": "Bug hunt: 1. reproduce the bug 2. find the cause 3. fix it 4. add a regression test",
 "release": "Release: 1. bump version 2. update changelog 3. tag and publish"}
MODELS = {"default": "no preference; keep the usual model",
 "opus": "Opus — Most capable for complex work", "sonnet": "Sonnet — Efficient for routine tasks",
 "haiku": "Haiku — Fastest for quick answers"}
routing = {"team": {"type":"choice","instructions":"Which team of coding agents should take this card?","criteria":TEAMS},
 "workflow": {"type":"choice","instructions":"Which saved workflow should the agent follow for this card?","criteria":WF},
 "model": {"type":"choice","instructions":"Which AI model fits this card? Hard, broad or risky work needs the most capable model; small routine edits a fast one.","criteria":MODELS}}
route_cases = [
 ("[feature] Redesign the settings page with a new sidebar layout", {"team":"frontend-crew"}),
 ("[issue] Checkout crashes when the cart is empty", {"workflow":"bug-hunt"}),
 ("[task] Fix typo in README", {"team":"solo","model":"haiku"}),
 ("[task] Ship version 2.5 to npm", {"workflow":"release"}),
 ("[feature] Add a /v1/invoices REST endpoint with a new invoices table", {"team":"backend-crew"}),
 ("[task] Migrate the whole auth system from sessions to OAuth across all services", {"model":"opus"}),
 ("[task] Write e2e tests for the signup flow", {"team":"qa-squad"}),
 ("[feature] Add a date formatting helper, test first", {"workflow":"tdd"}),
]



def load_cases(extra):
    items = []  # (kind, state, questions, key, gold)
    for s, g in ending_cases:
        items.append(("ending", {"card": "task", "reply": s}, {"ending": ENDING}, "ending", g))
    for s, g in idle_cases:
        items.append(("textIdle", {"reply": s}, {"reply": IDLE}, "reply", g))
    for s, nm, g in addr_cases:
        items.append(("addressed", {"paragraph": s}, {"a": addr(nm)}, "a", g))
    for s, gold in route_cases:
        for k, g in gold.items():
            items.append(("card", {"card": s, "details": ""}, {k: routing[k]}, k, g))
    for line in open(extra) if extra else []:
        if not line.strip():
            continue
        c = json.loads(line)
        k = c["kind"]
        if k == "ending":
            items.append((k, {"card": "task", "reply": c["text"]}, {"ending": ENDING}, "ending", c["gold"]))
        elif k == "textIdle":
            items.append((k, {"reply": c["text"]}, {"reply": IDLE}, "reply", c["gold"]))
        elif k == "addressed":
            items.append((k, {"paragraph": c["text"]}, {"a": addr(c["name"])}, "a", c["gold"]))
        elif k == "card":
            q = c["question"]
            items.append((k, {"card": c["text"], "details": c.get("details", "")}, {q: routing[q]}, q, c["gold"]))
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("models", nargs="+", help="english, multilingual, typed-decisions")
    ap.add_argument("--cases", help="extra cases, JSONL")
    args = ap.parse_args()
    items = load_cases(args.cases)
    router = Router()
    for model in args.models:
        rows = {}
        for kind, state, questions, key, gold in items:
            a = router.predict(state, questions, model=model)["answers"][key]
            if "choice" in a:
                pred, conf = a["choice"], a.get("confidence", 0.0)
            else:
                p = a["noul"]
                pred, conf = p >= 0.5, max(p, 1 - p)
            rows.setdefault(kind, []).append((pred == gold, conf))
        print(f"== {model}")
        for kind, rs in rows.items():
            right = sum(ok for ok, _ in rs)
            worst_wrong = max([c for ok, c in rs if not ok], default=0.0)
            t = round(worst_wrong + 0.01, 2)
            kept = sum(1 for ok, c in rs if ok and c >= t)
            print(f"  {kind:10} top-1 {right}/{len(rs)}  suggested threshold {t} keeps {kept}/{right} right answers")


if __name__ == "__main__":
    main()
