/**
 * electron-builder beforeBuild hook, run once per platform/arch being packaged. It prepares what the
 * installer ships outside app.asar (see the `extraResources` in package.json):
 *   vendor/zlib/<os>-<arch>/                 → resources/zlib          (heartleo/zlib CLI)
 *   vendor/node/<os>-<arch>/                 → resources/node          (Node.js for the DeepSeek Harness)
 *   vendor/runtime/<os>-<arch>/node_modules  → resources/node_modules  (production dependencies)
 * Returning false tells electron-builder that node_modules are handled here, so it neither collects
 * nor rebuilds them (every native dependency is a prebuilt N-API module).
 */
import { fetchBinary } from "./fetch-binaries.mjs";
import { stageRuntime } from "./stage-runtime.mjs";

export default async function beforeBuild({ platform, arch }) {
  const target = `${platform.buildConfigurationKey}-${arch}`;
  await fetchBinary("zlib", target);
  await fetchBinary("node", target);
  stageRuntime(target);
  return false;
}
