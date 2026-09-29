import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Windows-authored text usually reaches Linux intact, but a handful of artifacts
// survive the trip and only break once a Linux tool reads them: a UTF-8 BOM, a
// file saved as GBK or UTF-16 instead of UTF-8, invisible formatting characters
// pasted from Word, or CRLF endings in a file Linux executes line by line.
//
// Each rule reads the source that can answer it truthfully:
//   - Encoding rules read the working tree, so a file is caught before it is even
//     staged. Line endings are the exception: on Windows `core.autocrlf` rewrites
//     them during checkout, so the working tree can no longer show what Linux
//     would receive and those rules read the staged blobs instead.
//   - In CI the working tree and the index hold the same content, so both sources
//     describe exactly the commit under test.

const failures = [];
const MAX_FINDINGS_PER_RULE = 5;
const BATCH_SIZE = 256;

const BINARY_SUFFIX =
  /\.(?:png|jpe?g|gif|bmp|ico|webp|avif|exe|dll|so|dylib|bin|tar|tgz|gz|bz2|xz|zip|7z|rar|pdf|db|sqlite3?|woff2?|ttf|otf|eot|mp[34]|m4a|wav|ogg|webm|mov|avi|wasm|node|p12|pfx|jks|keystore)$/i;

// UTF-8 bytes that a Windows code page read as Latin-1/CP1252 and then re-encoded
// as UTF-8: the lead byte lands in U+00C2..U+00F4 and the continuation byte lands
// in the C1 controls or one of the CP1252 punctuation slots.
const MOJIBAKE =
  /[\u00c2-\u00f4][\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018\u2019\u201a\u201c\u201d\u201e\u2020\u2021\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/g;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u00ad\ufeff]/g;
const REPLACEMENT = /\ufffd/g;

// Files whose content Linux interprets line by line, where a trailing \r is
// either a syntax error or silently ends up inside a value.
const LINE_ORIENTED =
  /(?:^|\/)(?:Makefile|makefile|GNUmakefile|Dockerfile|\.npmrc|\.env(?:\.[^/]*)?|docker-compose[^/]*\.ya?ml)$|\.(?:sh|bash|zsh|fish|ksh|mk)$/;

function fail(message) {
  failures.push(message);
}

function git(args, options = {}) {
  const result = spawnSync("git", args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? ""}`);
  }
  return result;
}

function stagedEntries() {
  const entries = new Map();
  for (const record of git(["ls-files", "--stage", "-z"], { encoding: "utf8" }).stdout.split(
    "\0",
  )) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    const [mode, object, stage] = record.slice(0, separator).split(" ");
    if (entries.has(record.slice(separator + 1))) continue;
    entries.set(record.slice(separator + 1), { mode, object, stage });
  }
  return entries;
}

function readBlobs(objects) {
  const blobs = new Map();
  for (let start = 0; start < objects.length; start += BATCH_SIZE) {
    const batch = objects.slice(start, start + BATCH_SIZE);
    const output = git(["cat-file", "--batch"], {
      input: `${batch.join("\n")}\n`,
      maxBuffer: 512 * 1024 * 1024,
    }).stdout;
    let offset = 0;
    while (offset < output.length) {
      const lineEnd = output.indexOf(0x0a, offset);
      if (lineEnd === -1) break;
      const header = output.toString("utf8", offset, lineEnd).split(" ");
      if (header.length !== 3) {
        offset = lineEnd + 1;
        continue;
      }
      const [object, type, size] = header;
      const contentStart = lineEnd + 1;
      if (type === "blob") {
        blobs.set(object, output.subarray(contentStart, contentStart + Number(size)));
      }
      offset = contentStart + Number(size) + 1;
    }
  }
  return blobs;
}

function lineOf(text, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (text.charCodeAt(position) === 0x0a) line += 1;
  }
  return line;
}

function reportMatches(path, rule, text, pattern, describe) {
  const findings = new Map();
  for (const match of text.matchAll(pattern)) {
    const finding = `line ${lineOf(text, match.index)}: ${describe(match[0])}`;
    findings.set(finding, (findings.get(finding) ?? 0) + 1);
  }
  if (findings.size === 0) return;
  const listed = [...findings].slice(0, MAX_FINDINGS_PER_RULE);
  const hidden =
    [...findings.values()].reduce((total, count) => total + count, 0) -
    listed.reduce((total, [, count]) => total + count, 0);
  const suffix = hidden > 0 ? ` (and ${hidden} more)` : "";
  const details = listed.map(([finding, count]) =>
    count > 1 ? `${finding} (x${count})` : finding,
  );
  fail(`${path} ${rule}${suffix}: ${details.join("; ")}`);
}

function lineEndingProfile(buffer) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0d) {
      if (buffer[index + 1] === 0x0a) {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (buffer[index] === 0x0a) {
      lf += 1;
    }
  }
  return { crlf, lf, cr };
}

function checkPathName(path) {
  if (REPLACEMENT.test(path)) {
    fail(`${path} is not a valid UTF-8 path; rename it from a UTF-8 locale.`);
  }
  // eslint-disable-next-line no-control-regex -- control characters in a path are the finding
  if (/[\u0000-\u001f]/.test(path)) {
    fail(`${path} contains control characters in its name.`);
  }
}

function checkStagedEndings(path, blob) {
  const endings = lineEndingProfile(blob);
  const isLineOriented = LINE_ORIENTED.test(path) || (blob[0] === 0x23 && blob[1] === 0x21);
  if (endings.crlf > 0 && isLineOriented) {
    fail(
      `${path} uses CRLF line endings; Linux reads the trailing \\r as part of the line and fails. Commit it with LF endings.`,
    );
  }
  if (endings.crlf > 0 && endings.lf > 0) {
    fail(`${path} mixes CRLF and LF line endings; normalize the whole file to one ending.`);
  }
  if (endings.cr > 0) {
    fail(`${path} uses bare CR line endings; Linux tools expect LF.`);
  }
}

function checkWorkingTreeText(path, buffer) {
  const leading = buffer.subarray(0, 4).toString("hex");
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let text;
  try {
    text = utf8.decode(buffer);
  } catch {
    if (leading.startsWith("fffe") || leading.startsWith("feff")) {
      fail(`${path} is UTF-16 encoded; save it as UTF-8 so Linux tools can read it.`);
    } else {
      fail(
        `${path} is not valid UTF-8 (first bytes ${leading}); save it as UTF-8 instead of a Windows code page such as GBK.`,
      );
    }
    return;
  }

  // TextDecoder strips a leading BOM, so it can only be detected on the bytes.
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    fail(
      `${path} starts with a UTF-8 BOM (EF BB BF); strip it, because Linux shebangs, JSON parsers and diffs treat it as content.`,
    );
  }
  if (buffer.includes(0)) {
    fail(`${path} contains NUL bytes; a Windows editor most likely saved it as UTF-16.`);
  }

  reportMatches(path, "contains mojibake", text, MOJIBAKE, () => "double-encoded UTF-8 bytes");
  reportMatches(
    path,
    "contains invisible characters",
    text,
    INVISIBLE,
    (match) => `U+${match.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
  );
  reportMatches(path, "contains replacement characters", text, REPLACEMENT, () => "U+FFFD");
}

const entries = stagedEntries();
const blobs = readBlobs([...new Set([...entries.values()].map((entry) => entry.object))]);

let checked = 0;
for (const [path, entry] of entries) {
  checkPathName(path);
  if (BINARY_SUFFIX.test(path)) continue;
  checked += 1;

  const staged = blobs.get(entry.object);
  if (staged) checkStagedEndings(path, staged);

  let workingTree;
  try {
    workingTree = readFileSync(path);
  } catch {
    continue; // deleted or unreadable on disk; the staged blob was still checked
  }
  checkWorkingTreeText(path, workingTree);
}

if (failures.length > 0) {
  console.error("Text portability checks failed:");
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log(`Text portability checks passed for ${checked} text files.`);
