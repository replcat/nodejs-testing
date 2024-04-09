import * as inspector from "node:inspector";
import type { TestEvent } from "node:test/reporters";
import { isatty } from "node:tty";
import { inspect } from "node:util";
import { isMainThread } from "node:worker_threads";
import {
  format as prettyFormat,
  plugins as prettyFormatPlugins,
  type PrettyFormatOptions,
} from "pretty-format";
import { parse } from "stacktrace-parser";
import type { JsonFromReporter } from "./runner-protocol";

// Default options borrowed from jest-diff:
// https://github.com/jestjs/jest/blob/442c7f692e3a92f14a2fb56c1737b26fc663a0ef/packages/jest-diff/src/index.ts#L33
const {
  AsymmetricMatcher,
  DOMCollection,
  DOMElement,
  Immutable,
  ReactElement,
  ReactTestComponent,
} = prettyFormatPlugins;

const PLUGINS = [
  ReactTestComponent,
  ReactElement,
  DOMElement,
  DOMCollection,
  Immutable,
  AsymmetricMatcher,
];
const FORMAT_OPTIONS: PrettyFormatOptions = {
  plugins: PLUGINS,
};
const FALLBACK_FORMAT_OPTIONS = {
  callToJSON: false,
  maxDepth: 10,
  plugins: PLUGINS,
};

const stackObj = { stack: "" };
const stdoutWrite = process.stdout.write;

if (isMainThread && !isatty(0)) {
  if (!inspector.url()) {
    inspector.open(0, undefined, true);
  } else {
    if (process.env.NODE_OPTIONS?.includes("--inspect-publish-uid=http")) {
      process.stderr.write(`Debugger listening on ${inspector.url()}\n`);
    }
    inspector.waitForDebugger();
  }
}

// Kinda delicate thing to separate test tap output from output logged by tests.
// Node.js doesn't know about output that happens when running tests, so we put
// them in tap comments and include their location.
for (const channel of ["stderr", "stdout"] as const) {
  const ogWrite = process[channel].write;
  Object.assign(process[channel], {
    write(chunk: any, encoding: any, callback: any) {
      Error.captureStackTrace(stackObj);
      const stack = parse(stackObj.stack);

      const firstNotInternal = stack.findIndex(
        (s, i) => i > 0 && s.file?.startsWith("node:") === false,
      );
      const atTestRunner = stack.findIndex((s) => s.file?.includes("node:internal/test_runner"));

      // Treat this as a user log if there's an not `node:` internal log before
      // the first (if any) location from `node:internal/test_runner`
      if (firstNotInternal !== -1 && (atTestRunner === -1 || firstNotInternal < atTestRunner)) {
        chunk =
          JSON.stringify({
            type: "runner:log",
            chunk: chunk.toString(),
            sf: stack[firstNotInternal],
          } satisfies JsonFromReporter) + "\n";
      }

      return ogWrite.call(this, chunk, encoding, callback);
    },
  });
}

const RE_PRERENDERED_DIFF_LINE = /^\s*(actual|expected):\s*'(.+)',?$/gm;

const RE_RAW_ESCAPE_SEQUENCE = /(?<!\\)\\(u\{[^}]+\}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|.)/g;

const simpleEscapeSequences: Record<string, string> = {
  "n": "\n",
  "r": "\r",
  "t": "\t",
  "b": "\b",
  "f": "\f",
  "v": "\v",
  "0": "\0",
};

function rawEscapeSequenceToBytes(seq: string) {
  const [_backslash, first] = seq;
  const rest = seq.slice(2);

  if (first in simpleEscapeSequences) {
    return simpleEscapeSequences[first] + rest;
  }

  if (first === "x") {
    return String.fromCharCode(parseInt(rest, 16));
  }

  if (first === "u") {
    return (rest.startsWith("{"))
      ? String.fromCodePoint(parseInt(rest.slice(1, -1), 16))
      : String.fromCharCode(parseInt(rest, 16));
  }

  // maybe unreachable? but no obvious way to handle it at the moment
  return first + rest;
}

/**
 * Detect whether the assertion library has rendered the diff to a string, and
 * if so, extract the expected and actual values without unecessary outer quotes
 * or additional levels of escaping (... or else return undefined).
 * 
 * NOTES:
 * 
 * This seems unecessarily complicated (there are arguments to pretty-format
 * which would deal with the escaping issue, for example), but the problem is
 * that at this point it's really difficult to tell whether these properties are
 * string representations of other types, or just... strings.  And if they don't
 * correspond to simple strings in the test cases, then we want to trim off the
 * unecessary quotes before rendering the diff.
 * 
 * So the solution here is to render the error to a string and then extract the
 * inner string value from that. This has the unfortunate consequence of losing
 * the quotes around string-to-string comparisons, but fixes all other cases.
 * 
 * This is arguably an upstream problem and assertion libraries shouldn't be
 * rendering these things to strings in the first place, BUT... if you think
 * about the hoops that are being jumped through elsewhere in this file to get
 * pretty diffs, now that node has its own no-frills runner, libraries doing
 * this work themselves starts to seem reasonable? 
 * 
 * (i.e. the diffs should be able to show IN THE LIBRARY'S OWN TERMS why the
 * comparison was rejected, instead of showing a pretty diff with no actual
 * difference between the rendered expected and actual values, and leaving the
 * user scratching their head. Probably needs a convention where assertion
 * libraries add their own render functions to errors or something...)
 */
function extractPrerenderedDiff(cause: { expected: unknown, actual: unknown }) {
  if (typeof cause.actual !== "string" || typeof cause.expected !== "string") return

  // Extract the inner string value of the rendered diff properties of a string
  // representation of the assertion error... i.e. get lines like `actual:
  // '"Whatever {}"' (note the nested quoting) and extract new properties like
  // `{ actual: "Whatever {}" }` with one level of escaping removed.
  const result: Record<string, string> = {};
  for (const [_, key, value] of inspect(cause).matchAll(RE_PRERENDERED_DIFF_LINE)) {
    result[key] = value
      // replace raw singly-escaped sequences with their corresponding bytes
      .replaceAll(RE_RAW_ESCAPE_SEQUENCE, seq => rawEscapeSequenceToBytes(seq))
      // pop one level of escaping on whatever's left
      .replaceAll("\\\\", "\\");
  }

  if (result.actual !== undefined && result.expected !== undefined) {
    return {
      expected: result.expected,
      actual: result.actual,
    }
  }
}

module.exports = async function* reporter(source: AsyncGenerator<TestEvent>) {
  for await (const evt of source) {
    if (evt.type === "test:fail") {
      const err = evt.data.details.error as Error & { cause?: any };
      if (err.cause instanceof Error) {
        (err.cause as any)._message = err.cause.message;
        (err.cause as any)._stack = err.stack ? parse(err.stack) : undefined;
      }

      if (err.cause && "expected" in err.cause && "actual" in err.cause) {
        const prerendered = extractPrerenderedDiff(err.cause);
        if (prerendered) {
          err.cause.actual = prerendered.actual;
          err.cause.expected = prerendered.expected;
        } else {
          let actual = prettyFormat(err.cause.actual, FORMAT_OPTIONS);
          let expected = prettyFormat(err.cause.expected, FORMAT_OPTIONS);
          if (actual === expected) {
            actual = prettyFormat(err.cause.actual, FALLBACK_FORMAT_OPTIONS);
            expected = prettyFormat(err.cause.expected, FALLBACK_FORMAT_OPTIONS);
          }
          err.cause.actual = actual;
          err.cause.expected = expected;
        }
      }
    }

    stdoutWrite.call(process.stdout, JSON.stringify(evt) + "\n");
  }
};
