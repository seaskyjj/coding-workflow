# Self-Hosted Runner Plan Input

Use this only after `ci-diagnose-pr.mjs` has classified repeated hosted-runner unavailability and local gate evidence contains machine-checkable coverage gaps showing why local CI is insufficient.

Required evidence:

- diagnostics JSON from `scripts/ci-diagnose-pr.mjs`;
- local gate JSON from `scripts/local-pr-gate.mjs`;
- operator note explaining the local-CI insufficiency context; this note is required, but it is not sufficient without coverage gaps in the local gate JSON;
- target host;
- runner labels;
- repo or organization scope;
- cleanup and secret-handling decision owned by the product repo/operator.

Example:

```bash
node "$CODING_WORKFLOW/scripts/self-hosted-runner-plan.mjs" \
  --diagnostics-json tmp/coding-workflow/ci-diagnostics/pr-123/ci-diagnostics.json \
  --local-gate-json tmp/coding-workflow/local-pr-gate/standard-stack/local-pr-gate.json \
  --local-ci-insufficient-note "Branch protection requires visible PR checks." \
  --target-host staging-runner-1 \
  --runner-labels self-hosted,linux,x64,staging \
  --repo-scope OWNER/REPO
```

Boundaries:

- implemented: evidence-gated plan generation;
- not implemented: automatic runner registration, GitHub runner token storage, production secret provisioning;
- human/operator step: create and use the ephemeral runner token interactively through GitHub.
