import { join } from "node:path";
import { build, type Plugin, type Rolldown } from "vite-plus";

const PREFIX = "virtual:browser/";
const entries: Record<string, string> = {
  boot: join(import.meta.dirname, "src/browser/boot.ts"),
  "service-worker": join(import.meta.dirname, "src/browser/service-worker.ts")
};

/**
 * Bundles the browser scripts of encrypted sites into strings the Worker serves, importable as `virtual:browser/boot` and `virtual:browser/service-worker`.
 */
export function browserScripts(): Plugin {
  return {
    name: "site-browser-scripts",
    resolveId(id) {
      if (id.startsWith(PREFIX) && id.slice(PREFIX.length) in entries) return `\0${id}`;
      return null;
    },
    async load(id) {
      if (!id.startsWith(`\0${PREFIX}`)) return null;
      const entry = entries[id.slice(PREFIX.length + 1)];
      const [output] = (await build({
        configFile: false,
        logLevel: "silent",
        build: { write: false, minify: true, emptyOutDir: false, lib: { entry, formats: ["iife"], name: "site", fileName: "script" } }
      })) as Rolldown.RolldownOutput[];
      const chunk = output.output.find((item) => item.type === "chunk");
      if (!chunk) throw new Error(`Could not bundle ${entry}`);
      for (const moduleId of chunk.moduleIds) this.addWatchFile(moduleId);
      return `export default ${JSON.stringify(chunk.code)};`;
    }
  };
}
