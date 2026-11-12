import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workflowDirectory = fileURLToPath(
  new URL("../.github/workflows/", import.meta.url),
);

// Detect checkout steps, including steps with a separate "name:" line.
// Each step ends before the next sibling "- name:" or "- uses:" marker.
export function unsafeCheckoutSteps(yaml) {
  const lines = yaml.split(/\r?\n/);
  const findings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s*(?:-\s*)?uses:\s*actions\/checkout@\S+/.test(line))
      continue;

    const indent = line.match(/^\s*/)[0].length;
    const stepIndent = /^\s*-\s*uses:/.test(line) ? indent : indent - 2;
    let end = index + 1;
    while (end < lines.length) {
      const sibling = lines[end].match(
        /^(\s*)-\s*(?:name|uses|run):/,
      );
      if (sibling && sibling[1].length <= stepIndent) break;
      end += 1;
    }

    const step = lines.slice(index + 1, end);
    const safe = step.some((entry) =>
      /^\s+persist-credentials:\s*false\s*(?:#.*)?$/.test(entry),
    );
    if (!safe) findings.push(index + 1);
  }
  return findings;
}

test("credential persistence guard rejects unsafe checkout configuration", () => {
  assert.deepEqual(
    unsafeCheckoutSteps(
      "steps:\n  - uses: actions/checkout@v7\n  - name: Test\n    run: echo ok\n",
    ),
    [2],
  );
  assert.deepEqual(
    unsafeCheckoutSteps(
      "steps:\n  - name: Checkout\n    uses: actions/checkout@v7\n    with:\n      persist-credentials: true\n",
    ),
    [3],
  );
  assert.deepEqual(
    unsafeCheckoutSteps(
      "steps:\n  - uses: actions/checkout@v7\n    with:\n      persist-credentials: false\n  - name: Test\n    run: echo ok\n",
    ),
    [],
  );
});

test("every repository workflow checkout disables credential persistence", () => {
  const workflows = readdirSync(workflowDirectory).filter((filename) =>
    /\.ya?ml$/.test(filename),
  );
  assert.ok(workflows.length > 0, "workflow directory must not be empty");

  let checkoutCount = 0;
  for (const filename of workflows) {
    const yaml = readFileSync(join(workflowDirectory, filename), "utf8");
    const checkoutLines = yaml
      .split(/\r?\n/)
      .filter((line) =>
        /^\s*(?:-\s*)?uses:\s*actions\/checkout@\S+/.test(line),
      );
    checkoutCount += checkoutLines.length;
    assert.deepEqual(
      unsafeCheckoutSteps(yaml),
      [],
      `${filename} contains checkout without persist-credentials: false`,
    );
  }
  assert.ok(checkoutCount > 0, "checkout security checks must examine steps");
});
