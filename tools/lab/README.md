# tools/lab — is a learned preference layer worth building?

An experiment, not a feature. Nothing here is part of the MCP surface, and nothing here writes into a
project. It exists to answer one question with numbers before any of the workflow-memory design gets
built on top of the answer.

```bash
npx tsx tools/lab/run.ts            # the report
npx tsx tools/lab/run.ts --digest   # also print the digest it built, so its size is verifiable
```

## What is being tested

The proposal was to build a small learned model — "more neurons as I talk, biases that change as you
tell me what we want" — so that a future session receives a compact learned preference instead of
reading thousands of tokens of notes. Three claims in that idea can be measured:

1. **The vocabulary can represent the judgements.** If a linear model over named features cannot even
   fit the corpus, the features are wrong and no training helps. (`fit check`)
2. **It predicts an unseen judgement.** Leave-one-out, reported with a Wilson interval, because n is
   small and a bare percentage would overstate what is known.
3. **Taste transfers between projects** — the owner's "one ensemble so future repos see my past
   decisions". Measured by training on one repo and testing on the other.

Two comparators keep the numbers honest: always answering the common label, and **untrained tag
voting** (each feature votes the polarity it carried, no training at all). If a trained model cannot
beat the untrained vote, the training is not earning its keep and the *vocabulary* is what is carrying.

## The corpus

`corpus.ts` holds 52 real judgements, every one quoted and attributed to the file it came from: the
blog's `handoff.md` decisions, its `HANDOFF-admin-hang.md` process rules, this repo's `AGENTS.md`, and
the playbook's own `avoid` and `do` entries. Each judgement carries **the reason it was made**, in the
owner's terms, because a bare "no" cannot generalise — the reason can. `reason.*` tags are the reason
expressed in the feature vocabulary.

**Caveat, stated up front:** the labelling here was done by an agent reading the artifacts, not by the
owner pressing approve or reject. Part of what the model learns is therefore the labeller's own
consistency, which inflates every score below. This corpus is a harness seed; real signal arrives as
explicit verdicts.

## First results (2026-10-15, 52 judgements, 36 tags, 12 couplings)

| arm | leave-one-out accuracy | 95% CI |
|---|---|---|
| always answer the common label | 63.5% | — |
| untrained tag voting | 76.9% | 63.9–86.3% |
| gradient-trained weights | 76.9% | 63.9–86.3% |
| gradient-trained + couplings | 75.0% | 61.8–84.8% |
| **evidence-weighted** | **78.8%** | 66.0–87.8% |
| evidence-weighted + couplings | 76.9% | 63.9–86.3% |

Cross-project (train on one repo, test on the other, n=26 each): evidence-weighted reaches **61.5%**
(mcp → blog) and **57.7%** (blog → mcp), against an always-guess baseline of 15.4% and 42.3%.

Fit check: the vocabulary represents the corpus at 100% with 37 parameters — the features are adequate,
so a failure elsewhere would be a training failure, not a vocabulary failure.

Context cost, per session:

| what a session reads today | chars | ~tokens |
|---|---|---|
| blog `handoff.md` | 11,900 | 2,975 |
| blog `HANDOFF-admin-hang.md` | 17,477 | 4,369 |
| `AGENTS.md` | 2,987 | 747 |
| `README.md` | 5,137 | 1,284 |
| **usual reading total** | **37,501** | **9,375** |
| the full playbook, every topic | 157,225 | 39,306 |
| **the digest this model produces** | **2,347** | **587** |

Token counts are the usual ~4 characters per token estimate, not a tokenizer.

## What the numbers say

- **Build the memory and the digest; do not build a net.** Receiving 587 tokens instead of 9,375 is a
  94% reduction, and it does not depend on the learning question at all. The playbook alone is ~39k
  tokens if read whole, which is the strongest argument for a digest that *points at* topics.
- **The vocabulary is doing the work, not the training.** Untrained tag voting matches or nearly
  matches the gradient-trained model. Keep the features; treat the training as unproven.
- **Evidence-weighted beats gradient-trained, and cannot overfit a single observation.** Plain training
  gave `reason.trust` a weight of −4.48 from two judgements; weighting each feature by its smoothed lift
  over the base rate removes that failure mode and scores slightly better.
- **The couplings do not pay yet.** They add a parameter each, they score worse at every size tested,
  and 3 of the 12 never fire. The idea is not disproven — it is unsupported at this amount of data.
- **Cross-project transfer is not established.** 57–62% with n=26 is better than guessing and worse than
  anything worth trusting. A shared vocabulary with per-project evidence is defensible; a shared prior
  across projects should wait for far more verdicts.

## Falsification rule

This harness is the learning curve, so it has to be able to say no:

- If, once real verdicts exist, leave-one-out stays within noise of untrained tag voting, **delete the
  learner** and keep the vocabulary, the evidence table and the digest.
- If cross-project accuracy does not climb as more projects contribute verdicts, **drop the ensemble
  prior** and keep memory strictly per project.
- If a tag never fires on a real verdict after N sessions, remove it from the vocabulary rather than
  carrying a parameter that only adds noise.

## Adding to the corpus

Append a `Judgement` with a real `source` and `reason`. Do not add an item without a reason: the reason
is the part that transfers, and an item without one teaches the model nothing it can use elsewhere.
