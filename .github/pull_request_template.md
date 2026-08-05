## What this changes

## Why

<!-- If it fixes a bug: what was the failure mode? -->

## What I ran, and what it printed

<!-- Paste real output. If checks SKIPPED, say so — a skipped run is not a pass. -->

```
$ node tests/execute-trades.test.js

```

- Platform tested on: <!-- linux / macos / windows / container -->

## Checklist

- [ ] Tests cover the new behaviour and I ran them **on a platform where nothing skips**
- [ ] `node --check` and `bash -n` pass on every script I touched
- [ ] Failure paths handled, and unreadable state fails **closed**
- [ ] No new path can place an order without a standing human approval
- [ ] The executor's `--allowedTools` is unchanged
- [ ] No secret can reach a prompt, a log, or an agent's output

## Risk

<!-- The strongest objection to merging this, and what would change your mind. -->
