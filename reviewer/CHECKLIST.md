# Reviewer checklist (the lens)

Generic "look at the diff" review misses the bugs that actually ship. Review through these **recurring bug classes** — each is a class that passed typecheck + existing tests in real projects and still shipped a bug. For every applicable item, the expected output is a finding **plus the regression test that would catch it**.

## A. Authz / tenant invariants (highest-value)

For every **new or changed write endpoint / mutation**:
- [ ] Role gate: is the caller's role allowed? Is there a **negative** case (wrong role → denied)?
- [ ] Tenant/owner scope: is the write scoped to the caller's tenant (gym/org/user), and **forced server-side** (not taken from a client-supplied id)?
- [ ] **Referenced-id ownership**: if the row references other ids (e.g. assign coach X to user Y), are X and Y validated to belong to the caller's tenant? (Row-level policies often check only the row's own tenant id, not referenced ids.)
- [ ] Does DB-level RLS/constraint hold **independently** of the app-layer check (defense in depth)? Or does a missed app check become a data leak?
- [ ] Audit log written for the mutation?

## B. Cross-layer contract drift

- [ ] Client and server agree on required/optional fields, types, enums. Did a field become required on one side but stay optional on the other?
- [ ] Is the contract derived from a **single source** (shared types/schema), or hand-duplicated (drift risk)?
- [ ] Is there a test exercising the **real** client→server path (not just each side in isolation)?
- [ ] Dead fallbacks: did a new hard requirement make an old `?? fallback` unreachable / misleading?

## C. Policy invariants (product/compliance)

- [ ] Output-cleanliness: does a user-facing projection leak fields it must not (internal confidence, quality flags, raw enums like `needs_review`, internal UUIDs, debug metadata)? Is there a **property test** asserting the projection contains none of these?
- [ ] Fail-closed: revoked consent / unconfirmed identity / unsupported source / missing model → does it **block**, not silently proceed or fake a result?
- [ ] Provenance honesty: is data labeled by its true source (no manual input relabeled as a system signal, no stub presented as production)?

## D. Visual / UX (unit tests can't see these)

- [ ] Rendered at the **real target widths** (phone / tablet / desktop). Does it stretch with no max-width container? Do charts' bars and labels align? Empty/2-col grids leave broken gaps?
- [ ] Does any **dev-only affordance** (debug banner, dev OTP echo, internal ids) leak into the production/user view?
- [ ] Is a critical control (e.g. logout) hosted only inside something slated for removal (e.g. a dev banner)?

## E. Reliability / data lifecycle

- [ ] Idempotency on retries; correct soft-delete vs hard-delete per policy; GC respects legal-hold; backoff on failure.
- [ ] Worker/service writes not broken by new RLS write policies (service-context escape present).

## Verdict

End with one of: `approve` / `approve_after_fixes` / `request_changes` / `needs_human` (use `needs_human` for security, irreversible, or architectural calls). For each finding give: **severity** (high/med/low), **area** (A–E), **file:line**, **why it matters**, **concrete fix**, and **the test that should encode it**.

Be honest about what you could NOT verify (e.g. "did not render visually", "did not run the suite"). Do not pad with low-value style nits — prioritize the classes above.
