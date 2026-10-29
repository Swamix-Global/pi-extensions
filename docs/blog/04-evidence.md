![A magnifying glass over research notes](https://raw.githubusercontent.com/Swamix-Global/pi-extensions/main/docs/assets/swamix-search.jpg)

# Answers are better when you can inspect the evidence

### A practical introduction to the `evidence` tool

“Where is this behavior implemented?” is a deceptively hard question in a large codebase. A promising answer may omit a caller, cite an outdated comment, or confuse an implementation detail with a guarantee. The `evidence` tool is designed to make source-backed investigation more disciplined.

## Ask one focused question

```json
{
  "folder": "/absolute/path/to/repository",
  "question": "How does sendUserMessage handle cancellation?"
}
```

This is a Pi tool-call object. Replace the folder and symbol with the code you actually want to investigate. Narrow, concrete questions help the retrieval process select relevant windows. If you are unsure about the scope, use `listFiles: true` for the owning folder first.

The engine selects bounded source windows using question terms, asks a local model for relevant line ranges, and reconstructs quotations from the files themselves. Invalid ranges and unsupported absence claims are rejected. The result gives you paths, line references, source quotations, and any reported unknowns.

That design helps keep a quotation anchored to source—but it does **not** prove that every relevant file was found or that an interpretation is correct. Read cited spans before editing, follow callers when necessary, and re-ask a narrower question if the searched windows leave a gap.

## Where it helps

- **Debugging:** trace a concrete failure path or retry decision.
- **Refactoring:** identify callers and tests affected by a named signature.
- **Onboarding:** find where a specific behavior is decided.
- **Review:** separate what the code says from what someone inferred.

The extension and its CLI are in [`tool-query`](https://github.com/Swamix-Global/pi-extensions/tree/main/tool-query). Its model-backed extraction needs a configured local model endpoint; see the repository for installation and configuration. For the Pi tool, the installer is registered separately:

```sh
python3 tool-query/reinstall.py
```

Run that command from the extensions repository root, then reload an existing Pi session. Do not send sensitive repositories to a remote model endpoint without reviewing your organization's policies.

---

**Need source-grounded analysis for your codebase?** Swamix Global AI Solutions can help with custom implementation and support. [Contact Nikhil](mailto:nikhil@swamix.com?subject=Source-grounded%20AI%20analysis) · [swamix.com](https://swamix.com)
