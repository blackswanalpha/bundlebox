// The prompt gate of prompt4.md W1: a fitted head over cheap prompt features,
// mirrored in Python, that decides only when it has beaten its base rate.
import { test } from "node:test";
import assert from "node:assert/strict";

test("promptFeatures: the regex is one feature, and a question is a feature too", async () => {
  const h = await import("../src/wire/hooks.js");
  const task = h.promptFeatures("fix the pre-read guard in src/wire/hooks.js so `isTask` returns nothing below the threshold");
  const question = h.promptFeatures("what does this design imply for the similarity() in heap.js?");
  assert.equal(task.task_shaped, 1); assert.equal(task.imperative, 1); assert.equal(task.path, 1); assert.equal(task.symbol, 1); assert.equal(task.question, 0);
  assert.equal(question.task_shaped, 0); assert.equal(question.question, 1); assert.equal(question.imperative, 0);
  assert.equal(h.promptFeatures("ok")["len~log"], 0.1099);
  assert.equal(h.promptFeatures("<pasted_content id=\"x\">\nfix it\n</pasted_content>").pasted, 1);
});

test("taskScore: the head's weights decide, and a head that errs toward firing keeps a low threshold", async () => {
  const h = await import("../src/wire/hooks.js");
  const head = { useful: true, threshold: 0.2, weights: { "@bias": -1, question: -3, task_shaped: 2, imperative: 1 } };
  const q = h.taskScore("what does this design imply for the similarity() in heap.js?", head);
  const t = h.taskScore("fix the pre-read guard in src/wire/hooks.js so it denies a quoted read", head);
  assert.ok(q < head.threshold, `a question scores ${q}`);
  assert.ok(t >= head.threshold, `a task scores ${t}`);
  assert.equal(h.taskScore("anything", { useful: false, weights: {} }), 0.5, "no weights is the coin");
});
