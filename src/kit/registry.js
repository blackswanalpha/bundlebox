// registry.js — named producers of derived artefacts.
//
// A producer is {name, group, description, inputs(), build()}: the paths the
// artefact is derived from, and the text to write. Naming the shape lets the
// runner report snapgen tables and oversight guidelines the same way, and lets
// the loader enumerate every artefact without importing the subsystem that
// wrote it. A producer without a description is a row in INDEX.md that says
// nothing, so `add` refuses it.
import path from "node:path";
import { uniq } from "../core/util.js";

/** Problems with one producer. Empty means usable. */
export function validate(job) {
  const bad = [];
  if (!job || typeof job !== "object") return ["not an object"];
  if (!job.name || !/^[\w.-]+$/.test(job.name)) bad.push("name missing or not a file stem");
  if (!job.description) bad.push(`${job.name}: no description; it is the text in every listing`);
  if (typeof job.inputs !== "function") bad.push(`${job.name}: inputs() is not a function`);
  if (typeof job.build !== "function") bad.push(`${job.name}: build() is not a function`);
  return bad;
}

export function makeRegistry(name, outDir, { title = "", blurb = "" } = {}) {
  const jobs = new Map();
  return {
    name, outDir, title: title || name, blurb, jobs,
    add(job) {
      const bad = validate(job);
      if (bad.length) throw new Error(`registry ${name}: ${bad.join("; ")}`);
      const full = { group: "", ext: "md", ...job };
      jobs.set(full.name, full);
      return full;
    },
    get: (n) => jobs.get(n) || null,
    has: (n) => jobs.has(n),
    names: (group = null) => [...jobs.values()].filter((j) => group == null || j.group === group).map((j) => j.name),
    groups: () => uniq([...jobs.values()].map((j) => j.group).filter(Boolean)).sort(),
    path: (n) => path.join(outDir, `${n}.${jobs.get(n)?.ext || "md"}`),
    validate: () => [...jobs.values()].flatMap(validate),
  };
}
