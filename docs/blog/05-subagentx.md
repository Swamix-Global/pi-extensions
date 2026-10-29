> **Published article:** [Read this guide on swamix.com](https://swamix.com/blog/subagentx-multi-agent-orchestration/).

![A notebook and laptop for organizing engineering work](https://raw.githubusercontent.com/Swamix-Global/pi-extensions/main/docs/assets/swamix-hero-3-1-pro.jpg)

# Delegate the work, keep ownership of the outcome

### Coordinating specialist agents with SubagentX

Parallel agents can make research faster, but a flood of unbounded tasks can make the result harder to trust. SubagentX is a Pi extension for handing a **bounded job** to a child agent and waiting for it to settle.

## Start with a clear contract

```json
{
  "slug": "inspect-search-schema",
  "title": "Inspect the search tool schema and report supported arguments",
  "contract": "task: Inspect the search tool schema and return supported arguments with source references."
}
```

This is a Pi tool-call argument object. A useful contract names the job, its scope, constraints, and the expected result. Ask for concise evidence; keep architecture decisions and integration under the parent's control.

A launch waits for the child run to settle. Text can stream while the child is working, but a partial report is **not** the same as a completed run. If you need to reattach to an existing run, provide its recorded stem through `run`.

## Model pools and failure

SubagentX can use an ordered model pool. Manage it through the settings command:

```text
/settings:subagentx show
/settings:subagentx add <provider/model>
/settings:subagentx set <provider/model>,<provider/model>
```

Fallback depends on the available configured models and the failure type; a one-model pool cannot provide model failover. Set concurrency and cost expectations deliberately, and do not assume every child has access to the same tools, credentials, or files. Leaf agents cannot recursively delegate through SubagentX.

## A practical pattern

For a repository change, give separate children independent questions: one traces the implementation, another checks tests, and a third reviews documentation. Reconcile their findings against source, make one owner responsible for each edit, and verify the integrated result. Parallelism is useful when it shortens independent research—not when it hides uncertainty.

Install from the [SubagentX package](https://github.com/Swamix-Global/pi-extensions/tree/main/tool-subagentx) using its documented installer, then reload Pi. Review model-provider costs, data handling, and access permissions for your environment.

---

**Want an agent workflow built around your team and tools?** Swamix Global AI Solutions offers custom implementation and support. [Email Nikhil](mailto:nikhil@swamix.com?subject=Custom%20multi-agent%20implementation) · [swamix.com](https://swamix.com)
