![A developer's workspace with a notebook and laptop](https://raw.githubusercontent.com/Swamix-Global/pi-extensions/main/docs/assets/swamix-hero-3-1-pro.jpg)

# Build AI agents that developers can actually operate

### A field guide to practical tools and modules from Swamix Global AI Solutions

The interesting part of an AI agent is not just the model. It is the surrounding engineering: how the agent runs code, finds information, substantiates a claim, coordinates work, and keeps a long conversation usable.

This collection is a tour of tools built around [Pi](https://github.com/badlogic/pi-mono), with examples you can adapt. It is written for developers who care about *what a system does*, what it does not do, and how to operate it responsibly.

> **Looking for a custom implementation or support?** [Email Nikhil](mailto:nikhil@swamix.com?subject=Custom%20AI%20agent%20implementation%20and%20support) or visit [swamix.com](https://swamix.com).

## Choose the right starting point

![Map of six complementary capabilities: execution, research, verification, delegation, context, and interface](https://raw.githubusercontent.com/Swamix-Global/pi-extensions/main/docs/assets/swamix-tool-map.svg)

| Need | Tool or module | Guide |
| --- | --- | --- |
| Run shell commands or Python | `script` | [One interface for Bash and Python](https://github.com/Swamix-Global/pi-extensions/blob/main/docs/blog/01-script.md) |
| Find relevant sources | `web_search` | [Search across providers](https://github.com/Swamix-Global/pi-extensions/blob/main/docs/blog/02-web-search.md) |
| Read a page | `web_fetch` | [Turn a URL into readable material](https://github.com/Swamix-Global/pi-extensions/blob/main/docs/blog/03-web-fetch.md) |
| Ground a code answer | `evidence` | [Ask questions with source-backed quotes](https://github.com/Swamix-Global/pi-extensions/blob/main/docs/blog/04-evidence.md) |
| Delegate bounded work | `subagentx` | [Coordinate specialist agents](https://github.com/Swamix-Global/pi-extensions/blob/main/docs/blog/05-subagentx.md) |
| Improve terminal readability | `sgai-formatter` | [Make agent output easier to scan](https://github.com/Swamix-Global/pi-extensions/blob/main/docs/blog/06-formatter.md) |
| Manage long conversations | `util-compaction` | [Manage context without pretending limits disappear](https://github.com/Swamix-Global/pi-extensions/blob/main/docs/blog/07-compaction.md) |
| Route chat context | Context router | [A deterministic approach to older tool history](https://github.com/Swamix-Global/pi-extensions/blob/main/docs/blog/08-context-router.md) |
| Explore sessions in a browser | Pi Web UI | [A local interface for Pi sessions](https://github.com/Swamix-Global/pi-extensions/blob/main/docs/blog/09-webui.md) |

## Start with the public extensions

The [Pi extensions repository](https://github.com/Swamix-Global/pi-extensions) documents requirements, installation, configuration, and source. From a checkout:

```sh
git clone https://github.com/Swamix-Global/pi-extensions.git
cd pi-extensions
bash install.sh
```

The shared installer deploys the scripting, formatter, compaction, and search extensions. Evidence and SubagentX have their own registration steps; see the [repository README](https://github.com/Swamix-Global/pi-extensions#install). Reload an already-open Pi session after installation. Use **one** installation method per extension to avoid duplicate registration.

The [context-router repository](https://github.com/Swamix-Global/pi-modules) is public. The Pi Web UI discussed here is a local module; no public source repository or general release is currently linked. Contact Swamix to discuss availability and implementation.

## A note on responsible use

These tools can execute commands, contact external services, and handle your source code or session data. Review permissions, provider credentials, network access, and log retention before use. They are developer tools, **not a security sandbox**. Examples illustrate interfaces; they are not performance guarantees or claims of production certification.

*The cover images in this series are AI-generated editorial illustrations, not screenshots of the tools or photographs of a particular workspace.*

---

**Swamix Global AI Solutions** · Practical AI engineering, tailored to your workflow<br>
[swamix.com](https://swamix.com) · [nikhil@swamix.com](mailto:nikhil@swamix.com?subject=Custom%20AI%20agent%20implementation%20and%20support)
