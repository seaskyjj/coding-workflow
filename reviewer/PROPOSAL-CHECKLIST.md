# Proposal / design review checklist (reasoning review, NOT code review)

This checklist is for reviewing **design docs, investigation write-ups, technical decisions/ADRs, "next-step direction" documents, and knowledge / methodology notes** — anything whose value is an *argument and a plan* (or a *claim and its evidence*), not executable code.

A normal code review asks "does this diff match the contract / authz / fail-closed checklist?" That mode is blind to a docs change, because a docs diff is just new prose — there is nothing to type-check or run. The failure modes here are different: a conclusion that does not follow from its evidence, a fix that targets an *attributed* cause instead of a *proven* one, a fabricated external constraint, a success metric that can be satisfied without achieving the real goal, or building ahead of a proven need.

**Your job is to pressure-test the reasoning, not to polish the writing.** Wording, typos, formatting, and section ordering are NOT findings. Do not pad. Every finding must attack the soundness of an argument, the alignment of a fix to a proven root cause, or an unexamined assumption/alternative.

Apply these lenses in order. Each maps to a finding `area`:

## R1_argument — reconstruct the argument chain
Restate the doc in the argument shape that fits its **type** — do not force every artifact into one template:
- investigation / proposed fix → 现象 → 证据 → 结论 → 方案 (phenomenon → evidence → conclusion → plan);
- decision record / ADR → problem → options → criteria → tradeoffs → decision → consequences;
- knowledge / methodology note → claim → source/evidence → scope/applicability → confidence → update trigger.

Pick the structure that matches the artifact; do not push a decision or knowledge doc into incident/root-cause form. For each inference: does the evidence actually support the conclusion, or is there a leap? What must be assumed for it to hold? For decision docs, are the options and tradeoffs real and complete (or is the "decision" pre-baked with strawman alternatives)? For knowledge docs, are source, scope, and confidence stated? Flag conclusions stated with false precision (e.g., p50/p95 from a handful of samples), or claims presented as established that are actually conjecture.

## R2_rootcause_fix — root-cause vs fix alignment
The doc proposes fixing X. Is X the **proven dominant** cause, or merely the **attributed** one? How much of the measured budget/effect is left **unexplained / unmeasured**? If the dominant bucket is a black box that was never decomposed, the fix may miss. Flag "fix is committed before the root cause is isolated."

## R3_disconfirm — cheapest disconfirming experiment
Before building the proposed solution, what is the smallest, cheapest experiment (often an hour) that could **falsify** the core hypothesis? Was it run? **If the doc's load-bearing conclusion or committed next step depends on an experiment that was not run, that unrun experiment is itself a finding** (fix = run experiment X first), not a `could_not_verify` caveat — demoting a decision-blocking unrun experiment to a caveat is the exact miss this lens exists to catch. Reserve `could_not_verify` for the experiment's *unknown result* or for non-load-bearing measurements. Flag "jumps to building before running the discriminating test" and name the experiment.

## R4_alternatives — alternative hypotheses & cheaper levers
Enumerate other plausible explanations for the phenomenon, and other levers that might dominate the proposed one. Were they considered and ruled out, or silently ignored? Flag missing candidates (especially cheaper or higher-leverage ones).

## R5_metric_gaming — success-criteria validity
Can the stated success metric / acceptance criteria be satisfied **without** achieving the real user goal? Are key anchors and definitions pinned down (timestamps, what "done" means, what is measured against what)? Flag goals framed as "structure changed" when the real target is "outcome improved," and undefined measurement anchors.

## R6_domain — domain grounding & fabricated constraints
Does the reasoning match known domain facts? Flag **invented constraints** (e.g., describing a self-chosen parameter as an external/vendor hard limit), **mislabeled technology** (e.g., conflating a transport with a codec), and conclusions that a domain expert would immediately question. Every domain-based finding must **label its own evidence source** — primary/vendor documentation, project-local evidence, reviewer prior knowledge, or an assumption that needs verification — so a model's prior knowledge is never passed off as a settled fact (the no-fake-constraints rule applies to the reviewer too). If the only basis is reviewer prior knowledge or an assumption, the fix is "verify this domain claim" (with how), not asserting it as settled. If a claim depends on domain knowledge the doc doesn't establish, say what to verify.

## R7_scope — over-engineering, premature abstraction, sequencing
Is the plan building ahead of a **proven** need? Premature generic frameworks/abstractions for hypothetical future cases? Is the cheapest sufficient option chosen, or is it gold-plating? Is the sequencing right (validate before build; small disconfirming step before large commit)? Apply any project overlay rules about scope/focus.

## R8_honesty — decision vs implemented; no fake "done"
Does the doc clearly separate **decided / targeted / planned** from **implemented**? Flag anything that reads as "done / available" when it is only a decision, a target, or a placeholder. Flag acceptance language that would let an unbuilt thing be marked complete. (This mirrors the project's no-fake-implementation discipline applied to docs.)

## Verdict guidance
- `approve` — reasoning is sound; at most low advisory notes.
- `approve_after_fixes` — the direction holds but has specific, addressable reasoning gaps (missing disconfirming experiment, unstated driver, undefined metric anchor) that should be closed before acting.
- `request_changes` — a load-bearing conclusion does not follow from the evidence, the fix targets an unproven cause, or there is a fabricated constraint / metric-gaming that would mislead the next step.
- `needs_human` — the proposal hinges on a domain/strategic judgment that a static reasoning review cannot settle, **or the supplied excerpt/diff is insufficient to reconstruct the load-bearing argument** (the changed portion depends on definitions, options, cited evidence, or metric definitions not present).

**Insufficient context fails closed.** When you are reviewing a diff/excerpt rather than the whole artifact and the changed portion cannot be reconstructed without surrounding context, do **not** approve: return `needs_human` (or a finding plus a `could_not_verify` entry) that asks for the full-document context. Approving a partial argument is the proposal-mode equivalent of approving a truncated code diff.

Be explicit in `could_not_verify` about what a reasoning review cannot settle (real-world measurements not yet taken, business/strategic calls, the *result* of an experiment that still needs to run, or full-document context you flagged as missing). Note: a cheap, decision-blocking experiment that was simply not run is a **finding** (see R3), not a `could_not_verify` entry.
