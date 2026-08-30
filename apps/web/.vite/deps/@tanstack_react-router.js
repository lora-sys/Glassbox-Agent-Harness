"use client";
import {
  require_jsx_runtime,
  require_with_selector
} from "./chunk-6J7FWL6K.js";
import {
  require_react
} from "./chunk-SWUHRK3E.js";
import {
  __toESM
} from "./chunk-QKQ6FTX6.js";

// ../../node_modules/@tanstack/react-router/dist/esm/utils.js
var React$1 = __toESM(require_react(), 1);

// ../../node_modules/@tanstack/router-core/dist/esm/not-found.js
function notFound(options = {}) {
  options.isNotFound = true;
  if (options.throw) throw options;
  return options;
}
function isNotFound(obj) {
  return obj?.isNotFound === true;
}

// ../../node_modules/@tanstack/router-core/dist/esm/root.js
var rootRouteId = "__root__";

// ../../node_modules/@tanstack/router-core/dist/esm/redirect.js
function redirect(opts) {
  opts.statusCode = opts.statusCode || opts.code || 307;
  if (!opts.reloadDocument && typeof opts.href === "string") try {
    new URL(opts.href);
    opts.reloadDocument = true;
  } catch {
  }
  const headers = new Headers(opts.headers);
  if (opts.href && headers.get("Location") === null) headers.set("Location", opts.href);
  const response = new Response(null, {
    status: opts.statusCode,
    headers
  });
  response.options = opts;
  if (opts.throw) throw response;
  return response;
}
function isRedirect(obj) {
  return obj instanceof Response && !!obj.options;
}

// ../../node_modules/@tanstack/router-core/dist/esm/utils.js
function last(arr) {
  return arr[arr.length - 1];
}
function functionalUpdate(updater, previous) {
  if (typeof updater === "function") return updater(previous);
  return updater;
}
var hasOwn = Object.prototype.hasOwnProperty;
var isEnumerable = Object.prototype.propertyIsEnumerable;
function hasKeys(obj) {
  for (const key in obj) if (hasOwn.call(obj, key)) return true;
  return false;
}
var createNull = () => /* @__PURE__ */ Object.create(null);
var nullReplaceEqualDeep = (prev, next) => replaceEqualDeep(prev, next, createNull);
function replaceEqualDeep(prev, _next, _makeObj = () => ({}), _depth = 0) {
  if (isServer) return _next;
  if (prev === _next) return prev;
  if (_depth > 500) return _next;
  const next = _next;
  const array = isPlainArray(prev) && isPlainArray(next);
  if (!array && !(isPlainObject(prev) && isPlainObject(next))) return next;
  const prevItems = array ? prev : getEnumerableOwnKeys(prev);
  if (!prevItems) return next;
  const nextItems = array ? next : getEnumerableOwnKeys(next);
  if (!nextItems) return next;
  const prevSize = prevItems.length;
  const nextSize = nextItems.length;
  const copy = array ? new Array(nextSize) : _makeObj();
  let equalItems = 0;
  for (let i = 0; i < nextSize; i++) {
    const key = array ? i : nextItems[i];
    const p = prev[key];
    const n = next[key];
    if (p === n) {
      copy[key] = p;
      if (array ? i < prevSize : hasOwn.call(prev, key)) equalItems++;
      continue;
    }
    if (p === null || n === null || typeof p !== "object" || typeof n !== "object") {
      copy[key] = n;
      continue;
    }
    const v = replaceEqualDeep(p, n, _makeObj, _depth + 1);
    copy[key] = v;
    if (v === p) equalItems++;
  }
  return prevSize === nextSize && equalItems === prevSize ? prev : copy;
}
function getEnumerableOwnKeys(o) {
  const keys = Object.keys(o);
  if (keys.length !== Object.getOwnPropertyNames(o).length) return false;
  const symbols = Object.getOwnPropertySymbols(o);
  if (symbols.length === 0) return keys;
  for (const symbol of symbols) {
    if (!isEnumerable.call(o, symbol)) return false;
    keys.push(symbol);
  }
  return keys;
}
function isPlainObject(o) {
  if (!hasObjectPrototype(o)) return false;
  const ctor = o.constructor;
  if (typeof ctor === "undefined") return true;
  const prot = ctor.prototype;
  if (!hasObjectPrototype(prot)) return false;
  if (!prot.hasOwnProperty("isPrototypeOf")) return false;
  return true;
}
function hasObjectPrototype(o) {
  return Object.prototype.toString.call(o) === "[object Object]";
}
function isPlainArray(value) {
  return Array.isArray(value) && value.length === Object.keys(value).length;
}
function deepEqual(a, b, opts) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0, l = a.length; i < l; i++) if (!deepEqual(a[i], b[i], opts)) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ignoreUndefined = opts?.ignoreUndefined ?? true;
    if (opts?.partial) {
      for (const k in b) if (!ignoreUndefined || b[k] !== void 0) {
        if (!deepEqual(a[k], b[k], opts)) return false;
      }
      return true;
    }
    let aCount = 0;
    if (!ignoreUndefined) aCount = Object.keys(a).length;
    else for (const k in a) if (a[k] !== void 0) aCount++;
    let bCount = 0;
    for (const k in b) if (!ignoreUndefined || b[k] !== void 0) {
      bCount++;
      if (bCount > aCount || !deepEqual(a[k], b[k], opts)) return false;
    }
    return aCount === bCount;
  }
  return false;
}
function createControlledPromise(onResolve) {
  let resolveLoadPromise;
  let rejectLoadPromise;
  const controlledPromise = new Promise((resolve, reject) => {
    resolveLoadPromise = resolve;
    rejectLoadPromise = reject;
  });
  controlledPromise.status = "pending";
  controlledPromise.resolve = (value) => {
    controlledPromise.status = "resolved";
    controlledPromise.value = value;
    resolveLoadPromise(value);
    onResolve?.(value);
  };
  controlledPromise.reject = (e) => {
    controlledPromise.status = "rejected";
    rejectLoadPromise(e);
  };
  return controlledPromise;
}
function isModuleNotFoundError(error) {
  if (typeof error?.message !== "string") return false;
  return error.message.startsWith("Failed to fetch dynamically imported module") || error.message.startsWith("error loading dynamically imported module") || error.message.startsWith("Importing a module script failed");
}
function findLast(array, predicate) {
  for (let i = array.length - 1; i >= 0; i--) {
    const item = array[i];
    if (predicate(item)) return item;
  }
}
var PATH_UNSAFE_RE = /[\x00-\x1f\x7f"<>`{}]/g;
function sanitizePathSegment(segment) {
  return segment.replace(PATH_UNSAFE_RE, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}
function decodeSegment(segment) {
  let decoded;
  try {
    decoded = decodeURI(segment);
  } catch {
    decoded = segment.replaceAll(/%[0-9A-F]{2}/gi, (match) => {
      try {
        return decodeURI(match);
      } catch {
        return match;
      }
    });
  }
  return sanitizePathSegment(decoded);
}
var DEFAULT_PROTOCOL_ALLOWLIST = [
  "http:",
  "https:",
  "mailto:",
  "tel:"
];
function isDangerousProtocol(url, allowlist) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return !allowlist.has(parsed.protocol);
  } catch {
    return false;
  }
}
var HTML_ESCAPE_LOOKUP = {
  "&": "\\u0026",
  ">": "\\u003e",
  "<": "\\u003c",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029"
};
var HTML_ESCAPE_REGEX = /[&><\u2028\u2029]/g;
function escapeHtml(str) {
  return str.replace(HTML_ESCAPE_REGEX, (match) => HTML_ESCAPE_LOOKUP[match]);
}
function decodePath(path) {
  if (!path) return {
    path,
    handledProtocolRelativeURL: false
  };
  if (!/[%\\\x00-\x1f\x7f]/.test(path) && !path.startsWith("//")) return {
    path,
    handledProtocolRelativeURL: false
  };
  const re = /%25|%5C/gi;
  let cursor = 0;
  let result = "";
  let match;
  while (null !== (match = re.exec(path))) {
    result += decodeSegment(path.slice(cursor, match.index)) + match[0];
    cursor = re.lastIndex;
  }
  result = result + decodeSegment(cursor ? path.slice(cursor) : path);
  let handledProtocolRelativeURL = false;
  if (result.startsWith("//")) {
    handledProtocolRelativeURL = true;
    result = "/" + result.replace(/^\/+/, "");
  }
  return {
    path: result,
    handledProtocolRelativeURL
  };
}
function encodePathLikeUrl(path) {
  if (!/\s|[^\u0000-\u007F]/.test(path)) return path;
  return path.replace(/\s|[^\u0000-\u007F]/gu, encodeURIComponent);
}
function arraysEqual(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ../../node_modules/@tanstack/router-core/dist/esm/lru-cache.js
function createLRUCache(max) {
  const cache = /* @__PURE__ */ new Map();
  let oldest;
  let newest;
  const touch = (entry) => {
    if (!entry.next) return;
    if (!entry.prev) {
      entry.next.prev = void 0;
      oldest = entry.next;
      entry.next = void 0;
      if (newest) {
        entry.prev = newest;
        newest.next = entry;
      }
    } else {
      entry.prev.next = entry.next;
      entry.next.prev = entry.prev;
      entry.next = void 0;
      if (newest) {
        newest.next = entry;
        entry.prev = newest;
      }
    }
    newest = entry;
  };
  return {
    get(key) {
      const entry = cache.get(key);
      if (!entry) return void 0;
      touch(entry);
      return entry.value;
    },
    set(key, value) {
      if (cache.size >= max && oldest) {
        const toDelete = oldest;
        cache.delete(toDelete.key);
        if (toDelete.next) {
          oldest = toDelete.next;
          toDelete.next.prev = void 0;
        }
        if (toDelete === newest) newest = void 0;
      }
      const existing = cache.get(key);
      if (existing) {
        existing.value = value;
        touch(existing);
      } else {
        const entry = {
          key,
          value,
          prev: newest
        };
        if (newest) newest.next = entry;
        newest = entry;
        if (!oldest) oldest = entry;
        cache.set(key, entry);
      }
    },
    clear() {
      cache.clear();
      oldest = void 0;
      newest = void 0;
    }
  };
}

// ../../node_modules/@tanstack/router-core/dist/esm/invariant.js
function invariant() {
  throw new Error("Invariant failed");
}

// ../../node_modules/@tanstack/router-core/dist/esm/new-process-route-tree.js
var SEGMENT_TYPE_INDEX = 4;
var SEGMENT_TYPE_PATHLESS = 5;
function parseSegment(path, start, output = new Uint16Array(6)) {
  const next = path.indexOf("/", start);
  const end = next === -1 ? path.length : next;
  const part = path.substring(start, end);
  if (!part || !part.includes("$")) {
    output[0] = 0;
    output[1] = start;
    output[2] = start;
    output[3] = end;
    output[4] = end;
    output[5] = end;
    return output;
  }
  if (part === "$") {
    const total = path.length;
    output[0] = 2;
    output[1] = start;
    output[2] = start;
    output[3] = total;
    output[4] = total;
    output[5] = total;
    return output;
  }
  if (part.charCodeAt(0) === 36) {
    output[0] = 1;
    output[1] = start;
    output[2] = start + 1;
    output[3] = end;
    output[4] = end;
    output[5] = end;
    return output;
  }
  const openBrace = part.indexOf("{");
  let closeBrace;
  if (openBrace !== -1 && openBrace + 1 < part.length && (closeBrace = part.indexOf("}", openBrace)) !== -1) {
    const firstChar = part.charCodeAt(openBrace + 1);
    if (firstChar === 45) {
      if (openBrace + 2 < part.length && part.charCodeAt(openBrace + 2) === 36) {
        const paramStart = openBrace + 3;
        const paramEnd = closeBrace;
        if (paramStart < paramEnd) {
          output[0] = 3;
          output[1] = start + openBrace;
          output[2] = start + paramStart;
          output[3] = start + paramEnd;
          output[4] = start + closeBrace + 1;
          output[5] = end;
          return output;
        }
      }
    } else if (firstChar === 36) {
      const dollarPos = openBrace + 1;
      const afterDollar = openBrace + 2;
      if (afterDollar === closeBrace) {
        output[0] = 2;
        output[1] = start + openBrace;
        output[2] = start + dollarPos;
        output[3] = start + afterDollar;
        output[4] = start + closeBrace + 1;
        output[5] = path.length;
        return output;
      }
      output[0] = 1;
      output[1] = start + openBrace;
      output[2] = start + afterDollar;
      output[3] = start + closeBrace;
      output[4] = start + closeBrace + 1;
      output[5] = end;
      return output;
    }
  }
  output[0] = 0;
  output[1] = start;
  output[2] = start;
  output[3] = end;
  output[4] = end;
  output[5] = end;
  return output;
}
function parseSegments(defaultCaseSensitive, data, route, start, node, depth, dynamicListsToSort, onRoute) {
  onRoute?.(route);
  let cursor = start;
  {
    const path = route.fullPath ?? route.from;
    const options = route.options;
    const length = path.length;
    const caseSensitive = options?.caseSensitive ?? defaultCaseSensitive;
    const parseParams = options?.params?.parse ?? options?.parseParams;
    while (cursor < length) {
      const segment = parseSegment(path, cursor, data);
      let nextNode;
      const start2 = cursor;
      const end = segment[5];
      cursor = end + 1;
      depth++;
      const kind = segment[0];
      switch (kind) {
        case 0: {
          const value = path.substring(segment[2], segment[3]);
          let name = value;
          let staticChildren;
          if (caseSensitive) staticChildren = node.static ??= /* @__PURE__ */ new Map();
          else {
            name = value.toLowerCase();
            staticChildren = node.staticInsensitive ??= /* @__PURE__ */ new Map();
          }
          const existingNode = staticChildren.get(name);
          if (existingNode) nextNode = existingNode;
          else {
            const next = createStaticNode(path);
            next.parent = node;
            next.depth = depth;
            nextNode = next;
            staticChildren.set(name, next);
          }
          break;
        }
        case 1:
        case 3:
        case 2: {
          let prefix = path.substring(start2, segment[1]);
          let suffix = path.substring(segment[4], end);
          const actuallyCaseSensitive = caseSensitive && !!(prefix || suffix);
          if (!caseSensitive) {
            prefix = prefix.toLowerCase();
            suffix = suffix.toLowerCase();
          }
          const siblings = kind === 1 ? node.dynamic : kind === 3 ? node.optional : node.wildcard;
          const existingNode = kind !== 2 && !parseParams && siblings?.find((s) => !s.parse && s.caseSensitive === actuallyCaseSensitive && s.prefix === prefix && s.suffix === suffix);
          if (existingNode) nextNode = existingNode;
          else {
            const next = createDynamicNode(kind, path, actuallyCaseSensitive, prefix, suffix);
            nextNode = next;
            next.parent = node;
            next.depth = depth;
            let nodes;
            if (kind === 1) nodes = node.dynamic ??= [];
            else if (kind === 3) nodes = node.optional ??= [];
            else nodes = node.wildcard ??= [];
            nodes.push(next);
            if (nodes.length === 2) dynamicListsToSort?.push(nodes);
          }
          break;
        }
      }
      node = nextNode;
    }
    if (parseParams && route.children && !route.isRoot && route.id && route.id.charCodeAt(route.id.lastIndexOf("/") + 1) === 95) {
      const pathlessNode = createStaticNode(path);
      pathlessNode.kind = SEGMENT_TYPE_PATHLESS;
      pathlessNode.parent = node;
      depth++;
      pathlessNode.depth = depth;
      node.pathless ??= [];
      node.pathless.push(pathlessNode);
      node = pathlessNode;
    }
    const isLeaf = (route.path || !route.children) && !route.isRoot;
    if (isLeaf && path.endsWith("/")) {
      const indexNode = createStaticNode(path);
      indexNode.kind = SEGMENT_TYPE_INDEX;
      indexNode.parent = node;
      depth++;
      indexNode.depth = depth;
      node.index = indexNode;
      node = indexNode;
    }
    node.parse = parseParams ?? null;
    node.priority = options?.params?.priority ?? 0;
    if (isLeaf && !node.route) {
      node.route = route;
      node.fullPath = path;
    }
  }
  if (route.children) for (const child of route.children) parseSegments(defaultCaseSensitive, data, child, cursor, node, depth, dynamicListsToSort, onRoute);
}
function sortDynamic(a, b) {
  if (a.parse && !b.parse) return -1;
  if (!a.parse && b.parse) return 1;
  if (a.parse && b.parse && (a.priority || b.priority)) return b.priority - a.priority;
  if (a.prefix && b.prefix && a.prefix !== b.prefix) {
    if (a.prefix.startsWith(b.prefix)) return -1;
    if (b.prefix.startsWith(a.prefix)) return 1;
  }
  if (a.suffix && b.suffix && a.suffix !== b.suffix) {
    if (a.suffix.endsWith(b.suffix)) return -1;
    if (b.suffix.endsWith(a.suffix)) return 1;
  }
  if (a.prefix && !b.prefix) return -1;
  if (!a.prefix && b.prefix) return 1;
  if (a.suffix && !b.suffix) return -1;
  if (!a.suffix && b.suffix) return 1;
  if (a.caseSensitive && !b.caseSensitive) return -1;
  if (!a.caseSensitive && b.caseSensitive) return 1;
  return 0;
}
function createStaticNode(fullPath) {
  return {
    kind: 0,
    depth: 0,
    pathless: null,
    index: null,
    static: null,
    staticInsensitive: null,
    dynamic: null,
    optional: null,
    wildcard: null,
    route: null,
    fullPath,
    parent: null,
    parse: null,
    priority: 0
  };
}
function createDynamicNode(kind, fullPath, caseSensitive, prefix, suffix) {
  return {
    kind,
    depth: 0,
    pathless: null,
    index: null,
    static: null,
    staticInsensitive: null,
    dynamic: null,
    optional: null,
    wildcard: null,
    route: null,
    fullPath,
    parent: null,
    parse: null,
    priority: 0,
    caseSensitive,
    prefix,
    suffix
  };
}
function processRouteMasks(routeList, processedTree) {
  const segmentTree = createStaticNode("/");
  const data = new Uint16Array(6);
  const dynamicListsToSort = [];
  for (const route of routeList) parseSegments(false, data, route, 1, segmentTree, 0, dynamicListsToSort);
  for (const nodes of dynamicListsToSort) nodes.sort(sortDynamic);
  processedTree.masksTree = segmentTree;
  processedTree.flatCache = createLRUCache(1e3);
}
function findFlatMatch(path, processedTree) {
  path ||= "/";
  const cached = processedTree.flatCache.get(path);
  if (cached !== void 0) return cached;
  const result = findMatch(path, processedTree.masksTree);
  processedTree.flatCache.set(path, result);
  return result;
}
function findSingleMatch(from, caseSensitive, fuzzy, path, processedTree) {
  from ||= "/";
  path ||= "/";
  const key = caseSensitive ? `case\0${from}` : from;
  let tree = processedTree.singleCache.get(key);
  if (!tree) {
    tree = createStaticNode("/");
    parseSegments(caseSensitive, new Uint16Array(6), { from }, 1, tree, 0);
    processedTree.singleCache.set(key, tree);
  }
  return findMatch(path, tree, fuzzy);
}
function findRouteMatch(path, processedTree, fuzzy = false) {
  const key = fuzzy ? path : `nofuzz\0${path}`;
  const cached = processedTree.matchCache.get(key);
  if (cached !== void 0) return cached;
  path ||= "/";
  let result;
  try {
    result = findMatch(path, processedTree.segmentTree, fuzzy);
  } catch (err) {
    if (err instanceof URIError) result = null;
    else throw err;
  }
  if (result) result.branch = buildRouteBranch(result.route);
  processedTree.matchCache.set(key, result);
  return result;
}
function trimPathRight(path) {
  return path === "/" ? path : path.replace(/\/{1,}$/, "");
}
function processRouteTree(routeTree, caseSensitive = false, initRoute) {
  const segmentTree = createStaticNode(routeTree.fullPath);
  const data = new Uint16Array(6);
  const dynamicListsToSort = [];
  const routesById = {};
  const routesByPath = {};
  let index = 0;
  parseSegments(caseSensitive, data, routeTree, 1, segmentTree, 0, dynamicListsToSort, (route) => {
    initRoute?.(route, index);
    if (route.id in routesById) {
      if (true) throw new Error(`Invariant failed: Duplicate routes found with id: ${String(route.id)}`);
      invariant();
    }
    routesById[route.id] = route;
    if (index !== 0 && route.path) {
      const trimmedFullPath = trimPathRight(route.fullPath);
      if (!routesByPath[trimmedFullPath] || route.fullPath.endsWith("/")) routesByPath[trimmedFullPath] = route;
    }
    index++;
  });
  for (const nodes of dynamicListsToSort) nodes.sort(sortDynamic);
  return {
    processedTree: {
      segmentTree,
      singleCache: createLRUCache(1e3),
      matchCache: createLRUCache(1e3),
      flatCache: null,
      masksTree: null
    },
    routesById,
    routesByPath
  };
}
function findMatch(path, segmentTree, fuzzy = false) {
  const parts = path.split("/");
  const leaf = getNodeMatch(path, parts, segmentTree, fuzzy);
  if (!leaf) return null;
  const [rawParams] = extractParams(path, parts, leaf);
  return {
    route: leaf.node.route,
    rawParams
  };
}
function extractParams(path, parts, leaf) {
  const list = buildBranch(leaf.node);
  let nodeParts = null;
  const rawParams = /* @__PURE__ */ Object.create(null);
  let partIndex = leaf.extract?.part ?? 0;
  let nodeIndex = leaf.extract?.node ?? 0;
  let pathIndex = leaf.extract?.path ?? 0;
  let segmentCount = leaf.extract?.segment ?? 0;
  for (; nodeIndex < list.length; partIndex++, nodeIndex++, pathIndex++, segmentCount++) {
    const node = list[nodeIndex];
    if (node.kind === SEGMENT_TYPE_INDEX) break;
    if (node.kind === SEGMENT_TYPE_PATHLESS) {
      segmentCount--;
      partIndex--;
      pathIndex--;
      continue;
    }
    const part = parts[partIndex];
    const currentPathIndex = pathIndex;
    if (part) pathIndex += part.length;
    if (node.kind === 1) {
      nodeParts ??= leaf.node.fullPath.split("/");
      const nodePart = nodeParts[segmentCount];
      const preLength = node.prefix.length;
      if (nodePart.charCodeAt(preLength) === 123) {
        const sufLength = node.suffix.length;
        const name = nodePart.substring(preLength + 2, nodePart.length - sufLength - 1);
        const value = part.substring(preLength, part.length - sufLength);
        rawParams[name] = decodeURIComponent(value);
      } else {
        const name = nodePart.substring(1);
        rawParams[name] = decodeURIComponent(part);
      }
    } else if (node.kind === 3) {
      if (leaf.skipped & 1 << nodeIndex) {
        partIndex--;
        pathIndex = currentPathIndex - 1;
        continue;
      }
      nodeParts ??= leaf.node.fullPath.split("/");
      const nodePart = nodeParts[segmentCount];
      const preLength = node.prefix.length;
      const sufLength = node.suffix.length;
      const name = nodePart.substring(preLength + 3, nodePart.length - sufLength - 1);
      const value = node.suffix || node.prefix ? part.substring(preLength, part.length - sufLength) : part;
      if (value) rawParams[name] = decodeURIComponent(value);
    } else if (node.kind === 2) {
      const n = node;
      const value = path.substring(currentPathIndex + n.prefix.length, path.length - n.suffix.length);
      const splat = decodeURIComponent(value);
      rawParams["*"] = splat;
      rawParams._splat = splat;
      break;
    }
  }
  if (leaf.rawParams) Object.assign(rawParams, leaf.rawParams);
  return [rawParams, {
    part: partIndex,
    node: nodeIndex,
    path: pathIndex,
    segment: segmentCount
  }];
}
function buildRouteBranch(route) {
  const list = [route];
  while (route.parentRoute) {
    route = route.parentRoute;
    list.push(route);
  }
  list.reverse();
  return list;
}
function buildBranch(node) {
  const list = Array(node.depth + 1);
  do {
    list[node.depth] = node;
    node = node.parent;
  } while (node);
  return list;
}
function getNodeMatch(path, parts, segmentTree, fuzzy) {
  if (path === "/" && segmentTree.index) return {
    node: segmentTree.index,
    skipped: 0
  };
  const trailingSlash = !last(parts);
  const pathIsIndex = trailingSlash && path !== "/";
  const partsLength = parts.length - (trailingSlash ? 1 : 0);
  const stack = [{
    node: segmentTree,
    index: 1,
    skipped: 0,
    statics: 0,
    dynamics: 0,
    optionals: 0
  }];
  let bestFuzzy = null;
  let bestMatch = null;
  while (stack.length) {
    const frame = stack.pop();
    const { node, index, skipped, statics, dynamics, optionals } = frame;
    let { extract, rawParams } = frame;
    if (node.kind === 2 && node.route && !isFrameMoreSpecific(bestMatch, frame)) continue;
    if (node.parse) {
      if (!validateParseParams(path, parts, frame)) continue;
      rawParams = frame.rawParams;
      extract = frame.extract;
    }
    if (fuzzy && node.route && node.kind !== SEGMENT_TYPE_INDEX && isFrameMoreSpecific(bestFuzzy, frame)) bestFuzzy = frame;
    const isBeyondPath = index === partsLength;
    if (isBeyondPath) {
      if (node.route && (!pathIsIndex || node.kind === SEGMENT_TYPE_INDEX || node.kind === 2) && isFrameMoreSpecific(bestMatch, frame)) bestMatch = frame;
      if (!node.optional && !node.wildcard && !node.index && !node.pathless) continue;
    }
    const part = isBeyondPath ? void 0 : parts[index];
    let lowerPart;
    if (isBeyondPath && node.index) {
      const indexFrame = {
        node: node.index,
        index,
        skipped,
        statics,
        dynamics,
        optionals,
        extract,
        rawParams
      };
      let indexValid = true;
      if (node.index.parse) {
        if (!validateParseParams(path, parts, indexFrame)) indexValid = false;
      }
      if (indexValid) {
        if (!dynamics && !optionals && !skipped && isPerfectStaticMatch(statics, partsLength)) return indexFrame;
        if (isFrameMoreSpecific(bestMatch, indexFrame)) bestMatch = indexFrame;
      }
    }
    if (node.wildcard) for (let i = node.wildcard.length - 1; i >= 0; i--) {
      const segment = node.wildcard[i];
      const { prefix, suffix } = segment;
      if (prefix) {
        if (isBeyondPath) continue;
        if (!(segment.caseSensitive ? part : lowerPart ??= part.toLowerCase()).startsWith(prefix)) continue;
      }
      if (suffix) {
        if (isBeyondPath) continue;
        const end = parts.slice(index).join("/");
        const suffixPart = end.slice(-suffix.length);
        if ((segment.caseSensitive ? suffixPart : suffixPart.toLowerCase()) !== suffix || end.length - suffix.length < prefix.length) continue;
      }
      stack.push({
        node: segment,
        index: partsLength,
        skipped,
        statics,
        dynamics,
        optionals,
        extract,
        rawParams
      });
    }
    if (node.optional) {
      const nextSkipped = skipped | 1 << node.depth + 1;
      for (let i = node.optional.length - 1; i >= 0; i--) {
        const segment = node.optional[i];
        stack.push({
          node: segment,
          index,
          skipped: nextSkipped,
          statics,
          dynamics,
          optionals,
          extract,
          rawParams
        });
      }
      if (!isBeyondPath) for (let i = node.optional.length - 1; i >= 0; i--) {
        const segment = node.optional[i];
        const { prefix, suffix } = segment;
        if (prefix || suffix) {
          const casePart = segment.caseSensitive ? part : lowerPart ??= part.toLowerCase();
          if (prefix && !casePart.startsWith(prefix)) continue;
          if (suffix && casePart.indexOf(suffix, casePart.length - suffix.length) < prefix.length) continue;
        }
        stack.push({
          node: segment,
          index: index + 1,
          skipped,
          statics,
          dynamics,
          optionals: optionals + segmentScore(partsLength, index),
          extract,
          rawParams
        });
      }
    }
    if (!isBeyondPath && node.dynamic && part) for (let i = node.dynamic.length - 1; i >= 0; i--) {
      const segment = node.dynamic[i];
      const { prefix, suffix } = segment;
      if (prefix || suffix) {
        const casePart = segment.caseSensitive ? part : lowerPart ??= part.toLowerCase();
        if (prefix && !casePart.startsWith(prefix)) continue;
        if (suffix && casePart.indexOf(suffix, casePart.length - suffix.length) < prefix.length) continue;
      }
      stack.push({
        node: segment,
        index: index + 1,
        skipped,
        statics,
        dynamics: dynamics + segmentScore(partsLength, index),
        optionals,
        extract,
        rawParams
      });
    }
    if (!isBeyondPath && node.staticInsensitive) {
      const match = node.staticInsensitive.get(lowerPart ??= part.toLowerCase());
      if (match) stack.push({
        node: match,
        index: index + 1,
        skipped,
        statics: statics + segmentScore(partsLength, index),
        dynamics,
        optionals,
        extract,
        rawParams
      });
    }
    if (!isBeyondPath && node.static) {
      const match = node.static.get(part);
      if (match) stack.push({
        node: match,
        index: index + 1,
        skipped,
        statics: statics + segmentScore(partsLength, index),
        dynamics,
        optionals,
        extract,
        rawParams
      });
    }
    if (node.pathless) for (let i = node.pathless.length - 1; i >= 0; i--) {
      const segment = node.pathless[i];
      stack.push({
        node: segment,
        index,
        skipped,
        statics,
        dynamics,
        optionals,
        extract,
        rawParams
      });
    }
  }
  if (bestMatch) return bestMatch;
  if (fuzzy && bestFuzzy) {
    let sliceIndex = bestFuzzy.index;
    for (let i = 0; i < bestFuzzy.index; i++) sliceIndex += parts[i].length;
    const splat = sliceIndex === path.length ? "/" : path.slice(sliceIndex);
    bestFuzzy.rawParams ??= /* @__PURE__ */ Object.create(null);
    bestFuzzy.rawParams["**"] = decodeURIComponent(splat);
    return bestFuzzy;
  }
  return null;
}
function segmentScore(partsLength, index) {
  return 2 ** (partsLength - index - 1);
}
function isPerfectStaticMatch(statics, partsLength) {
  return statics === 2 ** (partsLength - 1) - 1;
}
function validateParseParams(path, parts, frame) {
  let rawParams;
  let state;
  try {
    [rawParams, state] = extractParams(path, parts, frame);
  } catch {
    return null;
  }
  frame.rawParams = rawParams;
  frame.extract = state;
  if (!frame.node.parse) return true;
  try {
    if (frame.node.parse(rawParams) === false) return null;
  } catch {
  }
  return true;
}
function isFrameMoreSpecific(prev, next) {
  if (!prev) return true;
  return next.statics > prev.statics || next.statics === prev.statics && (next.dynamics > prev.dynamics || next.dynamics === prev.dynamics && (next.optionals > prev.optionals || next.optionals === prev.optionals && ((next.node.kind === SEGMENT_TYPE_INDEX) > (prev.node.kind === SEGMENT_TYPE_INDEX) || next.node.kind === SEGMENT_TYPE_INDEX === (prev.node.kind === SEGMENT_TYPE_INDEX) && next.node.depth > prev.node.depth)));
}

// ../../node_modules/@tanstack/router-core/dist/esm/path.js
function joinPaths(paths) {
  return cleanPath(paths.filter((val) => {
    return val !== void 0;
  }).join("/"));
}
function cleanPath(path) {
  return path.replace(/\/{2,}/g, "/");
}
function trimPathLeft(path) {
  return path === "/" ? path : path.replace(/^\/{1,}/, "");
}
function trimPathRight2(path) {
  const len = path.length;
  return len > 1 && path[len - 1] === "/" ? path.replace(/\/{1,}$/, "") : path;
}
function trimPath(path) {
  return trimPathRight2(trimPathLeft(path));
}
function removeTrailingSlash(value, basepath) {
  if (value?.endsWith("/") && value !== "/" && value !== `${basepath}/`) return value.slice(0, -1);
  return value;
}
function exactPathTest(pathName1, pathName2, basepath) {
  return removeTrailingSlash(pathName1, basepath) === removeTrailingSlash(pathName2, basepath);
}
function resolvePath({ base, to, trailingSlash = "never", cache }) {
  if (to.includes("//")) to = cleanPath(to);
  if (to.startsWith("/")) {
    if (to.length === 1 || trailingSlash === "preserve") return to;
    if (trailingSlash === "always") return to.endsWith("/") ? to : `${to}/`;
    return to.endsWith("/") ? to.slice(0, -1) : to;
  }
  const isBase = to === ".";
  let key;
  if (cache) {
    key = isBase ? base : base + "\0" + to;
    const cached = cache.get(key);
    if (cached) return cached;
  }
  let baseSegments;
  if (isBase) baseSegments = base.split("/");
  else {
    if (base.includes("//")) base = cleanPath(base);
    baseSegments = base.split("/");
    while (baseSegments.length > 1 && last(baseSegments) === "") baseSegments.pop();
    const toSegments = to.split("/");
    for (let index = 0, length = toSegments.length; index < length; index++) {
      const value = toSegments[index];
      if (value === "") {
        if (!index) baseSegments = [value];
        else if (index === length - 1) baseSegments.push(value);
      } else if (value === "..") if (baseSegments.length > 1) baseSegments.pop();
      else baseSegments = [""];
      else if (value === ".") {
      } else baseSegments.push(value);
    }
  }
  if (baseSegments.length > 1) {
    if (last(baseSegments) === "") {
      if (trailingSlash === "never") baseSegments.pop();
    } else if (trailingSlash === "always") baseSegments.push("");
  }
  const joined = baseSegments.join("/");
  const result = (isBase ? cleanPath(joined) : joined) || "/";
  if (key && cache) cache.set(key, result);
  return result;
}
function compileDecodeCharMap(pathParamsAllowedCharacters) {
  const charMap = new Map(pathParamsAllowedCharacters.map((char) => [encodeURIComponent(char), char]));
  const pattern = Array.from(charMap.keys()).map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const regex = new RegExp(pattern, "g");
  return (encoded) => encoded.replace(regex, (match) => charMap.get(match) ?? match);
}
function encodeParam(key, params, decoder) {
  const value = params[key];
  if (typeof value !== "string") return value;
  if (key === "_splat") {
    if (/^[a-zA-Z0-9\-._~!/]*$/.test(value)) return value;
    return value.split("/").map((segment) => encodePathParam(segment, decoder)).join("/");
  } else return encodePathParam(value, decoder);
}
function interpolatePath({ path, params, decoder, ...rest }) {
  let isMissingParams = false;
  const usedParams = /* @__PURE__ */ Object.create(null);
  if (!path || path === "/") return {
    interpolatedPath: "/",
    usedParams,
    isMissingParams
  };
  if (!path.includes("$")) return {
    interpolatedPath: path,
    usedParams,
    isMissingParams
  };
  if (isServer ?? rest.server) {
    if (path.indexOf("{") === -1) {
      const length2 = path.length;
      let cursor2 = 0;
      let joined2 = "";
      while (cursor2 < length2) {
        while (cursor2 < length2 && path.charCodeAt(cursor2) === 47) cursor2++;
        if (cursor2 >= length2) break;
        const start = cursor2;
        let end = path.indexOf("/", cursor2);
        if (end === -1) end = length2;
        cursor2 = end;
        const part = path.substring(start, end);
        if (!part) continue;
        if (part.charCodeAt(0) === 36) if (part.length === 1) {
          const splat = params._splat;
          usedParams._splat = splat;
          usedParams["*"] = splat;
          if (!splat) {
            isMissingParams = true;
            continue;
          }
          const value = encodeParam("_splat", params, decoder);
          joined2 += "/" + value;
        } else {
          const key = part.substring(1);
          if (!isMissingParams && !(key in params)) isMissingParams = true;
          usedParams[key] = params[key];
          const value = encodeParam(key, params, decoder) ?? "undefined";
          joined2 += "/" + value;
        }
        else joined2 += "/" + part;
      }
      if (path.endsWith("/")) joined2 += "/";
      return {
        usedParams,
        interpolatedPath: joined2 || "/",
        isMissingParams
      };
    }
  }
  const length = path.length;
  let cursor = 0;
  let segment;
  let joined = "";
  while (cursor < length) {
    const start = cursor;
    segment = parseSegment(path, start, segment);
    const end = segment[5];
    cursor = end + 1;
    if (start === end) continue;
    const kind = segment[0];
    if (kind === 0) {
      joined += "/" + path.substring(start, end);
      continue;
    }
    if (kind === 2) {
      const splat = params._splat;
      usedParams._splat = splat;
      usedParams["*"] = splat;
      const prefix = path.substring(start, segment[1]);
      const suffix = path.substring(segment[4], end);
      if (!splat) {
        isMissingParams = true;
        if (prefix || suffix) joined += "/" + prefix + suffix;
        continue;
      }
      const value = encodeParam("_splat", params, decoder);
      joined += "/" + prefix + value + suffix;
      continue;
    }
    if (kind === 1) {
      const key = path.substring(segment[2], segment[3]);
      if (!isMissingParams && !(key in params)) isMissingParams = true;
      usedParams[key] = params[key];
      const prefix = path.substring(start, segment[1]);
      const suffix = path.substring(segment[4], end);
      const value = encodeParam(key, params, decoder) ?? "undefined";
      joined += "/" + prefix + value + suffix;
      continue;
    }
    if (kind === 3) {
      const key = path.substring(segment[2], segment[3]);
      const valueRaw = params[key];
      if (valueRaw == null) continue;
      usedParams[key] = valueRaw;
      const prefix = path.substring(start, segment[1]);
      const suffix = path.substring(segment[4], end);
      const value = encodeParam(key, params, decoder) ?? "";
      joined += "/" + prefix + value + suffix;
      continue;
    }
  }
  if (path.endsWith("/")) joined += "/";
  return {
    usedParams,
    interpolatedPath: joined || "/",
    isMissingParams
  };
}
function encodePathParam(value, decoder) {
  const encoded = encodeURIComponent(value);
  return decoder?.(encoded) ?? encoded;
}

// ../../node_modules/@tanstack/router-core/dist/esm/scroll-restoration.js
function getSafeSessionStorage() {
  try {
    return sessionStorage;
  } catch {
    return;
  }
}
var storageKey = "tsr-scroll-restoration-v1_3";
var safeSessionStorage = getSafeSessionStorage();
function createScrollRestorationCache() {
  try {
    return JSON.parse(safeSessionStorage?.getItem("tsr-scroll-restoration-v1_3") || "{}");
  } catch {
    return {};
  }
}
function persistScrollRestorationCache() {
  try {
    safeSessionStorage?.setItem(storageKey, JSON.stringify(scrollRestorationCache));
  } catch {
    if (true) console.warn("[ts-router] Could not persist scroll restoration state to sessionStorage.");
  }
}
var scrollRestorationCache = createScrollRestorationCache();
var scrollRestorationIdAttribute = "data-scroll-restoration-id";
var defaultGetScrollRestorationKey = (location) => {
  return location.state.__TSR_key || location.href;
};
function getScrollRestorationSelector(element) {
  const attrId = element.getAttribute(scrollRestorationIdAttribute);
  if (attrId) return `[${scrollRestorationIdAttribute}="${attrId}"]`;
  let selector = "";
  let el = element;
  let parent;
  while (parent = el.parentNode) {
    let index = 1;
    let sibling = el;
    while (sibling = sibling.previousElementSibling) index++;
    const part = `${el.localName}:nth-child(${index})`;
    selector = selector ? `${part} > ${selector}` : part;
    el = parent;
  }
  return selector;
}
function getElementScrollRestorationEntry(router, options) {
  const entries = scrollRestorationCache[(options.getKey || defaultGetScrollRestorationKey)(router.latestLocation)];
  if (!entries) return;
  if (options.id) return entries[`[${scrollRestorationIdAttribute}="${options.id}"]`];
  const element = options.getElement?.();
  if (!element) return;
  return entries[element === window ? windowScrollTarget : getScrollRestorationSelector(element)];
}
var ignoreScroll = false;
var windowScrollTarget = "window";
function getElement(selector) {
  try {
    return typeof selector === "function" ? selector() : document.querySelector(selector);
  } catch {
  }
}
function getScrollToTopElements(scrollToTopSelectors) {
  const elements = /* @__PURE__ */ new Set();
  for (const selector of scrollToTopSelectors) {
    if (selector === windowScrollTarget) continue;
    const element = getElement(selector);
    if (element) elements.add(element);
  }
  return elements;
}
function setupScrollRestoration(router, force) {
  const shouldSetupScrollRestoration = force ?? router.options.scrollRestoration;
  const scroll = router._scroll;
  if (shouldSetupScrollRestoration) scroll.restoring = true;
  if (isServer ?? router.isServer) return;
  const getKey = router.options.getScrollRestorationKey || defaultGetScrollRestorationKey;
  const trackedScrollTargets = /* @__PURE__ */ new Set();
  const snapshotCurrentScrollTargets = (restoreKey) => {
    const keyEntry = scrollRestorationCache[restoreKey] ||= {};
    for (const target of trackedScrollTargets) if (target === document) keyEntry[windowScrollTarget] = {
      scrollX,
      scrollY
    };
    else if (target.isConnected) keyEntry[getScrollRestorationSelector(target)] = {
      scrollX: target.scrollLeft,
      scrollY: target.scrollTop
    };
  };
  if (shouldSetupScrollRestoration && !scroll.restoration) {
    scroll.restoration = true;
    ignoreScroll = false;
    history.scrollRestoration = "manual";
    document.addEventListener("scroll", (event) => {
      if (ignoreScroll) return;
      trackedScrollTargets.add(event.target);
    }, true);
    router.subscribe("onBeforeLoad", (event) => {
      if (event.fromLocation) snapshotCurrentScrollTargets(getKey(event.fromLocation));
      trackedScrollTargets.clear();
    });
    addEventListener("pagehide", () => {
      snapshotCurrentScrollTargets(getKey(router.stores.resolvedLocation.get() ?? router.stores.location.get()));
      persistScrollRestorationCache();
    });
  }
  if (scroll.reset) return;
  scroll.reset = true;
  router.subscribe("onRendered", (event) => {
    const behavior = router.options.scrollRestorationBehavior;
    const scrollToTopSelectors = router.options.scrollToTopSelectors;
    const shouldResetScroll = scroll.next;
    const hashNavigation = scroll.hash;
    let scrollToTopElements;
    trackedScrollTargets.clear();
    scroll.next = true;
    scroll.hash = false;
    if (typeof router.options.scrollRestoration === "function" && !router.options.scrollRestoration({ location: router.latestLocation })) return;
    const cacheKey = getKey(event.toLocation);
    const fromCacheKey = event.fromLocation && getKey(event.fromLocation);
    if (scroll.restoring && fromCacheKey && fromCacheKey !== cacheKey) {
      const fromElementEntries = scrollRestorationCache[fromCacheKey];
      if (fromElementEntries) {
        let toElementEntries = scrollRestorationCache[cacheKey];
        for (const elementSelector in fromElementEntries) {
          if (elementSelector === windowScrollTarget) {
            if (shouldResetScroll) continue;
          } else {
            const element = getElement(elementSelector);
            if (!element) continue;
            if (shouldResetScroll && scrollToTopSelectors) {
              scrollToTopElements ??= getScrollToTopElements(scrollToTopSelectors);
              if (scrollToTopElements.has(element)) continue;
            }
          }
          if (!toElementEntries) toElementEntries = scrollRestorationCache[cacheKey] = {};
          toElementEntries[elementSelector] ??= fromElementEntries[elementSelector];
        }
      }
    }
    ignoreScroll = true;
    try {
      const hash = event.toLocation.hash;
      const hashScrollIntoViewOptions = event.toLocation.state.__hashScrollIntoViewOptions ?? true;
      let windowRestored = false;
      if (shouldResetScroll) {
        if (!hash && scrollToTopSelectors) scrollToTopElements ??= getScrollToTopElements(scrollToTopSelectors);
        const skipWindowRestore = hash && hashScrollIntoViewOptions && hashNavigation;
        const elementEntries = scroll.restoring ? scrollRestorationCache[cacheKey] : void 0;
        if (elementEntries) for (const elementSelector in elementEntries) {
          const { scrollX: scrollX2, scrollY: scrollY2 } = elementEntries[elementSelector];
          if (elementSelector === windowScrollTarget) {
            if (skipWindowRestore) continue;
            scrollTo({
              top: scrollY2,
              left: scrollX2,
              behavior
            });
            windowRestored = true;
          } else {
            const element = getElement(elementSelector);
            if (element) {
              element.scrollLeft = scrollX2;
              element.scrollTop = scrollY2;
              scrollToTopElements?.delete(element);
            }
          }
        }
        if (!hash) {
          const scrollOptions = {
            top: 0,
            left: 0,
            behavior
          };
          if (!windowRestored) scrollTo(scrollOptions);
          if (scrollToTopElements) for (const element of scrollToTopElements) element.scrollTo(scrollOptions);
        }
      }
      if (!windowRestored && hash && hashScrollIntoViewOptions) document.getElementById(hash)?.scrollIntoView(hashScrollIntoViewOptions);
    } finally {
      ignoreScroll = false;
    }
  });
}

// ../../node_modules/@tanstack/router-core/dist/esm/qss.js
function encode(obj, stringify = String) {
  const result = new URLSearchParams();
  for (const key in obj) {
    const val = obj[key];
    if (val !== void 0) result.set(key, stringify(val));
  }
  return result.toString();
}
function toValue(str) {
  if (!str) return "";
  if (str === "false") return false;
  if (str === "true") return true;
  return +str * 0 === 0 && +str + "" === str ? +str : str;
}
function decode(str) {
  const searchParams = new URLSearchParams(str);
  const result = /* @__PURE__ */ Object.create(null);
  for (const [key, value] of searchParams.entries()) {
    const previousValue = result[key];
    if (previousValue == null) result[key] = toValue(value);
    else if (Array.isArray(previousValue)) previousValue.push(toValue(value));
    else result[key] = [previousValue, toValue(value)];
  }
  return result;
}

// ../../node_modules/@tanstack/router-core/dist/esm/searchParams.js
var jsonStart = /^(?:\s|["[{\d-]|fa|nu|tr)/;
var defaultParseSearch = parseSearchWith(JSON.parse);
var defaultStringifySearch = stringifySearchWith(JSON.stringify, JSON.parse);
function parseSearchWith(parser) {
  return (searchStr) => {
    if (searchStr[0] === "?") searchStr = searchStr.substring(1);
    const query = decode(searchStr);
    for (const key in query) {
      const value = query[key];
      if (typeof value === "string") try {
        query[key] = parser(value);
      } catch (_err) {
      }
    }
    return query;
  };
}
function stringifySearchWith(stringify, parser) {
  const isJsonParser = parser === JSON.parse;
  function stringifyValue(val) {
    if (val && typeof val === "object") try {
      return stringify(val);
    } catch (_err) {
    }
    else if (parser && typeof val === "string") {
      if (isJsonParser && !jsonStart.test(val)) return val;
      try {
        parser(val);
        return stringify(val);
      } catch (_err) {
      }
    }
    return val;
  }
  return (search) => {
    const searchStr = encode(search, stringifyValue);
    return searchStr ? `?${searchStr}` : "";
  };
}

// ../../node_modules/@tanstack/router-core/dist/esm/rewrite.js
function composeRewrites(rewrites) {
  return {
    input: ({ url }) => {
      for (const rewrite of rewrites) url = executeRewriteInput(rewrite, url);
      return url;
    },
    output: ({ url }) => {
      for (let i = rewrites.length - 1; i >= 0; i--) url = executeRewriteOutput(rewrites[i], url);
      return url;
    }
  };
}
function rewriteBasepath(opts) {
  const trimmedBasepath = trimPath(opts.basepath);
  const normalizedBasepath = `/${trimmedBasepath}`;
  const checkBasepath = opts.caseSensitive ? normalizedBasepath : normalizedBasepath.toLowerCase();
  const checkBasepathWithSlash = `${checkBasepath}/`;
  return {
    input: ({ url }) => {
      const pathname = opts.caseSensitive ? url.pathname : url.pathname.toLowerCase();
      if (pathname === checkBasepath) url.pathname = "/";
      else if (pathname.startsWith(checkBasepathWithSlash)) url.pathname = url.pathname.slice(normalizedBasepath.length);
      return url;
    },
    output: ({ url }) => {
      url.pathname = joinPaths([
        "/",
        trimmedBasepath,
        url.pathname
      ]);
      return url;
    }
  };
}
function executeRewriteInput(rewrite, url) {
  const res = rewrite?.input?.({ url });
  if (res) {
    if (typeof res === "string") return new URL(res);
    else if (res instanceof URL) return res;
  }
  return url;
}
function executeRewriteOutput(rewrite, url) {
  const res = rewrite?.output?.({ url });
  if (res) {
    if (typeof res === "string") return new URL(res);
    else if (res instanceof URL) return res;
  }
  return url;
}

// ../../node_modules/@tanstack/router-core/dist/esm/stores.js
function createNonReactiveMutableStore(initialValue) {
  let value = initialValue;
  return {
    get() {
      return value;
    },
    set(nextOrUpdater) {
      value = functionalUpdate(nextOrUpdater, value);
    }
  };
}
function createNonReactiveReadonlyStore(read) {
  return { get() {
    return read();
  } };
}
function createRouterStores(initialLocation, config) {
  const { createMutableStore, createReadonlyStore, batch: batch2 } = config;
  const byRoute = /* @__PURE__ */ new Map();
  const status = createMutableStore("idle");
  const location = createMutableStore(initialLocation);
  const resolvedLocation = createMutableStore(void 0);
  const ids = createMutableStore([]);
  const matches = createReadonlyStore(() => ids.get().map((id) => byRoute.get(id).get()));
  const __store = createReadonlyStore(() => ({
    status: status.get(),
    isLoading: status.get() === "pending",
    matches: matches.get(),
    location: location.get(),
    resolvedLocation: resolvedLocation.get()
  }));
  function getMatchStore(routeId) {
    let matchStore = byRoute.get(routeId);
    if (!matchStore) {
      matchStore = createMutableStore(void 0);
      byRoute.set(routeId, matchStore);
    }
    return matchStore;
  }
  const store = {
    status,
    location,
    resolvedLocation,
    ids,
    matches,
    byRoute,
    __store,
    getMatchStore,
    setMatches
  };
  function setMatches(nextMatches) {
    const previousIds = ids.get();
    const nextIds = nextMatches.map((match) => match.routeId);
    batch2(() => {
      if (!arraysEqual(previousIds, nextIds)) ids.set(nextIds);
      for (const id of previousIds) if (!nextIds.includes(id)) byRoute.get(id).set(() => void 0);
      for (const nextMatch of nextMatches) {
        const matchStore = getMatchStore(nextMatch.routeId);
        if (matchStore.get() !== nextMatch) matchStore.set(nextMatch);
      }
    });
  }
  return store;
}

// ../../node_modules/@tanstack/history/dist/esm/index.js
var stateIndexKey = "__TSR_index";
var popStateEvent = "popstate";
var beforeUnloadEvent = "beforeunload";
function createHistory(opts) {
  let location = opts.getLocation();
  const subscribers = /* @__PURE__ */ new Set();
  const notify = (action) => {
    location = opts.getLocation();
    subscribers.forEach((subscriber) => subscriber({
      location,
      action
    }));
  };
  const handleIndexChange = (action) => {
    if (opts.notifyOnIndexChange ?? true) notify(action);
    else location = opts.getLocation();
  };
  const tryNavigation = async ({ task, navigateOpts, ...actionInfo }) => {
    if (navigateOpts?.ignoreBlocker ?? false) {
      task();
      return;
    }
    const blockers = opts.getBlockers?.() ?? [];
    const isPushOrReplace = actionInfo.type === "PUSH" || actionInfo.type === "REPLACE";
    if (typeof document !== "undefined" && blockers.length && isPushOrReplace) for (const blocker of blockers) {
      const nextLocation = parseHref(actionInfo.path, actionInfo.state);
      if (await blocker.blockerFn({
        currentLocation: location,
        nextLocation,
        action: actionInfo.type
      })) {
        opts.onBlocked?.();
        return;
      }
    }
    task();
  };
  return {
    get location() {
      return location;
    },
    get length() {
      return opts.getLength();
    },
    subscribers,
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    push: (path, state, navigateOpts) => {
      const currentIndex = location.state[stateIndexKey];
      state = assignKeyAndIndex(currentIndex + 1, state);
      tryNavigation({
        task: () => {
          opts.pushState(path, state);
          notify({ type: "PUSH" });
        },
        navigateOpts,
        type: "PUSH",
        path,
        state
      });
    },
    replace: (path, state, navigateOpts) => {
      const currentIndex = location.state[stateIndexKey];
      state = assignKeyAndIndex(currentIndex, state);
      tryNavigation({
        task: () => {
          opts.replaceState(path, state);
          notify({ type: "REPLACE" });
        },
        navigateOpts,
        type: "REPLACE",
        path,
        state
      });
    },
    go: (index, navigateOpts) => {
      tryNavigation({
        task: () => {
          opts.go(index);
          handleIndexChange({
            type: "GO",
            index
          });
        },
        navigateOpts,
        type: "GO"
      });
    },
    back: (navigateOpts) => {
      tryNavigation({
        task: () => {
          opts.back(navigateOpts?.ignoreBlocker ?? false);
          handleIndexChange({ type: "BACK" });
        },
        navigateOpts,
        type: "BACK"
      });
    },
    forward: (navigateOpts) => {
      tryNavigation({
        task: () => {
          opts.forward(navigateOpts?.ignoreBlocker ?? false);
          handleIndexChange({ type: "FORWARD" });
        },
        navigateOpts,
        type: "FORWARD"
      });
    },
    canGoBack: () => location.state[stateIndexKey] !== 0,
    createHref: (str) => opts.createHref(str),
    block: (blocker) => {
      if (!opts.setBlockers) return () => {
      };
      const blockers = opts.getBlockers?.() ?? [];
      opts.setBlockers([...blockers, blocker]);
      return () => {
        const blockers2 = opts.getBlockers?.() ?? [];
        opts.setBlockers?.(blockers2.filter((b) => b !== blocker));
      };
    },
    flush: () => opts.flush?.(),
    destroy: () => opts.destroy?.(),
    notify
  };
}
function assignKeyAndIndex(index, state) {
  if (!state) state = {};
  const key = createRandomKey();
  return {
    ...state,
    key,
    __TSR_key: key,
    [stateIndexKey]: index
  };
}
function createBrowserHistory(opts) {
  const win = opts?.window ?? (typeof document !== "undefined" ? window : void 0);
  const originalPushState = win.history.pushState;
  const originalReplaceState = win.history.replaceState;
  let blockers = [];
  const _getBlockers = () => blockers;
  const _setBlockers = (newBlockers) => blockers = newBlockers;
  const createHref = opts?.createHref ?? ((path) => path);
  const parseLocation = opts?.parseLocation ?? (() => parseHref(`${win.location.pathname}${win.location.search}${win.location.hash}`, win.history.state));
  if (!win.history.state?.__TSR_key && !win.history.state?.key) {
    const addedKey = createRandomKey();
    win.history.replaceState({
      [stateIndexKey]: 0,
      key: addedKey,
      __TSR_key: addedKey
    }, "");
  }
  let currentLocation = parseLocation();
  let rollbackLocation;
  let nextPopIsGo = false;
  let ignoreNextPop = false;
  let skipBlockerNextPop = false;
  let ignoreNextBeforeUnload = false;
  const getLocation = () => currentLocation;
  let next;
  const flush2 = () => {
    if (!next) return;
    history2._ignoreSubscribers = true;
    (next[2] ? win.history.pushState : win.history.replaceState)(next[1], "", next[0]);
    history2._ignoreSubscribers = false;
    next = void 0;
    rollbackLocation = void 0;
  };
  const queueHistoryAction = (isPush, destHref, state) => {
    const href = createHref(destHref);
    const hasPendingAction = !!next;
    if (!hasPendingAction) rollbackLocation = currentLocation;
    currentLocation = parseHref(destHref, state);
    next = [
      href,
      state,
      next?.[2] || isPush
    ];
    if (!hasPendingAction) queueMicrotask(() => flush2());
  };
  const onPushPop = (type) => {
    currentLocation = parseLocation();
    history2.notify({ type });
  };
  const onPushPopEvent = async () => {
    if (ignoreNextPop) {
      ignoreNextPop = false;
      return;
    }
    const nextLocation = parseLocation();
    const delta = nextLocation.state[stateIndexKey] - currentLocation.state[stateIndexKey];
    const isForward = delta === 1;
    const isBack = delta === -1;
    const isGo = !isForward && !isBack || nextPopIsGo;
    nextPopIsGo = false;
    const action = isGo ? "GO" : isBack ? "BACK" : "FORWARD";
    const notify = isGo ? {
      type: "GO",
      index: delta
    } : { type: isBack ? "BACK" : "FORWARD" };
    if (skipBlockerNextPop) skipBlockerNextPop = false;
    else {
      const blockers2 = _getBlockers();
      if (typeof document !== "undefined" && blockers2.length) {
        for (const blocker of blockers2) if (await blocker.blockerFn({
          currentLocation,
          nextLocation,
          action
        })) {
          ignoreNextPop = true;
          win.history.go(1);
          history2.notify(notify);
          return;
        }
      }
    }
    currentLocation = parseLocation();
    history2.notify(notify);
  };
  const onBeforeUnload = (e) => {
    if (ignoreNextBeforeUnload) {
      ignoreNextBeforeUnload = false;
      return;
    }
    let shouldBlock = false;
    const blockers2 = _getBlockers();
    if (typeof document !== "undefined" && blockers2.length) for (const blocker of blockers2) {
      const shouldHaveBeforeUnload = blocker.enableBeforeUnload ?? true;
      if (shouldHaveBeforeUnload === true) {
        shouldBlock = true;
        break;
      }
      if (typeof shouldHaveBeforeUnload === "function" && shouldHaveBeforeUnload() === true) {
        shouldBlock = true;
        break;
      }
    }
    if (shouldBlock) {
      e.preventDefault();
      return e.returnValue = "";
    }
  };
  const history2 = createHistory({
    getLocation,
    getLength: () => win.history.length,
    pushState: (href, state) => queueHistoryAction(true, href, state),
    replaceState: (href, state) => queueHistoryAction(false, href, state),
    back: (ignoreBlocker) => {
      if (ignoreBlocker) skipBlockerNextPop = true;
      ignoreNextBeforeUnload = true;
      return win.history.back();
    },
    forward: (ignoreBlocker) => {
      if (ignoreBlocker) skipBlockerNextPop = true;
      ignoreNextBeforeUnload = true;
      win.history.forward();
    },
    go: (n) => {
      nextPopIsGo = true;
      win.history.go(n);
    },
    createHref: (href) => createHref(href),
    flush: flush2,
    destroy: () => {
      win.history.pushState = originalPushState;
      win.history.replaceState = originalReplaceState;
      win.removeEventListener(beforeUnloadEvent, onBeforeUnload, { capture: true });
      win.removeEventListener(popStateEvent, onPushPopEvent);
    },
    onBlocked: () => {
      if (rollbackLocation && currentLocation !== rollbackLocation) currentLocation = rollbackLocation;
    },
    getBlockers: _getBlockers,
    setBlockers: _setBlockers,
    notifyOnIndexChange: false
  });
  win.addEventListener(beforeUnloadEvent, onBeforeUnload, { capture: true });
  win.addEventListener(popStateEvent, onPushPopEvent);
  win.history.pushState = function(...args) {
    const res = originalPushState.apply(win.history, args);
    if (!history2._ignoreSubscribers) onPushPop("PUSH");
    return res;
  };
  win.history.replaceState = function(...args) {
    const res = originalReplaceState.apply(win.history, args);
    if (!history2._ignoreSubscribers) onPushPop("REPLACE");
    return res;
  };
  return history2;
}
function createHashHistory(opts) {
  const win = opts?.window ?? (typeof document !== "undefined" ? window : void 0);
  return createBrowserHistory({
    window: win,
    parseLocation: () => {
      const hashSplit = win.location.hash.split("#").slice(1);
      const pathPart = hashSplit[0] ?? "/";
      const searchPart = win.location.search;
      const hashEntries = hashSplit.slice(1);
      return parseHref(`${pathPart}${searchPart}${hashEntries.length === 0 ? "" : `#${hashEntries.join("#")}`}`, win.history.state);
    },
    createHref: (href) => `${win.location.pathname}${win.location.search}#${href}`
  });
}
function createMemoryHistory(opts = { initialEntries: ["/"] }) {
  const entries = opts.initialEntries;
  let index = opts.initialIndex ? Math.min(Math.max(opts.initialIndex, 0), entries.length - 1) : entries.length - 1;
  const states = entries.map((_entry, index2) => assignKeyAndIndex(index2, void 0));
  const getLocation = () => parseHref(entries[index], states[index]);
  let blockers = [];
  const _getBlockers = () => blockers;
  const _setBlockers = (newBlockers) => blockers = newBlockers;
  return createHistory({
    getLocation,
    getLength: () => entries.length,
    pushState: (path, state) => {
      if (index < entries.length - 1) {
        entries.splice(index + 1);
        states.splice(index + 1);
      }
      states.push(state);
      entries.push(path);
      index = Math.max(entries.length - 1, 0);
    },
    replaceState: (path, state) => {
      states[index] = state;
      entries[index] = path;
    },
    back: () => {
      index = Math.max(index - 1, 0);
    },
    forward: () => {
      index = Math.min(index + 1, entries.length - 1);
    },
    go: (n) => {
      index = Math.min(Math.max(index + n, 0), entries.length - 1);
    },
    createHref: (path) => path,
    getBlockers: _getBlockers,
    setBlockers: _setBlockers
  });
}
function sanitizePath(path) {
  let sanitized = path.replace(/[\x00-\x1f\x7f]/g, "");
  if (sanitized.startsWith("//")) sanitized = "/" + sanitized.replace(/^\/+/, "");
  return sanitized;
}
function parseHref(href, state) {
  const sanitizedHref = sanitizePath(href);
  const hashIndex = sanitizedHref.indexOf("#");
  const searchIndex = sanitizedHref.indexOf("?");
  const addedKey = createRandomKey();
  return {
    href: sanitizedHref,
    pathname: sanitizedHref.substring(0, hashIndex > 0 ? searchIndex > 0 ? Math.min(hashIndex, searchIndex) : hashIndex : searchIndex > 0 ? searchIndex : sanitizedHref.length),
    hash: hashIndex > -1 ? sanitizedHref.substring(hashIndex) : "",
    search: searchIndex > -1 ? sanitizedHref.slice(searchIndex, hashIndex === -1 ? void 0 : hashIndex) : "",
    state: state || {
      [stateIndexKey]: 0,
      key: addedKey,
      __TSR_key: addedKey
    }
  };
}
function createRandomKey() {
  return (Math.random() + 1).toString(36).substring(7);
}

// ../../node_modules/@tanstack/router-core/dist/esm/router.js
function routeNeedsLoad(route) {
  return route.options.loader || route.options.beforeLoad || route.lazyFn || route.options.component?.preload || route.options.pendingComponent?.preload;
}
function defaultSerializeError(err) {
  if (err instanceof Error) {
    const obj = {
      name: err.name,
      message: err.message
    };
    if (true) obj.stack = err.stack;
    return obj;
  }
  return { data: err };
}
function getLocationChangeInfo(location, resolvedLocation) {
  return {
    fromLocation: resolvedLocation,
    toLocation: location,
    pathChanged: resolvedLocation?.pathname !== location.pathname,
    hrefChanged: resolvedLocation?.href !== location.href,
    hashChanged: resolvedLocation?.hash !== location.hash
  };
}
function _getUserHistoryState({ key: _key, __TSR_key: _tsrKey, __TSR_index: _tsrIndex, __hashScrollIntoViewOptions: _hashScroll, ...state }) {
  return state;
}
function runRouteLifecycle(router, previous, matches, owner) {
  for (const match of previous) {
    if (owner && router._tx !== owner) return;
    if (!matches.some((candidate) => candidate.routeId === match.routeId)) router.routesById[match.routeId].options.onLeave?.(match);
  }
  for (const match of matches) {
    if (owner && router._tx !== owner) return;
    router.routesById[match.routeId].options[previous.some((candidate) => candidate.routeId === match.routeId) ? "onStay" : "onEnter"]?.(match);
  }
}
var RouterCore = class {
  /**
  * @deprecated Use the `createRouter` function instead
  */
  constructor(options, getStoreConfig) {
    this.tempLocationKey = `${Math.round(Math.random() * 1e7)}`;
    this._scroll = { next: true };
    this.subscribers = /* @__PURE__ */ new Set();
    this._cache = /* @__PURE__ */ new Map();
    this._committed = [];
    this.routeBranchCache = /* @__PURE__ */ new WeakMap();
    this.lightweightCache = /* @__PURE__ */ new WeakMap();
    this.startTransition = async (fn) => {
      fn();
      return false;
    };
    this.update = (newOptions) => {
      if (true) {
        if (newOptions.notFoundRoute) console.warn("The notFoundRoute API is deprecated and will be removed in the next major version. See https://tanstack.com/router/v1/docs/framework/react/guide/not-found-errors#migrating-from-notfoundroute for more info.");
      }
      const prevOptions = this.options;
      const prevBasepath = this.basepath ?? prevOptions?.basepath ?? "/";
      const basepathWasUnset = this.basepath === void 0;
      const prevRewriteOption = prevOptions?.rewrite;
      this.options = {
        ...prevOptions,
        ...newOptions
      };
      this.isServer = this.options.isServer ?? isServer ?? typeof document === "undefined";
      this.protocolAllowlist = new Set(this.options.protocolAllowlist);
      if (this.options.pathParamsAllowedCharacters) this.pathParamsDecoder = compileDecodeCharMap(this.options.pathParamsAllowedCharacters);
      if (!this.history || this.options.history && this.options.history !== this.history) if (!this.options.history) {
        if (!(isServer ?? this.isServer)) this.history = createBrowserHistory();
      } else this.history = this.options.history;
      this.origin = this.options.origin;
      if (!this.origin) if (!(isServer ?? this.isServer) && window?.origin && window.origin !== "null") this.origin = window.origin;
      else this.origin = "http://localhost";
      if (this.history) this.updateLatestLocation();
      if (this.options.routeTree !== this.routeTree) {
        this.routeTree = this.options.routeTree;
        let processRouteTreeResult;
        if ((isServer ?? this.isServer) && false) {
          const cached = globalThis.__TSR_CACHE__;
          this.resolvePathCache = cached.resolvePathCache;
          processRouteTreeResult = cached.processRouteTreeResult;
        } else {
          this.resolvePathCache = createLRUCache(1e3);
          processRouteTreeResult = this.buildRouteTree();
          if ((isServer ?? this.isServer) && false) globalThis.__TSR_CACHE__ = {
            routeTree: this.routeTree,
            processRouteTreeResult,
            resolvePathCache: this.resolvePathCache
          };
        }
        this.setRoutes(processRouteTreeResult);
      }
      if (!this.stores && this.latestLocation) {
        const config = this.getStoreConfig(this);
        this.batch = config.batch;
        this.stores = createRouterStores(this.latestLocation, config);
        if (!(isServer ?? this.isServer)) setupScrollRestoration(this);
      }
      const nextBasepath = this.options.basepath ?? "/";
      const nextRewriteOption = this.options.rewrite;
      if (basepathWasUnset || prevBasepath !== nextBasepath || prevRewriteOption !== nextRewriteOption) {
        this.basepath = nextBasepath;
        const rewrites = [];
        const trimmed = trimPath(nextBasepath);
        if (trimmed && trimmed !== "/") rewrites.push(rewriteBasepath({ basepath: nextBasepath }));
        if (nextRewriteOption) rewrites.push(nextRewriteOption);
        this.rewrite = rewrites.length === 0 ? void 0 : rewrites.length === 1 ? rewrites[0] : composeRewrites(rewrites);
        if (this.history) this.updateLatestLocation();
        if (this.stores) this.stores.location.set(this.latestLocation);
      }
    };
    this.updateLatestLocation = () => {
      this.latestLocation = this.parseLocation(this.history.location, this.latestLocation);
    };
    this.buildRouteTree = () => {
      const result = processRouteTree(this.routeTree, this.options.caseSensitive, (route, i) => {
        route.init({ originalIndex: i });
      });
      if (this.options.routeMasks) processRouteMasks(this.options.routeMasks, result.processedTree);
      return result;
    };
    this.subscribe = (eventType, fn) => {
      const listener = {
        eventType,
        fn
      };
      this.subscribers.add(listener);
      return () => {
        this.subscribers.delete(listener);
      };
    };
    this.emit = (routerEvent) => {
      for (const listener of this.subscribers) if (listener.eventType === routerEvent.type) try {
        listener.fn(routerEvent);
      } catch (e) {
        console.error(e);
      }
    };
    this.parseLocation = (locationToParse, previousLocation) => {
      const parse = ({ pathname, search, hash, href, state }) => {
        if (!this.rewrite && !/[ \x00-\x1f\x7f\u0080-\uffff]/.test(pathname)) {
          const parsedSearch2 = this.options.parseSearch(search);
          const searchStr2 = this.options.stringifySearch(parsedSearch2);
          return {
            href: pathname + searchStr2 + hash,
            publicHref: pathname + searchStr2 + hash,
            pathname: decodePath(pathname).path,
            external: false,
            searchStr: searchStr2,
            search: nullReplaceEqualDeep(previousLocation?.search, parsedSearch2),
            hash: decodePath(hash.slice(1)).path,
            state: replaceEqualDeep(previousLocation?.state, state)
          };
        }
        const fullUrl = new URL(href, this.origin);
        const url = executeRewriteInput(this.rewrite, fullUrl);
        const parsedSearch = this.options.parseSearch(url.search);
        const searchStr = this.options.stringifySearch(parsedSearch);
        url.search = searchStr;
        return {
          href: url.href.replace(url.origin, ""),
          publicHref: href,
          pathname: decodePath(url.pathname).path,
          external: !!this.rewrite && url.origin !== this.origin,
          searchStr,
          search: nullReplaceEqualDeep(previousLocation?.search, parsedSearch),
          hash: decodePath(url.hash.slice(1)).path,
          state: replaceEqualDeep(previousLocation?.state, state)
        };
      };
      const location = parse(locationToParse);
      const { __tempLocation, __tempKey } = location.state;
      if (__tempLocation && (!__tempKey || __tempKey === this.tempLocationKey)) {
        const parsedTempLocation = parse(__tempLocation);
        parsedTempLocation.state.key = location.state.key;
        parsedTempLocation.state.__TSR_key = location.state.__TSR_key;
        delete parsedTempLocation.state.__tempLocation;
        return {
          ...parsedTempLocation,
          maskedLocation: location
        };
      }
      return location;
    };
    this.resolvePathWithBase = (from, path) => {
      return resolvePath({
        base: from,
        to: path,
        trailingSlash: this.options.trailingSlash,
        cache: this.resolvePathCache
      });
    };
    this.matchRoutes = (pathnameOrNext, locationSearchOrOpts, opts) => {
      if (typeof pathnameOrNext === "string") return this.matchRoutesInternal({
        pathname: pathnameOrNext,
        search: locationSearchOrOpts
      }, opts);
      return this.matchRoutesInternal(pathnameOrNext, locationSearchOrOpts);
    };
    this.getMatchedRoutes = (pathname) => {
      const rawParams = /* @__PURE__ */ Object.create(null);
      const match = findRouteMatch(trimPathRight2(pathname), this.processedTree, true);
      if (match) Object.assign(rawParams, match.rawParams);
      return [
        match?.branch || [this.routesById["__root__"]],
        rawParams,
        match?.route
      ];
    };
    this.buildLocation = (opts) => {
      const build = (dest = {}) => {
        if (dest.href) {
          const parsed = parseHref(dest.href, {});
          dest = {
            ...dest,
            to: executeRewriteInput(this.rewrite, new URL(parsed.pathname, this.origin)).pathname,
            search: this.options.parseSearch(parsed.search),
            hash: parsed.hash.slice(1)
          };
        }
        const currentLocation = dest._fromLocation || this._pendingLocation || this.latestLocation;
        const lightweightResult = this.matchRoutesLightweight(currentLocation);
        if (dest.from && true && dest._isNavigate) {
          const [allFromMatches] = this.getMatchedRoutes(dest.from);
          const matchedFrom = findLast(lightweightResult[0], (d) => {
            return comparePaths(d.fullPath, dest.from);
          });
          const matchedCurrent = findLast(allFromMatches, (d) => {
            return comparePaths(d.fullPath, lightweightResult[1]);
          });
          if (!matchedFrom && !matchedCurrent) console.warn(`Could not find match for from: ${dest.from}`);
        }
        const defaultedFromPath = dest.unsafeRelative === "path" ? currentLocation.pathname : dest.from ?? lightweightResult[1];
        const fromSearch = lightweightResult[2];
        const fromParams = lightweightResult[3];
        const nextTo = this.resolvePathWithBase(defaultedFromPath, dest.to ? `${dest.to}` : ".");
        let nextParams = resolveNextParams(dest.params, fromParams);
        const destRoute = this.routesByPath[trimPathRight2(nextTo)];
        let destRoutes;
        if (destRoute) destRoutes = this.getRouteBranch(destRoute);
        else if (nextTo.includes("$")) destRoutes = [];
        else {
          const [matchedRoutes, rawParams, foundRoute] = this.getMatchedRoutes(nextTo);
          destRoutes = matchedRoutes;
          if (this.options.notFoundRoute && (!foundRoute || foundRoute.path !== "/" && rawParams["**"])) destRoutes = [...destRoutes, this.options.notFoundRoute];
        }
        if (destRoutes.length && hasKeys(nextParams)) for (const route of destRoutes) {
          const fn = route.options.params?.stringify ?? route.options.stringifyParams;
          if (fn) {
            if (nextParams === fromParams) nextParams = Object.assign(/* @__PURE__ */ Object.create(null), nextParams);
            try {
              Object.assign(nextParams, fn(nextParams));
            } catch {
            }
          }
        }
        const nextPathname = opts.leaveParams ? nextTo : decodePath(interpolatePath({
          path: nextTo,
          params: nextParams,
          decoder: this.pathParamsDecoder,
          server: this.isServer
        }).interpolatedPath).path;
        if (destRoute && !opts.leaveParams) try {
          const foundRoute = this.getMatchedRoutes(nextPathname)[2];
          if (foundRoute?.id !== destRoute.id) console.warn(`Generated path "${nextPathname}" for route "${destRoute.id}" matched route "${foundRoute?.id}" instead. This can happen when multiple route templates resolve to the same URL. Use the route template that matches the intended route, or adjust params.stringify if it changed the target path.`);
        } catch {
        }
        let nextSearch = fromSearch;
        if (opts._includeValidateSearch && this.options.search?.strict) {
          const validatedSearch = {};
          destRoutes.forEach((route) => {
            if (route.options.validateSearch) try {
              Object.assign(validatedSearch, validateSearch(route.options.validateSearch, {
                ...validatedSearch,
                ...nextSearch
              }));
            } catch {
            }
          });
          nextSearch = validatedSearch;
        }
        nextSearch = applySearchMiddleware(nextSearch, dest, destRoutes, opts._includeValidateSearch);
        nextSearch = nullReplaceEqualDeep(fromSearch, nextSearch);
        const searchStr = this.options.stringifySearch(nextSearch);
        const hash = dest.hash === true ? currentLocation.hash : dest.hash ? functionalUpdate(dest.hash, currentLocation.hash) : void 0;
        const hashStr = hash ? `#${hash}` : "";
        let nextState = dest.state === true ? currentLocation.state : dest.state ? functionalUpdate(dest.state, currentLocation.state) : {};
        if (dest.state) nextState = replaceEqualDeep(currentLocation.state, nextState);
        const fullPath = `${nextPathname}${searchStr}${hashStr}`;
        let href;
        let publicHref;
        let external = false;
        if (this.rewrite) {
          const url = new URL(fullPath, this.origin);
          const rewrittenUrl = executeRewriteOutput(this.rewrite, url);
          href = url.href.replace(url.origin, "");
          if (rewrittenUrl.origin !== this.origin) {
            publicHref = rewrittenUrl.href;
            external = true;
          } else publicHref = rewrittenUrl.pathname + rewrittenUrl.search + rewrittenUrl.hash;
        } else {
          href = encodePathLikeUrl(fullPath);
          publicHref = href;
        }
        return {
          publicHref,
          href,
          pathname: nextPathname,
          search: nextSearch,
          searchStr,
          state: nextState,
          hash: hash ?? "",
          external,
          unmaskOnReload: dest.unmaskOnReload
        };
      };
      const next = build(opts);
      if (opts.mask) next.maskedLocation = build({
        from: opts.from,
        ...opts.mask
      });
      else if (this.options.routeMasks) {
        const match = findFlatMatch(next.pathname, this.processedTree);
        if (match) {
          const params = Object.assign(/* @__PURE__ */ Object.create(null), match.rawParams);
          const { from: _from, params: maskParams, ...maskProps } = match.route;
          const nextParams = resolveNextParams(maskParams, params);
          next.maskedLocation = build({
            from: opts.from,
            ...maskProps,
            params: nextParams
          });
        }
      }
      return next;
    };
    this.commitLocation = async ({ viewTransition, ignoreBlocker, ...next }) => {
      let historyAction;
      const isSameLocation = trimPathRight2(this.latestLocation.href) === trimPathRight2(next.href) && deepEqual(_getUserHistoryState(next.state), _getUserHistoryState(this.latestLocation.state));
      const previousCommitPromise = this._commitPromise;
      let resolve;
      const commitPromise = new Promise((done) => {
        resolve = done;
      });
      commitPromise.resolve = () => {
        resolve();
        previousCommitPromise?.resolve();
      };
      this._commitPromise = commitPromise;
      if (isSameLocation) this.load();
      else {
        let { maskedLocation, hashScrollIntoView, ...nextHistory } = next;
        if (maskedLocation) {
          nextHistory = {
            ...maskedLocation,
            state: {
              ...maskedLocation.state,
              __tempKey: void 0,
              __tempLocation: {
                ...nextHistory,
                search: nextHistory.searchStr,
                state: {
                  ...nextHistory.state,
                  __tempKey: void 0,
                  __tempLocation: void 0,
                  __TSR_key: void 0,
                  key: void 0
                }
              }
            }
          };
          if (nextHistory.unmaskOnReload ?? this.options.unmaskOnReload ?? false) nextHistory.state.__tempKey = this.tempLocationKey;
        }
        nextHistory.state.__hashScrollIntoViewOptions = hashScrollIntoView ?? this.options.defaultHashScrollIntoView ?? true;
        this.shouldViewTransition = viewTransition;
        historyAction = next.replace ? "REPLACE" : "PUSH";
        this.history[historyAction === "REPLACE" ? "replace" : "push"](nextHistory.publicHref, nextHistory.state, { ignoreBlocker });
        if (!this.history.subscribers.size) this.load({ action: { type: historyAction } });
      }
      this._scroll.next = next.resetScroll ?? true;
      return this._commitPromise;
    };
    this.buildAndCommitLocation = ({ replace, resetScroll, hashScrollIntoView, viewTransition, ignoreBlocker, ...rest } = {}) => {
      const location = this.buildLocation({
        ...rest,
        _includeValidateSearch: true
      });
      this._pendingLocation = location;
      const commitPromise = this.commitLocation({
        ...location,
        viewTransition,
        replace,
        resetScroll,
        hashScrollIntoView,
        ignoreBlocker
      });
      queueMicrotask(() => {
        if (this._pendingLocation === location) this._pendingLocation = void 0;
      });
      return commitPromise;
    };
    this.navigate = async ({ to, reloadDocument, href, publicHref, ...rest }) => {
      let hrefIsUrl = false;
      if (href) try {
        new URL(`${href}`);
        hrefIsUrl = true;
      } catch {
      }
      if (hrefIsUrl && !reloadDocument) reloadDocument = true;
      if (reloadDocument) {
        if (to !== void 0 || !href) {
          const location = this.buildLocation({
            to,
            ...rest
          });
          href = href ?? location.publicHref;
          publicHref = publicHref ?? location.publicHref;
        }
        const reloadHref = !hrefIsUrl && publicHref ? publicHref : href;
        if (isDangerousProtocol(reloadHref, this.protocolAllowlist)) {
          if (true) console.warn(`Blocked navigation to dangerous protocol: ${reloadHref}`);
          return;
        }
        if (!rest.ignoreBlocker) {
          const blockers = this.history.getBlockers?.() ?? [];
          for (const blocker of blockers) if (blocker?.blockerFn) {
            if (await blocker.blockerFn({
              currentLocation: this.latestLocation,
              nextLocation: this.latestLocation,
              action: "PUSH"
            })) return;
          }
        }
        if (rest.replace) window.location.replace(reloadHref);
        else window.location.href = reloadHref;
        return;
      }
      return this.buildAndCommitLocation({
        ...rest,
        href,
        to,
        _isNavigate: true
      });
    };
    this.load = async (opts) => {
      if (isServer ?? this.isServer) return loadServerRoute(this, opts);
      this.updateLatestLocation();
      if (opts?.action) this._scroll.hash = opts.action.type === "PUSH" || opts.action.type === "REPLACE";
      await loadClientRoute(this, opts);
    };
    this.startViewTransition = (fn) => {
      const shouldViewTransition = this.shouldViewTransition ?? this.options.defaultViewTransition;
      this.shouldViewTransition = void 0;
      if (shouldViewTransition && !(isServer ?? typeof document === "undefined") && typeof document.startViewTransition === "function") {
        let startViewTransitionParams;
        if (typeof shouldViewTransition === "object" && window.CSS?.supports?.("selector(:active-view-transition-type(a))")) {
          const next = this.latestLocation;
          const prevLocation = this.stores.resolvedLocation.get();
          const resolvedViewTransitionTypes = typeof shouldViewTransition.types === "function" ? shouldViewTransition.types(getLocationChangeInfo(next, prevLocation)) : shouldViewTransition.types;
          if (resolvedViewTransitionTypes === false) return fn();
          startViewTransitionParams = {
            update: fn,
            types: resolvedViewTransitionTypes
          };
        } else startViewTransitionParams = fn;
        return document.startViewTransition(startViewTransitionParams).updateCallbackDone;
      }
      return fn();
    };
    this.invalidate = (opts) => {
      const committedMatches = this._committed;
      const filter = opts?.filter;
      const preloads = this._preloads;
      const invalidIds = new Set([
        ...committedMatches,
        ...this._cache.values(),
        ...[...preloads?.values() ?? []].flat(),
        ...this._tx?.[3] ?? []
      ].filter((match) => !filter || filter(match)).map((match) => match.id));
      const discardedPreloads = [];
      for (const [controller, matches] of preloads ?? []) if (matches.some((match) => invalidIds.has(match.id))) {
        preloads.delete(controller);
        discardedPreloads.push(controller);
      }
      const invalidate = (d) => {
        if (invalidIds.has(d.id)) {
          const route = this.routesById[d.routeId];
          const next = {
            ...d,
            invalid: true,
            ...(opts?.forcePending || d.status === "error" || d.status === "notFound") && routeNeedsLoad(route) ? {
              status: "pending",
              error: void 0
            } : void 0
          };
          d._flight = void 0;
          return next;
        }
        return d;
      };
      this._committed = committedMatches.map(invalidate);
      for (const [id, match] of this._cache) if (invalidIds.has(id)) {
        match.invalid = true;
        if (opts?.forcePending) match.status = "pending";
      }
      for (const id of invalidIds) this._flights?.delete(id);
      for (const controller of discardedPreloads) controller.abort();
      this.shouldViewTransition = false;
      return this.load({ sync: opts?.sync });
    };
    this.resolveRedirect = (redirect2) => {
      const locationHeader = redirect2.headers.get("Location");
      if (!redirect2.options.href) {
        const href = this.buildLocation(redirect2.options).publicHref || "/";
        redirect2.options.href = href;
        redirect2.headers.set("Location", href);
      } else if (locationHeader) try {
        const url = new URL(locationHeader);
        if (this.origin && url.origin === this.origin) {
          const href = url.pathname + url.search + url.hash;
          redirect2.options.href = href;
          redirect2.headers.set("Location", href);
        }
      } catch {
      }
      if (redirect2.options.href && isDangerousProtocol(redirect2.options.href, this.protocolAllowlist)) throw new Error(true ? `Redirect blocked: unsafe protocol in href "${redirect2.options.href}". Allowed protocols: ${Array.from(this.protocolAllowlist).join(", ")}.` : "Redirect blocked: unsafe protocol");
      if (!redirect2.headers.get("Location")) redirect2.headers.set("Location", redirect2.options.href);
      return redirect2;
    };
    this.clearCache = (opts) => {
      const cached = this._cache;
      const preloads = this._preloads;
      const filter = opts?.filter;
      const discarded = [];
      const discardedIds = [];
      for (const [id, match] of cached) if (!filter || filter(match)) {
        discardedIds.push(id);
        discarded.push(match);
      }
      const abort = [];
      for (const [controller, matches] of preloads ?? []) if (!filter || matches.some(filter)) {
        abort.push(controller);
        discarded.push(...matches);
      }
      for (const id of discardedIds) cached.delete(id);
      for (const controller of abort) preloads.delete(controller);
      for (const match of discarded) {
        const flight = match._flight;
        match._flight = void 0;
        if (flight && !--flight[2]) {
          if (this._flights?.get(match.id) === flight) this._flights.delete(match.id);
          abort.push(flight[1]);
        }
      }
      for (const controller of abort) controller.abort();
    };
    this.loadRouteChunk = loadRouteChunk;
    this.preloadRoute = (opts) => preloadClientRoute(this, opts);
    this.matchRoute = (location, opts) => {
      const matchLocation = {
        ...location,
        to: location.to ? this.resolvePathWithBase(location.from || "", location.to) : void 0,
        params: location.params || {},
        leaveParams: true
      };
      const next = this.buildLocation(matchLocation);
      const isPending = this.stores.status.get() === "pending";
      if (opts?.pending && !isPending) return false;
      const baseLocation = opts?.pending ?? !isPending ? this.latestLocation : this.stores.resolvedLocation.get() || this.stores.location.get();
      const match = findSingleMatch(next.pathname, opts?.caseSensitive ?? false, opts?.fuzzy ?? false, baseLocation.pathname, this.processedTree);
      if (!match) return false;
      if (location.params) {
        if (!deepEqual(match.rawParams, location.params, { partial: true })) return false;
      }
      if (opts?.includeSearch ?? true) return deepEqual(baseLocation.search, next.search, { partial: true }) ? match.rawParams : false;
      return match.rawParams;
    };
    this.getStoreConfig = getStoreConfig;
    this.update({
      defaultPreloadDelay: 50,
      defaultPendingMs: 1e3,
      defaultPendingMinMs: 500,
      context: void 0,
      ...options,
      caseSensitive: options.caseSensitive ?? false,
      notFoundMode: options.notFoundMode ?? "fuzzy",
      stringifySearch: options.stringifySearch ?? defaultStringifySearch,
      parseSearch: options.parseSearch ?? defaultParseSearch,
      protocolAllowlist: options.protocolAllowlist ?? DEFAULT_PROTOCOL_ALLOWLIST
    });
    if (!(isServer ?? typeof document === "undefined")) self.__TSR_ROUTER__ = this;
  }
  isShell() {
    return !!this.options.isShell;
  }
  get state() {
    return this.stores.__store.get();
  }
  setRoutes({ routesById, routesByPath, processedTree }) {
    this.routesById = routesById;
    this.routesByPath = routesByPath;
    this.processedTree = processedTree;
    const notFoundRoute = this.options.notFoundRoute;
    if (notFoundRoute) {
      notFoundRoute.init({ originalIndex: 99999999999 });
      this.routesById[notFoundRoute.id] = notFoundRoute;
    }
  }
  getRouteBranch(route) {
    let branch = this.routeBranchCache.get(route);
    if (!branch) {
      branch = buildRouteBranch(route);
      this.routeBranchCache.set(route, branch);
    }
    return branch;
  }
  matchRoutesInternal(next, opts) {
    const [initialMatchedRoutes, rawParams, foundRoute] = this.getMatchedRoutes(next.pathname);
    let matchedRoutes = initialMatchedRoutes;
    let isGlobalNotFound = false;
    if (foundRoute ? foundRoute.path !== "/" && rawParams["**"] : trimPathRight2(next.pathname)) if (this.options.notFoundRoute) matchedRoutes = [...matchedRoutes, this.options.notFoundRoute];
    else isGlobalNotFound = true;
    const _notFoundRouteId = isGlobalNotFound ? findGlobalNotFoundRouteId(this.options.notFoundMode, matchedRoutes) : void 0;
    const matches = new Array(matchedRoutes.length);
    const committed = this._committed;
    const previousAt = (route, index) => {
      const match = committed[index];
      return match?.routeId === route.id ? match : route === this.options.notFoundRoute ? committed.find((candidate) => candidate.routeId === route.id) : void 0;
    };
    let strictParams;
    for (let index = 0; index < matchedRoutes.length; index++) {
      const route = matchedRoutes[index];
      const parentMatch = matches[index - 1];
      let preMatchSearch;
      let strictMatchSearch;
      let searchError;
      {
        const parentSearch = parentMatch?.search ?? next.search;
        const parentStrictSearch = parentMatch?._strictSearch ?? void 0;
        try {
          const strictSearch = validateSearch(route.options.validateSearch, { ...parentSearch }) ?? void 0;
          preMatchSearch = {
            ...parentSearch,
            ...strictSearch
          };
          strictMatchSearch = {
            ...parentStrictSearch,
            ...strictSearch
          };
        } catch (err) {
          let searchParamError = err;
          if (!(err instanceof SearchParamError)) searchParamError = new SearchParamError(err.message, { cause: err });
          if (opts?.throwOnError) throw searchParamError;
          preMatchSearch = parentSearch;
          strictMatchSearch = {};
          searchError = searchParamError;
        }
      }
      let loaderDeps = "";
      let loaderDepsHash = "";
      try {
        loaderDeps = route.options.loaderDeps?.({ search: preMatchSearch }) ?? "";
        loaderDepsHash = loaderDeps ? JSON.stringify(loaderDeps) || "" : "";
      } catch (cause2) {
        if (opts?.throwOnError) throw cause2;
        searchError ??= cause2;
      }
      const { interpolatedPath, usedParams } = interpolatePath({
        path: route.fullPath,
        params: rawParams,
        decoder: this.pathParamsDecoder,
        server: this.isServer
      });
      const matchId = route.id + interpolatedPath + loaderDepsHash;
      const previousMatch = previousAt(route, index);
      const existingMatch = opts?._rematerialize ? void 0 : this._cache.get(matchId) ?? (previousMatch?.id === matchId ? previousMatch : void 0);
      strictParams = existingMatch?._strictParams ?? Object.assign(usedParams, strictParams);
      let paramsError;
      if (!existingMatch) try {
        extractStrictParams(route, strictParams);
      } catch (err) {
        if (isNotFound(err) || isRedirect(err)) paramsError = err;
        else paramsError = new PathParamError(err.message, { cause: err });
        if (opts?.throwOnError) throw paramsError;
      }
      const cause = previousMatch ? "stay" : "enter";
      let match;
      if (existingMatch) match = {
        ...existingMatch,
        cause,
        search: previousMatch ? nullReplaceEqualDeep(previousMatch.search, preMatchSearch) : nullReplaceEqualDeep(existingMatch.search, preMatchSearch),
        _strictSearch: strictMatchSearch,
        searchError
      };
      else {
        const status = routeNeedsLoad(route) ? "pending" : "success";
        match = {
          id: matchId,
          ssr: isServer ?? this.isServer ? void 0 : route.options.ssr,
          index,
          routeId: route.id,
          params: previousMatch?.params ?? strictParams,
          _strictParams: strictParams,
          pathname: interpolatedPath,
          updatedAt: Date.now(),
          search: previousMatch ? nullReplaceEqualDeep(previousMatch.search, preMatchSearch) : preMatchSearch,
          _strictSearch: strictMatchSearch,
          searchError,
          status,
          isFetching: false,
          error: void 0,
          paramsError,
          context: {},
          abortController: opts?._controller ?? new AbortController(),
          cause,
          loaderDeps: previousMatch ? replaceEqualDeep(previousMatch.loaderDeps, loaderDeps) : loaderDeps,
          invalid: false,
          preload: false,
          staticData: route.options.staticData || {},
          fullPath: route.fullPath
        };
      }
      const _notFound = _notFoundRouteId === route.id;
      if (match._notFound && !_notFound) match.error = void 0;
      match._notFound = _notFound;
      matches[index] = match;
    }
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index];
      match.params = match.cause === "stay" ? nullReplaceEqualDeep(match.params, strictParams) : strictParams;
      if (opts?._controller) match.context = {};
    }
    return matches;
  }
  /**
  * Lightweight route matching for buildLocation.
  * Only computes fullPath, accumulated search, and params - skipping expensive
  * operations like AbortController, loaderDeps, and full match objects.
  */
  matchRoutesLightweight(location) {
    const lastRouteId = last(this.stores.ids.get());
    const lastStateMatch = lastRouteId ? this.stores.byRoute.get(lastRouteId).get() : void 0;
    const lastStateMatchId = lastStateMatch?.id;
    const cached = this.lightweightCache.get(location);
    if (cached && cached[0] === lastStateMatchId) return cached[1];
    const [matchedRoutes, rawParams] = this.getMatchedRoutes(location.pathname);
    const lastRoute = last(matchedRoutes);
    const accumulatedSearch = { ...location.search };
    for (const route of matchedRoutes) try {
      Object.assign(accumulatedSearch, validateSearch(route.options.validateSearch, accumulatedSearch));
    } catch {
    }
    const canReuseParams = lastStateMatch && lastStateMatch.routeId === lastRoute.id && lastStateMatch.pathname === location.pathname;
    let params;
    if (canReuseParams) params = lastStateMatch.params;
    else {
      const strictParams = Object.assign(/* @__PURE__ */ Object.create(null), rawParams);
      for (const route of matchedRoutes) try {
        extractStrictParams(route, strictParams);
      } catch {
      }
      params = strictParams;
    }
    const result = [
      matchedRoutes,
      lastRoute.fullPath,
      accumulatedSearch,
      params
    ];
    this.lightweightCache.set(location, [lastStateMatchId, result]);
    return result;
  }
};
if (true) {
  RouterCore.prototype._replaceRouteChunk = replaceRouteChunk;
  RouterCore.prototype._refreshRoute = async function() {
    this._serverResult = void 0;
    this.updateLatestLocation();
    await refreshClientRoute(this);
  };
}
var SearchParamError = class extends Error {
};
var PathParamError = class extends Error {
};
var normalize = (str) => str.endsWith("/") && str.length > 1 ? str.slice(0, -1) : str;
function comparePaths(a, b) {
  return normalize(a) === normalize(b);
}
function lazyFn(fn, key) {
  return async (...args) => {
    return (await fn())[key || "default"](...args);
  };
}
function validateSearch(validateSearch2, input) {
  if (validateSearch2 == null) return {};
  if ("~standard" in validateSearch2) {
    const result = validateSearch2["~standard"].validate(input);
    if (result instanceof Promise) throw new SearchParamError("Async validation not supported");
    if (result.issues) throw new SearchParamError(JSON.stringify(result.issues, void 0, 2), { cause: result });
    return result.value;
  }
  if ("parse" in validateSearch2) return validateSearch2.parse(input);
  if (typeof validateSearch2 === "function") return validateSearch2(input);
  return {};
}
function applySearchMiddleware(search, dest, destRoutes, includeValidateSearch) {
  const middlewares = [];
  for (const route of destRoutes) {
    const routeOptions = route.options;
    if ("search" in routeOptions) {
      if (routeOptions.search?.middlewares) middlewares.push(...routeOptions.search.middlewares);
    } else if (routeOptions.preSearchFilters || routeOptions.postSearchFilters) {
      const legacyMiddleware = ({ search: search2, next }) => {
        const result = next(routeOptions.preSearchFilters ? routeOptions.preSearchFilters.reduce((prev, next2) => next2(prev), search2) : search2);
        return routeOptions.postSearchFilters ? routeOptions.postSearchFilters.reduce((prev, next2) => next2(prev), result) : result;
      };
      middlewares.push(legacyMiddleware);
    }
    const routeValidateSearch = routeOptions.validateSearch;
    if (includeValidateSearch && routeValidateSearch) {
      const validate = ({ search: search2, next, meta }) => {
        const result = next(search2);
        try {
          const validated = validateSearch(routeValidateSearch, result);
          if (meta && validated) {
            for (const key in validated) if (!(key in result)) (meta.defaulted ||= /* @__PURE__ */ new Map()).set(key, validated[key]);
          }
          return {
            ...result,
            ...validated
          };
        } catch {
        }
        return result;
      };
      middlewares.push(validate);
    }
  }
  const applyNext = (index, currentSearch, meta) => {
    if (index >= middlewares.length) {
      if (!dest.search) return {};
      if (dest.search === true) return currentSearch;
      const result = functionalUpdate(dest.search, currentSearch);
      if (meta) meta.explicit = result;
      return result;
    }
    const next = (newSearch, collectMeta) => {
      if (collectMeta) {
        const nextMeta = meta || {};
        return {
          search: applyNext(index + 1, newSearch, nextMeta),
          meta: nextMeta
        };
      }
      return applyNext(index + 1, newSearch, meta);
    };
    return middlewares[index]({
      search: currentSearch,
      next,
      meta
    });
  };
  return applyNext(0, search);
}
function findGlobalNotFoundRouteId(notFoundMode, routes) {
  if (notFoundMode !== "root") {
    let fallback;
    for (let i = routes.length - 1; i >= 0; i--) {
      const route = routes[i];
      if (route.options.notFoundComponent) return route.id;
      fallback ||= route.children && route.id;
    }
    if (fallback) return fallback;
  }
  return rootRouteId;
}
function resolveNextParams(spec, base) {
  if (spec === false || spec === null) return /* @__PURE__ */ Object.create(null);
  if ((spec ?? true) === true) return base;
  const next = Object.assign(/* @__PURE__ */ Object.create(null), base);
  return Object.assign(next, functionalUpdate(spec, next));
}
function extractStrictParams(route, accumulatedParams) {
  const parseParams = route.options.params?.parse ?? route.options.parseParams;
  if (parseParams) Object.assign(accumulatedParams, parseParams(accumulatedParams));
}

// ../../node_modules/@tanstack/router-core/dist/esm/load-client.js
function replaceRouteChunk(route, lazyFn2) {
  route.lazyFn = lazyFn2 ?? route.lazyFn;
  route._lazy = void 0;
}
function preloadComponent(route, type) {
  return route.options[type]?.preload?.();
}
function loadComponents(route, onPendingReady) {
  const component = preloadComponent(route, "component");
  let pending = preloadComponent(route, "pendingComponent");
  if (onPendingReady) if (pending) pending = pending.then(onPendingReady);
  else onPendingReady();
  if (component && pending) return Promise.all([component, pending]).then(() => {
  });
  return component ?? pending;
}
function loadRouteChunk(route, componentType, onPendingReady) {
  const afterLazy = () => componentType === false ? void 0 : componentType ? preloadComponent(route, componentType) : loadComponents(route, onPendingReady);
  const current = route._lazy;
  if (current) return current === true ? afterLazy() : current.then(afterLazy);
  if (!route.lazyFn) return afterLazy();
  const promise = route.lazyFn().then((lazyRoute) => {
    if (route._lazy === promise) {
      const { id: _id, ...options } = lazyRoute.options;
      Object.assign(route.options, options);
      route._lazy = true;
    }
  }, (error) => {
    if (route._lazy === promise) route._lazy = void 0;
    throw error;
  });
  route._lazy = promise;
  return promise.then(afterLazy);
}
function _getRenderedMatches(matches) {
  const end = matches.findIndex((match) => match.status !== "success" || match._notFound) + 1;
  return end && end < matches.length ? matches.slice(0, end) : matches;
}
function _getAssetMatches(matches) {
  let end = matches.length;
  for (let index = 0; index < end; index++) {
    const match = matches[index];
    if (match._assetEnd !== void 0) {
      end = Math.min(end, Math.max(index + 1, match._assetEnd));
      continue;
    }
    if (match.status !== "success" || match._notFound) {
      end = index + 1;
      break;
    }
  }
  return end < matches.length ? matches.slice(0, end) : matches;
}
var SUCCESS = 0;
var ERROR = 1;
var NOT_FOUND = 2;
var REDIRECTED = 3;
var CANCELED_OUTCOME = [4];
function isControl(result) {
  return typeof result[0] === "number";
}
function waitFor(value, signal) {
  if (signal.aborted) return Promise.race([Promise.reject(signal), value]);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function getRoute(router, match) {
  return router.routesById[match.routeId];
}
function normalize2(value, rejected, routeId) {
  if (isRedirect(value)) return [REDIRECTED, value];
  if (isNotFound(value)) {
    value.routeId ||= routeId;
    return [NOT_FOUND, value];
  }
  if (!rejected) return [SUCCESS, value];
  if (typeof value?.then === "function") value = new Error("A Promise was thrown", { cause: value });
  return [ERROR, value];
}
function normalizeError(route, cause) {
  let outcome = normalize2(cause, true, route.id);
  if (outcome[0] !== ERROR) return outcome;
  try {
    route.options.onError?.(outcome[1]);
  } catch (onErrorCause) {
    outcome = normalize2(onErrorCause, true, route.id);
  }
  return outcome;
}
function normalizeLaneError(router, lane, route, cause, options) {
  if (options[0].signal.aborted) return CANCELED_OUTCOME;
  return materializeRedirect(router, lane, route, normalizeError(route, cause), options);
}
async function contextualize(router, lane, options, end, planSuccessfulLane, retainedEnd) {
  const [location, matches] = lane;
  const signal = options[0].signal;
  const preload = !!options[3];
  for (let index = options[6] ?? 0; index < end; index++) {
    const match = matches[index];
    const route = getRoute(router, match);
    match.abortController = options[0];
    const parentContext = matches[index - 1]?.context ?? router.options.context ?? {};
    const common = {
      params: match.params,
      location,
      navigate: (opts) => router.navigate({
        ...opts,
        _fromLocation: location
      }),
      buildLocation: router.buildLocation,
      cause: preload ? "preload" : match.cause,
      abortController: options[0],
      preload,
      matches,
      routeId: route.id
    };
    try {
      const routeContext = match._ctx ||= route.options.context ? route.options.context({
        ...common,
        deps: match.loaderDeps,
        context: parentContext
      }) || {} : void 0;
      match.context = {
        ...parentContext,
        ...routeContext
      };
    } catch (cause) {
      releaseFlight(router, match);
      return [index, normalizeLaneError(router, lane, route, cause, options)];
    }
    if (signal.aborted) return [index, CANCELED_OUTCOME];
    const validationError = match.paramsError ?? match.searchError;
    if (validationError !== void 0) {
      releaseFlight(router, match);
      return [index, normalizeLaneError(router, lane, route, validationError, options)];
    }
    const beforeLoad = route.options.beforeLoad;
    if (!beforeLoad) continue;
    const previousStatus = match.status;
    if (index >= retainedEnd) {
      match.status = "pending";
      options[7]?.();
    }
    try {
      setFetching(router, match, "beforeLoad", options[0]);
      const result = await waitFor(beforeLoad({
        ...common,
        search: match.search,
        context: match.context,
        ...router.options.additionalContext
      }), signal);
      if (signal.aborted) return [index, CANCELED_OUTCOME];
      const outcome = materializeRedirect(router, lane, route, normalize2(result, false, route.id), options);
      if (outcome[0] !== SUCCESS) {
        releaseFlight(router, match);
        return [index, outcome];
      }
      match.context = {
        ...match.context,
        ...result
      };
    } catch (cause) {
      releaseFlight(router, match);
      return [index, normalizeLaneError(router, lane, route, cause, options)];
    } finally {
      match.status = previousStatus;
      setFetching(router, match, false, options[0]);
    }
  }
  planSuccessfulLane();
}
function releaseOwnedFlight(router, match, flight) {
  if (!flight || --flight[2]) return;
  if (router._flights?.get(match.id) === flight) {
    const current = router._tx;
    if (current && !current[0].signal.aborted && !current[3].includes(match) && current[3].some((candidate) => candidate.id === match.id) && current[3].some((candidate) => candidate.isFetching === "beforeLoad")) return;
    router._flights.delete(match.id);
  }
  return flight[1];
}
function releaseFlight(router, match) {
  const flight = match._flight;
  match._flight = void 0;
  releaseOwnedFlight(router, match, flight)?.abort();
}
function transferMatchResources(router, previous, next, deferSameIdFlight) {
  const abort = [];
  for (const match of previous) if (!next?.includes(match)) {
    const flight = match._flight;
    match._flight = void 0;
    if (deferSameIdFlight && flight?.[2] === 1 && router._flights?.get(match.id) === flight && next?.some((candidate) => candidate.id === match.id)) flight[2] = 0;
    else {
      const controller = releaseOwnedFlight(router, match, flight);
      if (controller) abort.push(controller);
    }
  }
  for (const controller of abort) controller.abort();
}
function acquireMatchResources(matches) {
  for (const match of matches) {
    const flight = match._flight;
    if (flight) flight[2]++;
  }
}
function setFetching(router, match, value, owner) {
  match.isFetching = value;
  if (owner && router._tx?.[0] !== owner) return;
  const store = router.stores.byRoute.get(match.routeId);
  const presented = store?.get();
  if (presented?.id === match.id) store.set({
    ...presented,
    isFetching: value
  });
}
function getLoaderContext(router, lane, match, route, controller, parentMatchPromise, preload) {
  const location = lane[0];
  return {
    params: match.params,
    location,
    navigate: (opts) => router.navigate({
      ...opts,
      _fromLocation: location
    }),
    cause: preload ? "preload" : match.cause,
    abortController: controller,
    preload,
    deps: match.loaderDeps,
    parentMatchPromise,
    context: match.context,
    route,
    ...router.options.additionalContext
  };
}
async function loadResource(router, lane, match, route, loader, parentMatchPromise, options) {
  const owner = options[0];
  const signal = owner.signal;
  if (signal.aborted) return CANCELED_OUTCOME;
  if (!loader) return [SUCCESS, void 0];
  let flight = match._flight;
  setFetching(router, match, "loader", owner);
  try {
    if (!flight) {
      const controller = new AbortController();
      flight = [
        Promise.resolve().then(() => loader(getLoaderContext(router, lane, match, route, controller, parentMatchPromise, !!options[3]))).then((value) => normalize2(value, false, route.id), (cause) => normalize2(cause, true, route.id)).then((result) => {
          if (result[0] !== SUCCESS && router._flights?.get(match.id) === flight) {
            router._flights.delete(match.id);
            if (!flight[2]) controller.abort();
          }
          return result[0] === ERROR && flight[2] ? normalizeError(route, result[1]) : result;
        }),
        controller,
        1
      ];
      (router._flights ??= /* @__PURE__ */ new Map()).set(match.id, flight);
    }
    match._flight = flight;
    match.abortController = flight[1];
    return materializeRedirect(router, lane, route, await waitFor(flight[0], signal), options);
  } catch (cause) {
    if (cause !== signal || !signal.aborted) throw cause;
    releaseFlight(router, match);
    return CANCELED_OUTCOME;
  } finally {
    setFetching(router, match, false, owner);
  }
}
function settleInto(match, result, preload) {
  if (result[0] === REDIRECTED) return;
  match.status = "success";
  match.error = void 0;
  if (result[0] === SUCCESS) {
    match.loaderData = result[1];
    match.invalid = false;
    match.updatedAt = Date.now();
    match.preload = preload;
  } else match.invalid = true;
}
function cacheLoaderMatch(router, match, planned) {
  const current = router._cache.get(match.id);
  if (current !== planned || router._committed.some((candidate) => candidate.id === match.id && candidate._flight === match._flight)) return;
  const cached = {
    ...match,
    _notFound: void 0,
    context: {}
  };
  if (cached._flight) cached._flight[2]++;
  router._cache.set(match.id, cached);
  if (current) releaseFlight(router, current);
}
function getParentSnapshot(match, outcome) {
  if (outcome[0] === ERROR || outcome[0] === NOT_FOUND) return {
    ...match,
    status: outcome[0] === ERROR ? "error" : "notFound",
    error: outcome[1],
    _flight: void 0
  };
  return match;
}
function createLoaderTask(router, lane, index, tasks, semanticParent, options, retainedEnd) {
  const match = lane[1][index];
  const route = getRoute(router, match);
  const preload = !!options[3];
  const plannedCacheMatch = router._cache.get(match.id);
  let configured;
  let reload = false;
  let reloadFailure;
  try {
    if (match.status === "success") {
      configured = route.options.shouldReload;
      if (typeof configured === "function") configured = configured(getLoaderContext(router, lane, match, route, options[0], semanticParent, preload));
      if (options[0].signal.aborted) reloadFailure = CANCELED_OUTCOME;
    }
    if (!reloadFailure) if (match.status !== "success") reload = true;
    else {
      const staleAge = preload || match.preload ? route.options.preloadStaleTime ?? router.options.defaultPreloadStaleTime ?? 3e4 : route.options.staleTime ?? router.options.defaultStaleTime ?? 0;
      reload = !!(match.invalid || configured || configured === void 0 && Date.now() - match.updatedAt >= staleAge && (options[5] || match.cause === "enter" || options[2].some((candidate2) => candidate2.routeId === match.routeId && candidate2.id !== match.id)));
    }
  } catch (cause) {
    match.invalid = true;
    releaseFlight(router, match);
    reloadFailure = normalizeLaneError(router, lane, route, cause, options);
  }
  const routeLoader = route.options.loader;
  const isLoaderFn = typeof routeLoader === "function";
  const loader = isLoaderFn ? routeLoader : routeLoader?.handler;
  const preloadable = !preload || route.options.preload !== false;
  let donor = preloadable && routeLoader && !router._tx?.[6] ? router._flights?.get(match.id) : void 0;
  if (donor === match._flight || reloadFailure) donor = void 0;
  else if (donor && !reload && !preload && configured === void 0) reload = true;
  else if (!reload) donor = void 0;
  const background = !!(routeLoader && reload && match.status === "success" && !preload && !options[4] && ((isLoaderFn ? void 0 : routeLoader.staleReloadMode) ?? router.options.defaultStaleReloadMode) !== "blocking");
  const loaded = reload && preloadable;
  const blocking = loaded && !background && (match.status !== "success" || !!routeLoader);
  const onReady = index >= retainedEnd ? options[7] : void 0;
  const onLazyReady = route.lazyFn && route._lazy !== true ? onReady : void 0;
  if (loaded && !routeLoader) {
    match.invalid = false;
    match.updatedAt = Date.now();
  }
  if (donor) donor[2]++;
  if (blocking) {
    const acceptedFlight = match._flight;
    match._flight = donor;
    releaseOwnedFlight(router, match, acceptedFlight)?.abort();
    if (index >= retainedEnd) match.status = "pending";
    onReady?.();
  }
  if (!loaded) match.isFetching = false;
  const outcome = (reloadFailure ? Promise.resolve(reloadFailure) : !blocking ? Promise.resolve([SUCCESS, match.loaderData]) : loadResource(router, lane, match, route, loader, semanticParent, options)).then((result) => {
    if (blocking) {
      settleInto(match, result, preload);
      if (result[0] === SUCCESS) {
        if (routeLoader && !options[0].signal.aborted) cacheLoaderMatch(router, match, plannedCacheMatch);
        if (index >= retainedEnd) match.status = "pending";
      }
    }
    return result;
  });
  const chunkFailure = waitFor(Promise.resolve().then(() => loadRouteChunk(route, void 0, onLazyReady)), options[0].signal).then(() => void 0, (cause) => lane[1].some((candidate2, candidateIndex) => candidateIndex <= index && (candidate2.status === "error" || candidate2.status === "notFound" || candidate2._notFound)) ? void 0 : [index, normalizeLaneError(router, lane, route, cause, options)]).then((failure) => outcome.then((result) => {
    if (blocking && !failure && result[0] === SUCCESS && match.status === "pending" && !options[0].signal.aborted) {
      match.status = "success";
      onReady?.();
    }
    return failure;
  }));
  tasks.push([
    index,
    outcome,
    chunkFailure
  ]);
  if (!background) return outcome.then((result) => getParentSnapshot(match, result));
  const candidate = {
    ...match,
    status: "pending",
    preload: false,
    _flight: donor
  };
  match.invalid = false;
  match.isFetching = "loader";
  const backgroundOutcome = loadResource(router, lane, candidate, route, loader, semanticParent, options).then((result) => {
    match.isFetching = false;
    settleInto(candidate, result, false);
    return result;
  });
  (lane[2] ??= []).push([
    index,
    backgroundOutcome,
    chunkFailure,
    candidate
  ]);
  return backgroundOutcome.then((result) => getParentSnapshot(candidate, result));
}
async function getNotFoundBoundary(router, matches, indexed, signal, fallback = 0) {
  const cause = indexed?.[1][1];
  let index = cause?.routeId ? matches.findIndex((match) => match.routeId === cause.routeId) : indexed?.[0] ?? matches.length - 1;
  if (index < 0) index = 0;
  for (let i = index; i >= 0; i--) {
    const route = getRoute(router, matches[i]);
    try {
      const loading = loadRouteChunk(route, false);
      if (loading) await waitFor(loading, signal);
    } catch (cause2) {
      if (cause2 === signal && signal.aborted) throw cause2;
    }
    if (route.options.notFoundComponent) return i;
  }
  return cause?.routeId ? index : fallback;
}
function discardBackground(router, lane) {
  if (lane[2]) {
    transferMatchResources(router, lane[2].map((task) => task[3]));
    lane[2] = void 0;
  }
}
async function settleTasks(tasks, serialFailure, redirectTasks, gate) {
  let loaderFailure;
  try {
    await Promise.all(tasks.map((task) => task[1].then(async (outcome) => {
      const taskIndex = task[0];
      if (gate && taskIndex >= await gate) return;
      if (outcome[0] >= REDIRECTED) throw [taskIndex, outcome];
      if (!loaderFailure && outcome[0] !== SUCCESS) {
        loaderFailure = [taskIndex, outcome];
        await Promise.all((redirectTasks ?? []).map((nextTask) => {
          if (nextTask[0] <= taskIndex) return;
          return nextTask[1].then((nextOutcome) => {
            if (nextOutcome[0] === REDIRECTED) throw [nextTask[0], nextOutcome];
          });
        }));
      }
    })));
  } catch (cause) {
    return cause;
  }
  return serialFailure ?? loaderFailure;
}
function materializeRedirect(router, lane, route, outcome, options, failed) {
  while (outcome[0] === REDIRECTED) {
    const redirect2 = outcome[1];
    const redirectOptions = redirect2.options;
    if (redirectOptions.reloadDocument ? options[3] : options[1] >= 20) return outcome;
    try {
      if (redirectOptions.href && redirectOptions.reloadDocument) {
        router.resolveRedirect(redirect2);
        return outcome;
      }
      return [
        REDIRECTED,
        redirect2,
        router.buildLocation({
          ...redirectOptions,
          _fromLocation: lane[0],
          _includeValidateSearch: true
        })
      ];
    } catch (cause) {
      outcome = failed ? [ERROR, cause] : normalizeError(route, cause);
      failed = true;
    }
  }
  return outcome;
}
async function reduceLane(router, lane, tasks, controller, settlement, onReady) {
  const matches = lane[1];
  let failure = await settlement;
  let redirectLimitExceeded = false;
  const plannedBoundary = matches.findIndex((match) => match._notFound);
  const boundaryOf = (found) => found[1][0] === NOT_FOUND ? getNotFoundBoundary(router, matches, found, controller.signal) : found[0];
  let readinessEnd = plannedBoundary < 0 ? matches.length : plannedBoundary;
  if ((failure?.[1][0] ?? 0) >= REDIRECTED) readinessEnd = 0;
  else if (failure) {
    readinessEnd = failure[2] ??= await boundaryOf(failure);
    for (const task of tasks) {
      if (task[0] >= readinessEnd) break;
      const outcome = await task[1];
      if (outcome[0] !== SUCCESS && outcome[0] < REDIRECTED && !("loaderData" in matches[task[0]])) {
        failure = [task[0], outcome];
        readinessEnd = failure[2] = await boundaryOf(failure);
        break;
      }
    }
  }
  for (const task of tasks) {
    if (task[0] >= readinessEnd) break;
    const chunkFailure = await task[2];
    if (!chunkFailure) continue;
    failure = chunkFailure;
    break;
  }
  if ((failure?.[1][0] ?? 0) >= REDIRECTED) {
    const outcome = failure[1];
    if (outcome[0] !== REDIRECTED || outcome[1].options.reloadDocument || outcome[2]) {
      discardBackground(router, lane);
      return outcome;
    }
    redirectLimitExceeded = true;
    failure = [0, [ERROR, new Error("Too many redirects")]];
  }
  const boundary = failure ? failure[2] ?? await boundaryOf(failure) : plannedBoundary;
  if (boundary >= 0) {
    const outcome = failure?.[1];
    const kind = outcome?.[0];
    const match = matches[boundary];
    const cause = outcome?.[1];
    const install = () => {
      if (outcome) {
        match._notFound = void 0;
        if (kind === ERROR) match.status = "error";
        else {
          cause.routeId = match.routeId;
          if (match.routeId === router.routeTree.id) {
            match.status = "success";
            match._notFound = true;
          } else match.status = "notFound";
        }
        match.error = cause;
        match.isFetching = false;
      }
    };
    install();
    if (!outcome) onReady?.();
    const route = getRoute(router, match);
    try {
      await waitFor(outcome ? Promise.resolve().then(() => loadRouteChunk(route, kind === ERROR ? "errorComponent" : "notFoundComponent")) : Promise.all([loadRouteChunk(route), loadRouteChunk(route, "notFoundComponent")]), controller.signal);
    } catch (cause2) {
      if (cause2 === controller.signal && controller.signal.aborted) {
        discardBackground(router, lane);
        return CANCELED_OUTCOME;
      }
    }
    if (!outcome) match.status = "success";
    else if (redirectLimitExceeded) {
      controller.abort();
      await Promise.all([
        ...tasks.map((task) => task[1]),
        ...tasks.map((task) => task[2]),
        ...(lane[2] ?? []).map((task) => task[1])
      ]);
      discardBackground(router, lane);
      transferMatchResources(router, matches);
      install();
    }
  }
  return lane;
}
async function projectLane(router, lane, signal, start = 0, end = lane[1].length) {
  const matches = lane[1];
  for (let index = start; index < end; index++) {
    const match = matches[index];
    const routeOptions = getRoute(router, match).options;
    if (routeOptions.head || routeOptions.scripts) try {
      const context = {
        ssr: router.options.ssr,
        matches,
        match,
        params: match.params,
        loaderData: match.loaderData
      };
      const [head, scripts] = await waitFor(Promise.all([routeOptions.head?.(context), routeOptions.scripts?.(context)]), signal);
      match.meta = head?.meta;
      match.links = head?.links;
      match.headScripts = head?.scripts;
      match.styles = head?.styles;
      match.scripts = scripts;
    } catch (cause) {
      if (cause === signal && signal.aborted) break;
      console.error(cause);
    }
    if (match.status !== "success" || match._notFound) break;
  }
  return lane;
}
async function executeClientLane(router, location, matches, options) {
  const matched = [location, matches];
  const signal = options[0].signal;
  let reduced;
  try {
    const presented = router.stores.matches.get();
    let plannedBoundary = matches.findIndex((match) => match._notFound);
    if (router.options.notFoundMode !== "root" && plannedBoundary >= 0) {
      const boundary = await getNotFoundBoundary(router, matches, void 0, signal, plannedBoundary);
      matches[plannedBoundary]._notFound = void 0;
      matches[boundary]._notFound = true;
      plannedBoundary = boundary;
    }
    let end = plannedBoundary < 0 ? matches.length : plannedBoundary + 1;
    let retainedEnd = 0;
    while (retainedEnd < end && retainedEnd !== plannedBoundary) {
      const match = matches[retainedEnd];
      const committed = options[2][retainedEnd];
      const visible = presented[retainedEnd];
      if (committed?.id !== match.id || committed.status !== "success" || committed._notFound || match.preload || visible?.id !== match.id || visible.status !== "success" || visible._notFound) break;
      retainedEnd++;
    }
    const tasks = [];
    const start = options[6] ?? 0;
    let semanticParent = start ? Promise.resolve(matches[start - 1]) : void 0;
    const planSuccessfulLane = () => {
      for (let index = start; index < end; index++) {
        if (signal.aborted) break;
        semanticParent = createLoaderTask(router, matched, index, tasks, semanticParent, options, retainedEnd);
      }
    };
    const failure = await contextualize(router, matched, options, end, planSuccessfulLane, retainedEnd);
    if (failure) {
      options[4] = true;
      end = failure[0];
      if (failure[1][0] === NOT_FOUND) {
        const boundary = await getNotFoundBoundary(router, matches, failure, signal);
        failure[2] = boundary;
        end = Math.min(end, boundary + 1);
      } else if (failure[1][0] >= REDIRECTED) end = 0;
      planSuccessfulLane();
    }
    if (!signal.aborted && !options[3]) {
      const abort = [];
      for (const [id, flight] of router._flights ?? []) if (!flight[2]) {
        router._flights.delete(id);
        abort.push(flight[1]);
      }
      for (const controller of abort) controller.abort();
    }
    const reduction = reduceLane(router, matched, tasks, options[0], settleTasks(tasks, failure, matched[2]), options[7]);
    if (matched[2]?.length) matched[3] = settleTasks(matched[2], void 0, void 0, reduction.then((foreground) => isControl(foreground) ? 0 : _getRenderedMatches(matches).length, () => 0));
    reduced = await reduction;
  } catch (cause) {
    discardBackground(router, matched);
    if (cause === signal && signal.aborted) return CANCELED_OUTCOME;
    throw cause;
  }
  if (isControl(reduced)) return reduced;
  return projectLane(router, reduced, signal, options[6] === matches.length ? options[6] : 0);
}
function offerPending(router, tx) {
  if (router._tx !== tx) return;
  const matches = tx[3];
  const presented = router.stores.matches.get();
  let session = router._pending;
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const success = match.status === "success" && !match._notFound;
    const presentedPending = presented[index]?.id === match.id && presented[index]?.status === "pending";
    if (success && !presentedPending) continue;
    const route = getRoute(router, match);
    const delay = success || match.invalid ? 0 : route.options.pendingMs ?? router.options.defaultPendingMs;
    const component = route.options.pendingComponent ?? router.options.defaultPendingComponent;
    if (!component || typeof delay !== "number" || delay === Infinity) {
      if (session) {
        session[0] = tx;
        session[2] = 0;
        session[4] = true;
      }
      return;
    }
    const min = route.options.pendingMinMs ?? router.options.defaultPendingMinMs ?? 0;
    let tookOver = false;
    if (session?.[1] === match.id) {
      tookOver = session[0] !== tx;
      session[0] = tx;
    } else {
      clearTimeout(session?.[3]);
      router._pending = session = void 0;
    }
    if (!session) router._pending = session = [
      tx,
      match.id,
      presentedPending ? Date.now() + min : tx[4] + delay,
      void 0,
      presentedPending || void 0,
      component
    ];
    if (session[4] && !tookOver && session[5] === component) return;
    session[5] = component;
    if (!session[4]) {
      clearTimeout(session[3]);
      const remaining = session[2] - Date.now();
      if (remaining > 0) {
        session[3] = setTimeout(() => offerPending(router, tx), remaining);
        return;
      }
      session[2] = 0;
    }
    const offered = matches.map((match2) => ({
      ...match2,
      _flight: void 0
    }));
    offered[index].status = "pending";
    const ack = session[4] = router.startTransition(() => router.stores.setMatches(offered), offered).then((rendered) => {
      if (rendered && router._pending === session && session[4] === ack && !session[2]) session[2] = Date.now() + min;
      return rendered;
    });
    return;
  }
}
function finishPending(router, tx) {
  const session = router._pending;
  if (router._tx === tx || !router._tx?.[3].some((match) => match.id === session?.[1])) {
    clearTimeout(session?.[3]);
    router._pending = void 0;
  }
}
async function awaitPendingMinimum(router, tx) {
  const session = router._pending;
  if (!session) return;
  clearTimeout(session[3]);
  const remaining = session[2] - Date.now();
  if (!session[4] || remaining <= 0 || !_getRenderedMatches(tx[3]).some((match) => match.id === session[1])) return;
  let timer;
  try {
    await waitFor(new Promise((resolve) => {
      timer = setTimeout(resolve, remaining);
    }), tx[0].signal);
  } catch {
  }
  clearTimeout(timer);
}
function publishMatches(router, matches) {
  router._committed = matches;
  router.stores.setMatches(matches);
}
function commitMatches(router, tx, matches, resolvedPrefix) {
  const previous = router._committed;
  const previousCached = router._cache;
  for (const match of matches) {
    match.preload = false;
    if (resolvedPrefix) match._assetEnd = void 0;
  }
  const cut = _getRenderedMatches(matches).length;
  const cached = /* @__PURE__ */ new Map();
  if (!tx[6]) {
    const now = Date.now();
    for (const match of [...previous, ...previousCached.values()]) {
      if (match.status !== "success" || matches.some((candidate, index) => candidate.id === match.id && (index < cut || candidate.status === "success"))) continue;
      const route = getRoute(router, match);
      if (!route.options.loader || now - match.updatedAt >= (match.preload ? route.options.preloadGcTime ?? router.options.defaultPreloadGcTime ?? 3e5 : route.options.gcTime ?? router.options.defaultGcTime ?? 3e5)) continue;
      cached.set(match.id, previousCached.get(match.id) === match ? match : {
        ...match,
        _flight: void 0,
        isFetching: false,
        context: {}
      });
    }
  }
  tx[3] = [];
  router._cache = cached;
  publishMatches(router, matches);
  transferMatchResources(router, [...previousCached.values(), ...previous], [...matches, ...cached.values()]);
  if (true) {
    const handoff = tx[6]?.[0];
    if (handoff && router._handoff === handoff) handoff[1]();
  }
  runRouteLifecycle(router, previous, matches, tx);
}
async function awaitCurrent(router, owner) {
  let current = router._tx;
  while (current && current !== owner) {
    await current[5];
    if (router._tx === current) return;
    current = router._tx;
  }
}
function followRedirect(router, tx, outcome) {
  const options = outcome[1].options;
  const location = outcome[2];
  if (!location) return router.navigate({
    ...options,
    replace: true,
    ignoreBlocker: true
  });
  if (options.reloadDocument) return router.navigate({
    href: location.publicHref,
    reloadDocument: true,
    replace: true,
    ignoreBlocker: true
  });
  location._redirects = tx[1] + 1;
  router._pendingLocation = location;
  const committed = router.commitLocation({
    ...location,
    viewTransition: options.viewTransition,
    replace: true,
    resetScroll: options.resetScroll,
    hashScrollIntoView: options.hashScrollIntoView,
    ignoreBlocker: true
  });
  queueMicrotask(() => {
    if (router._pendingLocation === location) router._pendingLocation = void 0;
  });
  return committed;
}
async function runBackground(router, tx, base, tasks, settlement) {
  const next = base.map((match) => ({ ...match }));
  acquireMatchResources(next);
  for (const task of tasks) {
    releaseFlight(router, next[task[0]]);
    next[task[0]] = task[3];
  }
  const lane = [tx[2], next];
  let reduced;
  try {
    reduced = await reduceLane(router, lane, tasks, tx[0], settlement);
  } catch (cause) {
    transferMatchResources(router, next);
    throw cause;
  }
  if (isControl(reduced)) {
    transferMatchResources(router, next);
    if (reduced[0] === REDIRECTED && router._tx === tx && router._committed === base) await followRedirect(router, tx, reduced);
    return;
  }
  await projectLane(router, reduced, tx[0].signal);
  if (router._tx !== tx || router._committed !== base) {
    transferMatchResources(router, next);
    return;
  }
  for (const match of next) {
    const cached = router._cache.get(match.id);
    if (cached?._flight && cached._flight === match._flight) {
      router._cache.delete(match.id);
      releaseFlight(router, cached);
    }
  }
  publishMatches(router, next);
  transferMatchResources(router, base, next);
}
async function runClientTransaction(router, tx, forceStaleReload, onReady, sync, resolvedPrefix) {
  const result = await executeClientLane(router, tx[2], tx[3], [
    tx[0],
    tx[1],
    router._committed,
    void 0,
    sync,
    forceStaleReload,
    resolvedPrefix,
    onReady
  ]);
  if (isControl(result)) {
    const follow = result[0] === REDIRECTED && router._tx === tx;
    if (!follow || result[1].options.reloadDocument) finishPending(router, tx);
    transferMatchResources(router, tx[3]);
    tx[3] = [];
    if (!follow) return;
    if (router._tx !== tx) {
      finishPending(router, tx);
      return;
    }
    if (tx[6]) router._refreshNextLoad = true;
    await followRedirect(router, tx, result);
    return;
  }
  const matches = result[1];
  if (router._tx === tx) await awaitPendingMinimum(router, tx);
  if (router._tx !== tx) {
    finishPending(router, tx);
    transferMatchResources(router, matches);
    discardBackground(router, result);
    return;
  }
  const toLocation = tx[2];
  const changeInfo = getLocationChangeInfo(toLocation, router.stores.resolvedLocation.get());
  const background = result[2];
  await router.startViewTransition(async () => {
    if (router._tx === tx) await awaitPendingMinimum(router, tx);
    if (router._tx !== tx) {
      finishPending(router, tx);
      transferMatchResources(router, matches);
      discardBackground(router, result);
      return;
    }
    const commit = () => {
      finishPending(router, tx);
      commitMatches(router, tx, matches, resolvedPrefix);
      if (router._tx !== tx) return;
      router.emit({
        type: "onLoad",
        ...changeInfo
      });
      if (router._tx === tx) router.emit({
        type: "onBeforeRouteMount",
        ...changeInfo
      });
    };
    const rendered = await router.startTransition(commit, matches);
    if (tx[6]) tx[6] = void 0;
    if (router._tx !== tx) {
      discardBackground(router, result);
      return;
    }
    if (background?.length) runBackground(router, tx, matches, background, result[3]).catch(console.error);
    router.batch(() => {
      router.stores.resolvedLocation.set(toLocation);
      router.stores.status.set("idle");
      if (router._tx === tx) router.emit({
        type: "onResolved",
        ...changeInfo
      });
      if (rendered && router._tx === tx) router.emit({
        type: "onRendered",
        ...changeInfo
      });
    });
    if (router._tx !== tx) return;
    router._commitPromise?.resolve();
    router._commitPromise = void 0;
  });
}
async function loadClientRoute(router, opts) {
  let rematerialize = false;
  if (true) rematerialize = !!router._refreshNextLoad || !!router._tx?.[6];
  const previousOwner = router._tx;
  const resolvedLocation = router.stores.resolvedLocation.get();
  const previousLocation = resolvedLocation ?? router.stores.location.get();
  const location = router.latestLocation;
  const pendingLocation = router._pendingLocation;
  const redirects = pendingLocation?.href === location.href ? pendingLocation._redirects ?? 0 : 0;
  const handoff = router._handoff;
  const hydrationController = rematerialize ? void 0 : handoff?.[0]();
  const preflight = new AbortController();
  const previousPreflight = router._preflight;
  router._preflight = preflight;
  if (!rematerialize && !hydrationController) handoff?.[1]();
  previousPreflight?.abort();
  if (!preflight.signal.aborted) {
    const changeInfo = getLocationChangeInfo(location, resolvedLocation);
    router.emit({
      type: "onBeforeNavigate",
      ...changeInfo
    });
    if (!preflight.signal.aborted) router.emit({
      type: "onBeforeLoad",
      ...changeInfo
    });
  }
  if (preflight.signal.aborted) {
    await awaitCurrent(router, previousOwner);
    return;
  }
  const sameHref = previousLocation.href === location.href;
  let controller = preflight;
  const matches = rematerialize ? router.matchRoutes(location, {
    _controller: preflight,
    _rematerialize: true
  }) : router.matchRoutes(location, { _controller: preflight });
  acquireMatchResources(matches);
  const resolvedPrefix = hydrationController ? handoff[1](matches) : void 0;
  if (resolvedPrefix) controller = hydrationController;
  else hydrationController?.abort();
  if (preflight.signal.aborted) {
    transferMatchResources(router, matches);
    await awaitCurrent(router, previousOwner);
    return;
  }
  router._preflight = void 0;
  let settle;
  const run = () => runClientTransaction(router, tx, sameHref, () => offerPending(router, tx), opts?.sync, resolvedPrefix);
  const done = opts?.sync ? new Promise((resolve) => settle = resolve) : Promise.resolve().then(run).then();
  const tx = [
    controller,
    redirects,
    location,
    matches,
    Date.now(),
    done
  ];
  if (rematerialize) {
    tx[6] = [handoff];
    router._refreshNextLoad = void 0;
  }
  router._tx = tx;
  if (previousOwner) {
    for (const match of router.stores.matches.get()) {
      if (router._tx !== tx) break;
      if (match.isFetching) setFetching(router, match, false);
    }
    previousOwner[0].abort();
    transferMatchResources(router, previousOwner[3], tx[3], true);
  }
  if (router._tx !== tx) {
    transferMatchResources(router, tx[3]);
    tx[3] = [];
    settle?.();
    await awaitCurrent(router, tx);
    return;
  }
  router.batch(() => {
    router.stores.status.set("pending");
    router.stores.location.set(location);
  });
  if (resolvedPrefix || !router._committed.length && matches[0]?.status !== "success" && !matches.some((match) => match._notFound)) offerPending(router, tx);
  settle?.(run());
  await done;
  await awaitCurrent(router, tx);
}
async function refreshClientRoute(router) {
  const pending = router._tx;
  if (pending && !pending[6] && router.stores.status.get() === "pending") {
    await pending[5];
    if (router._tx !== pending) await awaitCurrent(router, pending);
  }
  router._flights?.clear();
  router.clearCache();
  router._refreshNextLoad = true;
  await loadClientRoute(router, { sync: true });
}
async function preloadClientRoute(router, opts) {
  if (router._refreshNextLoad || router._tx?.[6]) return;
  let location = router.buildLocation(opts);
  for (let redirects = 0; ; redirects++) {
    const base = router._committed;
    const controller = new AbortController();
    let matches;
    let active;
    let result;
    try {
      try {
        matches = router.matchRoutes(location, { _controller: controller });
        acquireMatchResources(matches);
        active = (router._preloads ??= /* @__PURE__ */ new Map()).set(controller, matches);
        result = await executeClientLane(router, location, matches, [
          controller,
          redirects,
          base,
          true
        ]);
      } finally {
        if (active) {
          active = active.delete(controller);
          transferMatchResources(router, matches);
        }
        controller.abort();
      }
      if (!isControl(result)) return result[1];
      if (!active || result.length < 3 || (router._refreshNextLoad || router._tx?.[6])) return;
      location = result[2];
    } catch (cause) {
      if (!isNotFound(cause)) console.error(cause);
      return;
    }
  }
}

// ../../node_modules/@tanstack/router-core/dist/esm/await-signal.js
function waitForReason(value, signal, onLate) {
  const promise = Promise.resolve(value);
  if (signal.aborted) {
    if (!onLate) return Promise.race([Promise.reject(signal.reason), promise]);
    promise.then(onLate, () => {
    });
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then((result) => {
      if (signal.aborted) onLate?.(result);
      else resolve(result);
    }, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// ../../node_modules/@tanstack/router-core/dist/esm/load-server.js
var SUCCESS2 = 0;
var ERROR2 = 1;
var NOT_FOUND2 = 2;
var REDIRECTED2 = 3;
var SKIPPED = 4;
function getRoute2(router, match) {
  return router.routesById[match.routeId];
}
function normalize3(value, rejected) {
  if (isRedirect(value)) return [REDIRECTED2, value];
  if (isNotFound(value)) return [NOT_FOUND2, value];
  if (rejected && typeof value?.then === "function") value = new Error("A Promise was thrown", { cause: value });
  return rejected ? [ERROR2, value] : [SUCCESS2, value];
}
function normalizeError2(router, lane, route, cause, signal, notify = true) {
  signal?.throwIfAborted();
  let outcome = normalize3(cause, true);
  if (outcome[0] !== ERROR2) return materializeRedirect2(router, lane, route, outcome, signal, notify);
  try {
    route.options.onError?.(outcome[1]);
  } catch (onErrorCause) {
    outcome = normalize3(onErrorCause, true);
  }
  signal?.throwIfAborted();
  return materializeRedirect2(router, lane, route, outcome, signal, notify);
}
function materializeRedirect2(router, lane, route, outcome, signal, notify = true) {
  if (outcome[0] !== REDIRECTED2) return outcome;
  signal?.throwIfAborted();
  try {
    outcome[1].options._fromLocation = lane.location;
    router.resolveRedirect(outcome[1]);
    signal?.throwIfAborted();
    return outcome;
  } catch (cause) {
    signal?.throwIfAborted();
    return notify ? normalizeError2(router, lane, route, cause, signal, false) : [ERROR2, cause];
  }
}
function maybe(value, cause) {
  if (cause !== void 0) return {
    status: "error",
    error: cause
  };
  return {
    status: "success",
    value
  };
}
function navigateFrom(router, location) {
  return (options) => router.navigate({
    ...options,
    _fromLocation: location
  });
}
function waitFor2(value, signal) {
  return signal ? waitForReason(value, signal) : value;
}
async function resolveSsr(router, lane, index) {
  const match = lane.matches[index];
  const route = getRoute2(router, match);
  const parentSsr = lane.matches[index - 1]?.ssr;
  if (router.isShell()) return route.id === rootRouteId;
  if (parentSsr === false) return false;
  const inherit = (value) => {
    return value === true && parentSsr === "data-only" ? "data-only" : value;
  };
  const defaultSsr = router.options.defaultSsr ?? true;
  const inheritedDefault = inherit(defaultSsr);
  match.ssr = inheritedDefault;
  const option = route.options.ssr;
  if (option === void 0) return inheritedDefault;
  if (typeof option !== "function") return inherit(option);
  return inherit(await option({
    search: maybe(match.search, match.searchError),
    params: maybe(match.params, match.paramsError),
    location: lane.location,
    matches: lane.matches.map((candidate) => ({
      index: candidate.index,
      pathname: candidate.pathname,
      fullPath: candidate.fullPath,
      staticData: candidate.staticData,
      id: candidate.id,
      routeId: candidate.routeId,
      search: maybe(candidate.search, candidate.searchError),
      params: maybe(candidate.params, candidate.paramsError),
      ssr: candidate.ssr
    }))
  }) ?? defaultSsr);
}
function stampNotFound(match, outcome) {
  if (outcome[0] === NOT_FOUND2 && !outcome[1].routeId) outcome[1].routeId = match.routeId;
  return outcome;
}
async function contextualize2(router, lane, signal) {
  const globalBoundary = lane.matches.findIndex((match) => match._notFound);
  let end = globalBoundary < 0 ? lane.matches.length : globalBoundary + 1;
  let failure;
  let parentContext = { ...router.options.context ?? {} };
  for (let index = 0; index < end; index++) {
    const match = lane.matches[index];
    const route = getRoute2(router, match);
    try {
      match.ssr = await resolveSsr(router, lane, index);
    } catch (cause) {
      signal?.throwIfAborted();
      failure = [index, stampNotFound(match, normalizeError2(router, lane, route, cause, signal))];
      end = index;
    }
    signal?.throwIfAborted();
    if (failure?.[1][0] === REDIRECTED2) break;
    match.__beforeLoadContext = void 0;
    let context = parentContext;
    try {
      let routeContext;
      if (route.options.context) {
        const routeContextOptions = {
          deps: match.loaderDeps,
          params: match.params,
          context: parentContext,
          location: lane.location,
          navigate: navigateFrom(router, lane.location),
          buildLocation: router.buildLocation,
          cause: match.cause,
          abortController: match.abortController,
          preload: false,
          matches: lane.matches,
          routeId: route.id
        };
        routeContext = route.options.context(routeContextOptions) ?? void 0;
      }
      context = {
        ...parentContext,
        ...routeContext
      };
      match.context = context;
    } catch (cause) {
      signal?.throwIfAborted();
      if (!failure) failure = [index, stampNotFound(match, normalizeError2(router, lane, route, cause, signal))];
      end = index;
      break;
    }
    signal?.throwIfAborted();
    if (failure) break;
    const validationError = match.paramsError ?? match.searchError;
    if (validationError !== void 0) {
      failure = [index, stampNotFound(match, normalizeError2(router, lane, route, validationError, signal))];
      end = index;
      break;
    }
    signal?.throwIfAborted();
    if (match.ssr === false || !route.options.beforeLoad) {
      parentContext = context;
      continue;
    }
    const abortController = match.abortController;
    const options = {
      search: match.search,
      abortController,
      params: match.params,
      preload: false,
      context,
      location: lane.location,
      navigate: navigateFrom(router, lane.location),
      buildLocation: router.buildLocation,
      cause: match.cause,
      matches: lane.matches,
      routeId: route.id,
      ...router.options.additionalContext
    };
    try {
      const beforeLoadContext = await route.options.beforeLoad(options);
      signal?.throwIfAborted();
      const outcome = stampNotFound(match, materializeRedirect2(router, lane, route, normalize3(beforeLoadContext, false), signal));
      if (outcome[0] !== SUCCESS2) {
        failure = [index, outcome];
        end = index;
        break;
      }
      match.__beforeLoadContext = beforeLoadContext;
      match.context = {
        ...context,
        ...beforeLoadContext
      };
      parentContext = match.context;
    } catch (cause) {
      signal?.throwIfAborted();
      failure = [index, stampNotFound(match, normalizeError2(router, lane, route, cause, signal))];
      end = index;
      break;
    }
  }
  return {
    location: lane.location,
    matches: lane.matches,
    end,
    failure
  };
}
function getLoaderContext2(router, lane, match, route, index, tasks) {
  return {
    params: match.params,
    deps: match.loaderDeps,
    preload: false,
    parentMatchPromise: tasks[index - 1]?.match,
    abortController: match.abortController,
    context: match.context,
    location: lane.location,
    navigate: navigateFrom(router, lane.location),
    cause: match.cause,
    route,
    ...router.options.additionalContext
  };
}
function createLoaderTask2(router, lane, index, tasks, signal) {
  const match = lane.matches[index];
  const route = getRoute2(router, match);
  let outcome;
  if (match.ssr === false) outcome = Promise.resolve([SKIPPED]);
  else {
    const routeLoader = route.options.loader;
    const loader = typeof routeLoader === "function" ? routeLoader : routeLoader?.handler;
    if (!loader) outcome = Promise.resolve([SUCCESS2, void 0]);
    else outcome = Promise.resolve().then(() => loader(getLoaderContext2(router, lane, match, route, index, tasks))).then((result) => normalize3(result, false), (cause) => normalize3(cause, true)).then((result) => {
      if (signal?.aborted || match.abortController.signal.reason === lane) return [SKIPPED];
      if (result[0] === ERROR2) result = normalizeError2(router, lane, route, result[1], signal);
      else result = materializeRedirect2(router, lane, route, result, signal);
      return stampNotFound(match, result);
    });
  }
  const parentMatch = outcome.then((result) => {
    const snapshot = { ...match };
    if (result[0] === SUCCESS2) {
      snapshot.loaderData = result[1];
      snapshot.status = "success";
      snapshot.error = void 0;
      snapshot.invalid = false;
      snapshot.isFetching = false;
    } else if (result[0] === ERROR2) {
      snapshot.status = "error";
      snapshot.error = result[1];
    } else if (result[0] === NOT_FOUND2) {
      snapshot.status = "notFound";
      snapshot.error = result[1];
    }
    return snapshot;
  });
  return {
    index,
    outcome,
    match: parentMatch
  };
}
async function getNotFoundBoundary2(router, matches, indexed, signal, fallback = 0) {
  const cause = indexed?.[1][1];
  let index = cause?.routeId ? matches.findIndex((match) => match.routeId === cause.routeId) : indexed?.[0] ?? matches.length - 1;
  if (index < 0) index = 0;
  for (let candidate = index; candidate >= 0; candidate--) {
    const route = getRoute2(router, matches[candidate]);
    try {
      const loading = loadRouteChunk(route, false);
      if (loading) await loading;
    } catch {
      signal?.throwIfAborted();
    }
    signal?.throwIfAborted();
    if (route.options.notFoundComponent) return candidate;
  }
  return cause?.routeId ? index : fallback;
}
function abortMatches(matches, start = 0, reason) {
  for (let index = start; index < matches.length; index++) matches[index].abortController.abort(reason);
}
async function applyFailure(router, lane, indexed, signal) {
  if (!indexed) {
    const boundary2 = lane.matches.findIndex((match2) => match2._notFound);
    if (boundary2 >= 0) {
      abortMatches(lane.matches, boundary2 + 1);
      return {
        status: 404,
        boundary: boundary2,
        kind: NOT_FOUND2
      };
    }
    return { status: 200 };
  }
  const [index, outcome] = indexed;
  if (outcome[0] === ERROR2) {
    const match2 = lane.matches[index];
    match2._notFound = void 0;
    match2.status = "error";
    match2.error = outcome[1];
    match2.isFetching = false;
    abortMatches(lane.matches, index + 1);
    return {
      status: 500,
      boundary: index,
      kind: ERROR2
    };
  }
  const boundary = indexed[2] ?? await getNotFoundBoundary2(router, lane.matches, indexed, signal);
  const match = lane.matches[boundary];
  const cause = outcome[1];
  cause.routeId = match.routeId;
  match._notFound = void 0;
  if (match.routeId === router.routeTree.id) {
    match.status = "success";
    match._notFound = true;
    match.error = cause;
  } else {
    match.status = "notFound";
    match.error = cause;
  }
  match.isFetching = false;
  abortMatches(lane.matches, boundary + 1);
  return {
    status: 404,
    boundary,
    kind: NOT_FOUND2
  };
}
async function loadNormalChunks(router, lane, end, signal) {
  const chunks = [];
  for (let index = 0; index < lane.matches.length; index++) {
    const match = lane.matches[index];
    if (index >= end || match.ssr !== true || match.status !== "success") continue;
    const route = getRoute2(router, match);
    try {
      const loading = loadRouteChunk(route);
      if (loading) {
        const chunk = loading.then(() => {
          signal?.throwIfAborted();
        }, (cause) => {
          signal?.throwIfAborted();
          return [index, stampNotFound(match, normalizeError2(router, lane, route, cause, signal))];
        });
        chunk.catch(() => {
        });
        chunks.push(chunk);
      }
    } catch (cause) {
      signal?.throwIfAborted();
      chunks.push([index, stampNotFound(match, normalizeError2(router, lane, route, cause, signal))]);
    }
  }
  for (const chunk of chunks) {
    const indexed = Array.isArray(chunk) ? chunk : await chunk;
    if (indexed) return indexed;
  }
}
async function projectLane2(router, lane, signal) {
  for (const match of lane.matches) {
    const routeOptions = getRoute2(router, match).options;
    if (routeOptions.head || routeOptions.scripts || routeOptions.headers) {
      const context = {
        ssr: router.options.ssr,
        matches: lane.matches,
        match,
        params: match.params,
        loaderData: match.loaderData
      };
      try {
        const [head, scripts, headers] = await Promise.all([
          routeOptions.head?.(context),
          routeOptions.scripts?.(context),
          routeOptions.headers?.(context)
        ]);
        signal?.throwIfAborted();
        match.meta = head?.meta;
        match.links = head?.links;
        match.headScripts = head?.scripts;
        match.styles = head?.styles;
        match.scripts = scripts;
        match.headers = headers;
      } catch (cause) {
        signal?.throwIfAborted();
        console.error(cause);
      }
    }
    if (match.ssr === false || match.status !== "success" || match._notFound) break;
  }
}
async function executeServerLane(router, location, matchedMatches, signal) {
  const matched = {
    location,
    matches: matchedMatches.map((match) => ({
      ...match,
      __beforeLoadContext: void 0,
      context: {},
      isFetching: false,
      abortController: new AbortController()
    }))
  };
  const abortLane = () => abortMatches(matched.matches, 0, signal?.reason);
  if (signal?.aborted) {
    abortLane();
    signal.throwIfAborted();
  }
  signal?.addEventListener("abort", abortLane, { once: true });
  try {
    const plannedGlobalBoundary = matched.matches.findIndex((match) => match._notFound);
    if (router.options.notFoundMode !== "root" && plannedGlobalBoundary >= 0) {
      const boundary = await getNotFoundBoundary2(router, matched.matches, void 0, signal, plannedGlobalBoundary);
      if (boundary !== plannedGlobalBoundary) {
        matched.matches[plannedGlobalBoundary]._notFound = void 0;
        matched.matches[boundary]._notFound = true;
      }
    }
    const lane = await contextualize2(router, matched, signal);
    signal?.throwIfAborted();
    let loaderEnd = lane.end;
    if (lane.failure?.[1][0] === REDIRECTED2) loaderEnd = 0;
    else if (lane.failure?.[1][0] === NOT_FOUND2) {
      lane.failure[2] = await getNotFoundBoundary2(router, lane.matches, lane.failure, signal);
      loaderEnd = Math.min(loaderEnd, lane.failure[2] + 1);
    }
    const tasks = [];
    for (let index = 0; index < loaderEnd; index++) {
      const task = createLoaderTask2(router, lane, index, tasks, signal);
      tasks.push(task);
    }
    let loaderFailure;
    let control = lane.failure?.[1][0] === REDIRECTED2 ? lane.failure : void 0;
    try {
      await Promise.all(tasks.map((task) => task.outcome.then((loadedOutcome) => {
        const match = lane.matches[task.index];
        const outcome = loadedOutcome;
        if (outcome[0] === SUCCESS2) {
          match.loaderData = outcome[1];
          match.status = "success";
          match.error = void 0;
          match.invalid = false;
          match.isFetching = false;
          match.updatedAt = Date.now();
        } else if (outcome[0] === REDIRECTED2) {
          control = [task.index, outcome];
          throw control;
        } else {
          if (match.ssr !== false) {
            match.status = "success";
            match.error = void 0;
            match.invalid = true;
            match.isFetching = false;
          }
          if (!loaderFailure && outcome[0] !== SKIPPED) loaderFailure = [task.index, outcome];
        }
      })));
    } catch (cause) {
      if (!Array.isArray(cause)) throw cause;
      control = cause;
    }
    signal?.throwIfAborted();
    if (control?.[1][0] === REDIRECTED2) {
      abortMatches(lane.matches, 0, lane);
      return {
        type: "redirect",
        redirect: control[1][1]
      };
    }
    let failure = lane.failure ?? loaderFailure;
    const plannedBoundary = lane.matches.findIndex((match) => match._notFound);
    let readinessEnd;
    if (failure) {
      const outcomeEnd = failure[2] ??= failure[1][0] === NOT_FOUND2 ? await getNotFoundBoundary2(router, lane.matches, failure, signal) : failure[0];
      for (const task of tasks) {
        if (task.index >= outcomeEnd) break;
        const outcome = await task.outcome;
        if (outcome[0] !== SUCCESS2 && outcome[0] < REDIRECTED2 && !("loaderData" in lane.matches[task.index])) {
          failure = [task.index, outcome];
          failure[2] = outcome[0] === NOT_FOUND2 ? await getNotFoundBoundary2(router, lane.matches, failure, signal) : task.index;
          break;
        }
      }
      readinessEnd = failure[2];
    } else readinessEnd = plannedBoundary < 0 ? lane.matches.length : plannedBoundary;
    const requiredFailure = await loadNormalChunks(router, lane, readinessEnd, signal);
    signal?.throwIfAborted();
    if (requiredFailure) {
      if (requiredFailure[1][0] === REDIRECTED2) {
        abortMatches(lane.matches);
        return {
          type: "redirect",
          redirect: requiredFailure[1][1]
        };
      }
      failure = requiredFailure;
    }
    const terminal = await applyFailure(router, lane, failure, signal);
    if (terminal.boundary !== void 0) {
      const match = lane.matches[terminal.boundary];
      if (match.ssr === true) {
        const route = getRoute2(router, match);
        try {
          if (terminal.kind === ERROR2) await loadRouteChunk(route, "errorComponent");
          else if (match._notFound) await Promise.all([loadRouteChunk(route), loadRouteChunk(route, "notFoundComponent")]);
          else await loadRouteChunk(route, "notFoundComponent");
        } catch {
        }
        signal?.throwIfAborted();
      }
    }
    signal?.throwIfAborted();
    await projectLane2(router, {
      location: lane.location,
      matches: lane.matches
    }, signal);
    signal?.throwIfAborted();
    router.serverSsr?.onCleanup(abortLane);
    return {
      type: "render",
      status: terminal.status,
      matches: lane.matches
    };
  } finally {
    signal?.removeEventListener("abort", abortLane);
  }
}
async function loadServerRoute(router, opts) {
  router.updateLatestLocation();
  const next = router.latestLocation;
  const previous = router._committed;
  let result;
  try {
    const canonical = router.buildLocation({
      to: next.pathname,
      search: true,
      params: true,
      hash: true,
      state: true,
      _includeValidateSearch: true
    });
    if (next.publicHref !== canonical.publicHref) throw redirect({ href: canonical.publicHref || "/" });
    const changeInfo = getLocationChangeInfo(next, router.stores.resolvedLocation.get());
    router.emit({
      type: "onBeforeNavigate",
      ...changeInfo
    });
    router.emit({
      type: "onBeforeLoad",
      ...changeInfo
    });
    opts?._signal?.throwIfAborted();
    result = await waitFor2(executeServerLane(router, next, router.matchRoutes(next), opts?._signal), opts?._signal);
    opts?._signal?.throwIfAborted();
  } catch (cause) {
    opts?._signal?.throwIfAborted();
    if (!isRedirect(cause)) throw cause;
    cause.options._fromLocation = next;
    result = {
      type: "redirect",
      redirect: router.resolveRedirect(cause)
    };
  }
  router._serverResult = result;
  router.batch(() => {
    router.stores.location.set(next);
    router.stores.status.set("idle");
    if (result.type === "render") {
      router.stores.setMatches(result.matches);
      router.stores.resolvedLocation.set(next);
    }
  });
  if (result.type === "render") {
    router._committed = result.matches;
    runRouteLifecycle(router, previous, result.matches);
  }
  router._commitPromise?.resolve();
  router._commitPromise = void 0;
}

// ../../node_modules/@tanstack/router-core/dist/esm/isServer/development.js
var isServer = void 0;

// ../../node_modules/@tanstack/react-router/dist/esm/utils.js
var reactUse = React$1["use"];
var useLayoutEffect2 = isServer ?? typeof window === "undefined" ? React$1.useEffect : React$1.useLayoutEffect;
function useIntersectionObserver(ref, callback, disabled) {
  React$1.useEffect(() => {
    if (!ref.current || disabled || typeof IntersectionObserver !== "function") return () => callback();
    const observer = new IntersectionObserver((entries) => {
      callback(entries.pop());
    }, { rootMargin: "100px" });
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      callback();
    };
  }, [
    callback,
    disabled,
    ref
  ]);
}
function useForwardedRef(ref) {
  const innerRef = React$1.useRef(null);
  React$1.useImperativeHandle(ref, () => innerRef.current, []);
  return innerRef;
}

// ../../node_modules/@tanstack/router-core/dist/esm/defer.js
var TSR_DEFERRED_PROMISE = /* @__PURE__ */ Symbol.for("TSR_DEFERRED_PROMISE");
function defer(_promise, options) {
  const promise = _promise;
  if (promise[TSR_DEFERRED_PROMISE]) return promise;
  promise[TSR_DEFERRED_PROMISE] = { status: "pending" };
  promise.then((data) => {
    promise[TSR_DEFERRED_PROMISE].status = "success";
    promise[TSR_DEFERRED_PROMISE].data = data;
  }).catch((error) => {
    promise[TSR_DEFERRED_PROMISE].status = "error";
    promise[TSR_DEFERRED_PROMISE].error = {
      data: (options?.serializeError ?? defaultSerializeError)(error),
      __isServerError: true
    };
  });
  return promise;
}

// ../../node_modules/@tanstack/router-core/dist/esm/link.js
var preloadWarning = "Error preloading route! ☝️";

// ../../node_modules/@tanstack/router-core/dist/esm/manifest.js
var DEV_STYLES_ATTR = "data-tanstack-router-dev-styles";
function getAssetCrossOrigin(assetCrossOrigin, kind) {
  if (!assetCrossOrigin) return;
  if (typeof assetCrossOrigin === "string") return assetCrossOrigin;
  return assetCrossOrigin[kind];
}
function getManifestScriptFormat(manifest) {
  return manifest?.scriptFormat ?? "module";
}
function getScriptPreloadAttrs(manifest, link2, assetCrossOrigin) {
  const preloadLink = resolveManifestAssetLink(link2);
  const crossOrigin = getAssetCrossOrigin(assetCrossOrigin, "script") ?? preloadLink.crossOrigin;
  return {
    ...getManifestScriptFormat(manifest) === "iife" ? {
      rel: "preload",
      as: "script"
    } : { rel: "modulepreload" },
    href: preloadLink.href,
    ...crossOrigin ? { crossOrigin } : {}
  };
}
function resolveManifestAssetLink(link2) {
  if (typeof link2 === "string") return {
    href: link2,
    crossOrigin: void 0
  };
  return link2;
}
function appendUniqueUserTags(target, tags) {
  if (tags.length === 0) return;
  if (tags.length === 1) {
    target.push(tags[0]);
    return;
  }
  const seen = /* @__PURE__ */ new Set();
  for (const tag of tags) {
    const key = JSON.stringify(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(tag);
  }
}
function resolveManifestCssLink(link2) {
  if (typeof link2 === "string") return {
    href: link2,
    crossOrigin: void 0
  };
  return link2;
}

// ../../node_modules/@tanstack/router-core/dist/esm/Matches.js
var isMatch = (match, path) => {
  const parts = path.split(".");
  let part;
  let i = 0;
  let value = match;
  while ((part = parts[i++]) != null && value != null) value = value[part];
  return value != null;
};

// ../../node_modules/@tanstack/router-core/dist/esm/route.js
var BaseRoute = class {
  get to() {
    return this._to;
  }
  get id() {
    return this._id;
  }
  get path() {
    return this._path;
  }
  get fullPath() {
    return this._fullPath;
  }
  constructor(options) {
    this.init = (opts) => {
      this.originalIndex = opts.originalIndex;
      const options2 = this.options;
      const isRoot = !options2?.path && !options2?.id;
      this.parentRoute = this.options.getParentRoute?.();
      if (isRoot) this._path = rootRouteId;
      else if (!this.parentRoute) {
        if (true) throw new Error(`Invariant failed: Child Route instances must pass a 'getParentRoute: () => ParentRoute' option that returns a Route instance.`);
        invariant();
      }
      let path = isRoot ? rootRouteId : options2?.path;
      if (path && path !== "/") path = trimPathLeft(path);
      const customId = options2?.id || path;
      let id = isRoot ? rootRouteId : joinPaths([this.parentRoute.id === "__root__" ? "" : this.parentRoute.id, customId]);
      if (path === "__root__") path = "/";
      if (id !== "__root__") id = joinPaths(["/", id]);
      const fullPath = id === "__root__" ? "/" : joinPaths([this.parentRoute.fullPath, path]);
      this._path = path;
      this._id = id;
      this._fullPath = fullPath;
      this._to = trimPathRight2(fullPath);
    };
    this.addChildren = (children) => {
      return this._addFileChildren(children);
    };
    this._addFileChildren = (children) => {
      if (Array.isArray(children)) this.children = children;
      if (typeof children === "object" && children !== null) this.children = Object.values(children);
      return this;
    };
    this._addFileTypes = () => {
      return this;
    };
    this.updateLoader = (options2) => {
      Object.assign(this.options, options2);
      return this;
    };
    this.update = (options2) => {
      Object.assign(this.options, options2);
      return this;
    };
    this.lazy = (lazyFn2) => {
      this.lazyFn = lazyFn2;
      return this;
    };
    this.redirect = (opts) => redirect({
      from: this.fullPath,
      ...opts
    });
    this.options = options || {};
    this.isRoot = !options?.getParentRoute;
    if (options?.id && options?.path) throw new Error(`Route cannot have both an 'id' and a 'path' option.`);
  }
};
var BaseRouteApi = class {
  constructor({ id }) {
    this.notFound = (opts) => {
      return notFound({
        routeId: this.id,
        ...opts
      });
    };
    this.redirect = (opts) => redirect({
      from: this.id,
      ...opts
    });
    this.id = id;
  }
};
var BaseRootRoute = class extends BaseRoute {
  constructor(options) {
    super(options);
  }
};

// ../../node_modules/@tanstack/router-core/dist/esm/config.js
var createRouterConfig = (options) => {
  return {
    serializationAdapters: options.serializationAdapters,
    defaultSsr: options.defaultSsr
  };
};

// ../../node_modules/@tanstack/router-core/dist/esm/searchMiddleware.js
function retainSearchParams(keys) {
  return ({ search, next }) => {
    const { search: resultSearch, meta } = next(search, true);
    if (keys === true) {
      const copy2 = {
        ...search,
        ...resultSearch
      };
      const removed = meta.removed;
      const explicit2 = meta.explicit;
      for (const key of removed?.keys() || []) if (explicit2 && hasOwn.call(explicit2, key) || deepEqual(search[key], removed.get(key))) delete copy2[key];
      for (const key of meta.removedAny || []) delete copy2[key];
      for (const key of meta.defaulted?.keys() || []) if (key in search && !meta.removedAny?.has(key) && !(meta.removed?.has(key) && (explicit2 && hasOwn.call(explicit2, key) || deepEqual(search[key], meta.removed.get(key))))) copy2[key] = search[key];
      return copy2;
    }
    const copy = { ...resultSearch };
    const explicit = meta.explicit;
    for (const key of keys) {
      const stringKey = key;
      if (!(meta.removedAny?.has(stringKey) || meta.removed?.has(stringKey) && (explicit && hasOwn.call(explicit, stringKey) || deepEqual(search[key], meta.removed.get(stringKey)))) && (!(key in copy) || key in search && meta.defaulted?.has(stringKey) && deepEqual(copy[key], meta.defaulted.get(stringKey)))) copy[key] = search[key];
    }
    return copy;
  };
}
function stripSearchParams(input) {
  return (({ search, next, meta }) => {
    if (input === true) {
      Object.keys(search).forEach((key) => {
        if (meta) (meta.removedAny ||= /* @__PURE__ */ new Set()).add(key);
      });
      return {};
    }
    const result = { ...next(search) };
    if (Array.isArray(input)) input.forEach((key) => {
      delete result[key];
      if (meta) (meta.removedAny ||= /* @__PURE__ */ new Set()).add(key);
    });
    else Object.entries(input).forEach(([key, value]) => {
      if (deepEqual(result[key], value)) {
        delete result[key];
        if (meta) (meta.removed ||= /* @__PURE__ */ new Map()).set(key, value);
      }
    });
    return result;
  });
}

// ../../node_modules/seroval/dist/dev/index.js
var Feature = (function(Feature2) {
  Feature2[Feature2["AggregateError"] = 1] = "AggregateError";
  Feature2[Feature2["ArrowFunction"] = 2] = "ArrowFunction";
  Feature2[Feature2["ErrorPrototypeStack"] = 4] = "ErrorPrototypeStack";
  Feature2[Feature2["ObjectAssign"] = 8] = "ObjectAssign";
  Feature2[Feature2["BigIntTypedArray"] = 16] = "BigIntTypedArray";
  Feature2[Feature2["RegExp"] = 32] = "RegExp";
  Feature2[Feature2["Temporal"] = 64] = "Temporal";
  return Feature2;
})({});
var SYM_ASYNC_ITERATOR = Symbol.asyncIterator;
var SYM_HAS_INSTANCE = Symbol.hasInstance;
var SYM_IS_CONCAT_SPREADABLE = Symbol.isConcatSpreadable;
var SYM_ITERATOR = Symbol.iterator;
var SYM_MATCH = Symbol.match;
var SYM_MATCH_ALL = Symbol.matchAll;
var SYM_REPLACE = Symbol.replace;
var SYM_SEARCH = Symbol.search;
var SYM_SPECIES = Symbol.species;
var SYM_SPLIT = Symbol.split;
var SYM_TO_PRIMITIVE = Symbol.toPrimitive;
var SYM_TO_STRING_TAG = Symbol.toStringTag;
var SYM_UNSCOPABLES = Symbol.unscopables;
var INV_SYMBOL_REF = {
  [SYM_ASYNC_ITERATOR]: 0,
  [SYM_HAS_INSTANCE]: 1,
  [SYM_IS_CONCAT_SPREADABLE]: 2,
  [SYM_ITERATOR]: 3,
  [SYM_MATCH]: 4,
  [SYM_MATCH_ALL]: 5,
  [SYM_REPLACE]: 6,
  [SYM_SEARCH]: 7,
  [SYM_SPECIES]: 8,
  [SYM_SPLIT]: 9,
  [SYM_TO_PRIMITIVE]: 10,
  [SYM_TO_STRING_TAG]: 11,
  [SYM_UNSCOPABLES]: 12
};
var CONSTANT_VAL = {
  [2]: true,
  [3]: false,
  [1]: void 0,
  [0]: null,
  [4]: -0,
  [5]: Number.POSITIVE_INFINITY,
  [6]: Number.NEGATIVE_INFINITY,
  [7]: NaN
};
function createSerovalNode(t, i, s, c, m, p, e, a, f, b, o, l) {
  return {
    t,
    i,
    s,
    c,
    m,
    p,
    e,
    a,
    f,
    b,
    o,
    l
  };
}
function createConstantNode(value) {
  return createSerovalNode(2, void 0, value, void 0, void 0, void 0, void 0, void 0, void 0, void 0, void 0, void 0);
}
var TRUE_NODE = createConstantNode(2);
var FALSE_NODE = createConstantNode(3);
var UNDEFINED_NODE = createConstantNode(1);
var NULL_NODE = createConstantNode(0);
var NEG_ZERO_NODE = createConstantNode(4);
var INFINITY_NODE = createConstantNode(5);
var NEG_INFINITY_NODE = createConstantNode(6);
var NAN_NODE = createConstantNode(7);
var { toString: objectToString } = Object.prototype;
var REFERENCES_KEY = "__SEROVAL_REFS__";
var INV_REFERENCE = /* @__PURE__ */ new Map();
if (typeof globalThis !== "undefined") Object.defineProperty(globalThis, REFERENCES_KEY, {
  value: INV_REFERENCE,
  configurable: true,
  writable: false,
  enumerable: false
});
else if (typeof window !== "undefined") Object.defineProperty(window, REFERENCES_KEY, {
  value: INV_REFERENCE,
  configurable: true,
  writable: false,
  enumerable: false
});
else if (typeof self !== "undefined") Object.defineProperty(self, REFERENCES_KEY, {
  value: INV_REFERENCE,
  configurable: true,
  writable: false,
  enumerable: false
});
else if (typeof global !== "undefined") Object.defineProperty(global, REFERENCES_KEY, {
  value: INV_REFERENCE,
  configurable: true,
  writable: false,
  enumerable: false
});
var PROMISE_CONSTRUCTOR = () => {
  const resolver = {
    p: 0,
    s: 0,
    f: 0
  };
  resolver.p = new Promise((resolve, reject) => {
    resolver.s = resolve;
    resolver.f = reject;
  });
  return resolver;
};
var PROMISE_SUCCESS = (resolver, data) => {
  resolver.s(data);
  resolver.p.s = 1;
  resolver.p.v = data;
};
var PROMISE_FAILURE = (resolver, data) => {
  resolver.f(data);
  resolver.p.s = 2;
  resolver.p.v = data;
};
var SERIALIZED_PROMISE_CONSTRUCTOR = PROMISE_CONSTRUCTOR.toString();
var SERIALIZED_PROMISE_SUCCESS = PROMISE_SUCCESS.toString();
var SERIALIZED_PROMISE_FAILURE = PROMISE_FAILURE.toString();
var STREAM_CONSTRUCTOR = () => {
  const buffer = [];
  const listeners = [];
  let alive = true;
  let success = false;
  let count = 0;
  const internal = {
    flush(value, mode, x) {
      for (x = 0; x < count; x++) if (listeners[x]) listeners[x][mode](value);
    },
    up(listener, x, z, current) {
      for (x = 0, z = buffer.length; x < z; x++) {
        current = buffer[x];
        if (!alive && x === z - 1) listener[success ? "return" : "throw"](current);
        else listener.next(current);
      }
    },
    on(listener, temp) {
      if (alive) {
        temp = count++;
        listeners[temp] = listener;
      }
      internal.up(listener);
      return () => {
        if (alive) {
          listeners[temp] = listeners[count];
          listeners[count--] = void 0;
        }
      };
    }
  };
  return {
    __SEROVAL_STREAM__: true,
    on(listener) {
      return internal.on(listener);
    },
    next(value) {
      if (alive) {
        buffer.push(value);
        internal.flush(value, "next");
      }
    },
    throw(value) {
      if (alive) {
        buffer.push(value);
        internal.flush(value, "throw");
        alive = false;
        success = false;
        listeners.length = 0;
      }
    },
    return(value) {
      if (alive) {
        buffer.push(value);
        internal.flush(value, "return");
        alive = false;
        success = true;
        listeners.length = 0;
      }
    }
  };
};
var SERIALIZED_STREAM_CONSTRUCTOR = STREAM_CONSTRUCTOR.toString();
var ITERATOR_CONSTRUCTOR = (symbol) => (sequence) => () => {
  let index = 0;
  const instance = {
    [symbol]() {
      return instance;
    },
    next() {
      if (index > sequence.d) return {
        done: true,
        value: void 0
      };
      const currentIndex = index++;
      const data = sequence.v[currentIndex];
      if (currentIndex === sequence.t) throw data;
      return {
        done: currentIndex === sequence.d,
        value: data
      };
    }
  };
  return instance;
};
var SERIALIZED_ITERATOR_CONSTRUCTOR = ITERATOR_CONSTRUCTOR.toString();
var ASYNC_ITERATOR_CONSTRUCTOR = (symbol, createPromise) => (stream) => () => {
  let count = 0;
  let doneAt = -1;
  let isThrow = false;
  const buffer = [];
  const pending = [];
  const internal = { finalize(i = 0, len = pending.length) {
    for (; i < len; i++) pending[i].s({
      done: true,
      value: void 0
    });
  } };
  stream.on({
    next(value) {
      const temp = pending.shift();
      if (temp) temp.s({
        done: false,
        value
      });
      buffer.push(value);
    },
    throw(value) {
      const temp = pending.shift();
      if (temp) temp.f(value);
      internal.finalize();
      doneAt = buffer.length;
      isThrow = true;
      buffer.push(value);
    },
    return(value) {
      const temp = pending.shift();
      if (temp) temp.s({
        done: true,
        value
      });
      internal.finalize();
      doneAt = buffer.length;
      buffer.push(value);
    }
  });
  const instance = {
    [symbol]() {
      return instance;
    },
    next() {
      if (doneAt === -1) {
        const index2 = count++;
        if (index2 >= buffer.length) {
          const temp = createPromise();
          pending.push(temp);
          return temp.p;
        }
        return {
          done: false,
          value: buffer[index2]
        };
      }
      if (count > doneAt) return {
        done: true,
        value: void 0
      };
      const index = count++;
      const value = buffer[index];
      if (index !== doneAt) return {
        done: false,
        value
      };
      if (isThrow) throw value;
      return {
        done: true,
        value
      };
    }
  };
  return instance;
};
var SERIALIZED_ASYNC_ITERATOR_CONSTRUCTOR = ASYNC_ITERATOR_CONSTRUCTOR.toString();
var ARRAY_BUFFER_CONSTRUCTOR = (b64) => {
  const decoded = atob(b64);
  const length = decoded.length;
  const arr = new Uint8Array(length);
  for (let i = 0; i < length; i++) arr[i] = decoded.charCodeAt(i);
  return arr.buffer;
};
var SERIALIZED_ARRAY_BUFFER_CONSTRUCTOR = ARRAY_BUFFER_CONSTRUCTOR.toString();
var createIterator = ITERATOR_CONSTRUCTOR(SYM_ITERATOR);
function createStream() {
  return STREAM_CONSTRUCTOR();
}
var createAsyncIterable = ASYNC_ITERATOR_CONSTRUCTOR(SYM_ASYNC_ITERATOR, PROMISE_CONSTRUCTOR);
var SerovalMode = (function(SerovalMode2) {
  SerovalMode2[SerovalMode2["Vanilla"] = 1] = "Vanilla";
  SerovalMode2[SerovalMode2["Cross"] = 2] = "Cross";
  return SerovalMode2;
})({});
function createPlugin(plugin) {
  return plugin;
}
var RETURN = () => T;
var SERIALIZED_RETURN = RETURN.toString();
var IS_MODERN = /=>/.test(SERIALIZED_RETURN);

// ../../node_modules/@tanstack/router-core/dist/esm/ssr/serializer/transformer.js
function createSerializationAdapter(opts) {
  return opts;
}

// ../../node_modules/@tanstack/router-core/dist/esm/ssr/serializer/RawStream.js
var RawStream = class {
  constructor(stream, options) {
    this.stream = stream;
    this.hint = options?.hint ?? "binary";
  }
};
var BufferCtor = globalThis.Buffer;
var hasNodeBuffer = !!BufferCtor && typeof BufferCtor.from === "function";
function uint8ArrayToBase64(bytes) {
  if (bytes.length === 0) return "";
  if (hasNodeBuffer) return BufferCtor.from(bytes).toString("base64");
  const CHUNK_SIZE = 32768;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    chunks.push(String.fromCharCode.apply(null, chunk));
  }
  return btoa(chunks.join(""));
}
function base64ToUint8Array(base64) {
  if (base64.length === 0) return new Uint8Array(0);
  if (hasNodeBuffer) {
    const buf = BufferCtor.from(base64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
var RAW_STREAM_FACTORY_BINARY = /* @__PURE__ */ Object.create(null);
var RAW_STREAM_FACTORY_TEXT = /* @__PURE__ */ Object.create(null);
var RAW_STREAM_FACTORY_CONSTRUCTOR_BINARY = (stream) => new ReadableStream({ start(controller) {
  stream.on({
    next(base64) {
      try {
        controller.enqueue(base64ToUint8Array(base64));
      } catch {
      }
    },
    throw(error) {
      controller.error(error);
    },
    return() {
      try {
        controller.close();
      } catch {
      }
    }
  });
} });
var textEncoderForFactory = new TextEncoder();
var RAW_STREAM_FACTORY_CONSTRUCTOR_TEXT = (stream) => {
  return new ReadableStream({ start(controller) {
    stream.on({
      next(value) {
        try {
          if (typeof value === "string") controller.enqueue(textEncoderForFactory.encode(value));
          else controller.enqueue(base64ToUint8Array(value.$b64));
        } catch {
        }
      },
      throw(error) {
        controller.error(error);
      },
      return() {
        try {
          controller.close();
        } catch {
        }
      }
    });
  } });
};
var FACTORY_BINARY = `(s=>new ReadableStream({start(c){s.on({next(b){try{const d=atob(b),a=new Uint8Array(d.length);for(let i=0;i<d.length;i++)a[i]=d.charCodeAt(i);c.enqueue(a)}catch(_){}},throw(e){c.error(e)},return(){try{c.close()}catch(_){}}})}}))`;
var FACTORY_TEXT = `(s=>{const e=new TextEncoder();return new ReadableStream({start(c){s.on({next(v){try{if(typeof v==='string'){c.enqueue(e.encode(v))}else{const d=atob(v.$b64),a=new Uint8Array(d.length);for(let i=0;i<d.length;i++)a[i]=d.charCodeAt(i);c.enqueue(a)}}catch(_){}},throw(x){c.error(x)},return(){try{c.close()}catch(_){}}})}})})`;
function toBinaryStream(readable) {
  const stream = createStream();
  const reader = readable.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          stream.return(void 0);
          break;
        }
        stream.next(uint8ArrayToBase64(value));
      }
    } catch (error) {
      stream.throw(error);
    } finally {
      reader.releaseLock();
    }
  })();
  return stream;
}
function toTextStream(readable) {
  const stream = createStream();
  const reader = readable.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          try {
            const remaining = decoder.decode();
            if (remaining.length > 0) stream.next(remaining);
          } catch {
          }
          stream.return(void 0);
          break;
        }
        try {
          const text = decoder.decode(value, { stream: true });
          if (text.length > 0) stream.next(text);
        } catch {
          stream.next({ $b64: uint8ArrayToBase64(value) });
        }
      }
    } catch (error) {
      stream.throw(error);
    } finally {
      reader.releaseLock();
    }
  })();
  return stream;
}
var RawStreamSSRPlugin = createPlugin({
  tag: "tss/RawStream",
  extends: [createPlugin({
    tag: "tss/RawStreamFactory",
    test(value) {
      return value === RAW_STREAM_FACTORY_BINARY;
    },
    parse: {
      sync(_value, _ctx, _data) {
        return {};
      },
      async async(_value, _ctx, _data) {
        return {};
      },
      stream(_value, _ctx, _data) {
        return {};
      }
    },
    serialize(_node, _ctx, _data) {
      return FACTORY_BINARY;
    },
    deserialize(_node, _ctx, _data) {
      return RAW_STREAM_FACTORY_BINARY;
    }
  }), createPlugin({
    tag: "tss/RawStreamFactoryText",
    test(value) {
      return value === RAW_STREAM_FACTORY_TEXT;
    },
    parse: {
      sync(_value, _ctx, _data) {
        return {};
      },
      async async(_value, _ctx, _data) {
        return {};
      },
      stream(_value, _ctx, _data) {
        return {};
      }
    },
    serialize(_node, _ctx, _data) {
      return FACTORY_TEXT;
    },
    deserialize(_node, _ctx, _data) {
      return RAW_STREAM_FACTORY_TEXT;
    }
  })],
  test(value) {
    return value instanceof RawStream;
  },
  parse: {
    sync(value, ctx, _data) {
      const factory = value.hint === "text" ? RAW_STREAM_FACTORY_TEXT : RAW_STREAM_FACTORY_BINARY;
      return {
        hint: ctx.parse(value.hint),
        factory: ctx.parse(factory),
        stream: ctx.parse(createStream())
      };
    },
    async async(value, ctx, _data) {
      const factory = value.hint === "text" ? RAW_STREAM_FACTORY_TEXT : RAW_STREAM_FACTORY_BINARY;
      const encodedStream = value.hint === "text" ? toTextStream(value.stream) : toBinaryStream(value.stream);
      return {
        hint: await ctx.parse(value.hint),
        factory: await ctx.parse(factory),
        stream: await ctx.parse(encodedStream)
      };
    },
    stream(value, ctx, _data) {
      const factory = value.hint === "text" ? RAW_STREAM_FACTORY_TEXT : RAW_STREAM_FACTORY_BINARY;
      const encodedStream = value.hint === "text" ? toTextStream(value.stream) : toBinaryStream(value.stream);
      return {
        hint: ctx.parse(value.hint),
        factory: ctx.parse(factory),
        stream: ctx.parse(encodedStream)
      };
    }
  },
  serialize(node, ctx, _data) {
    return "(" + ctx.serialize(node.factory) + ")(" + ctx.serialize(node.stream) + ")";
  },
  deserialize(node, ctx, _data) {
    const stream = ctx.deserialize(node.stream);
    return ctx.deserialize(node.hint) === "text" ? RAW_STREAM_FACTORY_CONSTRUCTOR_TEXT(stream) : RAW_STREAM_FACTORY_CONSTRUCTOR_BINARY(stream);
  }
});

// ../../node_modules/@tanstack/router-core/dist/esm/ssr/serializer/ShallowErrorPlugin.js
var ShallowErrorPlugin = createPlugin({
  tag: "$TSR/Error",
  test(value) {
    return value instanceof Error;
  },
  parse: {
    sync(value, ctx) {
      return { message: ctx.parse(value.message) };
    },
    async async(value, ctx) {
      return { message: await ctx.parse(value.message) };
    },
    stream(value, ctx) {
      return { message: ctx.parse(value.message) };
    }
  },
  serialize(node, ctx) {
    return "new Error(" + ctx.serialize(node.message) + ")";
  },
  deserialize(node, ctx) {
    return new Error(ctx.deserialize(node.message));
  }
});

// ../../node_modules/seroval-plugins/dist/dev/rolldown-runtime-D7D4PA-g.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
  let target = {};
  for (var name in all) __defProp(target, name, {
    get: all[name],
    enumerable: true
  });
  if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
  return target;
};

// ../../node_modules/seroval-plugins/dist/dev/web-43VA2W_p.js
var PROMISE_TO_ABORT_SIGNAL = (promise) => {
  const controller = new AbortController();
  const abort = controller.abort.bind(controller);
  promise.then(abort, abort);
  return controller;
};
function resolveAbortSignalResult(resolve) {
  resolve(this.reason);
}
function resolveAbortSignal(resolve) {
  this.addEventListener("abort", resolveAbortSignalResult.bind(this, resolve), { once: true });
}
function abortSignalToPromise(signal) {
  return new Promise(resolveAbortSignal.bind(signal));
}
var ABORT_CONTROLLER = {};
var AbortSignalPlugin = createPlugin({
  tag: "seroval-plugins/web/AbortSignal",
  extends: [createPlugin({
    tag: "seroval-plugins/web/AbortControllerFactoryPlugin",
    test(value) {
      return value === ABORT_CONTROLLER;
    },
    parse: {
      sync() {
        return ABORT_CONTROLLER;
      },
      async async() {
        return await Promise.resolve(ABORT_CONTROLLER);
      },
      stream() {
        return ABORT_CONTROLLER;
      }
    },
    serialize() {
      return PROMISE_TO_ABORT_SIGNAL.toString();
    },
    deserialize() {
      return PROMISE_TO_ABORT_SIGNAL;
    }
  })],
  test(value) {
    if (typeof AbortSignal === "undefined") return false;
    return value instanceof AbortSignal;
  },
  parse: {
    sync(value, ctx) {
      if (value.aborted) return { reason: ctx.parse(value.reason) };
      return {};
    },
    async async(value, ctx) {
      if (value.aborted) return { reason: await ctx.parse(value.reason) };
      const result = await abortSignalToPromise(value);
      return { reason: await ctx.parse(result) };
    },
    stream(value, ctx) {
      if (value.aborted) return { reason: ctx.parse(value.reason) };
      const promise = abortSignalToPromise(value);
      return {
        factory: ctx.parse(ABORT_CONTROLLER),
        controller: ctx.parse(promise)
      };
    }
  },
  serialize(node, ctx) {
    if (node.reason) return "AbortSignal.abort(" + ctx.serialize(node.reason) + ")";
    if (node.controller && node.factory) return "(" + ctx.serialize(node.factory) + ")(" + ctx.serialize(node.controller) + ").signal";
    return "(new AbortController).signal";
  },
  deserialize(node, ctx) {
    if (node.reason) return AbortSignal.abort(ctx.deserialize(node.reason));
    if (node.controller) return PROMISE_TO_ABORT_SIGNAL(ctx.deserialize(node.controller)).signal;
    return new AbortController().signal;
  }
});
var BlobPlugin = createPlugin({
  tag: "seroval-plugins/web/Blob",
  test(value) {
    if (typeof Blob === "undefined") return false;
    return value instanceof Blob;
  },
  parse: { async async(value, ctx) {
    return {
      type: await ctx.parse(value.type),
      buffer: await ctx.parse(await value.arrayBuffer())
    };
  } },
  serialize(node, ctx) {
    return "new Blob([" + ctx.serialize(node.buffer) + "],{type:" + ctx.serialize(node.type) + "})";
  },
  deserialize(node, ctx) {
    return new Blob([ctx.deserialize(node.buffer)], { type: ctx.deserialize(node.type) });
  }
});
function createCustomEventOptions(current) {
  return {
    detail: current.detail,
    bubbles: current.bubbles,
    cancelable: current.cancelable,
    composed: current.composed
  };
}
var CustomEventPlugin = createPlugin({
  tag: "seroval-plugins/web/CustomEvent",
  test(value) {
    if (typeof CustomEvent === "undefined") return false;
    return value instanceof CustomEvent;
  },
  parse: {
    sync(value, ctx) {
      return {
        type: ctx.parse(value.type),
        options: ctx.parse(createCustomEventOptions(value))
      };
    },
    async async(value, ctx) {
      return {
        type: await ctx.parse(value.type),
        options: await ctx.parse(createCustomEventOptions(value))
      };
    },
    stream(value, ctx) {
      return {
        type: ctx.parse(value.type),
        options: ctx.parse(createCustomEventOptions(value))
      };
    }
  },
  serialize(node, ctx) {
    return "new CustomEvent(" + ctx.serialize(node.type) + "," + ctx.serialize(node.options) + ")";
  },
  deserialize(node, ctx) {
    return new CustomEvent(ctx.deserialize(node.type), ctx.deserialize(node.options));
  }
});
var DOMExceptionPlugin = createPlugin({
  tag: "seroval-plugins/web/DOMException",
  test(value) {
    if (typeof DOMException === "undefined") return false;
    return value instanceof DOMException;
  },
  parse: {
    sync(value, ctx) {
      return {
        name: ctx.parse(value.name),
        message: ctx.parse(value.message)
      };
    },
    async async(value, ctx) {
      return {
        name: await ctx.parse(value.name),
        message: await ctx.parse(value.message)
      };
    },
    stream(value, ctx) {
      return {
        name: ctx.parse(value.name),
        message: ctx.parse(value.message)
      };
    }
  },
  serialize(node, ctx) {
    return "new DOMException(" + ctx.serialize(node.message) + "," + ctx.serialize(node.name) + ")";
  },
  deserialize(node, ctx) {
    return new DOMException(ctx.deserialize(node.message), ctx.deserialize(node.name));
  }
});
function createEventOptions(current) {
  return {
    bubbles: current.bubbles,
    cancelable: current.cancelable,
    composed: current.composed
  };
}
var EventPlugin = createPlugin({
  tag: "seroval-plugins/web/Event",
  test(value) {
    if (typeof Event === "undefined") return false;
    return value instanceof Event;
  },
  parse: {
    sync(value, ctx) {
      return {
        type: ctx.parse(value.type),
        options: ctx.parse(createEventOptions(value))
      };
    },
    async async(value, ctx) {
      return {
        type: await ctx.parse(value.type),
        options: await ctx.parse(createEventOptions(value))
      };
    },
    stream(value, ctx) {
      return {
        type: ctx.parse(value.type),
        options: ctx.parse(createEventOptions(value))
      };
    }
  },
  serialize(node, ctx) {
    return "new Event(" + ctx.serialize(node.type) + "," + ctx.serialize(node.options) + ")";
  },
  deserialize(node, ctx) {
    return new Event(ctx.deserialize(node.type), ctx.deserialize(node.options));
  }
});
var FilePlugin = createPlugin({
  tag: "seroval-plugins/web/File",
  test(value) {
    if (typeof File === "undefined") return false;
    return value instanceof File;
  },
  parse: { async async(value, ctx) {
    return {
      name: await ctx.parse(value.name),
      options: await ctx.parse({
        type: value.type,
        lastModified: value.lastModified
      }),
      buffer: await ctx.parse(await value.arrayBuffer())
    };
  } },
  serialize(node, ctx) {
    return "new File([" + ctx.serialize(node.buffer) + "]," + ctx.serialize(node.name) + "," + ctx.serialize(node.options) + ")";
  },
  deserialize(node, ctx) {
    return new File([ctx.deserialize(node.buffer)], ctx.deserialize(node.name), ctx.deserialize(node.options));
  }
});
function convertFormData(instance) {
  const items = [];
  instance.forEach((value, key) => {
    items.push([key, value]);
  });
  return items;
}
var FORM_DATA_FACTORY = {};
var FORM_DATA_FACTORY_CONSTRUCTOR = (e, f = new FormData(), i = 0, s = e.length, t) => {
  for (; i < s; i++) {
    t = e[i];
    f.append(t[0], t[1]);
  }
  return f;
};
var FormDataPlugin = createPlugin({
  tag: "seroval-plugins/web/FormData",
  extends: [FilePlugin, createPlugin({
    tag: "seroval-plugins/web/FormDataFactory",
    test(value) {
      return value === FORM_DATA_FACTORY;
    },
    parse: {
      sync() {
        return FORM_DATA_FACTORY;
      },
      async async() {
        return await Promise.resolve(FORM_DATA_FACTORY);
      },
      stream() {
        return FORM_DATA_FACTORY;
      }
    },
    serialize() {
      return FORM_DATA_FACTORY_CONSTRUCTOR.toString();
    },
    deserialize() {
      return FORM_DATA_FACTORY;
    }
  })],
  test(value) {
    if (typeof FormData === "undefined") return false;
    return value instanceof FormData;
  },
  parse: {
    sync(value, ctx) {
      return {
        factory: ctx.parse(FORM_DATA_FACTORY),
        entries: ctx.parse(convertFormData(value))
      };
    },
    async async(value, ctx) {
      return {
        factory: await ctx.parse(FORM_DATA_FACTORY),
        entries: await ctx.parse(convertFormData(value))
      };
    },
    stream(value, ctx) {
      return {
        factory: ctx.parse(FORM_DATA_FACTORY),
        entries: ctx.parse(convertFormData(value))
      };
    }
  },
  serialize(node, ctx) {
    return "(" + ctx.serialize(node.factory) + ")(" + ctx.serialize(node.entries) + ")";
  },
  deserialize(node, ctx) {
    return FORM_DATA_FACTORY_CONSTRUCTOR(ctx.deserialize(node.entries));
  }
});
function convertHeaders(instance) {
  const items = [];
  instance.forEach((value, key) => {
    items.push([key, value]);
  });
  return items;
}
var HeadersPlugin = createPlugin({
  tag: "seroval-plugins/web/Headers",
  test(value) {
    if (typeof Headers === "undefined") return false;
    return value instanceof Headers;
  },
  parse: {
    sync(value, ctx) {
      return { value: ctx.parse(convertHeaders(value)) };
    },
    async async(value, ctx) {
      return { value: await ctx.parse(convertHeaders(value)) };
    },
    stream(value, ctx) {
      return { value: ctx.parse(convertHeaders(value)) };
    }
  },
  serialize(node, ctx) {
    return "new Headers(" + ctx.serialize(node.value) + ")";
  },
  deserialize(node, ctx) {
    return new Headers(ctx.deserialize(node.value));
  }
});
var ImageDataPlugin = createPlugin({
  tag: "seroval-plugins/web/ImageData",
  test(value) {
    if (typeof ImageData === "undefined") return false;
    return value instanceof ImageData;
  },
  parse: {
    sync(value, ctx) {
      return {
        data: ctx.parse(value.data),
        width: ctx.parse(value.width),
        height: ctx.parse(value.height),
        options: ctx.parse({ colorSpace: value.colorSpace })
      };
    },
    async async(value, ctx) {
      return {
        data: await ctx.parse(value.data),
        width: await ctx.parse(value.width),
        height: await ctx.parse(value.height),
        options: await ctx.parse({ colorSpace: value.colorSpace })
      };
    },
    stream(value, ctx) {
      return {
        data: ctx.parse(value.data),
        width: ctx.parse(value.width),
        height: ctx.parse(value.height),
        options: ctx.parse({ colorSpace: value.colorSpace })
      };
    }
  },
  serialize(node, ctx) {
    return "new ImageData(" + ctx.serialize(node.data) + "," + ctx.serialize(node.width) + "," + ctx.serialize(node.height) + "," + ctx.serialize(node.options) + ")";
  },
  deserialize(node, ctx) {
    return new ImageData(ctx.deserialize(node.data), ctx.deserialize(node.width), ctx.deserialize(node.height), ctx.deserialize(node.options));
  }
});
var READABLE_STREAM_FACTORY = {};
var READABLE_STREAM_FACTORY_CONSTRUCTOR = (stream) => new ReadableStream({ start(controller) {
  stream.on({
    next(value) {
      try {
        controller.enqueue(value);
      } catch (_error) {
      }
    },
    throw(value) {
      controller.error(value);
    },
    return() {
      try {
        controller.close();
      } catch (_error) {
      }
    }
  });
} });
var ReadableStreamFactoryPlugin = createPlugin({
  tag: "seroval-plugins/web/ReadableStreamFactory",
  test(value) {
    return value === READABLE_STREAM_FACTORY;
  },
  parse: {
    sync() {
      return READABLE_STREAM_FACTORY;
    },
    async async() {
      return await Promise.resolve(READABLE_STREAM_FACTORY);
    },
    stream() {
      return READABLE_STREAM_FACTORY;
    }
  },
  serialize() {
    return READABLE_STREAM_FACTORY_CONSTRUCTOR.toString();
  },
  deserialize() {
    return READABLE_STREAM_FACTORY;
  }
});
async function drainStream(stream, reader) {
  try {
    const result = await reader.read();
    if (result.done) {
      stream.return(result.value);
      reader.releaseLock();
    } else {
      stream.next(result.value);
      await drainStream(stream, reader);
    }
  } catch (error) {
    stream.throw(error);
  }
}
function cleanupStream(reader) {
  reader.cancel().catch(() => {
  });
  reader.releaseLock();
}
function toStream(value) {
  const stream = createStream();
  const reader = value.getReader();
  const cleanup = cleanupStream.bind(null, reader);
  drainStream(stream, reader).catch(cleanup);
  return [stream, cleanup];
}
var ReadableStreamPlugin = createPlugin({
  tag: "seroval/plugins/web/ReadableStream",
  extends: [ReadableStreamFactoryPlugin],
  test(value) {
    if (typeof ReadableStream === "undefined") return false;
    return value instanceof ReadableStream;
  },
  parse: {
    sync(_value, ctx) {
      return {
        factory: ctx.parse(READABLE_STREAM_FACTORY),
        stream: ctx.parse(createStream())
      };
    },
    async async(value, ctx) {
      return {
        factory: await ctx.parse(READABLE_STREAM_FACTORY),
        stream: await ctx.parse(toStream(value)[0])
      };
    },
    stream(value, ctx) {
      const [stream, cleanup] = toStream(value);
      ctx.addCleanup(cleanup);
      return {
        factory: ctx.parse(READABLE_STREAM_FACTORY),
        stream: ctx.parse(stream)
      };
    }
  },
  serialize(node, ctx) {
    return "(" + ctx.serialize(node.factory) + ")(" + ctx.serialize(node.stream) + ")";
  },
  deserialize(node, ctx) {
    const stream = ctx.deserialize(node.stream);
    return READABLE_STREAM_FACTORY_CONSTRUCTOR(stream);
  }
});
function createRequestOptions(current, body) {
  return {
    body,
    cache: current.cache,
    credentials: current.credentials,
    headers: current.headers,
    integrity: current.integrity,
    keepalive: current.keepalive,
    method: current.method,
    mode: current.mode,
    redirect: current.redirect,
    referrer: current.referrer,
    referrerPolicy: current.referrerPolicy
  };
}
var RequestPlugin = createPlugin({
  tag: "seroval-plugins/web/Request",
  extends: [ReadableStreamPlugin, HeadersPlugin],
  test(value) {
    if (typeof Request === "undefined") return false;
    return value instanceof Request;
  },
  parse: {
    async async(value, ctx) {
      return {
        url: await ctx.parse(value.url),
        options: await ctx.parse(createRequestOptions(value, value.body && !value.bodyUsed ? await value.clone().arrayBuffer() : null))
      };
    },
    stream(value, ctx) {
      return {
        url: ctx.parse(value.url),
        options: ctx.parse(createRequestOptions(value, value.body && !value.bodyUsed ? value.clone().body : null))
      };
    }
  },
  serialize(node, ctx) {
    return "new Request(" + ctx.serialize(node.url) + "," + ctx.serialize(node.options) + ")";
  },
  deserialize(node, ctx) {
    return new Request(ctx.deserialize(node.url), ctx.deserialize(node.options));
  }
});
function createResponseOptions(current) {
  return {
    headers: current.headers,
    status: current.status,
    statusText: current.statusText
  };
}
var ResponsePlugin = createPlugin({
  tag: "seroval-plugins/web/Response",
  extends: [ReadableStreamPlugin, HeadersPlugin],
  test(value) {
    if (typeof Response === "undefined") return false;
    return value instanceof Response;
  },
  parse: {
    async async(value, ctx) {
      return {
        body: await ctx.parse(value.body && !value.bodyUsed ? await value.clone().arrayBuffer() : null),
        options: await ctx.parse(createResponseOptions(value))
      };
    },
    stream(value, ctx) {
      return {
        body: ctx.parse(value.body && !value.bodyUsed ? value.clone().body : null),
        options: ctx.parse(createResponseOptions(value))
      };
    }
  },
  serialize(node, ctx) {
    return "new Response(" + ctx.serialize(node.body) + "," + ctx.serialize(node.options) + ")";
  },
  deserialize(node, ctx) {
    return new Response(ctx.deserialize(node.body), ctx.deserialize(node.options));
  }
});
var URLPlugin = createPlugin({
  tag: "seroval-plugins/web/URL",
  test(value) {
    if (typeof URL === "undefined") return false;
    return value instanceof URL;
  },
  parse: {
    sync(value, ctx) {
      return { value: ctx.parse(value.href) };
    },
    async async(value, ctx) {
      return { value: await ctx.parse(value.href) };
    },
    stream(value, ctx) {
      return { value: ctx.parse(value.href) };
    }
  },
  serialize(node, ctx) {
    return "new URL(" + ctx.serialize(node.value) + ")";
  },
  deserialize(node, ctx) {
    return new URL(ctx.deserialize(node.value));
  }
});
var URLSearchParamsPlugin = createPlugin({
  tag: "seroval-plugins/web/URLSearchParams",
  test(value) {
    if (typeof URLSearchParams === "undefined") return false;
    return value instanceof URLSearchParams;
  },
  parse: {
    sync(value, ctx) {
      return { value: ctx.parse(value.toString()) };
    },
    async async(value, ctx) {
      return { value: await ctx.parse(value.toString()) };
    },
    stream(value, ctx) {
      return { value: ctx.parse(value.toString()) };
    }
  },
  serialize(node, ctx) {
    return "new URLSearchParams(" + ctx.serialize(node.value) + ")";
  },
  deserialize(node, ctx) {
    return new URLSearchParams(ctx.deserialize(node.value));
  }
});
var web_exports = __exportAll({
  AbortSignalPlugin: () => AbortSignalPlugin,
  BlobPlugin: () => BlobPlugin,
  CustomEventPlugin: () => CustomEventPlugin,
  DOMExceptionPlugin: () => DOMExceptionPlugin,
  EventPlugin: () => EventPlugin,
  FilePlugin: () => FilePlugin,
  FormDataPlugin: () => FormDataPlugin,
  HeadersPlugin: () => HeadersPlugin,
  ImageDataPlugin: () => ImageDataPlugin,
  ReadableStreamPlugin: () => ReadableStreamPlugin,
  RequestPlugin: () => RequestPlugin,
  ResponsePlugin: () => ResponsePlugin,
  URLPlugin: () => URLPlugin,
  URLSearchParamsPlugin: () => URLSearchParamsPlugin
});

// ../../node_modules/@tanstack/react-router/dist/esm/awaited.js
var React$12 = __toESM(require_react(), 1);
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
function useAwaited({ promise: _promise }) {
  if (reactUse) return reactUse(_promise);
  const promise = defer(_promise);
  if (promise[TSR_DEFERRED_PROMISE].status === "pending") throw promise;
  if (promise[TSR_DEFERRED_PROMISE].status === "error") throw promise[TSR_DEFERRED_PROMISE].error;
  return promise[TSR_DEFERRED_PROMISE].data;
}
function Await(props) {
  const inner = (0, import_jsx_runtime.jsx)(AwaitInner, { ...props });
  if (props.fallback) return (0, import_jsx_runtime.jsx)(React$12.Suspense, {
    fallback: props.fallback,
    children: inner
  });
  return inner;
}
function AwaitInner(props) {
  const data = useAwaited(props);
  return props.children(data);
}

// ../../node_modules/@tanstack/react-router/dist/esm/nonRouteComponentContext.js
var React$13 = __toESM(require_react(), 1);
var import_jsx_runtime2 = __toESM(require_jsx_runtime(), 1);
var nonRouteComponentContext = true ? React$13.createContext(void 0) : void 0;
function wrapInNonRouteComponentContext(element, component) {
  return (0, import_jsx_runtime2.jsx)(nonRouteComponentContext.Provider, {
    value: component,
    children: element
  });
}

// ../../node_modules/@tanstack/react-router/dist/esm/CatchBoundary.js
var React$14 = __toESM(require_react(), 1);
var import_jsx_runtime3 = __toESM(require_jsx_runtime(), 1);
var CatchBoundary = class extends React$14.Component {
  constructor(..._args) {
    super(..._args);
    this.state = { error: null };
    this.reset = () => {
      this.setState({ error: null });
    };
  }
  static getDerivedStateFromProps(props, state) {
    const resetKey = props.getResetKey();
    if (state.error && state.resetKey !== resetKey) return {
      resetKey,
      error: null
    };
    return { resetKey };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, errorInfo) {
    this.props.onCatch?.(error, errorInfo);
  }
  render() {
    const error = this.state.error;
    if (error) {
      const element = React$14.createElement(this.props.errorComponent ?? ErrorComponent, {
        error,
        reset: this.reset
      });
      return true ? wrapInNonRouteComponentContext(element, "errorComponent") : element;
    }
    return this.props.children;
  }
};
function ErrorComponent({ error }) {
  const [show, setShow] = React$14.useState(true);
  return (0, import_jsx_runtime3.jsxs)("div", {
    style: {
      padding: ".5rem",
      maxWidth: "100%"
    },
    children: [
      (0, import_jsx_runtime3.jsxs)("div", {
        style: {
          display: "flex",
          alignItems: "center",
          gap: ".5rem"
        },
        children: [(0, import_jsx_runtime3.jsx)("strong", {
          style: { fontSize: "1rem" },
          children: "Something went wrong!"
        }), (0, import_jsx_runtime3.jsx)("button", {
          style: {
            appearance: "none",
            fontSize: ".6em",
            border: "1px solid currentColor",
            padding: ".1rem .2rem",
            fontWeight: "bold",
            borderRadius: ".25rem"
          },
          onClick: () => setShow((d) => !d),
          children: show ? "Hide Error" : "Show Error"
        })]
      }),
      (0, import_jsx_runtime3.jsx)("div", { style: { height: ".25rem" } }),
      show ? (0, import_jsx_runtime3.jsx)("div", { children: (0, import_jsx_runtime3.jsx)("pre", {
        style: {
          fontSize: ".7em",
          border: "1px solid red",
          borderRadius: ".25rem",
          padding: ".3rem",
          color: "red",
          overflow: "auto"
        },
        children: error.message ? (0, import_jsx_runtime3.jsx)("code", { children: error.message }) : null
      }) }) : null
    ]
  });
}

// ../../node_modules/@tanstack/react-router/dist/esm/ClientOnly.js
var import_react = __toESM(require_react(), 1);
var import_jsx_runtime4 = __toESM(require_jsx_runtime(), 1);
function ClientOnly({ children, fallback = null }) {
  return (0, import_jsx_runtime4.jsx)(import_react.default.Fragment, { children: useHydrated() ? children : fallback });
}
function useHydrated() {
  return import_react.default.useSyncExternalStore(subscribe, () => true, () => false);
}
function subscribe() {
  return () => {
  };
}

// ../../node_modules/@tanstack/react-router/dist/esm/routerContext.js
var React$15 = __toESM(require_react(), 1);
var routerContext = React$15.createContext(null);

// ../../node_modules/@tanstack/react-router/dist/esm/useRouter.js
var React$16 = __toESM(require_react(), 1);
function useRouter(opts) {
  const value = React$16.useContext(routerContext);
  if (true) {
    if ((opts?.warn ?? true) && !value) console.warn("Warning: useRouter must be used inside a <RouterProvider> component!");
  }
  return value;
}

// ../../node_modules/@tanstack/react-router/dist/esm/matchContext.js
var React$17 = __toESM(require_react(), 1);
var matchContext = React$17.createContext(void 0);
var dummyMatchContext = React$17.createContext(void 0);

// ../../node_modules/@tanstack/react-router/dist/esm/useMatch.js
var React$18 = __toESM(require_react(), 1);

// ../../node_modules/@tanstack/store/dist/esm/alien.js
var ReactiveFlags = ((ReactiveFlags2) => {
  ReactiveFlags2[ReactiveFlags2["None"] = 0] = "None";
  ReactiveFlags2[ReactiveFlags2["Mutable"] = 1] = "Mutable";
  ReactiveFlags2[ReactiveFlags2["Watching"] = 2] = "Watching";
  ReactiveFlags2[ReactiveFlags2["RecursedCheck"] = 4] = "RecursedCheck";
  ReactiveFlags2[ReactiveFlags2["Recursed"] = 8] = "Recursed";
  ReactiveFlags2[ReactiveFlags2["Dirty"] = 16] = "Dirty";
  ReactiveFlags2[ReactiveFlags2["Pending"] = 32] = "Pending";
  return ReactiveFlags2;
})(ReactiveFlags || {});
function createReactiveSystem({
  update,
  notify,
  unwatched
}) {
  return {
    link: link2,
    unlink: unlink2,
    propagate: propagate2,
    checkDirty: checkDirty2,
    shallowPropagate: shallowPropagate2
  };
  function link2(dep, sub, version) {
    const prevDep = sub.depsTail;
    if (prevDep !== void 0 && prevDep.dep === dep) {
      return;
    }
    const nextDep = prevDep !== void 0 ? prevDep.nextDep : sub.deps;
    if (nextDep !== void 0 && nextDep.dep === dep) {
      nextDep.version = version;
      sub.depsTail = nextDep;
      return;
    }
    const prevSub = dep.subsTail;
    if (prevSub !== void 0 && prevSub.version === version && prevSub.sub === sub) {
      return;
    }
    const newLink = sub.depsTail = dep.subsTail = {
      version,
      dep,
      sub,
      prevDep,
      nextDep,
      prevSub,
      nextSub: void 0
    };
    if (nextDep !== void 0) {
      nextDep.prevDep = newLink;
    }
    if (prevDep !== void 0) {
      prevDep.nextDep = newLink;
    } else {
      sub.deps = newLink;
    }
    if (prevSub !== void 0) {
      prevSub.nextSub = newLink;
    } else {
      dep.subs = newLink;
    }
  }
  function unlink2(link22, sub = link22.sub) {
    const dep = link22.dep;
    const prevDep = link22.prevDep;
    const nextDep = link22.nextDep;
    const nextSub = link22.nextSub;
    const prevSub = link22.prevSub;
    if (nextDep !== void 0) {
      nextDep.prevDep = prevDep;
    } else {
      sub.depsTail = prevDep;
    }
    if (prevDep !== void 0) {
      prevDep.nextDep = nextDep;
    } else {
      sub.deps = nextDep;
    }
    if (nextSub !== void 0) {
      nextSub.prevSub = prevSub;
    } else {
      dep.subsTail = prevSub;
    }
    if (prevSub !== void 0) {
      prevSub.nextSub = nextSub;
    } else if ((dep.subs = nextSub) === void 0) {
      unwatched(dep);
    }
    return nextDep;
  }
  function propagate2(link22) {
    let next = link22.nextSub;
    let stack;
    top: do {
      const sub = link22.sub;
      let flags = sub.flags;
      if (!(flags & (4 | 8 | 16 | 32))) {
        sub.flags = flags | 32;
      } else if (!(flags & (4 | 8))) {
        flags = 0;
      } else if (!(flags & 4)) {
        sub.flags = flags & -9 | 32;
      } else if (!(flags & (16 | 32)) && isValidLink(link22, sub)) {
        sub.flags = flags | (8 | 32);
        flags &= 1;
      } else {
        flags = 0;
      }
      if (flags & 2) {
        notify(sub);
      }
      if (flags & 1) {
        const subSubs = sub.subs;
        if (subSubs !== void 0) {
          const nextSub = (link22 = subSubs).nextSub;
          if (nextSub !== void 0) {
            stack = { value: next, prev: stack };
            next = nextSub;
          }
          continue;
        }
      }
      if ((link22 = next) !== void 0) {
        next = link22.nextSub;
        continue;
      }
      while (stack !== void 0) {
        link22 = stack.value;
        stack = stack.prev;
        if (link22 !== void 0) {
          next = link22.nextSub;
          continue top;
        }
      }
      break;
    } while (true);
  }
  function checkDirty2(link22, sub) {
    let stack;
    let checkDepth = 0;
    let dirty = false;
    top: do {
      const dep = link22.dep;
      const flags = dep.flags;
      if (sub.flags & 16) {
        dirty = true;
      } else if ((flags & (1 | 16)) === (1 | 16)) {
        if (update(dep)) {
          const subs = dep.subs;
          if (subs.nextSub !== void 0) {
            shallowPropagate2(subs);
          }
          dirty = true;
        }
      } else if ((flags & (1 | 32)) === (1 | 32)) {
        if (link22.nextSub !== void 0 || link22.prevSub !== void 0) {
          stack = { value: link22, prev: stack };
        }
        link22 = dep.deps;
        sub = dep;
        ++checkDepth;
        continue;
      }
      if (!dirty) {
        const nextDep = link22.nextDep;
        if (nextDep !== void 0) {
          link22 = nextDep;
          continue;
        }
      }
      while (checkDepth--) {
        const firstSub = sub.subs;
        const hasMultipleSubs = firstSub.nextSub !== void 0;
        if (hasMultipleSubs) {
          link22 = stack.value;
          stack = stack.prev;
        } else {
          link22 = firstSub;
        }
        if (dirty) {
          if (update(sub)) {
            if (hasMultipleSubs) {
              shallowPropagate2(firstSub);
            }
            sub = link22.sub;
            continue;
          }
          dirty = false;
        } else {
          sub.flags &= -33;
        }
        sub = link22.sub;
        const nextDep = link22.nextDep;
        if (nextDep !== void 0) {
          link22 = nextDep;
          continue top;
        }
      }
      return dirty;
    } while (true);
  }
  function shallowPropagate2(link22) {
    do {
      const sub = link22.sub;
      const flags = sub.flags;
      if ((flags & (32 | 16)) === 32) {
        sub.flags = flags | 16;
        if ((flags & (2 | 4)) === 2) {
          notify(sub);
        }
      }
    } while ((link22 = link22.nextSub) !== void 0);
  }
  function isValidLink(checkLink, sub) {
    let link22 = sub.depsTail;
    while (link22 !== void 0) {
      if (link22 === checkLink) {
        return true;
      }
      link22 = link22.prevDep;
    }
    return false;
  }
}

// ../../node_modules/@tanstack/store/dist/esm/atom.js
function toObserver(nextHandler, errorHandler, completionHandler) {
  const isObserver = typeof nextHandler === "object";
  const self2 = isObserver ? nextHandler : void 0;
  return {
    next: (isObserver ? nextHandler.next : nextHandler)?.bind(self2),
    error: (isObserver ? nextHandler.error : errorHandler)?.bind(self2),
    complete: (isObserver ? nextHandler.complete : completionHandler)?.bind(
      self2
    )
  };
}
var queuedEffects = [];
var cycle = 0;
var { link, unlink, propagate, checkDirty, shallowPropagate } = createReactiveSystem({
  update(atom) {
    return atom._update();
  },
  // eslint-disable-next-line no-shadow
  notify(effect2) {
    queuedEffects[queuedEffectsLength++] = effect2;
    effect2.flags &= ~ReactiveFlags.Watching;
  },
  unwatched(atom) {
    if (atom.depsTail !== void 0) {
      atom.depsTail = void 0;
      atom.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
      purgeDeps(atom);
    }
  }
});
var notifyIndex = 0;
var queuedEffectsLength = 0;
var activeSub;
var batchDepth = 0;
function batch(fn) {
  try {
    ++batchDepth;
    fn();
  } finally {
    if (!--batchDepth) {
      flush();
    }
  }
}
function purgeDeps(sub) {
  const depsTail = sub.depsTail;
  let dep = depsTail !== void 0 ? depsTail.nextDep : sub.deps;
  while (dep !== void 0) {
    dep = unlink(dep, sub);
  }
}
function flush() {
  if (batchDepth > 0) {
    return;
  }
  while (notifyIndex < queuedEffectsLength) {
    const effect2 = queuedEffects[notifyIndex];
    queuedEffects[notifyIndex++] = void 0;
    effect2.notify();
  }
  notifyIndex = 0;
  queuedEffectsLength = 0;
}
function createAtom(valueOrFn, options) {
  const isComputed = typeof valueOrFn === "function";
  const getter = valueOrFn;
  const atom = {
    _snapshot: isComputed ? void 0 : valueOrFn,
    subs: void 0,
    subsTail: void 0,
    deps: void 0,
    depsTail: void 0,
    flags: isComputed ? ReactiveFlags.None : ReactiveFlags.Mutable,
    get() {
      if (activeSub !== void 0) {
        link(atom, activeSub, cycle);
      }
      return atom._snapshot;
    },
    subscribe(observerOrFn) {
      const obs = toObserver(observerOrFn);
      const observed = { current: false };
      const e = effect(() => {
        atom.get();
        if (!observed.current) {
          observed.current = true;
        } else {
          obs.next?.(atom._snapshot);
        }
      });
      return {
        unsubscribe: () => {
          e.stop();
        }
      };
    },
    _update(getValue) {
      const prevSub = activeSub;
      const compare = options?.compare ?? Object.is;
      if (isComputed) {
        activeSub = atom;
        ++cycle;
        atom.depsTail = void 0;
      } else if (getValue === void 0) {
        return false;
      }
      if (isComputed) {
        atom.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
      }
      try {
        const oldValue = atom._snapshot;
        const newValue = typeof getValue === "function" ? getValue(oldValue) : getValue === void 0 && isComputed ? getter(oldValue) : getValue;
        if (oldValue === void 0 || !compare(oldValue, newValue)) {
          atom._snapshot = newValue;
          return true;
        }
        return false;
      } finally {
        activeSub = prevSub;
        if (isComputed) {
          atom.flags &= ~ReactiveFlags.RecursedCheck;
        }
        purgeDeps(atom);
      }
    }
  };
  if (isComputed) {
    atom.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
    atom.get = function() {
      const flags = atom.flags;
      if (flags & ReactiveFlags.Dirty || flags & ReactiveFlags.Pending && checkDirty(atom.deps, atom)) {
        if (atom._update()) {
          const subs = atom.subs;
          if (subs !== void 0) {
            shallowPropagate(subs);
          }
        }
      } else if (flags & ReactiveFlags.Pending) {
        atom.flags = flags & ~ReactiveFlags.Pending;
      }
      if (activeSub !== void 0) {
        link(atom, activeSub, cycle);
      }
      return atom._snapshot;
    };
  } else {
    atom.set = function(valueOrFn2) {
      if (atom._update(valueOrFn2)) {
        const subs = atom.subs;
        if (subs !== void 0) {
          propagate(subs);
          shallowPropagate(subs);
          flush();
        }
      }
    };
  }
  return atom;
}
function effect(fn) {
  const run = () => {
    const prevSub = activeSub;
    activeSub = effectObj;
    ++cycle;
    effectObj.depsTail = void 0;
    effectObj.flags = ReactiveFlags.Watching | ReactiveFlags.RecursedCheck;
    try {
      return fn();
    } finally {
      activeSub = prevSub;
      effectObj.flags &= ~ReactiveFlags.RecursedCheck;
      purgeDeps(effectObj);
    }
  };
  const effectObj = {
    deps: void 0,
    depsTail: void 0,
    subs: void 0,
    subsTail: void 0,
    flags: ReactiveFlags.Watching | ReactiveFlags.RecursedCheck,
    notify() {
      const flags = this.flags;
      if (flags & ReactiveFlags.Dirty || flags & ReactiveFlags.Pending && checkDirty(this.deps, this)) {
        run();
      } else {
        this.flags = ReactiveFlags.Watching;
      }
    },
    stop() {
      this.flags = ReactiveFlags.None;
      this.depsTail = void 0;
      purgeDeps(this);
    }
  };
  run();
  return effectObj;
}

// ../../node_modules/@tanstack/react-store/dist/esm/useStore.js
var import_react2 = __toESM(require_react(), 1);
var import_with_selector = __toESM(require_with_selector(), 1);
function defaultCompare(a, b) {
  return a === b;
}
function useStore(atom, selector, compare = defaultCompare) {
  const subscribe2 = (0, import_react2.useCallback)(
    (handleStoreChange) => {
      if (!atom) {
        return () => {
        };
      }
      const { unsubscribe } = atom.subscribe(handleStoreChange);
      return unsubscribe;
    },
    [atom]
  );
  const boundGetSnapshot = (0, import_react2.useCallback)(() => atom?.get(), [atom]);
  const selectedSnapshot = (0, import_with_selector.useSyncExternalStoreWithSelector)(
    subscribe2,
    boundGetSnapshot,
    boundGetSnapshot,
    selector,
    compare
  );
  return selectedSnapshot;
}

// ../../node_modules/@tanstack/react-router/dist/esm/useMatch.js
var dummyMatch = {};
function useStructuralSharing(opts, router) {
  const previousResult = React$18.useRef();
  return (slice) => {
    const selected = opts?.select ? opts.select(slice) : slice;
    if (opts?.structuralSharing ?? router.options.defaultStructuralSharing) return previousResult.current = replaceEqualDeep(previousResult.current, selected);
    return selected;
  };
}
function useMatch(opts) {
  const router = useRouter();
  const nearestRouteId = React$18.useContext(opts.from ? dummyMatchContext : matchContext);
  const routeId = opts.from ?? nearestRouteId;
  const matchStore = router.stores.getMatchStore(routeId);
  if (isServer ?? router.isServer) {
    const match = matchStore.get();
    if (!match) {
      if (opts.shouldThrow ?? true) {
        if (true) throw new Error(`Invariant failed: Could not find ${opts.from ? `an active match from "${opts.from}"` : "a nearest match!"}`);
        invariant();
      }
      return;
    }
    return opts.select ? opts.select(match) : match;
  }
  const selector = useStructuralSharing(opts, router);
  const matchSelection = useStore(matchStore, (match) => match ? selector(match) : dummyMatch);
  if (matchSelection !== dummyMatch) return matchSelection;
  if (opts.shouldThrow ?? true) {
    if (true) throw new Error(`Invariant failed: Could not find ${opts.from ? `an active match from "${opts.from}"` : "a nearest match!"}`);
    invariant();
  }
}

// ../../node_modules/@tanstack/react-router/dist/esm/useLoaderData.js
function useLoaderData(opts) {
  return useMatch({
    from: opts.from,
    strict: opts.strict,
    structuralSharing: opts.structuralSharing,
    select: (match) => {
      return opts.select ? opts.select(match.loaderData) : match.loaderData;
    }
  });
}

// ../../node_modules/@tanstack/react-router/dist/esm/useLoaderDeps.js
function useLoaderDeps(opts) {
  const { select, ...rest } = opts;
  return useMatch({
    ...rest,
    select: (match) => {
      return select ? select(match.loaderDeps) : match.loaderDeps;
    }
  });
}

// ../../node_modules/@tanstack/react-router/dist/esm/useParams.js
function useParams(opts) {
  return useMatch({
    from: opts.from,
    shouldThrow: opts.shouldThrow,
    structuralSharing: opts.structuralSharing,
    strict: opts.strict,
    select: (match) => {
      const params = opts.strict === false ? match.params : match._strictParams;
      return opts.select ? opts.select(params) : params;
    }
  });
}

// ../../node_modules/@tanstack/react-router/dist/esm/useSearch.js
function useSearch(opts) {
  return useMatch({
    from: opts.from,
    strict: opts.strict,
    shouldThrow: opts.shouldThrow,
    structuralSharing: opts.structuralSharing,
    select: (match) => {
      return opts.select ? opts.select(match.search) : match.search;
    }
  });
}

// ../../node_modules/@tanstack/react-router/dist/esm/useNavigate.js
var React$19 = __toESM(require_react(), 1);
function useNavigate(_defaultOpts) {
  const router = useRouter();
  return React$19.useCallback((options) => {
    return router.navigate({
      ...options,
      from: options.from ?? _defaultOpts?.from
    });
  }, [_defaultOpts?.from, router]);
}
function Navigate(props) {
  const router = useRouter();
  const navigate = useNavigate();
  const previousPropsRef = React$19.useRef(null);
  useLayoutEffect2(() => {
    if (previousPropsRef.current !== props) {
      navigate(props);
      previousPropsRef.current = props;
    }
  }, [
    router,
    props,
    navigate
  ]);
  return null;
}

// ../../node_modules/@tanstack/react-router/dist/esm/useRouteContext.js
function useRouteContext(opts) {
  return useMatch({
    ...opts,
    select: (match) => opts.select ? opts.select(match.context) : match.context
  });
}

// ../../node_modules/@tanstack/react-router/dist/esm/link.js
var React$110 = __toESM(require_react(), 1);
var import_jsx_runtime5 = __toESM(require_jsx_runtime(), 1);
function useValueStable(value) {
  const ref = React$110.useRef(value);
  if (!deepEqual(ref.current, value, { ignoreUndefined: false })) ref.current = value;
  return ref.current;
}
function compareLinkState(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
function resolveExternalLink(hrefOption, to, protocolAllowlist) {
  if (hrefOption?.external) {
    if (isDangerousProtocol(hrefOption.href, protocolAllowlist)) {
      if (true) console.warn(`Blocked Link with dangerous protocol: ${hrefOption.href}`);
      return;
    }
    return hrefOption.href;
  }
  if (isSafeInternal(to)) return;
  if (typeof to !== "string" || to.indexOf(":") === -1) return;
  try {
    new URL(to);
    if (isDangerousProtocol(to, protocolAllowlist)) {
      if (true) console.warn(`Blocked Link with dangerous protocol: ${to}`);
      return;
    }
    return to;
  } catch {
  }
}
function resolveIsActive(location, next, activeOptions, basepath, isHydrated, isExternal) {
  if (isExternal) return false;
  if (activeOptions?.exact) {
    if (!exactPathTest(location.pathname, next.pathname, basepath)) return false;
  } else {
    const currentPathSplit = removeTrailingSlash(location.pathname, basepath);
    const nextPathSplit = removeTrailingSlash(next.pathname, basepath);
    if (!(currentPathSplit.startsWith(nextPathSplit) && (currentPathSplit.length === nextPathSplit.length || currentPathSplit[nextPathSplit.length] === "/"))) return false;
  }
  if (activeOptions?.includeSearch ?? true) {
    if (!deepEqual(location.search, next.search, {
      partial: !activeOptions?.exact,
      ignoreUndefined: !activeOptions?.explicitUndefined
    })) return false;
  }
  if (activeOptions?.includeHash) return isHydrated && location.hash === next.hash;
  return true;
}
function useLinkProps(options, forwardedRef) {
  const router = useRouter();
  const innerRef = useForwardedRef(forwardedRef);
  const { activeProps, inactiveProps, activeOptions, to, preload: userPreload, preloadDelay: userPreloadDelay, preloadIntentProximity: _preloadIntentProximity, hashScrollIntoView, replace, startTransition: startTransition2, resetScroll, viewTransition, children, target, disabled, style, className, onClick, onBlur, onFocus, onMouseEnter, onMouseLeave, onTouchStart, ignoreBlocker, params: _params, search: _search, hash: _hash, state: _state, mask: _mask, reloadDocument: _reloadDocument, unsafeRelative: _unsafeRelative, from: _from, _fromLocation, ...propsSafeToSpread } = options;
  if (isServer ?? router.isServer) {
    const safeInternal = isSafeInternal(to);
    if (typeof to === "string" && !safeInternal && to.indexOf(":") > -1) try {
      new URL(to);
      if (isDangerousProtocol(to, router.protocolAllowlist)) {
        if (true) console.warn(`Blocked Link with dangerous protocol: ${to}`);
        return {
          ...propsSafeToSpread,
          ref: innerRef,
          href: void 0,
          ...children && { children },
          ...target && { target },
          ...disabled && { disabled },
          ...style && { style },
          ...className && { className }
        };
      }
      return {
        ...propsSafeToSpread,
        ref: innerRef,
        href: to,
        ...children && { children },
        ...target && { target },
        ...disabled && { disabled },
        ...style && { style },
        ...className && { className }
      };
    } catch {
    }
    const next = router.buildLocation({
      ...options,
      from: options.from
    });
    const hrefOption = getHrefOption(next.maskedLocation ? next.maskedLocation.publicHref : next.publicHref, next.maskedLocation ? next.maskedLocation.external : next.external, router.history, disabled);
    const externalLink2 = (() => {
      if (hrefOption?.external) {
        if (isDangerousProtocol(hrefOption.href, router.protocolAllowlist)) {
          if (true) console.warn(`Blocked Link with dangerous protocol: ${hrefOption.href}`);
          return;
        }
        return hrefOption.href;
      }
      if (safeInternal) return void 0;
      if (typeof to === "string" && to.indexOf(":") > -1) try {
        new URL(to);
        if (isDangerousProtocol(to, router.protocolAllowlist)) {
          if (true) console.warn(`Blocked Link with dangerous protocol: ${to}`);
          return;
        }
        return to;
      } catch {
      }
    })();
    const isActive2 = (() => {
      if (externalLink2) return false;
      const currentLocation = router.stores.location.get();
      const exact = activeOptions?.exact ?? false;
      if (exact) {
        if (!exactPathTest(currentLocation.pathname, next.pathname, router.basepath)) return false;
      } else {
        const currentPathSplit = removeTrailingSlash(currentLocation.pathname, router.basepath);
        const nextPathSplit = removeTrailingSlash(next.pathname, router.basepath);
        if (!(currentPathSplit.startsWith(nextPathSplit) && (currentPathSplit.length === nextPathSplit.length || currentPathSplit[nextPathSplit.length] === "/"))) return false;
      }
      if (activeOptions?.includeSearch ?? true) {
        if (currentLocation.search !== next.search) {
          const currentSearchEmpty = !currentLocation.search || typeof currentLocation.search === "object" && !hasKeys(currentLocation.search);
          const nextSearchEmpty = !next.search || typeof next.search === "object" && !hasKeys(next.search);
          if (!(currentSearchEmpty && nextSearchEmpty)) {
            if (!deepEqual(currentLocation.search, next.search, {
              partial: !exact,
              ignoreUndefined: !activeOptions?.explicitUndefined
            })) return false;
          }
        }
      }
      if (activeOptions?.includeHash) return false;
      return true;
    })();
    if (externalLink2) return {
      ...propsSafeToSpread,
      ref: innerRef,
      href: externalLink2,
      ...children && { children },
      ...target && { target },
      ...disabled && { disabled },
      ...style && { style },
      ...className && { className }
    };
    const resolvedActiveProps2 = isActive2 ? functionalUpdate(activeProps, {}) ?? STATIC_ACTIVE_OBJECT : STATIC_EMPTY_OBJECT;
    const resolvedInactiveProps2 = isActive2 ? STATIC_EMPTY_OBJECT : functionalUpdate(inactiveProps, {}) ?? STATIC_EMPTY_OBJECT;
    const resolvedStyle2 = (() => {
      const baseStyle = style;
      const activeStyle = resolvedActiveProps2.style;
      const inactiveStyle = resolvedInactiveProps2.style;
      if (!baseStyle && !activeStyle && !inactiveStyle) return;
      if (baseStyle && !activeStyle && !inactiveStyle) return baseStyle;
      if (!baseStyle && activeStyle && !inactiveStyle) return activeStyle;
      if (!baseStyle && !activeStyle && inactiveStyle) return inactiveStyle;
      return {
        ...baseStyle,
        ...activeStyle,
        ...inactiveStyle
      };
    })();
    const resolvedClassName2 = (() => {
      const baseClassName = className;
      const activeClassName = resolvedActiveProps2.className;
      const inactiveClassName = resolvedInactiveProps2.className;
      if (!baseClassName && !activeClassName && !inactiveClassName) return "";
      let out = "";
      if (baseClassName) out = baseClassName;
      if (activeClassName) out = out ? `${out} ${activeClassName}` : activeClassName;
      if (inactiveClassName) out = out ? `${out} ${inactiveClassName}` : inactiveClassName;
      return out;
    })();
    return {
      ...propsSafeToSpread,
      ...resolvedActiveProps2,
      ...resolvedInactiveProps2,
      href: hrefOption?.href,
      ref: innerRef,
      disabled: !!disabled,
      target,
      ...resolvedStyle2 && { style: resolvedStyle2 },
      ...resolvedClassName2 && { className: resolvedClassName2 },
      ...disabled && STATIC_DISABLED_PROPS,
      ...isActive2 && STATIC_ACTIVE_PROPS
    };
  }
  const isHydrated = useHydrated();
  const stableSearch = useValueStable(options.search);
  const stableParams = useValueStable(options.params);
  const stableActiveOptions = useValueStable(activeOptions);
  const _options = React$110.useMemo(() => options, [
    router,
    options.from,
    options._fromLocation,
    options.hash,
    options.to,
    stableSearch,
    stableParams,
    options.state,
    options.mask,
    options.unsafeRelative
  ]);
  const selectLinkState = React$110.useCallback((location) => {
    const next = router.buildLocation({
      _fromLocation: location,
      ..._options
    });
    const hrefOption = getHrefOption(next.maskedLocation ? next.maskedLocation.publicHref : next.publicHref, next.maskedLocation ? next.maskedLocation.external : next.external, router.history, disabled);
    const externalLink2 = resolveExternalLink(hrefOption, to, router.protocolAllowlist);
    return [
      hrefOption?.href,
      externalLink2,
      resolveIsActive(location, next, stableActiveOptions, router.basepath, isHydrated, externalLink2 !== void 0)
    ];
  }, [
    stableActiveOptions,
    disabled,
    isHydrated,
    _options,
    router,
    to
  ]);
  const [href, externalLink, isActive] = useStore(router.stores.location, selectLinkState, compareLinkState);
  const resolvedActiveProps = isActive ? functionalUpdate(activeProps, {}) ?? STATIC_ACTIVE_OBJECT : STATIC_EMPTY_OBJECT;
  const resolvedInactiveProps = isActive ? STATIC_EMPTY_OBJECT : functionalUpdate(inactiveProps, {}) ?? STATIC_EMPTY_OBJECT;
  const resolvedClassName = [
    className,
    resolvedActiveProps.className,
    resolvedInactiveProps.className
  ].filter(Boolean).join(" ");
  const resolvedStyle = (style || resolvedActiveProps.style || resolvedInactiveProps.style) && {
    ...style,
    ...resolvedActiveProps.style,
    ...resolvedInactiveProps.style
  };
  const hasRenderFetched = React$110.useRef(false);
  const preload = options.reloadDocument || externalLink || disabled ? false : userPreload ?? router.options.defaultPreload;
  const preloadDelay = userPreloadDelay ?? router.options.defaultPreloadDelay ?? 0;
  const doPreload = React$110.useCallback(() => {
    router.preloadRoute(_options).catch((err) => {
      console.warn(err);
      console.warn(preloadWarning);
    });
  }, [router, _options]);
  const enqueuePreload = React$110.useCallback((e) => {
    if (!e) {
      cancelPreload(innerRef);
      return;
    }
    if (!(e.isIntersecting ?? preload === "intent")) {
      if (e.isIntersecting === false) cancelPreload(innerRef);
      return;
    }
    if (!preloadDelay) {
      doPreload();
      return;
    }
    if (timeoutMap.has(innerRef)) return;
    timeoutMap.set(innerRef, setTimeout(() => {
      timeoutMap.delete(innerRef);
      doPreload();
    }, preloadDelay));
  }, [
    doPreload,
    innerRef,
    preload,
    preloadDelay
  ]);
  useIntersectionObserver(innerRef, enqueuePreload, preload !== "viewport");
  React$110.useEffect(() => {
    if (hasRenderFetched.current) return;
    if (preload === "render") {
      doPreload();
      hasRenderFetched.current = true;
    }
  }, [doPreload, preload]);
  const handleClick = (e) => {
    const elementTarget = e.currentTarget.getAttribute("target");
    const effectiveTarget = target !== void 0 ? target : elementTarget;
    if (!disabled && !(e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) && !e.defaultPrevented && (!effectiveTarget || effectiveTarget === "_self") && e.button === 0) {
      e.preventDefault();
      router.navigate({
        ..._options,
        replace,
        resetScroll,
        hashScrollIntoView,
        startTransition: startTransition2,
        viewTransition,
        ignoreBlocker
      });
    }
  };
  if (externalLink) return {
    ...propsSafeToSpread,
    ref: innerRef,
    href: externalLink,
    ...children && { children },
    ...target && { target },
    ...disabled && { disabled },
    ...style && { style },
    ...className && { className },
    ...onClick && { onClick },
    ...onBlur && { onBlur },
    ...onFocus && { onFocus },
    ...onMouseEnter && { onMouseEnter },
    ...onMouseLeave && { onMouseLeave },
    ...onTouchStart && { onTouchStart }
  };
  const handleTouchStart = () => {
    if (preload !== "intent") return;
    doPreload();
  };
  const handleLeave = () => {
    if (preload === "intent") cancelPreload(innerRef);
  };
  return {
    ...propsSafeToSpread,
    ...resolvedActiveProps,
    ...resolvedInactiveProps,
    href,
    ref: innerRef,
    onClick: composeHandlers([onClick, handleClick]),
    onBlur: composeHandlers([onBlur, handleLeave]),
    onFocus: composeHandlers([onFocus, enqueuePreload]),
    onMouseEnter: composeHandlers([onMouseEnter, enqueuePreload]),
    onMouseLeave: composeHandlers([onMouseLeave, handleLeave]),
    onTouchStart: composeHandlers([onTouchStart, handleTouchStart]),
    disabled: !!disabled,
    target,
    ...resolvedStyle && { style: resolvedStyle },
    ...resolvedClassName && { className: resolvedClassName },
    ...disabled && STATIC_DISABLED_PROPS,
    ...isActive && STATIC_ACTIVE_PROPS
  };
}
var STATIC_EMPTY_OBJECT = {};
var STATIC_ACTIVE_OBJECT = { className: "active" };
var STATIC_DISABLED_PROPS = {
  role: "link",
  "aria-disabled": true
};
var STATIC_ACTIVE_PROPS = {
  "data-status": "active",
  "aria-current": "page"
};
var timeoutMap = /* @__PURE__ */ new WeakMap();
var cancelPreload = (eventTarget) => {
  clearTimeout(timeoutMap.get(eventTarget));
  timeoutMap.delete(eventTarget);
};
var composeHandlers = (handlers) => (e) => {
  for (const handler of handlers) {
    if (!handler) continue;
    if (e.defaultPrevented) return;
    handler(e);
  }
};
function getHrefOption(publicHref, external, history2, disabled) {
  if (disabled) return void 0;
  if (external) return {
    href: publicHref,
    external: true
  };
  return {
    href: history2.createHref(publicHref) || "/",
    external: false
  };
}
function isSafeInternal(to) {
  if (typeof to !== "string") return false;
  const zero = to.charCodeAt(0);
  if (zero === 47) return to.charCodeAt(1) !== 47;
  return zero === 46;
}
function createLink(Comp) {
  return React$110.forwardRef(function CreatedLink(props, ref) {
    return (0, import_jsx_runtime5.jsx)(Link, {
      ...props,
      _asChild: Comp,
      ref
    });
  });
}
var Link = React$110.forwardRef((props, ref) => {
  const { _asChild, ...rest } = props;
  const { type: _type, ...linkProps } = useLinkProps(rest, ref);
  const children = typeof rest.children === "function" ? rest.children({ isActive: linkProps["data-status"] === "active" }) : rest.children;
  if (!_asChild) {
    const { disabled: _, ...rest2 } = linkProps;
    return React$110.createElement("a", rest2, children);
  }
  return React$110.createElement(_asChild, linkProps, children);
});
var linkOptions = (options) => {
  return options;
};

// ../../node_modules/@tanstack/react-router/dist/esm/route.js
var import_react3 = __toESM(require_react(), 1);
var import_jsx_runtime6 = __toESM(require_jsx_runtime(), 1);
function getRouteApi(id) {
  return new RouteApi({ id });
}
var RouteApi = class extends BaseRouteApi {
  /**
  * @deprecated Use the `getRouteApi` function instead.
  */
  constructor({ id }) {
    super({ id });
    this.useMatch = (opts) => {
      return useMatch({
        select: opts?.select,
        from: this.id,
        structuralSharing: opts?.structuralSharing
      });
    };
    this.useRouteContext = (opts) => {
      return useRouteContext({
        ...opts,
        from: this.id
      });
    };
    this.useSearch = (opts) => {
      return useSearch({
        select: opts?.select,
        structuralSharing: opts?.structuralSharing,
        from: this.id
      });
    };
    this.useParams = (opts) => {
      return useParams({
        select: opts?.select,
        structuralSharing: opts?.structuralSharing,
        from: this.id
      });
    };
    this.useLoaderDeps = (opts) => {
      return useLoaderDeps({
        ...opts,
        from: this.id,
        strict: false
      });
    };
    this.useLoaderData = (opts) => {
      return useLoaderData({
        ...opts,
        from: this.id,
        strict: false
      });
    };
    this.useNavigate = () => {
      return useNavigate({ from: useRouter().routesById[this.id].fullPath });
    };
    this.notFound = (opts) => {
      return notFound({
        routeId: this.id,
        ...opts
      });
    };
    this.Link = import_react3.default.forwardRef((props, ref) => {
      const fullPath = useRouter().routesById[this.id].fullPath;
      return (0, import_jsx_runtime6.jsx)(Link, {
        ref,
        from: fullPath,
        ...props
      });
    });
  }
};
var Route = class extends BaseRoute {
  /**
  * @deprecated Use the `createRoute` function instead.
  */
  constructor(options) {
    super(options);
    this.useMatch = (opts) => {
      return useMatch({
        select: opts?.select,
        from: this.id,
        structuralSharing: opts?.structuralSharing
      });
    };
    this.useRouteContext = (opts) => {
      return useRouteContext({
        ...opts,
        from: this.id
      });
    };
    this.useSearch = (opts) => {
      return useSearch({
        select: opts?.select,
        structuralSharing: opts?.structuralSharing,
        from: this.id
      });
    };
    this.useParams = (opts) => {
      return useParams({
        select: opts?.select,
        structuralSharing: opts?.structuralSharing,
        from: this.id
      });
    };
    this.useLoaderDeps = (opts) => {
      return useLoaderDeps({
        ...opts,
        from: this.id
      });
    };
    this.useLoaderData = (opts) => {
      return useLoaderData({
        ...opts,
        from: this.id
      });
    };
    this.useNavigate = () => {
      return useNavigate({ from: this.fullPath });
    };
    this.Link = import_react3.default.forwardRef((props, ref) => {
      return (0, import_jsx_runtime6.jsx)(Link, {
        ref,
        from: this.fullPath,
        ...props
      });
    });
  }
};
function createRoute(options) {
  return new Route(options);
}
function createRootRouteWithContext() {
  return (options) => {
    return createRootRoute(options);
  };
}
var rootRouteWithContext = createRootRouteWithContext;
var RootRoute = class extends BaseRootRoute {
  /**
  * @deprecated `RootRoute` is now an internal implementation detail. Use `createRootRoute()` instead.
  */
  constructor(options) {
    super(options);
    this.useMatch = (opts) => {
      return useMatch({
        select: opts?.select,
        from: this.id,
        structuralSharing: opts?.structuralSharing
      });
    };
    this.useRouteContext = (opts) => {
      return useRouteContext({
        ...opts,
        from: this.id
      });
    };
    this.useSearch = (opts) => {
      return useSearch({
        select: opts?.select,
        structuralSharing: opts?.structuralSharing,
        from: this.id
      });
    };
    this.useParams = (opts) => {
      return useParams({
        select: opts?.select,
        structuralSharing: opts?.structuralSharing,
        from: this.id
      });
    };
    this.useLoaderDeps = (opts) => {
      return useLoaderDeps({
        ...opts,
        from: this.id
      });
    };
    this.useLoaderData = (opts) => {
      return useLoaderData({
        ...opts,
        from: this.id
      });
    };
    this.useNavigate = () => {
      return useNavigate({ from: this.fullPath });
    };
    this.Link = import_react3.default.forwardRef((props, ref) => {
      return (0, import_jsx_runtime6.jsx)(Link, {
        ref,
        from: this.fullPath,
        ...props
      });
    });
  }
};
function createRootRoute(options) {
  return new RootRoute(options);
}
function createRouteMask(opts) {
  return opts;
}
var NotFoundRoute = class extends Route {
  constructor(options) {
    super({
      ...options,
      id: "404"
    });
  }
};

// ../../node_modules/@tanstack/react-router/dist/esm/fileRoute.js
function createFileRoute(path) {
  return (options) => {
    const route = createRoute(options);
    route.isRoot = false;
    return route;
  };
}
var FileRoute = class {
  constructor(path, _opts) {
    this.path = path;
    this.createRoute = (options) => {
      if (true) {
        if (!this.silent) console.warn("Warning: FileRoute is deprecated and will be removed in the next major version. Use the createFileRoute(path)(options) function instead.");
      }
      const route = createRoute(options);
      route.isRoot = false;
      return route;
    };
    this.silent = _opts?.silent;
  }
};
function FileRouteLoader(_path) {
  if (true) console.warn(`Warning: FileRouteLoader is deprecated and will be removed in the next major version. Please place the loader function in the main route file, inside the \`createFileRoute('/path/to/file')(options)\` options`);
  return (loaderFn) => loaderFn;
}
var LazyRoute = class {
  constructor(opts) {
    this.useMatch = (opts2) => {
      return useMatch({
        select: opts2?.select,
        from: this.options.id,
        structuralSharing: opts2?.structuralSharing
      });
    };
    this.useRouteContext = (opts2) => {
      return useRouteContext({
        ...opts2,
        from: this.options.id
      });
    };
    this.useSearch = (opts2) => {
      return useSearch({
        select: opts2?.select,
        structuralSharing: opts2?.structuralSharing,
        from: this.options.id
      });
    };
    this.useParams = (opts2) => {
      return useParams({
        select: opts2?.select,
        structuralSharing: opts2?.structuralSharing,
        from: this.options.id
      });
    };
    this.useLoaderDeps = (opts2) => {
      return useLoaderDeps({
        ...opts2,
        from: this.options.id
      });
    };
    this.useLoaderData = (opts2) => {
      return useLoaderData({
        ...opts2,
        from: this.options.id
      });
    };
    this.useNavigate = () => {
      return useNavigate({ from: useRouter().routesById[this.options.id].fullPath });
    };
    this.options = opts;
  }
};
function createLazyRoute(id) {
  return (opts) => {
    return new LazyRoute({
      id,
      ...opts
    });
  };
}
function createLazyFileRoute(id) {
  if (typeof id === "object") return new LazyRoute(id);
  return (opts) => new LazyRoute({
    id,
    ...opts
  });
}

// ../../node_modules/@tanstack/react-router/dist/esm/lazyRouteComponent.js
var React$111 = __toESM(require_react(), 1);
function lazyRouteComponent(importer, exportName) {
  let loadPromise;
  let comp;
  let error;
  const load = () => {
    if (!loadPromise) {
      error = void 0;
      loadPromise = importer().then((res) => {
        if (!(isServer ?? typeof window === "undefined")) {
          loadPromise = void 0;
          lazyComp.preload = void 0;
        }
        comp = res[exportName ?? "default"];
      }).catch((err) => {
        loadPromise = void 0;
        error = err;
      });
    }
    return loadPromise;
  };
  const lazyComp = function Lazy(props) {
    if (error) {
      if (isModuleNotFoundError(error) && !(isServer ?? typeof window === "undefined") && typeof sessionStorage !== "undefined") {
        const storageKey2 = `tanstack_router_reload:${error.message}`;
        if (!sessionStorage.getItem(storageKey2)) {
          sessionStorage.setItem(storageKey2, "1");
          window.location.reload();
          throw new Promise(() => {
          });
        }
      }
      throw error;
    }
    if (!comp) if (reactUse) reactUse(load());
    else throw load();
    return React$111.createElement(comp, props);
  };
  lazyComp.preload = load;
  return lazyComp;
}

// ../../node_modules/@tanstack/react-router/dist/esm/not-found.js
var import_react4 = __toESM(require_react(), 1);
var import_jsx_runtime7 = __toESM(require_jsx_runtime(), 1);
function CatchNotFound(props) {
  const router = useRouter();
  if (isServer ?? router.isServer) {
    const resetKey2 = `not-found-${router.stores.location.get().pathname}-${router.stores.status.get()}`;
    return (0, import_jsx_runtime7.jsx)(CatchBoundary, {
      getResetKey: () => resetKey2,
      onCatch: (error, errorInfo) => {
        if (isNotFound(error)) props.onCatch?.(error, errorInfo);
        else throw error;
      },
      errorComponent: ({ error }) => {
        if (isNotFound(error)) return props.fallback?.(error);
        else throw error;
      },
      children: props.children
    });
  }
  const resetKey = `not-found-${useStore(router.stores.location, (location) => location.pathname)}-${useStore(router.stores.status, (status) => status)}`;
  return (0, import_jsx_runtime7.jsx)(CatchBoundary, {
    getResetKey: () => resetKey,
    onCatch: (error, errorInfo) => {
      if (isNotFound(error)) props.onCatch?.(error, errorInfo);
      else throw error;
    },
    errorComponent: ({ error }) => {
      if (isNotFound(error)) return props.fallback?.(error);
      else throw error;
    },
    children: props.children
  });
}
function DefaultGlobalNotFound() {
  return (0, import_jsx_runtime7.jsx)("p", { children: "Not Found" });
}

// ../../node_modules/@tanstack/react-router/dist/esm/ScriptOnce.js
var import_jsx_runtime8 = __toESM(require_jsx_runtime(), 1);
function ScriptOnce({ children }) {
  const router = useRouter();
  if (!(isServer ?? router.isServer)) return null;
  return (0, import_jsx_runtime8.jsx)("script", {
    nonce: router.options.ssr?.nonce,
    dangerouslySetInnerHTML: { __html: children + ";document.currentScript.remove()" }
  });
}

// ../../node_modules/@tanstack/react-router/dist/esm/SafeFragment.js
var import_react5 = __toESM(require_react(), 1);
var import_jsx_runtime9 = __toESM(require_jsx_runtime(), 1);
function SafeFragment(props) {
  return (0, import_jsx_runtime9.jsx)(import_jsx_runtime9.Fragment, { children: props.children });
}

// ../../node_modules/@tanstack/react-router/dist/esm/renderRouteNotFound.js
var import_react6 = __toESM(require_react(), 1);
var import_jsx_runtime10 = __toESM(require_jsx_runtime(), 1);
function renderRouteNotFound(router, route, data) {
  if (!route.options.notFoundComponent) {
    if (router.options.defaultNotFoundComponent) {
      const notFoundElement2 = (0, import_jsx_runtime10.jsx)(router.options.defaultNotFoundComponent, { ...data });
      return true ? wrapInNonRouteComponentContext(notFoundElement2, "notFoundComponent") : notFoundElement2;
    }
    if (true) {
      if (!route.options.notFoundComponent) console.warn(`Warning: A notFoundError was encountered on the route with ID "${route.id}", but a notFoundComponent option was not configured, nor was a router level defaultNotFoundComponent configured. Consider configuring at least one of these to avoid TanStack Router's overly generic defaultNotFoundComponent (<p>Not Found</p>)`);
    }
    return (0, import_jsx_runtime10.jsx)(DefaultGlobalNotFound, {});
  }
  const notFoundElement = (0, import_jsx_runtime10.jsx)(route.options.notFoundComponent, { ...data });
  return true ? wrapInNonRouteComponentContext(notFoundElement, "notFoundComponent") : notFoundElement;
}

// ../../node_modules/@tanstack/react-router/dist/esm/scroll-restoration.js
var import_jsx_runtime11 = __toESM(require_jsx_runtime(), 1);

// ../../node_modules/@tanstack/router-core/dist/esm/scroll-restoration-script/client.js
function getScrollRestorationScriptForRouter(_router) {
  return null;
}

// ../../node_modules/@tanstack/react-router/dist/esm/scroll-restoration.js
function ScrollRestoration() {
  const script = getScrollRestorationScriptForRouter(useRouter());
  if (!script) return null;
  return (0, import_jsx_runtime11.jsx)(ScriptOnce, { children: script });
}

// ../../node_modules/@tanstack/react-router/dist/esm/Match.js
var React$112 = __toESM(require_react(), 1);
var import_jsx_runtime12 = __toESM(require_jsx_runtime(), 1);
function renderPending(router, route) {
  const PendingComponent = route?.options.pendingComponent ?? router.options.defaultPendingComponent;
  if (!PendingComponent) return null;
  const pendingElement = (0, import_jsx_runtime12.jsx)(PendingComponent, {});
  return true ? wrapInNonRouteComponentContext(pendingElement, "pendingComponent") : pendingElement;
}
var outletMatchSelectionEqual = (a, b) => a[0] === b[0] && a[1] === b[1];
var canWrapInSuspense = (router, route, ssr) => !route.isRoot || route.options.shellComponent || route.options.wrapInSuspense || ssr === false || ssr === "data-only" || !((isServer ?? router.isServer) || router.ssr);
var Match = React$112.memo(function MatchImpl({ routeId }) {
  const router = useRouter();
  if (isServer ?? router.isServer) return (0, import_jsx_runtime12.jsx)(MatchView, {
    router,
    match: router.stores.byRoute.get(routeId).get()
  });
  return (0, import_jsx_runtime12.jsx)(MatchView, {
    router,
    match: useStore(router.stores.getMatchStore(routeId), (value) => value)
  });
});
function MatchView({ router, match }) {
  const route = router.routesById[match.routeId];
  const pendingElement = renderPending(router, route);
  const routeErrorComponent = route.options.errorComponent ?? router.options.defaultErrorComponent;
  const routeOnCatch = route.options.onCatch ?? router.options.defaultOnCatch;
  const routeNotFoundComponent = route.isRoot ? route.options.notFoundComponent ?? router.options.notFoundRoute?.options.component : route.options.notFoundComponent;
  const resolvedNoSsr = match.ssr === false || match.ssr === "data-only";
  const ResolvedSuspenseBoundary = canWrapInSuspense(router, route, match.ssr) && (route.options.wrapInSuspense ?? pendingElement ?? (route.options.errorComponent?.preload || resolvedNoSsr)) ? React$112.Suspense : SafeFragment;
  const ResolvedCatchBoundary = routeErrorComponent ? CatchBoundary : SafeFragment;
  const ResolvedNotFoundBoundary = routeNotFoundComponent ? CatchNotFound : SafeFragment;
  return (0, import_jsx_runtime12.jsxs)(route.isRoot ? route.options.shellComponent ?? SafeFragment : SafeFragment, { children: [(0, import_jsx_runtime12.jsx)(matchContext.Provider, {
    value: match.routeId,
    children: (0, import_jsx_runtime12.jsx)(ResolvedSuspenseBoundary, {
      fallback: pendingElement,
      children: (0, import_jsx_runtime12.jsx)(ResolvedCatchBoundary, {
        getResetKey: () => match,
        errorComponent: routeErrorComponent,
        onCatch: (error, errorInfo) => {
          if (isNotFound(error)) {
            error.routeId ??= match.routeId;
            throw error;
          }
          if (true) console.warn(`Warning: Error in route match: ${match.id}`);
          routeOnCatch?.(error, errorInfo);
        },
        children: (0, import_jsx_runtime12.jsx)(ResolvedNotFoundBoundary, {
          fallback: (error) => {
            error.routeId ??= match.routeId;
            if (error.routeId !== match.routeId) throw error;
            const notFoundElement = React$112.createElement(routeNotFoundComponent, error);
            return true ? wrapInNonRouteComponentContext(notFoundElement, "notFoundComponent") : notFoundElement;
          },
          children: resolvedNoSsr ? (0, import_jsx_runtime12.jsx)(ClientOnly, {
            fallback: pendingElement,
            children: (0, import_jsx_runtime12.jsx)(MatchInner, { match })
          }) : (0, import_jsx_runtime12.jsx)(MatchInner, { match })
        })
      })
    })
  }), (isServer ?? router.isServer) && route.parentRoute?.id === rootRouteId && router.options.scrollRestoration ? (0, import_jsx_runtime12.jsx)(ScrollRestoration, {}) : null] });
}
var MatchInner = React$112.memo(function MatchInnerImpl({ match }) {
  const router = useRouter();
  const routeId = match.routeId;
  const route = router.routesById[routeId];
  const key = React$112.useMemo(() => {
    const remountDeps = (route.options.remountDeps ?? router.options.defaultRemountDeps)?.({
      routeId,
      loaderDeps: match.loaderDeps,
      params: match._strictParams,
      search: match._strictSearch
    });
    return remountDeps ? JSON.stringify(remountDeps) : void 0;
  }, [
    routeId,
    match.loaderDeps,
    match._strictParams,
    match._strictSearch,
    route.options.remountDeps,
    router.options.defaultRemountDeps
  ]);
  const out = React$112.useMemo(() => {
    const Comp = route.options.component ?? router.options.defaultComponent;
    return Comp ? (0, import_jsx_runtime12.jsx)(Comp, {}, key) : (0, import_jsx_runtime12.jsx)(Outlet, {});
  }, [
    key,
    route.options.component,
    router.options.defaultComponent
  ]);
  if (match.status === "pending") {
    if (router.ssr && !canWrapInSuspense(router, route, match.ssr)) return out;
    if (router._tx) throw router._tx[5];
    return renderPending(router, route);
  }
  if (match.status === "notFound") return renderRouteNotFound(router, route, match.error);
  if (match.status === "error") {
    if (isServer ?? router.isServer) {
      const errorElement = (0, import_jsx_runtime12.jsx)((route.options.errorComponent ?? router.options.defaultErrorComponent) || ErrorComponent, {
        error: match.error,
        reset: void 0,
        info: { componentStack: "" }
      });
      return true ? wrapInNonRouteComponentContext(errorElement, "errorComponent") : errorElement;
    }
    throw match.error;
  }
  return out;
});
var Outlet = React$112.memo(function OutletImpl() {
  if (true) {
    const nonRouteComponent = React$112.useContext(nonRouteComponentContext);
    if (nonRouteComponent) console.warn(`Warning: An <Outlet /> was rendered inside a ${nonRouteComponent}. <Outlet /> should only be rendered inside a route component.`);
  }
  const router = useRouter();
  const routeId = React$112.useContext(matchContext);
  let parentGlobalNotFound;
  let parentNotFoundError;
  let childRouteId;
  if (isServer ?? router.isServer) {
    const matches = router.stores.matches.get();
    const parentIndex = matches.findIndex((match) => match.routeId === routeId);
    const parentMatch = matches[parentIndex];
    parentGlobalNotFound = !!parentMatch._notFound;
    parentNotFoundError = parentMatch.error;
    childRouteId = matches[parentIndex + 1]?.routeId;
  } else {
    const parentMatchStore = router.stores.getMatchStore(routeId);
    [parentGlobalNotFound, parentNotFoundError] = useStore(parentMatchStore, (match) => [!!match._notFound, match.error], outletMatchSelectionEqual);
    childRouteId = useStore(router.stores.ids, (ids) => {
      return ids[ids.indexOf(routeId) + 1];
    });
  }
  if (parentGlobalNotFound) return renderRouteNotFound(router, router.routesById[routeId], parentNotFoundError);
  if (!childRouteId) return null;
  const nextMatch = (0, import_jsx_runtime12.jsx)(Match, { routeId: childRouteId });
  if (routeId === rootRouteId) return (0, import_jsx_runtime12.jsx)(React$112.Suspense, {
    fallback: renderPending(router),
    children: nextMatch
  });
  return nextMatch;
});

// ../../node_modules/@tanstack/react-router/dist/esm/Transitioner.js
var React$113 = __toESM(require_react(), 1);
function settleOwner(owner, rendered) {
  const settle = owner[1];
  owner.length = 0;
  settle?.(rendered);
}
function Transitioner({ t }) {
  const router = useRouter();
  const acknowledgement = router._rendered ??= [];
  const mounted = true ? React$113.useRef(false) : void 0;
  router.startTransition = (fn, expected) => new Promise((resolve) => {
    settleOwner(acknowledgement, false);
    acknowledgement.push(expected, resolve);
    t(router);
    React$113.startTransition(fn);
  });
  useLayoutEffect2(() => {
    const unsub = router.history.subscribe(router.load);
    if (mounted?.current) return unsub;
    if (mounted) mounted.current = true;
    router.updateLatestLocation();
    const location = router.latestLocation;
    const nextLocation = router.buildLocation({
      to: location.pathname,
      search: true,
      params: true,
      hash: true,
      state: true,
      _includeValidateSearch: true
    });
    if (trimPathRight2(location.publicHref) !== trimPathRight2(nextLocation.publicHref)) {
      router.commitLocation({
        ...nextLocation,
        replace: true,
        ignoreBlocker: true
      });
      return unsub;
    }
    const resolvedLocation = router.stores.resolvedLocation.get();
    if (resolvedLocation?.href === location.href && resolvedLocation.state.__TSR_key === location.state.__TSR_key) acknowledgement.push(router.stores.matches.get(), (rendered) => {
      if (rendered) router.emit({
        type: "onRendered",
        ...getLocationChangeInfo(resolvedLocation, resolvedLocation)
      });
    });
    else if (!router._tx) router.load({ sync: true }).catch(console.error);
    return unsub;
  }, [router, router.history]);
  return null;
}

// ../../node_modules/@tanstack/react-router/dist/esm/Matches.js
var React$114 = __toESM(require_react(), 1);
var import_jsx_runtime13 = __toESM(require_jsx_runtime(), 1);
function Matches() {
  const router = useRouter();
  const rootRoute = router.routesById[rootRouteId];
  const pendingElement = renderPending(router, rootRoute);
  const ResolvedSuspense = (isServer ?? router.isServer) || router.ssr ? SafeFragment : React$114.Suspense;
  const inner = (0, import_jsx_runtime13.jsxs)(import_jsx_runtime13.Fragment, { children: [!(isServer ?? router.isServer) && (0, import_jsx_runtime13.jsx)(Transitioner, { t: React$114.useState()[1] }), (0, import_jsx_runtime13.jsx)(ResolvedSuspense, {
    fallback: pendingElement,
    children: (0, import_jsx_runtime13.jsx)(MatchesInner, {})
  })] });
  return router.options.InnerWrap ? (0, import_jsx_runtime13.jsx)(router.options.InnerWrap, { children: inner }) : inner;
}
function MatchesInner() {
  const router = useRouter();
  const acknowledgement = router._rendered;
  const matches = isServer ?? router.isServer ? router.stores.matches.get() : useStore(router.stores.matches, (value) => acknowledgement[0] ?? value);
  const match = matches[0];
  const routeId = match?.routeId;
  useLayoutEffect2(() => {
    if (acknowledgement[0] === matches) settleOwner(acknowledgement, true);
  }, [acknowledgement, matches]);
  const matchComponent = routeId ? (0, import_jsx_runtime13.jsx)(Match, { routeId }) : null;
  return (0, import_jsx_runtime13.jsx)(matchContext.Provider, {
    value: routeId,
    children: router.options.disableGlobalCatchBoundary ? matchComponent : (0, import_jsx_runtime13.jsx)(CatchBoundary, {
      getResetKey: () => match,
      onCatch: true ? (error) => {
        console.warn(`Warning: The following error wasn't caught by any route! At the very least, consider setting an 'errorComponent' in your RootRoute!`);
        console.warn(`Warning: ${error.message || error.toString()}`);
      } : void 0,
      children: matchComponent
    })
  });
}
function useMatchRoute() {
  const router = useRouter();
  if (isServer ?? router.isServer) return (opts) => {
    const { pending, caseSensitive, fuzzy, includeSearch, ...rest } = opts;
    return router.matchRoute(rest, {
      pending,
      caseSensitive,
      fuzzy,
      includeSearch
    });
  };
  return React$114.useCallback((opts) => {
    const { pending, caseSensitive, fuzzy, includeSearch, ...rest } = opts;
    return router.matchRoute(rest, {
      pending,
      caseSensitive,
      fuzzy,
      includeSearch
    });
  }, [
    router,
    useStore(router.stores.location, (location) => location.href),
    useStore(router.stores.resolvedLocation, (location) => location?.href),
    useStore(router.stores.status, (status) => status)
  ]);
}
function MatchRoute(props) {
  const params = useMatchRoute()(props);
  if (typeof props.children === "function") return props.children(params);
  return params ? props.children : null;
}
function useMatches(opts) {
  const router = useRouter();
  if (isServer ?? router.isServer) {
    const matches = router.stores.matches.get();
    return opts?.select ? opts.select(matches) : matches;
  }
  return useStore(router.stores.matches, useStructuralSharing(opts, router));
}
function useParentMatches(opts) {
  const contextRouteId = React$114.useContext(matchContext);
  return useMatches({
    select: (matches) => {
      matches = matches.slice(0, matches.findIndex((d) => d.routeId === contextRouteId));
      return opts?.select ? opts.select(matches) : matches;
    },
    structuralSharing: opts?.structuralSharing
  });
}
function useChildMatches(opts) {
  const contextRouteId = React$114.useContext(matchContext);
  return useMatches({
    select: (matches) => {
      matches = matches.slice(matches.findIndex((d) => d.routeId === contextRouteId) + 1);
      return opts?.select ? opts.select(matches) : matches;
    },
    structuralSharing: opts?.structuralSharing
  });
}

// ../../node_modules/@tanstack/react-router/dist/esm/routerStores.js
var getStoreFactory = (opts) => {
  if (isServer ?? opts.isServer) return {
    createMutableStore: createNonReactiveMutableStore,
    createReadonlyStore: createNonReactiveReadonlyStore,
    batch: (fn) => fn()
  };
  return {
    createMutableStore: createAtom,
    createReadonlyStore: createAtom,
    batch
  };
};

// ../../node_modules/@tanstack/react-router/dist/esm/router.js
var createRouter = (options) => {
  return new Router(options);
};
var Router = class extends RouterCore {
  constructor(options) {
    super(options, getStoreFactory);
  }
};

// ../../node_modules/@tanstack/react-router/dist/esm/RouterProvider.js
var import_react7 = __toESM(require_react(), 1);
var import_jsx_runtime14 = __toESM(require_jsx_runtime(), 1);
function RouterContextProvider({ router, children, ...rest }) {
  if (hasKeys(rest)) router.update({
    ...router.options,
    ...rest,
    context: {
      ...router.options.context,
      ...rest.context
    }
  });
  const provider = (0, import_jsx_runtime14.jsx)(routerContext.Provider, {
    value: router,
    children
  });
  if (router.options.Wrap) return (0, import_jsx_runtime14.jsx)(router.options.Wrap, { children: provider });
  return provider;
}
function RouterProvider({ router, ...rest }) {
  return (0, import_jsx_runtime14.jsx)(RouterContextProvider, {
    router,
    ...rest,
    children: (0, import_jsx_runtime14.jsx)(Matches, {})
  });
}

// ../../node_modules/@tanstack/react-router/dist/esm/ScrollRestoration.js
function useScrollRestoration() {
  setupScrollRestoration(useRouter(), true);
}
function ScrollRestoration2(_props) {
  useScrollRestoration();
  if (true) console.warn("The ScrollRestoration component is deprecated. Use createRouter's `scrollRestoration` option instead.");
  return null;
}
function useElementScrollRestoration(options) {
  useScrollRestoration();
  return getElementScrollRestorationEntry(useRouter(), options);
}

// ../../node_modules/@tanstack/react-router/dist/esm/useBlocker.js
var React$115 = __toESM(require_react(), 1);
function _resolveBlockerOpts(opts, condition) {
  if (opts === void 0) return {
    shouldBlockFn: () => true,
    withResolver: false
  };
  if ("shouldBlockFn" in opts) return opts;
  if (typeof opts === "function") {
    const shouldBlock2 = Boolean(condition ?? true);
    const _customBlockerFn2 = async () => {
      if (shouldBlock2) return await opts();
      return false;
    };
    return {
      shouldBlockFn: _customBlockerFn2,
      enableBeforeUnload: shouldBlock2,
      withResolver: false
    };
  }
  const shouldBlock = Boolean(opts.condition ?? true);
  const fn = opts.blockerFn;
  const _customBlockerFn = async () => {
    if (shouldBlock && fn !== void 0) return await fn();
    return shouldBlock;
  };
  return {
    shouldBlockFn: _customBlockerFn,
    enableBeforeUnload: shouldBlock,
    withResolver: fn === void 0
  };
}
function useBlocker(opts, condition) {
  const { shouldBlockFn, enableBeforeUnload = true, disabled = false, withResolver = false } = _resolveBlockerOpts(opts, condition);
  const router = useRouter();
  const { history: history2 } = router;
  const [resolver, setResolver] = React$115.useState({
    status: "idle",
    current: void 0,
    next: void 0,
    action: void 0,
    proceed: void 0,
    reset: void 0
  });
  React$115.useEffect(() => {
    const blockerFnComposed = async (blockerFnArgs) => {
      function getLocation(location) {
        const parsedLocation = router.parseLocation(location);
        const [, rawParams, foundRoute] = router.getMatchedRoutes(parsedLocation.pathname);
        if (foundRoute === void 0) return {
          routeId: "__notFound__",
          fullPath: parsedLocation.pathname,
          pathname: parsedLocation.pathname,
          params: rawParams,
          search: router.options.parseSearch(location.search)
        };
        return {
          routeId: foundRoute.id,
          fullPath: foundRoute.fullPath,
          pathname: parsedLocation.pathname,
          params: rawParams,
          search: router.options.parseSearch(location.search)
        };
      }
      const current = getLocation(blockerFnArgs.currentLocation);
      const next = getLocation(blockerFnArgs.nextLocation);
      if (current.routeId === "__notFound__" && next.routeId !== "__notFound__") return false;
      const shouldBlock = await shouldBlockFn({
        action: blockerFnArgs.action,
        current,
        next
      });
      if (!withResolver) return shouldBlock;
      if (!shouldBlock) return false;
      const canNavigateAsync = await new Promise((resolve) => {
        setResolver({
          status: "blocked",
          current,
          next,
          action: blockerFnArgs.action,
          proceed: () => resolve(false),
          reset: () => resolve(true)
        });
      });
      setResolver({
        status: "idle",
        current: void 0,
        next: void 0,
        action: void 0,
        proceed: void 0,
        reset: void 0
      });
      return canNavigateAsync;
    };
    return disabled ? void 0 : history2.block({
      blockerFn: blockerFnComposed,
      enableBeforeUnload
    });
  }, [
    shouldBlockFn,
    enableBeforeUnload,
    disabled,
    withResolver,
    history2,
    router
  ]);
  return resolver;
}
var _resolvePromptBlockerArgs = (props) => {
  if ("shouldBlockFn" in props) return { ...props };
  const shouldBlock = Boolean(props.condition ?? true);
  const fn = props.blockerFn;
  const _customBlockerFn = async () => {
    if (shouldBlock && fn !== void 0) return await fn();
    return shouldBlock;
  };
  return {
    shouldBlockFn: _customBlockerFn,
    enableBeforeUnload: shouldBlock,
    withResolver: fn === void 0
  };
};
function Block(opts) {
  const { children, ...rest } = opts;
  const resolver = useBlocker(_resolvePromptBlockerArgs(rest));
  return children ? typeof children === "function" ? children(resolver) : children : null;
}

// ../../node_modules/@tanstack/react-router/dist/esm/useRouterState.js
function useRouterState(opts) {
  const contextRouter = useRouter({ warn: opts?.router === void 0 });
  const router = opts?.router || contextRouter;
  if (isServer ?? router.isServer) {
    const state = router.stores.__store.get();
    return opts?.select ? opts.select(state) : state;
  }
  return useStore(router.stores.__store, useStructuralSharing(opts, router));
}

// ../../node_modules/@tanstack/react-router/dist/esm/useLocation.js
function useLocation(opts) {
  const router = useRouter();
  if (isServer ?? router.isServer) {
    const location = router.stores.location.get();
    return opts?.select ? opts.select(location) : location;
  }
  return useStore(router.stores.location, useStructuralSharing(opts, router));
}

// ../../node_modules/@tanstack/react-router/dist/esm/useCanGoBack.js
function useCanGoBack() {
  const router = useRouter();
  if (isServer ?? router.isServer) return router.stores.location.get().state.__TSR_index !== 0;
  return useStore(router.stores.location, (location) => location.state.__TSR_index !== 0);
}

// ../../node_modules/@tanstack/react-router/dist/esm/Asset.js
var React$116 = __toESM(require_react(), 1);
var import_jsx_runtime15 = __toESM(require_jsx_runtime(), 1);
var INLINE_CSS_HYDRATION_ATTR = "data-tsr-inline-css";
var noopScriptHandler = () => {
};
function setScriptAttrs(script, attrs) {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) if (key !== "suppressHydrationWarning" && value !== void 0 && value !== false) script.setAttribute(key, typeof value === "boolean" ? "" : String(value));
}
function Asset(asset) {
  const { attrs, children, nonce, preventScriptHoist } = asset;
  switch (asset.tag) {
    case "title":
      return (0, import_jsx_runtime15.jsx)("title", {
        ...attrs,
        suppressHydrationWarning: true,
        children
      });
    case "meta":
      return (0, import_jsx_runtime15.jsx)("meta", {
        ...attrs,
        suppressHydrationWarning: true
      });
    case "link":
      return (0, import_jsx_runtime15.jsx)("link", {
        ...attrs,
        precedence: attrs?.precedence ?? (attrs?.rel === "stylesheet" ? "default" : void 0),
        nonce,
        suppressHydrationWarning: true
      });
    case "style":
      if (asset.inlineCss && (process.env.TSS_INLINE_CSS_ENABLED === "true" || process.env.TSS_INLINE_CSS_ENABLED === void 0 && isServer)) return (0, import_jsx_runtime15.jsx)(InlineCssStyle, {
        attrs,
        nonce,
        children
      });
      return (0, import_jsx_runtime15.jsx)("style", {
        ...attrs,
        dangerouslySetInnerHTML: { __html: children },
        nonce
      });
    case "script":
      return (0, import_jsx_runtime15.jsx)(Script, {
        attrs,
        preventScriptHoist,
        children
      });
    default:
      return null;
  }
}
function InlineCssStyle({ attrs, children, nonce }) {
  const isInlineCssPlaceholder = children === void 0;
  const [hydratedInlineCss] = React$116.useState(() => {
    if (!isInlineCssPlaceholder || typeof document === "undefined") return;
    return document.querySelector(`style[${INLINE_CSS_HYDRATION_ATTR}]`)?.textContent ?? void 0;
  });
  const html = isInlineCssPlaceholder ? hydratedInlineCss ?? "" : children ?? "";
  return (0, import_jsx_runtime15.jsx)("style", {
    ...attrs,
    [INLINE_CSS_HYDRATION_ATTR]: "",
    dangerouslySetInnerHTML: { __html: html },
    nonce,
    suppressHydrationWarning: true
  });
}
function Script({ attrs, children, preventScriptHoist }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const dataScript = typeof attrs?.type === "string" && attrs.type !== "" && attrs.type !== "text/javascript" && attrs.type !== "module";
  if (attrs?.src && typeof children === "string" && children.trim().length) console.warn("[TanStack Router] <Script> received both `src` and `children`. The `children` content will be ignored. Remove `children` or remove `src`.");
  React$116.useEffect(() => {
    if (dataScript) return;
    if (attrs?.src) {
      const normSrc = (() => {
        try {
          const base = document.baseURI || window.location.href;
          return new URL(attrs.src, base).href;
        } catch {
          return attrs.src;
        }
      })();
      for (const el of document.querySelectorAll("script[src]")) if (el.src === normSrc) return;
      const script = document.createElement("script");
      setScriptAttrs(script, attrs);
      document.head.appendChild(script);
      return () => script.remove();
    }
    if (typeof children === "string") {
      const typeAttr = typeof attrs?.type === "string" ? attrs.type : "text/javascript";
      const nonceAttr = typeof attrs?.nonce === "string" ? attrs.nonce : void 0;
      for (const el of document.querySelectorAll("script:not([src])")) {
        if (!(el instanceof HTMLScriptElement)) continue;
        const sType = el.getAttribute("type") ?? "text/javascript";
        const sNonce = el.getAttribute("nonce") ?? void 0;
        if (el.textContent === children && sType === typeAttr && sNonce === nonceAttr) return;
      }
      const script = document.createElement("script");
      script.textContent = children;
      setScriptAttrs(script, attrs);
      document.head.appendChild(script);
      return () => script.remove();
    }
  }, [
    attrs,
    children,
    dataScript
  ]);
  if (isServer ?? router.isServer) {
    if (attrs?.src) {
      if (!preventScriptHoist) return (0, import_jsx_runtime15.jsx)("script", {
        ...attrs,
        suppressHydrationWarning: true
      });
      return (0, import_jsx_runtime15.jsx)("script", {
        ...attrs,
        onLoad: noopScriptHandler,
        suppressHydrationWarning: true
      });
    }
    if (typeof children === "string") return (0, import_jsx_runtime15.jsx)("script", {
      ...attrs,
      dangerouslySetInnerHTML: { __html: children },
      suppressHydrationWarning: true
    });
    return null;
  }
  if (dataScript && typeof children === "string") return (0, import_jsx_runtime15.jsx)("script", {
    ...attrs,
    suppressHydrationWarning: true,
    dangerouslySetInnerHTML: { __html: children }
  });
  if (!hydrated) {
    if (attrs?.src) return (0, import_jsx_runtime15.jsx)("script", {
      ...attrs,
      suppressHydrationWarning: true
    });
    if (typeof children === "string") return (0, import_jsx_runtime15.jsx)("script", {
      ...attrs,
      dangerouslySetInnerHTML: { __html: children },
      suppressHydrationWarning: true
    });
  }
  return null;
}

// ../../node_modules/@tanstack/react-router/dist/esm/headContentUtils.js
var React$117 = __toESM(require_react(), 1);
function buildTagsFromMatches(router, nonce, matches, assetCrossOrigin) {
  matches = _getAssetMatches(matches);
  const routeMeta = matches.map((match) => match.meta).filter((meta) => meta !== void 0);
  const resultMeta = [];
  const metaByAttribute = {};
  let title;
  for (let i = routeMeta.length - 1; i >= 0; i--) {
    const metas = routeMeta[i];
    for (let j = metas.length - 1; j >= 0; j--) {
      const m = metas[j];
      if (!m) continue;
      if (m.title) {
        if (!title) title = {
          tag: "title",
          children: m.title
        };
      } else if ("script:ld+json" in m) try {
        const json = JSON.stringify(m["script:ld+json"]);
        resultMeta.push({
          tag: "script",
          attrs: { type: "application/ld+json" },
          children: escapeHtml(json)
        });
      } catch {
      }
      else {
        const attribute = m.name ?? m.property;
        if (attribute) if (metaByAttribute[attribute]) continue;
        else metaByAttribute[attribute] = true;
        resultMeta.push({
          tag: "meta",
          attrs: {
            ...m,
            nonce
          }
        });
      }
    }
  }
  if (title) resultMeta.push(title);
  if (nonce) resultMeta.push({
    tag: "meta",
    attrs: {
      property: "csp-nonce",
      content: nonce
    }
  });
  resultMeta.reverse();
  const constructedLinks = matches.flatMap((match) => match.links ?? []).filter((link2) => link2 !== void 0).map((link2) => ({
    tag: "link",
    attrs: {
      ...link2,
      nonce
    }
  }));
  const manifest = router.ssr?.manifest;
  const manifestCssTags = [];
  if (manifest) {
    matches.forEach((match) => {
      manifest.routes[match.routeId]?.css?.forEach((link2) => {
        const resolvedLink = resolveManifestCssLink(link2);
        manifestCssTags.push({
          tag: "link",
          attrs: {
            rel: "stylesheet",
            ...resolvedLink,
            crossOrigin: getAssetCrossOrigin(assetCrossOrigin, "stylesheet") ?? resolvedLink.crossOrigin,
            suppressHydrationWarning: true,
            nonce
          }
        });
      });
    });
    if (manifest.inlineStyle) manifestCssTags.push({
      tag: "style",
      attrs: {
        ...manifest.inlineStyle.attrs,
        nonce
      },
      children: manifest.inlineStyle.children,
      inlineCss: true
    });
  }
  const preloadLinks = [];
  if (manifest) matches.forEach((match) => {
    manifest.routes[match.routeId]?.preloads?.forEach((preload) => {
      preloadLinks.push({
        tag: "link",
        attrs: {
          ...getScriptPreloadAttrs(manifest, preload, assetCrossOrigin),
          nonce
        }
      });
    });
  });
  const styles = matches.flatMap((match) => match.styles ?? []).filter((style) => style !== void 0).map(({ children, ...attrs }) => ({
    tag: "style",
    attrs: {
      ...attrs,
      nonce
    },
    children
  }));
  const headScripts = matches.flatMap((match) => match.headScripts ?? []).filter((script) => script !== void 0).map(({ children, ...script }) => ({
    tag: "script",
    attrs: {
      ...script,
      nonce
    },
    children
  }));
  const tags = [];
  appendUniqueUserTags(tags, resultMeta);
  tags.push(...preloadLinks);
  appendUniqueUserTags(tags, constructedLinks);
  tags.push(...manifestCssTags);
  appendUniqueUserTags(tags, styles);
  appendUniqueUserTags(tags, headScripts);
  return tags;
}
var useTags = (assetCrossOrigin) => {
  const router = useRouter();
  const nonce = router.options.ssr?.nonce;
  if (isServer ?? router.isServer) return buildTagsFromMatches(router, nonce, router.stores.matches.get(), assetCrossOrigin);
  const selectTags = React$117.useCallback((matches) => buildTagsFromMatches(router, nonce, matches, assetCrossOrigin), [
    assetCrossOrigin,
    nonce,
    router
  ]);
  return useStore(router.stores.matches, selectTags, deepEqual);
};

// ../../node_modules/@tanstack/react-router/dist/esm/Scripts.js
var import_react8 = __toESM(require_react(), 1);
var import_jsx_runtime16 = __toESM(require_jsx_runtime(), 1);
var Scripts = () => {
  const router = useRouter();
  const nonce = router.options.ssr?.nonce;
  const getScripts = (matches) => {
    matches = _getAssetMatches(matches);
    const scripts = matches.flatMap((match) => match.scripts ?? []).filter(Boolean).map(({ children, ...script }) => ({
      tag: "script",
      attrs: {
        ...script,
        suppressHydrationWarning: true,
        nonce
      },
      children
    }));
    const manifest = router.ssr?.manifest;
    if (!manifest) return scripts;
    for (const match of matches) {
      const manifestScripts = manifest.routes[match.routeId]?.scripts;
      if (!manifestScripts) continue;
      for (const asset of manifestScripts) scripts.push({
        tag: "script",
        attrs: {
          ...asset.attrs,
          nonce
        },
        children: asset.children,
        ...typeof asset.attrs?.src === "string" ? { preventScriptHoist: true } : {}
      });
    }
    return scripts;
  };
  if (isServer ?? router.isServer) return renderScripts(router, getScripts(router.stores.matches.get()));
  return renderScripts(router, useStore(router.stores.matches, getScripts, deepEqual));
};
function renderScripts(router, scripts) {
  if ((isServer ?? router.isServer) && router.serverSsr) {
    const serverBufferedScript = router.serverSsr.takeBufferedScripts();
    if (serverBufferedScript) scripts.unshift(serverBufferedScript);
  }
  return (0, import_jsx_runtime16.jsx)(import_jsx_runtime16.Fragment, { children: scripts.map((asset, i) => (0, import_react8.createElement)(Asset, {
    ...asset,
    key: `tsr-scripts-${asset.tag}-${i}`
  })) });
}

// ../../node_modules/@tanstack/react-router/dist/esm/HeadContent.js
var import_react9 = __toESM(require_react(), 1);
var import_jsx_runtime17 = __toESM(require_jsx_runtime(), 1);

// ../../node_modules/@tanstack/react-router/dist/esm/HeadContent.dev.js
var React$118 = __toESM(require_react(), 1);
var import_react10 = __toESM(require_react(), 1);
var import_jsx_runtime18 = __toESM(require_jsx_runtime(), 1);
function HeadContent2(props) {
  const tags = useTags(props.assetCrossOrigin);
  const nonce = useRouter().options.ssr?.nonce;
  const hydrated = useHydrated();
  React$118.useEffect(() => {
    if (hydrated) document.querySelectorAll(`link[${DEV_STYLES_ATTR}]`).forEach((el) => el.remove());
  }, [hydrated]);
  return (0, import_jsx_runtime18.jsx)(import_jsx_runtime18.Fragment, { children: (hydrated ? tags.filter((tag) => tag.tag !== "link" || tag.attrs?.[DEV_STYLES_ATTR] !== true) : tags).map((tag) => (0, import_react10.createElement)(Asset, {
    ...tag,
    key: `tsr-meta-${JSON.stringify(tag)}`,
    nonce
  })) });
}
export {
  Asset,
  Await,
  Block,
  CatchBoundary,
  CatchNotFound,
  ClientOnly,
  DEFAULT_PROTOCOL_ALLOWLIST,
  DefaultGlobalNotFound,
  ErrorComponent,
  FileRoute,
  FileRouteLoader,
  HeadContent2 as HeadContent,
  LazyRoute,
  Link,
  Match,
  MatchRoute,
  Matches,
  Navigate,
  NotFoundRoute,
  Outlet,
  RootRoute,
  Route,
  RouteApi,
  Router,
  RouterContextProvider,
  RouterProvider,
  ScriptOnce,
  Scripts,
  ScrollRestoration2 as ScrollRestoration,
  SearchParamError,
  cleanPath,
  composeRewrites,
  createBrowserHistory,
  createControlledPromise,
  createFileRoute,
  createHashHistory,
  createHistory,
  createLazyFileRoute,
  createLazyRoute,
  createLink,
  createMemoryHistory,
  createRootRoute,
  createRootRouteWithContext,
  createRoute,
  createRouteMask,
  createRouter,
  createRouterConfig,
  createSerializationAdapter,
  deepEqual,
  defaultParseSearch,
  defaultStringifySearch,
  defer,
  functionalUpdate,
  getRouteApi,
  interpolatePath,
  isMatch,
  isNotFound,
  isPlainArray,
  isPlainObject,
  isRedirect,
  joinPaths,
  lazyFn,
  lazyRouteComponent,
  linkOptions,
  notFound,
  parseSearchWith,
  reactUse,
  redirect,
  replaceEqualDeep,
  resolvePath,
  retainSearchParams,
  rootRouteId,
  rootRouteWithContext,
  stringifySearchWith,
  stripSearchParams,
  trimPath,
  trimPathLeft,
  trimPathRight2 as trimPathRight,
  useAwaited,
  useBlocker,
  useCanGoBack,
  useChildMatches,
  useElementScrollRestoration,
  useHydrated,
  useLayoutEffect2 as useLayoutEffect,
  useLinkProps,
  useLoaderData,
  useLoaderDeps,
  useLocation,
  useMatch,
  useMatchRoute,
  useMatches,
  useNavigate,
  useParams,
  useParentMatches,
  useRouteContext,
  useRouter,
  useRouterState,
  useSearch,
  useTags
};
//# sourceMappingURL=@tanstack_react-router.js.map
