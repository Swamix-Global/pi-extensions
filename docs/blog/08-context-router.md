> **Published article:** [Read this guide on swamix.com](https://swamix.com/blog/pi-agent-context-router/).

![A ribbon passing through a brass guide beside folded paper](https://raw.githubusercontent.com/Swamix-Global/pi-extensions/main/docs/assets/swamix-router.jpg)

# A deterministic way to handle older tool history

### Inside the Pi context-router module

A long agent session can contain many old tool calls and results. They may have helped earlier turns, but forwarding every old tool block forever can make later requests heavier. The context router takes an explicit, inspectable approach: for supported chat routes, it removes older pre-turn tool-call/result pairs while keeping the newest complete pair and preserving conversation prose.

The policy is **stateless and unconditional**—not a token-budget trigger or a rolling summary. The router also handles historical media and repairs certain dangling tool-call/result entries. For a long single turn it may shed older complete tool groups while retaining the newest; prose is not cut. When there is nothing to strip, the documented behavior is to forward the request byte-identically.

## Why determinism matters

With identical input, a deterministic transformation is easier to reason about than a hidden, evolving frontier. It also helps teams compare behavior across runs. This is an engineering design goal, not a claim of a particular cache hit rate, token saving, or cost reduction. Measure provider usage in your own environment.

There are important boundaries. The documentation identifies the Responses API route `/codex/responses` as verbatim forwarding; do not assume chat-style stripping is applied there. Preserving prose and the newest tool group does not guarantee that a request fits the provider's context limit. Review the actual route and configuration before relying on the policy.

## Inspect a configured local service

The public [context-router repository](https://github.com/Swamix-Global/pi-modules) documents a local user-service deployment. On a machine where that service has already been set up, you can restart it and inspect counters:

```sh
systemctl --user restart pi-context-router
curl -s localhost:4141/stats
```

These are not a complete fresh-install recipe. Configuration, provider routing, credentials, network exposure, and service provisioning need to match your environment. The project documents manual verification with real Pi RPC turns; provider usage is the source for input and cache-read measurements, not the router's strip counters alone.

Read the [module README](https://github.com/Swamix-Global/pi-modules/blob/master/README.md) and [specification](https://github.com/Swamix-Global/pi-modules/blob/master/SPEC.md) for the actual routes and operating details.

---

**Need custom context routing or support for an existing agent stack?** [Contact Nikhil](mailto:nikhil@swamix.com?subject=Custom%20AI%20context%20routing) at Swamix Global AI Solutions · [swamix.com](https://swamix.com)
