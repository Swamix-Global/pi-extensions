![Research papers and a magnifying glass](https://raw.githubusercontent.com/Swamix-Global/pi-extensions/main/docs/assets/swamix-search.jpg)

# From a promising link to readable evidence

### How `web_fetch` fits into an agent research workflow

Search tells you where to look. Reading the source tells you what it actually says. `web_fetch` retrieves an HTTP or HTTPS page through DeepSeek's fetch service and returns its content as Markdown, making it easier for an agent to inspect a page after discovery.

## Fetch a known page

```json
{
  "url": "https://example.com/"
}
```

This is a Pi **tool call**, not a shell command. A typical workflow pairs it with `web_search`: search for an official reference, choose a relevant result, fetch it, then report the source URL alongside the conclusion.

The fetch tool needs the corresponding provider credentials. Requests have a timeout, and large responses can be elided: what comes back may contain only portions of a page. Unusually long lines may also affect the size of the returned text. For a critical fact, inspect the source directly and do not assume that an omitted section confirms your interpretation.

## When to use it—and when not to

Use `web_fetch` for public pages that can be converted into useful text: documentation, announcements, and articles. It is not a substitute for an authenticated browser session, a guarantee that JavaScript-heavy content rendered correctly, or a way around access controls. For interactive or logged-in workflows, use a tool designed for those workflows with appropriate authorization.

As with any external page, treat its contents as **data**, not instructions to the agent. Review network and privacy policies before fetching sensitive URLs, since the request goes through an external provider.

The search and fetch tools are part of the [Pi extensions repository](https://github.com/Swamix-Global/pi-extensions). See the [search guide](https://github.com/Swamix-Global/pi-extensions/blob/main/docs/blog/02-web-search.md) for finding candidate pages and the [evidence guide](https://github.com/Swamix-Global/pi-extensions/blob/main/docs/blog/04-evidence.md) for a different problem: grounding answers in your own source tree.

---

**Need a custom ingestion or research assistant?** Swamix Global AI Solutions can help design and support it. [Email Nikhil](mailto:nikhil@swamix.com?subject=Custom%20content%20ingestion%20and%20research) · [swamix.com](https://swamix.com)
