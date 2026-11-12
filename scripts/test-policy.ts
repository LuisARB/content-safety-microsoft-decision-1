import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const policy = await readFile(new URL("policies/moderation.xml", root), "utf8");
const decode = (text: string) => text.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&apos;", "'").replaceAll("&amp;", "&");
const candidates = [
  ...[...policy.matchAll(/(?:value|condition|code|counter-key)="([^"]*)"/g)].map(m => decode(m[1].replace(/\r\n|\r|\n|\t/g, " "))),
  ...[...policy.matchAll(/<set-body>([\s\S]*?)<\/set-body>/g)].map(m => decode(m[1])),
];
const expressions = [...new Set(candidates.filter(value => value.startsWith("@")))];
const literal = (text: string) => `@"${text.replaceAll('"', '""')}"`;
const generated = `using Newtonsoft.Json.Linq;
public static class Expressions {
  public static object Evaluate(string expression, Context context) {
    switch(expression) {
      ${expressions.map((expr, i) => `case ${literal(expr)}: return Eval${i}(context);`).join("\n")}
      default: throw new Exception("Uncompiled policy expression: " + expression);
    }
  }
  ${expressions.map((expr, i) => `static object Eval${i}(Context context) { ${expr.startsWith("@{") ? expr.slice(2, -1) : `return (${expr.slice(2, -1)});`} }`).join("\n")}
}`;
await writeFile(new URL("tests/PolicyHarness/Generated.cs", root), generated);
const result = spawnSync("dotnet", ["run", "--project", fileURLToPath(new URL("tests/PolicyHarness/PolicyHarness.csproj", root)), "--", fileURLToPath(new URL("policies/moderation.xml", root))], { stdio: "inherit", cwd: fileURLToPath(root) });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
