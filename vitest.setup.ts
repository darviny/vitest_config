import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { beforeEach, expect, type RunnerTask, type RunnerTestSuite } from "vitest";

/**
 * Test File
 */
const file = relative(process.cwd(), expect.getState().testPath ?? "");

/**
 * TypeScript Complier output
 */
const { stdout } = spawnSync("node_modules/.bin/tsc", ["--noEmit", "--pretty", "true"], { encoding: "utf8" });

/**
 * Compiler output formatted and the "Found N errors" summary removed.
 */
const [body] = stripVTControlCharacters(stdout).split(/^Found \d+ errors?/m);

/**
 * Type errors from this test file, each with its line number and full text.
 */
const errors = body
  .split(/^(?=.+:\d+:\d+ - error TS\d+)/m)
  .filter((block) => block.startsWith(`${file}:`))
  .map((block) => ({ line: Number(block.slice(file.length + 1).split(":")[0]), text: block.trimEnd() }));

/**
 * Helper Function: Collects every test and describe block in a suite, including nested suites.
 *
 * Preconditions:
 * - suite.tasks is the list of direct child tasks.
 *
 * Postconditions:
 * - The returned array contains every task in the suite and in nested suites.
 * - Each task appears before the tasks nested inside it.
 * - The original suite is unchanged.
 *
 * @param {RunnerTestSuite} suite the test file
 * @returns {RunnerTask[]} every test and describe block in the suite, flattened.
 */
function allTasks(suite: RunnerTestSuite): RunnerTask[] {
  return suite.tasks.flatMap((task) => [task, ...(task.type === "suite" ? allTasks(task) : [])]);
}

/**
 * Helper Function: Reports whether a type error on a given line belongs to a test.
 *
 * Preconditions:
 * - errorLine is the line number of a type error in test's file.
 *
 * Postconditions:
 * - Returns true when test, or a describe block that encloses test, starts on the nearest line at or above the error.
 * - Returns true when the error is above every test and describe block.
 * - Returns true when Vitest recorded no locations.
 * - Returns false when a different block owns the error.
 * - The original test is unchanged.
 *
 * @param {number} errorLine the line number of the type error.
 * @param {RunnerTask} test the test that may own the error.
 * @returns {boolean} true when the error belongs to test, or false when it does not.
 */
function belongsTo(errorLine: number, test: RunnerTask): boolean {
  const starts = allTasks(test.file).map((task) => task.location?.line ?? Number.POSITIVE_INFINITY);
  const owner = Math.max(...starts.filter((line) => line <= errorLine));
  if (owner === Number.NEGATIVE_INFINITY) return true;
  for (let task: RunnerTask | undefined = test; task; task = task.suite) {
    if (task.location?.line === owner) return true;
  }
  return false;
}

/**
 * Fails the current test when a type error belongs to it.
 *
 * Preconditions:
 * - errors lists the type errors parsed for this test file.
 *
 * Postconditions:
 * - On success, no listed error belongs to task, and the test continues.
 * - On failure, a TypeCheckError is thrown and the test does not continue.
 * - The original errors are unchanged.
 *
 * @param {RunnerTask} task the test that is about to run.
 * @returns {void}
 */
beforeEach(({ task }) => {
  const thisTaskErrors = errors.filter((error) => belongsTo(error.line, task));
  if (thisTaskErrors.length === 0) return;
  const lines = thisTaskErrors.map((error) => error.line);
  const summary = `Found ${thisTaskErrors.length} error(s) in ${file}, starting at line ${lines[0]}`;
  const error = new Error(`\n${thisTaskErrors.map((e) => e.text).join("\n\n")}\n\n\n${summary}\n`);
  error.name = "TypeCheckError";
  // A frameless stack: Vitest prints no code frame, and tests with the same
  // errors are reported together instead of repeating the output per test.
  error.stack = `TypeCheckError in ${file} at line ${lines.join(", ")}`;
  throw error;
});
