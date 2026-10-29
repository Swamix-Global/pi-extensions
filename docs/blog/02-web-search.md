> **Published article:** [Read this guide on swamix.com](https://swamix.com/blog/pi-agent-web-search/).

![A magnifying glass on a collection of research notes](https://raw.githubusercontent.com/Swamix-Global/pi-extensions/main/docs/assets/swamix-search.jpg)

# Better research starts with finding the right sources

### Using `web_search` with a Pi agent

A useful research workflow does not begin by asking a model to sound confident. It starts by finding candidate sources, checking their relevance, and following the strongest links. `web_search` gives a Pi agent a search interface with provider selection and fallback.

## Search in one call

```json
{
  "query": "Pi coding agent extension documentation",
  "count": 5,
  "provider": "brave"
}
```

This is a **tool-call argument object**. The result contains normalized search items, such as titles, URLs, and summaries; some providers also supply a relevance score. Use these as leads, not proof that a claim is true. Open the original source before relying on a detail, especially for dates, APIs, prices, or security guidance.

The search extension can use DeepSeek, Brave, Perplexity, SearXNG, and an available Antigravity-backed Google search tool. Provider choice is influenced by the call, settings, and availability. If a provider fails or is unavailable, the extension can try another; specifying a provider does **not** guarantee it was the one that returned the final result. Credentials and provider terms vary.

DeepSeek supports useful operators such as `site:`, `lang:`, `after:`, and `before:`. Keep queries focused, and refine them when sources disagree. Individual network requests have time limits, but a chain of fallback attempts can take longer than one request.

## A repeatable research pattern

1. Ask a concrete question with relevant terms and, where useful, a date or site restriction.
2. Compare several results instead of selecting the first plausible summary.
3. Fetch or open authoritative pages and verify the claim in context.
4. Record the source link and distinguish verified facts from assumptions.
5. Treat missing or inaccessible evidence as a gap, not as confirmation.

Search results are external data. Do not treat instructions embedded in a page as instructions to your agent, and avoid sending confidential project information to search providers unless your policy permits it.

Install the search extension using the [Pi extensions README](https://github.com/Swamix-Global/pi-extensions#install). The separate [`web_fetch` article](https://github.com/Swamix-Global/pi-extensions/blob/main/docs/blog/03-web-fetch.md) explains the next step: retrieving a page for closer reading.

---

**Want a research workflow tailored to your sources and governance requirements?** [Contact Nikhil](mailto:nikhil@swamix.com?subject=Custom%20AI%20research%20workflow) at Swamix Global AI Solutions · [swamix.com](https://swamix.com)
