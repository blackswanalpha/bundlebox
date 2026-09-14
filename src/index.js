// index.js — the programmatic surface. `import { scan, pinpoint } from "bundlebox"`.
// Everything is lazy so importing the package never walks a tree or spawns.
export const lazy = (file, name) => async (...a) => { const m = await import(file); return (name ? m[name] : m.default)(...a); };
export const config = () => import("./core/config.js");
export const paths = () => import("./core/paths.js");
export const estimate = () => import("./tokens/estimate.js");
export const prices = () => import("./tokens/prices.js");
export const detectors = () => import("./detectors/index.js");
export const compile = () => import("./compile/compiler.js");
export const context = () => import("./compile/context.js");
export const route = () => import("./route/router.js");
export const run = () => import("./run/runner.js");
export const adapters = () => import("./adapters/index.js");
export const snapgen = () => import("./snapgen/index.js");
export const pinpoint = () => import("./pinpoint/index.js");
export const oversight = () => import("./oversight/index.js");
export const pipeline = () => import("./pipeline/runner.js");
export const buckmaster = () => import("./buckmaster/index.js");
export const session = () => import("./tokens/session.js");
export const mcp = () => import("./mcp/server.js");
export { main as cli } from "./cli.js";
