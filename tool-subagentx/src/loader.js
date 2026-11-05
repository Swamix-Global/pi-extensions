import { statSync } from "node:fs";
let generation = 0;
export default async function (pi) {
  const url = new URL("./reloadable/tool-subagentx.js", import.meta.url);
  url.searchParams.set("version", `${statSync(url).mtimeMs}-${Date.now()}-${generation++}`);
  const module = await import(url.href);
  return module.default(pi);
}
