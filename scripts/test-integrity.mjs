import ts from "typescript";

const TEST_DSL = new Set(["describe", "it", "test"]);
const DISABLED_DSL = new Set(["skip", "only", "todo", "skipIf"]);
const REVIEW_MARKER = /^\s*\/\/\s*test-contract-change:\s*(\S+)\s+(.+)$/mu;

function expressionName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node))
    return expressionName(node.expression) + "." + node.name.text;
  if (ts.isCallExpression(node)) return expressionName(node.expression);
  return "";
}

function testDslName(node) {
  let current = node;
  while (ts.isCallExpression(current)) current = current.expression;
  while (ts.isPropertyAccessExpression(current)) {
    const name = current.name.text;
    if (TEST_DSL.has(name)) return name;
    current = current.expression;
  }
  return ts.isIdentifier(current) && TEST_DSL.has(current.text) ? current.text : undefined;
}

function disabledDslName(node) {
  let current = node;
  while (ts.isCallExpression(current)) current = current.expression;
  while (ts.isPropertyAccessExpression(current)) {
    if (DISABLED_DSL.has(current.name.text)) {
      const dsl = testDslName(current.expression);
      if (dsl) return dsl + "." + current.name.text;
    }
    current = current.expression;
  }
  return undefined;
}

function staticTitle(node, source) {
  if (!node) return "<missing title>";
  if (
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    typeof node.text === "string"
  )
    return node.text;
  return node.getText(source).replace(/\s+/gu, " ").trim();
}

function normalized(node, source) {
  return node.getText(source).replace(/\s+/gu, " ").trim();
}

function assertionSignature(node, source) {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  const name = expressionName(callee);
  const args = node.arguments.map((argument) => normalized(argument, source)).join(",");
  if (name === "assert" || name.startsWith("assert.")) return name + "(" + args + ")";
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isCallExpression(callee.expression) &&
    expressionName(callee.expression.expression) === "expect"
  ) {
    const receiver = callee.expression.arguments[0];
    return (
      "expect(" +
      (receiver ? normalized(receiver, source) : "") +
      ")." +
      callee.name.text +
      "(" +
      args +
      ")"
    );
  }
  return undefined;
}

function isLiteral(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

function isAlwaysPassingAssertion(node) {
  if (!ts.isCallExpression(node)) return false;
  const name = expressionName(node.expression);
  if ((name === "assert.ok" || name === "assert") && node.arguments.length > 0) {
    if (node.arguments[0].kind === ts.SyntaxKind.TrueKeyword) return true;
  }
  if (/^assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)$/u.test(name)) {
    const [left, right] = node.arguments;
    if (left && right && isLiteral(left) && isLiteral(right))
      return normalized(left, node.getSourceFile()) === normalized(right, node.getSourceFile());
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isCallExpression(node.expression.expression) &&
    expressionName(node.expression.expression.expression) === "expect"
  ) {
    const actual = node.expression.expression.arguments[0];
    const expected = node.arguments[0];
    if (actual && expected && isLiteral(actual) && isLiteral(expected))
      return (
        normalized(actual, node.getSourceFile()) === normalized(expected, node.getSourceFile())
      );
  }
  return false;
}

export function analyzeTestSource(filePath, sourceText) {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) {
    return {
      tests: [],
      disabled: [],
      alwaysPassing: [],
      parseErrors: source.parseDiagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      ),
      reviewMarker: REVIEW_MARKER.exec(sourceText)?.[0],
    };
  }

  const tests = [];
  const disabled = [];
  const alwaysPassing = [];

  function walk(node, suites = []) {
    if (ts.isPropertyAccessExpression(node) && DISABLED_DSL.has(node.name.text)) {
      const dsl = testDslName(node.expression);
      if (dsl) disabled.push(dsl + "." + node.name.text);
    }

    if (ts.isCallExpression(node)) {
      const disabledName = disabledDslName(node.expression);
      if (disabledName) disabled.push(disabledName);
      const dsl = testDslName(node.expression);
      if (dsl === "describe" || dsl === "test" || dsl === "it") {
        const title = staticTitle(node.arguments[0], source);
        const callback = [...node.arguments]
          .reverse()
          .find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
        if (dsl === "describe") {
          if (callback) walk(callback.body, [...suites, title]);
          return;
        }
        const assertions = [];
        function collect(candidate) {
          if (ts.isCallExpression(candidate)) {
            const signature = assertionSignature(candidate, source);
            if (signature) assertions.push(signature);
            if (isAlwaysPassingAssertion(candidate)) {
              alwaysPassing.push([...suites, title].join(" > ") + ": " + candidate.getText(source));
            }
          }
          ts.forEachChild(candidate, collect);
        }
        if (callback) collect(callback.body);
        tests.push({
          title: [...suites, title].join(" > "),
          assertions: assertions.sort((a, b) => a.localeCompare(b)),
          filePath,
        });
        return;
      }
    }
    ts.forEachChild(node, (child) => walk(child, suites));
  }

  walk(source);
  return {
    tests,
    disabled,
    alwaysPassing,
    parseErrors: [],
    reviewMarker: REVIEW_MARKER.exec(sourceText)?.[0],
  };
}

function byTitle(tests) {
  const result = new Map();
  for (const entry of tests) {
    const group = result.get(entry.title) ?? [];
    group.push(entry);
    result.set(entry.title, group);
  }
  return result;
}

/** Compare changed test sources as one set so a test moved between files retains its identity. */
export function inspectTestSources(sourcePairs) {
  const before = [];
  const after = [];
  const newAnalyses = [];
  for (const pair of sourcePairs) {
    if (pair.oldSource !== undefined)
      before.push(...analyzeTestSource(pair.oldPath ?? pair.path, pair.oldSource).tests);
    if (pair.newSource !== undefined) {
      const analysis = analyzeTestSource(pair.newPath ?? pair.path, pair.newSource);
      after.push(...analysis.tests);
      newAnalyses.push({ path: pair.newPath ?? pair.path, ...analysis });
    }
  }

  const errors = [];
  const warnings = [];
  const deletedTests = [];
  const disabled = [];
  const alwaysPassing = [];
  const parseErrors = [];
  for (const analysis of newAnalyses) {
    disabled.push(...analysis.disabled.map((item) => analysis.path + ": " + item));
    alwaysPassing.push(...analysis.alwaysPassing.map((item) => analysis.path + ": " + item));
    parseErrors.push(...analysis.parseErrors.map((item) => analysis.path + ": " + item));
  }

  const oldByTitle = byTitle(before);
  const newByTitle = byTitle(after);
  for (const [title, oldGroup] of oldByTitle) {
    const candidates = [...(newByTitle.get(title) ?? [])];
    for (const oldTest of oldGroup) {
      const exactIndex = candidates.findIndex(
        (candidate) => JSON.stringify(candidate.assertions) === JSON.stringify(oldTest.assertions),
      );
      if (exactIndex >= 0) {
        candidates.splice(exactIndex, 1);
        continue;
      }
      if (candidates.length > 0) {
        const changed = candidates.shift();
        const marker = newAnalyses.find(
          (analysis) => analysis.path === changed.filePath,
        )?.reviewMarker;
        const change = 'Test "' + title + '" changed its assertion structure';
        if (marker) warnings.push(change + "; manual review required by " + marker.trim() + ".");
        else errors.push(change);
      } else {
        deletedTests.push(title);
      }
    }
  }

  if (disabled.length) errors.push("disabled-tests");
  if (alwaysPassing.length) errors.push("always-passing-assertions");
  if (parseErrors.length) errors.push("test-parse-errors");
  if (deletedTests.length) errors.push("reduced-test-coverage");

  return {
    errors,
    warnings,
    deletedTests,
    disabled,
    alwaysPassing,
    parseErrors,
    beforeCount: before.length,
    afterCount: after.length,
  };
}
