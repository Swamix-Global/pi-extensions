![An engineering notebook on a desk](https://raw.githubusercontent.com/Swamix-Global/pi-extensions/main/docs/assets/swamix-hero-3-1-pro.jpg)

# Long conversations need an explicit context strategy

### What `util-compaction` does—and what it cannot promise

An agent that works across many turns accumulates instructions, messages, and tool results. Eventually that history can compete with the available context window. `util-compaction` helps manage that pressure by invoking Pi's native compaction when estimated context reaches a configured threshold.

## Use the built-in settings

```text
/settings:util-compaction
/settings:util-compaction on
/settings:util-compaction off
/settings:util-compaction <tokens>
```

The default proactive threshold is 100,000 estimated tokens. Compaction is triggered after the agent settles, not as an exact guarantee of what the next provider request will contain. The package also contains context-output safety handling to limit model-visible tool text.

The important distinction: **a threshold is not a promise that every request fits**. Providers count tokens differently, large indivisible messages may remain, and preserved instructions still need room. A good system should fail clearly when it cannot fit rather than silently remove critical instructions.

## Operate it with measurements

1. Establish what your provider actually reports for input, cached input, and output.
2. Observe representative multi-turn workflows, not just a single prompt.
3. Keep full output or logs outside the model-visible context where appropriate.
4. Test compaction, recovery, and failure paths before changing production settings.
5. Treat cache and cost improvements as measured results, not assumptions.

The [context-router article](https://github.com/Swamix-Global/pi-extensions/blob/main/docs/blog/08-context-router.md) describes a separate, deterministic approach to older tool history. The two components have different responsibilities; neither turns a context window into an unlimited resource.

Install from the [Pi extensions repository](https://github.com/Swamix-Global/pi-extensions) and reload an existing session. Consult the implementation and project documentation before changing thresholds or deploying to a different environment.

---

**Need help with long-running agent workflows and context management?** [Email Nikhil](mailto:nikhil@swamix.com?subject=AI%20context%20management%20and%20support) at Swamix Global AI Solutions · [swamix.com](https://swamix.com)
