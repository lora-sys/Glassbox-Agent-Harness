import {
  __commonJS,
  __export,
  __toESM
} from "./chunk-QKQ6FTX6.js";

// ../../node_modules/lodash.isequal/index.js
var require_lodash = __commonJS({
  "../../node_modules/lodash.isequal/index.js"(exports, module) {
    var LARGE_ARRAY_SIZE = 200;
    var HASH_UNDEFINED = "__lodash_hash_undefined__";
    var COMPARE_PARTIAL_FLAG = 1;
    var COMPARE_UNORDERED_FLAG = 2;
    var MAX_SAFE_INTEGER = 9007199254740991;
    var argsTag = "[object Arguments]";
    var arrayTag = "[object Array]";
    var asyncTag = "[object AsyncFunction]";
    var boolTag = "[object Boolean]";
    var dateTag = "[object Date]";
    var errorTag = "[object Error]";
    var funcTag = "[object Function]";
    var genTag = "[object GeneratorFunction]";
    var mapTag = "[object Map]";
    var numberTag = "[object Number]";
    var nullTag = "[object Null]";
    var objectTag = "[object Object]";
    var promiseTag = "[object Promise]";
    var proxyTag = "[object Proxy]";
    var regexpTag = "[object RegExp]";
    var setTag = "[object Set]";
    var stringTag = "[object String]";
    var symbolTag = "[object Symbol]";
    var undefinedTag = "[object Undefined]";
    var weakMapTag = "[object WeakMap]";
    var arrayBufferTag = "[object ArrayBuffer]";
    var dataViewTag = "[object DataView]";
    var float32Tag = "[object Float32Array]";
    var float64Tag = "[object Float64Array]";
    var int8Tag = "[object Int8Array]";
    var int16Tag = "[object Int16Array]";
    var int32Tag = "[object Int32Array]";
    var uint8Tag = "[object Uint8Array]";
    var uint8ClampedTag = "[object Uint8ClampedArray]";
    var uint16Tag = "[object Uint16Array]";
    var uint32Tag = "[object Uint32Array]";
    var reRegExpChar = /[\\^$.*+?()[\]{}|]/g;
    var reIsHostCtor = /^\[object .+?Constructor\]$/;
    var reIsUint = /^(?:0|[1-9]\d*)$/;
    var typedArrayTags = {};
    typedArrayTags[float32Tag] = typedArrayTags[float64Tag] = typedArrayTags[int8Tag] = typedArrayTags[int16Tag] = typedArrayTags[int32Tag] = typedArrayTags[uint8Tag] = typedArrayTags[uint8ClampedTag] = typedArrayTags[uint16Tag] = typedArrayTags[uint32Tag] = true;
    typedArrayTags[argsTag] = typedArrayTags[arrayTag] = typedArrayTags[arrayBufferTag] = typedArrayTags[boolTag] = typedArrayTags[dataViewTag] = typedArrayTags[dateTag] = typedArrayTags[errorTag] = typedArrayTags[funcTag] = typedArrayTags[mapTag] = typedArrayTags[numberTag] = typedArrayTags[objectTag] = typedArrayTags[regexpTag] = typedArrayTags[setTag] = typedArrayTags[stringTag] = typedArrayTags[weakMapTag] = false;
    var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
    var freeSelf = typeof self == "object" && self && self.Object === Object && self;
    var root = freeGlobal || freeSelf || Function("return this")();
    var freeExports = typeof exports == "object" && exports && !exports.nodeType && exports;
    var freeModule = freeExports && typeof module == "object" && module && !module.nodeType && module;
    var moduleExports = freeModule && freeModule.exports === freeExports;
    var freeProcess = moduleExports && freeGlobal.process;
    var nodeUtil = (function() {
      try {
        return freeProcess && freeProcess.binding && freeProcess.binding("util");
      } catch (e) {
      }
    })();
    var nodeIsTypedArray = nodeUtil && nodeUtil.isTypedArray;
    function arrayFilter(array2, predicate) {
      var index = -1, length = array2 == null ? 0 : array2.length, resIndex = 0, result = [];
      while (++index < length) {
        var value = array2[index];
        if (predicate(value, index, array2)) {
          result[resIndex++] = value;
        }
      }
      return result;
    }
    function arrayPush(array2, values) {
      var index = -1, length = values.length, offset = array2.length;
      while (++index < length) {
        array2[offset + index] = values[index];
      }
      return array2;
    }
    function arraySome(array2, predicate) {
      var index = -1, length = array2 == null ? 0 : array2.length;
      while (++index < length) {
        if (predicate(array2[index], index, array2)) {
          return true;
        }
      }
      return false;
    }
    function baseTimes(n, iteratee) {
      var index = -1, result = Array(n);
      while (++index < n) {
        result[index] = iteratee(index);
      }
      return result;
    }
    function baseUnary(func) {
      return function(value) {
        return func(value);
      };
    }
    function cacheHas(cache, key) {
      return cache.has(key);
    }
    function getValue(object2, key) {
      return object2 == null ? void 0 : object2[key];
    }
    function mapToArray(map) {
      var index = -1, result = Array(map.size);
      map.forEach(function(value, key) {
        result[++index] = [key, value];
      });
      return result;
    }
    function overArg(func, transform) {
      return function(arg) {
        return func(transform(arg));
      };
    }
    function setToArray(set) {
      var index = -1, result = Array(set.size);
      set.forEach(function(value) {
        result[++index] = value;
      });
      return result;
    }
    var arrayProto = Array.prototype;
    var funcProto = Function.prototype;
    var objectProto = Object.prototype;
    var coreJsData = root["__core-js_shared__"];
    var funcToString = funcProto.toString;
    var hasOwnProperty2 = objectProto.hasOwnProperty;
    var maskSrcKey = (function() {
      var uid = /[^.]+$/.exec(coreJsData && coreJsData.keys && coreJsData.keys.IE_PROTO || "");
      return uid ? "Symbol(src)_1." + uid : "";
    })();
    var nativeObjectToString = objectProto.toString;
    var reIsNative = RegExp(
      "^" + funcToString.call(hasOwnProperty2).replace(reRegExpChar, "\\$&").replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, "$1.*?") + "$"
    );
    var Buffer2 = moduleExports ? root.Buffer : void 0;
    var Symbol2 = root.Symbol;
    var Uint8Array2 = root.Uint8Array;
    var propertyIsEnumerable = objectProto.propertyIsEnumerable;
    var splice = arrayProto.splice;
    var symToStringTag = Symbol2 ? Symbol2.toStringTag : void 0;
    var nativeGetSymbols = Object.getOwnPropertySymbols;
    var nativeIsBuffer = Buffer2 ? Buffer2.isBuffer : void 0;
    var nativeKeys = overArg(Object.keys, Object);
    var DataView2 = getNative(root, "DataView");
    var Map2 = getNative(root, "Map");
    var Promise2 = getNative(root, "Promise");
    var Set2 = getNative(root, "Set");
    var WeakMap2 = getNative(root, "WeakMap");
    var nativeCreate = getNative(Object, "create");
    var dataViewCtorString = toSource(DataView2);
    var mapCtorString = toSource(Map2);
    var promiseCtorString = toSource(Promise2);
    var setCtorString = toSource(Set2);
    var weakMapCtorString = toSource(WeakMap2);
    var symbolProto = Symbol2 ? Symbol2.prototype : void 0;
    var symbolValueOf = symbolProto ? symbolProto.valueOf : void 0;
    function Hash(entries) {
      var index = -1, length = entries == null ? 0 : entries.length;
      this.clear();
      while (++index < length) {
        var entry2 = entries[index];
        this.set(entry2[0], entry2[1]);
      }
    }
    function hashClear() {
      this.__data__ = nativeCreate ? nativeCreate(null) : {};
      this.size = 0;
    }
    function hashDelete(key) {
      var result = this.has(key) && delete this.__data__[key];
      this.size -= result ? 1 : 0;
      return result;
    }
    function hashGet(key) {
      var data = this.__data__;
      if (nativeCreate) {
        var result = data[key];
        return result === HASH_UNDEFINED ? void 0 : result;
      }
      return hasOwnProperty2.call(data, key) ? data[key] : void 0;
    }
    function hashHas(key) {
      var data = this.__data__;
      return nativeCreate ? data[key] !== void 0 : hasOwnProperty2.call(data, key);
    }
    function hashSet(key, value) {
      var data = this.__data__;
      this.size += this.has(key) ? 0 : 1;
      data[key] = nativeCreate && value === void 0 ? HASH_UNDEFINED : value;
      return this;
    }
    Hash.prototype.clear = hashClear;
    Hash.prototype["delete"] = hashDelete;
    Hash.prototype.get = hashGet;
    Hash.prototype.has = hashHas;
    Hash.prototype.set = hashSet;
    function ListCache(entries) {
      var index = -1, length = entries == null ? 0 : entries.length;
      this.clear();
      while (++index < length) {
        var entry2 = entries[index];
        this.set(entry2[0], entry2[1]);
      }
    }
    function listCacheClear() {
      this.__data__ = [];
      this.size = 0;
    }
    function listCacheDelete(key) {
      var data = this.__data__, index = assocIndexOf(data, key);
      if (index < 0) {
        return false;
      }
      var lastIndex = data.length - 1;
      if (index == lastIndex) {
        data.pop();
      } else {
        splice.call(data, index, 1);
      }
      --this.size;
      return true;
    }
    function listCacheGet(key) {
      var data = this.__data__, index = assocIndexOf(data, key);
      return index < 0 ? void 0 : data[index][1];
    }
    function listCacheHas(key) {
      return assocIndexOf(this.__data__, key) > -1;
    }
    function listCacheSet(key, value) {
      var data = this.__data__, index = assocIndexOf(data, key);
      if (index < 0) {
        ++this.size;
        data.push([key, value]);
      } else {
        data[index][1] = value;
      }
      return this;
    }
    ListCache.prototype.clear = listCacheClear;
    ListCache.prototype["delete"] = listCacheDelete;
    ListCache.prototype.get = listCacheGet;
    ListCache.prototype.has = listCacheHas;
    ListCache.prototype.set = listCacheSet;
    function MapCache(entries) {
      var index = -1, length = entries == null ? 0 : entries.length;
      this.clear();
      while (++index < length) {
        var entry2 = entries[index];
        this.set(entry2[0], entry2[1]);
      }
    }
    function mapCacheClear() {
      this.size = 0;
      this.__data__ = {
        "hash": new Hash(),
        "map": new (Map2 || ListCache)(),
        "string": new Hash()
      };
    }
    function mapCacheDelete(key) {
      var result = getMapData(this, key)["delete"](key);
      this.size -= result ? 1 : 0;
      return result;
    }
    function mapCacheGet(key) {
      return getMapData(this, key).get(key);
    }
    function mapCacheHas(key) {
      return getMapData(this, key).has(key);
    }
    function mapCacheSet(key, value) {
      var data = getMapData(this, key), size = data.size;
      data.set(key, value);
      this.size += data.size == size ? 0 : 1;
      return this;
    }
    MapCache.prototype.clear = mapCacheClear;
    MapCache.prototype["delete"] = mapCacheDelete;
    MapCache.prototype.get = mapCacheGet;
    MapCache.prototype.has = mapCacheHas;
    MapCache.prototype.set = mapCacheSet;
    function SetCache(values) {
      var index = -1, length = values == null ? 0 : values.length;
      this.__data__ = new MapCache();
      while (++index < length) {
        this.add(values[index]);
      }
    }
    function setCacheAdd(value) {
      this.__data__.set(value, HASH_UNDEFINED);
      return this;
    }
    function setCacheHas(value) {
      return this.__data__.has(value);
    }
    SetCache.prototype.add = SetCache.prototype.push = setCacheAdd;
    SetCache.prototype.has = setCacheHas;
    function Stack(entries) {
      var data = this.__data__ = new ListCache(entries);
      this.size = data.size;
    }
    function stackClear() {
      this.__data__ = new ListCache();
      this.size = 0;
    }
    function stackDelete(key) {
      var data = this.__data__, result = data["delete"](key);
      this.size = data.size;
      return result;
    }
    function stackGet(key) {
      return this.__data__.get(key);
    }
    function stackHas(key) {
      return this.__data__.has(key);
    }
    function stackSet(key, value) {
      var data = this.__data__;
      if (data instanceof ListCache) {
        var pairs = data.__data__;
        if (!Map2 || pairs.length < LARGE_ARRAY_SIZE - 1) {
          pairs.push([key, value]);
          this.size = ++data.size;
          return this;
        }
        data = this.__data__ = new MapCache(pairs);
      }
      data.set(key, value);
      this.size = data.size;
      return this;
    }
    Stack.prototype.clear = stackClear;
    Stack.prototype["delete"] = stackDelete;
    Stack.prototype.get = stackGet;
    Stack.prototype.has = stackHas;
    Stack.prototype.set = stackSet;
    function arrayLikeKeys(value, inherited) {
      var isArr = isArray(value), isArg = !isArr && isArguments(value), isBuff = !isArr && !isArg && isBuffer(value), isType = !isArr && !isArg && !isBuff && isTypedArray(value), skipIndexes = isArr || isArg || isBuff || isType, result = skipIndexes ? baseTimes(value.length, String) : [], length = result.length;
      for (var key in value) {
        if ((inherited || hasOwnProperty2.call(value, key)) && !(skipIndexes && // Safari 9 has enumerable `arguments.length` in strict mode.
        (key == "length" || // Node.js 0.10 has enumerable non-index properties on buffers.
        isBuff && (key == "offset" || key == "parent") || // PhantomJS 2 has enumerable non-index properties on typed arrays.
        isType && (key == "buffer" || key == "byteLength" || key == "byteOffset") || // Skip index properties.
        isIndex(key, length)))) {
          result.push(key);
        }
      }
      return result;
    }
    function assocIndexOf(array2, key) {
      var length = array2.length;
      while (length--) {
        if (eq(array2[length][0], key)) {
          return length;
        }
      }
      return -1;
    }
    function baseGetAllKeys(object2, keysFunc, symbolsFunc) {
      var result = keysFunc(object2);
      return isArray(object2) ? result : arrayPush(result, symbolsFunc(object2));
    }
    function baseGetTag(value) {
      if (value == null) {
        return value === void 0 ? undefinedTag : nullTag;
      }
      return symToStringTag && symToStringTag in Object(value) ? getRawTag(value) : objectToString(value);
    }
    function baseIsArguments(value) {
      return isObjectLike(value) && baseGetTag(value) == argsTag;
    }
    function baseIsEqual(value, other, bitmask, customizer, stack) {
      if (value === other) {
        return true;
      }
      if (value == null || other == null || !isObjectLike(value) && !isObjectLike(other)) {
        return value !== value && other !== other;
      }
      return baseIsEqualDeep(value, other, bitmask, customizer, baseIsEqual, stack);
    }
    function baseIsEqualDeep(object2, other, bitmask, customizer, equalFunc, stack) {
      var objIsArr = isArray(object2), othIsArr = isArray(other), objTag = objIsArr ? arrayTag : getTag(object2), othTag = othIsArr ? arrayTag : getTag(other);
      objTag = objTag == argsTag ? objectTag : objTag;
      othTag = othTag == argsTag ? objectTag : othTag;
      var objIsObj = objTag == objectTag, othIsObj = othTag == objectTag, isSameTag = objTag == othTag;
      if (isSameTag && isBuffer(object2)) {
        if (!isBuffer(other)) {
          return false;
        }
        objIsArr = true;
        objIsObj = false;
      }
      if (isSameTag && !objIsObj) {
        stack || (stack = new Stack());
        return objIsArr || isTypedArray(object2) ? equalArrays(object2, other, bitmask, customizer, equalFunc, stack) : equalByTag(object2, other, objTag, bitmask, customizer, equalFunc, stack);
      }
      if (!(bitmask & COMPARE_PARTIAL_FLAG)) {
        var objIsWrapped = objIsObj && hasOwnProperty2.call(object2, "__wrapped__"), othIsWrapped = othIsObj && hasOwnProperty2.call(other, "__wrapped__");
        if (objIsWrapped || othIsWrapped) {
          var objUnwrapped = objIsWrapped ? object2.value() : object2, othUnwrapped = othIsWrapped ? other.value() : other;
          stack || (stack = new Stack());
          return equalFunc(objUnwrapped, othUnwrapped, bitmask, customizer, stack);
        }
      }
      if (!isSameTag) {
        return false;
      }
      stack || (stack = new Stack());
      return equalObjects(object2, other, bitmask, customizer, equalFunc, stack);
    }
    function baseIsNative(value) {
      if (!isObject(value) || isMasked(value)) {
        return false;
      }
      var pattern = isFunction(value) ? reIsNative : reIsHostCtor;
      return pattern.test(toSource(value));
    }
    function baseIsTypedArray(value) {
      return isObjectLike(value) && isLength(value.length) && !!typedArrayTags[baseGetTag(value)];
    }
    function baseKeys(object2) {
      if (!isPrototype(object2)) {
        return nativeKeys(object2);
      }
      var result = [];
      for (var key in Object(object2)) {
        if (hasOwnProperty2.call(object2, key) && key != "constructor") {
          result.push(key);
        }
      }
      return result;
    }
    function equalArrays(array2, other, bitmask, customizer, equalFunc, stack) {
      var isPartial = bitmask & COMPARE_PARTIAL_FLAG, arrLength = array2.length, othLength = other.length;
      if (arrLength != othLength && !(isPartial && othLength > arrLength)) {
        return false;
      }
      var stacked = stack.get(array2);
      if (stacked && stack.get(other)) {
        return stacked == other;
      }
      var index = -1, result = true, seen = bitmask & COMPARE_UNORDERED_FLAG ? new SetCache() : void 0;
      stack.set(array2, other);
      stack.set(other, array2);
      while (++index < arrLength) {
        var arrValue = array2[index], othValue = other[index];
        if (customizer) {
          var compared = isPartial ? customizer(othValue, arrValue, index, other, array2, stack) : customizer(arrValue, othValue, index, array2, other, stack);
        }
        if (compared !== void 0) {
          if (compared) {
            continue;
          }
          result = false;
          break;
        }
        if (seen) {
          if (!arraySome(other, function(othValue2, othIndex) {
            if (!cacheHas(seen, othIndex) && (arrValue === othValue2 || equalFunc(arrValue, othValue2, bitmask, customizer, stack))) {
              return seen.push(othIndex);
            }
          })) {
            result = false;
            break;
          }
        } else if (!(arrValue === othValue || equalFunc(arrValue, othValue, bitmask, customizer, stack))) {
          result = false;
          break;
        }
      }
      stack["delete"](array2);
      stack["delete"](other);
      return result;
    }
    function equalByTag(object2, other, tag, bitmask, customizer, equalFunc, stack) {
      switch (tag) {
        case dataViewTag:
          if (object2.byteLength != other.byteLength || object2.byteOffset != other.byteOffset) {
            return false;
          }
          object2 = object2.buffer;
          other = other.buffer;
        case arrayBufferTag:
          if (object2.byteLength != other.byteLength || !equalFunc(new Uint8Array2(object2), new Uint8Array2(other))) {
            return false;
          }
          return true;
        case boolTag:
        case dateTag:
        case numberTag:
          return eq(+object2, +other);
        case errorTag:
          return object2.name == other.name && object2.message == other.message;
        case regexpTag:
        case stringTag:
          return object2 == other + "";
        case mapTag:
          var convert = mapToArray;
        case setTag:
          var isPartial = bitmask & COMPARE_PARTIAL_FLAG;
          convert || (convert = setToArray);
          if (object2.size != other.size && !isPartial) {
            return false;
          }
          var stacked = stack.get(object2);
          if (stacked) {
            return stacked == other;
          }
          bitmask |= COMPARE_UNORDERED_FLAG;
          stack.set(object2, other);
          var result = equalArrays(convert(object2), convert(other), bitmask, customizer, equalFunc, stack);
          stack["delete"](object2);
          return result;
        case symbolTag:
          if (symbolValueOf) {
            return symbolValueOf.call(object2) == symbolValueOf.call(other);
          }
      }
      return false;
    }
    function equalObjects(object2, other, bitmask, customizer, equalFunc, stack) {
      var isPartial = bitmask & COMPARE_PARTIAL_FLAG, objProps = getAllKeys(object2), objLength = objProps.length, othProps = getAllKeys(other), othLength = othProps.length;
      if (objLength != othLength && !isPartial) {
        return false;
      }
      var index = objLength;
      while (index--) {
        var key = objProps[index];
        if (!(isPartial ? key in other : hasOwnProperty2.call(other, key))) {
          return false;
        }
      }
      var stacked = stack.get(object2);
      if (stacked && stack.get(other)) {
        return stacked == other;
      }
      var result = true;
      stack.set(object2, other);
      stack.set(other, object2);
      var skipCtor = isPartial;
      while (++index < objLength) {
        key = objProps[index];
        var objValue = object2[key], othValue = other[key];
        if (customizer) {
          var compared = isPartial ? customizer(othValue, objValue, key, other, object2, stack) : customizer(objValue, othValue, key, object2, other, stack);
        }
        if (!(compared === void 0 ? objValue === othValue || equalFunc(objValue, othValue, bitmask, customizer, stack) : compared)) {
          result = false;
          break;
        }
        skipCtor || (skipCtor = key == "constructor");
      }
      if (result && !skipCtor) {
        var objCtor = object2.constructor, othCtor = other.constructor;
        if (objCtor != othCtor && ("constructor" in object2 && "constructor" in other) && !(typeof objCtor == "function" && objCtor instanceof objCtor && typeof othCtor == "function" && othCtor instanceof othCtor)) {
          result = false;
        }
      }
      stack["delete"](object2);
      stack["delete"](other);
      return result;
    }
    function getAllKeys(object2) {
      return baseGetAllKeys(object2, keys, getSymbols);
    }
    function getMapData(map, key) {
      var data = map.__data__;
      return isKeyable(key) ? data[typeof key == "string" ? "string" : "hash"] : data.map;
    }
    function getNative(object2, key) {
      var value = getValue(object2, key);
      return baseIsNative(value) ? value : void 0;
    }
    function getRawTag(value) {
      var isOwn = hasOwnProperty2.call(value, symToStringTag), tag = value[symToStringTag];
      try {
        value[symToStringTag] = void 0;
        var unmasked = true;
      } catch (e) {
      }
      var result = nativeObjectToString.call(value);
      if (unmasked) {
        if (isOwn) {
          value[symToStringTag] = tag;
        } else {
          delete value[symToStringTag];
        }
      }
      return result;
    }
    var getSymbols = !nativeGetSymbols ? stubArray : function(object2) {
      if (object2 == null) {
        return [];
      }
      object2 = Object(object2);
      return arrayFilter(nativeGetSymbols(object2), function(symbol) {
        return propertyIsEnumerable.call(object2, symbol);
      });
    };
    var getTag = baseGetTag;
    if (DataView2 && getTag(new DataView2(new ArrayBuffer(1))) != dataViewTag || Map2 && getTag(new Map2()) != mapTag || Promise2 && getTag(Promise2.resolve()) != promiseTag || Set2 && getTag(new Set2()) != setTag || WeakMap2 && getTag(new WeakMap2()) != weakMapTag) {
      getTag = function(value) {
        var result = baseGetTag(value), Ctor = result == objectTag ? value.constructor : void 0, ctorString = Ctor ? toSource(Ctor) : "";
        if (ctorString) {
          switch (ctorString) {
            case dataViewCtorString:
              return dataViewTag;
            case mapCtorString:
              return mapTag;
            case promiseCtorString:
              return promiseTag;
            case setCtorString:
              return setTag;
            case weakMapCtorString:
              return weakMapTag;
          }
        }
        return result;
      };
    }
    function isIndex(value, length) {
      length = length == null ? MAX_SAFE_INTEGER : length;
      return !!length && (typeof value == "number" || reIsUint.test(value)) && (value > -1 && value % 1 == 0 && value < length);
    }
    function isKeyable(value) {
      var type = typeof value;
      return type == "string" || type == "number" || type == "symbol" || type == "boolean" ? value !== "__proto__" : value === null;
    }
    function isMasked(func) {
      return !!maskSrcKey && maskSrcKey in func;
    }
    function isPrototype(value) {
      var Ctor = value && value.constructor, proto = typeof Ctor == "function" && Ctor.prototype || objectProto;
      return value === proto;
    }
    function objectToString(value) {
      return nativeObjectToString.call(value);
    }
    function toSource(func) {
      if (func != null) {
        try {
          return funcToString.call(func);
        } catch (e) {
        }
        try {
          return func + "";
        } catch (e) {
        }
      }
      return "";
    }
    function eq(value, other) {
      return value === other || value !== value && other !== other;
    }
    var isArguments = baseIsArguments(/* @__PURE__ */ (function() {
      return arguments;
    })()) ? baseIsArguments : function(value) {
      return isObjectLike(value) && hasOwnProperty2.call(value, "callee") && !propertyIsEnumerable.call(value, "callee");
    };
    var isArray = Array.isArray;
    function isArrayLike(value) {
      return value != null && isLength(value.length) && !isFunction(value);
    }
    var isBuffer = nativeIsBuffer || stubFalse;
    function isEqual(value, other) {
      return baseIsEqual(value, other);
    }
    function isFunction(value) {
      if (!isObject(value)) {
        return false;
      }
      var tag = baseGetTag(value);
      return tag == funcTag || tag == genTag || tag == asyncTag || tag == proxyTag;
    }
    function isLength(value) {
      return typeof value == "number" && value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
    }
    function isObject(value) {
      var type = typeof value;
      return value != null && (type == "object" || type == "function");
    }
    function isObjectLike(value) {
      return value != null && typeof value == "object";
    }
    var isTypedArray = nodeIsTypedArray ? baseUnary(nodeIsTypedArray) : baseIsTypedArray;
    function keys(object2) {
      return isArrayLike(object2) ? arrayLikeKeys(object2) : baseKeys(object2);
    }
    function stubArray() {
      return [];
    }
    function stubFalse() {
      return false;
    }
    module.exports = isEqual;
  }
});

// ../../node_modules/lodash.isequalwith/index.js
var require_lodash2 = __commonJS({
  "../../node_modules/lodash.isequalwith/index.js"(exports, module) {
    var LARGE_ARRAY_SIZE = 200;
    var HASH_UNDEFINED = "__lodash_hash_undefined__";
    var UNORDERED_COMPARE_FLAG = 1;
    var PARTIAL_COMPARE_FLAG = 2;
    var MAX_SAFE_INTEGER = 9007199254740991;
    var argsTag = "[object Arguments]";
    var arrayTag = "[object Array]";
    var boolTag = "[object Boolean]";
    var dateTag = "[object Date]";
    var errorTag = "[object Error]";
    var funcTag = "[object Function]";
    var genTag = "[object GeneratorFunction]";
    var mapTag = "[object Map]";
    var numberTag = "[object Number]";
    var objectTag = "[object Object]";
    var promiseTag = "[object Promise]";
    var regexpTag = "[object RegExp]";
    var setTag = "[object Set]";
    var stringTag = "[object String]";
    var symbolTag = "[object Symbol]";
    var weakMapTag = "[object WeakMap]";
    var arrayBufferTag = "[object ArrayBuffer]";
    var dataViewTag = "[object DataView]";
    var float32Tag = "[object Float32Array]";
    var float64Tag = "[object Float64Array]";
    var int8Tag = "[object Int8Array]";
    var int16Tag = "[object Int16Array]";
    var int32Tag = "[object Int32Array]";
    var uint8Tag = "[object Uint8Array]";
    var uint8ClampedTag = "[object Uint8ClampedArray]";
    var uint16Tag = "[object Uint16Array]";
    var uint32Tag = "[object Uint32Array]";
    var reRegExpChar = /[\\^$.*+?()[\]{}|]/g;
    var reIsHostCtor = /^\[object .+?Constructor\]$/;
    var reIsUint = /^(?:0|[1-9]\d*)$/;
    var typedArrayTags = {};
    typedArrayTags[float32Tag] = typedArrayTags[float64Tag] = typedArrayTags[int8Tag] = typedArrayTags[int16Tag] = typedArrayTags[int32Tag] = typedArrayTags[uint8Tag] = typedArrayTags[uint8ClampedTag] = typedArrayTags[uint16Tag] = typedArrayTags[uint32Tag] = true;
    typedArrayTags[argsTag] = typedArrayTags[arrayTag] = typedArrayTags[arrayBufferTag] = typedArrayTags[boolTag] = typedArrayTags[dataViewTag] = typedArrayTags[dateTag] = typedArrayTags[errorTag] = typedArrayTags[funcTag] = typedArrayTags[mapTag] = typedArrayTags[numberTag] = typedArrayTags[objectTag] = typedArrayTags[regexpTag] = typedArrayTags[setTag] = typedArrayTags[stringTag] = typedArrayTags[weakMapTag] = false;
    var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
    var freeSelf = typeof self == "object" && self && self.Object === Object && self;
    var root = freeGlobal || freeSelf || Function("return this")();
    var freeExports = typeof exports == "object" && exports && !exports.nodeType && exports;
    var freeModule = freeExports && typeof module == "object" && module && !module.nodeType && module;
    var moduleExports = freeModule && freeModule.exports === freeExports;
    var freeProcess = moduleExports && freeGlobal.process;
    var nodeUtil = (function() {
      try {
        return freeProcess && freeProcess.binding("util");
      } catch (e) {
      }
    })();
    var nodeIsTypedArray = nodeUtil && nodeUtil.isTypedArray;
    function arraySome(array2, predicate) {
      var index = -1, length = array2 ? array2.length : 0;
      while (++index < length) {
        if (predicate(array2[index], index, array2)) {
          return true;
        }
      }
      return false;
    }
    function baseTimes(n, iteratee) {
      var index = -1, result = Array(n);
      while (++index < n) {
        result[index] = iteratee(index);
      }
      return result;
    }
    function baseUnary(func) {
      return function(value) {
        return func(value);
      };
    }
    function getValue(object2, key) {
      return object2 == null ? void 0 : object2[key];
    }
    function isHostObject(value) {
      var result = false;
      if (value != null && typeof value.toString != "function") {
        try {
          result = !!(value + "");
        } catch (e) {
        }
      }
      return result;
    }
    function mapToArray(map) {
      var index = -1, result = Array(map.size);
      map.forEach(function(value, key) {
        result[++index] = [key, value];
      });
      return result;
    }
    function overArg(func, transform) {
      return function(arg) {
        return func(transform(arg));
      };
    }
    function setToArray(set) {
      var index = -1, result = Array(set.size);
      set.forEach(function(value) {
        result[++index] = value;
      });
      return result;
    }
    var arrayProto = Array.prototype;
    var funcProto = Function.prototype;
    var objectProto = Object.prototype;
    var coreJsData = root["__core-js_shared__"];
    var maskSrcKey = (function() {
      var uid = /[^.]+$/.exec(coreJsData && coreJsData.keys && coreJsData.keys.IE_PROTO || "");
      return uid ? "Symbol(src)_1." + uid : "";
    })();
    var funcToString = funcProto.toString;
    var hasOwnProperty2 = objectProto.hasOwnProperty;
    var objectToString = objectProto.toString;
    var reIsNative = RegExp(
      "^" + funcToString.call(hasOwnProperty2).replace(reRegExpChar, "\\$&").replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, "$1.*?") + "$"
    );
    var Symbol2 = root.Symbol;
    var Uint8Array2 = root.Uint8Array;
    var propertyIsEnumerable = objectProto.propertyIsEnumerable;
    var splice = arrayProto.splice;
    var nativeKeys = overArg(Object.keys, Object);
    var DataView2 = getNative(root, "DataView");
    var Map2 = getNative(root, "Map");
    var Promise2 = getNative(root, "Promise");
    var Set2 = getNative(root, "Set");
    var WeakMap2 = getNative(root, "WeakMap");
    var nativeCreate = getNative(Object, "create");
    var dataViewCtorString = toSource(DataView2);
    var mapCtorString = toSource(Map2);
    var promiseCtorString = toSource(Promise2);
    var setCtorString = toSource(Set2);
    var weakMapCtorString = toSource(WeakMap2);
    var symbolProto = Symbol2 ? Symbol2.prototype : void 0;
    var symbolValueOf = symbolProto ? symbolProto.valueOf : void 0;
    function Hash(entries) {
      var index = -1, length = entries ? entries.length : 0;
      this.clear();
      while (++index < length) {
        var entry2 = entries[index];
        this.set(entry2[0], entry2[1]);
      }
    }
    function hashClear() {
      this.__data__ = nativeCreate ? nativeCreate(null) : {};
    }
    function hashDelete(key) {
      return this.has(key) && delete this.__data__[key];
    }
    function hashGet(key) {
      var data = this.__data__;
      if (nativeCreate) {
        var result = data[key];
        return result === HASH_UNDEFINED ? void 0 : result;
      }
      return hasOwnProperty2.call(data, key) ? data[key] : void 0;
    }
    function hashHas(key) {
      var data = this.__data__;
      return nativeCreate ? data[key] !== void 0 : hasOwnProperty2.call(data, key);
    }
    function hashSet(key, value) {
      var data = this.__data__;
      data[key] = nativeCreate && value === void 0 ? HASH_UNDEFINED : value;
      return this;
    }
    Hash.prototype.clear = hashClear;
    Hash.prototype["delete"] = hashDelete;
    Hash.prototype.get = hashGet;
    Hash.prototype.has = hashHas;
    Hash.prototype.set = hashSet;
    function ListCache(entries) {
      var index = -1, length = entries ? entries.length : 0;
      this.clear();
      while (++index < length) {
        var entry2 = entries[index];
        this.set(entry2[0], entry2[1]);
      }
    }
    function listCacheClear() {
      this.__data__ = [];
    }
    function listCacheDelete(key) {
      var data = this.__data__, index = assocIndexOf(data, key);
      if (index < 0) {
        return false;
      }
      var lastIndex = data.length - 1;
      if (index == lastIndex) {
        data.pop();
      } else {
        splice.call(data, index, 1);
      }
      return true;
    }
    function listCacheGet(key) {
      var data = this.__data__, index = assocIndexOf(data, key);
      return index < 0 ? void 0 : data[index][1];
    }
    function listCacheHas(key) {
      return assocIndexOf(this.__data__, key) > -1;
    }
    function listCacheSet(key, value) {
      var data = this.__data__, index = assocIndexOf(data, key);
      if (index < 0) {
        data.push([key, value]);
      } else {
        data[index][1] = value;
      }
      return this;
    }
    ListCache.prototype.clear = listCacheClear;
    ListCache.prototype["delete"] = listCacheDelete;
    ListCache.prototype.get = listCacheGet;
    ListCache.prototype.has = listCacheHas;
    ListCache.prototype.set = listCacheSet;
    function MapCache(entries) {
      var index = -1, length = entries ? entries.length : 0;
      this.clear();
      while (++index < length) {
        var entry2 = entries[index];
        this.set(entry2[0], entry2[1]);
      }
    }
    function mapCacheClear() {
      this.__data__ = {
        "hash": new Hash(),
        "map": new (Map2 || ListCache)(),
        "string": new Hash()
      };
    }
    function mapCacheDelete(key) {
      return getMapData(this, key)["delete"](key);
    }
    function mapCacheGet(key) {
      return getMapData(this, key).get(key);
    }
    function mapCacheHas(key) {
      return getMapData(this, key).has(key);
    }
    function mapCacheSet(key, value) {
      getMapData(this, key).set(key, value);
      return this;
    }
    MapCache.prototype.clear = mapCacheClear;
    MapCache.prototype["delete"] = mapCacheDelete;
    MapCache.prototype.get = mapCacheGet;
    MapCache.prototype.has = mapCacheHas;
    MapCache.prototype.set = mapCacheSet;
    function SetCache(values) {
      var index = -1, length = values ? values.length : 0;
      this.__data__ = new MapCache();
      while (++index < length) {
        this.add(values[index]);
      }
    }
    function setCacheAdd(value) {
      this.__data__.set(value, HASH_UNDEFINED);
      return this;
    }
    function setCacheHas(value) {
      return this.__data__.has(value);
    }
    SetCache.prototype.add = SetCache.prototype.push = setCacheAdd;
    SetCache.prototype.has = setCacheHas;
    function Stack(entries) {
      this.__data__ = new ListCache(entries);
    }
    function stackClear() {
      this.__data__ = new ListCache();
    }
    function stackDelete(key) {
      return this.__data__["delete"](key);
    }
    function stackGet(key) {
      return this.__data__.get(key);
    }
    function stackHas(key) {
      return this.__data__.has(key);
    }
    function stackSet(key, value) {
      var cache = this.__data__;
      if (cache instanceof ListCache) {
        var pairs = cache.__data__;
        if (!Map2 || pairs.length < LARGE_ARRAY_SIZE - 1) {
          pairs.push([key, value]);
          return this;
        }
        cache = this.__data__ = new MapCache(pairs);
      }
      cache.set(key, value);
      return this;
    }
    Stack.prototype.clear = stackClear;
    Stack.prototype["delete"] = stackDelete;
    Stack.prototype.get = stackGet;
    Stack.prototype.has = stackHas;
    Stack.prototype.set = stackSet;
    function arrayLikeKeys(value, inherited) {
      var result = isArray(value) || isArguments(value) ? baseTimes(value.length, String) : [];
      var length = result.length, skipIndexes = !!length;
      for (var key in value) {
        if ((inherited || hasOwnProperty2.call(value, key)) && !(skipIndexes && (key == "length" || isIndex(key, length)))) {
          result.push(key);
        }
      }
      return result;
    }
    function assocIndexOf(array2, key) {
      var length = array2.length;
      while (length--) {
        if (eq(array2[length][0], key)) {
          return length;
        }
      }
      return -1;
    }
    function baseGetTag(value) {
      return objectToString.call(value);
    }
    function baseIsEqual(value, other, customizer, bitmask, stack) {
      if (value === other) {
        return true;
      }
      if (value == null || other == null || !isObject(value) && !isObjectLike(other)) {
        return value !== value && other !== other;
      }
      return baseIsEqualDeep(value, other, baseIsEqual, customizer, bitmask, stack);
    }
    function baseIsEqualDeep(object2, other, equalFunc, customizer, bitmask, stack) {
      var objIsArr = isArray(object2), othIsArr = isArray(other), objTag = arrayTag, othTag = arrayTag;
      if (!objIsArr) {
        objTag = getTag(object2);
        objTag = objTag == argsTag ? objectTag : objTag;
      }
      if (!othIsArr) {
        othTag = getTag(other);
        othTag = othTag == argsTag ? objectTag : othTag;
      }
      var objIsObj = objTag == objectTag && !isHostObject(object2), othIsObj = othTag == objectTag && !isHostObject(other), isSameTag = objTag == othTag;
      if (isSameTag && !objIsObj) {
        stack || (stack = new Stack());
        return objIsArr || isTypedArray(object2) ? equalArrays(object2, other, equalFunc, customizer, bitmask, stack) : equalByTag(object2, other, objTag, equalFunc, customizer, bitmask, stack);
      }
      if (!(bitmask & PARTIAL_COMPARE_FLAG)) {
        var objIsWrapped = objIsObj && hasOwnProperty2.call(object2, "__wrapped__"), othIsWrapped = othIsObj && hasOwnProperty2.call(other, "__wrapped__");
        if (objIsWrapped || othIsWrapped) {
          var objUnwrapped = objIsWrapped ? object2.value() : object2, othUnwrapped = othIsWrapped ? other.value() : other;
          stack || (stack = new Stack());
          return equalFunc(objUnwrapped, othUnwrapped, customizer, bitmask, stack);
        }
      }
      if (!isSameTag) {
        return false;
      }
      stack || (stack = new Stack());
      return equalObjects(object2, other, equalFunc, customizer, bitmask, stack);
    }
    function baseIsNative(value) {
      if (!isObject(value) || isMasked(value)) {
        return false;
      }
      var pattern = isFunction(value) || isHostObject(value) ? reIsNative : reIsHostCtor;
      return pattern.test(toSource(value));
    }
    function baseIsTypedArray(value) {
      return isObjectLike(value) && isLength(value.length) && !!typedArrayTags[objectToString.call(value)];
    }
    function baseKeys(object2) {
      if (!isPrototype(object2)) {
        return nativeKeys(object2);
      }
      var result = [];
      for (var key in Object(object2)) {
        if (hasOwnProperty2.call(object2, key) && key != "constructor") {
          result.push(key);
        }
      }
      return result;
    }
    function equalArrays(array2, other, equalFunc, customizer, bitmask, stack) {
      var isPartial = bitmask & PARTIAL_COMPARE_FLAG, arrLength = array2.length, othLength = other.length;
      if (arrLength != othLength && !(isPartial && othLength > arrLength)) {
        return false;
      }
      var stacked = stack.get(array2);
      if (stacked && stack.get(other)) {
        return stacked == other;
      }
      var index = -1, result = true, seen = bitmask & UNORDERED_COMPARE_FLAG ? new SetCache() : void 0;
      stack.set(array2, other);
      stack.set(other, array2);
      while (++index < arrLength) {
        var arrValue = array2[index], othValue = other[index];
        if (customizer) {
          var compared = isPartial ? customizer(othValue, arrValue, index, other, array2, stack) : customizer(arrValue, othValue, index, array2, other, stack);
        }
        if (compared !== void 0) {
          if (compared) {
            continue;
          }
          result = false;
          break;
        }
        if (seen) {
          if (!arraySome(other, function(othValue2, othIndex) {
            if (!seen.has(othIndex) && (arrValue === othValue2 || equalFunc(arrValue, othValue2, customizer, bitmask, stack))) {
              return seen.add(othIndex);
            }
          })) {
            result = false;
            break;
          }
        } else if (!(arrValue === othValue || equalFunc(arrValue, othValue, customizer, bitmask, stack))) {
          result = false;
          break;
        }
      }
      stack["delete"](array2);
      stack["delete"](other);
      return result;
    }
    function equalByTag(object2, other, tag, equalFunc, customizer, bitmask, stack) {
      switch (tag) {
        case dataViewTag:
          if (object2.byteLength != other.byteLength || object2.byteOffset != other.byteOffset) {
            return false;
          }
          object2 = object2.buffer;
          other = other.buffer;
        case arrayBufferTag:
          if (object2.byteLength != other.byteLength || !equalFunc(new Uint8Array2(object2), new Uint8Array2(other))) {
            return false;
          }
          return true;
        case boolTag:
        case dateTag:
        case numberTag:
          return eq(+object2, +other);
        case errorTag:
          return object2.name == other.name && object2.message == other.message;
        case regexpTag:
        case stringTag:
          return object2 == other + "";
        case mapTag:
          var convert = mapToArray;
        case setTag:
          var isPartial = bitmask & PARTIAL_COMPARE_FLAG;
          convert || (convert = setToArray);
          if (object2.size != other.size && !isPartial) {
            return false;
          }
          var stacked = stack.get(object2);
          if (stacked) {
            return stacked == other;
          }
          bitmask |= UNORDERED_COMPARE_FLAG;
          stack.set(object2, other);
          var result = equalArrays(convert(object2), convert(other), equalFunc, customizer, bitmask, stack);
          stack["delete"](object2);
          return result;
        case symbolTag:
          if (symbolValueOf) {
            return symbolValueOf.call(object2) == symbolValueOf.call(other);
          }
      }
      return false;
    }
    function equalObjects(object2, other, equalFunc, customizer, bitmask, stack) {
      var isPartial = bitmask & PARTIAL_COMPARE_FLAG, objProps = keys(object2), objLength = objProps.length, othProps = keys(other), othLength = othProps.length;
      if (objLength != othLength && !isPartial) {
        return false;
      }
      var index = objLength;
      while (index--) {
        var key = objProps[index];
        if (!(isPartial ? key in other : hasOwnProperty2.call(other, key))) {
          return false;
        }
      }
      var stacked = stack.get(object2);
      if (stacked && stack.get(other)) {
        return stacked == other;
      }
      var result = true;
      stack.set(object2, other);
      stack.set(other, object2);
      var skipCtor = isPartial;
      while (++index < objLength) {
        key = objProps[index];
        var objValue = object2[key], othValue = other[key];
        if (customizer) {
          var compared = isPartial ? customizer(othValue, objValue, key, other, object2, stack) : customizer(objValue, othValue, key, object2, other, stack);
        }
        if (!(compared === void 0 ? objValue === othValue || equalFunc(objValue, othValue, customizer, bitmask, stack) : compared)) {
          result = false;
          break;
        }
        skipCtor || (skipCtor = key == "constructor");
      }
      if (result && !skipCtor) {
        var objCtor = object2.constructor, othCtor = other.constructor;
        if (objCtor != othCtor && ("constructor" in object2 && "constructor" in other) && !(typeof objCtor == "function" && objCtor instanceof objCtor && typeof othCtor == "function" && othCtor instanceof othCtor)) {
          result = false;
        }
      }
      stack["delete"](object2);
      stack["delete"](other);
      return result;
    }
    function getMapData(map, key) {
      var data = map.__data__;
      return isKeyable(key) ? data[typeof key == "string" ? "string" : "hash"] : data.map;
    }
    function getNative(object2, key) {
      var value = getValue(object2, key);
      return baseIsNative(value) ? value : void 0;
    }
    var getTag = baseGetTag;
    if (DataView2 && getTag(new DataView2(new ArrayBuffer(1))) != dataViewTag || Map2 && getTag(new Map2()) != mapTag || Promise2 && getTag(Promise2.resolve()) != promiseTag || Set2 && getTag(new Set2()) != setTag || WeakMap2 && getTag(new WeakMap2()) != weakMapTag) {
      getTag = function(value) {
        var result = objectToString.call(value), Ctor = result == objectTag ? value.constructor : void 0, ctorString = Ctor ? toSource(Ctor) : void 0;
        if (ctorString) {
          switch (ctorString) {
            case dataViewCtorString:
              return dataViewTag;
            case mapCtorString:
              return mapTag;
            case promiseCtorString:
              return promiseTag;
            case setCtorString:
              return setTag;
            case weakMapCtorString:
              return weakMapTag;
          }
        }
        return result;
      };
    }
    function isIndex(value, length) {
      length = length == null ? MAX_SAFE_INTEGER : length;
      return !!length && (typeof value == "number" || reIsUint.test(value)) && (value > -1 && value % 1 == 0 && value < length);
    }
    function isKeyable(value) {
      var type = typeof value;
      return type == "string" || type == "number" || type == "symbol" || type == "boolean" ? value !== "__proto__" : value === null;
    }
    function isMasked(func) {
      return !!maskSrcKey && maskSrcKey in func;
    }
    function isPrototype(value) {
      var Ctor = value && value.constructor, proto = typeof Ctor == "function" && Ctor.prototype || objectProto;
      return value === proto;
    }
    function toSource(func) {
      if (func != null) {
        try {
          return funcToString.call(func);
        } catch (e) {
        }
        try {
          return func + "";
        } catch (e) {
        }
      }
      return "";
    }
    function eq(value, other) {
      return value === other || value !== value && other !== other;
    }
    function isArguments(value) {
      return isArrayLikeObject(value) && hasOwnProperty2.call(value, "callee") && (!propertyIsEnumerable.call(value, "callee") || objectToString.call(value) == argsTag);
    }
    var isArray = Array.isArray;
    function isArrayLike(value) {
      return value != null && isLength(value.length) && !isFunction(value);
    }
    function isArrayLikeObject(value) {
      return isObjectLike(value) && isArrayLike(value);
    }
    function isEqualWith2(value, other, customizer) {
      customizer = typeof customizer == "function" ? customizer : void 0;
      var result = customizer ? customizer(value, other) : void 0;
      return result === void 0 ? baseIsEqual(value, other, customizer) : !!result;
    }
    function isFunction(value) {
      var tag = isObject(value) ? objectToString.call(value) : "";
      return tag == funcTag || tag == genTag;
    }
    function isLength(value) {
      return typeof value == "number" && value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
    }
    function isObject(value) {
      var type = typeof value;
      return !!value && (type == "object" || type == "function");
    }
    function isObjectLike(value) {
      return !!value && typeof value == "object";
    }
    var isTypedArray = nodeIsTypedArray ? baseUnary(nodeIsTypedArray) : baseIsTypedArray;
    function keys(object2) {
      return isArrayLike(object2) ? arrayLikeKeys(object2) : baseKeys(object2);
    }
    module.exports = isEqualWith2;
  }
});

// ../../node_modules/lodash.throttle/index.js
var require_lodash3 = __commonJS({
  "../../node_modules/lodash.throttle/index.js"(exports, module) {
    var FUNC_ERROR_TEXT = "Expected a function";
    var NAN = 0 / 0;
    var symbolTag = "[object Symbol]";
    var reTrim = /^\s+|\s+$/g;
    var reIsBadHex = /^[-+]0x[0-9a-f]+$/i;
    var reIsBinary = /^0b[01]+$/i;
    var reIsOctal = /^0o[0-7]+$/i;
    var freeParseInt = parseInt;
    var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
    var freeSelf = typeof self == "object" && self && self.Object === Object && self;
    var root = freeGlobal || freeSelf || Function("return this")();
    var objectProto = Object.prototype;
    var objectToString = objectProto.toString;
    var nativeMax = Math.max;
    var nativeMin = Math.min;
    var now = function() {
      return root.Date.now();
    };
    function debounce2(func, wait, options) {
      var lastArgs, lastThis, maxWait, result, timerId, lastCallTime, lastInvokeTime = 0, leading = false, maxing = false, trailing = true;
      if (typeof func != "function") {
        throw new TypeError(FUNC_ERROR_TEXT);
      }
      wait = toNumber(wait) || 0;
      if (isObject(options)) {
        leading = !!options.leading;
        maxing = "maxWait" in options;
        maxWait = maxing ? nativeMax(toNumber(options.maxWait) || 0, wait) : maxWait;
        trailing = "trailing" in options ? !!options.trailing : trailing;
      }
      function invokeFunc(time) {
        var args = lastArgs, thisArg = lastThis;
        lastArgs = lastThis = void 0;
        lastInvokeTime = time;
        result = func.apply(thisArg, args);
        return result;
      }
      function leadingEdge(time) {
        lastInvokeTime = time;
        timerId = setTimeout(timerExpired, wait);
        return leading ? invokeFunc(time) : result;
      }
      function remainingWait(time) {
        var timeSinceLastCall = time - lastCallTime, timeSinceLastInvoke = time - lastInvokeTime, result2 = wait - timeSinceLastCall;
        return maxing ? nativeMin(result2, maxWait - timeSinceLastInvoke) : result2;
      }
      function shouldInvoke(time) {
        var timeSinceLastCall = time - lastCallTime, timeSinceLastInvoke = time - lastInvokeTime;
        return lastCallTime === void 0 || timeSinceLastCall >= wait || timeSinceLastCall < 0 || maxing && timeSinceLastInvoke >= maxWait;
      }
      function timerExpired() {
        var time = now();
        if (shouldInvoke(time)) {
          return trailingEdge(time);
        }
        timerId = setTimeout(timerExpired, remainingWait(time));
      }
      function trailingEdge(time) {
        timerId = void 0;
        if (trailing && lastArgs) {
          return invokeFunc(time);
        }
        lastArgs = lastThis = void 0;
        return result;
      }
      function cancel() {
        if (timerId !== void 0) {
          clearTimeout(timerId);
        }
        lastInvokeTime = 0;
        lastArgs = lastCallTime = lastThis = timerId = void 0;
      }
      function flush() {
        return timerId === void 0 ? result : trailingEdge(now());
      }
      function debounced() {
        var time = now(), isInvoking = shouldInvoke(time);
        lastArgs = arguments;
        lastThis = this;
        lastCallTime = time;
        if (isInvoking) {
          if (timerId === void 0) {
            return leadingEdge(lastCallTime);
          }
          if (maxing) {
            timerId = setTimeout(timerExpired, wait);
            return invokeFunc(lastCallTime);
          }
        }
        if (timerId === void 0) {
          timerId = setTimeout(timerExpired, wait);
        }
        return result;
      }
      debounced.cancel = cancel;
      debounced.flush = flush;
      return debounced;
    }
    function throttle(func, wait, options) {
      var leading = true, trailing = true;
      if (typeof func != "function") {
        throw new TypeError(FUNC_ERROR_TEXT);
      }
      if (isObject(options)) {
        leading = "leading" in options ? !!options.leading : leading;
        trailing = "trailing" in options ? !!options.trailing : trailing;
      }
      return debounce2(func, wait, {
        "leading": leading,
        "maxWait": wait,
        "trailing": trailing
      });
    }
    function isObject(value) {
      var type = typeof value;
      return !!value && (type == "object" || type == "function");
    }
    function isObjectLike(value) {
      return !!value && typeof value == "object";
    }
    function isSymbol(value) {
      return typeof value == "symbol" || isObjectLike(value) && objectToString.call(value) == symbolTag;
    }
    function toNumber(value) {
      if (typeof value == "number") {
        return value;
      }
      if (isSymbol(value)) {
        return NAN;
      }
      if (isObject(value)) {
        var other = typeof value.valueOf == "function" ? value.valueOf() : value;
        value = isObject(other) ? other + "" : other;
      }
      if (typeof value != "string") {
        return value === 0 ? value : +value;
      }
      value = value.replace(reTrim, "");
      var isBinary = reIsBinary.test(value);
      return isBinary || reIsOctal.test(value) ? freeParseInt(value.slice(2), isBinary ? 2 : 8) : reIsBadHex.test(value) ? NAN : +value;
    }
    module.exports = throttle;
  }
});

// ../../node_modules/lodash.uniq/index.js
var require_lodash4 = __commonJS({
  "../../node_modules/lodash.uniq/index.js"(exports, module) {
    var LARGE_ARRAY_SIZE = 200;
    var HASH_UNDEFINED = "__lodash_hash_undefined__";
    var INFINITY = 1 / 0;
    var funcTag = "[object Function]";
    var genTag = "[object GeneratorFunction]";
    var reRegExpChar = /[\\^$.*+?()[\]{}|]/g;
    var reIsHostCtor = /^\[object .+?Constructor\]$/;
    var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
    var freeSelf = typeof self == "object" && self && self.Object === Object && self;
    var root = freeGlobal || freeSelf || Function("return this")();
    function arrayIncludes(array2, value) {
      var length = array2 ? array2.length : 0;
      return !!length && baseIndexOf(array2, value, 0) > -1;
    }
    function arrayIncludesWith(array2, value, comparator) {
      var index = -1, length = array2 ? array2.length : 0;
      while (++index < length) {
        if (comparator(value, array2[index])) {
          return true;
        }
      }
      return false;
    }
    function baseFindIndex(array2, predicate, fromIndex, fromRight) {
      var length = array2.length, index = fromIndex + (fromRight ? 1 : -1);
      while (fromRight ? index-- : ++index < length) {
        if (predicate(array2[index], index, array2)) {
          return index;
        }
      }
      return -1;
    }
    function baseIndexOf(array2, value, fromIndex) {
      if (value !== value) {
        return baseFindIndex(array2, baseIsNaN, fromIndex);
      }
      var index = fromIndex - 1, length = array2.length;
      while (++index < length) {
        if (array2[index] === value) {
          return index;
        }
      }
      return -1;
    }
    function baseIsNaN(value) {
      return value !== value;
    }
    function cacheHas(cache, key) {
      return cache.has(key);
    }
    function getValue(object2, key) {
      return object2 == null ? void 0 : object2[key];
    }
    function isHostObject(value) {
      var result = false;
      if (value != null && typeof value.toString != "function") {
        try {
          result = !!(value + "");
        } catch (e) {
        }
      }
      return result;
    }
    function setToArray(set) {
      var index = -1, result = Array(set.size);
      set.forEach(function(value) {
        result[++index] = value;
      });
      return result;
    }
    var arrayProto = Array.prototype;
    var funcProto = Function.prototype;
    var objectProto = Object.prototype;
    var coreJsData = root["__core-js_shared__"];
    var maskSrcKey = (function() {
      var uid = /[^.]+$/.exec(coreJsData && coreJsData.keys && coreJsData.keys.IE_PROTO || "");
      return uid ? "Symbol(src)_1." + uid : "";
    })();
    var funcToString = funcProto.toString;
    var hasOwnProperty2 = objectProto.hasOwnProperty;
    var objectToString = objectProto.toString;
    var reIsNative = RegExp(
      "^" + funcToString.call(hasOwnProperty2).replace(reRegExpChar, "\\$&").replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, "$1.*?") + "$"
    );
    var splice = arrayProto.splice;
    var Map2 = getNative(root, "Map");
    var Set2 = getNative(root, "Set");
    var nativeCreate = getNative(Object, "create");
    function Hash(entries) {
      var index = -1, length = entries ? entries.length : 0;
      this.clear();
      while (++index < length) {
        var entry2 = entries[index];
        this.set(entry2[0], entry2[1]);
      }
    }
    function hashClear() {
      this.__data__ = nativeCreate ? nativeCreate(null) : {};
    }
    function hashDelete(key) {
      return this.has(key) && delete this.__data__[key];
    }
    function hashGet(key) {
      var data = this.__data__;
      if (nativeCreate) {
        var result = data[key];
        return result === HASH_UNDEFINED ? void 0 : result;
      }
      return hasOwnProperty2.call(data, key) ? data[key] : void 0;
    }
    function hashHas(key) {
      var data = this.__data__;
      return nativeCreate ? data[key] !== void 0 : hasOwnProperty2.call(data, key);
    }
    function hashSet(key, value) {
      var data = this.__data__;
      data[key] = nativeCreate && value === void 0 ? HASH_UNDEFINED : value;
      return this;
    }
    Hash.prototype.clear = hashClear;
    Hash.prototype["delete"] = hashDelete;
    Hash.prototype.get = hashGet;
    Hash.prototype.has = hashHas;
    Hash.prototype.set = hashSet;
    function ListCache(entries) {
      var index = -1, length = entries ? entries.length : 0;
      this.clear();
      while (++index < length) {
        var entry2 = entries[index];
        this.set(entry2[0], entry2[1]);
      }
    }
    function listCacheClear() {
      this.__data__ = [];
    }
    function listCacheDelete(key) {
      var data = this.__data__, index = assocIndexOf(data, key);
      if (index < 0) {
        return false;
      }
      var lastIndex = data.length - 1;
      if (index == lastIndex) {
        data.pop();
      } else {
        splice.call(data, index, 1);
      }
      return true;
    }
    function listCacheGet(key) {
      var data = this.__data__, index = assocIndexOf(data, key);
      return index < 0 ? void 0 : data[index][1];
    }
    function listCacheHas(key) {
      return assocIndexOf(this.__data__, key) > -1;
    }
    function listCacheSet(key, value) {
      var data = this.__data__, index = assocIndexOf(data, key);
      if (index < 0) {
        data.push([key, value]);
      } else {
        data[index][1] = value;
      }
      return this;
    }
    ListCache.prototype.clear = listCacheClear;
    ListCache.prototype["delete"] = listCacheDelete;
    ListCache.prototype.get = listCacheGet;
    ListCache.prototype.has = listCacheHas;
    ListCache.prototype.set = listCacheSet;
    function MapCache(entries) {
      var index = -1, length = entries ? entries.length : 0;
      this.clear();
      while (++index < length) {
        var entry2 = entries[index];
        this.set(entry2[0], entry2[1]);
      }
    }
    function mapCacheClear() {
      this.__data__ = {
        "hash": new Hash(),
        "map": new (Map2 || ListCache)(),
        "string": new Hash()
      };
    }
    function mapCacheDelete(key) {
      return getMapData(this, key)["delete"](key);
    }
    function mapCacheGet(key) {
      return getMapData(this, key).get(key);
    }
    function mapCacheHas(key) {
      return getMapData(this, key).has(key);
    }
    function mapCacheSet(key, value) {
      getMapData(this, key).set(key, value);
      return this;
    }
    MapCache.prototype.clear = mapCacheClear;
    MapCache.prototype["delete"] = mapCacheDelete;
    MapCache.prototype.get = mapCacheGet;
    MapCache.prototype.has = mapCacheHas;
    MapCache.prototype.set = mapCacheSet;
    function SetCache(values) {
      var index = -1, length = values ? values.length : 0;
      this.__data__ = new MapCache();
      while (++index < length) {
        this.add(values[index]);
      }
    }
    function setCacheAdd(value) {
      this.__data__.set(value, HASH_UNDEFINED);
      return this;
    }
    function setCacheHas(value) {
      return this.__data__.has(value);
    }
    SetCache.prototype.add = SetCache.prototype.push = setCacheAdd;
    SetCache.prototype.has = setCacheHas;
    function assocIndexOf(array2, key) {
      var length = array2.length;
      while (length--) {
        if (eq(array2[length][0], key)) {
          return length;
        }
      }
      return -1;
    }
    function baseIsNative(value) {
      if (!isObject(value) || isMasked(value)) {
        return false;
      }
      var pattern = isFunction(value) || isHostObject(value) ? reIsNative : reIsHostCtor;
      return pattern.test(toSource(value));
    }
    function baseUniq(array2, iteratee, comparator) {
      var index = -1, includes = arrayIncludes, length = array2.length, isCommon = true, result = [], seen = result;
      if (comparator) {
        isCommon = false;
        includes = arrayIncludesWith;
      } else if (length >= LARGE_ARRAY_SIZE) {
        var set = iteratee ? null : createSet(array2);
        if (set) {
          return setToArray(set);
        }
        isCommon = false;
        includes = cacheHas;
        seen = new SetCache();
      } else {
        seen = iteratee ? [] : result;
      }
      outer:
        while (++index < length) {
          var value = array2[index], computed2 = iteratee ? iteratee(value) : value;
          value = comparator || value !== 0 ? value : 0;
          if (isCommon && computed2 === computed2) {
            var seenIndex = seen.length;
            while (seenIndex--) {
              if (seen[seenIndex] === computed2) {
                continue outer;
              }
            }
            if (iteratee) {
              seen.push(computed2);
            }
            result.push(value);
          } else if (!includes(seen, computed2, comparator)) {
            if (seen !== result) {
              seen.push(computed2);
            }
            result.push(value);
          }
        }
      return result;
    }
    var createSet = !(Set2 && 1 / setToArray(new Set2([, -0]))[1] == INFINITY) ? noop2 : function(values) {
      return new Set2(values);
    };
    function getMapData(map, key) {
      var data = map.__data__;
      return isKeyable(key) ? data[typeof key == "string" ? "string" : "hash"] : data.map;
    }
    function getNative(object2, key) {
      var value = getValue(object2, key);
      return baseIsNative(value) ? value : void 0;
    }
    function isKeyable(value) {
      var type = typeof value;
      return type == "string" || type == "number" || type == "symbol" || type == "boolean" ? value !== "__proto__" : value === null;
    }
    function isMasked(func) {
      return !!maskSrcKey && maskSrcKey in func;
    }
    function toSource(func) {
      if (func != null) {
        try {
          return funcToString.call(func);
        } catch (e) {
        }
        try {
          return func + "";
        } catch (e) {
        }
      }
      return "";
    }
    function uniq(array2) {
      return array2 && array2.length ? baseUniq(array2) : [];
    }
    function eq(value, other) {
      return value === other || value !== value && other !== other;
    }
    function isFunction(value) {
      var tag = isObject(value) ? objectToString.call(value) : "";
      return tag == funcTag || tag == genTag;
    }
    function isObject(value) {
      var type = typeof value;
      return !!value && (type == "object" || type == "function");
    }
    function noop2() {
    }
    module.exports = uniq;
  }
});

// ../../node_modules/@tldraw/utils/dist-esm/lib/version.mjs
var TLDRAW_LIBRARY_VERSION_KEY = "__TLDRAW_LIBRARY_VERSIONS__";
function getLibraryVersions() {
  if (globalThis[TLDRAW_LIBRARY_VERSION_KEY]) {
    return globalThis[TLDRAW_LIBRARY_VERSION_KEY];
  }
  const info = {
    versions: [],
    didWarn: false,
    scheduledNotice: null
  };
  Object.defineProperty(globalThis, TLDRAW_LIBRARY_VERSION_KEY, {
    value: info,
    writable: false,
    configurable: false,
    enumerable: false
  });
  return info;
}
function registerTldrawLibraryVersion(name, version, modules) {
  if (!name || !version || !modules) {
    if (true) {
      throw new Error("Missing name/version/module system in built version of tldraw library");
    }
    return;
  }
  const info = getLibraryVersions();
  if (isNextjsDev()) {
    const isDuplicate = info.versions.some(
      (v) => v.name === name && v.version === version && v.modules === modules
    );
    if (isDuplicate) return;
  }
  info.versions.push({ name, version, modules });
  if (!info.scheduledNotice) {
    try {
      info.scheduledNotice = setTimeout(() => {
        info.scheduledNotice = null;
        checkLibraryVersions(info);
      }, 100);
    } catch {
      checkLibraryVersions(info);
    }
  }
}
function checkLibraryVersions(info) {
  if (!info.versions.length) return;
  if (info.didWarn) return;
  const sorted = info.versions.sort((a, b) => compareVersions(a.version, b.version));
  const latestVersion = sorted[sorted.length - 1].version;
  const matchingVersions = /* @__PURE__ */ new Set();
  const nonMatchingVersions = /* @__PURE__ */ new Map();
  for (const lib of sorted) {
    if (nonMatchingVersions.has(lib.name)) {
      matchingVersions.delete(lib.name);
      entry(nonMatchingVersions, lib.name, /* @__PURE__ */ new Set()).add(lib.version);
      continue;
    }
    if (lib.version === latestVersion) {
      matchingVersions.add(lib.name);
    } else {
      matchingVersions.delete(lib.name);
      entry(nonMatchingVersions, lib.name, /* @__PURE__ */ new Set()).add(lib.version);
    }
  }
  if (nonMatchingVersions.size > 0) {
    const message = [
      `${format("[tldraw]", ["bold", "bgRed", "textWhite"])} ${format("You have multiple versions of tldraw libraries installed. This can lead to bugs and unexpected behavior.", ["textRed", "bold"])}`,
      "",
      `The latest version you have installed is ${format(`v${latestVersion}`, ["bold", "textBlue"])}. The following libraries are on the latest version:`,
      ...Array.from(matchingVersions, (name) => `  • ✅ ${format(name, ["bold"])}`),
      "",
      `The following libraries are not on the latest version, or have multiple versions installed:`,
      ...Array.from(nonMatchingVersions, ([name, versions]) => {
        const sortedVersions = Array.from(versions).sort(compareVersions).map((v) => format(`v${v}`, v === latestVersion ? ["textGreen"] : ["textRed"]));
        return `  • ❌ ${format(name, ["bold"])} (${sortedVersions.join(", ")})`;
      })
    ];
    console.log(message.join("\n"));
    info.didWarn = true;
    return;
  }
  const potentialDuplicates = /* @__PURE__ */ new Map();
  for (const lib of sorted) {
    entry(potentialDuplicates, lib.name, { version: lib.version, modules: [] }).modules.push(
      lib.modules
    );
  }
  const duplicates = /* @__PURE__ */ new Map();
  for (const [name, lib] of potentialDuplicates) {
    if (lib.modules.length > 1) duplicates.set(name, lib);
  }
  if (duplicates.size > 0) {
    const message = [
      `${format("[tldraw]", ["bold", "bgRed", "textWhite"])} ${format("You have multiple instances of some tldraw libraries active. This can lead to bugs and unexpected behavior. ", ["textRed", "bold"])}`,
      "",
      "This usually means that your bundler is misconfigured, and is importing the same library multiple times - usually once as an ES Module, and once as a CommonJS module.",
      "",
      "The following libraries have been imported multiple times:",
      ...Array.from(duplicates, ([name, lib]) => {
        const modules = lib.modules.map((m, i) => m === "esm" ? `      ${i + 1}. ES Modules` : `      ${i + 1}. CommonJS`).join("\n");
        return `  • ❌ ${format(name, ["bold"])} v${lib.version}: 
${modules}`;
      }),
      "",
      "You should configure your bundler to only import one version of each library."
    ];
    console.log(message.join("\n"));
    info.didWarn = true;
    return;
  }
}
function compareVersions(a, b) {
  const aMatch = a.match(/^(\d+)\.(\d+)\.(\d+)(?:-(\w+))?$/);
  const bMatch = b.match(/^(\d+)\.(\d+)\.(\d+)(?:-(\w+))?$/);
  if (!aMatch || !bMatch) return a.localeCompare(b);
  if (aMatch[1] !== bMatch[1]) return Number(aMatch[1]) - Number(bMatch[1]);
  if (aMatch[2] !== bMatch[2]) return Number(aMatch[2]) - Number(bMatch[2]);
  if (aMatch[3] !== bMatch[3]) return Number(aMatch[3]) - Number(bMatch[3]);
  if (aMatch[4] && bMatch[4]) return aMatch[4].localeCompare(bMatch[4]);
  if (aMatch[4]) return 1;
  if (bMatch[4]) return -1;
  return 0;
}
var formats = {
  bold: "1",
  textBlue: "94",
  textRed: "31",
  textGreen: "32",
  bgRed: "41",
  textWhite: "97"
};
function format(value, formatters = []) {
  return `\x1B[${formatters.map((f) => formats[f]).join(";")}m${value}\x1B[m`;
}
function isNextjsDev() {
  try {
    return "__NEXT_DATA__" in globalThis;
  } catch {
    return false;
  }
}
function entry(map, key, defaultValue) {
  if (map.has(key)) {
    return map.get(key);
  }
  map.set(key, defaultValue);
  return defaultValue;
}

// ../../node_modules/@tldraw/utils/dist-esm/index.mjs
var import_lodash2 = __toESM(require_lodash(), 1);
var import_lodash3 = __toESM(require_lodash2(), 1);
var import_lodash4 = __toESM(require_lodash3(), 1);
var import_lodash5 = __toESM(require_lodash4(), 1);

// ../../node_modules/@tldraw/utils/dist-esm/lib/array.mjs
function rotateArray(arr, offset) {
  if (arr.length === 0) return [];
  const normalizedOffset = (Math.abs(offset) % arr.length + arr.length) % arr.length;
  return [...arr.slice(normalizedOffset), ...arr.slice(0, normalizedOffset)];
}
function dedupe(input, equals2) {
  const result = [];
  mainLoop: for (const item of input) {
    for (const existing of result) {
      if (equals2 ? equals2(item, existing) : item === existing) {
        continue mainLoop;
      }
    }
    result.push(item);
  }
  return result;
}
function compact(arr) {
  return arr.filter((i) => i !== void 0 && i !== null);
}
function last(arr) {
  return arr[arr.length - 1];
}
function minBy(arr, fn) {
  let min;
  let minVal = Infinity;
  for (const item of arr) {
    const val = fn(item);
    if (val < minVal) {
      min = item;
      minVal = val;
    }
  }
  return min;
}
function maxBy(arr, fn) {
  let max;
  let maxVal = -Infinity;
  for (const item of arr) {
    const val = fn(item);
    if (val > maxVal) {
      max = item;
      maxVal = val;
    }
  }
  return max;
}
function partition(arr, predicate) {
  const satisfies = [];
  const doesNotSatisfy = [];
  for (const item of arr) {
    if (predicate(item)) {
      satisfies.push(item);
    } else {
      doesNotSatisfy.push(item);
    }
  }
  return [satisfies, doesNotSatisfy];
}
function areArraysShallowEqual(arr1, arr2) {
  if (arr1 === arr2) return true;
  if (arr1.length !== arr2.length) return false;
  for (let i = 0; i < arr1.length; i++) {
    if (!Object.is(arr1[i], arr2[i])) {
      return false;
    }
  }
  return true;
}
function mergeArraysAndReplaceDefaults(key, customEntries, defaults) {
  const overrideTypes = new Set(customEntries.map((entry2) => entry2[key]));
  const result = [];
  for (const defaultEntry of defaults) {
    if (overrideTypes.has(defaultEntry[key])) continue;
    result.push(defaultEntry);
  }
  for (const customEntry of customEntries) {
    result.push(customEntry);
  }
  return result;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/function.mjs
function omitFromStackTrace(fn) {
  const wrappedFn = (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      if (error instanceof Error && Error.captureStackTrace) {
        Error.captureStackTrace(error, wrappedFn);
      }
      throw error;
    }
  };
  return wrappedFn;
}
function noop() {
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/control.mjs
var Result = {
  /**
   * Create a successful result containing a value.
   *
   * @param value - The success value to wrap
   * @returns An OkResult containing the value
   */
  ok(value) {
    return { ok: true, value };
  },
  /**
   * Create a failed result containing an error.
   *
   * @param error - The error value to wrap
   * @returns An ErrorResult containing the error
   */
  err(error) {
    return { ok: false, error };
  },
  /**
   * Create a successful result containing an array of values.
   *
   * If any of the results are errors, the returned result will be an error containing the first error.
   *
   * @param results - The array of results to wrap
   * @returns An OkResult containing the array of values
   */
  all(results) {
    return results.every((result) => result.ok) ? Result.ok(results.map((result) => result.value)) : Result.err(results.find((result) => !result.ok)?.error);
  }
};
function exhaustiveSwitchError(value, property) {
  const debugValue = property && value && typeof value === "object" && property in value ? value[property] : value;
  throw new Error(`Unknown switch case ${debugValue}`);
}
var assert = omitFromStackTrace(
  (value, message) => {
    if (!value) {
      throw new Error(message || "Assertion Error");
    }
  }
);
var assertExists = omitFromStackTrace((value, message) => {
  if (value == null) {
    throw new Error(message ?? "value must be defined");
  }
  return value;
});
function promiseWithResolve() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return Object.assign(promise, {
    resolve,
    reject
  });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/bind.mjs
function bind(...args) {
  if (args.length === 2) {
    const [originalMethod, context] = args;
    context.addInitializer(function initializeMethod() {
      assert(Reflect.isExtensible(this), "Cannot bind to a non-extensible class.");
      const value = originalMethod.bind(this);
      const ok = Reflect.defineProperty(this, context.name, {
        value,
        writable: true,
        configurable: true
      });
      assert(ok, "Cannot bind a non-configurable class method.");
    });
  } else {
    const [_target, propertyKey, descriptor] = args;
    if (!descriptor || typeof descriptor.value !== "function") {
      throw new TypeError(
        `Only methods can be decorated with @bind. <${propertyKey}> is not a method!`
      );
    }
    return {
      configurable: true,
      get() {
        const bound = descriptor.value.bind(this);
        Object.defineProperty(this, propertyKey, {
          value: bound,
          configurable: true,
          writable: true
        });
        return bound;
      }
    };
  }
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/cache.mjs
var WeakCache = class {
  /**
   * The internal WeakMap storage for cached key-value pairs.
   *
   * @public
   */
  items = /* @__PURE__ */ new WeakMap();
  /**
   * Get the cached value for a given key, computing it if not already cached.
   *
   * Retrieves the cached value associated with the given key. If no cached
   * value exists, calls the provided callback function to compute the value, stores it
   * in the cache, and returns it. Subsequent calls with the same key will return the
   * cached value without recomputation.
   *
   * @param item - The object key to retrieve the cached value for
   * @param cb - Callback function that computes the value when not already cached
   * @returns The cached value if it exists, otherwise the newly computed value from the callback
   *
   * @example
   * ```ts
   * const cache = new WeakCache<HTMLElement, DOMRect>()
   * const element = document.getElementById('my-element')!
   *
   * // First call computes and caches the bounding rect
   * const rect1 = cache.get(element, (el) => el.getBoundingClientRect())
   *
   * // Second call returns cached value
   * const rect2 = cache.get(element, (el) => el.getBoundingClientRect())
   * // rect1 and rect2 are the same object
   * ```
   */
  get(item, cb) {
    if (!this.items.has(item)) {
      this.items.set(item, cb(item));
    }
    return this.items.get(item);
  }
};

// ../../node_modules/@tldraw/utils/dist-esm/lib/debounce.mjs
function debounce(callback, wait) {
  let state = void 0;
  const fn = (...args) => {
    if (!state) {
      state = {};
      state.promise = new Promise((resolve, reject) => {
        state.resolve = resolve;
        state.reject = reject;
      });
    }
    clearTimeout(state.timeout);
    state.latestArgs = args;
    state.timeout = setTimeout(() => {
      const s = state;
      state = void 0;
      try {
        s.resolve(callback(...s.latestArgs));
      } catch (e) {
        s.reject(e);
      }
    }, wait);
    return state.promise;
  };
  fn.cancel = () => {
    if (!state) return;
    clearTimeout(state.timeout);
    const s = state;
    state = void 0;
    s.promise.catch(noop);
    s.reject(new Error("Debounced function was cancelled"));
  };
  return fn;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/error.mjs
var annotationsByError = /* @__PURE__ */ new WeakMap();
function annotateError(error, annotations) {
  if (typeof error !== "object" || error === null) return;
  let currentAnnotations = annotationsByError.get(error);
  if (!currentAnnotations) {
    currentAnnotations = { tags: {}, extras: {} };
    annotationsByError.set(error, currentAnnotations);
  }
  if (annotations.tags) {
    currentAnnotations.tags = {
      ...currentAnnotations.tags,
      ...annotations.tags
    };
  }
  if (annotations.extras) {
    currentAnnotations.extras = {
      ...currentAnnotations.extras,
      ...annotations.extras
    };
  }
}
function getErrorAnnotations(error) {
  return annotationsByError.get(error) ?? { tags: {}, extras: {} };
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/ExecutionQueue.mjs
var ExecutionQueue = class {
  /**
   * Creates a new ExecutionQueue.
   *
   * Creates a new execution queue that will process tasks sequentially.
   * If a timeout is provided, there will be a delay between each task execution,
   * which is useful for rate limiting or controlling execution flow.
   *
   * timeout - Optional delay in milliseconds between task executions
   * @example
   * ```ts
   * // Create queue without delay
   * const fastQueue = new ExecutionQueue()
   *
   * // Create queue with 500ms delay between tasks
   * const slowQueue = new ExecutionQueue(500)
   * ```
   */
  constructor(timeout) {
    this.timeout = timeout;
  }
  timeout;
  queue = [];
  running = false;
  /**
   * Checks if the queue is empty and not currently running a task.
   *
   * Determines whether the execution queue has completed all tasks and is idle.
   * Returns true only when there are no pending tasks in the queue AND no task is currently being executed.
   *
   * @returns True if the queue has no pending tasks and is not currently executing
   * @example
   * ```ts
   * const queue = new ExecutionQueue()
   *
   * console.log(queue.isEmpty()) // true - queue is empty
   *
   * queue.push(() => console.log('task'))
   * console.log(queue.isEmpty()) // false - task is running/pending
   * ```
   */
  isEmpty() {
    return this.queue.length === 0 && !this.running;
  }
  async run() {
    if (this.running) return;
    try {
      this.running = true;
      while (this.queue.length) {
        const task = this.queue.shift();
        await task();
        if (this.timeout) {
          await sleep(this.timeout);
        }
      }
    } finally {
      this.running = false;
    }
  }
  /**
   * Adds a task to the queue and returns a promise that resolves with the task's result.
   *
   * Enqueues a task for sequential execution. The task will be executed after all
   * previously queued tasks have completed. If a timeout was specified in the constructor,
   * there will be a delay between this task and the next one.
   *
   * @param task - The function to execute (can be sync or async)
   * @returns Promise that resolves with the task's return value
   * @example
   * ```ts
   * const queue = new ExecutionQueue(100)
   *
   * // Add async task
   * const result = await queue.push(async () => {
   *   const response = await fetch('/api/data')
   *   return response.json()
   * })
   *
   * // Add sync task
   * const number = await queue.push(() => 42)
   * ```
   */
  async push(task) {
    return new Promise((resolve, reject) => {
      this.queue.push(() => Promise.resolve(task()).then(resolve).catch(reject));
      this.run();
    });
  }
  /**
   * Clears all pending tasks from the queue.
   *
   * Immediately removes all pending tasks from the queue. Any currently
   * running task will complete normally, but no additional tasks will be executed.
   * This method does not wait for the current task to finish.
   *
   * @returns void
   * @example
   * ```ts
   * const queue = new ExecutionQueue()
   *
   * // Add several tasks
   * queue.push(() => console.log('task 1'))
   * queue.push(() => console.log('task 2'))
   * queue.push(() => console.log('task 3'))
   *
   * // Clear all pending tasks
   * queue.close()
   * // Only 'task 1' will execute if it was already running
   * ```
   */
  close() {
    this.queue = [];
  }
};

// ../../node_modules/@tldraw/utils/dist-esm/lib/network.mjs
async function fetch(input, init) {
  return window.fetch(input, {
    // We want to make sure that the referrer is not sent to other domains.
    referrerPolicy: "strict-origin-when-cross-origin",
    ...init
  });
}
function Image(width, height) {
  const img = new window.Image(width, height);
  img.referrerPolicy = "strict-origin-when-cross-origin";
  return img;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/file.mjs
var FileHelpers = class _FileHelpers {
  /**
   * Converts a URL to an ArrayBuffer by fetching the resource.
   *
   * Fetches the resource at the given URL and returns its content as an ArrayBuffer.
   * This is useful for loading binary data like images, videos, or other file types.
   *
   * @param url - The URL of the file to fetch
   * @returns Promise that resolves to the file content as an ArrayBuffer
   * @example
   * ```ts
   * const buffer = await FileHelpers.urlToArrayBuffer('https://example.com/image.png')
   * console.log(buffer.byteLength) // Size of the file in bytes
   * ```
   * @public
   */
  static async urlToArrayBuffer(url) {
    const response = await fetch(url);
    return await response.arrayBuffer();
  }
  /**
   * Converts a URL to a Blob by fetching the resource.
   *
   * Fetches the resource at the given URL and returns its content as a Blob object.
   * Blobs are useful for handling file data in web applications.
   *
   * @param url - The URL of the file to fetch
   * @returns Promise that resolves to the file content as a Blob
   * @example
   * ```ts
   * const blob = await FileHelpers.urlToBlob('https://example.com/document.pdf')
   * console.log(blob.type) // 'application/pdf'
   * console.log(blob.size) // Size in bytes
   * ```
   * @public
   */
  static async urlToBlob(url) {
    const response = await fetch(url);
    return await response.blob();
  }
  /**
   * Converts a URL to a data URL by fetching the resource.
   *
   * Fetches the resource at the given URL and converts it to a base64-encoded data URL.
   * If the URL is already a data URL, it returns the URL unchanged. This is useful for embedding
   * resources directly in HTML or CSS.
   *
   * @param url - The URL of the file to convert, or an existing data URL
   * @returns Promise that resolves to a data URL string
   * @example
   * ```ts
   * const dataUrl = await FileHelpers.urlToDataUrl('https://example.com/image.jpg')
   * // Returns: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEA...'
   *
   * const existing = await FileHelpers.urlToDataUrl('data:text/plain;base64,SGVsbG8=')
   * // Returns the same data URL unchanged
   * ```
   * @public
   */
  static async urlToDataUrl(url) {
    if (url.startsWith("data:")) return url;
    const blob = await _FileHelpers.urlToBlob(url);
    return await _FileHelpers.blobToDataUrl(blob);
  }
  /**
   * Convert a Blob to a base64 encoded data URL.
   *
   * Converts a Blob object to a base64-encoded data URL using the FileReader API.
   * This is useful for displaying images or embedding file content directly in HTML.
   *
   * @param file - The Blob object to convert
   * @returns Promise that resolves to a base64-encoded data URL string
   * @example
   * ```ts
   * const blob = new Blob(['Hello World'], { type: 'text/plain' })
   * const dataUrl = await FileHelpers.blobToDataUrl(blob)
   * // Returns: 'data:text/plain;base64,SGVsbG8gV29ybGQ='
   *
   * // With an image file
   * const imageDataUrl = await FileHelpers.blobToDataUrl(myImageFile)
   * // Can be used directly in img src attribute
   * ```
   * @public
   */
  static async blobToDataUrl(file) {
    return await new Promise((resolve, reject) => {
      if (file) {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (error) => reject(error);
        reader.onabort = (error) => reject(error);
        reader.readAsDataURL(file);
      }
    });
  }
  /**
   * Convert a Blob to a unicode text string.
   *
   * Reads the content of a Blob object as a UTF-8 text string using the FileReader API.
   * This is useful for reading text files or extracting text content from blobs.
   *
   * @param file - The Blob object to convert to text
   * @returns Promise that resolves to the text content as a string
   * @example
   * ```ts
   * const textBlob = new Blob(['Hello World'], { type: 'text/plain' })
   * const text = await FileHelpers.blobToText(textBlob)
   * console.log(text) // 'Hello World'
   *
   * // With a text file from user input
   * const content = await FileHelpers.blobToText(myTextFile)
   * console.log(content) // File content as string
   * ```
   * @public
   */
  static async blobToText(file) {
    return await new Promise((resolve, reject) => {
      if (file) {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (error) => reject(error);
        reader.onabort = (error) => reject(error);
        reader.readAsText(file);
      }
    });
  }
  static rewriteMimeType(blob, newMimeType) {
    if (blob.type === newMimeType) return blob;
    if (blob instanceof File) {
      return new File([blob], blob.name, { type: newMimeType });
    }
    return new Blob([blob], { type: newMimeType });
  }
};

// ../../node_modules/@tldraw/utils/dist-esm/lib/hash.mjs
function getHashForString(string2) {
  let hash2 = 0;
  for (let i = 0; i < string2.length; i++) {
    hash2 = (hash2 << 5) - hash2 + string2.charCodeAt(i);
    hash2 |= 0;
  }
  return hash2 + "";
}
function getHashForObject(obj) {
  return getHashForString(JSON.stringify(obj));
}
function getHashForBuffer(buffer) {
  const view = new DataView(buffer);
  let hash2 = 0;
  for (let i = 0; i < view.byteLength; i++) {
    hash2 = (hash2 << 5) - hash2 + view.getUint8(i);
    hash2 |= 0;
  }
  return hash2 + "";
}
function lns(str) {
  const result = str.split("");
  result.push(...result.splice(0, Math.round(result.length / 5)));
  result.push(...result.splice(0, Math.round(result.length / 4)));
  result.push(...result.splice(0, Math.round(result.length / 3)));
  result.push(...result.splice(0, Math.round(result.length / 2)));
  return result.reverse().map((n) => +n ? +n < 5 ? 5 + +n : +n > 5 ? +n - 5 : n : n).join("");
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/id.mjs
var crypto = globalThis.crypto;
var urlAlphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
var POOL_SIZE_MULTIPLIER = 128;
var pool;
var poolOffset;
function fillPool(bytes) {
  if (!pool || pool.length < bytes) {
    pool = new Uint8Array(bytes * POOL_SIZE_MULTIPLIER);
    crypto.getRandomValues(pool);
    poolOffset = 0;
  } else if (poolOffset + bytes > pool.length) {
    crypto.getRandomValues(pool);
    poolOffset = 0;
  }
  poolOffset += bytes;
}
function nanoid(size = 21) {
  fillPool(size -= 0);
  let id = "";
  for (let i = poolOffset - size; i < poolOffset; i++) {
    id += urlAlphabet[pool[i] & 63];
  }
  return id;
}
var impl = nanoid;
function mockUniqueId(fn) {
  impl = fn;
}
function restoreUniqueId() {
  impl = nanoid;
}
function uniqueId(size) {
  return impl(size);
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/iterable.mjs
function getFirstFromIterable(set) {
  return set.values().next().value;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/LruCache.mjs
var LruCache = class {
  constructor(maxSize) {
    this.maxSize = maxSize;
  }
  maxSize;
  map = /* @__PURE__ */ new Map();
  get(key) {
    if (!this.map.has(key)) return void 0;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      this.map.delete(this.map.keys().next().value);
    }
  }
  has(key) {
    return this.map.has(key);
  }
  // eslint-disable-next-line tldraw/no-setter-getter
  get size() {
    return this.map.size;
  }
};

// ../../node_modules/@tldraw/utils/dist-esm/lib/media/apng.mjs
function isApngAnimated(buffer) {
  const view = new Uint8Array(buffer);
  if (!view || !(typeof Buffer !== "undefined" && Buffer.isBuffer(view) || view instanceof Uint8Array) || view.length < 16) {
    return false;
  }
  const isPNG = view[0] === 137 && view[1] === 80 && view[2] === 78 && view[3] === 71 && view[4] === 13 && view[5] === 10 && view[6] === 26 && view[7] === 10;
  if (!isPNG) {
    return false;
  }
  function indexOfSubstring(haystack, needle, fromIndex, upToIndex, chunksize = 1024) {
    if (!needle) {
      return -1;
    }
    needle = new RegExp(needle, "g");
    const needle_length = needle.source.length;
    const decoder = new TextDecoder();
    const full_haystack_length = haystack.length;
    if (typeof upToIndex === "undefined") {
      upToIndex = full_haystack_length;
    }
    if (fromIndex >= full_haystack_length || upToIndex <= 0 || fromIndex >= upToIndex) {
      return -1;
    }
    haystack = haystack.subarray(fromIndex, upToIndex);
    let position = -1;
    let current_index = 0;
    let full_length = 0;
    let needle_buffer = "";
    outer: while (current_index < haystack.length) {
      const next_index = current_index + chunksize;
      const chunk = haystack.subarray(current_index, next_index);
      const decoded = decoder.decode(chunk, { stream: true });
      const text = needle_buffer + decoded;
      let match;
      let last_index = -1;
      while ((match = needle.exec(text)) !== null) {
        last_index = match.index - needle_buffer.length;
        position = full_length + last_index;
        break outer;
      }
      current_index = next_index;
      full_length += decoded.length;
      const needle_index = last_index > -1 ? last_index + needle_length : decoded.length - needle_length;
      needle_buffer = decoded.slice(needle_index);
    }
    if (position >= 0) {
      position += fromIndex >= 0 ? fromIndex : full_haystack_length + fromIndex;
    }
    return position;
  }
  const idatIdx = indexOfSubstring(view, "IDAT", 12);
  if (idatIdx >= 12) {
    const actlIdx = indexOfSubstring(view, "acTL", 8, idatIdx);
    return actlIdx >= 8;
  }
  return false;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/media/avif.mjs
function isAvifAnimated(buffer) {
  const view = new Uint8Array(buffer);
  return view[3] === 44;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/media/gif.mjs
function getDataBlocksLength(buffer, offset) {
  let length = 0;
  while (buffer[offset + length]) {
    length += buffer[offset + length] + 1;
  }
  return length + 1;
}
function isGIF(buffer) {
  const enc = new TextDecoder("ascii");
  const header = enc.decode(buffer.slice(0, 3));
  return header === "GIF";
}
function isGifAnimated(buffer) {
  const view = new Uint8Array(buffer);
  let hasColorTable, colorTableSize;
  let offset = 0;
  let imagesCount = 0;
  if (!isGIF(buffer)) {
    return false;
  }
  hasColorTable = view[10] & 128;
  colorTableSize = view[10] & 7;
  offset += 6;
  offset += 7;
  offset += hasColorTable ? 3 * Math.pow(2, colorTableSize + 1) : 0;
  while (imagesCount < 2 && offset < view.length) {
    switch (view[offset]) {
      // Image descriptor block. According to specification there could be any
      // number of these blocks (even zero). When there is more than one image
      // descriptor browsers will display animation (they shouldn't when there
      // is no delays defined, but they do it anyway).
      case 44:
        imagesCount += 1;
        hasColorTable = view[offset + 9] & 128;
        colorTableSize = view[offset + 9] & 7;
        offset += 10;
        offset += hasColorTable ? 3 * Math.pow(2, colorTableSize + 1) : 0;
        offset += getDataBlocksLength(view, offset + 1) + 1;
        break;
      // Skip all extension blocks. In theory this "plain text extension" blocks
      // could be frames of animation, but no browser renders them.
      case 33:
        offset += 2;
        offset += getDataBlocksLength(view, offset);
        break;
      // Stop processing on trailer block,
      // all data after this point will is ignored by decoders
      case 59:
        offset = view.length;
        break;
      // Oops! This GIF seems to be invalid
      default:
        offset = view.length;
        break;
    }
  }
  return imagesCount > 1;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/media/png.mjs
var TABLE = [
  0,
  1996959894,
  3993919788,
  2567524794,
  124634137,
  1886057615,
  3915621685,
  2657392035,
  249268274,
  2044508324,
  3772115230,
  2547177864,
  162941995,
  2125561021,
  3887607047,
  2428444049,
  498536548,
  1789927666,
  4089016648,
  2227061214,
  450548861,
  1843258603,
  4107580753,
  2211677639,
  325883990,
  1684777152,
  4251122042,
  2321926636,
  335633487,
  1661365465,
  4195302755,
  2366115317,
  997073096,
  1281953886,
  3579855332,
  2724688242,
  1006888145,
  1258607687,
  3524101629,
  2768942443,
  901097722,
  1119000684,
  3686517206,
  2898065728,
  853044451,
  1172266101,
  3705015759,
  2882616665,
  651767980,
  1373503546,
  3369554304,
  3218104598,
  565507253,
  1454621731,
  3485111705,
  3099436303,
  671266974,
  1594198024,
  3322730930,
  2970347812,
  795835527,
  1483230225,
  3244367275,
  3060149565,
  1994146192,
  31158534,
  2563907772,
  4023717930,
  1907459465,
  112637215,
  2680153253,
  3904427059,
  2013776290,
  251722036,
  2517215374,
  3775830040,
  2137656763,
  141376813,
  2439277719,
  3865271297,
  1802195444,
  476864866,
  2238001368,
  4066508878,
  1812370925,
  453092731,
  2181625025,
  4111451223,
  1706088902,
  314042704,
  2344532202,
  4240017532,
  1658658271,
  366619977,
  2362670323,
  4224994405,
  1303535960,
  984961486,
  2747007092,
  3569037538,
  1256170817,
  1037604311,
  2765210733,
  3554079995,
  1131014506,
  879679996,
  2909243462,
  3663771856,
  1141124467,
  855842277,
  2852801631,
  3708648649,
  1342533948,
  654459306,
  3188396048,
  3373015174,
  1466479909,
  544179635,
  3110523913,
  3462522015,
  1591671054,
  702138776,
  2966460450,
  3352799412,
  1504918807,
  783551873,
  3082640443,
  3233442989,
  3988292384,
  2596254646,
  62317068,
  1957810842,
  3939845945,
  2647816111,
  81470997,
  1943803523,
  3814918930,
  2489596804,
  225274430,
  2053790376,
  3826175755,
  2466906013,
  167816743,
  2097651377,
  4027552580,
  2265490386,
  503444072,
  1762050814,
  4150417245,
  2154129355,
  426522225,
  1852507879,
  4275313526,
  2312317920,
  282753626,
  1742555852,
  4189708143,
  2394877945,
  397917763,
  1622183637,
  3604390888,
  2714866558,
  953729732,
  1340076626,
  3518719985,
  2797360999,
  1068828381,
  1219638859,
  3624741850,
  2936675148,
  906185462,
  1090812512,
  3747672003,
  2825379669,
  829329135,
  1181335161,
  3412177804,
  3160834842,
  628085408,
  1382605366,
  3423369109,
  3138078467,
  570562233,
  1426400815,
  3317316542,
  2998733608,
  733239954,
  1555261956,
  3268935591,
  3050360625,
  752459403,
  1541320221,
  2607071920,
  3965973030,
  1969922972,
  40735498,
  2617837225,
  3943577151,
  1913087877,
  83908371,
  2512341634,
  3803740692,
  2075208622,
  213261112,
  2463272603,
  3855990285,
  2094854071,
  198958881,
  2262029012,
  4057260610,
  1759359992,
  534414190,
  2176718541,
  4139329115,
  1873836001,
  414664567,
  2282248934,
  4279200368,
  1711684554,
  285281116,
  2405801727,
  4167216745,
  1634467795,
  376229701,
  2685067896,
  3608007406,
  1308918612,
  956543938,
  2808555105,
  3495958263,
  1231636301,
  1047427035,
  2932959818,
  3654703836,
  1088359270,
  936918e3,
  2847714899,
  3736837829,
  1202900863,
  817233897,
  3183342108,
  3401237130,
  1404277552,
  615818150,
  3134207493,
  3453421203,
  1423857449,
  601450431,
  3009837614,
  3294710456,
  1567103746,
  711928724,
  3020668471,
  3272380065,
  1510334235,
  755167117
];
if (typeof Int32Array !== "undefined") {
  TABLE = new Int32Array(TABLE);
}
var crc = (current, previous) => {
  let crc2 = previous === 0 ? 0 : ~~previous ^ -1;
  for (let index = 0; index < current.length; index++) {
    crc2 = TABLE[(crc2 ^ current[index]) & 255] ^ crc2 >>> 8;
  }
  return crc2 ^ -1;
};
var LEN_SIZE = 4;
var CRC_SIZE = 4;
var PngHelpers = class _PngHelpers {
  /**
   * Checks if binary data at the specified offset contains a valid PNG file signature.
   * Validates the 8-byte PNG signature: 89 50 4E 47 0D 0A 1A 0A.
   *
   * @param view - DataView containing the binary data to check
   * @param offset - Byte offset where the PNG signature should start
   * @returns True if the data contains a valid PNG signature, false otherwise
   *
   * @example
   * ```ts
   * // Validate PNG from file upload
   * const file = event.target.files[0]
   * const buffer = await file.arrayBuffer()
   * const view = new DataView(buffer)
   *
   * if (PngHelpers.isPng(view, 0)) {
   *   console.log('Valid PNG file detected')
   *   // Process PNG file...
   * } else {
   *   console.error('Not a valid PNG file')
   * }
   * ```
   */
  static isPng(view, offset) {
    if (view.getUint8(offset + 0) === 137 && view.getUint8(offset + 1) === 80 && view.getUint8(offset + 2) === 78 && view.getUint8(offset + 3) === 71 && view.getUint8(offset + 4) === 13 && view.getUint8(offset + 5) === 10 && view.getUint8(offset + 6) === 26 && view.getUint8(offset + 7) === 10) {
      return true;
    }
    return false;
  }
  /**
   * Reads the 4-character chunk type identifier from a PNG chunk header.
   *
   * @param view - DataView containing the PNG data
   * @param offset - Byte offset of the chunk type field (after length field)
   * @returns 4-character string representing the chunk type (e.g., 'IHDR', 'IDAT', 'IEND')
   *
   * @example
   * ```ts
   * // Read chunk type from PNG header (after 8-byte signature)
   * const chunkType = PngHelpers.getChunkType(dataView, 8)
   * console.log(chunkType) // 'IHDR' (Image Header)
   *
   * // Read chunk type at a specific position during parsing
   * let offset = 8 // Skip PNG signature
   * const chunkLength = dataView.getUint32(offset)
   * const type = PngHelpers.getChunkType(dataView, offset + 4)
   * ```
   */
  static getChunkType(view, offset) {
    return [
      String.fromCharCode(view.getUint8(offset)),
      String.fromCharCode(view.getUint8(offset + 1)),
      String.fromCharCode(view.getUint8(offset + 2)),
      String.fromCharCode(view.getUint8(offset + 3))
    ].join("");
  }
  /**
   * Parses all chunks in a PNG file and returns their metadata.
   * Skips duplicate IDAT chunks but includes all other chunk types.
   *
   * @param view - DataView containing the complete PNG file data
   * @param offset - Starting byte offset (defaults to 0)
   * @returns Record mapping chunk types to their metadata (start position, data offset, and size)
   * @throws Error if the data is not a valid PNG file
   *
   * @example
   * ```ts
   * // Parse PNG structure for metadata extraction
   * const view = new DataView(await blob.arrayBuffer())
   * const chunks = PngHelpers.readChunks(view)
   *
   * // Check for specific chunks
   * const ihdrChunk = chunks['IHDR']
   * const physChunk = chunks['pHYs']
   *
   * if (physChunk) {
   *   console.log(`Found pixel density info at byte ${physChunk.start}`)
   * } else {
   *   console.log('No pixel density information found')
   * }
   * ```
   */
  static readChunks(view, offset = 0) {
    const chunks = {};
    if (!_PngHelpers.isPng(view, offset)) {
      throw new Error("Not a PNG");
    }
    offset += 8;
    while (offset <= view.buffer.byteLength) {
      const start = offset;
      const len = view.getInt32(offset);
      offset += 4;
      const chunkType = _PngHelpers.getChunkType(view, offset);
      if (chunkType === "IDAT" && chunks[chunkType]) {
        offset += len + LEN_SIZE + CRC_SIZE;
        continue;
      }
      if (chunkType === "IEND") {
        break;
      }
      chunks[chunkType] = {
        start,
        dataOffset: offset + 4,
        size: len
      };
      offset += len + LEN_SIZE + CRC_SIZE;
    }
    return chunks;
  }
  /**
   * Parses the pHYs (physical pixel dimensions) chunk data.
   * Reads pixels per unit for X and Y axes, and the unit specifier.
   *
   * @param view - DataView containing the PNG data
   * @param offset - Byte offset of the pHYs chunk data
   * @returns Object with ppux (pixels per unit X), ppuy (pixels per unit Y), and unit specifier
   *
   * @example
   * ```ts
   * // Extract pixel density information for DPI calculation
   * const physChunk = PngHelpers.findChunk(dataView, 'pHYs')
   * if (physChunk) {
   *   const physData = PngHelpers.parsePhys(dataView, physChunk.dataOffset)
   *
   *   if (physData.unit === 1) { // meters
   *     const dpiX = Math.round(physData.ppux * 0.0254)
   *     const dpiY = Math.round(physData.ppuy * 0.0254)
   *     console.log(`DPI: ${dpiX} x ${dpiY}`)
   *   }
   * }
   * ```
   */
  static parsePhys(view, offset) {
    return {
      ppux: view.getUint32(offset),
      ppuy: view.getUint32(offset + 4),
      unit: view.getUint8(offset + 8)
    };
  }
  /**
   * Finds a specific chunk type in the PNG file and returns its metadata.
   *
   * @param view - DataView containing the PNG file data
   * @param type - 4-character chunk type to search for (e.g., 'pHYs', 'IDAT')
   * @returns Chunk metadata object if found, undefined otherwise
   *
   * @example
   * ```ts
   * // Look for pixel density information in PNG
   * const physChunk = PngHelpers.findChunk(dataView, 'pHYs')
   * if (physChunk) {
   *   const physData = PngHelpers.parsePhys(dataView, physChunk.dataOffset)
   *   console.log(`Found pHYs chunk with ${physData.ppux} x ${physData.ppuy} pixels per unit`)
   * }
   *
   * // Check for text metadata
   * const textChunk = PngHelpers.findChunk(dataView, 'tEXt')
   * if (textChunk) {
   *   console.log(`Found text metadata at byte ${textChunk.start}`)
   * }
   * ```
   */
  static findChunk(view, type) {
    const chunks = _PngHelpers.readChunks(view);
    return chunks[type];
  }
  /**
   * Adds or replaces a pHYs chunk in a PNG file to set pixel density for high-DPI displays.
   * The method determines insertion point by prioritizing IDAT chunk position over existing pHYs,
   * creates a properly formatted pHYs chunk with CRC validation, and returns a new Blob.
   *
   * @param view - DataView containing the original PNG file data
   * @param dpr - Device pixel ratio multiplier (defaults to 1)
   * @param options - Optional Blob constructor options for MIME type and other properties
   * @returns New Blob containing the PNG with updated pixel density information
   *
   * @example
   * ```ts
   * // Export PNG with proper pixel density for high-DPI displays
   * const canvas = document.createElement('canvas')
   * const ctx = canvas.getContext('2d')
   * // ... draw content to canvas ...
   *
   * canvas.toBlob(async (blob) => {
   *   if (blob) {
   *     const view = new DataView(await blob.arrayBuffer())
   *     // Create 2x DPI version for Retina displays
   *     const highDpiBlob = PngHelpers.setPhysChunk(view, 2, { type: 'image/png' })
   *     // Download or use the blob...
   *   }
   * }, 'image/png')
   * ```
   */
  static setPhysChunk(view, dpr = 1, options) {
    let offset = 46;
    let size = 0;
    const res1 = _PngHelpers.findChunk(view, "pHYs");
    if (res1) {
      offset = res1.start;
      size = res1.size;
    }
    const res2 = _PngHelpers.findChunk(view, "IDAT");
    if (res2) {
      offset = res2.start;
      size = 0;
    }
    const pHYsData = new ArrayBuffer(21);
    const pHYsDataView = new DataView(pHYsData);
    pHYsDataView.setUint32(0, 9);
    pHYsDataView.setUint8(4, "p".charCodeAt(0));
    pHYsDataView.setUint8(5, "H".charCodeAt(0));
    pHYsDataView.setUint8(6, "Y".charCodeAt(0));
    pHYsDataView.setUint8(7, "s".charCodeAt(0));
    const DPI_72 = 2835.5;
    pHYsDataView.setInt32(8, DPI_72 * dpr);
    pHYsDataView.setInt32(12, DPI_72 * dpr);
    pHYsDataView.setInt8(16, 1);
    const crcBit = new Uint8Array(pHYsData.slice(4, 17));
    pHYsDataView.setInt32(17, crc(crcBit));
    const startBuf = view.buffer.slice(0, offset);
    const endBuf = view.buffer.slice(offset + size);
    return new Blob([startBuf, pHYsData, endBuf], options);
  }
};

// ../../node_modules/@tldraw/utils/dist-esm/lib/media/webp.mjs
function isWebp(view) {
  if (!view || view.length < 12) {
    return false;
  }
  return view[8] === 87 && view[9] === 69 && view[10] === 66 && view[11] === 80;
}
function isWebpAnimated(buffer) {
  const view = new Uint8Array(buffer);
  if (!isWebp(view)) {
    return false;
  }
  if (!view || view.length < 21) {
    return false;
  }
  return (view[20] >> 1 & 1) === 1;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/media/media.mjs
var DEFAULT_SUPPORTED_VECTOR_IMAGE_TYPES = Object.freeze(["image/svg+xml"]);
var DEFAULT_SUPPORTED_STATIC_IMAGE_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp"
]);
var DEFAULT_SUPPORTED_ANIMATED_IMAGE_TYPES = Object.freeze([
  "image/gif",
  "image/apng",
  "image/avif"
]);
var DEFAULT_SUPPORTED_IMAGE_TYPES = Object.freeze([
  ...DEFAULT_SUPPORTED_STATIC_IMAGE_TYPES,
  ...DEFAULT_SUPPORTED_VECTOR_IMAGE_TYPES,
  ...DEFAULT_SUPPORTED_ANIMATED_IMAGE_TYPES
]);
var DEFAULT_SUPPORT_VIDEO_TYPES = Object.freeze([
  "video/mp4",
  "video/webm",
  "video/quicktime"
]);
var DEFAULT_SUPPORTED_MEDIA_TYPES = Object.freeze([
  ...DEFAULT_SUPPORTED_IMAGE_TYPES,
  ...DEFAULT_SUPPORT_VIDEO_TYPES
]);
var DEFAULT_SUPPORTED_MEDIA_TYPE_LIST = DEFAULT_SUPPORTED_MEDIA_TYPES.join(",");
var MediaHelpers = class _MediaHelpers {
  /**
   * Load a video element from a URL with cross-origin support.
   *
   * @param src - The URL of the video to load
   * @param doc - Optional document to create the video element in
   * @returns Promise that resolves to the loaded HTMLVideoElement
   * @example
   * ```ts
   * const video = await MediaHelpers.loadVideo('https://example.com/video.mp4')
   * console.log(`Video dimensions: ${video.videoWidth}x${video.videoHeight}`)
   * ```
   * @public
   */
  static loadVideo(src, doc) {
    return new Promise((resolve, reject) => {
      const video = (doc ?? document).createElement("video");
      video.onloadeddata = () => resolve(video);
      video.onerror = (e) => {
        console.error(e);
        reject(new Error("Could not load video"));
      };
      video.crossOrigin = "anonymous";
      video.src = src;
    });
  }
  /**
   * Extract a frame from a video element as a data URL.
   *
   * @param video - The HTMLVideoElement to extract frame from
   * @param time - The time in seconds to extract the frame from (default: 0)
   * @returns Promise that resolves to a data URL of the video frame
   * @example
   * ```ts
   * const video = await MediaHelpers.loadVideo('https://example.com/video.mp4')
   * const frameDataUrl = await MediaHelpers.getVideoFrameAsDataUrl(video, 5.0)
   * // Use frameDataUrl as image thumbnail
   * const img = document.createElement('img')
   * img.src = frameDataUrl
   * ```
   * @public
   */
  static async getVideoFrameAsDataUrl(video, time = 0) {
    const promise = promiseWithResolve();
    let didSetTime = false;
    const onReadyStateChanged = () => {
      if (!didSetTime) {
        if (video.readyState >= video.HAVE_METADATA) {
          didSetTime = true;
          video.currentTime = time;
        } else {
          return;
        }
      }
      if (video.readyState >= video.HAVE_CURRENT_DATA) {
        const canvas = (video.ownerDocument ?? document).createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("Could not get 2d context");
        }
        ctx.drawImage(video, 0, 0);
        promise.resolve(canvas.toDataURL());
      }
    };
    const onError = (e) => {
      console.error(e);
      promise.reject(new Error("Could not get video frame"));
    };
    video.addEventListener("loadedmetadata", onReadyStateChanged);
    video.addEventListener("loadeddata", onReadyStateChanged);
    video.addEventListener("canplay", onReadyStateChanged);
    video.addEventListener("seeked", onReadyStateChanged);
    video.addEventListener("error", onError);
    video.addEventListener("stalled", onError);
    onReadyStateChanged();
    try {
      return await promise;
    } finally {
      video.removeEventListener("loadedmetadata", onReadyStateChanged);
      video.removeEventListener("loadeddata", onReadyStateChanged);
      video.removeEventListener("canplay", onReadyStateChanged);
      video.removeEventListener("seeked", onReadyStateChanged);
      video.removeEventListener("error", onError);
      video.removeEventListener("stalled", onError);
    }
  }
  /**
   * Load an image from a URL and get its dimensions along with the image element.
   *
   * @param src - The URL of the image to load
   * @param doc - Optional document to use for DOM operations (e.g. measuring SVG dimensions)
   * @returns Promise that resolves to an object with width, height, and the image element
   * @example
   * ```ts
   * const { w, h, image } = await MediaHelpers.getImageAndDimensions('https://example.com/image.png')
   * console.log(`Image size: ${w}x${h}`)
   * // Image is ready to use
   * document.body.appendChild(image)
   * ```
   * @public
   */
  static getImageAndDimensions(src, doc) {
    return new Promise((resolve, reject) => {
      const img = Image();
      img.onload = () => {
        let dimensions;
        if (img.naturalWidth) {
          dimensions = {
            w: img.naturalWidth,
            h: img.naturalHeight
          };
        } else {
          const body = (doc ?? document).body;
          body.appendChild(img);
          dimensions = {
            w: img.clientWidth,
            h: img.clientHeight
          };
          body.removeChild(img);
        }
        resolve({ ...dimensions, image: img });
      };
      img.onerror = (e) => {
        console.error(e);
        reject(new Error("Could not load image"));
      };
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "strict-origin-when-cross-origin";
      img.style.visibility = "hidden";
      img.style.position = "absolute";
      img.style.opacity = "0";
      img.style.zIndex = "-9999";
      img.src = src;
    });
  }
  /**
   * Get the size of a video blob
   *
   * @param blob - A Blob containing the video
   * @param doc - Optional document to create elements in
   * @returns Promise that resolves to an object with width and height properties
   * @example
   * ```ts
   * const file = new File([...], 'video.mp4', { type: 'video/mp4' })
   * const { w, h } = await MediaHelpers.getVideoSize(file)
   * console.log(`Video dimensions: ${w}x${h}`)
   * ```
   * @public
   */
  static async getVideoSize(blob, doc) {
    return _MediaHelpers.usingObjectURL(blob, async (url) => {
      const video = await _MediaHelpers.loadVideo(url, doc);
      return { w: video.videoWidth, h: video.videoHeight };
    });
  }
  /**
   * Get the size of an image blob
   *
   * @param blob - A Blob containing the image
   * @param doc - Optional document to use for DOM operations
   * @returns Promise that resolves to an object with width and height properties
   * @example
   * ```ts
   * const file = new File([...], 'image.png', { type: 'image/png' })
   * const { w, h } = await MediaHelpers.getImageSize(file)
   * console.log(`Image dimensions: ${w}x${h}`)
   * ```
   * @public
   */
  static async getImageSize(blob, doc) {
    const { w, h } = await _MediaHelpers.usingObjectURL(
      blob,
      (url) => _MediaHelpers.getImageAndDimensions(url, doc)
    );
    try {
      if (blob.type === "image/png") {
        const view = new DataView(await blob.arrayBuffer());
        if (PngHelpers.isPng(view, 0)) {
          const physChunk = PngHelpers.findChunk(view, "pHYs");
          if (physChunk) {
            const physData = PngHelpers.parsePhys(view, physChunk.dataOffset);
            if (physData.unit === 1 && physData.ppux === physData.ppuy) {
              const dpi = Math.round(physData.ppux * 0.0254);
              const r96 = dpi / 96;
              const r72 = dpi / 72;
              let pixelRatio = 1;
              if (Number.isInteger(r96) && r96 > 1) {
                pixelRatio = r96;
              } else if (Number.isInteger(r72) && r72 > 1) {
                pixelRatio = r72;
              }
              if (pixelRatio > 1) {
                return {
                  w: Math.ceil(w / pixelRatio),
                  h: Math.ceil(h / pixelRatio),
                  pixelRatio
                };
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(err);
      return { w, h, pixelRatio: 1 };
    }
    return { w, h, pixelRatio: 1 };
  }
  /**
   * Check if a media file blob contains animation data.
   *
   * @param file - The Blob to check for animation
   * @returns Promise that resolves to true if the file is animated, false otherwise
   * @example
   * ```ts
   * const file = new File([...], 'animation.gif', { type: 'image/gif' })
   * const animated = await MediaHelpers.isAnimated(file)
   * console.log(animated ? 'Animated' : 'Static')
   * ```
   * @public
   */
  static async isAnimated(file) {
    if (file.type === "image/gif") {
      return isGifAnimated(await file.arrayBuffer());
    }
    if (file.type === "image/avif") {
      return isAvifAnimated(await file.arrayBuffer());
    }
    if (file.type === "image/webp") {
      return isWebpAnimated(await file.arrayBuffer());
    }
    if (file.type === "image/apng") {
      return isApngAnimated(await file.arrayBuffer());
    }
    return false;
  }
  /**
   * Check if a MIME type represents an animated image format.
   *
   * @param mimeType - The MIME type to check
   * @returns True if the MIME type is an animated image format, false otherwise
   * @example
   * ```ts
   * const isAnimated = MediaHelpers.isAnimatedImageType('image/gif')
   * console.log(isAnimated) // true
   * ```
   * @public
   */
  static isAnimatedImageType(mimeType) {
    return DEFAULT_SUPPORTED_ANIMATED_IMAGE_TYPES.includes(mimeType || "");
  }
  /**
   * Check if a MIME type represents a static (non-animated) image format.
   *
   * @param mimeType - The MIME type to check
   * @returns True if the MIME type is a static image format, false otherwise
   * @example
   * ```ts
   * const isStatic = MediaHelpers.isStaticImageType('image/jpeg')
   * console.log(isStatic) // true
   * ```
   * @public
   */
  static isStaticImageType(mimeType) {
    return DEFAULT_SUPPORTED_STATIC_IMAGE_TYPES.includes(mimeType || "");
  }
  /**
   * Check if a MIME type represents a vector image format.
   *
   * @param mimeType - The MIME type to check
   * @returns True if the MIME type is a vector image format, false otherwise
   * @example
   * ```ts
   * const isVector = MediaHelpers.isVectorImageType('image/svg+xml')
   * console.log(isVector) // true
   * ```
   * @public
   */
  static isVectorImageType(mimeType) {
    return DEFAULT_SUPPORTED_VECTOR_IMAGE_TYPES.includes(mimeType || "");
  }
  /**
   * Check if a MIME type represents any supported image format (static, animated, or vector).
   *
   * @param mimeType - The MIME type to check
   * @returns True if the MIME type is a supported image format, false otherwise
   * @example
   * ```ts
   * const isImage = MediaHelpers.isImageType('image/png')
   * console.log(isImage) // true
   * ```
   * @public
   */
  static isImageType(mimeType) {
    return DEFAULT_SUPPORTED_IMAGE_TYPES.includes(mimeType || "");
  }
  /**
   * Utility function to create an object URL from a blob, execute a function with it, and automatically clean it up.
   *
   * @param blob - The Blob to create an object URL for
   * @param fn - Function to execute with the object URL
   * @returns Promise that resolves to the result of the function
   * @example
   * ```ts
   * const result = await MediaHelpers.usingObjectURL(imageBlob, async (url) => {
   *   const { w, h } = await MediaHelpers.getImageAndDimensions(url)
   *   return { width: w, height: h }
   * })
   * // Object URL is automatically revoked after function completes
   * console.log(`Image dimensions: ${result.width}x${result.height}`)
   * ```
   * @public
   */
  static async usingObjectURL(blob, fn) {
    const url = URL.createObjectURL(blob);
    try {
      return await fn(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
};

// ../../node_modules/@tldraw/utils/dist-esm/lib/number.mjs
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function invLerp(a, b, t) {
  return (t - a) / (b - a);
}
function rng(seed = "") {
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 0;
  function next() {
    const t = x ^ x << 11;
    x = y;
    y = z;
    z = w;
    w ^= (w >>> 19 ^ t ^ t >>> 8) >>> 0;
    return w / 4294967296 * 2;
  }
  for (let k = 0; k < seed.length + 64; k++) {
    x ^= seed.charCodeAt(k) | 0;
    next();
  }
  return next;
}
function modulate(value, rangeA, rangeB, clamp = false) {
  const [fromLow, fromHigh] = rangeA;
  const [v0, v1] = rangeB;
  const result = v0 + (value - fromLow) / (fromHigh - fromLow) * (v1 - v0);
  return clamp ? v0 < v1 ? Math.max(Math.min(result, v1), v0) : Math.max(Math.min(result, v0), v1) : result;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/object.mjs
var import_lodash = __toESM(require_lodash2(), 1);
function hasOwnProperty(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
function getOwnProperty(obj, key) {
  if (!hasOwnProperty(obj, key)) {
    return void 0;
  }
  return obj[key];
}
function objectMapKeys(object2) {
  return Object.keys(object2);
}
function objectMapValues(object2) {
  return Object.values(object2);
}
function objectMapEntries(object2) {
  return Object.entries(object2);
}
function* objectMapEntriesIterable(object2) {
  for (const key in object2) {
    if (!Object.prototype.hasOwnProperty.call(object2, key)) continue;
    yield [key, object2[key]];
  }
}
function objectMapFromEntries(entries) {
  return Object.fromEntries(entries);
}
function filterEntries(object2, predicate) {
  const result = {};
  let didChange = false;
  for (const key in object2) {
    if (!Object.prototype.hasOwnProperty.call(object2, key)) continue;
    const value = object2[key];
    if (predicate(key, value)) {
      result[key] = value;
    } else {
      didChange = true;
    }
  }
  return didChange ? result : object2;
}
function mapObjectMapValues(object2, mapper) {
  const result = {};
  for (const key in object2) {
    if (!Object.prototype.hasOwnProperty.call(object2, key)) continue;
    result[key] = mapper(key, object2[key]);
  }
  return result;
}
function areObjectsShallowEqual(obj1, obj2) {
  if (obj1 === obj2) return true;
  const keys1 = Object.keys(obj1);
  if (keys1.length !== Object.keys(obj2).length) return false;
  for (const key of keys1) {
    if (!hasOwnProperty(obj2, key)) return false;
    if (!Object.is(obj1[key], obj2[key])) return false;
  }
  return true;
}
function groupBy(array2, keySelector) {
  const result = {};
  for (const value of array2) {
    const key = keySelector(value);
    if (!result[key]) result[key] = [];
    result[key].push(value);
  }
  return result;
}
function omit(obj, keys) {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result;
}
function getChangedKeys(obj1, obj2) {
  const result = [];
  for (const key in obj1) {
    if (!Object.is(obj1[key], obj2[key])) {
      result.push(key);
    }
  }
  return result;
}
function isEqualAllowingForFloatingPointErrors(obj1, obj2, threshold = 1e-6) {
  return (0, import_lodash.default)(obj1, obj2, (value1, value2) => {
    if (typeof value1 === "number" && typeof value2 === "number") {
      return Math.abs(value1 - value2) < threshold;
    }
    return void 0;
  });
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/perf.mjs
var PERFORMANCE_COLORS = {
  Good: "#40C057",
  Mid: "#FFC078",
  Poor: "#E03131"
};
var PERFORMANCE_PREFIX_COLOR = PERFORMANCE_COLORS.Good;
function measureCbDuration(name, cb) {
  const start = performance.now();
  const result = cb();
  console.debug(
    `%cPerf%c ${name} took ${performance.now() - start}ms`,
    `color: white; background: ${PERFORMANCE_PREFIX_COLOR};padding: 2px;border-radius: 3px;`,
    "font-weight: normal"
  );
  return result;
}
function measureDuration(_target, propertyKey, descriptor) {
  const originalMethod = descriptor.value;
  descriptor.value = function(...args) {
    const start = performance.now();
    const result = originalMethod.apply(this, args);
    console.debug(
      `%cPerf%c ${propertyKey} took: ${performance.now() - start}ms`,
      `color: white; background: ${PERFORMANCE_PREFIX_COLOR};padding: 2px;border-radius: 3px;`,
      "font-weight: normal"
    );
    return result;
  };
  return descriptor;
}
var averages = /* @__PURE__ */ new Map();
function measureAverageDuration(_target, propertyKey, descriptor) {
  const originalMethod = descriptor.value;
  descriptor.value = function(...args) {
    const start = performance.now();
    const result = originalMethod.apply(this, args);
    const end = performance.now();
    const length = end - start;
    if (length !== 0) {
      const value = averages.get(descriptor.value);
      const total = value.total + length;
      const count = value.count + 1;
      averages.set(descriptor.value, { total, count });
      console.debug(
        `%cPerf%c ${propertyKey} took ${(end - start).toFixed(2)}ms | average ${(total / count).toFixed(2)}ms`,
        `color: white; background: ${PERFORMANCE_PREFIX_COLOR};padding: 2px;border-radius: 3px;`,
        "font-weight: normal"
      );
    }
    return result;
  };
  averages.set(descriptor.value, { total: 0, count: 0 });
  return descriptor;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/PerformanceTracker.mjs
var PerformanceTracker = class {
  startTime = 0;
  name = "";
  frames = 0;
  started = false;
  frame = null;
  /**
   * Records animation frames to calculate frame rate.
   * Called automatically during performance tracking.
   */
  // eslint-disable-next-line tldraw/prefer-class-methods
  recordFrame = () => {
    this.frames++;
    if (!this.started) return;
    this.frame = requestAnimationFrame(this.recordFrame);
  };
  /**
   * Starts performance tracking for a named operation.
   *
   * @param name - A descriptive name for the operation being tracked
   *
   * @example
   * ```ts
   * tracker.start('canvas-render')
   * // ... perform rendering operations
   * tracker.stop()
   * ```
   */
  start(name) {
    this.name = name;
    this.frames = 0;
    this.started = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.recordFrame);
    this.startTime = performance.now();
  }
  /**
   * Stops performance tracking and logs results to the console.
   *
   * Displays the operation name, frame rate, and uses color coding:
   * - Green background: \> 55 FPS (good performance)
   * - Yellow background: 30-55 FPS (moderate performance)
   * - Red background: \< 30 FPS (poor performance)
   *
   * @example
   * ```ts
   * tracker.start('interaction')
   * handleUserInteraction()
   * tracker.stop() // Logs: "Perf Interaction 60 fps"
   * ```
   */
  stop() {
    this.started = false;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    const duration = (performance.now() - this.startTime) / 1e3;
    const fps = duration === 0 ? 0 : Math.floor(this.frames / duration);
    const background = fps > 55 ? PERFORMANCE_COLORS.Good : fps > 30 ? PERFORMANCE_COLORS.Mid : PERFORMANCE_COLORS.Poor;
    const color = background === PERFORMANCE_COLORS.Mid ? "black" : "white";
    const capitalized = this.name[0].toUpperCase() + this.name.slice(1);
    console.debug(
      `%cPerf%c ${capitalized} %c${fps}%c fps`,
      `color: white; background: ${PERFORMANCE_PREFIX_COLOR};padding: 2px;border-radius: 3px;`,
      "font-weight: normal",
      `font-weight: bold; padding: 2px; background: ${background};color: ${color};`,
      "font-weight: normal"
    );
  }
  /**
   * Checks whether performance tracking is currently active.
   *
   * @returns True if tracking is in progress, false otherwise
   *
   * @example
   * ```ts
   * if (!tracker.isStarted()) {
   *   tracker.start('new-operation')
   * }
   * ```
   */
  isStarted() {
    return this.started;
  }
};

// ../../node_modules/@tldraw/utils/dist-esm/lib/fractionalIndexing.mjs
var DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
var ZERO = DIGITS[0];
var LARGEST_DIGIT = DIGITS[DIGITS.length - 1];
var SMALLEST_INTEGER = "A" + ZERO.repeat(26);
var JITTER_BITS = 16;
function getIntegerLength(head) {
  if (head >= "a" && head <= "z") {
    return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  } else if (head >= "A" && head <= "Z") {
    return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  }
  throw new Error("invalid order key head: " + head);
}
function getIntegerPart(key) {
  const integerPartLength = getIntegerLength(key[0]);
  if (integerPartLength > key.length) {
    throw new Error("invalid order key: " + key);
  }
  return key.slice(0, integerPartLength);
}
function digitIndex(char) {
  const code = char.charCodeAt(0);
  if (code <= 57) return code - 48;
  if (code <= 90) return code - 55;
  return code - 61;
}
function validateOrderKey(key) {
  if (key === SMALLEST_INTEGER) {
    throw new Error("invalid order key: " + key);
  }
  const i = getIntegerPart(key);
  if (key.length > i.length && key[key.length - 1] === ZERO) {
    throw new Error("invalid order key: " + key);
  }
}
function midpoint(a, b) {
  if (b != null && a >= b) {
    throw new Error(a + " >= " + b);
  }
  if (a.slice(-1) === ZERO || b && b.slice(-1) === ZERO) {
    throw new Error("trailing zero");
  }
  if (b) {
    let n = 0;
    while ((a[n] || ZERO) === b[n]) {
      n++;
    }
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
    }
  }
  const digitA = a ? digitIndex(a[0]) : 0;
  const digitB = b != null ? digitIndex(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) {
    const midDigit = Math.round(0.5 * (digitA + digitB));
    return DIGITS[midDigit];
  }
  if (b && b.length > 1) {
    return b.slice(0, 1);
  }
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}
function incrementInteger(x) {
  const [head, ...digs] = x.split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digitIndex(digs[i]) + 1;
    if (d === DIGITS.length) {
      digs[i] = ZERO;
    } else {
      digs[i] = DIGITS[d];
      carry = false;
    }
  }
  if (carry) {
    if (head === "Z") return "a" + ZERO;
    if (head === "z") return null;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > "a") {
      digs.push(ZERO);
    } else {
      digs.pop();
    }
    return h + digs.join("");
  }
  return head + digs.join("");
}
function decrementInteger(x) {
  const [head, ...digs] = x.split("");
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = digitIndex(digs[i]) - 1;
    if (d === -1) {
      digs[i] = LARGEST_DIGIT;
    } else {
      digs[i] = DIGITS[d];
      borrow = false;
    }
  }
  if (borrow) {
    if (head === "a") return "Z" + LARGEST_DIGIT;
    if (head === "A") return null;
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < "Z") {
      digs.push(LARGEST_DIGIT);
    } else {
      digs.pop();
    }
    return h + digs.join("");
  }
  return head + digs.join("");
}
function keyBetweenUnchecked(a, b) {
  if (a != null && b != null && a >= b) {
    throw new Error(a + " >= " + b);
  }
  if (a == null) {
    if (b == null) return "a" + ZERO;
    const ib2 = getIntegerPart(b);
    const fb2 = b.slice(ib2.length);
    if (ib2 === SMALLEST_INTEGER) {
      return ib2 + midpoint("", fb2);
    }
    if (ib2 < b) return ib2;
    const res = decrementInteger(ib2);
    if (res == null) throw new Error("cannot decrement any more");
    return res;
  }
  if (b == null) {
    const ia2 = getIntegerPart(a);
    const fa2 = a.slice(ia2.length);
    const i2 = incrementInteger(ia2);
    return i2 == null ? ia2 + midpoint(fa2, null) : i2;
  }
  const ia = getIntegerPart(a);
  const fa = a.slice(ia.length);
  const ib = getIntegerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) {
    return ia + midpoint(fa, fb);
  }
  const i = incrementInteger(ia);
  if (i == null) throw new Error("cannot increment any more");
  if (i < b) return i;
  return ia + midpoint(fa, null);
}
function nKeysBetweenUnchecked(a, b, n) {
  if (n === 0) return [];
  if (n === 1) return [keyBetweenUnchecked(a, b)];
  if (b == null) {
    let c2 = keyBetweenUnchecked(a, b);
    const result = [c2];
    for (let i = 0; i < n - 1; i++) {
      c2 = keyBetweenUnchecked(c2, b);
      result.push(c2);
    }
    return result;
  }
  if (a == null) {
    let c2 = keyBetweenUnchecked(a, b);
    const result = [c2];
    for (let i = 0; i < n - 1; i++) {
      c2 = keyBetweenUnchecked(a, c2);
      result.push(c2);
    }
    result.reverse();
    return result;
  }
  const mid = Math.floor(n / 2);
  const c = keyBetweenUnchecked(a, b);
  return [...nKeysBetweenUnchecked(a, c, mid), c, ...nKeysBetweenUnchecked(c, b, n - mid - 1)];
}
function jitterBetween(low, high) {
  let mid = keyBetweenUnchecked(low, high);
  for (let i = 0; i < JITTER_BITS; i++) {
    if (Math.random() < 0.5) {
      low = mid;
    } else {
      high = mid;
    }
    mid = keyBetweenUnchecked(low, high);
  }
  return mid;
}
function generateNJitteredKeysBetween(a, b, n) {
  if (n === 0) return [];
  if (a != null) validateOrderKey(a);
  if (b != null) validateOrderKey(b);
  const keys = nKeysBetweenUnchecked(a, b, n + 1);
  const result = new Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = jitterBetween(keys[i], keys[i + 1]);
  }
  return result;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/reordering.mjs
var generateKeysFn = false ? generateNKeysBetween : generateNJitteredKeysBetween;
var ZERO_INDEX_KEY = "a0";
function validateIndexKey(index) {
  try {
    validateOrderKey(index);
  } catch {
    throw new Error("invalid index: " + index);
  }
}
function getIndicesBetween(below, above, n) {
  return generateKeysFn(below ?? null, above ?? null, n);
}
function getIndicesAbove(below, n) {
  return generateKeysFn(below ?? null, null, n);
}
function getIndicesBelow(above, n) {
  return generateKeysFn(null, above ?? null, n);
}
function getIndexBetween(below, above) {
  return generateKeysFn(below ?? null, above ?? null, 1)[0];
}
function getIndexAbove(below = null) {
  return generateKeysFn(below, null, 1)[0];
}
function getIndexBelow(above = null) {
  return generateKeysFn(null, above, 1)[0];
}
function getIndices(n, start = "a1") {
  return [start, ...generateKeysFn(start, null, n)];
}
function sortByIndex(a, b) {
  if (a.index < b.index) {
    return -1;
  } else if (a.index > b.index) {
    return 1;
  }
  return 0;
}
function sortByMaybeIndex(a, b) {
  if (a.index && b.index) {
    return a.index < b.index ? -1 : 1;
  }
  if (a.index && b.index == null) {
    return -1;
  }
  if (a.index == null && b.index == null) {
    return 0;
  }
  return 1;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/retry.mjs
async function retry(fn, {
  attempts = 3,
  waitDuration = 1e3,
  abortSignal,
  matchError
} = {}) {
  let error = null;
  for (let i = 0; i < attempts; i++) {
    if (abortSignal?.aborted) throw new Error("aborted");
    try {
      return await fn({ attempt: i, remaining: attempts - i, total: attempts });
    } catch (e) {
      if (matchError && !matchError(e)) throw e;
      error = e;
      await sleep(waitDuration);
    }
  }
  throw error;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/sort.mjs
function sortById(a, b) {
  return a.id > b.id ? 1 : -1;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/storage.mjs
function getFromLocalStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function setInLocalStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
  }
}
function deleteFromLocalStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch {
  }
}
function clearLocalStorage() {
  try {
    localStorage.clear();
  } catch {
  }
}
function getFromSessionStorage(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function setInSessionStorage(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
  }
}
function deleteFromSessionStorage(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {
  }
}
function clearSessionStorage() {
  try {
    sessionStorage.clear();
  } catch {
  }
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/string.mjs
var graphemeSegmenter;
function getFirstCharacter(str) {
  if (!str) return "";
  graphemeSegmenter ??= new Intl.Segmenter(void 0, { granularity: "grapheme" });
  for (const { segment } of graphemeSegmenter.segment(str)) {
    return segment;
  }
  return "";
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/stringEnum.mjs
function stringEnum(...values) {
  const obj = {};
  for (const value of values) {
    obj[value] = value;
  }
  return obj;
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/throttle.mjs
var isTest = () => typeof process !== "undefined" && false;
var timingVarianceFactor = 0.9;
var getTargetTimePerFrame = (targetFps) => Math.floor(1e3 / targetFps) * timingVarianceFactor;
var FpsScheduler = class {
  targetFps;
  targetTimePerFrame;
  fpsQueue = [];
  frameRaf;
  flushRaf;
  lastFlushTime;
  constructor(targetFps = 120) {
    this.targetFps = targetFps;
    this.targetTimePerFrame = getTargetTimePerFrame(targetFps);
    this.lastFlushTime = -this.targetTimePerFrame;
  }
  updateTargetFps(targetFps) {
    if (targetFps === this.targetFps) return;
    this.targetFps = targetFps;
    this.targetTimePerFrame = getTargetTimePerFrame(targetFps);
    this.lastFlushTime = -this.targetTimePerFrame;
  }
  flush() {
    const queue = this.fpsQueue.splice(0, this.fpsQueue.length);
    for (const fn of queue) {
      fn();
    }
  }
  tick(isOnNextFrame = false) {
    if (this.frameRaf) return;
    const now = Date.now();
    const elapsed = now - this.lastFlushTime;
    if (elapsed < this.targetTimePerFrame) {
      this.frameRaf = requestAnimationFrame(() => {
        this.frameRaf = void 0;
        this.tick(true);
      });
      return;
    }
    if (isOnNextFrame) {
      if (this.flushRaf) return;
      this.lastFlushTime = now;
      this.flush();
    } else {
      if (this.flushRaf) return;
      this.flushRaf = requestAnimationFrame(() => {
        this.flushRaf = void 0;
        this.lastFlushTime = Date.now();
        this.flush();
      });
    }
  }
  /**
   * Creates a throttled version of a function that executes at most once per frame.
   * The default target frame rate is set by the FpsScheduler instance.
   * Subsequent calls within the same frame are ignored, ensuring smooth performance
   * for high-frequency events like mouse movements or scroll events.
   *
   * @param fn - The function to throttle, optionally with a cancel method
   * @returns A throttled function with an optional cancel method to remove pending calls
   *
   * @public
   */
  fpsThrottle(fn) {
    if (isTest()) {
      fn.cancel = () => {
        if (this.frameRaf) {
          cancelAnimationFrame(this.frameRaf);
          this.frameRaf = void 0;
        }
        if (this.flushRaf) {
          cancelAnimationFrame(this.flushRaf);
          this.flushRaf = void 0;
        }
      };
      return fn;
    }
    const throttledFn = () => {
      if (this.fpsQueue.includes(fn)) {
        return;
      }
      this.fpsQueue.push(fn);
      this.tick();
    };
    throttledFn.cancel = () => {
      const index = this.fpsQueue.indexOf(fn);
      if (index > -1) {
        this.fpsQueue.splice(index, 1);
      }
    };
    return throttledFn;
  }
  /**
   * Schedules a function to execute on the next animation frame.
   * If the same function is passed multiple times before the frame executes,
   * it will only be called once, effectively batching multiple calls.
   *
   * @param fn - The function to execute on the next frame
   * @returns A cancel function that can prevent execution if called before the next frame
   *
   * @public
   */
  throttleToNextFrame(fn) {
    if (isTest()) {
      fn();
      return () => void 0;
    }
    if (!this.fpsQueue.includes(fn)) {
      this.fpsQueue.push(fn);
      this.tick();
    }
    return () => {
      const index = this.fpsQueue.indexOf(fn);
      if (index > -1) {
        this.fpsQueue.splice(index, 1);
      }
    };
  }
};
var defaultScheduler = new FpsScheduler(120);
function fpsThrottle(fn) {
  return defaultScheduler.fpsThrottle(fn);
}
function throttleToNextFrame(fn) {
  return defaultScheduler.throttleToNextFrame(fn);
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/timers.mjs
var Timers = class {
  timeouts = /* @__PURE__ */ new Map();
  intervals = /* @__PURE__ */ new Map();
  rafs = /* @__PURE__ */ new Map();
  /**
   * Creates a new Timers instance with bound methods for safe callback usage.
   * @example
   * ```ts
   * const timers = new Timers()
   * // Methods are pre-bound, safe to use as callbacks
   * element.addEventListener('click', timers.dispose)
   * ```
   */
  constructor() {
    this.setTimeout = this.setTimeout.bind(this);
    this.setInterval = this.setInterval.bind(this);
    this.requestAnimationFrame = this.requestAnimationFrame.bind(this);
    this.dispose = this.dispose.bind(this);
  }
  /**
   * Creates a timeout that will be tracked under the specified context.
   * @param contextId - The context identifier to group this timer under.
   * @param handler - The function to execute when the timeout expires.
   * @param timeout - The delay in milliseconds (default: 0).
   * @param args - Additional arguments to pass to the handler.
   * @returns The timer ID that can be used with clearTimeout.
   * @example
   * ```ts
   * const timers = new Timers()
   * const id = timers.setTimeout('autosave', () => save(), 5000)
   * // Timer will be automatically cleared when 'autosave' context is disposed
   * ```
   * @public
   */
  setTimeout(contextId, handler, timeout, ...args) {
    const id = window.setTimeout(handler, timeout, args);
    const current = this.timeouts.get(contextId) ?? [];
    this.timeouts.set(contextId, [...current, id]);
    return id;
  }
  /**
   * Creates an interval that will be tracked under the specified context.
   * @param contextId - The context identifier to group this timer under.
   * @param handler - The function to execute repeatedly.
   * @param timeout - The delay in milliseconds between executions (default: 0).
   * @param args - Additional arguments to pass to the handler.
   * @returns The interval ID that can be used with clearInterval.
   * @example
   * ```ts
   * const timers = new Timers()
   * const id = timers.setInterval('refresh', () => updateData(), 1000)
   * // Interval will be automatically cleared when 'refresh' context is disposed
   * ```
   * @public
   */
  setInterval(contextId, handler, timeout, ...args) {
    const id = window.setInterval(handler, timeout, args);
    const current = this.intervals.get(contextId) ?? [];
    this.intervals.set(contextId, [...current, id]);
    return id;
  }
  /**
   * Requests an animation frame that will be tracked under the specified context.
   * @param contextId - The context identifier to group this animation frame under.
   * @param callback - The function to execute on the next animation frame.
   * @returns The request ID that can be used with cancelAnimationFrame.
   * @example
   * ```ts
   * const timers = new Timers()
   * const id = timers.requestAnimationFrame('render', () => draw())
   * // Animation frame will be automatically cancelled when 'render' context is disposed
   * ```
   * @public
   */
  requestAnimationFrame(contextId, callback) {
    const id = window.requestAnimationFrame(callback);
    const current = this.rafs.get(contextId) ?? [];
    this.rafs.set(contextId, [...current, id]);
    return id;
  }
  /**
   * Disposes of all timers associated with the specified context.
   * Clears all timeouts, intervals, and animation frames for the given context ID.
   * @param contextId - The context identifier whose timers should be cleared.
   * @returns void
   * @example
   * ```ts
   * const timers = new Timers()
   * timers.setTimeout('ui', () => console.log('timeout'), 1000)
   * timers.setInterval('ui', () => console.log('interval'), 500)
   *
   * // Clear all 'ui' context timers
   * timers.dispose('ui')
   * ```
   * @public
   */
  dispose(contextId) {
    this.timeouts.get(contextId)?.forEach((id) => clearTimeout(id));
    this.intervals.get(contextId)?.forEach((id) => clearInterval(id));
    this.rafs.get(contextId)?.forEach((id) => cancelAnimationFrame(id));
    this.timeouts.delete(contextId);
    this.intervals.delete(contextId);
    this.rafs.delete(contextId);
  }
  /**
   * Disposes of all timers across all contexts.
   * Clears every timeout, interval, and animation frame managed by this instance.
   * @returns void
   * @example
   * ```ts
   * const timers = new Timers()
   * timers.setTimeout('ui', () => console.log('ui'), 1000)
   * timers.setTimeout('background', () => console.log('bg'), 2000)
   *
   * // Clear everything
   * timers.disposeAll()
   * ```
   * @public
   */
  disposeAll() {
    for (const contextId of this.timeouts.keys()) {
      this.dispose(contextId);
    }
  }
  /**
   * Returns an object with timer methods bound to a specific context.
   * Convenient for getting context-specific timer functions without repeatedly passing the contextId.
   * @param contextId - The context identifier to bind the returned methods to.
   * @returns An object with setTimeout, setInterval, requestAnimationFrame, and dispose methods bound to the context.
   * @example
   * ```ts
   * const timers = new Timers()
   * const uiTimers = timers.forContext('ui')
   *
   * // These are equivalent to calling timers.setTimeout('ui', ...)
   * uiTimers.setTimeout(() => console.log('timeout'), 1000)
   * uiTimers.setInterval(() => console.log('interval'), 500)
   * uiTimers.requestAnimationFrame(() => console.log('frame'))
   *
   * // Dispose only this context
   * uiTimers.dispose()
   * ```
   * @public
   */
  forContext(contextId) {
    return {
      setTimeout: (handler, timeout, ...args) => this.setTimeout(contextId, handler, timeout, args),
      setInterval: (handler, timeout, ...args) => this.setInterval(contextId, handler, timeout, args),
      requestAnimationFrame: (callback) => this.requestAnimationFrame(contextId, callback),
      dispose: () => this.dispose(contextId)
    };
  }
};

// ../../node_modules/@tldraw/utils/dist-esm/lib/url.mjs
function safeParseUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl);
  } catch {
    return;
  }
}

// ../../node_modules/@tldraw/utils/dist-esm/lib/value.mjs
function isDefined(value) {
  return value !== void 0;
}
function isNonNull(value) {
  return value !== null;
}
function isNonNullish(value) {
  return value !== null && value !== void 0;
}
function getStructuredClone() {
  if (typeof globalThis !== "undefined" && globalThis.structuredClone) {
    return [globalThis.structuredClone, true];
  }
  if (typeof global !== "undefined" && global.structuredClone) {
    return [global.structuredClone, true];
  }
  if (typeof window !== "undefined" && window.structuredClone) {
    return [window.structuredClone, true];
  }
  return [(i) => i ? JSON.parse(JSON.stringify(i)) : i, false];
}
var _structuredClone = getStructuredClone();
var structuredClone = _structuredClone[0];
var isNativeStructuredClone = _structuredClone[1];
var STRUCTURED_CLONE_OBJECT_PROTOTYPE = Object.getPrototypeOf(structuredClone({}));

// ../../node_modules/@tldraw/utils/dist-esm/lib/warn.mjs
var usedWarnings = /* @__PURE__ */ new Set();
function warnDeprecatedGetter(name) {
  warnOnce(
    `Using '${name}' is deprecated and will be removed in the near future. Please refactor to use 'get${name[0].toLocaleUpperCase()}${name.slice(
      1
    )}' instead.`
  );
}
function warnOnce(message) {
  if (usedWarnings.has(message)) return;
  usedWarnings.add(message);
  console.warn(`[tldraw] ${message}`);
}

// ../../node_modules/@tldraw/utils/dist-esm/index.mjs
registerTldrawLibraryVersion(
  "@tldraw/utils",
  "5.3.2",
  "esm"
);

// ../../node_modules/@tldraw/validate/dist-esm/lib/validation.mjs
var validation_exports = {};
__export(validation_exports, {
  ArrayOfValidator: () => ArrayOfValidator,
  DictValidator: () => DictValidator,
  ObjectValidator: () => ObjectValidator,
  UnionValidator: () => UnionValidator,
  ValidationError: () => ValidationError,
  Validator: () => Validator,
  any: () => any,
  array: () => array,
  arrayOf: () => arrayOf,
  bigint: () => bigint,
  boolean: () => boolean,
  dict: () => dict,
  httpUrl: () => httpUrl,
  indexKey: () => indexKey,
  integer: () => integer,
  jsonDict: () => jsonDict,
  jsonValue: () => jsonValue,
  linkUrl: () => linkUrl,
  literal: () => literal,
  literalEnum: () => literalEnum,
  model: () => model,
  nonZeroFiniteNumber: () => nonZeroFiniteNumber,
  nonZeroInteger: () => nonZeroInteger,
  nonZeroNumber: () => nonZeroNumber,
  nullable: () => nullable,
  number: () => number,
  numberUnion: () => numberUnion,
  object: () => object,
  optional: () => optional,
  or: () => or,
  positiveInteger: () => positiveInteger,
  positiveNumber: () => positiveNumber,
  setEnum: () => setEnum,
  srcUrl: () => srcUrl,
  string: () => string,
  union: () => union,
  unitInterval: () => unitInterval,
  unknown: () => unknown,
  unknownObject: () => unknownObject
});
var IS_DEV = true;
function formatPath(path) {
  if (!path.length) {
    return null;
  }
  let formattedPath = "";
  for (const item of path) {
    if (typeof item === "number") {
      formattedPath += `.${item}`;
    } else if (item.startsWith("(")) {
      if (formattedPath.endsWith(")")) {
        formattedPath = `${formattedPath.slice(0, -1)}, ${item.slice(1)}`;
      } else {
        formattedPath += item;
      }
    } else {
      formattedPath += `.${item}`;
    }
  }
  formattedPath = formattedPath.replace(/id = [^,]+, /, "").replace(/id = [^)]+/, "");
  if (formattedPath.startsWith(".")) {
    return formattedPath.slice(1);
  }
  return formattedPath;
}
var ValidationError = class extends Error {
  /**
   * Creates a new ValidationError with contextual information about where the error occurred.
   *
   * rawMessage - The raw error message without path information
   * path - Array indicating the location in the data structure where validation failed
   */
  constructor(rawMessage, path = []) {
    const formattedPath = formatPath(path);
    const indentedMessage = rawMessage.split("\n").map((line, i) => i === 0 ? line : `  ${line}`).join("\n");
    super(formattedPath ? `At ${formattedPath}: ${indentedMessage}` : indentedMessage);
    this.rawMessage = rawMessage;
    this.path = path;
  }
  rawMessage;
  path;
  name = "ValidationError";
};
function rethrowPrefixed(path, err) {
  if (err instanceof ValidationError) {
    throw new ValidationError(err.rawMessage, [path, ...err.path]);
  }
  throw new ValidationError(err.toString(), [path]);
}
function typeToString(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  switch (type) {
    case "bigint":
    case "boolean":
    case "function":
    case "number":
    case "string":
    case "symbol":
      return `a ${type}`;
    case "object":
      return `an ${type}`;
    case "undefined":
      return "undefined";
    default:
      exhaustiveSwitchError(type);
  }
}
var Validator = class _Validator {
  /**
   * Creates a new Validator instance.
   *
   * validationFn - Function that validates and returns a value of type T
   * validateUsingKnownGoodVersionFn - Optional performance-optimized validation function
   * skipSameValueCheck - Internal flag to skip dev check for validators that transform values
   */
  constructor(validationFn, validateUsingKnownGoodVersionFn, skipSameValueCheck = false) {
    this.validationFn = validationFn;
    this.validateUsingKnownGoodVersionFn = validateUsingKnownGoodVersionFn;
    this.skipSameValueCheck = skipSameValueCheck;
  }
  validationFn;
  validateUsingKnownGoodVersionFn;
  skipSameValueCheck;
  /**
   * Validates an unknown value and returns it with the correct type. The returned value is
   * guaranteed to be referentially equal to the passed value.
   *
   * @param value - The unknown value to validate
   * @returns The validated value with type T
   * @throws ValidationError When validation fails
   * @example
   * ```ts
   * import { T } from '@tldraw/validate'
   *
   * const name = T.string.validate("Alice") // Returns "Alice" as string
   * const title = T.string.validate("") // Returns "" (empty strings are valid)
   *
   * // These will throw ValidationError:
   * T.string.validate(123) // Expected string, got a number
   * T.string.validate(null) // Expected string, got null
   * T.string.validate(undefined) // Expected string, got undefined
   * ```
   */
  validate(value) {
    const validated = this.validationFn(value);
    if (IS_DEV && !this.skipSameValueCheck && !Object.is(value, validated)) {
      throw new ValidationError("Validator functions must return the same value they were passed");
    }
    return validated;
  }
  /**
   * Performance-optimized validation using a previously validated value. If the new value
   * is referentially equal to the known good value, returns the known good value immediately.
   *
   * @param knownGoodValue - A previously validated value
   * @param newValue - The new value to validate
   * @returns The validated value, potentially reusing the known good value
   * @throws ValidationError When validation fails
   * @example
   * ```ts
   * import { T } from '@tldraw/validate'
   *
   * const userValidator = T.object({
   *   name: T.string,
   *   settings: T.object({ theme: T.literalEnum('light', 'dark') })
   * })
   *
   * const user = userValidator.validate({ name: "Alice", settings: { theme: "light" } })
   *
   * // Later, with partially changed data:
   * const newData = { name: "Alice", settings: { theme: "dark" } }
   * const updated = userValidator.validateUsingKnownGoodVersion(user, newData)
   * // Only validates the changed 'theme' field for better performance
   * ```
   */
  validateUsingKnownGoodVersion(knownGoodValue, newValue) {
    if (Object.is(knownGoodValue, newValue)) {
      return knownGoodValue;
    }
    if (this.validateUsingKnownGoodVersionFn) {
      return this.validateUsingKnownGoodVersionFn(knownGoodValue, newValue);
    }
    return this.validate(newValue);
  }
  /**
   * Type guard that checks if a value is valid without throwing an error.
   *
   * @param value - The value to check
   * @returns True if the value is valid, false otherwise
   * @example
   * ```ts
   * import { T } from '@tldraw/validate'
   *
   * function processUserInput(input: unknown) {
   *   if (T.string.isValid(input)) {
   *     // input is now typed as string within this block
   *     return input.toUpperCase()
   *   }
   *   if (T.number.isValid(input)) {
   *     // input is now typed as number within this block
   *     return input.toFixed(2)
   *   }
   *   throw new Error('Expected string or number')
   * }
   * ```
   */
  isValid(value) {
    try {
      this.validate(value);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Returns a new validator that also accepts null values.
   *
   * @returns A new validator that accepts T or null
   * @example
   * ```ts
   * import { T } from '@tldraw/validate'
   *
   * const assetValidator = T.object({
   *   id: T.string,
   *   name: T.string,
   *   src: T.srcUrl.nullable(), // Can be null if not loaded yet
   *   mimeType: T.string.nullable()
   * })
   *
   * const asset = assetValidator.validate({
   *   id: "image-123",
   *   name: "photo.jpg",
   *   src: null, // Valid - asset not loaded yet
   *   mimeType: "image/jpeg"
   * })
   * ```
   */
  nullable() {
    return nullable(this);
  }
  /**
   * Returns a new validator that also accepts undefined values.
   *
   * @returns A new validator that accepts T or undefined
   * @example
   * ```ts
   * import { T } from '@tldraw/validate'
   *
   * const shapeConfigValidator = T.object({
   *   type: T.literal('rectangle'),
   *   x: T.number,
   *   y: T.number,
   *   label: T.string.optional(), // Optional property
   *   metadata: T.object({ created: T.string }).optional()
   * })
   *
   * // Both of these are valid:
   * const shape1 = shapeConfigValidator.validate({ type: 'rectangle', x: 0, y: 0 })
   * const shape2 = shapeConfigValidator.validate({
   *   type: 'rectangle', x: 0, y: 0, label: "My Shape"
   * })
   * ```
   */
  optional() {
    return optional(this);
  }
  /**
   * Creates a new validator by refining this validator with additional logic that can transform
   * the validated value to a new type.
   *
   * @param otherValidationFn - Function that transforms/validates the value to type U
   * @returns A new validator that validates to type U
   * @throws ValidationError When validation or refinement fails
   * @example
   * ```ts
   * import { T, ValidationError } from '@tldraw/validate'
   *
   * // Transform string to ensure it starts with a prefix
   * const prefixedIdValidator = T.string.refine((id) => {
   *   return id.startsWith('shape:') ? id : `shape:${id}`
   * })
   *
   * const id1 = prefixedIdValidator.validate("rectangle-123") // Returns "shape:rectangle-123"
   * const id2 = prefixedIdValidator.validate("shape:circle-456") // Returns "shape:circle-456"
   *
   * // Parse and validate JSON strings
   * const jsonValidator = T.string.refine((str) => {
   *   try {
   *     return JSON.parse(str)
   *   } catch {
   *     throw new ValidationError('Invalid JSON string')
   *   }
   * })
   * ```
   */
  refine(otherValidationFn) {
    return new _Validator(
      (value) => {
        return otherValidationFn(this.validate(value));
      },
      (knownGoodValue, newValue) => {
        const validated = this.validateUsingKnownGoodVersion(knownGoodValue, newValue);
        if (Object.is(knownGoodValue, validated)) {
          return knownGoodValue;
        }
        return otherValidationFn(validated);
      },
      true
      // skipSameValueCheck: refine is designed to transform values
    );
  }
  check(nameOrCheckFn, checkFn) {
    if (typeof nameOrCheckFn === "string") {
      return this.refine((value) => {
        try {
          checkFn(value);
        } catch (err) {
          rethrowPrefixed(`(check ${nameOrCheckFn})`, err);
        }
        return value;
      });
    } else {
      return this.refine((value) => {
        nameOrCheckFn(value);
        return value;
      });
    }
  }
};
var ArrayOfValidator = class extends Validator {
  /**
   * Creates a new ArrayOfValidator.
   *
   * itemValidator - Validator used to validate each array element
   */
  constructor(itemValidator) {
    super(
      (value) => {
        const arr = array.validate(value);
        for (let i = 0; i < arr.length; i++) {
          try {
            itemValidator.validate(arr[i]);
          } catch (err) {
            rethrowPrefixed(i, err);
          }
        }
        return arr;
      },
      (knownGoodValue, newValue) => {
        if (Object.is(knownGoodValue, newValue)) {
          return knownGoodValue;
        }
        if (!itemValidator.validateUsingKnownGoodVersion) return this.validate(newValue);
        const arr = array.validate(newValue);
        let isDifferent = knownGoodValue.length !== arr.length;
        for (let i = 0; i < arr.length; i++) {
          const item = arr[i];
          if (i >= knownGoodValue.length) {
            isDifferent = true;
            try {
              itemValidator.validate(item);
            } catch (err) {
              rethrowPrefixed(i, err);
            }
            continue;
          }
          if (Object.is(knownGoodValue[i], item)) {
            continue;
          }
          try {
            const checkedItem = itemValidator.validateUsingKnownGoodVersion(
              knownGoodValue[i],
              item
            );
            if (!Object.is(checkedItem, knownGoodValue[i])) {
              isDifferent = true;
            }
          } catch (err) {
            rethrowPrefixed(i, err);
          }
        }
        return isDifferent ? newValue : knownGoodValue;
      }
    );
    this.itemValidator = itemValidator;
  }
  itemValidator;
  /**
   * Returns a new validator that ensures the array is not empty.
   *
   * @returns A new validator that rejects empty arrays
   * @throws ValidationError When the array is empty
   * @example
   * ```ts
   * const nonEmptyStrings = T.arrayOf(T.string).nonEmpty()
   * nonEmptyStrings.validate(["hello"]) // Valid
   * nonEmptyStrings.validate([]) // Throws ValidationError
   * ```
   */
  nonEmpty() {
    return this.check((value) => {
      if (value.length === 0) {
        throw new ValidationError("Expected a non-empty array");
      }
    });
  }
  /**
   * Returns a new validator that ensures the array has more than one element.
   *
   * @returns A new validator that requires at least 2 elements
   * @throws ValidationError When the array has 1 or fewer elements
   * @example
   * ```ts
   * const multipleItems = T.arrayOf(T.string).lengthGreaterThan1()
   * multipleItems.validate(["a", "b"]) // Valid
   * multipleItems.validate(["a"]) // Throws ValidationError
   * ```
   */
  lengthGreaterThan1() {
    return this.check((value) => {
      if (value.length <= 1) {
        throw new ValidationError("Expected an array with length greater than 1");
      }
    });
  }
};
var ObjectValidator = class _ObjectValidator extends Validator {
  /**
   * Creates a new ObjectValidator.
   *
   * config - Object mapping property names to their validators
   * shouldAllowUnknownProperties - Whether to allow properties not defined in config
   */
  constructor(config, shouldAllowUnknownProperties = false) {
    const configKeys = [];
    const configValidators = [];
    for (const [key, validator] of Object.entries(config)) {
      configKeys.push(key);
      configValidators.push(validator);
    }
    super(
      (object2) => {
        if (typeof object2 !== "object" || object2 === null) {
          throw new ValidationError(`Expected object, got ${typeToString(object2)}`);
        }
        for (let i = 0; i < configKeys.length; i++) {
          const key = configKeys[i];
          try {
            configValidators[i].validate(getOwnProperty(object2, key));
          } catch (err) {
            rethrowPrefixed(key, err);
          }
        }
        if (!shouldAllowUnknownProperties) {
          for (const key in object2) {
            if (!hasOwnProperty(object2, key)) continue;
            if (!hasOwnProperty(config, key)) {
              throw new ValidationError(`Unexpected property`, [key]);
            }
          }
        }
        return object2;
      },
      (knownGoodValue, newValue) => {
        if (Object.is(knownGoodValue, newValue)) {
          return knownGoodValue;
        }
        if (typeof newValue !== "object" || newValue === null) {
          throw new ValidationError(`Expected object, got ${typeToString(newValue)}`);
        }
        let isDifferent = false;
        for (let i = 0; i < configKeys.length; i++) {
          const key = configKeys[i];
          const prev = getOwnProperty(knownGoodValue, key);
          const next = getOwnProperty(newValue, key);
          if (Object.is(prev, next)) {
            continue;
          }
          try {
            const validator = configValidators[i];
            const checked = validator.validateUsingKnownGoodVersion ? validator.validateUsingKnownGoodVersion(prev, next) : validator.validate(next);
            if (!Object.is(checked, prev)) {
              isDifferent = true;
            }
          } catch (err) {
            rethrowPrefixed(key, err);
          }
        }
        if (!shouldAllowUnknownProperties) {
          for (const key in newValue) {
            if (!hasOwnProperty(newValue, key)) continue;
            if (!hasOwnProperty(config, key)) {
              throw new ValidationError(`Unexpected property`, [key]);
            }
          }
        } else if (!isDifferent) {
          for (const key of Object.keys(newValue)) {
            if (!hasOwnProperty(config, key) && !Object.is(getOwnProperty(knownGoodValue, key), getOwnProperty(newValue, key))) {
              isDifferent = true;
              break;
            }
          }
        }
        if (!isDifferent) {
          for (const key in knownGoodValue) {
            if (!hasOwnProperty(knownGoodValue, key)) continue;
            if (!hasOwnProperty(newValue, key)) {
              isDifferent = true;
              break;
            }
          }
        }
        return isDifferent ? newValue : knownGoodValue;
      }
    );
    this.config = config;
    this.shouldAllowUnknownProperties = shouldAllowUnknownProperties;
  }
  config;
  shouldAllowUnknownProperties;
  /**
   * Returns a new validator that allows unknown properties in the validated object.
   *
   * @returns A new ObjectValidator that accepts extra properties
   * @example
   * ```ts
   * const flexibleUser = T.object({ name: T.string }).allowUnknownProperties()
   * flexibleUser.validate({ name: "Alice", extra: "allowed" }) // Valid
   * ```
   */
  allowUnknownProperties() {
    return new _ObjectValidator(this.config, true);
  }
  /**
   * Creates a new ObjectValidator by extending this validator with additional properties.
   *
   * @param extension - Object mapping new property names to their validators
   * @returns A new ObjectValidator that validates both original and extended properties
   * @example
   * ```ts
   * const baseUser = T.object({ name: T.string, age: T.number })
   * const adminUser = baseUser.extend({
   *   permissions: T.arrayOf(T.string),
   *   isAdmin: T.boolean
   * })
   * // adminUser validates: { name: string; age: number; permissions: string[]; isAdmin: boolean }
   * ```
   */
  extend(extension) {
    return new _ObjectValidator({ ...this.config, ...extension });
  }
};
var UnionValidator = class _UnionValidator extends Validator {
  /**
   * Creates a new UnionValidator.
   *
   * key - The discriminator property name used to determine the variant
   * config - Object mapping variant names to their validators
   * unknownValueValidation - Function to handle unknown variants
   * useNumberKeys - Whether the discriminator uses number keys instead of strings
   */
  constructor(key, config, unknownValueValidation, useNumberKeys) {
    super(
      (input) => {
        this.expectObject(input);
        const matchingSchema = this.getMatchingSchema(input);
        if (matchingSchema === void 0) {
          return this.unknownValueValidation(input, this.getVariant(input));
        }
        try {
          return matchingSchema.validate(input);
        } catch (err) {
          rethrowPrefixed(`(${key} = ${this.getVariant(input)})`, err);
        }
      },
      (prevValue, newValue) => {
        this.expectObject(newValue);
        this.expectObject(prevValue);
        const matchingSchema = this.getMatchingSchema(newValue);
        if (matchingSchema === void 0) {
          return this.unknownValueValidation(newValue, this.getVariant(newValue));
        }
        try {
          if (getOwnProperty(prevValue, key) !== getOwnProperty(newValue, key)) {
            return matchingSchema.validate(newValue);
          }
          if (matchingSchema.validateUsingKnownGoodVersion) {
            return matchingSchema.validateUsingKnownGoodVersion(prevValue, newValue);
          } else {
            return matchingSchema.validate(newValue);
          }
        } catch (err) {
          rethrowPrefixed(`(${key} = ${this.getVariant(newValue)})`, err);
        }
      }
    );
    this.key = key;
    this.config = config;
    this.unknownValueValidation = unknownValueValidation;
    this.useNumberKeys = useNumberKeys;
  }
  key;
  config;
  unknownValueValidation;
  useNumberKeys;
  expectObject(value) {
    if (typeof value !== "object" || value === null) {
      throw new ValidationError(`Expected an object, got ${typeToString(value)}`, []);
    }
  }
  getVariant(object2) {
    return getOwnProperty(object2, this.key);
  }
  // Returns the matching schema for the object's variant, or undefined if the variant is
  // unknown. The variant itself is only needed on cold paths (unknown variants and errors),
  // so this avoids allocating a `{ matchingSchema, variant }` result per validation.
  getMatchingSchema(object2) {
    const variant = getOwnProperty(object2, this.key);
    if (!this.useNumberKeys && typeof variant !== "string") {
      throw new ValidationError(
        `Expected a string for key "${this.key}", got ${typeToString(variant)}`
      );
    } else if (this.useNumberKeys) {
      const numVariant = Number(variant);
      if (numVariant - numVariant !== 0) {
        throw new ValidationError(
          `Expected a number for key "${this.key}", got "${variant}"`
        );
      }
    }
    return hasOwnProperty(this.config, variant) ? this.config[variant] : void 0;
  }
  /**
   * Returns a new UnionValidator that can handle unknown variants using the provided function.
   *
   * @param unknownValueValidation - Function to validate/transform unknown variants
   * @returns A new UnionValidator that accepts unknown variants
   * @example
   * ```ts
   * const shapeValidator = T.union('type', { circle: circleValidator })
   *   .validateUnknownVariants((obj, variant) => {
   *     console.warn(`Unknown shape type: ${variant}`)
   *     return obj as UnknownShape
   *   })
   * ```
   */
  validateUnknownVariants(unknownValueValidation) {
    return new _UnionValidator(this.key, this.config, unknownValueValidation, this.useNumberKeys);
  }
};
var DictValidator = class extends Validator {
  /**
   * Creates a new DictValidator.
   *
   * keyValidator - Validator for object keys
   * valueValidator - Validator for object values
   */
  constructor(keyValidator, valueValidator) {
    super(
      (object2) => {
        if (typeof object2 !== "object" || object2 === null) {
          throw new ValidationError(`Expected object, got ${typeToString(object2)}`);
        }
        for (const key in object2) {
          if (!hasOwnProperty(object2, key)) continue;
          try {
            keyValidator.validate(key);
            valueValidator.validate(object2[key]);
          } catch (err) {
            rethrowPrefixed(key, err);
          }
        }
        return object2;
      },
      (knownGoodValue, newValue) => {
        if (typeof newValue !== "object" || newValue === null) {
          throw new ValidationError(`Expected object, got ${typeToString(newValue)}`);
        }
        const newObj = newValue;
        let isDifferent = false;
        let newKeyCount = 0;
        for (const key in newObj) {
          if (!hasOwnProperty(newObj, key)) continue;
          newKeyCount++;
          const next = newObj[key];
          if (!hasOwnProperty(knownGoodValue, key)) {
            isDifferent = true;
            try {
              keyValidator.validate(key);
              valueValidator.validate(next);
            } catch (err) {
              rethrowPrefixed(key, err);
            }
            continue;
          }
          const prev = knownGoodValue[key];
          if (Object.is(prev, next)) {
            continue;
          }
          try {
            const checked = valueValidator.validateUsingKnownGoodVersion ? valueValidator.validateUsingKnownGoodVersion(prev, next) : valueValidator.validate(next);
            if (!Object.is(checked, prev)) {
              isDifferent = true;
            }
          } catch (err) {
            rethrowPrefixed(key, err);
          }
        }
        if (!isDifferent) {
          let oldKeyCount = 0;
          for (const key in knownGoodValue) {
            if (hasOwnProperty(knownGoodValue, key)) {
              oldKeyCount++;
            }
          }
          if (oldKeyCount !== newKeyCount) {
            isDifferent = true;
          }
        }
        return isDifferent ? newValue : knownGoodValue;
      }
    );
    this.keyValidator = keyValidator;
    this.valueValidator = valueValidator;
  }
  keyValidator;
  valueValidator;
};
function typeofValidator(type) {
  return new Validator((value) => {
    if (typeof value !== type) {
      throw new ValidationError(`Expected ${type}, got ${typeToString(value)}`);
    }
    return value;
  });
}
var unknown = new Validator((value) => value);
var any = new Validator((value) => value);
var string = typeofValidator("string");
var number = new Validator((value) => {
  if (Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "number") {
    throw new ValidationError(`Expected number, got ${typeToString(value)}`);
  }
  if (value !== value) {
    throw new ValidationError("Expected a number, got NaN");
  }
  throw new ValidationError(`Expected a finite number, got ${value}`);
});
var positiveNumber = new Validator((value) => {
  if (Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "number") {
    throw new ValidationError(`Expected number, got ${typeToString(value)}`);
  }
  if (value !== value) {
    throw new ValidationError("Expected a number, got NaN");
  }
  if (value < 0) {
    throw new ValidationError(`Expected a positive number, got ${value}`);
  }
  throw new ValidationError(`Expected a finite number, got ${value}`);
});
var nonZeroNumber = new Validator((value) => {
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== "number") {
    throw new ValidationError(`Expected number, got ${typeToString(value)}`);
  }
  if (value !== value) {
    throw new ValidationError("Expected a number, got NaN");
  }
  if (value <= 0) {
    throw new ValidationError(`Expected a non-zero positive number, got ${value}`);
  }
  throw new ValidationError(`Expected a finite number, got ${value}`);
});
var nonZeroFiniteNumber = new Validator((value) => {
  if (Number.isFinite(value) && value !== 0) {
    return value;
  }
  if (typeof value !== "number") {
    throw new ValidationError(`Expected number, got ${typeToString(value)}`);
  }
  if (value !== value) {
    throw new ValidationError("Expected a number, got NaN");
  }
  if (value === 0) {
    throw new ValidationError(`Expected a non-zero number, got 0`);
  }
  throw new ValidationError(`Expected a finite number, got ${value}`);
});
var unitInterval = new Validator((value) => {
  if (Number.isFinite(value) && value >= 0 && value <= 1) {
    return value;
  }
  if (typeof value !== "number") {
    throw new ValidationError(`Expected number, got ${typeToString(value)}`);
  }
  if (value !== value) {
    throw new ValidationError("Expected a number, got NaN");
  }
  throw new ValidationError(`Expected a number between 0 and 1, got ${value}`);
});
var integer = new Validator((value) => {
  if (Number.isInteger(value)) {
    return value;
  }
  if (typeof value !== "number") {
    throw new ValidationError(`Expected number, got ${typeToString(value)}`);
  }
  if (value !== value) {
    throw new ValidationError("Expected a number, got NaN");
  }
  if (value - value !== 0) {
    throw new ValidationError(`Expected a finite number, got ${value}`);
  }
  throw new ValidationError(`Expected an integer, got ${value}`);
});
var positiveInteger = new Validator((value) => {
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "number") {
    throw new ValidationError(`Expected number, got ${typeToString(value)}`);
  }
  if (value !== value) {
    throw new ValidationError("Expected a number, got NaN");
  }
  if (value - value !== 0) {
    throw new ValidationError(`Expected a finite number, got ${value}`);
  }
  if (value < 0) {
    throw new ValidationError(`Expected a positive integer, got ${value}`);
  }
  throw new ValidationError(`Expected an integer, got ${value}`);
});
var nonZeroInteger = new Validator((value) => {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "number") {
    throw new ValidationError(`Expected number, got ${typeToString(value)}`);
  }
  if (value !== value) {
    throw new ValidationError("Expected a number, got NaN");
  }
  if (value - value !== 0) {
    throw new ValidationError(`Expected a finite number, got ${value}`);
  }
  if (value <= 0) {
    throw new ValidationError(`Expected a non-zero positive integer, got ${value}`);
  }
  throw new ValidationError(`Expected an integer, got ${value}`);
});
var boolean = typeofValidator("boolean");
var bigint = typeofValidator("bigint");
function literal(expectedValue) {
  return new Validator((actualValue) => {
    if (actualValue !== expectedValue) {
      throw new ValidationError(`Expected ${expectedValue}, got ${JSON.stringify(actualValue)}`);
    }
    return expectedValue;
  });
}
var array = new Validator((value) => {
  if (!Array.isArray(value)) {
    throw new ValidationError(`Expected an array, got ${typeToString(value)}`);
  }
  return value;
});
function arrayOf(itemValidator) {
  return new ArrayOfValidator(itemValidator);
}
var unknownObject = new Validator((value) => {
  if (typeof value !== "object" || value === null) {
    throw new ValidationError(`Expected object, got ${typeToString(value)}`);
  }
  return value;
});
function object(config) {
  return new ObjectValidator(config);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value) === STRUCTURED_CLONE_OBJECT_PROTOTYPE);
}
function isValidJson(value) {
  if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!isValidJson(value[i])) return false;
    }
    return true;
  }
  if (isPlainObject(value)) {
    for (const key in value) {
      if (!hasOwnProperty(value, key)) continue;
      if (!isValidJson(value[key])) return false;
    }
    return true;
  }
  return false;
}
var jsonValue = new Validator(
  (value) => {
    if (isValidJson(value)) {
      return value;
    }
    throw new ValidationError(`Expected json serializable value, got ${typeof value}`);
  },
  (knownGoodValue, newValue) => {
    if (Array.isArray(knownGoodValue) && Array.isArray(newValue)) {
      let isDifferent = knownGoodValue.length !== newValue.length;
      for (let i = 0; i < newValue.length; i++) {
        if (i >= knownGoodValue.length) {
          isDifferent = true;
          jsonValue.validate(newValue[i]);
          continue;
        }
        const prev = knownGoodValue[i];
        const next = newValue[i];
        if (Object.is(prev, next)) {
          continue;
        }
        const checked = jsonValue.validateUsingKnownGoodVersion(prev, next);
        if (!Object.is(checked, prev)) {
          isDifferent = true;
        }
      }
      return isDifferent ? newValue : knownGoodValue;
    } else if (isPlainObject(knownGoodValue) && isPlainObject(newValue)) {
      let isDifferent = false;
      for (const key in newValue) {
        if (!hasOwnProperty(newValue, key)) continue;
        if (!hasOwnProperty(knownGoodValue, key)) {
          isDifferent = true;
          jsonValue.validate(newValue[key]);
          continue;
        }
        const prev = knownGoodValue[key];
        const next = newValue[key];
        if (Object.is(prev, next)) {
          continue;
        }
        const checked = jsonValue.validateUsingKnownGoodVersion(prev, next);
        if (!Object.is(checked, prev)) {
          isDifferent = true;
        }
      }
      if (!isDifferent) {
        for (const key in knownGoodValue) {
          if (!hasOwnProperty(knownGoodValue, key)) continue;
          if (!hasOwnProperty(newValue, key)) {
            isDifferent = true;
            break;
          }
        }
      }
      return isDifferent ? newValue : knownGoodValue;
    } else {
      return jsonValue.validate(newValue);
    }
  }
);
function jsonDict() {
  return dict(string, jsonValue);
}
function dict(keyValidator, valueValidator) {
  return new DictValidator(keyValidator, valueValidator);
}
function union(key, config) {
  return new UnionValidator(
    key,
    config,
    (_unknownValue, unknownVariant) => {
      throw new ValidationError(
        `Expected one of ${Object.keys(config).map((key2) => JSON.stringify(key2)).join(" or ")}, got ${JSON.stringify(unknownVariant)}`,
        [key]
      );
    },
    false
  );
}
function numberUnion(key, config) {
  return new UnionValidator(
    key,
    config,
    (unknownValue, unknownVariant) => {
      throw new ValidationError(
        `Expected one of ${Object.keys(config).map((key2) => JSON.stringify(key2)).join(" or ")}, got ${JSON.stringify(unknownVariant)}`,
        [key]
      );
    },
    true
  );
}
function model(name, validator) {
  return new Validator(
    (value) => {
      try {
        return validator.validate(value);
      } catch (err) {
        rethrowPrefixed(name, err);
      }
    },
    (prevValue, newValue) => {
      try {
        if (validator.validateUsingKnownGoodVersion) {
          return validator.validateUsingKnownGoodVersion(prevValue, newValue);
        } else {
          return validator.validate(newValue);
        }
      } catch (err) {
        rethrowPrefixed(name, err);
      }
    }
  );
}
function setEnum(values) {
  return new Validator((value) => {
    if (!values.has(value)) {
      const valuesString = Array.from(values, (value2) => JSON.stringify(value2)).join(" or ");
      throw new ValidationError(`Expected ${valuesString}, got ${value}`);
    }
    return value;
  });
}
function optional(validator) {
  return new Validator(
    (value) => {
      if (value === void 0) return void 0;
      return validator.validate(value);
    },
    (knownGoodValue, newValue) => {
      if (newValue === void 0) return void 0;
      if (validator.validateUsingKnownGoodVersion && knownGoodValue !== void 0) {
        return validator.validateUsingKnownGoodVersion(knownGoodValue, newValue);
      }
      return validator.validate(newValue);
    },
    // Propagate skipSameValueCheck from inner validator to allow refine wrappers
    validator instanceof Validator && validator.skipSameValueCheck
  );
}
function nullable(validator) {
  return new Validator(
    (value) => {
      if (value === null) return null;
      return validator.validate(value);
    },
    (knownGoodValue, newValue) => {
      if (newValue === null) return null;
      if (validator.validateUsingKnownGoodVersion && knownGoodValue !== null) {
        return validator.validateUsingKnownGoodVersion(knownGoodValue, newValue);
      }
      return validator.validate(newValue);
    },
    // Propagate skipSameValueCheck from inner validator to allow refine wrappers
    validator instanceof Validator && validator.skipSameValueCheck
  );
}
function literalEnum(...values) {
  return setEnum(new Set(values));
}
function parseUrl(str) {
  try {
    return new URL(str);
  } catch {
    if (str.startsWith("/") || str.startsWith("./")) {
      try {
        return new URL(str, "http://example.com");
      } catch {
        throw new ValidationError(`Expected a valid url, got ${JSON.stringify(str)}`);
      }
    }
    throw new ValidationError(`Expected a valid url, got ${JSON.stringify(str)}`);
  }
}
var validLinkProtocols = /* @__PURE__ */ new Set(["http:", "https:", "mailto:"]);
var linkUrl = string.check((value) => {
  if (value === "") return;
  const url = parseUrl(value);
  if (!validLinkProtocols.has(url.protocol.toLowerCase())) {
    throw new ValidationError(
      `Expected a valid url, got ${JSON.stringify(value)} (invalid protocol)`
    );
  }
});
var validSrcProtocols = /* @__PURE__ */ new Set(["http:", "https:", "data:", "asset:"]);
var srcUrl = string.check((value) => {
  if (value === "") return;
  const url = parseUrl(value);
  if (!validSrcProtocols.has(url.protocol.toLowerCase())) {
    throw new ValidationError(
      `Expected a valid url, got ${JSON.stringify(value)} (invalid protocol)`
    );
  }
});
var httpUrl = string.check((value) => {
  if (value === "") return;
  const url = parseUrl(value);
  if (!url.protocol.toLowerCase().match(/^https?:$/)) {
    throw new ValidationError(
      `Expected a valid url, got ${JSON.stringify(value)} (invalid protocol)`
    );
  }
});
var indexKey = string.refine((key) => {
  try {
    validateIndexKey(key);
    return key;
  } catch {
    throw new ValidationError(`Expected an index key, got ${JSON.stringify(key)}`);
  }
});
function or(v1, v2) {
  return new Validator((value) => {
    try {
      return v1.validate(value);
    } catch {
      return v2.validate(value);
    }
  });
}

// ../../node_modules/@tldraw/validate/dist-esm/index.mjs
registerTldrawLibraryVersion(
  "@tldraw/validate",
  "5.3.2",
  "esm"
);

// ../../node_modules/@tldraw/tlschema/dist-esm/misc/id-validator.mjs
function idValidator(prefix) {
  return validation_exports.string.refine((id) => {
    if (!id.startsWith(`${prefix}:`)) {
      throw new Error(`${prefix} ID must start with "${prefix}:"`);
    }
    return id;
  });
}

// ../../node_modules/@tldraw/tlschema/dist-esm/assets/TLBaseAsset.mjs
var assetIdValidator = idValidator("asset");
function createAssetValidator(type, props, meta) {
  const propsValidator = props instanceof validation_exports.Validator ? props : props ? validation_exports.object(props) : validation_exports.jsonValue;
  return validation_exports.object({
    id: assetIdValidator,
    typeName: validation_exports.literal("asset"),
    type: validation_exports.literal(type),
    props: propsValidator,
    meta: meta ? validation_exports.object(meta) : validation_exports.jsonValue
  });
}

// ../../node_modules/@tldraw/state/dist-esm/lib/helpers.mjs
function isChild(x) {
  return x && typeof x === "object" && "parents" in x;
}
function haveParentsChanged(child) {
  for (let i = 0, n = child.parents.length; i < n; i++) {
    child.parents[i].__unsafe__getWithoutCapture(true);
    if (child.parents[i].lastChangedEpoch !== child.parentEpochs[i]) {
      return true;
    }
  }
  return false;
}
function detach(parent, child) {
  if (!parent.children.remove(child)) {
    return;
  }
  if (parent.children.isEmpty && isChild(parent)) {
    for (let i = 0, n = parent.parents.length; i < n; i++) {
      detach(parent.parents[i], parent);
    }
  }
}
function attach(parent, child) {
  if (!parent.children.add(child)) {
    return;
  }
  if (isChild(parent)) {
    for (let i = 0, n = parent.parents.length; i < n; i++) {
      attach(parent.parents[i], parent);
    }
  }
}
function equals(a, b) {
  const shallowEquals = a === b || Object.is(a, b) || Boolean(a && b && typeof a.equals === "function" && a.equals(b));
  return shallowEquals;
}
function singleton(key, init) {
  const symbol = /* @__PURE__ */ Symbol.for(`com.tldraw.state/${key}`);
  const global2 = globalThis;
  global2[symbol] ??= init();
  return global2[symbol];
}
var EMPTY_ARRAY = singleton("empty_array", () => Object.freeze([]));

// ../../node_modules/@tldraw/state/dist-esm/lib/ArraySet.mjs
var ARRAY_SIZE_THRESHOLD = 8;
var ArraySet = class {
  arraySize = 0;
  array = Array(ARRAY_SIZE_THRESHOLD);
  set = null;
  /**
   * Get whether this ArraySet has any elements.
   *
   * @returns True if this ArraySet has any elements, false otherwise.
   */
  // eslint-disable-next-line tldraw/no-setter-getter
  get isEmpty() {
    if (this.array) {
      return this.arraySize === 0;
    }
    if (this.set) {
      return this.set.size === 0;
    }
    throw new Error("no set or array");
  }
  /**
   * Add an element to the ArraySet if it is not already present.
   *
   * @param elem - The element to add to the set
   * @returns `true` if the element was added, `false` if it was already present
   * @example
   * ```ts
   * const arraySet = new ArraySet<string>()
   *
   * console.log(arraySet.add('hello')) // true
   * console.log(arraySet.add('hello')) // false (already exists)
   * ```
   */
  add(elem) {
    if (this.array) {
      const idx = this.array.indexOf(elem);
      if (idx !== -1) {
        return false;
      }
      if (this.arraySize < ARRAY_SIZE_THRESHOLD) {
        this.array[this.arraySize] = elem;
        this.arraySize++;
        return true;
      } else {
        this.set = new Set(this.array);
        this.array = null;
        this.set.add(elem);
        return true;
      }
    }
    if (this.set) {
      if (this.set.has(elem)) {
        return false;
      }
      this.set.add(elem);
      return true;
    }
    throw new Error("no set or array");
  }
  /**
   * Remove an element from the ArraySet if it is present.
   *
   * @param elem - The element to remove from the set
   * @returns `true` if the element was removed, `false` if it was not present
   * @example
   * ```ts
   * const arraySet = new ArraySet<string>()
   * arraySet.add('hello')
   *
   * console.log(arraySet.remove('hello')) // true
   * console.log(arraySet.remove('hello')) // false (not present)
   * ```
   */
  remove(elem) {
    if (this.array) {
      const idx = this.array.indexOf(elem);
      if (idx === -1) {
        return false;
      }
      this.array[idx] = void 0;
      this.arraySize--;
      if (idx !== this.arraySize) {
        this.array[idx] = this.array[this.arraySize];
        this.array[this.arraySize] = void 0;
      }
      return true;
    }
    if (this.set) {
      if (!this.set.has(elem)) {
        return false;
      }
      this.set.delete(elem);
      return true;
    }
    throw new Error("no set or array");
  }
  /**
   * Execute a callback function for each element in the ArraySet.
   *
   * @param visitor - A function to call for each element in the set
   * @example
   * ```ts
   * const arraySet = new ArraySet<string>()
   * arraySet.add('hello')
   * arraySet.add('world')
   *
   * arraySet.visit((item) => {
   *   console.log(item) // 'hello', 'world'
   * })
   * ```
   */
  visit(visitor) {
    if (this.array) {
      for (let i = 0; i < this.arraySize; i++) {
        const elem = this.array[i];
        if (typeof elem !== "undefined") {
          visitor(elem);
        }
      }
      return;
    }
    if (this.set) {
      this.set.forEach(visitor);
      return;
    }
    throw new Error("no set or array");
  }
  /**
   * Make the ArraySet iterable, allowing it to be used in for...of loops and with spread syntax.
   *
   * @returns An iterator that yields each element in the set
   * @example
   * ```ts
   * const arraySet = new ArraySet<number>()
   * arraySet.add(1)
   * arraySet.add(2)
   *
   * for (const item of arraySet) {
   *   console.log(item) // 1, 2
   * }
   *
   * const items = [...arraySet] // [1, 2]
   * ```
   */
  *[Symbol.iterator]() {
    if (this.array) {
      for (let i = 0; i < this.arraySize; i++) {
        const elem = this.array[i];
        if (typeof elem !== "undefined") {
          yield elem;
        }
      }
    } else if (this.set) {
      yield* this.set;
    } else {
      throw new Error("no set or array");
    }
  }
  /**
   * Check whether an element is present in the ArraySet.
   *
   * @param elem - The element to check for
   * @returns `true` if the element is present, `false` otherwise
   * @example
   * ```ts
   * const arraySet = new ArraySet<string>()
   * arraySet.add('hello')
   *
   * console.log(arraySet.has('hello')) // true
   * console.log(arraySet.has('world')) // false
   * ```
   */
  has(elem) {
    if (this.array) {
      return this.array.indexOf(elem) !== -1;
    } else {
      return this.set.has(elem);
    }
  }
  /**
   * Remove all elements from the ArraySet.
   *
   * @example
   * ```ts
   * const arraySet = new ArraySet<string>()
   * arraySet.add('hello')
   * arraySet.add('world')
   *
   * arraySet.clear()
   * console.log(arraySet.size()) // 0
   * ```
   */
  clear() {
    if (this.set) {
      this.set.clear();
    } else {
      this.arraySize = 0;
      this.array = [];
    }
  }
  /**
   * Get the number of elements in the ArraySet.
   *
   * @returns The number of elements in the set
   * @example
   * ```ts
   * const arraySet = new ArraySet<string>()
   * console.log(arraySet.size()) // 0
   *
   * arraySet.add('hello')
   * console.log(arraySet.size()) // 1
   * ```
   */
  size() {
    if (this.set) {
      return this.set.size;
    } else {
      return this.arraySize;
    }
  }
};

// ../../node_modules/@tldraw/state/dist-esm/lib/isComputed.mjs
function isComputed(value) {
  return !!(value && value.__isComputed === true);
}

// ../../node_modules/@tldraw/state/dist-esm/lib/capture.mjs
var CaptureStackFrame = class {
  constructor(below, child) {
    this.below = below;
    this.child = child;
  }
  below;
  child;
  offset = 0;
  maybeRemoved;
};
var inst = singleton("capture", () => ({ stack: null }));
function unsafe__withoutCapture(fn) {
  const oldStack = inst.stack;
  inst.stack = null;
  try {
    return fn();
  } finally {
    inst.stack = oldStack;
  }
}
function startCapturingParents(child) {
  inst.stack = new CaptureStackFrame(inst.stack, child);
  if (child.__debug_ancestor_epochs__) {
    const previousAncestorEpochs = child.__debug_ancestor_epochs__;
    child.__debug_ancestor_epochs__ = null;
    for (const p of child.parents) {
      p.__unsafe__getWithoutCapture(true);
    }
    logChangedAncestors(child, previousAncestorEpochs);
  }
  child.parentSet.clear();
}
function stopCapturingParents() {
  const frame = inst.stack;
  inst.stack = frame.below;
  if (frame.offset < frame.child.parents.length) {
    for (let i = frame.offset; i < frame.child.parents.length; i++) {
      const maybeRemovedParent = frame.child.parents[i];
      if (!frame.child.parentSet.has(maybeRemovedParent)) {
        detach(maybeRemovedParent, frame.child);
      }
    }
    frame.child.parents.length = frame.offset;
    frame.child.parentEpochs.length = frame.offset;
  }
  if (frame.maybeRemoved) {
    for (let i = 0; i < frame.maybeRemoved.length; i++) {
      const maybeRemovedParent = frame.maybeRemoved[i];
      if (!frame.child.parentSet.has(maybeRemovedParent)) {
        detach(maybeRemovedParent, frame.child);
      }
    }
  }
  if (frame.child.__debug_ancestor_epochs__) {
    captureAncestorEpochs(frame.child, frame.child.__debug_ancestor_epochs__);
  }
}
function maybeCaptureParent(p) {
  if (inst.stack) {
    const wasCapturedAlready = inst.stack.child.parentSet.has(p);
    if (wasCapturedAlready) {
      return;
    }
    inst.stack.child.parentSet.add(p);
    if (inst.stack.child.isActivelyListening) {
      attach(p, inst.stack.child);
    }
    if (inst.stack.offset < inst.stack.child.parents.length) {
      const maybeRemovedParent = inst.stack.child.parents[inst.stack.offset];
      if (maybeRemovedParent !== p) {
        if (!inst.stack.maybeRemoved) {
          inst.stack.maybeRemoved = [maybeRemovedParent];
        } else {
          inst.stack.maybeRemoved.push(maybeRemovedParent);
        }
      }
    }
    inst.stack.child.parents[inst.stack.offset] = p;
    inst.stack.child.parentEpochs[inst.stack.offset] = p.lastChangedEpoch;
    inst.stack.offset++;
  }
}
function whyAmIRunning() {
  const child = inst.stack?.child;
  if (!child) {
    throw new Error("whyAmIRunning() called outside of a reactive context");
  }
  child.__debug_ancestor_epochs__ = /* @__PURE__ */ new Map();
}
function captureAncestorEpochs(child, ancestorEpochs) {
  for (let i = 0; i < child.parents.length; i++) {
    const parent = child.parents[i];
    const epoch = child.parentEpochs[i];
    ancestorEpochs.set(parent, epoch);
    if (isComputed(parent)) {
      captureAncestorEpochs(parent, ancestorEpochs);
    }
  }
  return ancestorEpochs;
}
function collectChangedAncestors(child, ancestorEpochs) {
  const changeTree = {};
  for (let i = 0; i < child.parents.length; i++) {
    const parent = child.parents[i];
    if (!ancestorEpochs.has(parent)) {
      continue;
    }
    const prevEpoch = ancestorEpochs.get(parent);
    const currentEpoch = parent.lastChangedEpoch;
    if (currentEpoch !== prevEpoch) {
      if (isComputed(parent)) {
        changeTree[parent.name] = collectChangedAncestors(parent, ancestorEpochs);
      } else {
        changeTree[parent.name] = null;
      }
    }
  }
  return changeTree;
}
function logChangedAncestors(child, ancestorEpochs) {
  const changeTree = collectChangedAncestors(child, ancestorEpochs);
  if (Object.keys(changeTree).length === 0) {
    console.log(`Effect(${child.name}) was executed manually.`);
    return;
  }
  let str = isComputed(child) ? `Computed(${child.name}) is recomputing because:` : `Effect(${child.name}) is executing because:`;
  function logParent(tree, indent) {
    const indentStr = "\n" + " ".repeat(indent) + "↳ ";
    for (const [name, val] of Object.entries(tree)) {
      if (val) {
        str += `${indentStr}Computed(${name}) changed`;
        logParent(val, indent + 2);
      } else {
        str += `${indentStr}Atom(${name}) changed`;
      }
    }
  }
  logParent(changeTree, 1);
  console.log(str);
}

// ../../node_modules/@tldraw/state/dist-esm/lib/types.mjs
var RESET_VALUE = /* @__PURE__ */ Symbol.for("com.tldraw.state/RESET_VALUE");

// ../../node_modules/@tldraw/state/dist-esm/lib/HistoryBuffer.mjs
var HistoryBuffer = class {
  /**
   * Creates a new HistoryBuffer with the specified capacity.
   *
   * capacity - Maximum number of diffs to store in the buffer
   * @example
   * ```ts
   * const buffer = new HistoryBuffer<number>(10) // Store up to 10 diffs
   * ```
   */
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }
  capacity;
  /**
   * Current write position in the circular buffer.
   * @internal
   */
  index = 0;
  /**
   * Circular buffer storing range tuples. Uses undefined to represent empty slots.
   * @internal
   */
  buffer;
  /**
   * Adds a diff entry to the history buffer, representing a change between two epochs.
   *
   * If the diff is undefined, the operation is ignored. If the diff is RESET_VALUE,
   * the entire buffer is cleared to indicate that historical tracking should restart.
   *
   * @param lastComputedEpoch - The epoch when the previous value was computed
   * @param currentEpoch - The epoch when the current value was computed
   * @param diff - The diff representing the change, or RESET_VALUE to clear history
   * @example
   * ```ts
   * const buffer = new HistoryBuffer<string>(5)
   * buffer.pushEntry(0, 1, 'added text')
   * buffer.pushEntry(1, 2, RESET_VALUE) // Clears the buffer
   * ```
   */
  pushEntry(lastComputedEpoch, currentEpoch, diff) {
    if (diff === void 0) {
      return;
    }
    if (diff === RESET_VALUE) {
      this.clear();
      return;
    }
    this.buffer[this.index] = [lastComputedEpoch, currentEpoch, diff];
    this.index = (this.index + 1) % this.capacity;
  }
  /**
   * Clears all entries from the history buffer and resets the write position.
   * This is called when a RESET_VALUE diff is encountered.
   *
   * @example
   * ```ts
   * const buffer = new HistoryBuffer<string>(5)
   * buffer.pushEntry(0, 1, 'change')
   * buffer.clear()
   * console.log(buffer.getChangesSince(0)) // RESET_VALUE
   * ```
   */
  clear() {
    this.index = 0;
    this.buffer.fill(void 0);
  }
  /**
   * Retrieves all diffs that occurred since the specified epoch.
   *
   * The method searches backwards through the circular buffer to find changes
   * that occurred after the given epoch. If insufficient history is available
   * or the requested epoch is too old, returns RESET_VALUE indicating that
   * a complete state rebuild is required.
   *
   * @param sinceEpoch - The epoch from which to retrieve changes
   * @returns Array of diffs since the epoch, or RESET_VALUE if history is insufficient
   * @example
   * ```ts
   * const buffer = new HistoryBuffer<string>(5)
   * buffer.pushEntry(0, 1, 'first')
   * buffer.pushEntry(1, 2, 'second')
   * const changes = buffer.getChangesSince(0) // ['first', 'second']
   * const recentChanges = buffer.getChangesSince(1) // ['second']
   * const tooOld = buffer.getChangesSince(-100) // RESET_VALUE
   * ```
   */
  getChangesSince(sinceEpoch) {
    const { index, capacity, buffer } = this;
    for (let i = 0; i < capacity; i++) {
      const offset = (index - 1 + capacity - i) % capacity;
      const elem = buffer[offset];
      if (!elem) {
        return RESET_VALUE;
      }
      const [fromEpoch, toEpoch] = elem;
      if (i === 0 && sinceEpoch >= toEpoch) {
        return [];
      }
      if (fromEpoch <= sinceEpoch && sinceEpoch < toEpoch) {
        const len = i + 1;
        const result = new Array(len);
        for (let j = 0; j < len; j++) {
          result[j] = buffer[(offset + j) % capacity][2];
        }
        return result;
      }
    }
    return RESET_VALUE;
  }
};

// ../../node_modules/@tldraw/state/dist-esm/lib/constants.mjs
var GLOBAL_START_EPOCH = -1;

// ../../node_modules/@tldraw/state/dist-esm/lib/transactions.mjs
var Transaction = class {
  constructor(parent, isSync) {
    this.parent = parent;
    this.isSync = isSync;
  }
  parent;
  isSync;
  asyncProcessCount = 0;
  initialAtomValues = /* @__PURE__ */ new Map();
  /**
   * Get whether this transaction is a root (no parents).
   *
   * @public
   */
  // eslint-disable-next-line tldraw/no-setter-getter
  get isRoot() {
    return this.parent === null;
  }
  /**
   * Commit the transaction's changes.
   *
   * @public
   */
  commit() {
    if (inst2.globalIsReacting) {
      for (const atom2 of this.initialAtomValues.keys()) {
        traverseAtomForCleanup(atom2);
      }
    } else if (this.isRoot) {
      flushChanges(this.initialAtomValues.keys());
    } else {
      this.initialAtomValues.forEach((value, atom2) => {
        if (!this.parent.initialAtomValues.has(atom2)) {
          this.parent.initialAtomValues.set(atom2, value);
        }
      });
    }
  }
  /**
   * Abort the transaction.
   *
   * @public
   */
  abort() {
    inst2.globalEpoch++;
    this.initialAtomValues.forEach((value, atom2) => {
      atom2.set(value);
      atom2.historyBuffer?.clear();
    });
    this.commit();
  }
};
var inst2 = singleton("transactions", () => ({
  // The current epoch (global to all atoms).
  globalEpoch: GLOBAL_START_EPOCH + 1,
  // Whether any transaction is reacting.
  globalIsReacting: false,
  currentTransaction: null,
  cleanupReactors: null,
  reactionEpoch: GLOBAL_START_EPOCH + 1
}));
function getReactionEpoch() {
  return inst2.reactionEpoch;
}
function getGlobalEpoch() {
  return inst2.globalEpoch;
}
function getIsReacting() {
  return inst2.globalIsReacting;
}
var traverseReactors;
function traverseChild(child) {
  if (child.lastTraversedEpoch === inst2.globalEpoch) {
    return;
  }
  child.lastTraversedEpoch = inst2.globalEpoch;
  if ("__isEffectScheduler" in child) {
    traverseReactors.add(child);
  } else {
    ;
    child.children.visit(traverseChild);
  }
}
function traverse(reactors, child) {
  traverseReactors = reactors;
  traverseChild(child);
}
function flushChanges(atoms) {
  if (inst2.globalIsReacting) {
    throw new Error("flushChanges cannot be called during a reaction");
  }
  const outerTxn = inst2.currentTransaction;
  try {
    inst2.currentTransaction = null;
    inst2.globalIsReacting = true;
    inst2.reactionEpoch = inst2.globalEpoch;
    const reactors = /* @__PURE__ */ new Set();
    for (const atom2 of atoms) {
      atom2.children.visit((child) => traverse(reactors, child));
    }
    for (const r of reactors) {
      r.maybeScheduleEffect();
    }
    let updateDepth = 0;
    while (inst2.cleanupReactors?.size) {
      if (updateDepth++ > 1e3) {
        throw new Error("Reaction update depth limit exceeded");
      }
      const reactors2 = inst2.cleanupReactors;
      inst2.cleanupReactors = null;
      for (const r of reactors2) {
        r.maybeScheduleEffect();
      }
    }
  } finally {
    inst2.cleanupReactors = null;
    inst2.globalIsReacting = false;
    inst2.currentTransaction = outerTxn;
    traverseReactors = void 0;
  }
}
function atomDidChange(atom2, previousValue) {
  if (inst2.currentTransaction) {
    if (!inst2.currentTransaction.initialAtomValues.has(atom2)) {
      inst2.currentTransaction.initialAtomValues.set(atom2, previousValue);
    }
  } else if (inst2.globalIsReacting) {
    traverseAtomForCleanup(atom2);
  } else {
    flushChanges([atom2]);
  }
}
function traverseAtomForCleanup(atom2) {
  const rs = inst2.cleanupReactors ??= /* @__PURE__ */ new Set();
  atom2.children.visit((child) => traverse(rs, child));
}
function advanceGlobalEpoch() {
  inst2.globalEpoch++;
}
function transaction(fn) {
  const txn = new Transaction(inst2.currentTransaction, true);
  inst2.currentTransaction = txn;
  try {
    let result = void 0;
    let rollback = false;
    try {
      result = fn(() => rollback = true);
    } catch (e) {
      txn.abort();
      throw e;
    }
    if (inst2.currentTransaction !== txn) {
      throw new Error("Transaction boundaries overlap");
    }
    if (rollback) {
      txn.abort();
    } else {
      txn.commit();
    }
    return result;
  } finally {
    inst2.currentTransaction = txn.parent;
  }
}
function transact(fn) {
  if (inst2.currentTransaction) {
    return fn();
  }
  return transaction(fn);
}
async function deferAsyncEffects(fn) {
  if (inst2.currentTransaction?.isSync) {
    throw new Error("deferAsyncEffects cannot be called during a sync transaction");
  }
  while (inst2.globalIsReacting) {
    await new Promise((r) => queueMicrotask(() => r(null)));
  }
  const txn = inst2.currentTransaction ?? new Transaction(null, false);
  if (txn.isSync) throw new Error("deferAsyncEffects cannot be called during a sync transaction");
  inst2.currentTransaction = txn;
  txn.asyncProcessCount++;
  let result = void 0;
  let error = void 0;
  try {
    result = await fn();
  } catch (e) {
    error = e ?? null;
  }
  if (--txn.asyncProcessCount > 0) {
    if (typeof error !== "undefined") {
      throw error;
    } else {
      return result;
    }
  }
  inst2.currentTransaction = null;
  if (typeof error !== "undefined") {
    txn.abort();
    throw error;
  } else {
    txn.commit();
    return result;
  }
}

// ../../node_modules/@tldraw/state/dist-esm/lib/Atom.mjs
var __Atom__ = class {
  constructor(name, current, options) {
    this.name = name;
    this.current = current;
    this.isEqual = options?.isEqual ?? null;
    if (!options) return;
    if (options.historyLength) {
      this.historyBuffer = new HistoryBuffer(options.historyLength);
    }
    this.computeDiff = options.computeDiff;
  }
  name;
  current;
  /**
   * Custom equality function for comparing values, or null to use default equality.
   * @internal
   */
  isEqual;
  /**
   * Optional function to compute diffs between old and new values.
   * @internal
   */
  computeDiff;
  /**
   * The global epoch when this atom was last changed.
   * @internal
   */
  lastChangedEpoch = getGlobalEpoch();
  /**
   * Set of child signals that depend on this atom.
   * @internal
   */
  children = new ArraySet();
  /**
   * Optional history buffer for tracking changes over time.
   * @internal
   */
  historyBuffer;
  /**
   * Gets the current value without capturing it as a dependency in the current reactive context.
   * This is unsafe because it breaks the reactivity chain - use with caution.
   *
   * @param _ignoreErrors - Unused parameter for API compatibility
   * @returns The current value
   * @internal
   */
  __unsafe__getWithoutCapture(_ignoreErrors) {
    return this.current;
  }
  /**
   * Gets the current value of this atom. When called within a computed signal or reaction,
   * this atom will be automatically captured as a dependency.
   *
   * @returns The current value
   * @example
   * ```ts
   * const count = atom('count', 5)
   * console.log(count.get()) // 5
   * ```
   */
  get() {
    maybeCaptureParent(this);
    return this.current;
  }
  /**
   * Sets the value of this atom to the given value. If the value is the same as the current value, this is a no-op.
   *
   * @param value - The new value to set
   * @param diff - The diff to use for the update. If not provided, the diff will be computed using {@link AtomOptions.computeDiff}
   * @returns The new value
   * @example
   * ```ts
   * const count = atom('count', 0)
   * count.set(5) // count.get() is now 5
   * ```
   */
  set(value, diff) {
    if (this.isEqual?.(this.current, value) ?? equals(this.current, value)) {
      return this.current;
    }
    advanceGlobalEpoch();
    if (this.historyBuffer) {
      this.historyBuffer.pushEntry(
        this.lastChangedEpoch,
        getGlobalEpoch(),
        diff ?? this.computeDiff?.(this.current, value, this.lastChangedEpoch, getGlobalEpoch()) ?? RESET_VALUE
      );
    }
    this.lastChangedEpoch = getGlobalEpoch();
    const oldValue = this.current;
    this.current = value;
    atomDidChange(this, oldValue);
    return value;
  }
  /**
   * Updates the value of this atom using the given updater function. If the returned value is the same as the current value, this is a no-op.
   *
   * @param updater - A function that takes the current value and returns the new value
   * @returns The new value
   * @example
   * ```ts
   * const count = atom('count', 5)
   * count.update(n => n + 1) // count.get() is now 6
   * ```
   */
  update(updater) {
    return this.set(updater(this.current));
  }
  /**
   * Gets all the diffs that have occurred since the given epoch. When called within a computed
   * signal or reaction, this atom will be automatically captured as a dependency.
   *
   * @param epoch - The epoch to get changes since
   * @returns An array of diffs, or RESET_VALUE if history is insufficient
   * @internal
   */
  getDiffSince(epoch) {
    maybeCaptureParent(this);
    if (epoch >= this.lastChangedEpoch) {
      return EMPTY_ARRAY;
    }
    return this.historyBuffer?.getChangesSince(epoch) ?? RESET_VALUE;
  }
};
var _Atom = singleton("Atom", () => __Atom__);
function atom(name, initialValue, options) {
  return new _Atom(name, initialValue, options);
}
function isAtom(value) {
  return value instanceof _Atom;
}

// ../../node_modules/@tldraw/state/dist-esm/lib/warnings.mjs
var didWarnComputedGetter = false;
function logComputedGetterWarning() {
  if (didWarnComputedGetter) return;
  didWarnComputedGetter = true;
  console.warn(
    `Using \`@computed\` as a decorator for getters is deprecated and will be removed in the near future. Please refactor to use \`@computed\` as a decorator for methods.

// Before
@computed
get foo() {
	return 'foo'
}

// After
@computed
getFoo() {
	return 'foo'
}
`
  );
}

// ../../node_modules/@tldraw/state/dist-esm/lib/Computed.mjs
var UNINITIALIZED = /* @__PURE__ */ Symbol.for("com.tldraw.state/UNINITIALIZED");
function isUninitialized(value) {
  return value === UNINITIALIZED;
}
var WithDiff = singleton(
  "WithDiff",
  () => class WithDiff {
    constructor(value, diff) {
      this.value = value;
      this.diff = diff;
    }
    value;
    diff;
  }
);
function withDiff(value, diff) {
  return new WithDiff(value, diff);
}
var __UNSAFE__Computed = class {
  constructor(name, derive, options) {
    this.name = name;
    this.derive = derive;
    if (options?.historyLength) {
      this.historyBuffer = new HistoryBuffer(options.historyLength);
    }
    this.computeDiff = options?.computeDiff;
    this.isEqual = options?.isEqual ?? equals;
  }
  name;
  derive;
  __isComputed = true;
  lastChangedEpoch = GLOBAL_START_EPOCH;
  lastTraversedEpoch = GLOBAL_START_EPOCH;
  __debug_ancestor_epochs__ = null;
  /**
   * The epoch when the reactor was last checked.
   */
  lastCheckedEpoch = GLOBAL_START_EPOCH;
  parentSet = new ArraySet();
  parents = [];
  parentEpochs = [];
  children = new ArraySet();
  // eslint-disable-next-line tldraw/no-setter-getter
  get isActivelyListening() {
    return !this.children.isEmpty;
  }
  historyBuffer;
  // The last-computed value of this signal.
  state = UNINITIALIZED;
  // If the signal throws an error we stash it so we can rethrow it on the next get()
  error = null;
  computeDiff;
  isEqual;
  __unsafe__getWithoutCapture(ignoreErrors) {
    const isNew = this.lastChangedEpoch === GLOBAL_START_EPOCH;
    const globalEpoch = getGlobalEpoch();
    if (!isNew && (this.lastCheckedEpoch === globalEpoch || this.isActivelyListening && getIsReacting() && this.lastTraversedEpoch < getReactionEpoch() || !haveParentsChanged(this))) {
      this.lastCheckedEpoch = globalEpoch;
      if (this.error) {
        if (!ignoreErrors) {
          throw this.error.thrownValue;
        } else {
          return this.state;
        }
      } else {
        return this.state;
      }
    }
    try {
      startCapturingParents(this);
      const result = this.derive(this.state, this.lastCheckedEpoch);
      const newState = result instanceof WithDiff ? result.value : result;
      const isUninitialized2 = this.state === UNINITIALIZED;
      if (isUninitialized2 || !this.isEqual(this.state, newState)) {
        if (this.historyBuffer && !isUninitialized2) {
          const diff = result instanceof WithDiff ? result.diff : void 0;
          this.historyBuffer.pushEntry(
            this.lastChangedEpoch,
            getGlobalEpoch(),
            diff ?? this.computeDiff?.(this.state, newState, this.lastCheckedEpoch, getGlobalEpoch()) ?? RESET_VALUE
          );
        }
        this.lastChangedEpoch = getGlobalEpoch();
        this.state = newState;
      }
      this.error = null;
      this.lastCheckedEpoch = getGlobalEpoch();
      return this.state;
    } catch (e) {
      if (this.state !== UNINITIALIZED) {
        this.state = UNINITIALIZED;
        this.lastChangedEpoch = getGlobalEpoch();
      }
      this.lastCheckedEpoch = getGlobalEpoch();
      if (this.historyBuffer) {
        this.historyBuffer.clear();
      }
      this.error = { thrownValue: e };
      if (!ignoreErrors) throw e;
      return this.state;
    } finally {
      stopCapturingParents();
    }
  }
  get() {
    try {
      return this.__unsafe__getWithoutCapture();
    } finally {
      maybeCaptureParent(this);
    }
  }
  getDiffSince(epoch) {
    this.__unsafe__getWithoutCapture(true);
    maybeCaptureParent(this);
    if (epoch >= this.lastChangedEpoch) {
      return EMPTY_ARRAY;
    }
    return this.historyBuffer?.getChangesSince(epoch) ?? RESET_VALUE;
  }
};
var _Computed = singleton("Computed", () => __UNSAFE__Computed);
function computedMethodLegacyDecorator(options = {}, _target, key, descriptor) {
  const originalMethod = descriptor.value;
  const derivationKey = /* @__PURE__ */ Symbol.for("__@tldraw/state__computed__" + key);
  descriptor.value = function() {
    let d = this[derivationKey];
    if (!d) {
      d = new _Computed(key, originalMethod.bind(this), options);
      Object.defineProperty(this, derivationKey, {
        enumerable: false,
        configurable: false,
        writable: false,
        value: d
      });
    }
    return d.get();
  };
  descriptor.value[isComputedMethodKey] = true;
  return descriptor;
}
function computedGetterLegacyDecorator(options = {}, _target, key, descriptor) {
  const originalMethod = descriptor.get;
  const derivationKey = /* @__PURE__ */ Symbol.for("__@tldraw/state__computed__" + key);
  descriptor.get = function() {
    let d = this[derivationKey];
    if (!d) {
      d = new _Computed(key, originalMethod.bind(this), options);
      Object.defineProperty(this, derivationKey, {
        enumerable: false,
        configurable: false,
        writable: false,
        value: d
      });
    }
    return d.get();
  };
  return descriptor;
}
function computedMethodTc39Decorator(options, compute, context) {
  assert(context.kind === "method", "@computed can only be used on methods");
  const derivationKey = /* @__PURE__ */ Symbol.for("__@tldraw/state__computed__" + String(context.name));
  const fn = function() {
    let d = this[derivationKey];
    if (!d) {
      d = new _Computed(String(context.name), compute.bind(this), options);
      Object.defineProperty(this, derivationKey, {
        enumerable: false,
        configurable: false,
        writable: false,
        value: d
      });
    }
    return d.get();
  };
  fn[isComputedMethodKey] = true;
  return fn;
}
function computedDecorator(options = {}, args) {
  if (args.length === 2) {
    const [originalMethod, context] = args;
    return computedMethodTc39Decorator(options, originalMethod, context);
  } else {
    const [_target, key, descriptor] = args;
    if (descriptor.get) {
      logComputedGetterWarning();
      return computedGetterLegacyDecorator(options, _target, key, descriptor);
    } else {
      return computedMethodLegacyDecorator(options, _target, key, descriptor);
    }
  }
}
var isComputedMethodKey = "@@__isComputedMethod__@@";
function getComputedInstance(obj, propertyName) {
  const key = /* @__PURE__ */ Symbol.for("__@tldraw/state__computed__" + propertyName.toString());
  let inst3 = obj[key];
  if (!inst3) {
    const val = obj[propertyName];
    if (typeof val === "function" && val[isComputedMethodKey]) {
      val.call(obj);
    }
    inst3 = obj[key];
  }
  return inst3;
}
function computed() {
  if (arguments.length === 1) {
    const options = arguments[0];
    return (...args) => computedDecorator(options, args);
  } else if (typeof arguments[0] === "string") {
    return new _Computed(arguments[0], arguments[1], arguments[2]);
  } else {
    return computedDecorator(void 0, arguments);
  }
}

// ../../node_modules/@tldraw/state/dist-esm/lib/EffectScheduler.mjs
var __EffectScheduler__ = class {
  constructor(name, runEffect, options) {
    this.name = name;
    this.runEffect = runEffect;
    this._scheduleEffect = options?.scheduleEffect;
  }
  name;
  runEffect;
  __isEffectScheduler = true;
  /** @internal */
  _isActivelyListening = false;
  /**
   * Whether this scheduler is attached and actively listening to its parents.
   * @public
   */
  // eslint-disable-next-line tldraw/no-setter-getter
  get isActivelyListening() {
    return this._isActivelyListening;
  }
  /** @internal */
  lastTraversedEpoch = GLOBAL_START_EPOCH;
  /** @internal */
  lastReactedEpoch = GLOBAL_START_EPOCH;
  /** @internal */
  _scheduleCount = 0;
  /** @internal */
  __debug_ancestor_epochs__ = null;
  /**
   * The number of times this effect has been scheduled.
   * @public
   */
  // eslint-disable-next-line tldraw/no-setter-getter
  get scheduleCount() {
    return this._scheduleCount;
  }
  /** @internal */
  parentSet = new ArraySet();
  /** @internal */
  parentEpochs = [];
  /** @internal */
  parents = [];
  /** @internal */
  _scheduleEffect;
  /** @internal */
  maybeScheduleEffect() {
    if (!this._isActivelyListening) return;
    if (this.lastReactedEpoch === getGlobalEpoch()) return;
    if (this.parents.length && !haveParentsChanged(this)) {
      this.lastReactedEpoch = getGlobalEpoch();
      return;
    }
    this.scheduleEffect();
  }
  /** @internal */
  scheduleEffect() {
    this._scheduleCount++;
    if (this._scheduleEffect) {
      this._scheduleEffect(this.maybeExecute);
    } else {
      this.execute();
    }
  }
  /** @internal */
  // eslint-disable-next-line tldraw/prefer-class-methods
  maybeExecute = () => {
    if (!this._isActivelyListening) return;
    this.execute();
  };
  /**
   * Makes this scheduler become 'actively listening' to its parents.
   * If it has been executed before it will immediately become eligible to receive 'maybeScheduleEffect' calls.
   * If it has not executed before it will need to be manually executed once to become eligible for scheduling, i.e. by calling `EffectScheduler.execute`.
   * @public
   */
  attach() {
    this._isActivelyListening = true;
    for (let i = 0, n = this.parents.length; i < n; i++) {
      attach(this.parents[i], this);
    }
  }
  /**
   * Makes this scheduler stop 'actively listening' to its parents.
   * It will no longer be eligible to receive 'maybeScheduleEffect' calls until `EffectScheduler.attach` is called again.
   * @public
   */
  detach() {
    this._isActivelyListening = false;
    for (let i = 0, n = this.parents.length; i < n; i++) {
      detach(this.parents[i], this);
    }
  }
  /**
   * Executes the effect immediately and returns the result.
   * @returns The result of the effect.
   * @public
   */
  execute() {
    try {
      startCapturingParents(this);
      const currentEpoch = getGlobalEpoch();
      const result = this.runEffect(this.lastReactedEpoch);
      this.lastReactedEpoch = currentEpoch;
      return result;
    } finally {
      stopCapturingParents();
    }
  }
};
var EffectScheduler = singleton(
  "EffectScheduler",
  () => __EffectScheduler__
);
function react(name, fn, options) {
  const scheduler = new EffectScheduler(name, fn, options);
  scheduler.attach();
  scheduler.scheduleEffect();
  return () => {
    scheduler.detach();
  };
}
function reactor(name, fn, options) {
  const scheduler = new EffectScheduler(name, fn, options);
  return {
    scheduler,
    start: (options2) => {
      const force = options2?.force ?? false;
      scheduler.attach();
      if (force) {
        scheduler.scheduleEffect();
      } else {
        scheduler.maybeScheduleEffect();
      }
    },
    stop: () => {
      scheduler.detach();
    }
  };
}

// ../../node_modules/@tldraw/state/dist-esm/lib/isSignal.mjs
function isSignal(value) {
  return value instanceof _Atom || value instanceof _Computed;
}

// ../../node_modules/@tldraw/state/dist-esm/lib/localStorageAtom.mjs
function localStorageAtom(name, initialValue, options) {
  let _initialValue = initialValue;
  try {
    const value = getFromLocalStorage(name);
    if (value) {
      _initialValue = JSON.parse(value);
    }
  } catch {
    deleteFromLocalStorage(name);
  }
  const outAtom = atom(name, _initialValue, options);
  const reactCleanup = react(`save ${name} to localStorage`, () => {
    setInLocalStorage(name, JSON.stringify(outAtom.get()));
  });
  const handleStorageEvent = (event) => {
    if (event.key !== name) return;
    if (event.newValue === null) {
      outAtom.set(initialValue);
      return;
    }
    try {
      const newValue = JSON.parse(event.newValue);
      outAtom.set(newValue);
    } catch {
    }
  };
  window.addEventListener("storage", handleStorageEvent);
  const cleanup = () => {
    reactCleanup();
    window.removeEventListener("storage", handleStorageEvent);
  };
  return [outAtom, cleanup];
}

// ../../node_modules/@tldraw/state/dist-esm/index.mjs
var currentApiVersion = 1;
var actualApiVersion = singleton("apiVersion", () => currentApiVersion);
if (actualApiVersion !== currentApiVersion) {
  throw new Error(
    `You have multiple incompatible versions of @tldraw/state in your app. Please deduplicate the package.`
  );
}
registerTldrawLibraryVersion(
  "@tldraw/state",
  "5.3.2",
  "esm"
);

// ../../node_modules/@tldraw/store/dist-esm/lib/ImmutableMap.mjs
function smi(i32) {
  return i32 >>> 1 & 1073741824 | i32 & 3221225471;
}
var defaultValueOf = Object.prototype.valueOf;
function hash(o) {
  if (o == null) {
    return hashNullish(o);
  }
  if (typeof o.hashCode === "function") {
    return smi(o.hashCode(o));
  }
  const v = valueOf(o);
  if (v == null) {
    return hashNullish(v);
  }
  switch (typeof v) {
    case "boolean":
      return v ? 1108378657 : 1108378656;
    case "number":
      return hashNumber(v);
    case "string":
      return cachedHashString(v);
    case "object":
    case "function":
      return hashJSObj(v);
    case "symbol":
      return hashSymbol(v);
    default:
      if (typeof v.toString === "function") {
        return hashString(v.toString());
      }
      throw new Error("Value type " + typeof v + " cannot be hashed.");
  }
}
function hashNullish(nullish) {
  return nullish === null ? 1108378658 : (
    /* undefined */
    1108378659
  );
}
function hashNumber(n) {
  if (n !== n || n === Infinity) {
    return 0;
  }
  let hash2 = n | 0;
  if (hash2 !== n) {
    hash2 ^= n * 4294967295;
  }
  while (n > 4294967295) {
    n /= 4294967295;
    hash2 ^= n;
  }
  return smi(hash2);
}
function cachedHashString(string2) {
  let hashed = stringHashCache[string2];
  if (hashed === void 0) {
    hashed = hashString(string2);
    if (stringHashCacheCount === STRING_HASH_CACHE_SIZE) {
      stringHashCacheCount = 0;
      stringHashCache = {};
    }
    stringHashCache[string2] = hashed;
    stringHashCacheCount++;
  }
  return hashed;
}
function hashString(string2) {
  let hashed = 0;
  for (let ii = 0; ii < string2.length; ii++) {
    hashed = 31 * hashed + string2.charCodeAt(ii) | 0;
  }
  return smi(hashed);
}
function hashSymbol(sym) {
  let hashed = symbolMap[sym];
  if (hashed !== void 0) {
    return hashed;
  }
  hashed = nextHash();
  symbolMap[sym] = hashed;
  return hashed;
}
function hashJSObj(obj) {
  let hashed = weakMap.get(obj);
  if (hashed !== void 0) {
    return hashed;
  }
  hashed = nextHash();
  weakMap.set(obj, hashed);
  return hashed;
}
function valueOf(obj) {
  return obj.valueOf !== defaultValueOf && typeof obj.valueOf === "function" ? obj.valueOf(obj) : obj;
}
function nextHash() {
  const nextHash2 = ++_objHashUID;
  if (_objHashUID & 1073741824) {
    _objHashUID = 0;
  }
  return nextHash2;
}
var weakMap = /* @__PURE__ */ new WeakMap();
var symbolMap = /* @__PURE__ */ Object.create(null);
var _objHashUID = 0;
var stringHashCache = {};
var stringHashCacheCount = 0;
var STRING_HASH_CACHE_SIZE = 24e3;
var SHIFT = 5;
var SIZE = 1 << SHIFT;
var MASK = SIZE - 1;
var NOT_SET = {};
function MakeRef() {
  return { value: false };
}
function SetRef(ref) {
  if (ref) {
    ref.value = true;
  }
}
function arrCopy(arr, offset = 0) {
  return arr.slice(offset);
}
var OwnerID = class {
};
var ImmutableMap = class _ImmutableMap {
  // @pragma Construction
  // @ts-ignore
  _root;
  // @ts-ignore
  size;
  // @ts-ignore
  __ownerID;
  // @ts-ignore
  __hash;
  // @ts-ignore
  __altered;
  /**
   * Creates a new ImmutableMap instance.
   *
   * @param value - An iterable of key-value pairs to populate the map, or null/undefined for an empty map
   * @example
   * ```ts
   * // Create from array of pairs
   * const map1 = new ImmutableMap([['a', 1], ['b', 2]])
   *
   * // Create empty map
   * const map2 = new ImmutableMap()
   *
   * // Create from another map
   * const map3 = new ImmutableMap(map1)
   * ```
   */
  constructor(value) {
    return value === void 0 || value === null ? emptyMap() : value instanceof _ImmutableMap ? value : emptyMap().withMutations((map) => {
      for (const [k, v] of value) {
        map.set(k, v);
      }
    });
  }
  get(k, notSetValue) {
    return this._root ? this._root.get(0, void 0, k, notSetValue) : notSetValue;
  }
  /**
   * Returns a new ImmutableMap with the specified key-value pair added or updated.
   * If the key already exists, its value is replaced. Otherwise, a new entry is created.
   *
   * @param k - The key to set
   * @param v - The value to associate with the key
   * @returns A new ImmutableMap with the key-value pair set
   * @example
   * ```ts
   * const map = new ImmutableMap([['a', 1]])
   * const updated = map.set('b', 2) // New map with both 'a' and 'b'
   * const replaced = map.set('a', 10) // New map with 'a' updated to 10
   * ```
   */
  set(k, v) {
    return updateMap(this, k, v);
  }
  /**
   * Returns a new ImmutableMap with the specified key removed.
   * If the key doesn't exist, returns the same map instance.
   *
   * @param k - The key to remove
   * @returns A new ImmutableMap with the key removed, or the same instance if key not found
   * @example
   * ```ts
   * const map = new ImmutableMap([['a', 1], ['b', 2]])
   * const smaller = map.delete('a') // New map with only 'b'
   * const same = map.delete('missing') // Returns original map
   * ```
   */
  delete(k) {
    return updateMap(this, k, NOT_SET);
  }
  /**
   * Returns a new ImmutableMap with all specified keys removed.
   * This is more efficient than calling delete() multiple times.
   *
   * @param keys - An iterable of keys to remove
   * @returns A new ImmutableMap with all specified keys removed
   * @example
   * ```ts
   * const map = new ImmutableMap([['a', 1], ['b', 2], ['c', 3]])
   * const smaller = map.deleteAll(['a', 'c']) // New map with only 'b'
   * ```
   */
  deleteAll(keys) {
    return this.withMutations((map) => {
      for (const key of keys) {
        map.delete(key);
      }
    });
  }
  __ensureOwner(ownerID) {
    if (ownerID === this.__ownerID) {
      return this;
    }
    if (!ownerID) {
      if (this.size === 0) {
        return emptyMap();
      }
      this.__ownerID = ownerID;
      this.__altered = false;
      return this;
    }
    return makeMap(this.size, this._root, ownerID, this.__hash);
  }
  /**
   * Applies multiple mutations efficiently by creating a mutable copy,
   * applying all changes, then returning an immutable result.
   * This is more efficient than chaining multiple set/delete operations.
   *
   * @param fn - Function that receives a mutable copy and applies changes
   * @returns A new ImmutableMap with all mutations applied, or the same instance if no changes
   * @example
   * ```ts
   * const map = new ImmutableMap([['a', 1]])
   * const updated = map.withMutations(mutable => {
   *   mutable.set('b', 2)
   *   mutable.set('c', 3)
   *   mutable.delete('a')
   * }) // Efficiently applies all changes at once
   * ```
   */
  withMutations(fn) {
    const mutable = this.asMutable();
    fn(mutable);
    return mutable.wasAltered() ? mutable.__ensureOwner(this.__ownerID) : this;
  }
  /**
   * Checks if this map instance has been altered during a mutation operation.
   * This is used internally to optimize mutations.
   *
   * @returns True if the map was altered, false otherwise
   * @internal
   */
  wasAltered() {
    return this.__altered;
  }
  /**
   * Returns a mutable copy of this map that can be efficiently modified.
   * Multiple changes to the mutable copy are batched together.
   *
   * @returns A mutable copy of this map
   * @internal
   */
  asMutable() {
    return this.__ownerID ? this : this.__ensureOwner(new OwnerID());
  }
  /**
   * Makes the map iterable, yielding key-value pairs.
   *
   * @returns An iterator over [key, value] pairs
   * @example
   * ```ts
   * const map = new ImmutableMap([['a', 1], ['b', 2]])
   * for (const [key, value] of map) {
   *   console.log(key, value) // 'a' 1, then 'b' 2
   * }
   * ```
   */
  [Symbol.iterator]() {
    return this.entries()[Symbol.iterator]();
  }
  /**
   * Returns an iterable of key-value pairs.
   *
   * @returns An iterable over [key, value] pairs
   * @example
   * ```ts
   * const map = new ImmutableMap([['a', 1], ['b', 2]])
   * const entries = Array.from(map.entries()) // [['a', 1], ['b', 2]]
   * ```
   */
  entries() {
    return new MapIterator(this, ITERATE_ENTRIES, false);
  }
  /**
   * Returns an iterable of keys.
   *
   * @returns An iterable over keys
   * @example
   * ```ts
   * const map = new ImmutableMap([['a', 1], ['b', 2]])
   * const keys = Array.from(map.keys()) // ['a', 'b']
   * ```
   */
  keys() {
    return new MapIterator(this, ITERATE_KEYS, false);
  }
  /**
   * Returns an iterable of values.
   *
   * @returns An iterable over values
   * @example
   * ```ts
   * const map = new ImmutableMap([['a', 1], ['b', 2]])
   * const values = Array.from(map.values()) // [1, 2]
   * ```
   */
  values() {
    return new MapIterator(this, ITERATE_VALUES, false);
  }
};
var ArrayMapNode = class _ArrayMapNode {
  constructor(ownerID, entries) {
    this.ownerID = ownerID;
    this.entries = entries;
  }
  ownerID;
  entries;
  get(_shift, _keyHash, key, notSetValue) {
    const entries = this.entries;
    for (let ii = 0, len = entries.length; ii < len; ii++) {
      if (Object.is(key, entries[ii][0])) {
        return entries[ii][1];
      }
    }
    return notSetValue;
  }
  update(ownerID, _shift, _keyHash, key, value, didChangeSize, didAlter) {
    const removed = value === NOT_SET;
    const entries = this.entries;
    let idx = 0;
    const len = entries.length;
    for (; idx < len; idx++) {
      if (Object.is(key, entries[idx][0])) {
        break;
      }
    }
    const exists = idx < len;
    if (exists ? entries[idx][1] === value : removed) {
      return this;
    }
    SetRef(didAlter);
    if (removed || !exists) SetRef(didChangeSize);
    if (removed && entries.length === 1) {
      return;
    }
    if (!exists && !removed && entries.length >= MAX_ARRAY_MAP_SIZE) {
      return createNodes(ownerID, entries, key, value);
    }
    const isEditable = ownerID && ownerID === this.ownerID;
    const newEntries = isEditable ? entries : arrCopy(entries);
    if (exists) {
      if (removed) {
        if (idx === len - 1) {
          newEntries.pop();
        } else {
          newEntries[idx] = newEntries.pop();
        }
      } else {
        newEntries[idx] = [key, value];
      }
    } else {
      newEntries.push([key, value]);
    }
    if (isEditable) {
      this.entries = newEntries;
      return this;
    }
    return new _ArrayMapNode(ownerID, newEntries);
  }
};
var BitmapIndexedNode = class _BitmapIndexedNode {
  constructor(ownerID, bitmap, nodes) {
    this.ownerID = ownerID;
    this.bitmap = bitmap;
    this.nodes = nodes;
  }
  ownerID;
  bitmap;
  nodes;
  get(shift, keyHash, key, notSetValue) {
    if (keyHash === void 0) {
      keyHash = hash(key);
    }
    const bit = 1 << ((shift === 0 ? keyHash : keyHash >>> shift) & MASK);
    const bitmap = this.bitmap;
    return (bitmap & bit) === 0 ? notSetValue : this.nodes[popCount(bitmap & bit - 1)].get(shift + SHIFT, keyHash, key, notSetValue);
  }
  update(ownerID, shift, keyHash, key, value, didChangeSize, didAlter) {
    if (keyHash === void 0) {
      keyHash = hash(key);
    }
    const keyHashFrag = (shift === 0 ? keyHash : keyHash >>> shift) & MASK;
    const bit = 1 << keyHashFrag;
    const bitmap = this.bitmap;
    const exists = (bitmap & bit) !== 0;
    if (!exists && value === NOT_SET) {
      return this;
    }
    const idx = popCount(bitmap & bit - 1);
    const nodes = this.nodes;
    const node = exists ? nodes[idx] : void 0;
    const newNode = updateNode(
      node,
      ownerID,
      shift + SHIFT,
      keyHash,
      key,
      value,
      didChangeSize,
      didAlter
    );
    if (newNode === node) {
      return this;
    }
    if (!exists && newNode && nodes.length >= MAX_BITMAP_INDEXED_SIZE) {
      return expandNodes(ownerID, nodes, bitmap, keyHashFrag, newNode);
    }
    if (exists && !newNode && nodes.length === 2 && isLeafNode(nodes[idx ^ 1])) {
      return nodes[idx ^ 1];
    }
    if (exists && newNode && nodes.length === 1 && isLeafNode(newNode)) {
      return newNode;
    }
    const isEditable = ownerID && ownerID === this.ownerID;
    const newBitmap = exists ? newNode ? bitmap : bitmap ^ bit : bitmap | bit;
    const newNodes = exists ? newNode ? setAt(nodes, idx, newNode, isEditable) : spliceOut(nodes, idx, isEditable) : spliceIn(nodes, idx, newNode, isEditable);
    if (isEditable) {
      this.bitmap = newBitmap;
      this.nodes = newNodes;
      return this;
    }
    return new _BitmapIndexedNode(ownerID, newBitmap, newNodes);
  }
};
var HashArrayMapNode = class _HashArrayMapNode {
  constructor(ownerID, count, nodes) {
    this.ownerID = ownerID;
    this.count = count;
    this.nodes = nodes;
  }
  ownerID;
  count;
  nodes;
  get(shift, keyHash, key, notSetValue) {
    if (keyHash === void 0) {
      keyHash = hash(key);
    }
    const idx = (shift === 0 ? keyHash : keyHash >>> shift) & MASK;
    const node = this.nodes[idx];
    return node ? node.get(shift + SHIFT, keyHash, key, notSetValue) : notSetValue;
  }
  update(ownerID, shift, keyHash, key, value, didChangeSize, didAlter) {
    if (keyHash === void 0) {
      keyHash = hash(key);
    }
    const idx = (shift === 0 ? keyHash : keyHash >>> shift) & MASK;
    const removed = value === NOT_SET;
    const nodes = this.nodes;
    const node = nodes[idx];
    if (removed && !node) {
      return this;
    }
    const newNode = updateNode(
      node,
      ownerID,
      shift + SHIFT,
      keyHash,
      key,
      value,
      didChangeSize,
      didAlter
    );
    if (newNode === node) {
      return this;
    }
    let newCount = this.count;
    if (!node) {
      newCount++;
    } else if (!newNode) {
      newCount--;
      if (newCount < MIN_HASH_ARRAY_MAP_SIZE) {
        return packNodes(ownerID, nodes, newCount, idx);
      }
    }
    const isEditable = ownerID && ownerID === this.ownerID;
    const newNodes = setAt(nodes, idx, newNode, isEditable);
    if (isEditable) {
      this.count = newCount;
      this.nodes = newNodes;
      return this;
    }
    return new _HashArrayMapNode(ownerID, newCount, newNodes);
  }
};
var HashCollisionNode = class _HashCollisionNode {
  constructor(ownerID, keyHash, entries) {
    this.ownerID = ownerID;
    this.keyHash = keyHash;
    this.entries = entries;
  }
  ownerID;
  keyHash;
  entries;
  get(shift, keyHash, key, notSetValue) {
    const entries = this.entries;
    for (let ii = 0, len = entries.length; ii < len; ii++) {
      if (Object.is(key, entries[ii][0])) {
        return entries[ii][1];
      }
    }
    return notSetValue;
  }
  update(ownerID, shift, keyHash, key, value, didChangeSize, didAlter) {
    if (keyHash === void 0) {
      keyHash = hash(key);
    }
    const removed = value === NOT_SET;
    if (keyHash !== this.keyHash) {
      if (removed) {
        return this;
      }
      SetRef(didAlter);
      SetRef(didChangeSize);
      return mergeIntoNode(this, ownerID, shift, keyHash, [key, value]);
    }
    const entries = this.entries;
    let idx = 0;
    const len = entries.length;
    for (; idx < len; idx++) {
      if (Object.is(key, entries[idx][0])) {
        break;
      }
    }
    const exists = idx < len;
    if (exists ? entries[idx][1] === value : removed) {
      return this;
    }
    SetRef(didAlter);
    if (removed || !exists) SetRef(didChangeSize);
    if (removed && len === 2) {
      return new ValueNode(ownerID, this.keyHash, entries[idx ^ 1]);
    }
    const isEditable = ownerID && ownerID === this.ownerID;
    const newEntries = isEditable ? entries : arrCopy(entries);
    if (exists) {
      if (removed) {
        if (idx === len - 1) {
          newEntries.pop();
        } else {
          newEntries[idx] = newEntries.pop();
        }
      } else {
        newEntries[idx] = [key, value];
      }
    } else {
      newEntries.push([key, value]);
    }
    if (isEditable) {
      this.entries = newEntries;
      return this;
    }
    return new _HashCollisionNode(ownerID, this.keyHash, newEntries);
  }
};
var ValueNode = class _ValueNode {
  constructor(ownerID, keyHash, entry2) {
    this.ownerID = ownerID;
    this.keyHash = keyHash;
    this.entry = entry2;
  }
  ownerID;
  keyHash;
  entry;
  get(shift, keyHash, key, notSetValue) {
    return Object.is(key, this.entry[0]) ? this.entry[1] : notSetValue;
  }
  update(ownerID, shift, keyHash, key, value, didChangeSize, didAlter) {
    const removed = value === NOT_SET;
    const keyMatch = Object.is(key, this.entry[0]);
    if (keyMatch ? value === this.entry[1] : removed) {
      return this;
    }
    SetRef(didAlter);
    if (removed) {
      SetRef(didChangeSize);
      return;
    }
    if (keyMatch) {
      if (ownerID && ownerID === this.ownerID) {
        this.entry[1] = value;
        return this;
      }
      return new _ValueNode(ownerID, this.keyHash, [key, value]);
    }
    SetRef(didChangeSize);
    return mergeIntoNode(this, ownerID, shift, hash(key), [key, value]);
  }
};
var MapIterator = class {
  constructor(map, _type, _reverse) {
    this._type = _type;
    this._reverse = _reverse;
    this._stack = map._root && mapIteratorFrame(map._root);
  }
  _type;
  _reverse;
  _stack;
  [Symbol.iterator]() {
    return this;
  }
  next() {
    const type = this._type;
    let stack = this._stack;
    while (stack) {
      const node = stack.node;
      const index = stack.index++;
      let maxIndex;
      if (node.entry) {
        if (index === 0) {
          return mapIteratorValue(type, node.entry);
        }
      } else if ("entries" in node && node.entries) {
        maxIndex = node.entries.length - 1;
        if (index <= maxIndex) {
          return mapIteratorValue(type, node.entries[this._reverse ? maxIndex - index : index]);
        }
      } else {
        maxIndex = node.nodes.length - 1;
        if (index <= maxIndex) {
          const subNode = node.nodes[this._reverse ? maxIndex - index : index];
          if (subNode) {
            if (subNode.entry) {
              return mapIteratorValue(type, subNode.entry);
            }
            stack = this._stack = mapIteratorFrame(subNode, stack);
          }
          continue;
        }
      }
      stack = this._stack = this._stack.__prev;
    }
    return iteratorDone();
  }
};
function mapIteratorValue(type, entry2) {
  return iteratorValue(type, entry2[0], entry2[1]);
}
function mapIteratorFrame(node, prev) {
  return {
    node,
    index: 0,
    __prev: prev
  };
}
var ITERATE_KEYS = 0;
var ITERATE_VALUES = 1;
var ITERATE_ENTRIES = 2;
function iteratorValue(type, k, v, iteratorResult) {
  const value = type === ITERATE_KEYS ? k : type === ITERATE_VALUES ? v : [k, v];
  if (iteratorResult) {
    iteratorResult.value = value;
  } else {
    iteratorResult = { value, done: false };
  }
  return iteratorResult;
}
function iteratorDone() {
  return { value: void 0, done: true };
}
function makeMap(size, root, ownerID, hash2) {
  const map = Object.create(ImmutableMap.prototype);
  map.size = size;
  map._root = root;
  map.__ownerID = ownerID;
  map.__hash = hash2;
  map.__altered = false;
  return map;
}
var EMPTY_MAP;
function emptyMap() {
  return EMPTY_MAP || (EMPTY_MAP = makeMap(0));
}
function updateMap(map, k, v) {
  let newRoot;
  let newSize;
  if (!map._root) {
    if (v === NOT_SET) {
      return map;
    }
    newSize = 1;
    newRoot = new ArrayMapNode(map.__ownerID, [[k, v]]);
  } else {
    const didChangeSize = MakeRef();
    const didAlter = MakeRef();
    newRoot = updateNode(map._root, map.__ownerID, 0, void 0, k, v, didChangeSize, didAlter);
    if (!didAlter.value) {
      return map;
    }
    newSize = map.size + (didChangeSize.value ? v === NOT_SET ? -1 : 1 : 0);
  }
  if (map.__ownerID) {
    map.size = newSize;
    map._root = newRoot;
    map.__hash = void 0;
    map.__altered = true;
    return map;
  }
  return newRoot ? makeMap(newSize, newRoot) : emptyMap();
}
function updateNode(node, ownerID, shift, keyHash, key, value, didChangeSize, didAlter) {
  if (!node) {
    if (value === NOT_SET) {
      return node;
    }
    SetRef(didAlter);
    SetRef(didChangeSize);
    return new ValueNode(ownerID, keyHash, [key, value]);
  }
  return node.update(ownerID, shift, keyHash, key, value, didChangeSize, didAlter);
}
function isLeafNode(node) {
  return node.constructor === ValueNode || node.constructor === HashCollisionNode;
}
function mergeIntoNode(node, ownerID, shift, keyHash, entry2) {
  if (node.keyHash === keyHash) {
    return new HashCollisionNode(ownerID, keyHash, [node.entry, entry2]);
  }
  const idx1 = (shift === 0 ? node.keyHash : node.keyHash >>> shift) & MASK;
  const idx2 = (shift === 0 ? keyHash : keyHash >>> shift) & MASK;
  let newNode;
  const nodes = idx1 === idx2 ? [mergeIntoNode(node, ownerID, shift + SHIFT, keyHash, entry2)] : (newNode = new ValueNode(ownerID, keyHash, entry2), idx1 < idx2 ? [node, newNode] : [newNode, node]);
  return new BitmapIndexedNode(ownerID, 1 << idx1 | 1 << idx2, nodes);
}
function createNodes(ownerID, entries, key, value) {
  if (!ownerID) {
    ownerID = new OwnerID();
  }
  let node = new ValueNode(ownerID, hash(key), [key, value]);
  for (let ii = 0; ii < entries.length; ii++) {
    const entry2 = entries[ii];
    node = node.update(ownerID, 0, void 0, entry2[0], entry2[1]);
  }
  return node;
}
function packNodes(ownerID, nodes, count, excluding) {
  let bitmap = 0;
  let packedII = 0;
  const packedNodes = new Array(count);
  for (let ii = 0, bit = 1, len = nodes.length; ii < len; ii++, bit <<= 1) {
    const node = nodes[ii];
    if (node !== void 0 && ii !== excluding) {
      bitmap |= bit;
      packedNodes[packedII++] = node;
    }
  }
  return new BitmapIndexedNode(ownerID, bitmap, packedNodes);
}
function expandNodes(ownerID, nodes, bitmap, including, node) {
  let count = 0;
  const expandedNodes = new Array(SIZE);
  for (let ii = 0; bitmap !== 0; ii++, bitmap >>>= 1) {
    expandedNodes[ii] = bitmap & 1 ? nodes[count++] : void 0;
  }
  expandedNodes[including] = node;
  return new HashArrayMapNode(ownerID, count + 1, expandedNodes);
}
function popCount(x) {
  x -= x >> 1 & 1431655765;
  x = (x & 858993459) + (x >> 2 & 858993459);
  x = x + (x >> 4) & 252645135;
  x += x >> 8;
  x += x >> 16;
  return x & 127;
}
function setAt(array2, idx, val, canEdit) {
  const newArray = canEdit ? array2 : arrCopy(array2);
  newArray[idx] = val;
  return newArray;
}
function spliceIn(array2, idx, val, canEdit) {
  const newLen = array2.length + 1;
  if (canEdit && idx + 1 === newLen) {
    array2[idx] = val;
    return array2;
  }
  const newArray = new Array(newLen);
  let after = 0;
  for (let ii = 0; ii < newLen; ii++) {
    if (ii === idx) {
      newArray[ii] = val;
      after = -1;
    } else {
      newArray[ii] = array2[ii + after];
    }
  }
  return newArray;
}
function spliceOut(array2, idx, canEdit) {
  const newLen = array2.length - 1;
  if (canEdit && idx === newLen) {
    array2.pop();
    return array2;
  }
  const newArray = new Array(newLen);
  let after = 0;
  for (let ii = 0; ii < newLen; ii++) {
    if (ii === idx) {
      after = 1;
    }
    newArray[ii] = array2[ii + after];
  }
  return newArray;
}
var MAX_ARRAY_MAP_SIZE = SIZE / 4;
var MAX_BITMAP_INDEXED_SIZE = SIZE / 2;
var MIN_HASH_ARRAY_MAP_SIZE = SIZE / 4;

// ../../node_modules/@tldraw/store/dist-esm/lib/AtomMap.mjs
var AtomMap = class {
  /**
   * Creates a new AtomMap instance.
   *
   * name - A unique name for this map, used for atom identification
   * entries - Optional initial entries to populate the map with
   * @example
   * ```ts
   * // Create an empty map
   * const map = new AtomMap('userMap')
   *
   * // Create a map with initial data
   * const initialData: [string, number][] = [['a', 1], ['b', 2]]
   * const mapWithData = new AtomMap('numbersMap', initialData)
   * ```
   */
  constructor(name, entries) {
    this.name = name;
    let atoms = emptyMap();
    if (entries) {
      atoms = atoms.withMutations((atoms2) => {
        for (const [k, v] of entries) {
          atoms2.set(k, atom(`${name}:${String(k)}`, v));
        }
      });
    }
    this.atoms = atom(`${name}:atoms`, atoms);
  }
  name;
  atoms;
  /**
   * Retrieves the underlying atom for a given key.
   *
   * @param key - The key to retrieve the atom for
   * @returns The atom containing the value, or undefined if the key doesn't exist
   * @internal
   */
  getAtom(key) {
    const valueAtom = this.atoms.__unsafe__getWithoutCapture().get(key);
    if (!valueAtom) {
      this.atoms.get();
      return void 0;
    }
    return valueAtom;
  }
  /**
   * Gets the value associated with a key. Returns undefined if the key doesn't exist.
   * This method is reactive and will cause reactive contexts to update when the value changes.
   *
   * @param key - The key to retrieve the value for
   * @returns The value associated with the key, or undefined if not found
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * map.set('name', 'Alice')
   * console.log(map.get('name')) // 'Alice'
   * console.log(map.get('missing')) // undefined
   * ```
   */
  get(key) {
    const value = this.getAtom(key)?.get();
    assert(value !== UNINITIALIZED);
    return value;
  }
  /**
   * Gets the value associated with a key without creating reactive dependencies.
   * This method will not cause reactive contexts to update when the value changes.
   *
   * @param key - The key to retrieve the value for
   * @returns The value associated with the key, or undefined if not found
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * map.set('count', 42)
   * const value = map.__unsafe__getWithoutCapture('count') // No reactive subscription
   * ```
   */
  __unsafe__getWithoutCapture(key) {
    const valueAtom = this.atoms.__unsafe__getWithoutCapture().get(key);
    if (!valueAtom) return void 0;
    const value = valueAtom.__unsafe__getWithoutCapture();
    assert(value !== UNINITIALIZED);
    return value;
  }
  /**
   * Checks whether a key exists in the map.
   * This method is reactive and will cause reactive contexts to update when keys are added or removed.
   *
   * @param key - The key to check for
   * @returns True if the key exists in the map, false otherwise
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * console.log(map.has('name')) // false
   * map.set('name', 'Alice')
   * console.log(map.has('name')) // true
   * ```
   */
  has(key) {
    const valueAtom = this.getAtom(key);
    if (!valueAtom) {
      return false;
    }
    return valueAtom.get() !== UNINITIALIZED;
  }
  /**
   * Checks whether a key exists in the map without creating reactive dependencies.
   * This method will not cause reactive contexts to update when keys are added or removed.
   *
   * @param key - The key to check for
   * @returns True if the key exists in the map, false otherwise
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * map.set('active', true)
   * const exists = map.__unsafe__hasWithoutCapture('active') // No reactive subscription
   * ```
   */
  __unsafe__hasWithoutCapture(key) {
    const valueAtom = this.atoms.__unsafe__getWithoutCapture().get(key);
    if (!valueAtom) return false;
    assert(valueAtom.__unsafe__getWithoutCapture() !== UNINITIALIZED);
    return true;
  }
  /**
   * Sets a value for the given key. If the key already exists, its value is updated.
   * If the key doesn't exist, a new entry is created.
   *
   * @param key - The key to set the value for
   * @param value - The value to associate with the key
   * @returns This AtomMap instance for method chaining
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * map.set('name', 'Alice').set('age', 30)
   * ```
   */
  set(key, value) {
    const existingAtom = this.atoms.__unsafe__getWithoutCapture().get(key);
    if (existingAtom) {
      existingAtom.set(value);
    } else {
      this.atoms.update((atoms) => {
        return atoms.set(key, atom(`${this.name}:${String(key)}`, value));
      });
    }
    return this;
  }
  /**
   * Updates an existing value using an updater function.
   *
   * @param key - The key of the value to update
   * @param updater - A function that receives the current value and returns the new value
   * @throws Error if the key doesn't exist in the map
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * map.set('count', 5)
   * map.update('count', count => count + 1) // count is now 6
   * ```
   */
  update(key, updater) {
    const valueAtom = this.atoms.__unsafe__getWithoutCapture().get(key);
    if (!valueAtom) {
      throw new Error(`AtomMap: key ${key} not found`);
    }
    const value = valueAtom.__unsafe__getWithoutCapture();
    assert(value !== UNINITIALIZED);
    valueAtom.set(updater(value));
  }
  /**
   * Removes a key-value pair from the map.
   *
   * @param key - The key to remove
   * @returns True if the key existed and was removed, false if it didn't exist
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * map.set('temp', 'value')
   * console.log(map.delete('temp')) // true
   * console.log(map.delete('missing')) // false
   * ```
   */
  delete(key) {
    const valueAtom = this.atoms.__unsafe__getWithoutCapture().get(key);
    if (!valueAtom) {
      return false;
    }
    transact(() => {
      valueAtom.set(UNINITIALIZED);
      this.atoms.update((atoms) => {
        return atoms.delete(key);
      });
    });
    return true;
  }
  /**
   * Removes multiple key-value pairs from the map in a single transaction.
   *
   * @param keys - An iterable of keys to remove
   * @returns An array of [key, value] pairs that were actually deleted
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * map.set('a', 1).set('b', 2).set('c', 3)
   * const deleted = map.deleteMany(['a', 'c', 'missing'])
   * console.log(deleted) // [['a', 1], ['c', 3]]
   * ```
   */
  deleteMany(keys) {
    return transact(() => {
      const deleted = [];
      const newAtoms = this.atoms.get().withMutations((atoms) => {
        for (const key of keys) {
          const valueAtom = atoms.get(key);
          if (!valueAtom) continue;
          const oldValue = valueAtom.get();
          assert(oldValue !== UNINITIALIZED);
          deleted.push([key, oldValue]);
          atoms.delete(key);
          valueAtom.set(UNINITIALIZED);
        }
      });
      if (deleted.length) {
        this.atoms.set(newAtoms);
      }
      return deleted;
    });
  }
  /**
   * Removes all key-value pairs from the map.
   *
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * map.set('a', 1).set('b', 2)
   * map.clear()
   * console.log(map.size) // 0
   * ```
   */
  clear() {
    return transact(() => {
      for (const valueAtom of this.atoms.__unsafe__getWithoutCapture().values()) {
        valueAtom.set(UNINITIALIZED);
      }
      this.atoms.set(emptyMap());
    });
  }
  /**
   * Returns an iterator that yields [key, value] pairs for each entry in the map.
   * This method is reactive and will cause reactive contexts to update when entries change.
   *
   * @returns A generator that yields [key, value] tuples
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * map.set('a', 1).set('b', 2)
   * for (const [key, value] of map.entries()) {
   *   console.log(`${key}: ${value}`)
   * }
   * ```
   */
  *entries() {
    for (const [key, valueAtom] of this.atoms.get()) {
      const value = valueAtom.get();
      assert(value !== UNINITIALIZED);
      yield [key, value];
    }
  }
  /**
   * Returns an iterator that yields all keys in the map.
   * This method is reactive and will cause reactive contexts to update when keys change.
   *
   * @returns A generator that yields keys
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * map.set('name', 'Alice').set('age', 30)
   * for (const key of map.keys()) {
   *   console.log(key) // 'name', 'age'
   * }
   * ```
   */
  *keys() {
    for (const key of this.atoms.get().keys()) {
      yield key;
    }
  }
  /**
   * Returns an iterator that yields all values in the map.
   * This method is reactive and will cause reactive contexts to update when values change.
   *
   * @returns A generator that yields values
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * map.set('name', 'Alice').set('age', 30)
   * for (const value of map.values()) {
   *   console.log(value) // 'Alice', 30
   * }
   * ```
   */
  *values() {
    for (const valueAtom of this.atoms.get().values()) {
      const value = valueAtom.get();
      assert(value !== UNINITIALIZED);
      yield value;
    }
  }
  /**
   * The number of key-value pairs in the map.
   * This property is reactive and will cause reactive contexts to update when the size changes.
   *
   * @returns The number of entries in the map
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * console.log(map.size) // 0
   * map.set('a', 1)
   * console.log(map.size) // 1
   * ```
   */
  // eslint-disable-next-line tldraw/no-setter-getter
  get size() {
    return this.atoms.get().size;
  }
  /**
   * Executes a provided function once for each key-value pair in the map.
   * This method is reactive and will cause reactive contexts to update when entries change.
   *
   * @param callbackfn - Function to execute for each entry
   *   - value - The value of the current entry
   *   - key - The key of the current entry
   *   - map - The AtomMap being traversed
   * @param thisArg - Value to use as `this` when executing the callback
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * map.set('a', 1).set('b', 2)
   * map.forEach((value, key) => {
   *   console.log(`${key} = ${value}`)
   * })
   * ```
   */
  forEach(callbackfn, thisArg) {
    for (const [key, value] of this.entries()) {
      callbackfn.call(thisArg, value, key, this);
    }
  }
  /**
   * Returns the default iterator for the map, which is the same as entries().
   * This allows the map to be used in for...of loops and other iterable contexts.
   *
   * @returns The same iterator as entries()
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * map.set('a', 1).set('b', 2)
   *
   * // These are equivalent:
   * for (const [key, value] of map) {
   *   console.log(`${key}: ${value}`)
   * }
   *
   * for (const [key, value] of map.entries()) {
   *   console.log(`${key}: ${value}`)
   * }
   * ```
   */
  [Symbol.iterator]() {
    return this.entries();
  }
  /**
   * The string tag used by Object.prototype.toString for this class.
   *
   * @example
   * ```ts
   * const map = new AtomMap('myMap')
   * console.log(Object.prototype.toString.call(map)) // '[object AtomMap]'
   * ```
   */
  [Symbol.toStringTag] = "AtomMap";
};

// ../../node_modules/@tldraw/store/dist-esm/lib/AtomSet.mjs
var AtomSet = class {
  constructor(name, keys) {
    this.name = name;
    const entries = keys ? Array.from(keys, (k) => [k, k]) : void 0;
    this.map = new AtomMap(name, entries);
  }
  name;
  map;
  add(value) {
    this.map.set(value, value);
    return this;
  }
  clear() {
    this.map.clear();
  }
  delete(value) {
    return this.map.delete(value);
  }
  forEach(callbackfn, thisArg) {
    for (const value of this) {
      callbackfn.call(thisArg, value, value, this);
    }
  }
  has(value) {
    return this.map.has(value);
  }
  // eslint-disable-next-line tldraw/no-setter-getter
  get size() {
    return this.map.size;
  }
  entries() {
    return this.map.entries();
  }
  keys() {
    return this.map.keys();
  }
  values() {
    return this.map.keys();
  }
  [Symbol.iterator]() {
    return this.map.keys();
  }
  [Symbol.toStringTag] = "AtomSet";
};

// ../../node_modules/@tldraw/store/dist-esm/lib/isDev.mjs
var _isDev = false;
try {
  _isDev = true;
} catch (_e) {
}
try {
  _isDev = _isDev || import.meta.env.DEV || import.meta.env.TEST || import.meta.env.MODE === "development" || import.meta.env.MODE === "test";
} catch (_e) {
}
function isDev() {
  return _isDev;
}

// ../../node_modules/@tldraw/store/dist-esm/lib/devFreeze.mjs
function devFreeze(object2) {
  if (!isDev()) return object2;
  const proto = Object.getPrototypeOf(object2);
  if (proto && !(Array.isArray(object2) || proto === Object.prototype || proto === null || proto === STRUCTURED_CLONE_OBJECT_PROTOTYPE)) {
    console.error("cannot include non-js data in a record", object2);
    throw new Error("cannot include non-js data in a record");
  }
  if (Object.isFrozen(object2)) {
    return object2;
  }
  const propNames = Object.getOwnPropertyNames(object2);
  for (const name of propNames) {
    const value = object2[name];
    if (value && typeof value === "object") {
      devFreeze(value);
    }
  }
  return Object.freeze(object2);
}

// ../../node_modules/@tldraw/store/dist-esm/lib/IncrementalSetConstructor.mjs
var IncrementalSetConstructor = class {
  constructor(previousValue) {
    this.previousValue = previousValue;
  }
  previousValue;
  /**
   * The next value of the set.
   *
   * @internal
   */
  nextValue;
  /**
   * The diff of the set.
   *
   * @internal
   */
  diff;
  /**
   * Gets the result of the incremental set construction if any changes were made.
   * Returns undefined if no additions or removals occurred.
   *
   * @returns An object containing the final set value and the diff of changes,
   * or undefined if no changes were made
   *
   * @example
   * ```ts
   * const constructor = new IncrementalSetConstructor(new Set(['a', 'b']))
   * constructor.add('c')
   *
   * const result = constructor.get()
   * // result = {
   * //   value: Set(['a', 'b', 'c']),
   * //   diff: { added: Set(['c']) }
   * // }
   * ```
   *
   * @public
   */
  get() {
    const numRemoved = this.diff?.removed?.size ?? 0;
    const numAdded = this.diff?.added?.size ?? 0;
    if (numRemoved === 0 && numAdded === 0) {
      return void 0;
    }
    return { value: this.nextValue, diff: this.diff };
  }
  /**
   * Add an item to the set.
   *
   * @param item - The item to add.
   * @param wasAlreadyPresent - Whether the item was already present in the set.
   * @internal
   */
  _add(item, wasAlreadyPresent) {
    this.nextValue ??= new Set(this.previousValue);
    this.nextValue.add(item);
    this.diff ??= {};
    if (wasAlreadyPresent) {
      this.diff.removed?.delete(item);
    } else {
      this.diff.added ??= /* @__PURE__ */ new Set();
      this.diff.added.add(item);
    }
  }
  /**
   * Adds an item to the set. If the item was already present in the original set
   * and was previously removed during this construction, it will be restored.
   * If the item is already present and wasn't removed, this is a no-op.
   *
   * @param item - The item to add to the set
   *
   * @example
   * ```ts
   * const constructor = new IncrementalSetConstructor(new Set(['a', 'b']))
   * constructor.add('c') // Adds new item
   * constructor.add('a') // No-op, already present
   * constructor.remove('b')
   * constructor.add('b') // Restores previously removed item
   * ```
   *
   * @public
   */
  add(item) {
    const wasAlreadyPresent = this.previousValue.has(item);
    if (wasAlreadyPresent) {
      const wasRemoved = this.diff?.removed?.has(item);
      if (!wasRemoved) return;
      return this._add(item, wasAlreadyPresent);
    }
    const isCurrentlyPresent = this.nextValue?.has(item);
    if (isCurrentlyPresent) return;
    this._add(item, wasAlreadyPresent);
  }
  /**
   * Remove an item from the set.
   *
   * @param item - The item to remove.
   * @param wasAlreadyPresent - Whether the item was already present in the set.
   * @internal
   */
  _remove(item, wasAlreadyPresent) {
    this.nextValue ??= new Set(this.previousValue);
    this.nextValue.delete(item);
    this.diff ??= {};
    if (wasAlreadyPresent) {
      this.diff.removed ??= /* @__PURE__ */ new Set();
      this.diff.removed.add(item);
    } else {
      this.diff.added?.delete(item);
    }
  }
  /**
   * Removes an item from the set. If the item wasn't present in the original set
   * and was added during this construction, it will be removed from the added diff.
   * If the item is not present at all, this is a no-op.
   *
   * @param item - The item to remove from the set
   *
   * @example
   * ```ts
   * const constructor = new IncrementalSetConstructor(new Set(['a', 'b']))
   * constructor.remove('a') // Removes existing item
   * constructor.remove('c') // No-op, not present
   * constructor.add('d')
   * constructor.remove('d') // Removes recently added item
   * ```
   *
   * @public
   */
  remove(item) {
    const wasAlreadyPresent = this.previousValue.has(item);
    if (!wasAlreadyPresent) {
      const wasAdded = this.diff?.added?.has(item);
      if (!wasAdded) return;
      return this._remove(item, wasAlreadyPresent);
    }
    const hasAlreadyBeenRemoved = this.diff?.removed?.has(item);
    if (hasAlreadyBeenRemoved) return;
    this._remove(item, wasAlreadyPresent);
  }
};

// ../../node_modules/@tldraw/store/dist-esm/lib/migrate.mjs
function squashDependsOn(sequence) {
  const result = [];
  for (let i = sequence.length - 1; i >= 0; i--) {
    const elem = sequence[i];
    if (!("id" in elem)) {
      const dependsOn = elem.dependsOn;
      const prev = result[0];
      if (prev) {
        result[0] = {
          ...prev,
          dependsOn: dependsOn.concat(prev.dependsOn ?? [])
        };
      }
    } else {
      result.unshift(elem);
    }
  }
  return result;
}
function createMigrationSequence({
  sequence,
  sequenceId,
  retroactive = true
}) {
  const migrations = {
    sequenceId,
    retroactive,
    sequence: squashDependsOn(sequence)
  };
  validateMigrations(migrations);
  return migrations;
}
function createMigrationIds(sequenceId, versions) {
  return Object.fromEntries(
    objectMapEntries(versions).map(([key, version]) => [key, `${sequenceId}/${version}`])
  );
}
function createRecordMigrationSequence(opts) {
  const sequenceId = opts.sequenceId;
  return createMigrationSequence({
    sequenceId,
    retroactive: opts.retroactive ?? true,
    sequence: opts.sequence.map(
      (m) => "id" in m ? {
        ...m,
        scope: "record",
        filter: (r) => r.typeName === opts.recordType && (m.filter?.(r) ?? true) && (opts.filter?.(r) ?? true)
      } : m
    )
  });
}
function sortMigrations(migrations) {
  if (migrations.length === 0) return [];
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const dependents = /* @__PURE__ */ new Map();
  const inDegree = /* @__PURE__ */ new Map();
  const explicitDeps = /* @__PURE__ */ new Map();
  for (const m of migrations) {
    inDegree.set(m.id, 0);
    dependents.set(m.id, /* @__PURE__ */ new Set());
    explicitDeps.set(m.id, /* @__PURE__ */ new Set());
  }
  for (const m of migrations) {
    const { version, sequenceId } = parseMigrationId(m.id);
    const prevId = `${sequenceId}/${version - 1}`;
    if (byId.has(prevId)) {
      dependents.get(prevId).add(m.id);
      inDegree.set(m.id, inDegree.get(m.id) + 1);
    }
    if (m.dependsOn) {
      for (const depId of m.dependsOn) {
        if (byId.has(depId)) {
          dependents.get(depId).add(m.id);
          explicitDeps.get(m.id).add(depId);
          inDegree.set(m.id, inDegree.get(m.id) + 1);
        }
      }
    }
  }
  const ready = migrations.filter((m) => inDegree.get(m.id) === 0);
  const result = [];
  const processed = /* @__PURE__ */ new Set();
  while (ready.length > 0) {
    let bestCandidate;
    let bestCandidateScore = -Infinity;
    for (const m of ready) {
      let urgencyScore = 0;
      for (const depId of dependents.get(m.id) || []) {
        if (!processed.has(depId)) {
          urgencyScore += 1;
          if (explicitDeps.get(depId).has(m.id)) {
            urgencyScore += 100;
          }
        }
      }
      if (urgencyScore > bestCandidateScore || // Tiebreaker: prefer lower sequence/version
      urgencyScore === bestCandidateScore && m.id.localeCompare(bestCandidate?.id ?? "") < 0) {
        bestCandidate = m;
        bestCandidateScore = urgencyScore;
      }
    }
    const nextMigration = bestCandidate;
    ready.splice(ready.indexOf(nextMigration), 1);
    result.push(nextMigration);
    processed.add(nextMigration.id);
    for (const depId of dependents.get(nextMigration.id) || []) {
      if (!processed.has(depId)) {
        inDegree.set(depId, inDegree.get(depId) - 1);
        if (inDegree.get(depId) === 0) {
          ready.push(byId.get(depId));
        }
      }
    }
  }
  if (result.length !== migrations.length) {
    const unprocessed = migrations.filter((m) => !processed.has(m.id));
    assert(false, `Circular dependency in migrations: ${unprocessed[0].id}`);
  }
  return result;
}
function parseMigrationId(id) {
  const [sequenceId, version] = id.split("/");
  return { sequenceId, version: parseInt(version) };
}
function validateMigrationId(id, expectedSequenceId) {
  if (expectedSequenceId) {
    assert(
      id.startsWith(expectedSequenceId + "/"),
      `Every migration in sequence '${expectedSequenceId}' must have an id starting with '${expectedSequenceId}/'. Got invalid id: '${id}'`
    );
  }
  assert(id.match(/^(.*?)\/(0|[1-9]\d*)$/), `Invalid migration id: '${id}'`);
}
function validateMigrations(migrations) {
  assert(
    !migrations.sequenceId.includes("/"),
    `sequenceId cannot contain a '/', got ${migrations.sequenceId}`
  );
  assert(migrations.sequenceId.length, "sequenceId must be a non-empty string");
  if (migrations.sequence.length === 0) {
    return;
  }
  validateMigrationId(migrations.sequence[0].id, migrations.sequenceId);
  let n = parseMigrationId(migrations.sequence[0].id).version;
  assert(
    n === 1,
    `Expected the first migrationId to be '${migrations.sequenceId}/1' but got '${migrations.sequence[0].id}'`
  );
  for (let i = 1; i < migrations.sequence.length; i++) {
    const id = migrations.sequence[i].id;
    validateMigrationId(id, migrations.sequenceId);
    const m = parseMigrationId(id).version;
    assert(
      m === n + 1,
      `Migration id numbers must increase in increments of 1, expected ${migrations.sequenceId}/${n + 1} but got '${migrations.sequence[i].id}'`
    );
    n = m;
  }
}
var MigrationFailureReason = {
  IncompatibleSubtype: "incompatible-subtype",
  UnknownType: "unknown-type",
  TargetVersionTooNew: "target-version-too-new",
  TargetVersionTooOld: "target-version-too-old",
  MigrationError: "migration-error",
  UnrecognizedSubtype: "unrecognized-subtype"
};

// ../../node_modules/@tldraw/store/dist-esm/lib/RecordsDiff.mjs
function createEmptyRecordsDiff() {
  return { added: {}, updated: {}, removed: {} };
}
function reverseRecordsDiff(diff) {
  const result = { added: diff.removed, removed: diff.added, updated: {} };
  for (const [from, to] of Object.values(diff.updated)) {
    result.updated[from.id] = [to, from];
  }
  return result;
}
function isRecordsDiffEmpty(diff) {
  return !hasAnyKey(diff.added) && !hasAnyKey(diff.updated) && !hasAnyKey(diff.removed);
}
function hasAnyKey(obj) {
  for (const _ in obj) return true;
  return false;
}
function squashRecordDiffs(diffs, options) {
  const result = options?.mutateFirstDiff ? diffs[0] : { added: {}, removed: {}, updated: {} };
  squashRecordDiffsMutable(result, options?.mutateFirstDiff ? diffs.slice(1) : diffs);
  return result;
}
function squashRecordDiffsMutable(target, diffs) {
  for (const diff of diffs) {
    const targetHasRemoved = hasAnyKey(target.removed);
    for (const _id in diff.added) {
      const id = _id;
      const value = diff.added[id];
      if (targetHasRemoved && target.removed[id]) {
        const original = target.removed[id];
        delete target.removed[id];
        if (original !== value) {
          target.updated[id] = [original, value];
        }
      } else {
        target.added[id] = value;
      }
    }
    const targetHasAdded = hasAnyKey(target.added);
    for (const _id in diff.updated) {
      const id = _id;
      const to = diff.updated[id][1];
      if (targetHasAdded && target.added[id]) {
        target.added[id] = to;
        delete target.updated[id];
        if (targetHasRemoved) delete target.removed[id];
        continue;
      }
      const existing = target.updated[id];
      if (existing) {
        existing[1] = to;
        if (targetHasRemoved) delete target.removed[id];
        continue;
      }
      target.updated[id] = [diff.updated[id][0], to];
      if (targetHasRemoved) delete target.removed[id];
    }
    for (const _id in diff.removed) {
      const id = _id;
      if (target.added[id]) {
        delete target.added[id];
      } else if (target.updated[id]) {
        target.removed[id] = target.updated[id][0];
        delete target.updated[id];
      } else {
        target.removed[id] = diff.removed[id];
      }
    }
  }
}

// ../../node_modules/@tldraw/store/dist-esm/lib/RecordType.mjs
var RecordType = class _RecordType {
  /**
   * Creates a new RecordType instance.
   *
   * typeName - The unique type name for records created by this RecordType
   * config - Configuration object for the RecordType
   *   - createDefaultProperties - Function that returns default properties for new records
   *   - validator - Optional validator function for record validation
   *   - scope - Optional scope determining persistence behavior (defaults to 'document')
   *   - ephemeralKeys - Optional mapping of property names to ephemeral status
   * @public
   */
  constructor(typeName, config) {
    this.typeName = typeName;
    this.createDefaultProperties = config.createDefaultProperties;
    this.validator = config.validator ?? { validate: (r) => r };
    this.scope = config.scope ?? "document";
    this.ephemeralKeys = config.ephemeralKeys;
    const ephemeralKeySet = /* @__PURE__ */ new Set();
    if (config.ephemeralKeys) {
      for (const [key, isEphemeral] of objectMapEntries(config.ephemeralKeys)) {
        if (isEphemeral) ephemeralKeySet.add(key);
      }
    }
    this.ephemeralKeySet = ephemeralKeySet;
  }
  typeName;
  /**
   * Factory function that creates default properties for new records.
   * @public
   */
  createDefaultProperties;
  /**
   * Validator function used to validate records of this type.
   * @public
   */
  validator;
  /**
   * Optional configuration specifying which record properties are ephemeral.
   * Ephemeral properties are not included in snapshots or synchronization.
   * @public
   */
  ephemeralKeys;
  /**
   * Set of property names that are marked as ephemeral for efficient lookup.
   * @public
   */
  ephemeralKeySet;
  /**
   * The scope that determines how records of this type are persisted and synchronized.
   * @public
   */
  scope;
  /**
   * Creates a new record of this type with the given properties.
   *
   * Properties are merged with default properties from the RecordType configuration.
   * If no id is provided, a unique id will be generated automatically.
   *
   * @example
   * ```ts
   * const book = Book.create({
   *   title: 'The Great Gatsby',
   *   author: 'F. Scott Fitzgerald'
   * })
   * // Result: { id: 'book:abc123', typeName: 'book', title: 'The Great Gatsby', author: 'F. Scott Fitzgerald', inStock: true }
   * ```
   *
   * @param properties - The properties for the new record, including both required and optional fields
   * @returns The newly created record with generated id and typeName
   * @public
   */
  create(properties) {
    const result = {
      ...this.createDefaultProperties(),
      id: properties.id ?? this.createId()
    };
    for (const [k, v] of Object.entries(properties)) {
      if (v !== void 0) {
        result[k] = v;
      }
    }
    result.typeName = this.typeName;
    return result;
  }
  /**
   * Creates a deep copy of an existing record with a new unique id.
   *
   * This method performs a deep clone of all properties while generating a fresh id,
   * making it useful for duplicating records without id conflicts.
   *
   * @example
   * ```ts
   * const originalBook = Book.create({ title: '1984', author: 'George Orwell' })
   * const duplicatedBook = Book.clone(originalBook)
   * // duplicatedBook has same properties but different id
   * ```
   *
   * @param record - The record to clone
   * @returns A new record with the same properties but a different id
   * @public
   */
  clone(record) {
    return { ...structuredClone(record), id: this.createId() };
  }
  /**
   * Create a new ID for this record type.
   *
   * @example
   *
   * ```ts
   * const id = recordType.createId()
   * ```
   *
   * @returns The new ID.
   * @public
   */
  createId(customUniquePart) {
    return this.typeName + ":" + (customUniquePart ?? uniqueId());
  }
  /**
   * Extracts the unique identifier part from a full record id.
   *
   * Record ids have the format `typeName:uniquePart`. This method returns just the unique part.
   *
   * @example
   * ```ts
   * const bookId = Book.createId() // 'book:abc123'
   * const uniquePart = Book.parseId(bookId) // 'abc123'
   * ```
   *
   * @param id - The full record id to parse
   * @returns The unique identifier portion after the colon
   * @throws Error if the id is not valid for this record type
   * @public
   */
  parseId(id) {
    if (!this.isId(id)) {
      throw new Error(`ID "${id}" is not a valid ID for type "${this.typeName}"`);
    }
    return id.slice(this.typeName.length + 1);
  }
  /**
   * Type guard that checks whether a record belongs to this RecordType.
   *
   * This method performs a runtime check by comparing the record's typeName
   * against this RecordType's typeName.
   *
   * @example
   * ```ts
   * if (Book.isInstance(someRecord)) {
   *   // someRecord is now typed as a book record
   *   console.log(someRecord.title)
   * }
   * ```
   *
   * @param record - The record to check, may be undefined
   * @returns True if the record is an instance of this record type
   * @public
   */
  isInstance(record) {
    return record?.typeName === this.typeName;
  }
  /**
   * Type guard that checks whether an id string belongs to this RecordType.
   *
   * Validates that the id starts with this RecordType's typeName followed by a colon.
   * This is more efficient than parsing the full id when you only need to verify the type.
   *
   * @example
   * ```ts
   * if (Book.isId(someId)) {
   *   // someId is now typed as IdOf<BookRecord>
   *   const book = store.get(someId)
   * }
   * ```
   *
   * @param id - The id string to check, may be undefined
   * @returns True if the id belongs to this record type
   * @public
   */
  isId(id) {
    if (!id) return false;
    for (let i = 0; i < this.typeName.length; i++) {
      if (id[i] !== this.typeName[i]) return false;
    }
    return id[this.typeName.length] === ":";
  }
  /**
   * Create a new RecordType that has the same type name as this RecordType and includes the given
   * default properties.
   *
   * @example
   *
   * ```ts
   * const authorType = createRecordType('author', () => ({ living: true }))
   * const deadAuthorType = authorType.withDefaultProperties({ living: false })
   * ```
   *
   * @param createDefaultProperties - A function that returns the default properties of the new RecordType.
   * @returns The new RecordType.
   */
  withDefaultProperties(createDefaultProperties) {
    return new _RecordType(this.typeName, {
      createDefaultProperties,
      validator: this.validator,
      scope: this.scope,
      ephemeralKeys: this.ephemeralKeys
    });
  }
  /**
   * Validates a record against this RecordType's validator and returns it with proper typing.
   *
   * This method runs the configured validator function and throws an error if validation fails.
   * If a previous version of the record is provided, it may use optimized validation.
   *
   * @example
   * ```ts
   * try {
   *   const validBook = Book.validate(untrustedData)
   *   // validBook is now properly typed and validated
   * } catch (error) {
   *   console.log('Validation failed:', error.message)
   * }
   * ```
   *
   * @param record - The unknown record data to validate
   * @param recordBefore - Optional previous version for optimized validation
   * @returns The validated and properly typed record
   * @throws Error if validation fails
   * @public
   */
  validate(record, recordBefore) {
    if (recordBefore && this.validator.validateUsingKnownGoodVersion) {
      return this.validator.validateUsingKnownGoodVersion(recordBefore, record);
    }
    return this.validator.validate(record);
  }
};
function createRecordType(typeName, config) {
  return new RecordType(typeName, {
    createDefaultProperties: () => ({}),
    validator: config.validator,
    scope: config.scope,
    ephemeralKeys: config.ephemeralKeys
  });
}
function assertIdType(id, type) {
  if (!id || !type.isId(id)) {
    throw new Error(`string ${JSON.stringify(id)} is not a valid ${type.typeName} id`);
  }
}

// ../../node_modules/@tldraw/store/dist-esm/lib/setUtils.mjs
function intersectSets(sets) {
  if (sets.length === 0) return /* @__PURE__ */ new Set();
  const first = sets[0];
  const rest = sets.slice(1);
  const result = /* @__PURE__ */ new Set();
  for (const val of first) {
    if (rest.every((set) => set.has(val))) {
      result.add(val);
    }
  }
  return result;
}
function diffSets(prev, next) {
  const result = {};
  for (const val of next) {
    if (!prev.has(val)) {
      result.added ??= /* @__PURE__ */ new Set();
      result.added.add(val);
    }
  }
  for (const val of prev) {
    if (!next.has(val)) {
      result.removed ??= /* @__PURE__ */ new Set();
      result.removed.add(val);
    }
  }
  return result.added || result.removed ? result : void 0;
}

// ../../node_modules/@tldraw/store/dist-esm/lib/executeQuery.mjs
function isQueryValueMatcher(value) {
  if (typeof value !== "object" || value === null) return false;
  return "eq" in value || "neq" in value || "gt" in value;
}
function extractMatcherPaths(query, prefix = "") {
  const paths = [];
  for (const [key, value] of Object.entries(query)) {
    const currentPath = prefix ? `${prefix}\\${key}` : key;
    if (isQueryValueMatcher(value)) {
      paths.push({ path: currentPath, matcher: value });
    } else if (typeof value === "object" && value !== null) {
      paths.push(...extractMatcherPaths(value, currentPath));
    }
  }
  return paths;
}
function objectMatchesQuery(query, object2) {
  for (const [key, matcher] of Object.entries(query)) {
    const value = object2[key];
    if (isQueryValueMatcher(matcher)) {
      if ("eq" in matcher && value !== matcher.eq) return false;
      if ("neq" in matcher && (value === matcher.neq || value === void 0)) return false;
      if ("gt" in matcher && (typeof value !== "number" || value <= matcher.gt)) return false;
      continue;
    }
    if (typeof value !== "object" || value === null) return false;
    if (!objectMatchesQuery(matcher, value)) {
      return false;
    }
  }
  return true;
}
function executeQuery(store, typeName, query) {
  const matcherPaths = extractMatcherPaths(query);
  const matchIds = Object.fromEntries(matcherPaths.map(({ path }) => [path, /* @__PURE__ */ new Set()]));
  for (const { path, matcher } of matcherPaths) {
    const index = store.index(typeName, path);
    if ("eq" in matcher) {
      const ids = index.get().get(matcher.eq);
      if (ids) {
        for (const id of ids) {
          matchIds[path].add(id);
        }
      }
    } else if ("neq" in matcher) {
      for (const [value, ids] of index.get()) {
        if (value !== matcher.neq) {
          for (const id of ids) {
            matchIds[path].add(id);
          }
        }
      }
    } else if ("gt" in matcher) {
      for (const [value, ids] of index.get()) {
        if (typeof value === "number" && value > matcher.gt) {
          for (const id of ids) {
            matchIds[path].add(id);
          }
        }
      }
    }
    if (matchIds[path].size === 0) {
      return /* @__PURE__ */ new Set();
    }
  }
  return intersectSets(Object.values(matchIds));
}

// ../../node_modules/@tldraw/store/dist-esm/lib/StoreQueries.mjs
var StoreQueries = class {
  /**
   * Creates a new StoreQueries instance.
   *
   * recordMap - The atom map containing all records in the store
   * history - The atom tracking the store's change history with diffs
   *
   * @internal
   */
  constructor(recordMap, history) {
    this.recordMap = recordMap;
    this.history = history;
  }
  recordMap;
  history;
  /**
   * A cache of derivations (indexes).
   *
   * @internal
   */
  indexCache = /* @__PURE__ */ new Map();
  /**
   * A cache of derivations (filtered histories).
   *
   * @internal
   */
  historyCache = /* @__PURE__ */ new Map();
  /**
   * @internal
   */
  getAllIdsForType(typeName) {
    const ids = /* @__PURE__ */ new Set();
    for (const record of this.recordMap.values()) {
      if (record.typeName === typeName) {
        ids.add(record.id);
      }
    }
    return ids;
  }
  /**
   * @internal
   */
  getRecordById(typeName, id) {
    const record = this.recordMap.get(id);
    if (record && record.typeName === typeName) {
      return record;
    }
    return void 0;
  }
  /**
   * Helper to extract nested property value using pre-split path parts.
   * @internal
   */
  getNestedValue(obj, pathParts) {
    let current = obj;
    for (const part of pathParts) {
      if (current == null || typeof current !== "object") return void 0;
      current = current[part];
    }
    return current;
  }
  /**
   * Creates a reactive computed that tracks the change history for records of a specific type.
   * The returned computed provides incremental diffs showing what records of the given type
   * have been added, updated, or removed.
   *
   * @param typeName - The type name to filter the history by
   * @returns A computed value containing the current epoch and diffs of changes for the specified type
   *
   * @example
   * ```ts
   * // Track changes to book records only
   * const bookHistory = store.query.filterHistory('book')
   *
   * // React to book changes
   * react('book-changes', () => {
   *   const currentEpoch = bookHistory.get()
   *   console.log('Books updated at epoch:', currentEpoch)
   * })
   * ```
   *
   * @public
   */
  filterHistory(typeName) {
    if (this.historyCache.has(typeName)) {
      return this.historyCache.get(typeName);
    }
    const filtered = computed(
      "filterHistory:" + typeName,
      (lastValue, lastComputedEpoch) => {
        if (isUninitialized(lastValue)) {
          return this.history.get();
        }
        const diff = this.history.getDiffSince(lastComputedEpoch);
        if (diff === RESET_VALUE) return this.history.get();
        const res = { added: {}, removed: {}, updated: {} };
        let numAdded = 0;
        let numRemoved = 0;
        let numUpdated = 0;
        for (const changes of diff) {
          for (const added of objectMapValues(changes.added)) {
            if (added.typeName === typeName) {
              if (res.removed[added.id]) {
                const original = res.removed[added.id];
                delete res.removed[added.id];
                numRemoved--;
                if (original !== added) {
                  res.updated[added.id] = [original, added];
                  numUpdated++;
                }
              } else {
                res.added[added.id] = added;
                numAdded++;
              }
            }
          }
          for (const [from, to] of objectMapValues(changes.updated)) {
            if (to.typeName === typeName) {
              if (res.added[to.id]) {
                res.added[to.id] = to;
              } else if (res.updated[to.id]) {
                res.updated[to.id] = [res.updated[to.id][0], to];
              } else {
                res.updated[to.id] = [from, to];
                numUpdated++;
              }
            }
          }
          for (const removed of objectMapValues(changes.removed)) {
            if (removed.typeName === typeName) {
              if (res.added[removed.id]) {
                delete res.added[removed.id];
                numAdded--;
              } else if (res.updated[removed.id]) {
                res.removed[removed.id] = res.updated[removed.id][0];
                delete res.updated[removed.id];
                numUpdated--;
                numRemoved++;
              } else {
                res.removed[removed.id] = removed;
                numRemoved++;
              }
            }
          }
        }
        if (numAdded || numRemoved || numUpdated) {
          return withDiff(this.history.get(), res);
        } else {
          return lastValue;
        }
      },
      { historyLength: 100 }
    );
    this.historyCache.set(typeName, filtered);
    return filtered;
  }
  /**
   * Creates a reactive index that maps property values to sets of record IDs for efficient lookups.
   * The index automatically updates when records are added, updated, or removed, and results are cached
   * for performance.
   *
   * Supports nested property paths using backslash separator (e.g., 'metadata\\sessionId').
   *
   * @param typeName - The type name of records to index
   * @param path - The property name or backslash-delimited path to index by
   * @returns A reactive computed containing the index map with change diffs
   *
   * @example
   * ```ts
   * // Create an index of books by author ID
   * const booksByAuthor = store.query.index('book', 'authorId')
   *
   * // Get all books by a specific author
   * const authorBooks = booksByAuthor.get().get('author:leguin')
   * console.log(authorBooks) // Set<RecordId<Book>>
   *
   * // Index by nested property using backslash separator
   * const booksBySession = store.query.index('book', 'metadata\\sessionId')
   * const sessionBooks = booksBySession.get().get('session:alpha')
   * ```
   *
   * @public
   */
  index(typeName, path) {
    const cacheKey = typeName + ":" + path;
    if (this.indexCache.has(cacheKey)) {
      return this.indexCache.get(cacheKey);
    }
    const index = this.__uncached_createIndex(typeName, path);
    this.indexCache.set(cacheKey, index);
    return index;
  }
  /**
   * Creates a new index without checking the cache. This method performs the actual work
   * of building the reactive index computation that tracks property values to record ID sets.
   *
   * Supports nested property paths using backslash separator.
   *
   * @param typeName - The type name of records to index
   * @param path - The property name or backslash-delimited path to index by
   * @returns A reactive computed containing the index map with change diffs
   *
   * @internal
   */
  __uncached_createIndex(typeName, path) {
    const typeHistory = this.filterHistory(typeName);
    const pathParts = path.split("\\");
    const getPropertyValue = pathParts.length > 1 ? (obj) => this.getNestedValue(obj, pathParts) : (obj) => obj[path];
    const fromScratch = () => {
      typeHistory.get();
      const res = /* @__PURE__ */ new Map();
      for (const record of this.recordMap.values()) {
        if (record.typeName === typeName) {
          const value = getPropertyValue(record);
          if (value !== void 0) {
            if (!res.has(value)) {
              res.set(value, /* @__PURE__ */ new Set());
            }
            res.get(value).add(record.id);
          }
        }
      }
      return res;
    };
    return computed(
      "index:" + typeName + ":" + path,
      (prevValue, lastComputedEpoch) => {
        if (isUninitialized(prevValue)) return fromScratch();
        const history = typeHistory.getDiffSince(lastComputedEpoch);
        if (history === RESET_VALUE) {
          return fromScratch();
        }
        const setConstructors = /* @__PURE__ */ new Map();
        const add = (value, id) => {
          let setConstructor = setConstructors.get(value);
          if (!setConstructor)
            setConstructor = new IncrementalSetConstructor(
              prevValue.get(value) ?? /* @__PURE__ */ new Set()
            );
          setConstructor.add(id);
          setConstructors.set(value, setConstructor);
        };
        const remove2 = (value, id) => {
          let set = setConstructors.get(value);
          if (!set) set = new IncrementalSetConstructor(prevValue.get(value) ?? /* @__PURE__ */ new Set());
          set.remove(id);
          setConstructors.set(value, set);
        };
        for (const changes of history) {
          for (const record of objectMapValues(changes.added)) {
            if (record.typeName === typeName) {
              const value = getPropertyValue(record);
              if (value !== void 0) {
                add(value, record.id);
              }
            }
          }
          for (const [from, to] of objectMapValues(changes.updated)) {
            if (to.typeName === typeName) {
              const prev = getPropertyValue(from);
              const next = getPropertyValue(to);
              if (prev !== next) {
                if (prev !== void 0) {
                  remove2(prev, to.id);
                }
                if (next !== void 0) {
                  add(next, to.id);
                }
              }
            }
          }
          for (const record of objectMapValues(changes.removed)) {
            if (record.typeName === typeName) {
              const value = getPropertyValue(record);
              if (value !== void 0) {
                remove2(value, record.id);
              }
            }
          }
        }
        let nextValue = void 0;
        let nextDiff = void 0;
        for (const [value, setConstructor] of setConstructors) {
          const result = setConstructor.get();
          if (!result) continue;
          if (!nextValue) nextValue = new Map(prevValue);
          if (!nextDiff) nextDiff = /* @__PURE__ */ new Map();
          if (result.value.size === 0) {
            nextValue.delete(value);
          } else {
            nextValue.set(value, result.value);
          }
          nextDiff.set(value, result.diff);
        }
        if (nextValue && nextDiff) {
          return withDiff(nextValue, nextDiff);
        }
        return prevValue;
      },
      { historyLength: 100 }
    );
  }
  /**
   * Creates a reactive query that returns the first record matching the given query criteria.
   * Returns undefined if no matching record is found. The query automatically updates
   * when records change.
   *
   * @param typeName - The type name of records to query
   * @param queryCreator - Function that returns the query expression object to match against
   * @param name - Optional name for the query computation (used for debugging)
   * @returns A computed value containing the first matching record or undefined
   *
   * @example
   * ```ts
   * // Find the first book with a specific title
   * const bookLatheOfHeaven = store.query.record('book', () => ({ title: { eq: 'The Lathe of Heaven' } }))
   * console.log(bookLatheOfHeaven.get()?.title) // 'The Lathe of Heaven' or undefined
   *
   * // Find any book in stock
   * const anyInStockBook = store.query.record('book', () => ({ inStock: { eq: true } }))
   * ```
   *
   * @public
   */
  record(typeName, queryCreator = () => ({}), name = "record:" + typeName + (queryCreator ? ":" + queryCreator.toString() : "")) {
    const ids = this.ids(typeName, queryCreator, name);
    return computed(name, () => {
      for (const id of ids.get()) {
        return this.recordMap.get(id);
      }
      return void 0;
    });
  }
  /**
   * Creates a reactive query that returns an array of all records matching the given query criteria.
   * The array automatically updates when records are added, updated, or removed.
   *
   * @param typeName - The type name of records to query
   * @param queryCreator - Function that returns the query expression object to match against
   * @param name - Optional name for the query computation (used for debugging)
   * @returns A computed value containing an array of all matching records
   *
   * @example
   * ```ts
   * // Get all books in stock
   * const inStockBooks = store.query.records('book', () => ({ inStock: { eq: true } }))
   * console.log(inStockBooks.get()) // Book[]
   *
   * // Get all books by a specific author
   * const leguinBooks = store.query.records('book', () => ({ authorId: { eq: 'author:leguin' } }))
   *
   * // Get all books (no filter)
   * const allBooks = store.query.records('book')
   * ```
   *
   * @public
   */
  records(typeName, queryCreator = () => ({}), name = "records:" + typeName + (queryCreator ? ":" + queryCreator.toString() : "")) {
    const ids = this.ids(typeName, queryCreator, "ids:" + name);
    return computed(
      name,
      () => {
        return Array.from(ids.get(), (id) => this.recordMap.get(id));
      },
      {
        isEqual: areArraysShallowEqual
      }
    );
  }
  /**
   * Creates a reactive query that returns a set of record IDs matching the given query criteria.
   * This is more efficient than `records()` when you only need the IDs and not the full record objects.
   * The set automatically updates with collection diffs when records change.
   *
   * @param typeName - The type name of records to query
   * @param queryCreator - Function that returns the query expression object to match against
   * @param name - Optional name for the query computation (used for debugging)
   * @returns A computed value containing a set of matching record IDs with collection diffs
   *
   * @example
   * ```ts
   * // Get IDs of all books in stock
   * const inStockBookIds = store.query.ids('book', () => ({ inStock: { eq: true } }))
   * console.log(inStockBookIds.get()) // Set<RecordId<Book>>
   *
   * // Get all book IDs (no filter)
   * const allBookIds = store.query.ids('book')
   *
   * // Use with other queries for efficient lookups
   * const authorBookIds = store.query.ids('book', () => ({ authorId: { eq: 'author:leguin' } }))
   * ```
   *
   * @public
   */
  ids(typeName, queryCreator = () => ({}), name = "ids:" + typeName + (queryCreator ? ":" + queryCreator.toString() : "")) {
    const typeHistory = this.filterHistory(typeName);
    const fromScratch = () => {
      typeHistory.get();
      const query = queryCreator();
      if (Object.keys(query).length === 0) {
        return this.getAllIdsForType(typeName);
      }
      return executeQuery(this, typeName, query);
    };
    const fromScratchWithDiff = (prevValue) => {
      const nextValue = fromScratch();
      const diff = diffSets(prevValue, nextValue);
      if (diff) {
        return withDiff(nextValue, diff);
      } else {
        return prevValue;
      }
    };
    const cachedQuery = computed("ids_query:" + name, queryCreator, {
      isEqual: import_lodash2.default
    });
    return computed(
      "query:" + name,
      (prevValue, lastComputedEpoch) => {
        const query = cachedQuery.get();
        if (isUninitialized(prevValue)) {
          return fromScratch();
        }
        if (lastComputedEpoch < cachedQuery.lastChangedEpoch) {
          return fromScratchWithDiff(prevValue);
        }
        const history = typeHistory.getDiffSince(lastComputedEpoch);
        if (history === RESET_VALUE) {
          return fromScratchWithDiff(prevValue);
        }
        const setConstructor = new IncrementalSetConstructor(
          prevValue
        );
        for (const changes of history) {
          for (const added of objectMapValues(changes.added)) {
            if (added.typeName === typeName && objectMatchesQuery(query, added)) {
              setConstructor.add(added.id);
            }
          }
          for (const [_, updated] of objectMapValues(changes.updated)) {
            if (updated.typeName === typeName) {
              if (objectMatchesQuery(query, updated)) {
                setConstructor.add(updated.id);
              } else {
                setConstructor.remove(updated.id);
              }
            }
          }
          for (const removed of objectMapValues(changes.removed)) {
            if (removed.typeName === typeName) {
              setConstructor.remove(removed.id);
            }
          }
        }
        const result = setConstructor.get();
        if (!result) {
          return prevValue;
        }
        return withDiff(result.value, result.diff);
      },
      { historyLength: 50 }
    );
  }
  /**
   * Executes a one-time query against the current store state and returns matching records.
   * This is a non-reactive query that returns results immediately without creating a computed value.
   * Use this when you need a snapshot of data at a specific point in time.
   *
   * @param typeName - The type name of records to query
   * @param query - The query expression object to match against
   * @returns An array of records that match the query at the current moment
   *
   * @example
   * ```ts
   * // Get current in-stock books (non-reactive)
   * const currentInStockBooks = store.query.exec('book', { inStock: { eq: true } })
   * console.log(currentInStockBooks) // Book[]
   *
   * // Unlike records(), this won't update when the data changes
   * const staticBookList = store.query.exec('book', { authorId: { eq: 'author:leguin' } })
   * ```
   *
   * @public
   */
  exec(typeName, query) {
    const ids = executeQuery(this, typeName, query);
    if (ids.size === 0) {
      return EMPTY_ARRAY;
    }
    return Array.from(ids, (id) => this.recordMap.get(id));
  }
};

// ../../node_modules/@tldraw/store/dist-esm/lib/StoreSideEffects.mjs
var StoreSideEffects = class {
  /**
   * Creates a new side effects manager for the given store.
   *
   * store - The store instance to manage side effects for
   */
  constructor(store) {
    this.store = store;
  }
  store;
  _beforeCreateHandlers = {};
  _afterCreateHandlers = {};
  _beforeChangeHandlers = {};
  _afterChangeHandlers = {};
  _beforeDeleteHandlers = {};
  _afterDeleteHandlers = {};
  _operationCompleteHandlers = [];
  _isEnabled = true;
  /**
   * Checks whether side effects are currently enabled.
   * When disabled, all side effect handlers are bypassed.
   *
   * @returns `true` if side effects are enabled, `false` otherwise
   * @internal
   */
  isEnabled() {
    return this._isEnabled;
  }
  /**
   * Enables or disables side effects processing.
   * When disabled, no side effect handlers will be called.
   *
   * @param enabled - Whether to enable or disable side effects
   * @internal
   */
  setIsEnabled(enabled) {
    this._isEnabled = enabled;
  }
  /**
   * Processes all registered 'before create' handlers for a record.
   * Handlers are called in registration order and can transform the record.
   *
   * @param record - The record about to be created
   * @param source - Whether the change originated from 'user' or 'remote'
   * @returns The potentially modified record to actually create
   * @internal
   */
  handleBeforeCreate(record, source) {
    if (!this._isEnabled) return record;
    const handlers = this._beforeCreateHandlers[record.typeName];
    if (handlers) {
      let r = record;
      for (const handler of handlers) {
        r = handler(r, source);
      }
      return r;
    }
    return record;
  }
  /**
   * Processes all registered 'after create' handlers for a record.
   * Handlers are called in registration order after the record is created.
   *
   * @param record - The record that was created
   * @param source - Whether the change originated from 'user' or 'remote'
   * @internal
   */
  handleAfterCreate(record, source) {
    if (!this._isEnabled) return;
    const handlers = this._afterCreateHandlers[record.typeName];
    if (handlers) {
      for (const handler of handlers) {
        handler(record, source);
      }
    }
  }
  /**
   * Processes all registered 'before change' handlers for a record.
   * Handlers are called in registration order and can modify or block the change.
   *
   * @param prev - The current version of the record
   * @param next - The proposed new version of the record
   * @param source - Whether the change originated from 'user' or 'remote'
   * @returns The potentially modified record to actually store
   * @internal
   */
  handleBeforeChange(prev, next, source) {
    if (!this._isEnabled) return next;
    const handlers = this._beforeChangeHandlers[next.typeName];
    if (handlers) {
      let r = next;
      for (const handler of handlers) {
        r = handler(prev, r, source);
      }
      return r;
    }
    return next;
  }
  /**
   * Processes all registered 'after change' handlers for a record.
   * Handlers are called in registration order after the record is updated.
   *
   * @param prev - The previous version of the record
   * @param next - The new version of the record that was stored
   * @param source - Whether the change originated from 'user' or 'remote'
   * @internal
   */
  handleAfterChange(prev, next, source) {
    if (!this._isEnabled) return;
    const handlers = this._afterChangeHandlers[next.typeName];
    if (handlers) {
      for (const handler of handlers) {
        handler(prev, next, source);
      }
    }
  }
  /**
   * Processes all registered 'before delete' handlers for a record.
   * If any handler returns `false`, the deletion is prevented.
   *
   * @param record - The record about to be deleted
   * @param source - Whether the change originated from 'user' or 'remote'
   * @returns `true` to allow deletion, `false` to prevent it
   * @internal
   */
  handleBeforeDelete(record, source) {
    if (!this._isEnabled) return true;
    const handlers = this._beforeDeleteHandlers[record.typeName];
    if (handlers) {
      for (const handler of handlers) {
        if (handler(record, source) === false) {
          return false;
        }
      }
    }
    return true;
  }
  /**
   * Processes all registered 'after delete' handlers for a record.
   * Handlers are called in registration order after the record is deleted.
   *
   * @param record - The record that was deleted
   * @param source - Whether the change originated from 'user' or 'remote'
   * @internal
   */
  handleAfterDelete(record, source) {
    if (!this._isEnabled) return;
    const handlers = this._afterDeleteHandlers[record.typeName];
    if (handlers) {
      for (const handler of handlers) {
        handler(record, source);
      }
    }
  }
  /**
   * Processes all registered operation complete handlers.
   * Called after an atomic store operation finishes.
   *
   * @param source - Whether the operation originated from 'user' or 'remote'
   * @internal
   */
  handleOperationComplete(source) {
    if (!this._isEnabled) return;
    for (const handler of this._operationCompleteHandlers) {
      handler(source);
    }
  }
  /**
   * Internal helper for registering multiple side effect handlers at once and keeping them organized.
   * This provides a convenient way to register handlers for multiple record types and lifecycle events
   * in a single call, returning a single cleanup function.
   *
   * @param handlersByType - An object mapping record type names to their respective handlers
   * @returns A function that removes all registered handlers when called
   *
   * @example
   * ```ts
   * const cleanup = sideEffects.register({
   *   shape: {
   *     afterDelete: (shape) => console.log('Shape deleted:', shape.id),
   *     beforeChange: (prev, next) => ({ ...next, lastModified: Date.now() })
   *   },
   *   arrow: {
   *     afterCreate: (arrow) => updateConnectedShapes(arrow)
   *   }
   * })
   *
   * // Later, remove all handlers
   * cleanup()
   * ```
   *
   * @internal
   */
  register(handlersByType) {
    const disposes = [];
    for (const [type, handlers] of Object.entries(handlersByType)) {
      if (handlers?.beforeCreate) {
        disposes.push(this.registerBeforeCreateHandler(type, handlers.beforeCreate));
      }
      if (handlers?.afterCreate) {
        disposes.push(this.registerAfterCreateHandler(type, handlers.afterCreate));
      }
      if (handlers?.beforeChange) {
        disposes.push(this.registerBeforeChangeHandler(type, handlers.beforeChange));
      }
      if (handlers?.afterChange) {
        disposes.push(this.registerAfterChangeHandler(type, handlers.afterChange));
      }
      if (handlers?.beforeDelete) {
        disposes.push(this.registerBeforeDeleteHandler(type, handlers.beforeDelete));
      }
      if (handlers?.afterDelete) {
        disposes.push(this.registerAfterDeleteHandler(type, handlers.afterDelete));
      }
    }
    return () => {
      for (const dispose of disposes) dispose();
    };
  }
  /**
   * Register a handler to be called before a record of a certain type is created. Return a
   * modified record from the handler to change the record that will be created.
   *
   * Use this handle only to modify the creation of the record itself. If you want to trigger a
   * side-effect on a different record (for example, moving one shape when another is created),
   * use {@link StoreSideEffects.registerAfterCreateHandler} instead.
   *
   * @example
   * ```ts
   * editor.sideEffects.registerBeforeCreateHandler('shape', (shape, source) => {
   *     // only modify shapes created by the user
   *     if (source !== 'user') return shape
   *
   *     //by default, arrow shapes have no label. Let's make sure they always have a label.
   *     if (shape.type === 'arrow') {
   *         return {...shape, props: {...shape.props, text: 'an arrow'}}
   *     }
   *
   *     // other shapes get returned unmodified
   *     return shape
   * })
   * ```
   *
   * @param typeName - The type of record to listen for
   * @param handler - The handler to call
   *
   * @returns A callback that removes the handler.
   */
  registerBeforeCreateHandler(typeName, handler) {
    const handlers = this._beforeCreateHandlers[typeName];
    if (!handlers) this._beforeCreateHandlers[typeName] = [];
    this._beforeCreateHandlers[typeName].push(handler);
    return () => remove(this._beforeCreateHandlers[typeName], handler);
  }
  /**
   * Register a handler to be called after a record is created. This is useful for side-effects
   * that would update _other_ records. If you want to modify the record being created use
   * {@link StoreSideEffects.registerBeforeCreateHandler} instead.
   *
   * @example
   * ```ts
   * editor.sideEffects.registerAfterCreateHandler('page', (page, source) => {
   *     // Automatically create a shape when a page is created
   *     editor.createShape({
   *         id: createShapeId(),
   *         type: 'text',
   *         props: { richText: toRichText(page.name) },
   *     })
   * })
   * ```
   *
   * @param typeName - The type of record to listen for
   * @param handler - The handler to call
   *
   * @returns A callback that removes the handler.
   */
  registerAfterCreateHandler(typeName, handler) {
    const handlers = this._afterCreateHandlers[typeName];
    if (!handlers) this._afterCreateHandlers[typeName] = [];
    this._afterCreateHandlers[typeName].push(handler);
    return () => remove(this._afterCreateHandlers[typeName], handler);
  }
  /**
   * Register a handler to be called before a record is changed. The handler is given the old and
   * new record - you can return a modified record to apply a different update, or the old record
   * to block the update entirely.
   *
   * Use this handler only for intercepting updates to the record itself. If you want to update
   * other records in response to a change, use
   * {@link StoreSideEffects.registerAfterChangeHandler} instead.
   *
   * @example
   * ```ts
   * editor.sideEffects.registerBeforeChangeHandler('shape', (prev, next, source) => {
   *     if (next.isLocked && !prev.isLocked) {
   *         // prevent shapes from ever being locked:
   *         return prev
   *     }
   *     // other types of change are allowed
   *     return next
   * })
   * ```
   *
   * @param typeName - The type of record to listen for
   * @param handler - The handler to call
   *
   * @returns A callback that removes the handler.
   */
  registerBeforeChangeHandler(typeName, handler) {
    const handlers = this._beforeChangeHandlers[typeName];
    if (!handlers) this._beforeChangeHandlers[typeName] = [];
    this._beforeChangeHandlers[typeName].push(handler);
    return () => remove(this._beforeChangeHandlers[typeName], handler);
  }
  /**
   * Register a handler to be called after a record is changed. This is useful for side-effects
   * that would update _other_ records - if you want to modify the record being changed, use
   * {@link StoreSideEffects.registerBeforeChangeHandler} instead.
   *
   * @example
   * ```ts
   * editor.sideEffects.registerAfterChangeHandler('shape', (prev, next, source) => {
   *     if (next.props.color === 'red') {
   *         // there can only be one red shape at a time:
   *         const otherRedShapes = editor.getCurrentPageShapes().filter(s => s.props.color === 'red' && s.id !== next.id)
   *         editor.updateShapes(otherRedShapes.map(s => ({...s, props: {...s.props, color: 'blue'}})))
   *     }
   * })
   * ```
   *
   * @param typeName - The type of record to listen for
   * @param handler - The handler to call
   *
   * @returns A callback that removes the handler.
   */
  registerAfterChangeHandler(typeName, handler) {
    const handlers = this._afterChangeHandlers[typeName];
    if (!handlers) this._afterChangeHandlers[typeName] = [];
    this._afterChangeHandlers[typeName].push(handler);
    return () => remove(this._afterChangeHandlers[typeName], handler);
  }
  /**
   * Register a handler to be called before a record is deleted. The handler can return `false` to
   * prevent the deletion.
   *
   * Use this handler only for intercepting deletions of the record itself. If you want to do
   * something to other records in response to a deletion, use
   * {@link StoreSideEffects.registerAfterDeleteHandler} instead.
   *
   * @example
   * ```ts
   * editor.sideEffects.registerBeforeDeleteHandler('shape', (shape, source) => {
   *     if (shape.props.color === 'red') {
   *         // prevent red shapes from being deleted
   * 	       return false
   *     }
   * })
   * ```
   *
   * @param typeName - The type of record to listen for
   * @param handler - The handler to call
   *
   * @returns A callback that removes the handler.
   */
  registerBeforeDeleteHandler(typeName, handler) {
    const handlers = this._beforeDeleteHandlers[typeName];
    if (!handlers) this._beforeDeleteHandlers[typeName] = [];
    this._beforeDeleteHandlers[typeName].push(handler);
    return () => remove(this._beforeDeleteHandlers[typeName], handler);
  }
  /**
   * Register a handler to be called after a record is deleted. This is useful for side-effects
   * that would update _other_ records - if you want to block the deletion of the record itself,
   * use {@link StoreSideEffects.registerBeforeDeleteHandler} instead.
   *
   * @example
   * ```ts
   * editor.sideEffects.registerAfterDeleteHandler('shape', (shape, source) => {
   *     // if the last shape in a frame is deleted, delete the frame too:
   *     const parentFrame = editor.getShape(shape.parentId)
   *     if (!parentFrame || parentFrame.type !== 'frame') return
   *
   *     const siblings = editor.getSortedChildIdsForParent(parentFrame)
   *     if (siblings.length === 0) {
   *         editor.deleteShape(parentFrame.id)
   *     }
   * })
   * ```
   *
   * @param typeName - The type of record to listen for
   * @param handler - The handler to call
   *
   * @returns A callback that removes the handler.
   */
  registerAfterDeleteHandler(typeName, handler) {
    const handlers = this._afterDeleteHandlers[typeName];
    if (!handlers) this._afterDeleteHandlers[typeName] = [];
    this._afterDeleteHandlers[typeName].push(handler);
    return () => remove(this._afterDeleteHandlers[typeName], handler);
  }
  /**
   * Register a handler to be called when a store completes an atomic operation.
   *
   * @example
   * ```ts
   * let count = 0
   *
   * editor.sideEffects.registerOperationCompleteHandler(() => count++)
   *
   * editor.selectAll()
   * expect(count).toBe(1)
   *
   * editor.store.atomic(() => {
   *	editor.selectNone()
   * 	editor.selectAll()
   * })
   *
   * expect(count).toBe(2)
   * ```
   *
   * @param handler - The handler to call
   *
   * @returns A callback that removes the handler.
   *
   * @public
   */
  registerOperationCompleteHandler(handler) {
    this._operationCompleteHandlers.push(handler);
    return () => remove(this._operationCompleteHandlers, handler);
  }
};
function remove(array2, item) {
  const index = array2.indexOf(item);
  if (index >= 0) {
    array2.splice(index, 1);
  }
}

// ../../node_modules/@tldraw/store/dist-esm/lib/Store.mjs
var Store = class {
  /**
   * The unique identifier of the store instance.
   *
   * @public
   */
  id;
  /**
   * An AtomMap containing the stores records.
   *
   * @internal
   * @readonly
   */
  records;
  /**
   * An atom containing the store's history.
   *
   * @public
   * @readonly
   */
  history = atom("history", 0, {
    historyLength: 1e3
  });
  /**
   * Reactive queries and indexes for efficiently accessing store data.
   * Provides methods for filtering, indexing, and subscribing to subsets of records.
   *
   * @example
   * ```ts
   * // Create an index by a property
   * const booksByAuthor = store.query.index('book', 'author')
   *
   * // Get records matching criteria
   * const inStockBooks = store.query.records('book', () => ({
   *   inStock: { eq: true }
   * }))
   * ```
   *
   * @public
   * @readonly
   */
  query;
  /**
   * A set containing listeners that have been added to this store.
   *
   * @internal
   */
  listeners = /* @__PURE__ */ new Set();
  /**
   * An array of history entries that have not yet been flushed.
   *
   * @internal
   */
  historyAccumulator = new HistoryAccumulator();
  /**
   * A reactor that responds to changes to the history by squashing the accumulated history and
   * notifying listeners of the changes.
   *
   * @internal
   */
  historyReactor;
  /**
   * Function to dispose of any in-flight timeouts.
   *
   * @internal
   */
  cancelHistoryReactor() {
  }
  /**
   * The schema that defines the structure and validation rules for records in this store.
   *
   * @public
   */
  schema;
  /**
   * Custom properties associated with this store instance.
   *
   * @public
   */
  props;
  /**
   * A mapping of record scopes to the set of record type names that belong to each scope.
   * Used to filter records by their persistence and synchronization behavior.
   *
   * @public
   */
  scopedTypes;
  /**
   * Side effects manager that handles lifecycle events for record operations.
   * Allows registration of callbacks for create, update, delete, and validation events.
   *
   * @example
   * ```ts
   * store.sideEffects.registerAfterCreateHandler('book', (book) => {
   *   console.log('Book created:', book.title)
   * })
   * ```
   *
   * @public
   */
  sideEffects = new StoreSideEffects(this);
  /**
   * Creates a new Store instance.
   *
   * @example
   * ```ts
   * const store = new Store({
   *   schema: StoreSchema.create({ book: Book }),
   *   props: { appName: 'MyLibrary' },
   *   initialData: savedData
   * })
   * ```
   *
   * @param config - Configuration object for the store
   */
  constructor(config) {
    const { initialData, schema, id } = config;
    this.id = id ?? uniqueId();
    this.schema = schema;
    this.props = config.props;
    if (initialData) {
      this.records = new AtomMap(
        "store",
        objectMapEntries(initialData).map(([id2, record]) => [
          id2,
          devFreeze(this.schema.validateRecord(this, record, "initialize", null))
        ])
      );
    } else {
      this.records = new AtomMap("store");
    }
    this.query = new StoreQueries(this.records, this.history);
    this.historyReactor = reactor(
      "Store.historyReactor",
      () => {
        this.history.get();
        this._flushHistory();
      },
      { scheduleEffect: (cb) => this.cancelHistoryReactor = throttleToNextFrame(cb) }
    );
    this.scopedTypes = {
      document: new Set(
        objectMapValues(this.schema.types).filter((t) => t.scope === "document").map((t) => t.typeName)
      ),
      session: new Set(
        objectMapValues(this.schema.types).filter((t) => t.scope === "session").map((t) => t.typeName)
      ),
      presence: new Set(
        objectMapValues(this.schema.types).filter((t) => t.scope === "presence").map((t) => t.typeName)
      )
    };
  }
  _flushHistory() {
    if (this.historyAccumulator.hasChanges()) {
      const entries = this.historyAccumulator.flush();
      for (const { changes, source } of entries) {
        let instanceChanges = null;
        let documentChanges = null;
        let presenceChanges = null;
        for (const { onHistory, filters } of this.listeners) {
          if (filters.source !== "all" && filters.source !== source) {
            continue;
          }
          if (filters.scope !== "all") {
            if (filters.scope === "document") {
              documentChanges ??= this.filterChangesByScope(changes, "document");
              if (!documentChanges) continue;
              onHistory({ changes: documentChanges, source });
            } else if (filters.scope === "session") {
              instanceChanges ??= this.filterChangesByScope(changes, "session");
              if (!instanceChanges) continue;
              onHistory({ changes: instanceChanges, source });
            } else {
              presenceChanges ??= this.filterChangesByScope(changes, "presence");
              if (!presenceChanges) continue;
              onHistory({ changes: presenceChanges, source });
            }
          } else {
            onHistory({ changes, source });
          }
        }
      }
    }
  }
  dispose() {
    this.cancelHistoryReactor();
  }
  /**
   * Filters out non-document changes from a diff. Returns null if there are no changes left.
   * @param change - the records diff
   * @param scope - the records scope
   * @returns
   */
  filterChangesByScope(change, scope) {
    const result = {
      added: filterEntries(change.added, (_, r) => this.scopedTypes[scope].has(r.typeName)),
      updated: filterEntries(change.updated, (_, r) => this.scopedTypes[scope].has(r[1].typeName)),
      removed: filterEntries(change.removed, (_, r) => this.scopedTypes[scope].has(r.typeName))
    };
    if (!hasAnyKey(result.added) && !hasAnyKey(result.updated) && !hasAnyKey(result.removed)) {
      return null;
    }
    return result;
  }
  /**
   * Update the history with a diff of changes.
   *
   * @param changes - The changes to add to the history.
   */
  updateHistory(changes) {
    this.historyAccumulator.add({
      changes,
      source: this.isMergingRemoteChanges ? "remote" : "user"
    });
    if (this.listeners.size === 0) {
      this.historyAccumulator.clear();
    }
    this.history.set(this.history.get() + 1, changes);
  }
  validate(phase) {
    this.allRecords().forEach((record) => this.schema.validateRecord(this, record, phase, null));
  }
  /**
   * Add or update records in the store. If a record with the same ID already exists, it will be updated.
   * Otherwise, a new record will be created.
   *
   * @example
   * ```ts
   * // Add new records
   * const book = Book.create({ title: 'Lathe Of Heaven', author: 'Le Guin' })
   * store.put([book])
   *
   * // Update existing record
   * store.put([{ ...book, title: 'The Lathe of Heaven' }])
   * ```
   *
   * @param records - The records to add or update
   * @param phaseOverride - Override the validation phase (used internally)
   * @public
   */
  put(records, phaseOverride) {
    this.atomic(() => {
      const updates = {};
      const additions = {};
      let record;
      let didChange = false;
      const source = this.isMergingRemoteChanges ? "remote" : "user";
      for (let i = 0, n = records.length; i < n; i++) {
        record = records[i];
        const initialValue = this.records.__unsafe__getWithoutCapture(record.id);
        if (initialValue) {
          record = this.sideEffects.handleBeforeChange(initialValue, record, source);
          const validated = this.schema.validateRecord(
            this,
            record,
            phaseOverride ?? "updateRecord",
            initialValue
          );
          if (validated === initialValue) continue;
          record = devFreeze(validated);
          this.records.set(record.id, record);
          didChange = true;
          updates[record.id] = [initialValue, record];
          this.addDiffForAfterEvent(initialValue, record);
        } else {
          record = this.sideEffects.handleBeforeCreate(record, source);
          didChange = true;
          record = this.schema.validateRecord(
            this,
            record,
            phaseOverride ?? "createRecord",
            null
          );
          record = devFreeze(record);
          additions[record.id] = record;
          this.addDiffForAfterEvent(null, record);
          this.records.set(record.id, record);
        }
      }
      if (!didChange) return;
      this.updateHistory({
        added: additions,
        updated: updates,
        removed: {}
      });
    });
  }
  /**
   * Remove records from the store by their IDs.
   *
   * @example
   * ```ts
   * // Remove a single record
   * store.remove([book.id])
   *
   * // Remove multiple records
   * store.remove([book1.id, book2.id, book3.id])
   * ```
   *
   * @param ids - The IDs of the records to remove
   * @public
   */
  remove(ids) {
    this.atomic(() => {
      const toDelete = new Set(ids);
      const source = this.isMergingRemoteChanges ? "remote" : "user";
      if (this.sideEffects.isEnabled()) {
        for (const id of ids) {
          const record = this.records.__unsafe__getWithoutCapture(id);
          if (!record) continue;
          if (this.sideEffects.handleBeforeDelete(record, source) === false) {
            toDelete.delete(id);
          }
        }
      }
      const actuallyDeleted = this.records.deleteMany(toDelete);
      if (actuallyDeleted.length === 0) return;
      const removed = {};
      for (const [id, record] of actuallyDeleted) {
        removed[id] = record;
        this.addDiffForAfterEvent(record, null);
      }
      this.updateHistory({ added: {}, updated: {}, removed });
    });
  }
  /**
   * Get a record by its ID. This creates a reactive subscription to the record.
   *
   * @example
   * ```ts
   * const book = store.get(bookId)
   * if (book) {
   *   console.log(book.title)
   * }
   * ```
   *
   * @param id - The ID of the record to get
   * @returns The record if it exists, undefined otherwise
   * @public
   */
  get(id) {
    return this.records.get(id);
  }
  /**
   * Get a record by its ID without creating a reactive subscription.
   * Use this when you need to access a record but don't want reactive updates.
   *
   * @example
   * ```ts
   * // Won't trigger reactive updates when this record changes
   * const book = store.unsafeGetWithoutCapture(bookId)
   * ```
   *
   * @param id - The ID of the record to get
   * @returns The record if it exists, undefined otherwise
   * @public
   */
  unsafeGetWithoutCapture(id) {
    return this.records.__unsafe__getWithoutCapture(id);
  }
  /**
   * Serialize the store's records to a plain JavaScript object.
   * Only includes records matching the specified scope.
   *
   * @example
   * ```ts
   * // Serialize only document records (default)
   * const documentData = store.serialize('document')
   *
   * // Serialize all records
   * const allData = store.serialize('all')
   * ```
   *
   * @param scope - The scope of records to serialize. Defaults to 'document'
   * @returns The serialized store data
   * @public
   */
  serialize(scope = "document") {
    const result = {};
    for (const [id, record] of this.records) {
      if (scope === "all" || this.scopedTypes[scope].has(record.typeName)) {
        result[id] = record;
      }
    }
    return result;
  }
  /**
   * Get a serialized snapshot of the store and its schema.
   * This includes both the data and schema information needed for proper migration.
   *
   * @example
   * ```ts
   * const snapshot = store.getStoreSnapshot()
   * localStorage.setItem('myApp', JSON.stringify(snapshot))
   *
   * // Later...
   * const saved = JSON.parse(localStorage.getItem('myApp'))
   * store.loadStoreSnapshot(saved)
   * ```
   *
   * @param scope - The scope of records to serialize. Defaults to 'document'
   * @returns A snapshot containing both store data and schema information
   * @public
   */
  getStoreSnapshot(scope = "document") {
    return {
      store: this.serialize(scope),
      schema: this.schema.serialize()
    };
  }
  /**
   * Migrate a serialized snapshot to the current schema version.
   * This applies any necessary migrations to bring old data up to date.
   *
   * @example
   * ```ts
   * const oldSnapshot = JSON.parse(localStorage.getItem('myApp'))
   * const migratedSnapshot = store.migrateSnapshot(oldSnapshot)
   * ```
   *
   * @param snapshot - The snapshot to migrate
   * @returns The migrated snapshot with current schema version
   * @throws Error if migration fails
   * @public
   */
  migrateSnapshot(snapshot) {
    const migrationResult = this.schema.migrateStoreSnapshot(snapshot);
    if (migrationResult.type === "error") {
      throw new Error(`Failed to migrate snapshot: ${migrationResult.reason}`);
    }
    return {
      store: migrationResult.value,
      schema: this.schema.serialize()
    };
  }
  /**
   * Load a serialized snapshot into the store, replacing all current data.
   * The snapshot will be automatically migrated to the current schema version if needed.
   *
   * @example
   * ```ts
   * const snapshot = JSON.parse(localStorage.getItem('myApp'))
   * store.loadStoreSnapshot(snapshot)
   * ```
   *
   * @param snapshot - The snapshot to load
   * @throws Error if migration fails or snapshot is invalid
   * @public
   */
  loadStoreSnapshot(snapshot) {
    const migrationResult = this.schema.migrateStoreSnapshot(snapshot);
    if (migrationResult.type === "error") {
      throw new Error(`Failed to migrate snapshot: ${migrationResult.reason}`);
    }
    const prevSideEffectsEnabled = this.sideEffects.isEnabled();
    try {
      this.sideEffects.setIsEnabled(false);
      this.atomic(() => {
        this.clear();
        this.put(Object.values(migrationResult.value));
        this.ensureStoreIsUsable();
      }, false);
    } finally {
      this.sideEffects.setIsEnabled(prevSideEffectsEnabled);
    }
  }
  /**
   * Get an array of all records in the store.
   *
   * @example
   * ```ts
   * const allRecords = store.allRecords()
   * const books = allRecords.filter(r => r.typeName === 'book')
   * ```
   *
   * @returns An array containing all records in the store
   * @public
   */
  allRecords() {
    return Array.from(this.records.values());
  }
  /**
   * Remove all records from the store.
   *
   * @example
   * ```ts
   * store.clear()
   * console.log(store.allRecords().length) // 0
   * ```
   *
   * @public
   */
  clear() {
    this.remove(Array.from(this.records.keys()));
  }
  /**
   * Update a single record using an updater function. To update multiple records at once,
   * use the `update` method of the `TypedStore` class.
   *
   * @example
   * ```ts
   * store.update(book.id, (book) => ({
   *   ...book,
   *   title: 'Updated Title'
   * }))
   * ```
   *
   * @param id - The ID of the record to update
   * @param updater - A function that receives the current record and returns the updated record
   * @public
   */
  update(id, updater) {
    const existing = this.unsafeGetWithoutCapture(id);
    if (!existing) {
      console.error(`Record ${id} not found. This is probably an error`);
      return;
    }
    this.put([updater(existing)]);
  }
  /**
   * Check whether a record with the given ID exists in the store.
   *
   * @example
   * ```ts
   * if (store.has(bookId)) {
   *   console.log('Book exists!')
   * }
   * ```
   *
   * @param id - The ID of the record to check
   * @returns True if the record exists, false otherwise
   * @public
   */
  has(id) {
    return this.records.has(id);
  }
  /**
   * Add a listener that will be called when the store changes.
   * Returns a function to remove the listener.
   *
   * @example
   * ```ts
   * const removeListener = store.listen((entry) => {
   *   console.log('Changes:', entry.changes)
   *   console.log('Source:', entry.source)
   * })
   *
   * // Listen only to user changes to document records
   * const removeDocumentListener = store.listen(
   *   (entry) => console.log('Document changed:', entry),
   *   { source: 'user', scope: 'document' }
   * )
   *
   * // Later, remove the listener
   * removeListener()
   * ```
   *
   * @param onHistory - The listener function to call when changes occur
   * @param filters - Optional filters to control when the listener is called
   * @returns A function that removes the listener when called
   * @public
   */
  listen(onHistory, filters) {
    this._flushHistory();
    const listener = {
      onHistory,
      filters: {
        source: filters?.source ?? "all",
        scope: filters?.scope ?? "all"
      }
    };
    if (!this.historyReactor.scheduler.isActivelyListening) {
      this.historyReactor.start();
      this.historyReactor.scheduler.execute();
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.historyReactor.stop();
      }
    };
  }
  isMergingRemoteChanges = false;
  /**
   * Merge changes from a remote source. Changes made within the provided function
   * will be marked with source 'remote' instead of 'user'.
   *
   * @example
   * ```ts
   * // Changes from sync/collaboration
   * store.mergeRemoteChanges(() => {
   *   store.put(remoteRecords)
   *   store.remove(deletedIds)
   * })
   * ```
   *
   * @param fn - A function that applies the remote changes
   * @public
   */
  mergeRemoteChanges(fn) {
    if (this.isMergingRemoteChanges) {
      return fn();
    }
    if (this._isInAtomicOp) {
      throw new Error("Cannot merge remote changes while in atomic operation");
    }
    try {
      this.atomic(fn, true, true);
    } finally {
      this.ensureStoreIsUsable();
    }
  }
  /**
   * Run `fn` and return a {@link RecordsDiff} of the changes that occurred as a result.
   */
  extractingChanges(fn) {
    const changes = [];
    const dispose = this.historyAccumulator.addInterceptor((entry2) => changes.push(entry2.changes));
    try {
      transact(fn);
      return squashRecordDiffs(changes);
    } finally {
      dispose();
    }
  }
  applyDiff(diff, {
    runCallbacks = true,
    ignoreEphemeralKeys = false
  } = {}) {
    this.atomic(() => {
      const toPut = objectMapValues(diff.added);
      for (const [_from, to] of objectMapValues(diff.updated)) {
        const type = this.schema.getType(to.typeName);
        if (ignoreEphemeralKeys && type.ephemeralKeySet.size) {
          const existing = this.get(to.id);
          if (!existing) {
            toPut.push(to);
            continue;
          }
          let changed = null;
          for (const [key, value] of Object.entries(to)) {
            if (type.ephemeralKeySet.has(key) || Object.is(value, getOwnProperty(existing, key))) {
              continue;
            }
            if (!changed) changed = { ...existing };
            changed[key] = value;
          }
          if (changed) toPut.push(changed);
        } else {
          toPut.push(to);
        }
      }
      const toRemove = objectMapKeys(diff.removed);
      if (toPut.length) {
        this.put(toPut);
      }
      if (toRemove.length) {
        this.remove(toRemove);
      }
    }, runCallbacks);
  }
  /**
   * Create a cache based on values in the store. Pass in a function that takes and ID and a
   * signal for the underlying record. Return a signal (usually a computed) for the cached value.
   * For simple derivations, use {@link Store.createComputedCache}. This function is useful if you
   * need more precise control over intermediate values.
   */
  createCache(create) {
    const cache = new WeakCache();
    return {
      get: (id) => {
        const atom2 = this.records.getAtom(id);
        if (!atom2) return void 0;
        return cache.get(atom2, () => create(id, atom2)).get();
      }
    };
  }
  /**
   * Create a computed cache.
   *
   * @param name - The name of the derivation cache.
   * @param derive - A function used to derive the value of the cache.
   * @param opts - Options for the computed cache.
   * @public
   */
  createComputedCache(name, derive, opts) {
    return this.createCache((id, record) => {
      const recordSignal = opts?.areRecordsEqual ? computed(`${name}:${id}:isEqual`, () => record.get(), { isEqual: opts.areRecordsEqual }) : record;
      return computed(
        name + ":" + id,
        () => {
          return derive(recordSignal.get());
        },
        {
          isEqual: opts?.areResultsEqual
        }
      );
    });
  }
  _integrityChecker;
  /** @internal */
  ensureStoreIsUsable() {
    this.atomic(() => {
      this._integrityChecker ??= this.schema.createIntegrityChecker(this);
      this._integrityChecker?.();
    });
  }
  _isPossiblyCorrupted = false;
  /** @internal */
  markAsPossiblyCorrupted() {
    this._isPossiblyCorrupted = true;
  }
  /** @internal */
  isPossiblyCorrupted() {
    return this._isPossiblyCorrupted;
  }
  pendingAfterEvents = null;
  addDiffForAfterEvent(before, after) {
    assert(this.pendingAfterEvents, "must be in event operation");
    if (before === after) return;
    if (before && after) assert(before.id === after.id);
    if (!before && !after) return;
    const id = (before || after).id;
    const existing = this.pendingAfterEvents.get(id);
    if (existing) {
      existing.after = after;
    } else {
      this.pendingAfterEvents.set(id, { before, after });
    }
  }
  flushAtomicCallbacks(isMergingRemoteChanges) {
    let updateDepth = 0;
    let source = isMergingRemoteChanges ? "remote" : "user";
    while (this.pendingAfterEvents) {
      const events = this.pendingAfterEvents;
      this.pendingAfterEvents = null;
      if (!this.sideEffects.isEnabled()) continue;
      updateDepth++;
      if (updateDepth > 100) {
        throw new Error("Maximum store update depth exceeded, bailing out");
      }
      for (const { before, after } of events.values()) {
        if (before && after && before !== after && !(0, import_lodash2.default)(before, after)) {
          this.sideEffects.handleAfterChange(before, after, source);
        } else if (before && !after) {
          this.sideEffects.handleAfterDelete(before, source);
        } else if (!before && after) {
          this.sideEffects.handleAfterCreate(after, source);
        }
      }
      if (!this.pendingAfterEvents) {
        this.sideEffects.handleOperationComplete(source);
      } else {
        source = "user";
      }
    }
  }
  _isInAtomicOp = false;
  /** @internal */
  atomic(fn, runCallbacks = true, isMergingRemoteChanges = false) {
    return transact(() => {
      if (this._isInAtomicOp) {
        if (!this.pendingAfterEvents) this.pendingAfterEvents = /* @__PURE__ */ new Map();
        const prevSideEffectsEnabled2 = this.sideEffects.isEnabled();
        assert(!isMergingRemoteChanges, "cannot call mergeRemoteChanges while in atomic operation");
        try {
          if (prevSideEffectsEnabled2 && !runCallbacks) {
            this.sideEffects.setIsEnabled(false);
          }
          return fn();
        } finally {
          this.sideEffects.setIsEnabled(prevSideEffectsEnabled2);
        }
      }
      this.pendingAfterEvents = /* @__PURE__ */ new Map();
      const prevSideEffectsEnabled = this.sideEffects.isEnabled();
      this.sideEffects.setIsEnabled(runCallbacks && prevSideEffectsEnabled);
      this._isInAtomicOp = true;
      if (isMergingRemoteChanges) {
        this.isMergingRemoteChanges = true;
      }
      try {
        const result = fn();
        this.isMergingRemoteChanges = false;
        this.flushAtomicCallbacks(isMergingRemoteChanges);
        return result;
      } finally {
        this.pendingAfterEvents = null;
        this.sideEffects.setIsEnabled(prevSideEffectsEnabled);
        this._isInAtomicOp = false;
        this.isMergingRemoteChanges = false;
      }
    });
  }
  /** @internal */
  addHistoryInterceptor(fn) {
    return this.historyAccumulator.addInterceptor(
      (entry2) => fn(entry2, this.isMergingRemoteChanges ? "remote" : "user")
    );
  }
};
function squashHistoryEntries(entries) {
  if (entries.length === 0) return [];
  const chunked = [];
  let chunk = [entries[0]];
  let entry2;
  for (let i = 1, n = entries.length; i < n; i++) {
    entry2 = entries[i];
    if (chunk[0].source !== entry2.source) {
      chunked.push(chunk);
      chunk = [];
    }
    chunk.push(entry2);
  }
  chunked.push(chunk);
  return devFreeze(
    chunked.map((chunk2) => ({
      source: chunk2[0].source,
      // a single-entry chunk needs no squashing — skip the O(N) copy of its diff
      changes: chunk2.length === 1 ? chunk2[0].changes : squashRecordDiffs(chunk2.map((e) => e.changes))
    }))
  );
}
var HistoryAccumulator = class {
  _history = [];
  _interceptors = /* @__PURE__ */ new Set();
  /**
   * Add an interceptor that will be called for each history entry.
   * Returns a function to remove the interceptor.
   */
  addInterceptor(fn) {
    this._interceptors.add(fn);
    return () => {
      this._interceptors.delete(fn);
    };
  }
  /**
   * Add a history entry to the accumulator.
   * Calls all registered interceptors with the entry.
   */
  add(entry2) {
    this._history.push(entry2);
    for (const interceptor of this._interceptors) {
      interceptor(entry2);
    }
  }
  /**
   * Flush all accumulated history entries, squashing adjacent entries from the same source.
   * Clears the internal history buffer.
   */
  flush() {
    const history = squashHistoryEntries(this._history);
    this._history = [];
    return history;
  }
  /**
   * Clear all accumulated history entries without flushing.
   */
  clear() {
    this._history = [];
  }
  /**
   * Check if there are any accumulated history entries.
   */
  hasChanges() {
    return this._history.length > 0;
  }
};
function createComputedCache(name, derive, opts) {
  const cache = new WeakCache();
  return {
    get(context, id) {
      const computedCache = cache.get(context, () => {
        const store = context instanceof Store ? context : context.store;
        return store.createComputedCache(name, (record) => derive(context, record), opts);
      });
      return computedCache.get(id);
    }
  };
}

// ../../node_modules/@tldraw/store/dist-esm/lib/StoreSchema.mjs
function upgradeSchema(schema) {
  if (schema.schemaVersion > 2 || schema.schemaVersion < 1) return Result.err("Bad schema version");
  if (schema.schemaVersion === 2) return Result.ok(schema);
  const result = {
    schemaVersion: 2,
    sequences: {
      "com.tldraw.store": schema.storeVersion
    }
  };
  for (const [typeName, recordVersion] of Object.entries(schema.recordVersions)) {
    result.sequences[`com.tldraw.${typeName}`] = recordVersion.version;
    if ("subTypeKey" in recordVersion) {
      for (const [subType, version] of Object.entries(recordVersion.subTypeVersions)) {
        result.sequences[`com.tldraw.${typeName}.${subType}`] = version;
      }
    }
  }
  return Result.ok(result);
}
var StoreSchema = class _StoreSchema {
  constructor(types, options) {
    this.types = types;
    this.options = options;
    for (const m of options.migrations ?? []) {
      assert(!this.migrations[m.sequenceId], `Duplicate migration sequenceId ${m.sequenceId}`);
      validateMigrations(m);
      this.migrations[m.sequenceId] = m;
    }
    const allMigrations = Object.values(this.migrations).flatMap((m) => m.sequence);
    this.sortedMigrations = sortMigrations(allMigrations);
    for (const migration of this.sortedMigrations) {
      if (!migration.dependsOn?.length) continue;
      for (const dep of migration.dependsOn) {
        const depMigration = allMigrations.find((m) => m.id === dep);
        assert(depMigration, `Migration '${migration.id}' depends on missing migration '${dep}'`);
      }
    }
  }
  types;
  options;
  /**
   * Creates a new StoreSchema with the given record types and options.
   *
   * This static factory method is the recommended way to create a StoreSchema.
   * It ensures type safety while providing a clean API for schema definition.
   *
   * @param types - Object mapping type names to their RecordType definitions
   * @param options - Optional configuration for migrations, validation, and integrity checking
   * @returns A new StoreSchema instance
   *
   * @example
   * ```ts
   * const Book = createRecordType<Book>('book', { scope: 'document' })
   * const Author = createRecordType<Author>('author', { scope: 'document' })
   *
   * const schema = StoreSchema.create(
   *   {
   *     book: Book,
   *     author: Author
   *   },
   *   {
   *     migrations: [bookMigrations],
   *     onValidationFailure: (failure) => failure.record
   *   }
   * )
   * ```
   *
   * @public
   */
  static create(types, options) {
    return new _StoreSchema(types, options ?? {});
  }
  migrations = {};
  sortedMigrations;
  migrationCache = /* @__PURE__ */ new WeakMap();
  /**
   * Validates a record using its corresponding RecordType validator.
   *
   * This method ensures that records conform to their type definitions before
   * being stored. If validation fails and an onValidationFailure handler is
   * provided, it will be called to potentially recover from the error.
   *
   * @param store - The store instance where validation is occurring
   * @param record - The record to validate
   * @param phase - The lifecycle phase where validation is happening
   * @param recordBefore - The previous version of the record (for updates)
   * @returns The validated record, potentially modified by validation failure handler
   *
   * @example
   * ```ts
   * try {
   *   const validatedBook = schema.validateRecord(
   *     store,
   *     { id: 'book:1', typeName: 'book', title: '', author: 'Jane Doe' },
   *     'createRecord',
   *     null
   *   )
   * } catch (error) {
   *   console.error('Record validation failed:', error)
   * }
   * ```
   *
   * @public
   */
  validateRecord(store, record, phase, recordBefore) {
    try {
      const recordType = getOwnProperty(this.types, record.typeName);
      if (!recordType) {
        throw new Error(`Missing definition for record type ${record.typeName}`);
      }
      return recordType.validate(record, recordBefore ?? void 0);
    } catch (error) {
      if (this.options.onValidationFailure) {
        return this.options.onValidationFailure({
          store,
          record,
          phase,
          recordBefore,
          error
        });
      } else {
        throw error;
      }
    }
  }
  /**
   * Gets all migrations that need to be applied to upgrade from a persisted schema
   * to the current schema version.
   *
   * This method compares the persisted schema with the current schema and determines
   * which migrations need to be applied to bring the data up to date. It handles
   * both regular migrations and retroactive migrations, and caches results for
   * performance.
   *
   * @param persistedSchema - The schema version that was previously persisted
   * @returns A Result containing the list of migrations to apply, or an error message
   *
   * @example
   * ```ts
   * const persistedSchema = {
   *   schemaVersion: 2,
   *   sequences: { 'com.tldraw.book': 1, 'com.tldraw.author': 0 }
   * }
   *
   * const migrationsResult = schema.getMigrationsSince(persistedSchema)
   * if (migrationsResult.ok) {
   *   console.log('Migrations to apply:', migrationsResult.value.length)
   *   // Apply each migration to bring data up to date
   * }
   * ```
   *
   * @public
   */
  getMigrationsSince(persistedSchema) {
    const cached = this.migrationCache.get(persistedSchema);
    if (cached) {
      return cached;
    }
    const upgradeResult = upgradeSchema(persistedSchema);
    if (!upgradeResult.ok) {
      this.migrationCache.set(persistedSchema, upgradeResult);
      return upgradeResult;
    }
    const schema = upgradeResult.value;
    const sequenceIdsToInclude = new Set(
      // start with any shared sequences
      Object.keys(schema.sequences).filter((sequenceId) => this.migrations[sequenceId])
    );
    for (const sequenceId in this.migrations) {
      if (schema.sequences[sequenceId] === void 0 && this.migrations[sequenceId].retroactive) {
        sequenceIdsToInclude.add(sequenceId);
      }
    }
    if (sequenceIdsToInclude.size === 0) {
      const result2 = Result.ok([]);
      this.migrationCache.set(persistedSchema, result2);
      return result2;
    }
    const allMigrationsToInclude = /* @__PURE__ */ new Set();
    for (const sequenceId of sequenceIdsToInclude) {
      const theirVersion = schema.sequences[sequenceId];
      if (typeof theirVersion !== "number" && this.migrations[sequenceId].retroactive || theirVersion === 0) {
        for (const migration of this.migrations[sequenceId].sequence) {
          allMigrationsToInclude.add(migration.id);
        }
        continue;
      }
      const theirVersionId = `${sequenceId}/${theirVersion}`;
      const idx = this.migrations[sequenceId].sequence.findIndex((m) => m.id === theirVersionId);
      if (idx === -1) {
        const result2 = Result.err("Incompatible schema?");
        this.migrationCache.set(persistedSchema, result2);
        return result2;
      }
      for (const migration of this.migrations[sequenceId].sequence.slice(idx + 1)) {
        allMigrationsToInclude.add(migration.id);
      }
    }
    const result = Result.ok(
      this.sortedMigrations.filter(({ id }) => allMigrationsToInclude.has(id))
    );
    this.migrationCache.set(persistedSchema, result);
    return result;
  }
  /**
   * Migrates a single persisted record to match the current schema version.
   *
   * This method applies the necessary migrations to transform a record from an
   * older (or newer) schema version to the current version. It supports both
   * forward ('up') and backward ('down') migrations.
   *
   * @param record - The record to migrate
   * @param persistedSchema - The schema version the record was persisted with
   * @param direction - Direction to migrate ('up' for newer, 'down' for older)
   * @returns A MigrationResult containing the migrated record or an error
   *
   * @example
   * ```ts
   * const oldRecord = { id: 'book:1', typeName: 'book', title: 'Old Title', publishDate: '2020-01-01' }
   * const oldSchema = { schemaVersion: 2, sequences: { 'com.tldraw.book': 1 } }
   *
   * const result = schema.migratePersistedRecord(oldRecord, oldSchema, 'up')
   * if (result.type === 'success') {
   *   console.log('Migrated record:', result.value)
   *   // Record now has publishedYear instead of publishDate
   * } else {
   *   console.error('Migration failed:', result.reason)
   * }
   * ```
   *
   * @public
   */
  migratePersistedRecord(record, persistedSchema, direction = "up") {
    const migrations = this.getMigrationsSince(persistedSchema);
    if (!migrations.ok) {
      console.error("Error migrating record", migrations.error);
      return { type: "error", reason: MigrationFailureReason.MigrationError };
    }
    let migrationsToApply = migrations.value;
    if (migrationsToApply.length === 0) {
      return { type: "success", value: record };
    }
    if (!migrationsToApply.every((m) => m.scope === "record")) {
      return {
        type: "error",
        reason: direction === "down" ? MigrationFailureReason.TargetVersionTooOld : MigrationFailureReason.TargetVersionTooNew
      };
    }
    if (direction === "down") {
      if (!migrationsToApply.every((m) => m.scope === "record" && m.down)) {
        return {
          type: "error",
          reason: MigrationFailureReason.TargetVersionTooOld
        };
      }
      migrationsToApply = migrationsToApply.slice().reverse();
    }
    record = structuredClone(record);
    try {
      for (const migration of migrationsToApply) {
        if (migration.scope === "store") throw new Error(
          /* won't happen, just for TS */
        );
        if (migration.scope === "storage") throw new Error(
          /* won't happen, just for TS */
        );
        const shouldApply = migration.filter ? migration.filter(record) : true;
        if (!shouldApply) continue;
        const result = migration[direction](record);
        if (result) {
          record = structuredClone(result);
        }
      }
    } catch (e) {
      console.error("Error migrating record", e);
      return { type: "error", reason: MigrationFailureReason.MigrationError };
    }
    return { type: "success", value: record };
  }
  migrateStorage(storage) {
    const schema = storage.getSchema();
    assert(schema, "Schema is missing.");
    const migrations = this.getMigrationsSince(schema);
    if (!migrations.ok) {
      console.error("Error migrating store", migrations.error);
      throw new Error(migrations.error);
    }
    const migrationsToApply = migrations.value;
    if (migrationsToApply.length === 0) {
      return;
    }
    storage.setSchema(this.serialize());
    for (const migration of migrationsToApply) {
      if (migration.scope === "record") {
        const updates = [];
        for (const [id, state] of storage.entries()) {
          const shouldApply = migration.filter ? migration.filter(state) : true;
          if (!shouldApply) continue;
          const record = structuredClone(state);
          const result = migration.up(record) ?? record;
          if (!(0, import_lodash2.default)(result, state)) {
            updates.push([id, result]);
          }
        }
        for (const [id, record] of updates) {
          storage.set(id, record);
        }
      } else if (migration.scope === "store") {
        const prevStore = Object.fromEntries(storage.entries());
        let nextStore = structuredClone(prevStore);
        nextStore = migration.up(nextStore) ?? nextStore;
        for (const [id, state] of Object.entries(nextStore)) {
          if (!state) continue;
          if (!(0, import_lodash2.default)(state, prevStore[id])) {
            storage.set(id, state);
          }
        }
        for (const id of Object.keys(prevStore)) {
          if (!nextStore[id]) {
            storage.delete(id);
          }
        }
      } else if (migration.scope === "storage") {
        migration.up(storage);
      } else {
        exhaustiveSwitchError(migration);
      }
    }
    for (const [id, state] of storage.entries()) {
      if (this.getType(state.typeName).scope !== "document") {
        storage.delete(id);
      }
    }
  }
  /**
   * Migrates an entire store snapshot to match the current schema version.
   *
   * This method applies all necessary migrations to bring a persisted store
   * snapshot up to the current schema version. It handles both record-level
   * and store-level migrations, and can optionally mutate the input store
   * for performance.
   *
   * @param snapshot - The store snapshot containing data and schema information
   * @param opts - Options controlling migration behavior
   *   - mutateInputStore - Whether to modify the input store directly (default: false)
   * @returns A MigrationResult containing the migrated store or an error
   *
   * @example
   * ```ts
   * const snapshot = {
   *   schema: { schemaVersion: 2, sequences: { 'com.tldraw.book': 1 } },
   *   store: {
   *     'book:1': { id: 'book:1', typeName: 'book', title: 'Old Book', publishDate: '2020-01-01' }
   *   }
   * }
   *
   * const result = schema.migrateStoreSnapshot(snapshot)
   * if (result.type === 'success') {
   *   console.log('Migrated store:', result.value)
   *   // All records are now at current schema version
   * }
   * ```
   *
   * @public
   */
  migrateStoreSnapshot(snapshot, opts) {
    const migrations = this.getMigrationsSince(snapshot.schema);
    if (!migrations.ok) {
      console.error("Error migrating store", migrations.error);
      return { type: "error", reason: MigrationFailureReason.MigrationError };
    }
    const migrationsToApply = migrations.value;
    if (migrationsToApply.length === 0) {
      return { type: "success", value: snapshot.store };
    }
    const store = Object.assign(
      new Map(objectMapEntries(snapshot.store).map(devFreeze)),
      {
        getSchema: () => snapshot.schema,
        setSchema: (_) => {
        }
      }
    );
    try {
      this.migrateStorage(store);
      if (opts?.mutateInputStore) {
        for (const [id, record] of store.entries()) {
          snapshot.store[id] = record;
        }
        for (const id of Object.keys(snapshot.store)) {
          if (!store.has(id)) {
            delete snapshot.store[id];
          }
        }
        return { type: "success", value: snapshot.store };
      } else {
        return {
          type: "success",
          value: Object.fromEntries(store.entries())
        };
      }
    } catch (e) {
      console.error("Error migrating store", e);
      return { type: "error", reason: MigrationFailureReason.MigrationError };
    }
  }
  /**
   * Creates an integrity checker function for the given store.
   *
   * This method calls the createIntegrityChecker option if provided, allowing
   * custom integrity checking logic to be set up for the store. The integrity
   * checker is used to validate store consistency and catch data corruption.
   *
   * @param store - The store instance to create an integrity checker for
   * @returns An integrity checker function, or undefined if none is configured
   *
   * @internal
   */
  createIntegrityChecker(store) {
    return this.options.createIntegrityChecker?.(store) ?? void 0;
  }
  /**
   * Serializes the current schema to a SerializedSchemaV2 format.
   *
   * This method creates a serialized representation of the current schema,
   * capturing the latest version number for each migration sequence.
   * The result can be persisted and later used to determine what migrations
   * need to be applied when loading data.
   *
   * @returns A SerializedSchemaV2 object representing the current schema state
   *
   * @example
   * ```ts
   * const serialized = schema.serialize()
   * console.log(serialized)
   * // {
   * //   schemaVersion: 2,
   * //   sequences: {
   * //     'com.tldraw.book': 3,
   * //     'com.tldraw.author': 2
   * //   }
   * // }
   *
   * // Store this with your data for future migrations
   * localStorage.setItem('schema', JSON.stringify(serialized))
   * ```
   *
   * @public
   */
  serialize() {
    return {
      schemaVersion: 2,
      sequences: Object.fromEntries(
        Object.values(this.migrations).map(({ sequenceId, sequence }) => [
          sequenceId,
          sequence.length ? parseMigrationId(sequence.at(-1).id).version : 0
        ])
      )
    };
  }
  /**
   * Serializes a schema representing the earliest possible version.
   *
   * This method creates a serialized schema where all migration sequences
   * are set to version 0, representing the state before any migrations
   * have been applied. This is used in specific legacy scenarios.
   *
   * @returns A SerializedSchema with all sequences set to version 0
   *
   * @deprecated This is only here for legacy reasons, don't use it unless you have david's blessing!
   * @internal
   */
  serializeEarliestVersion() {
    return {
      schemaVersion: 2,
      sequences: Object.fromEntries(
        Object.values(this.migrations).map(({ sequenceId }) => [sequenceId, 0])
      )
    };
  }
  /**
   * Gets the RecordType definition for a given type name.
   *
   * This method retrieves the RecordType associated with the specified
   * type name, which contains the record's validation, creation, and
   * other behavioral logic.
   *
   * @param typeName - The name of the record type to retrieve
   * @returns The RecordType definition for the specified type
   *
   * @throws Will throw an error if the record type does not exist
   *
   * @internal
   */
  getType(typeName) {
    const type = getOwnProperty(this.types, typeName);
    assert(type, "record type does not exist");
    return type;
  }
};

// ../../node_modules/@tldraw/store/dist-esm/index.mjs
registerTldrawLibraryVersion(
  "@tldraw/store",
  "5.3.2",
  "esm"
);

// ../../node_modules/@tldraw/tlschema/dist-esm/assets/TLBookmarkAsset.mjs
var bookmarkAssetProps = {
  title: validation_exports.string,
  description: validation_exports.string,
  image: validation_exports.string,
  favicon: validation_exports.string,
  src: validation_exports.srcUrl.nullable()
};
var bookmarkAssetValidator = createAssetValidator(
  "bookmark",
  validation_exports.object(bookmarkAssetProps)
);
var Versions = createMigrationIds("com.tldraw.asset.bookmark", {
  MakeUrlsValid: 1,
  AddFavicon: 2
});
var bookmarkAssetMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.asset.bookmark",
  recordType: "asset",
  filter: (asset) => asset.type === "bookmark",
  sequence: [
    {
      id: Versions.MakeUrlsValid,
      up: (asset) => {
        if (!validation_exports.srcUrl.isValid(asset.props.src)) {
          asset.props.src = "";
        }
      },
      down: (_asset) => {
      }
    },
    {
      id: Versions.AddFavicon,
      up: (asset) => {
        if (!validation_exports.srcUrl.isValid(asset.props.favicon)) {
          asset.props.favicon = "";
        }
      },
      down: (asset) => {
        delete asset.props.favicon;
      }
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/assets/TLImageAsset.mjs
var imageAssetProps = {
  w: validation_exports.number,
  h: validation_exports.number,
  name: validation_exports.string,
  isAnimated: validation_exports.boolean,
  mimeType: validation_exports.string.nullable(),
  src: validation_exports.srcUrl.nullable(),
  fileSize: validation_exports.nonZeroNumber.optional(),
  pixelRatio: validation_exports.positiveNumber.optional()
};
var imageAssetValidator = createAssetValidator(
  "image",
  validation_exports.object(imageAssetProps)
);
var Versions2 = createMigrationIds("com.tldraw.asset.image", {
  AddIsAnimated: 1,
  RenameWidthHeight: 2,
  MakeUrlsValid: 3,
  AddFileSize: 4,
  MakeFileSizeOptional: 5,
  AddPixelRatio: 6
});
var imageAssetMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.asset.image",
  recordType: "asset",
  filter: (asset) => asset.type === "image",
  sequence: [
    {
      id: Versions2.AddIsAnimated,
      up: (asset) => {
        asset.props.isAnimated = false;
      },
      down: (asset) => {
        delete asset.props.isAnimated;
      }
    },
    {
      id: Versions2.RenameWidthHeight,
      up: (asset) => {
        asset.props.w = asset.props.width;
        asset.props.h = asset.props.height;
        delete asset.props.width;
        delete asset.props.height;
      },
      down: (asset) => {
        asset.props.width = asset.props.w;
        asset.props.height = asset.props.h;
        delete asset.props.w;
        delete asset.props.h;
      }
    },
    {
      id: Versions2.MakeUrlsValid,
      up: (asset) => {
        if (!validation_exports.srcUrl.isValid(asset.props.src)) {
          asset.props.src = "";
        }
      },
      down: (_asset) => {
      }
    },
    {
      id: Versions2.AddFileSize,
      up: (asset) => {
        asset.props.fileSize = -1;
      },
      down: (asset) => {
        delete asset.props.fileSize;
      }
    },
    {
      id: Versions2.MakeFileSizeOptional,
      up: (asset) => {
        if (asset.props.fileSize === -1) {
          asset.props.fileSize = void 0;
        }
      },
      down: (asset) => {
        if (asset.props.fileSize === void 0) {
          asset.props.fileSize = -1;
        }
      }
    },
    {
      id: Versions2.AddPixelRatio,
      up: (_asset) => {
      },
      down: (asset) => {
        delete asset.props.pixelRatio;
      }
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/assets/TLVideoAsset.mjs
var videoAssetProps = {
  w: validation_exports.number,
  h: validation_exports.number,
  name: validation_exports.string,
  isAnimated: validation_exports.boolean,
  mimeType: validation_exports.string.nullable(),
  src: validation_exports.srcUrl.nullable(),
  fileSize: validation_exports.number.optional()
};
var videoAssetValidator = createAssetValidator(
  "video",
  validation_exports.object(videoAssetProps)
);
var Versions3 = createMigrationIds("com.tldraw.asset.video", {
  AddIsAnimated: 1,
  RenameWidthHeight: 2,
  MakeUrlsValid: 3,
  AddFileSize: 4,
  MakeFileSizeOptional: 5
});
var videoAssetMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.asset.video",
  recordType: "asset",
  filter: (asset) => asset.type === "video",
  sequence: [
    {
      id: Versions3.AddIsAnimated,
      up: (asset) => {
        asset.props.isAnimated = false;
      },
      down: (asset) => {
        delete asset.props.isAnimated;
      }
    },
    {
      id: Versions3.RenameWidthHeight,
      up: (asset) => {
        asset.props.w = asset.props.width;
        asset.props.h = asset.props.height;
        delete asset.props.width;
        delete asset.props.height;
      },
      down: (asset) => {
        asset.props.width = asset.props.w;
        asset.props.height = asset.props.h;
        delete asset.props.w;
        delete asset.props.h;
      }
    },
    {
      id: Versions3.MakeUrlsValid,
      up: (asset) => {
        if (!validation_exports.srcUrl.isValid(asset.props.src)) {
          asset.props.src = "";
        }
      },
      down: (_asset) => {
      }
    },
    {
      id: Versions3.AddFileSize,
      up: (asset) => {
        asset.props.fileSize = -1;
      },
      down: (asset) => {
        delete asset.props.fileSize;
      }
    },
    {
      id: Versions3.MakeFileSizeOptional,
      up: (asset) => {
        if (asset.props.fileSize === -1) {
          asset.props.fileSize = void 0;
        }
      },
      down: (asset) => {
        if (asset.props.fileSize === void 0) {
          asset.props.fileSize = -1;
        }
      }
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/misc/geometry-types.mjs
var vecModelValidator = validation_exports.object({
  x: validation_exports.number,
  y: validation_exports.number,
  z: validation_exports.number.optional()
});
var boxModelValidator = validation_exports.object({
  x: validation_exports.number,
  y: validation_exports.number,
  w: validation_exports.number,
  h: validation_exports.number
});

// ../../node_modules/@tldraw/tlschema/dist-esm/misc/TLOpacity.mjs
var opacityValidator = validation_exports.unitInterval;

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLBaseShape.mjs
var parentIdValidator = validation_exports.string.refine((id) => {
  if (!id.startsWith("page:") && !id.startsWith("shape:")) {
    throw new Error('Parent ID must start with "page:" or "shape:"');
  }
  return id;
});
var shapeIdValidator = idValidator("shape");
function createShapeValidator(type, props, meta) {
  return validation_exports.object({
    id: shapeIdValidator,
    typeName: validation_exports.literal("shape"),
    x: validation_exports.number,
    y: validation_exports.number,
    rotation: validation_exports.number,
    index: validation_exports.indexKey,
    parentId: parentIdValidator,
    type: validation_exports.literal(type),
    isLocked: validation_exports.boolean,
    opacity: opacityValidator,
    props: props ? validation_exports.object(props) : validation_exports.jsonValue,
    meta: meta ? validation_exports.object(meta) : validation_exports.jsonValue
  });
}

// ../../node_modules/@tldraw/tlschema/dist-esm/bindings/TLBaseBinding.mjs
var bindingIdValidator = idValidator("binding");
function createBindingValidator(type, props, meta) {
  return validation_exports.object({
    id: bindingIdValidator,
    typeName: validation_exports.literal("binding"),
    type: validation_exports.literal(type),
    fromId: shapeIdValidator,
    toId: shapeIdValidator,
    props: props ? validation_exports.object(props) : validation_exports.jsonValue,
    meta: meta ? validation_exports.object(meta) : validation_exports.jsonValue
  });
}

// ../../node_modules/@tldraw/tlschema/dist-esm/records/TLBinding.mjs
var rootBindingVersions = createMigrationIds("com.tldraw.binding", {});
var rootBindingMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.binding",
  recordType: "binding",
  sequence: []
});
function isBinding(record) {
  if (!record) return false;
  return record.typeName === "binding";
}
function isBindingId(id) {
  if (!id) return false;
  return id.startsWith("binding:");
}
function createBindingId(id) {
  return `binding:${id ?? uniqueId()}`;
}
function createBindingPropsMigrationSequence(migrations) {
  return migrations;
}
function createBindingPropsMigrationIds(bindingType, ids) {
  return mapObjectMapValues(ids, (_k, v) => `com.tldraw.binding.${bindingType}/${v}`);
}
function createBindingRecordType(bindings) {
  return createRecordType("binding", {
    scope: "document",
    validator: validation_exports.model(
      "binding",
      validation_exports.union(
        "type",
        mapObjectMapValues(
          bindings,
          (type, { props, meta }) => createBindingValidator(type, props, meta)
        )
      )
    )
  }).withDefaultProperties(() => ({
    meta: {}
  }));
}

// ../../node_modules/@tldraw/tlschema/dist-esm/misc/TLRichText.mjs
var richTextValidator = validation_exports.object({
  type: validation_exports.string,
  content: validation_exports.arrayOf(validation_exports.unknown),
  attrs: validation_exports.any.optional()
});
function toRichText(text) {
  const lines = text.split("\n");
  const content = lines.map((text2) => {
    if (!text2) {
      return {
        type: "paragraph"
      };
    }
    return {
      type: "paragraph",
      content: [{ type: "text", text: text2 }]
    };
  });
  return {
    type: "doc",
    content
  };
}

// ../../node_modules/@tldraw/tlschema/dist-esm/styles/StyleProp.mjs
var StyleProp = class _StyleProp {
  /** @internal */
  constructor(id, defaultValue, type) {
    this.id = id;
    this.defaultValue = defaultValue;
    this.type = type;
  }
  id;
  defaultValue;
  type;
  /**
   * Define a new {@link StyleProp}.
   *
   * @param uniqueId - Each StyleProp must have a unique ID. We recommend you prefix this with
   * your app/library name.
   * @param options -
   * - `defaultValue`: The default value for this style prop.
   *
   * - `type`: Optionally, describe what type of data you expect for this style prop.
   *
   * @example
   * ```ts
   * import {T} from '@tldraw/validate'
   * import {StyleProp} from '@tldraw/tlschema'
   *
   * const MyLineWidthProp = StyleProp.define('myApp:lineWidth', {
   *   defaultValue: 1,
   *   type: T.number,
   * })
   * ```
   * @public
   */
  static define(uniqueId2, options) {
    const { defaultValue, type = validation_exports.any } = options;
    return new _StyleProp(uniqueId2, defaultValue, type);
  }
  /**
   * Define a new {@link StyleProp} as a list of possible values.
   *
   * @param uniqueId - Each StyleProp must have a unique ID. We recommend you prefix this with
   * your app/library name.
   * @param options -
   * - `defaultValue`: The default value for this style prop.
   *
   * - `values`: An array of possible values of this style prop.
   *
   * @example
   * ```ts
   * import {StyleProp} from '@tldraw/tlschema'
   *
   * const MySizeProp = StyleProp.defineEnum('myApp:size', {
   *   defaultValue: 'medium',
   *   values: ['small', 'medium', 'large'],
   * })
   * ```
   */
  static defineEnum(uniqueId2, options) {
    const { defaultValue, values } = options;
    return new EnumStyleProp(uniqueId2, defaultValue, values);
  }
  setDefaultValue(value) {
    this.defaultValue = value;
  }
  validate(value) {
    return this.type.validate(value);
  }
  validateUsingKnownGoodVersion(prevValue, newValue) {
    if (this.type.validateUsingKnownGoodVersion) {
      return this.type.validateUsingKnownGoodVersion(prevValue, newValue);
    } else {
      return this.validate(newValue);
    }
  }
};
var EnumStyleProp = class extends StyleProp {
  /** @internal */
  constructor(id, defaultValue, values) {
    super(id, defaultValue, validation_exports.literalEnum(...values));
    this.values = [...values];
  }
  values;
  /**
   * Add new values to this enum style prop at runtime. This is useful for extending
   * the built-in styles with custom values (e.g. adding custom colors). Be sure to
   * also modify the associated types.
   *
   * @param newValues - The new values to add.
   *
   * @public
   */
  addValues(...newValues) {
    for (const v of newValues) {
      if (!this.values.includes(v)) {
        this.values.push(v);
      }
    }
    ;
    this.type = validation_exports.literalEnum(...this.values);
  }
  /**
   * Remove values from this enum style prop at runtime. This is useful for narrowing
   * the built-in styles with custom values (e.g. adding custom colors). Be sure to
   * also modify the associated types.
   *
   * @param valuesToRemove - The values to remove.
   *
   * @public
   */
  removeValues(...valuesToRemove) {
    for (const v of valuesToRemove) {
      if (this.values.includes(v)) {
        this.values.splice(this.values.indexOf(v), 1);
      }
    }
    ;
    this.type = validation_exports.literalEnum(...this.values);
  }
};

// ../../node_modules/@tldraw/tlschema/dist-esm/records/TLShape.mjs
var rootShapeVersions = createMigrationIds("com.tldraw.shape", {
  AddIsLocked: 1,
  HoistOpacity: 2,
  AddMeta: 3,
  AddWhite: 4
});
var rootShapeMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.shape",
  recordType: "shape",
  sequence: [
    {
      id: rootShapeVersions.AddIsLocked,
      up: (record) => {
        record.isLocked = false;
      },
      down: (record) => {
        delete record.isLocked;
      }
    },
    {
      id: rootShapeVersions.HoistOpacity,
      up: (record) => {
        record.opacity = Number(record.props.opacity ?? "1");
        delete record.props.opacity;
      },
      down: (record) => {
        const opacity = record.opacity;
        delete record.opacity;
        record.props.opacity = opacity < 0.175 ? "0.1" : opacity < 0.375 ? "0.25" : opacity < 0.625 ? "0.5" : opacity < 0.875 ? "0.75" : "1";
      }
    },
    {
      id: rootShapeVersions.AddMeta,
      up: (record) => {
        record.meta = {};
      }
    },
    {
      id: rootShapeVersions.AddWhite,
      up: (_record) => {
      },
      down: (record) => {
        if (record.props.color === "white") {
          record.props.color = "black";
        }
      }
    }
  ]
});
function isShape(record) {
  if (!record) return false;
  return record.typeName === "shape";
}
function isShapeId(id) {
  if (!id) return false;
  return id.startsWith("shape:");
}
function createShapeId(id) {
  return `shape:${id ?? uniqueId()}`;
}
function getShapePropKeysByStyle(props) {
  const propKeysByStyle = /* @__PURE__ */ new Map();
  for (const [key, prop] of Object.entries(props)) {
    if (prop instanceof StyleProp) {
      if (propKeysByStyle.has(prop)) {
        throw new Error(
          `Duplicate style prop ${prop.id}. Each style prop can only be used once within a shape.`
        );
      }
      propKeysByStyle.set(prop, key);
    }
  }
  return propKeysByStyle;
}
function createShapePropsMigrationSequence(migrations) {
  return migrations;
}
function createShapePropsMigrationIds(shapeType, ids) {
  return mapObjectMapValues(ids, (_k, v) => `com.tldraw.shape.${shapeType}/${v}`);
}
function createShapeRecordType(shapes) {
  return createRecordType("shape", {
    scope: "document",
    validator: validation_exports.model(
      "shape",
      validation_exports.union(
        "type",
        mapObjectMapValues(
          shapes,
          (type, { props, meta }) => createShapeValidator(type, props, meta)
        )
      )
    )
  }).withDefaultProperties(() => ({
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {}
  }));
}

// ../../node_modules/@tldraw/tlschema/dist-esm/recordsWithProps.mjs
function processPropsMigrations(typeName, records) {
  const result = [];
  for (const [subType, { migrations }] of Object.entries(records)) {
    const sequenceId = `com.tldraw.${typeName}.${subType}`;
    if (!migrations) {
      result.push(
        createMigrationSequence({
          sequenceId,
          retroactive: true,
          sequence: []
        })
      );
    } else if ("sequenceId" in migrations) {
      assert(
        sequenceId === migrations.sequenceId,
        `sequenceId mismatch for ${subType} ${RecordType} migrations. Expected '${sequenceId}', got '${migrations.sequenceId}'`
      );
      result.push(migrations);
    } else if ("sequence" in migrations) {
      result.push(
        createMigrationSequence({
          sequenceId,
          retroactive: true,
          sequence: migrations.sequence.map(
            (m) => "id" in m ? createPropsMigration(typeName, subType, m) : m
          )
        })
      );
    } else {
      result.push(
        createMigrationSequence({
          sequenceId,
          retroactive: true,
          sequence: Object.keys(migrations.migrators).map((k) => Number(k)).sort((a, b) => a - b).map(
            (version) => ({
              id: `${sequenceId}/${version}`,
              scope: "record",
              filter: (r) => r.typeName === typeName && r.type === subType,
              up: (record) => {
                const result2 = migrations.migrators[version].up(record);
                if (result2) {
                  return result2;
                }
              },
              down: (record) => {
                const result2 = migrations.migrators[version].down(record);
                if (result2) {
                  return result2;
                }
              }
            })
          )
        })
      );
    }
  }
  return result;
}
function createPropsMigration(typeName, subType, m) {
  return {
    id: m.id,
    dependsOn: m.dependsOn,
    scope: "record",
    filter: (r) => r.typeName === typeName && r.type === subType,
    up: (record) => {
      const result = m.up(record.props);
      if (result) {
        record.props = result;
      }
    },
    down: typeof m.down === "function" ? (record) => {
      const result = m.down(record.props);
      if (result) {
        record.props = result;
      }
    } : void 0
  };
}

// ../../node_modules/@tldraw/tlschema/dist-esm/styles/TLColorStyle.mjs
var defaultColorNames = [
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
  "white"
];
var DefaultColorStyle = StyleProp.defineEnum("tldraw:color", {
  defaultValue: "black",
  values: defaultColorNames
});
var DefaultLabelColorStyle = StyleProp.defineEnum("tldraw:labelColor", {
  defaultValue: "black",
  values: defaultColorNames
});
function registerColorsFromThemes(definitions) {
  const colorNames = /* @__PURE__ */ new Set();
  for (const def of Object.values(definitions)) {
    for (const colorPalette of [def.colors.light, def.colors.dark]) {
      for (const [key, value] of Object.entries(colorPalette)) {
        if (typeof value === "object" && value !== null) {
          colorNames.add(key);
        }
      }
    }
  }
  if (colorNames.size > 0) {
    DefaultColorStyle.addValues(...colorNames);
    DefaultLabelColorStyle.addValues(...colorNames);
  }
  const toRemove = DefaultColorStyle.values.filter((v) => !colorNames.has(v));
  if (toRemove.length > 0) {
    DefaultColorStyle.removeValues(...toRemove);
    DefaultLabelColorStyle.removeValues(...toRemove);
  }
  if (true) {
    for (const def of Object.values(definitions)) {
      for (const color of colorNames) {
        if (!(color in def.colors.light)) {
          console.warn(
            `Theme '${def.id}' light palette is missing color '${color}'. Shapes using this color won't render correctly.`
          );
        }
        if (!(color in def.colors.dark)) {
          console.warn(
            `Theme '${def.id}' dark palette is missing color '${color}'. Shapes using this color won't render correctly.`
          );
        }
      }
    }
  }
}

// ../../node_modules/@tldraw/tlschema/dist-esm/styles/TLDashStyle.mjs
var DefaultDashStyle = StyleProp.defineEnum("tldraw:dash", {
  defaultValue: "draw",
  values: ["draw", "solid", "dashed", "dotted", "none"]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/styles/TLFillStyle.mjs
var DefaultFillStyle = StyleProp.defineEnum("tldraw:fill", {
  defaultValue: "none",
  values: ["none", "semi", "solid", "pattern", "fill", "lined-fill"]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/styles/TLFontStyle.mjs
var DefaultFontStyle = StyleProp.defineEnum("tldraw:font", {
  defaultValue: "draw",
  values: ["draw", "sans", "serif", "mono"]
});
var DefaultFontFamilies = {
  draw: "'tldraw_draw', sans-serif",
  sans: "'tldraw_sans', sans-serif",
  serif: "'tldraw_serif', serif",
  mono: "'tldraw_mono', monospace"
};
function isFontEntry(value) {
  return typeof value === "object" && value !== null && "fontFamily" in value;
}
function registerFontsFromThemes(definitions) {
  const fontNames = /* @__PURE__ */ new Set();
  for (const def of Object.values(definitions)) {
    if (!def.fonts) continue;
    for (const [key, value] of Object.entries(def.fonts)) {
      if (isFontEntry(value)) {
        fontNames.add(key);
      }
    }
  }
  const toAdd = [...fontNames].filter((v) => !DefaultFontStyle.values.includes(v));
  if (toAdd.length > 0) {
    DefaultFontStyle.addValues(...toAdd);
  }
  const toRemove = DefaultFontStyle.values.filter((v) => !fontNames.has(v));
  if (toRemove.length > 0) {
    DefaultFontStyle.removeValues(...toRemove);
  }
  if (true) {
    for (const def of Object.values(definitions)) {
      for (const font of fontNames) {
        if (!def.fonts || !(font in def.fonts)) {
          console.warn(
            `Theme '${def.id}' is missing font '${font}'. Shapes using this font won't render correctly in this theme.`
          );
        }
      }
    }
  }
}

// ../../node_modules/@tldraw/tlschema/dist-esm/styles/TLSizeStyle.mjs
var DefaultSizeStyle = StyleProp.defineEnum("tldraw:size", {
  defaultValue: "m",
  values: ["s", "m", "l", "xl"]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLArrowShape.mjs
var arrowKinds = ["arc", "elbow"];
var ArrowShapeKindStyle = StyleProp.defineEnum("tldraw:arrowKind", {
  defaultValue: "arc",
  values: arrowKinds
});
var arrowheadTypes = [
  "arrow",
  "triangle",
  "square",
  "dot",
  "pipe",
  "diamond",
  "inverted",
  "bar",
  "none"
];
var ArrowShapeArrowheadStartStyle = StyleProp.defineEnum("tldraw:arrowheadStart", {
  defaultValue: "none",
  values: arrowheadTypes
});
var ArrowShapeArrowheadEndStyle = StyleProp.defineEnum("tldraw:arrowheadEnd", {
  defaultValue: "arrow",
  values: arrowheadTypes
});
var arrowShapeProps = {
  kind: ArrowShapeKindStyle,
  labelColor: DefaultLabelColorStyle,
  color: DefaultColorStyle,
  fill: DefaultFillStyle,
  dash: DefaultDashStyle,
  size: DefaultSizeStyle,
  arrowheadStart: ArrowShapeArrowheadStartStyle,
  arrowheadEnd: ArrowShapeArrowheadEndStyle,
  font: DefaultFontStyle,
  start: vecModelValidator,
  end: vecModelValidator,
  bend: validation_exports.number,
  richText: richTextValidator,
  labelPosition: validation_exports.number,
  scale: validation_exports.nonZeroNumber,
  elbowMidPoint: validation_exports.number
};
var arrowShapeVersions = createShapePropsMigrationIds("arrow", {
  AddLabelColor: 1,
  AddIsPrecise: 2,
  AddLabelPosition: 3,
  ExtractBindings: 4,
  AddScale: 5,
  AddElbow: 6,
  AddRichText: 7,
  AddRichTextAttrs: 8
});
function propsMigration(migration) {
  return createPropsMigration("shape", "arrow", migration);
}
var arrowShapeMigrations = createMigrationSequence({
  sequenceId: "com.tldraw.shape.arrow",
  retroactive: false,
  sequence: [
    propsMigration({
      id: arrowShapeVersions.AddLabelColor,
      up: (props) => {
        props.labelColor = "black";
      },
      down: "retired"
    }),
    propsMigration({
      id: arrowShapeVersions.AddIsPrecise,
      up: ({ start, end }) => {
        if (start.type === "binding") {
          start.isPrecise = !(start.normalizedAnchor.x === 0.5 && start.normalizedAnchor.y === 0.5);
        }
        if (end.type === "binding") {
          end.isPrecise = !(end.normalizedAnchor.x === 0.5 && end.normalizedAnchor.y === 0.5);
        }
      },
      down: ({ start, end }) => {
        if (start.type === "binding") {
          if (!start.isPrecise) {
            start.normalizedAnchor = { x: 0.5, y: 0.5 };
          }
          delete start.isPrecise;
        }
        if (end.type === "binding") {
          if (!end.isPrecise) {
            end.normalizedAnchor = { x: 0.5, y: 0.5 };
          }
          delete end.isPrecise;
        }
      }
    }),
    propsMigration({
      id: arrowShapeVersions.AddLabelPosition,
      up: (props) => {
        props.labelPosition = 0.5;
      },
      down: (props) => {
        delete props.labelPosition;
      }
    }),
    {
      id: arrowShapeVersions.ExtractBindings,
      scope: "storage",
      up: (storage) => {
        const updates = [];
        for (const record of storage.values()) {
          if (record.typeName !== "shape" || record.type !== "arrow") continue;
          const arrow = record;
          const newArrow = structuredClone(arrow);
          const { start, end } = arrow.props;
          if (start.type === "binding") {
            const id = createBindingId();
            const binding = {
              typeName: "binding",
              id,
              type: "arrow",
              fromId: arrow.id,
              toId: start.boundShapeId,
              meta: {},
              props: {
                terminal: "start",
                normalizedAnchor: start.normalizedAnchor,
                isExact: start.isExact,
                isPrecise: start.isPrecise
              }
            };
            updates.push([id, binding]);
            newArrow.props.start = { x: 0, y: 0 };
          } else {
            delete newArrow.props.start.type;
          }
          if (end.type === "binding") {
            const id = createBindingId();
            const binding = {
              typeName: "binding",
              id,
              type: "arrow",
              fromId: arrow.id,
              toId: end.boundShapeId,
              meta: {},
              props: {
                terminal: "end",
                normalizedAnchor: end.normalizedAnchor,
                isExact: end.isExact,
                isPrecise: end.isPrecise
              }
            };
            updates.push([id, binding]);
            newArrow.props.end = { x: 0, y: 0 };
          } else {
            delete newArrow.props.end.type;
          }
          updates.push([arrow.id, newArrow]);
        }
        for (const [id, record] of updates) {
          storage.set(id, record);
        }
      }
    },
    propsMigration({
      id: arrowShapeVersions.AddScale,
      up: (props) => {
        props.scale = 1;
      },
      down: (props) => {
        delete props.scale;
      }
    }),
    propsMigration({
      id: arrowShapeVersions.AddElbow,
      up: (props) => {
        props.kind = "arc";
        props.elbowMidPoint = 0.5;
      },
      down: (props) => {
        delete props.kind;
        delete props.elbowMidPoint;
      }
    }),
    propsMigration({
      id: arrowShapeVersions.AddRichText,
      up: (props) => {
        props.richText = toRichText(props.text);
        delete props.text;
      }
      // N.B. Explicitly no down state so that we force clients to update.
      // down: (props) => {
      // 	delete props.richText
      // },
    }),
    propsMigration({
      id: arrowShapeVersions.AddRichTextAttrs,
      up: (_props) => {
      },
      down: (props) => {
        if (props.richText && "attrs" in props.richText) {
          delete props.richText.attrs;
        }
      }
    })
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/bindings/TLArrowBinding.mjs
var ElbowArrowSnap = validation_exports.literalEnum("center", "edge-point", "edge", "none");
var arrowBindingProps = {
  terminal: validation_exports.literalEnum("start", "end"),
  normalizedAnchor: vecModelValidator,
  isExact: validation_exports.boolean,
  isPrecise: validation_exports.boolean,
  snap: ElbowArrowSnap
};
var arrowBindingVersions = createBindingPropsMigrationIds("arrow", {
  AddSnap: 1
});
var arrowBindingMigrations = createBindingPropsMigrationSequence({
  sequence: [
    { dependsOn: [arrowShapeVersions.ExtractBindings] },
    {
      id: arrowBindingVersions.AddSnap,
      up: (props) => {
        props.snap = "none";
      },
      down: (props) => {
        delete props.snap;
      }
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/records/TLCamera.mjs
var cameraValidator = validation_exports.model(
  "camera",
  validation_exports.object({
    typeName: validation_exports.literal("camera"),
    id: idValidator("camera"),
    x: validation_exports.number,
    y: validation_exports.number,
    z: validation_exports.number,
    meta: validation_exports.jsonValue
  })
);
var cameraVersions = createMigrationIds("com.tldraw.camera", {
  AddMeta: 1
});
var cameraMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.camera",
  recordType: "camera",
  sequence: [
    {
      id: cameraVersions.AddMeta,
      up: (record) => {
        ;
        record.meta = {};
      }
    }
  ]
});
var CameraRecordType = createRecordType("camera", {
  validator: cameraValidator,
  scope: "session"
}).withDefaultProperties(
  () => ({
    x: 0,
    y: 0,
    z: 1,
    meta: {}
  })
);

// ../../node_modules/@tldraw/tlschema/dist-esm/misc/TLCursor.mjs
var TL_CURSOR_TYPES = /* @__PURE__ */ new Set([
  "none",
  "default",
  "pointer",
  "cross",
  "comment",
  "grab",
  "rotate",
  "grabbing",
  "resize-edge",
  "resize-corner",
  "text",
  "move",
  "ew-resize",
  "ns-resize",
  "nesw-resize",
  "nwse-resize",
  "nesw-rotate",
  "nwse-rotate",
  "swne-rotate",
  "senw-rotate",
  "zoom-in",
  "zoom-out"
]);
var cursorTypeValidator = validation_exports.setEnum(TL_CURSOR_TYPES);
var cursorValidator = validation_exports.object({
  type: cursorTypeValidator,
  rotation: validation_exports.number
});

// ../../node_modules/@tldraw/tlschema/dist-esm/misc/TLColor.mjs
var TL_CANVAS_UI_COLOR_TYPES = /* @__PURE__ */ new Set([
  "accent",
  "white",
  "black",
  "selection-stroke",
  "selection-fill",
  "laser",
  "muted-1"
]);
var canvasUiColorTypeValidator = validation_exports.setEnum(TL_CANVAS_UI_COLOR_TYPES);

// ../../node_modules/@tldraw/tlschema/dist-esm/misc/TLScribble.mjs
var TL_SCRIBBLE_STATES = /* @__PURE__ */ new Set([
  "starting",
  "paused",
  "active",
  "complete",
  "stopping"
]);
var scribbleValidator = validation_exports.object({
  id: validation_exports.string,
  points: validation_exports.arrayOf(vecModelValidator),
  size: validation_exports.positiveNumber,
  color: canvasUiColorTypeValidator,
  opacity: validation_exports.number,
  state: validation_exports.setEnum(TL_SCRIBBLE_STATES),
  delay: validation_exports.number,
  shrink: validation_exports.number,
  taper: validation_exports.boolean
});

// ../../node_modules/@tldraw/tlschema/dist-esm/records/TLPage.mjs
var pageIdValidator = idValidator("page");
var pageValidator = validation_exports.model(
  "page",
  validation_exports.object({
    typeName: validation_exports.literal("page"),
    id: pageIdValidator,
    name: validation_exports.string,
    index: validation_exports.indexKey,
    meta: validation_exports.jsonValue
  })
);
var pageVersions = createMigrationIds("com.tldraw.page", {
  AddMeta: 1
});
var pageMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.page",
  recordType: "page",
  sequence: [
    {
      id: pageVersions.AddMeta,
      up: (record) => {
        record.meta = {};
      }
    }
  ]
});
var PageRecordType = createRecordType("page", {
  validator: pageValidator,
  scope: "document"
}).withDefaultProperties(() => ({
  meta: {}
}));
function isPageId(id) {
  return PageRecordType.isId(id);
}

// ../../node_modules/@tldraw/tlschema/dist-esm/records/TLUser.mjs
var userIdValidator = idValidator("user");
var userVersions = createMigrationIds("com.tldraw.user", {
  Initial: 1
});
var userMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.user",
  recordType: "user",
  sequence: [
    {
      id: userVersions.Initial,
      up: (_record) => {
      }
    }
  ]
});
function createUserRecordType(config) {
  const metaConfig = config?.meta;
  const metaValidator = metaConfig ? validation_exports.object(
    Object.fromEntries(
      Object.entries(metaConfig).map(([key, v]) => [
        key,
        new validation_exports.Validator((value) => {
          if (value === void 0) return void 0;
          return v.validate(value);
        })
      ])
    )
  ).allowUnknownProperties() : validation_exports.jsonValue;
  const validator = validation_exports.model(
    "user",
    validation_exports.object({
      typeName: validation_exports.literal("user"),
      id: userIdValidator,
      name: validation_exports.string,
      color: validation_exports.string,
      imageUrl: validation_exports.string,
      meta: metaValidator
    })
  );
  return createRecordType("user", {
    validator,
    scope: "document"
  }).withDefaultProperties(() => ({
    name: "",
    color: "",
    imageUrl: "",
    meta: {}
  }));
}
var userValidator = validation_exports.model(
  "user",
  validation_exports.object({
    typeName: validation_exports.literal("user"),
    id: userIdValidator,
    name: validation_exports.string,
    color: validation_exports.string,
    imageUrl: validation_exports.string,
    meta: validation_exports.jsonValue
  })
);
var UserRecordType = createUserRecordType();
function isUserId(id) {
  return UserRecordType.isId(id);
}
function createUserId(id) {
  return UserRecordType.createId(id);
}

// ../../node_modules/@tldraw/tlschema/dist-esm/records/TLInstance.mjs
var shouldKeyBePreservedBetweenSessions = {
  // This object defines keys that should be preserved across calls to loadSnapshot()
  id: false,
  // meta
  typeName: false,
  // meta
  currentPageId: false,
  // does not preserve because who knows if the page still exists
  opacityForNextShape: false,
  // does not preserve because it's a temporary state
  stylesForNextShape: false,
  // does not preserve because it's a temporary state
  followingUserId: false,
  // does not preserve because it's a temporary state
  highlightedUserIds: false,
  // does not preserve because it's a temporary state
  brush: false,
  // does not preserve because it's a temporary state
  cursor: false,
  // does not preserve because it's a temporary state
  scribbles: false,
  // does not preserve because it's a temporary state
  isFocusMode: true,
  // preserves because it's a user preference
  isDebugMode: true,
  // preserves because it's a user preference
  isToolLocked: true,
  // preserves because it's a user preference
  exportBackground: true,
  // preserves because it's a user preference
  screenBounds: true,
  // preserves because it's capturing the user's screen state
  insets: true,
  // preserves because it's capturing the user's screen state
  zoomBrush: false,
  // does not preserve because it's a temporary state
  chatMessage: false,
  // does not preserve because it's a temporary state
  isChatting: false,
  // does not preserve because it's a temporary state
  isPenMode: false,
  // does not preserve because it's a temporary state
  isGridMode: true,
  // preserves because it's a user preference
  isFocused: true,
  // preserves because obviously
  devicePixelRatio: true,
  // preserves because it captures the user's screen state
  isCoarsePointer: true,
  // preserves because it captures the user's screen state
  isHoveringCanvas: false,
  // does not preserve because it's a temporary state
  openMenus: false,
  // does not preserve because it's a temporary state
  isChangingStyle: false,
  // does not preserve because it's a temporary state
  isReadonly: true,
  // preserves because it's a config option
  meta: false,
  // does not preserve because who knows what's in there, leave it up to sdk users to save and reinstate
  duplicateProps: false,
  //
  cameraState: false
  // does not preserve because it's a temporary state
};
function pluckPreservingValues(val) {
  return val ? filterEntries(val, (key) => {
    return shouldKeyBePreservedBetweenSessions[key];
  }) : null;
}
var instanceIdValidator = idValidator("instance");
function createInstanceRecordType(stylesById) {
  const stylesForNextShapeValidators = {};
  for (const [id, style] of stylesById) {
    stylesForNextShapeValidators[id] = validation_exports.optional(style);
  }
  const instanceTypeValidator = validation_exports.model(
    "instance",
    validation_exports.object({
      typeName: validation_exports.literal("instance"),
      id: idValidator("instance"),
      currentPageId: pageIdValidator,
      followingUserId: userIdValidator.nullable(),
      brush: boxModelValidator.nullable(),
      opacityForNextShape: opacityValidator,
      stylesForNextShape: validation_exports.object(stylesForNextShapeValidators),
      cursor: cursorValidator,
      scribbles: validation_exports.arrayOf(scribbleValidator),
      isFocusMode: validation_exports.boolean,
      isDebugMode: validation_exports.boolean,
      isToolLocked: validation_exports.boolean,
      exportBackground: validation_exports.boolean,
      screenBounds: boxModelValidator,
      insets: validation_exports.arrayOf(validation_exports.boolean),
      zoomBrush: boxModelValidator.nullable(),
      isPenMode: validation_exports.boolean,
      isGridMode: validation_exports.boolean,
      chatMessage: validation_exports.string,
      isChatting: validation_exports.boolean,
      highlightedUserIds: validation_exports.arrayOf(userIdValidator),
      isFocused: validation_exports.boolean,
      devicePixelRatio: validation_exports.number,
      isCoarsePointer: validation_exports.boolean,
      isHoveringCanvas: validation_exports.boolean.nullable(),
      openMenus: validation_exports.arrayOf(validation_exports.string),
      isChangingStyle: validation_exports.boolean,
      isReadonly: validation_exports.boolean,
      meta: validation_exports.jsonValue,
      duplicateProps: validation_exports.object({
        shapeIds: validation_exports.arrayOf(idValidator("shape")),
        offset: validation_exports.object({
          x: validation_exports.number,
          y: validation_exports.number
        })
      }).nullable(),
      cameraState: validation_exports.literalEnum("idle", "moving")
    })
  );
  return createRecordType("instance", {
    validator: instanceTypeValidator,
    scope: "session",
    ephemeralKeys: {
      currentPageId: false,
      meta: false,
      followingUserId: true,
      opacityForNextShape: true,
      stylesForNextShape: true,
      brush: true,
      cursor: true,
      scribbles: true,
      isFocusMode: true,
      isDebugMode: true,
      isToolLocked: true,
      exportBackground: true,
      screenBounds: true,
      insets: true,
      zoomBrush: true,
      isPenMode: true,
      isGridMode: true,
      chatMessage: true,
      isChatting: true,
      highlightedUserIds: true,
      isFocused: true,
      devicePixelRatio: true,
      isCoarsePointer: true,
      isHoveringCanvas: true,
      openMenus: true,
      isChangingStyle: true,
      isReadonly: true,
      duplicateProps: true,
      cameraState: true
    }
  }).withDefaultProperties(
    () => ({
      followingUserId: null,
      opacityForNextShape: 1,
      stylesForNextShape: {},
      brush: null,
      scribbles: [],
      cursor: {
        type: "default",
        rotation: 0
      },
      isFocusMode: false,
      exportBackground: false,
      isDebugMode: false,
      isToolLocked: false,
      screenBounds: { x: 0, y: 0, w: 1080, h: 720 },
      insets: [false, false, false, false],
      zoomBrush: null,
      isGridMode: false,
      isPenMode: false,
      chatMessage: "",
      isChatting: false,
      highlightedUserIds: [],
      isFocused: false,
      devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio,
      isCoarsePointer: false,
      isHoveringCanvas: null,
      openMenus: [],
      isChangingStyle: false,
      isReadonly: false,
      meta: {},
      duplicateProps: null,
      cameraState: "idle"
    })
  );
}
var instanceVersions = createMigrationIds("com.tldraw.instance", {
  AddTransparentExportBgs: 1,
  RemoveDialog: 2,
  AddToolLockMode: 3,
  RemoveExtraPropsForNextShape: 4,
  AddLabelColor: 5,
  AddFollowingUserId: 6,
  RemoveAlignJustify: 7,
  AddZoom: 8,
  AddVerticalAlign: 9,
  AddScribbleDelay: 10,
  RemoveUserId: 11,
  AddIsPenModeAndIsGridMode: 12,
  HoistOpacity: 13,
  AddChat: 14,
  AddHighlightedUserIds: 15,
  ReplacePropsForNextShapeWithStylesForNextShape: 16,
  AddMeta: 17,
  RemoveCursorColor: 18,
  AddLonelyProperties: 19,
  ReadOnlyReadonly: 20,
  AddHoveringCanvas: 21,
  AddScribbles: 22,
  AddInset: 23,
  AddDuplicateProps: 24,
  RemoveCanMoveCamera: 25,
  AddCameraState: 26
});
var instanceMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.instance",
  recordType: "instance",
  sequence: [
    {
      id: instanceVersions.AddTransparentExportBgs,
      up: (instance) => {
        return { ...instance, exportBackground: true };
      }
    },
    {
      id: instanceVersions.RemoveDialog,
      up: ({ dialog: _, ...instance }) => {
        return instance;
      }
    },
    {
      id: instanceVersions.AddToolLockMode,
      up: (instance) => {
        return { ...instance, isToolLocked: false };
      }
    },
    {
      id: instanceVersions.RemoveExtraPropsForNextShape,
      up: ({ propsForNextShape, ...instance }) => {
        return {
          ...instance,
          propsForNextShape: Object.fromEntries(
            Object.entries(propsForNextShape).filter(
              ([key]) => [
                "color",
                "labelColor",
                "dash",
                "fill",
                "size",
                "font",
                "align",
                "verticalAlign",
                "icon",
                "geo",
                "arrowheadStart",
                "arrowheadEnd",
                "spline"
              ].includes(key)
            )
          )
        };
      }
    },
    {
      id: instanceVersions.AddLabelColor,
      up: ({ propsForNextShape, ...instance }) => {
        return {
          ...instance,
          propsForNextShape: {
            ...propsForNextShape,
            labelColor: "black"
          }
        };
      }
    },
    {
      id: instanceVersions.AddFollowingUserId,
      up: (instance) => {
        return { ...instance, followingUserId: null };
      }
    },
    {
      id: instanceVersions.RemoveAlignJustify,
      up: (instance) => {
        let newAlign = instance.propsForNextShape.align;
        if (newAlign === "justify") {
          newAlign = "start";
        }
        return {
          ...instance,
          propsForNextShape: {
            ...instance.propsForNextShape,
            align: newAlign
          }
        };
      }
    },
    {
      id: instanceVersions.AddZoom,
      up: (instance) => {
        return { ...instance, zoomBrush: null };
      }
    },
    {
      id: instanceVersions.AddVerticalAlign,
      up: (instance) => {
        return {
          ...instance,
          propsForNextShape: {
            ...instance.propsForNextShape,
            verticalAlign: "middle"
          }
        };
      }
    },
    {
      id: instanceVersions.AddScribbleDelay,
      up: (instance) => {
        if (instance.scribble !== null) {
          return { ...instance, scribble: { ...instance.scribble, delay: 0 } };
        }
        return { ...instance };
      }
    },
    {
      id: instanceVersions.RemoveUserId,
      up: ({ userId: _, ...instance }) => {
        return instance;
      }
    },
    {
      id: instanceVersions.AddIsPenModeAndIsGridMode,
      up: (instance) => {
        return { ...instance, isPenMode: false, isGridMode: false };
      }
    },
    {
      id: instanceVersions.HoistOpacity,
      up: ({ propsForNextShape: { opacity, ...propsForNextShape }, ...instance }) => {
        return { ...instance, opacityForNextShape: Number(opacity ?? "1"), propsForNextShape };
      }
    },
    {
      id: instanceVersions.AddChat,
      up: (instance) => {
        return { ...instance, chatMessage: "", isChatting: false };
      }
    },
    {
      id: instanceVersions.AddHighlightedUserIds,
      up: (instance) => {
        return { ...instance, highlightedUserIds: [] };
      }
    },
    {
      id: instanceVersions.ReplacePropsForNextShapeWithStylesForNextShape,
      up: ({ propsForNextShape: _, ...instance }) => {
        return { ...instance, stylesForNextShape: {} };
      }
    },
    {
      id: instanceVersions.AddMeta,
      up: (record) => {
        return {
          ...record,
          meta: {}
        };
      }
    },
    {
      id: instanceVersions.RemoveCursorColor,
      up: (record) => {
        const { color: _, ...cursor } = record.cursor;
        return {
          ...record,
          cursor
        };
      }
    },
    {
      id: instanceVersions.AddLonelyProperties,
      up: (record) => {
        return {
          ...record,
          canMoveCamera: true,
          isFocused: false,
          devicePixelRatio: 1,
          isCoarsePointer: false,
          openMenus: [],
          isChangingStyle: false,
          isReadOnly: false
        };
      }
    },
    {
      id: instanceVersions.ReadOnlyReadonly,
      up: ({ isReadOnly: _isReadOnly, ...record }) => {
        return {
          ...record,
          isReadonly: _isReadOnly
        };
      }
    },
    {
      id: instanceVersions.AddHoveringCanvas,
      up: (record) => {
        return {
          ...record,
          isHoveringCanvas: null
        };
      }
    },
    {
      id: instanceVersions.AddScribbles,
      up: ({ scribble: _, ...record }) => {
        return {
          ...record,
          scribbles: []
        };
      }
    },
    {
      id: instanceVersions.AddInset,
      up: (record) => {
        return {
          ...record,
          insets: [false, false, false, false]
        };
      },
      down: ({ insets: _, ...record }) => {
        return {
          ...record
        };
      }
    },
    {
      id: instanceVersions.AddDuplicateProps,
      up: (record) => {
        return {
          ...record,
          duplicateProps: null
        };
      },
      down: ({ duplicateProps: _, ...record }) => {
        return {
          ...record
        };
      }
    },
    {
      id: instanceVersions.RemoveCanMoveCamera,
      up: ({ canMoveCamera: _, ...record }) => {
        return {
          ...record
        };
      },
      down: (instance) => {
        return { ...instance, canMoveCamera: true };
      }
    },
    {
      id: instanceVersions.AddCameraState,
      up: (record) => {
        return { ...record, cameraState: "idle" };
      },
      down: ({ cameraState: _, ...record }) => {
        return record;
      }
    }
  ]
});
var TLINSTANCE_ID = "instance:instance";

// ../../node_modules/@tldraw/tlschema/dist-esm/records/TLPageState.mjs
var instancePageStateValidator = validation_exports.model(
  "instance_page_state",
  validation_exports.object({
    typeName: validation_exports.literal("instance_page_state"),
    id: idValidator("instance_page_state"),
    pageId: pageIdValidator,
    selectedShapeIds: validation_exports.arrayOf(shapeIdValidator),
    hintingShapeIds: validation_exports.arrayOf(shapeIdValidator),
    erasingShapeIds: validation_exports.arrayOf(shapeIdValidator),
    hoveredShapeId: shapeIdValidator.nullable(),
    editingShapeId: shapeIdValidator.nullable(),
    croppingShapeId: shapeIdValidator.nullable(),
    focusedGroupId: shapeIdValidator.nullable(),
    meta: validation_exports.jsonValue
  })
);
var instancePageStateVersions = createMigrationIds("com.tldraw.instance_page_state", {
  AddCroppingId: 1,
  RemoveInstanceIdAndCameraId: 2,
  AddMeta: 3,
  RenameProperties: 4,
  RenamePropertiesAgain: 5
});
var instancePageStateMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.instance_page_state",
  recordType: "instance_page_state",
  sequence: [
    {
      id: instancePageStateVersions.AddCroppingId,
      up(instance) {
        instance.croppingShapeId = null;
      }
    },
    {
      id: instancePageStateVersions.RemoveInstanceIdAndCameraId,
      up(instance) {
        delete instance.instanceId;
        delete instance.cameraId;
      }
    },
    {
      id: instancePageStateVersions.AddMeta,
      up: (record) => {
        record.meta = {};
      }
    },
    {
      id: instancePageStateVersions.RenameProperties,
      // this migration is cursed: it was written wrong and doesn't do anything.
      // rather than replace it, I've added another migration below that fixes it.
      up: (_record) => {
      },
      down: (_record) => {
      }
    },
    {
      id: instancePageStateVersions.RenamePropertiesAgain,
      up: (record) => {
        record.selectedShapeIds = record.selectedIds;
        delete record.selectedIds;
        record.hintingShapeIds = record.hintingIds;
        delete record.hintingIds;
        record.erasingShapeIds = record.erasingIds;
        delete record.erasingIds;
        record.hoveredShapeId = record.hoveredId;
        delete record.hoveredId;
        record.editingShapeId = record.editingId;
        delete record.editingId;
        record.croppingShapeId = record.croppingShapeId ?? record.croppingId ?? null;
        delete record.croppingId;
        record.focusedGroupId = record.focusLayerId;
        delete record.focusLayerId;
      },
      down: (record) => {
        record.selectedIds = record.selectedShapeIds;
        delete record.selectedShapeIds;
        record.hintingIds = record.hintingShapeIds;
        delete record.hintingShapeIds;
        record.erasingIds = record.erasingShapeIds;
        delete record.erasingShapeIds;
        record.hoveredId = record.hoveredShapeId;
        delete record.hoveredShapeId;
        record.editingId = record.editingShapeId;
        delete record.editingShapeId;
        record.croppingId = record.croppingShapeId;
        delete record.croppingShapeId;
        record.focusLayerId = record.focusedGroupId;
        delete record.focusedGroupId;
      }
    }
  ]
});
var InstancePageStateRecordType = createRecordType(
  "instance_page_state",
  {
    validator: instancePageStateValidator,
    scope: "session",
    ephemeralKeys: {
      pageId: false,
      selectedShapeIds: false,
      // editingShapeId is set with `history: 'ignore'`, so entering the editing
      // state is never undoable. Marking it ephemeral keeps undo/redo from
      // reapplying a stale editingShapeId (e.g. after a shape it pointed at was
      // deleted), which could leave the editor pointing at a missing shape.
      editingShapeId: true,
      croppingShapeId: false,
      meta: false,
      hintingShapeIds: true,
      erasingShapeIds: true,
      hoveredShapeId: true,
      focusedGroupId: true
    }
  }
).withDefaultProperties(
  () => ({
    editingShapeId: null,
    croppingShapeId: null,
    selectedShapeIds: [],
    hoveredShapeId: null,
    erasingShapeIds: [],
    hintingShapeIds: [],
    focusedGroupId: null,
    meta: {}
  })
);

// ../../node_modules/@tldraw/tlschema/dist-esm/records/TLPointer.mjs
var pointerValidator = validation_exports.model(
  "pointer",
  validation_exports.object({
    typeName: validation_exports.literal("pointer"),
    id: idValidator("pointer"),
    x: validation_exports.number,
    y: validation_exports.number,
    lastActivityTimestamp: validation_exports.number,
    meta: validation_exports.jsonValue
  })
);
var pointerVersions = createMigrationIds("com.tldraw.pointer", {
  AddMeta: 1
});
var pointerMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.pointer",
  recordType: "pointer",
  sequence: [
    {
      id: pointerVersions.AddMeta,
      up: (record) => {
        record.meta = {};
      }
    }
  ]
});
var PointerRecordType = createRecordType("pointer", {
  validator: pointerValidator,
  scope: "session"
}).withDefaultProperties(
  () => ({
    x: 0,
    y: 0,
    lastActivityTimestamp: 0,
    meta: {}
  })
);
var TLPOINTER_ID = PointerRecordType.createId("pointer");

// ../../node_modules/@tldraw/tlschema/dist-esm/records/TLPresence.mjs
var instancePresenceValidator = validation_exports.model(
  "instance_presence",
  validation_exports.object({
    typeName: validation_exports.literal("instance_presence"),
    id: idValidator("instance_presence"),
    userId: userIdValidator,
    userName: validation_exports.string,
    lastActivityTimestamp: validation_exports.number.nullable(),
    followingUserId: userIdValidator.nullable(),
    cursor: validation_exports.object({
      x: validation_exports.number,
      y: validation_exports.number,
      type: cursorTypeValidator,
      rotation: validation_exports.number
    }).nullable(),
    color: validation_exports.string,
    camera: validation_exports.object({
      x: validation_exports.number,
      y: validation_exports.number,
      z: validation_exports.number
    }).nullable(),
    screenBounds: boxModelValidator.nullable(),
    selectedShapeIds: validation_exports.arrayOf(idValidator("shape")),
    currentPageId: idValidator("page"),
    brush: boxModelValidator.nullable(),
    scribbles: validation_exports.arrayOf(scribbleValidator),
    chatMessage: validation_exports.string,
    meta: validation_exports.jsonValue
  })
);
var instancePresenceVersions = createMigrationIds("com.tldraw.instance_presence", {
  AddScribbleDelay: 1,
  RemoveInstanceId: 2,
  AddChatMessage: 3,
  AddMeta: 4,
  RenameSelectedShapeIds: 5,
  NullableCameraCursor: 6
});
var instancePresenceMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.instance_presence",
  recordType: "instance_presence",
  sequence: [
    {
      id: instancePresenceVersions.AddScribbleDelay,
      up: (instance) => {
        if (instance.scribble !== null) {
          instance.scribble.delay = 0;
        }
      }
    },
    {
      id: instancePresenceVersions.RemoveInstanceId,
      up: (instance) => {
        delete instance.instanceId;
      }
    },
    {
      id: instancePresenceVersions.AddChatMessage,
      up: (instance) => {
        instance.chatMessage = "";
      }
    },
    {
      id: instancePresenceVersions.AddMeta,
      up: (record) => {
        record.meta = {};
      }
    },
    {
      id: instancePresenceVersions.RenameSelectedShapeIds,
      up: (_record) => {
      }
    },
    {
      id: instancePresenceVersions.NullableCameraCursor,
      up: (_record) => {
      },
      down: (record) => {
        if (record.camera === null) {
          record.camera = { x: 0, y: 0, z: 1 };
        }
        if (record.lastActivityTimestamp === null) {
          record.lastActivityTimestamp = 0;
        }
        if (record.cursor === null) {
          record.cursor = { type: "default", x: 0, y: 0, rotation: 0 };
        }
        if (record.screenBounds === null) {
          record.screenBounds = { x: 0, y: 0, w: 1, h: 1 };
        }
      }
    }
  ]
});
var InstancePresenceRecordType = createRecordType(
  "instance_presence",
  {
    validator: instancePresenceValidator,
    scope: "presence"
  }
).withDefaultProperties(() => ({
  lastActivityTimestamp: null,
  followingUserId: null,
  color: "#FF0000",
  camera: null,
  cursor: null,
  screenBounds: null,
  selectedShapeIds: [],
  brush: null,
  scribbles: [],
  chatMessage: "",
  meta: {}
}));

// ../../node_modules/@tldraw/tlschema/dist-esm/createPresenceStateDerivation.mjs
function createPresenceStateDerivation($user, opts) {
  const { instanceId, getUserPresence: _getUserPresence } = opts ?? {};
  const getUserPresence = _getUserPresence ?? getDefaultUserPresence;
  return (store) => {
    return computed("instancePresence", () => {
      const user = $user.get();
      if (!user) return null;
      const state = getUserPresence(store, user);
      if (!state) return null;
      return InstancePresenceRecordType.create({
        ...state,
        id: instanceId ?? InstancePresenceRecordType.createId(store.id)
      });
    });
  };
}
function getDefaultUserPresence(store, user) {
  const instance = store.get(TLINSTANCE_ID);
  const pageState = store.get(InstancePageStateRecordType.createId(instance?.currentPageId));
  const camera = store.get(CameraRecordType.createId(instance?.currentPageId));
  const pointer = store.get(TLPOINTER_ID);
  if (!pageState || !instance || !camera || !pointer) {
    return null;
  }
  return {
    selectedShapeIds: pageState.selectedShapeIds,
    brush: instance.brush,
    scribbles: instance.scribbles,
    userId: user.id,
    userName: user.name,
    followingUserId: instance.followingUserId,
    camera: {
      x: camera.x,
      y: camera.y,
      z: camera.z
    },
    color: user.color || "#FF0000",
    currentPageId: instance.currentPageId,
    cursor: {
      x: pointer.x,
      y: pointer.y,
      rotation: instance.cursor.rotation,
      type: instance.cursor.type
    },
    lastActivityTimestamp: pointer.lastActivityTimestamp,
    screenBounds: instance.screenBounds,
    chatMessage: instance.chatMessage,
    meta: {}
  };
}

// ../../node_modules/@tldraw/tlschema/dist-esm/records/TLAsset.mjs
var assetVersions = createMigrationIds("com.tldraw.asset", {
  AddMeta: 1
});
var assetMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.asset",
  recordType: "asset",
  sequence: [
    {
      id: assetVersions.AddMeta,
      up: (record) => {
        ;
        record.meta = {};
      }
    }
  ]
});
function createAssetRecordType(assets) {
  return createRecordType("asset", {
    scope: "document",
    validator: validation_exports.model(
      "asset",
      validation_exports.union(
        "type",
        mapObjectMapValues(
          assets,
          (type, { props, meta }) => createAssetValidator(type, props, meta)
        )
      )
    )
  }).withDefaultProperties(() => ({
    meta: {}
  }));
}
var AssetRecordType = createRecordType("asset", {
  scope: "document"
}).withDefaultProperties(() => ({
  meta: {}
}));
function createAssetPropsMigrationSequence(migrations) {
  return migrations;
}
function createAssetPropsMigrationIds(assetType, ids) {
  return mapObjectMapValues(ids, (_k, v) => `com.tldraw.asset.${assetType}/${v}`);
}

// ../../node_modules/@tldraw/tlschema/dist-esm/records/TLCustomRecord.mjs
function createCustomRecordType(typeName, config) {
  return createRecordType(typeName, {
    scope: config.scope,
    validator: config.validator
  }).withDefaultProperties(config.createDefaultProperties ?? (() => ({})));
}
function processCustomRecordMigrations(records) {
  const result = [];
  for (const [typeName, config] of Object.entries(records)) {
    const sequenceId = `com.tldraw.${typeName}`;
    const { migrations } = config;
    if (!migrations) {
      result.push(
        createMigrationSequence({
          sequenceId,
          retroactive: true,
          sequence: []
        })
      );
    } else if ("sequenceId" in migrations) {
      assert(
        sequenceId === migrations.sequenceId,
        `sequenceId mismatch for ${typeName} custom record migrations. Expected '${sequenceId}', got '${migrations.sequenceId}'`
      );
      result.push(migrations);
    } else if ("sequence" in migrations) {
      result.push(
        createMigrationSequence({
          sequenceId,
          retroactive: true,
          sequence: migrations.sequence.map((m) => {
            if (!("id" in m)) return m;
            return {
              id: m.id,
              dependsOn: m.dependsOn,
              scope: "record",
              filter: (r) => r.typeName === typeName,
              up: (record) => {
                const result2 = m.up(record);
                if (result2) return result2;
              },
              down: typeof m.down === "function" ? (record) => {
                const result2 = m.down(record);
                if (result2) return result2;
              } : void 0
            };
          })
        })
      );
    }
  }
  return result;
}
function createCustomRecordMigrationIds(recordType, ids) {
  return mapObjectMapValues(ids, (_k, v) => `com.tldraw.${recordType}/${v}`);
}
function createCustomRecordMigrationSequence(migrations) {
  return migrations;
}
function createCustomRecordId(typeName, id) {
  return `${typeName}:${id ?? uniqueId()}`;
}
function isCustomRecordId(typeName, id) {
  if (!id) return false;
  return id.startsWith(`${typeName}:`);
}
function isCustomRecord(typeName, record) {
  if (!record) return false;
  return record.typeName === typeName;
}

// ../../node_modules/@tldraw/tlschema/dist-esm/records/TLDocument.mjs
var documentValidator = validation_exports.model(
  "document",
  validation_exports.object({
    typeName: validation_exports.literal("document"),
    id: validation_exports.literal("document:document"),
    gridSize: validation_exports.number,
    name: validation_exports.string,
    meta: validation_exports.jsonValue
  })
);
function isDocument(record) {
  if (!record) return false;
  return record.typeName === "document";
}
var documentVersions = createMigrationIds("com.tldraw.document", {
  AddName: 1,
  AddMeta: 2
});
var documentMigrations = createRecordMigrationSequence({
  sequenceId: "com.tldraw.document",
  recordType: "document",
  sequence: [
    {
      id: documentVersions.AddName,
      up: (document2) => {
        ;
        document2.name = "";
      },
      down: (document2) => {
        delete document2.name;
      }
    },
    {
      id: documentVersions.AddMeta,
      up: (record) => {
        ;
        record.meta = {};
      }
    }
  ]
});
var DocumentRecordType = createRecordType("document", {
  validator: documentValidator,
  scope: "document"
}).withDefaultProperties(
  () => ({
    gridSize: 10,
    name: "",
    meta: {}
  })
);
var TLDOCUMENT_ID = DocumentRecordType.createId("document");

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLBookmarkShape.mjs
var bookmarkShapeProps = {
  w: validation_exports.nonZeroNumber,
  h: validation_exports.nonZeroNumber,
  assetId: assetIdValidator.nullable(),
  url: validation_exports.linkUrl
};
var Versions4 = createShapePropsMigrationIds("bookmark", {
  NullAssetId: 1,
  MakeUrlsValid: 2
});
var bookmarkShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: Versions4.NullAssetId,
      up: (props) => {
        if (props.assetId === void 0) {
          props.assetId = null;
        }
      },
      down: "retired"
    },
    {
      id: Versions4.MakeUrlsValid,
      up: (props) => {
        if (!validation_exports.linkUrl.isValid(props.url)) {
          props.url = "";
        }
      },
      down: (_props) => {
      }
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/misc/b64Vecs.mjs
var FIRST_POINT_B64_LENGTH = 16;
var FIRST_POINT_2D_B64_LENGTH = 12;
var DEFAULT_PRESSURE = 0.5;
var DIM_2D = 2;
var DIM_3D = 3;
var BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i;
}
var SIX_BIT_MASK = 63;
var PADDING_CHAR_CODE = "=".charCodeAt(0);
var POW2 = new Float64Array(31);
for (let i = 0; i < 31; i++) {
  POW2[i] = Math.pow(2, i - 15);
}
var POW2_SUBNORMAL = Math.pow(2, -14) / 1024;
var MANTISSA = new Float64Array(1024);
for (let i = 0; i < 1024; i++) {
  MANTISSA[i] = 1 + i / 1024;
}
function nativeGetFloat16(dataView, offset) {
  return dataView.getFloat16(offset, true);
}
function fallbackGetFloat16(dataView, offset) {
  return float16BitsToNumber(dataView.getUint16(offset, true));
}
var getFloat16 = typeof DataView.prototype.getFloat16 === "function" ? nativeGetFloat16 : fallbackGetFloat16;
function nativeSetFloat16(dataView, offset, value) {
  ;
  dataView.setFloat16(offset, value, true);
}
function fallbackSetFloat16(dataView, offset, value) {
  dataView.setUint16(offset, numberToFloat16Bits(value), true);
}
var setFloat16 = typeof DataView.prototype.setFloat16 === "function" ? nativeSetFloat16 : fallbackSetFloat16;
function nativeBase64ToUint8Array(base64) {
  return Uint8Array.fromBase64(base64);
}
function fallbackBase64ToUint8Array(base64) {
  const paddedLength = base64.length;
  let padding = 0;
  if (paddedLength > 0 && base64.charCodeAt(paddedLength - 1) === PADDING_CHAR_CODE) {
    padding++;
    if (paddedLength > 1 && base64.charCodeAt(paddedLength - 2) === PADDING_CHAR_CODE) {
      padding++;
    }
  }
  const numBytes = Math.floor(paddedLength * 3 / 4) - padding;
  const bytes = new Uint8Array(numBytes);
  let byteIndex = 0;
  const fullGroups = Math.floor((paddedLength - padding) / 4) * 4;
  for (let i = 0; i < fullGroups; i += 4) {
    const c0 = B64_LOOKUP[base64.charCodeAt(i)];
    const c1 = B64_LOOKUP[base64.charCodeAt(i + 1)];
    const c2 = B64_LOOKUP[base64.charCodeAt(i + 2)];
    const c3 = B64_LOOKUP[base64.charCodeAt(i + 3)];
    const bitmap = c0 << 18 | c1 << 12 | c2 << 6 | c3;
    bytes[byteIndex++] = bitmap >> 16 & 255;
    bytes[byteIndex++] = bitmap >> 8 & 255;
    bytes[byteIndex++] = bitmap & 255;
  }
  if (padding === 1) {
    const c0 = B64_LOOKUP[base64.charCodeAt(fullGroups)];
    const c1 = B64_LOOKUP[base64.charCodeAt(fullGroups + 1)];
    const c2 = B64_LOOKUP[base64.charCodeAt(fullGroups + 2)];
    const bitmap = c0 << 18 | c1 << 12 | c2 << 6;
    bytes[byteIndex++] = bitmap >> 16 & 255;
    bytes[byteIndex++] = bitmap >> 8 & 255;
  } else if (padding === 2) {
    const c0 = B64_LOOKUP[base64.charCodeAt(fullGroups)];
    const c1 = B64_LOOKUP[base64.charCodeAt(fullGroups + 1)];
    const bitmap = c0 << 18 | c1 << 12;
    bytes[byteIndex++] = bitmap >> 16 & 255;
  }
  return bytes;
}
function nativeUint8ArrayToBase64(uint8Array) {
  return uint8Array.toBase64();
}
function fallbackUint8ArrayToBase64(uint8Array) {
  const len = uint8Array.length;
  const fullGroups = Math.floor(len / 3) * 3;
  let result = "";
  for (let i = 0; i < fullGroups; i += 3) {
    const byte1 = uint8Array[i];
    const byte2 = uint8Array[i + 1];
    const byte3 = uint8Array[i + 2];
    const bitmap = byte1 << 16 | byte2 << 8 | byte3;
    result += BASE64_CHARS[bitmap >> 18 & SIX_BIT_MASK] + // bits 23–18 (top sextet)
    BASE64_CHARS[bitmap >> 12 & SIX_BIT_MASK] + // bits 17–12
    BASE64_CHARS[bitmap >> 6 & SIX_BIT_MASK] + // bits 11–6
    BASE64_CHARS[bitmap & SIX_BIT_MASK];
  }
  const remaining = len - fullGroups;
  if (remaining === 1) {
    const bitmap = uint8Array[fullGroups] << 16;
    result += BASE64_CHARS[bitmap >> 18 & SIX_BIT_MASK] + BASE64_CHARS[bitmap >> 12 & SIX_BIT_MASK] + "==";
  } else if (remaining === 2) {
    const bitmap = uint8Array[fullGroups] << 16 | uint8Array[fullGroups + 1] << 8;
    result += BASE64_CHARS[bitmap >> 18 & SIX_BIT_MASK] + BASE64_CHARS[bitmap >> 12 & SIX_BIT_MASK] + BASE64_CHARS[bitmap >> 6 & SIX_BIT_MASK] + "=";
  }
  return result;
}
var uint8ArrayToBase64 = typeof Uint8Array.prototype.toBase64 === "function" ? nativeUint8ArrayToBase64 : fallbackUint8ArrayToBase64;
var base64ToUint8Array = typeof Uint8Array.fromBase64 === "function" ? nativeBase64ToUint8Array : fallbackBase64ToUint8Array;
function float16BitsToNumber(bits) {
  const sign = bits >> 15;
  const exp = bits >> 10 & 31;
  const frac = bits & 1023;
  if (exp === 0) {
    return sign ? -frac * POW2_SUBNORMAL : frac * POW2_SUBNORMAL;
  }
  if (exp === 31) {
    return frac ? NaN : sign ? -Infinity : Infinity;
  }
  const magnitude = POW2[exp] * MANTISSA[frac];
  return sign ? -magnitude : magnitude;
}
function numberToFloat16Bits(value) {
  if (value === 0) return Object.is(value, -0) ? 32768 : 0;
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return 32256;
    return value > 0 ? 31744 : 64512;
  }
  const sign = value < 0 ? 1 : 0;
  value = Math.abs(value);
  const exp = Math.floor(Math.log2(value));
  let expBiased = exp + 15;
  if (expBiased >= 31) {
    return sign << 15 | 31744;
  }
  if (expBiased <= 0) {
    const frac2 = Math.round(value * Math.pow(2, 14) * 1024);
    return sign << 15 | frac2 & 1023;
  }
  const mantissa = value / Math.pow(2, exp) - 1;
  let frac = Math.round(mantissa * 1024);
  if (frac >= 1024) {
    frac = 0;
    expBiased++;
    if (expBiased >= 31) {
      return sign << 15 | 31744;
    }
  }
  return sign << 15 | expBiased << 10 | frac;
}
var b64Vecs = class _b64Vecs {
  /**
   * Encode a single point (x, y, z) to 8 base64 characters using legacy Float16 encoding.
   * Each coordinate is encoded as a Float16 value, resulting in 6 bytes total.
   *
   * @param x - The x coordinate
   * @param y - The y coordinate
   * @param z - The z coordinate
   * @returns An 8-character base64 string representing the point
   * @internal
   */
  static _legacyEncodePoint(x, y, z) {
    const buffer = new Uint8Array(6);
    const dataView = new DataView(buffer.buffer);
    setFloat16(dataView, 0, x);
    setFloat16(dataView, 2, y);
    setFloat16(dataView, 4, z);
    return uint8ArrayToBase64(buffer);
  }
  /**
   * Convert an array of VecModels to a base64 string using legacy Float16 encoding.
   * Uses Float16 encoding for each coordinate (x, y, z). If a point's z value is
   * undefined, it defaults to 0.5.
   *
   * @param points - An array of VecModel objects to encode
   * @returns A base64-encoded string containing all points
   * @internal Used only for migrations from legacy format
   */
  static _legacyEncodePoints(points) {
    if (points.length === 0) return "";
    const buffer = new Uint8Array(points.length * 6);
    const dataView = new DataView(buffer.buffer);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const offset = i * 6;
      setFloat16(dataView, offset, p.x);
      setFloat16(dataView, offset + 2, p.y);
      setFloat16(dataView, offset + 4, p.z ?? 0.5);
    }
    return uint8ArrayToBase64(buffer);
  }
  /**
   * Convert a legacy base64 string back to an array of VecModels.
   * Decodes Float16-encoded coordinates (x, y, z) from the base64 string.
   *
   * @param base64 - The base64-encoded string containing point data
   * @returns An array of VecModel objects decoded from the string
   * @internal Used only for migrations from legacy format
   */
  static _legacyDecodePoints(base64) {
    const bytes = base64ToUint8Array(base64);
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = [];
    for (let offset = 0; offset < bytes.length; offset += 6) {
      result.push({
        x: getFloat16(dataView, offset),
        y: getFloat16(dataView, offset + 2),
        z: getFloat16(dataView, offset + 4)
      });
    }
    return result;
  }
  /**
   * Encode an array of VecModels using delta encoding for improved precision.
   * The first point is stored as Float32 (high precision for absolute position),
   * subsequent points are stored as Float16 deltas from the previous point.
   * This provides full precision for the starting position and excellent precision
   * for deltas between consecutive points (which are typically small values).
   *
   * Format:
   * - First point: 3 Float32 values = 12 bytes = 16 base64 chars
   * - Delta points: 3 Float16 values each = 6 bytes = 8 base64 chars each
   *
   * @param points - An array of VecModel objects to encode
   * @param dim - Encoding dimension; `2` routes through the 2D variant (drops z), `3` (default) keeps x, y, z
   * @returns A base64-encoded string containing delta-encoded points
   * @public
   */
  static encodePoints(points, dim) {
    if (dim === DIM_2D) return _b64Vecs.encodePoints2D(points);
    if (points.length === 0) return "";
    const firstPointBytes = 12;
    const deltaBytes = (points.length - 1) * 6;
    const totalBytes = firstPointBytes + deltaBytes;
    const buffer = new Uint8Array(totalBytes);
    const dataView = new DataView(buffer.buffer);
    const first = points[0];
    dataView.setFloat32(0, first.x, true);
    dataView.setFloat32(4, first.y, true);
    dataView.setFloat32(8, first.z ?? 0.5, true);
    let prevX = first.x;
    let prevY = first.y;
    let prevZ = first.z ?? 0.5;
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      const z = p.z ?? 0.5;
      const offset = firstPointBytes + (i - 1) * 6;
      setFloat16(dataView, offset, p.x - prevX);
      setFloat16(dataView, offset + 2, p.y - prevY);
      setFloat16(dataView, offset + 4, z - prevZ);
      prevX = p.x;
      prevY = p.y;
      prevZ = z;
    }
    return uint8ArrayToBase64(buffer);
  }
  /**
   * Decode a delta-encoded base64 string back to an array of absolute VecModels.
   * The first point is stored as Float32 (high precision), subsequent points are
   * Float16 deltas that are accumulated to reconstruct absolute positions.
   *
   * @param base64 - The base64-encoded string containing delta-encoded point data
   * @param dim - Encoding dimension; `2` expects x/y only (z supplied as 0.5), `3` (default) expects x/y/z
   * @returns An array of VecModel objects with absolute coordinates
   * @public
   */
  static decodePoints(base64, dim) {
    if (dim === DIM_2D) return _b64Vecs.decodePoints2D(base64);
    if (base64.length === 0) return [];
    const bytes = base64ToUint8Array(base64);
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = [];
    let x = dataView.getFloat32(0, true);
    let y = dataView.getFloat32(4, true);
    let z = dataView.getFloat32(8, true);
    result.push({ x, y, z });
    const firstPointBytes = 12;
    for (let offset = firstPointBytes; offset < bytes.length; offset += 6) {
      x += getFloat16(dataView, offset);
      y += getFloat16(dataView, offset + 2);
      z += getFloat16(dataView, offset + 4);
      result.push({ x, y, z });
    }
    return result;
  }
  /**
   * Get the first point from a delta-encoded base64 string.
   * The first point is stored as Float32 for full precision.
   *
   * @param b64Points - The delta-encoded base64 string
   * @param dim - Encoding dimension; `2` expects x/y only (z supplied as 0.5), `3` (default) expects x/y/z
   * @returns The first point as a VecModel, or null if the string is too short
   * @public
   */
  static decodeFirstPoint(b64Points, dim) {
    if (dim === DIM_2D) return _b64Vecs.decodeFirstPoint2D(b64Points);
    if (b64Points.length < FIRST_POINT_B64_LENGTH) return null;
    const bytes = base64ToUint8Array(b64Points.slice(0, FIRST_POINT_B64_LENGTH));
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      x: dataView.getFloat32(0, true),
      y: dataView.getFloat32(4, true),
      z: dataView.getFloat32(8, true)
    };
  }
  /**
   * Get the last point from a delta-encoded base64 string.
   * Requires decoding all points to accumulate deltas.
   *
   * @param b64Points - The delta-encoded base64 string
   * @param dim - Encoding dimension; `2` expects x/y only (z supplied as 0.5), `3` (default) expects x/y/z
   * @returns The last point as a VecModel, or null if the string is too short
   * @public
   */
  static decodeLastPoint(b64Points, dim) {
    if (dim === DIM_2D) return _b64Vecs.decodeLastPoint2D(b64Points);
    if (b64Points.length < FIRST_POINT_B64_LENGTH) return null;
    const bytes = base64ToUint8Array(b64Points);
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let x = dataView.getFloat32(0, true);
    let y = dataView.getFloat32(4, true);
    let z = dataView.getFloat32(8, true);
    const firstPointBytes = 12;
    for (let offset = firstPointBytes; offset < bytes.length; offset += 6) {
      x += getFloat16(dataView, offset);
      y += getFloat16(dataView, offset + 2);
      z += getFloat16(dataView, offset + 4);
    }
    return { x, y, z };
  }
  /**
   * Encode an array of VecModels as 2D delta-encoded points, dropping z entirely.
   * Use for draw shapes from devices that don't report pressure, where z is a
   * constant 0.5 and storing it wastes ~33% of per-point bytes.
   *
   * Format:
   * - First point: 2 Float32 values (x, y) = 8 bytes
   * - Delta points: 2 Float16 values (dx, dy) = 4 bytes each
   *
   * @param points - An array of VecModel objects to encode (z is discarded)
   * @returns A base64-encoded string containing 2D delta-encoded points
   * @public
   */
  static encodePoints2D(points) {
    if (points.length === 0) return "";
    const firstPointBytes = 8;
    const deltaBytes = (points.length - 1) * 4;
    const buffer = new Uint8Array(firstPointBytes + deltaBytes);
    const dataView = new DataView(buffer.buffer);
    const first = points[0];
    dataView.setFloat32(0, first.x, true);
    dataView.setFloat32(4, first.y, true);
    let prevX = first.x;
    let prevY = first.y;
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      const offset = firstPointBytes + (i - 1) * 4;
      setFloat16(dataView, offset, p.x - prevX);
      setFloat16(dataView, offset + 2, p.y - prevY);
      prevX = p.x;
      prevY = p.y;
    }
    return uint8ArrayToBase64(buffer);
  }
  /**
   * Decode a 2D delta-encoded base64 string back to an array of absolute VecModels.
   * The z coordinate is always set to 0.5 (the default pressure value) so downstream
   * consumers don't need a separate code path.
   *
   * @param base64 - The base64-encoded string containing 2D delta-encoded point data
   * @returns An array of VecModel objects with absolute (x, y) and z = 0.5
   * @public
   */
  static decodePoints2D(base64) {
    if (base64.length === 0) return [];
    const bytes = base64ToUint8Array(base64);
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = [];
    let x = dataView.getFloat32(0, true);
    let y = dataView.getFloat32(4, true);
    result.push({ x, y, z: DEFAULT_PRESSURE });
    const firstPointBytes = 8;
    for (let offset = firstPointBytes; offset < bytes.length; offset += 4) {
      x += getFloat16(dataView, offset);
      y += getFloat16(dataView, offset + 2);
      result.push({ x, y, z: DEFAULT_PRESSURE });
    }
    return result;
  }
  /**
   * Get the first point from a 2D delta-encoded base64 string.
   *
   * @param b64Points - The 2D delta-encoded base64 string
   * @returns The first point with z = 0.5, or null if the string is too short
   * @public
   */
  static decodeFirstPoint2D(b64Points) {
    if (b64Points.length < FIRST_POINT_2D_B64_LENGTH) return null;
    const bytes = base64ToUint8Array(b64Points.slice(0, FIRST_POINT_2D_B64_LENGTH));
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      x: dataView.getFloat32(0, true),
      y: dataView.getFloat32(4, true),
      z: DEFAULT_PRESSURE
    };
  }
  /**
   * Get the last point from a 2D delta-encoded base64 string.
   * Requires decoding all points to accumulate deltas.
   *
   * @param b64Points - The 2D delta-encoded base64 string
   * @returns The last point with z = 0.5, or null if the string is too short
   * @public
   */
  static decodeLastPoint2D(b64Points) {
    if (b64Points.length < FIRST_POINT_2D_B64_LENGTH) return null;
    const bytes = base64ToUint8Array(b64Points);
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let x = dataView.getFloat32(0, true);
    let y = dataView.getFloat32(4, true);
    const firstPointBytes = 8;
    for (let offset = firstPointBytes; offset < bytes.length; offset += 4) {
      x += getFloat16(dataView, offset);
      y += getFloat16(dataView, offset + 2);
    }
    return { x, y, z: DEFAULT_PRESSURE };
  }
  /**
   * Whether an encoded path contains only a single point (a "dot"), inferred from
   * the encoded length without decoding — cheap enough for the render path.
   *
   * The single-point length depends on the encoding dimension, so this takes the
   * segment's `dim`: a one-point path is `FIRST_POINT_B64_LENGTH` chars (3D) or
   * `FIRST_POINT_2D_B64_LENGTH` chars (2D). Keeping this beside the layout constants
   * is deliberate — it is the single source of truth for "how long is one point", so
   * callers never hard-code a length threshold (which silently breaks when a new
   * encoding is added).
   *
   * @param b64Points - The encoded path string
   * @param dim - Encoding dimension; `2` for (x, y), `3` (default) for (x, y, z)
   * @returns true if the path encodes exactly one point
   * @public
   */
  static isSinglePoint(b64Points, dim) {
    return b64Points.length <= (dim === DIM_2D ? FIRST_POINT_2D_B64_LENGTH : FIRST_POINT_B64_LENGTH);
  }
};

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLDrawShape.mjs
var DrawShapeSegment = validation_exports.object({
  type: validation_exports.literalEnum("free", "straight"),
  path: validation_exports.string,
  dim: validation_exports.literalEnum(DIM_2D, DIM_3D).optional()
});
var drawShapeProps = {
  color: DefaultColorStyle,
  fill: DefaultFillStyle,
  dash: DefaultDashStyle,
  size: DefaultSizeStyle,
  segments: validation_exports.arrayOf(DrawShapeSegment),
  isComplete: validation_exports.boolean,
  isClosed: validation_exports.boolean,
  isPen: validation_exports.boolean,
  scale: validation_exports.nonZeroNumber,
  scaleX: validation_exports.nonZeroFiniteNumber,
  scaleY: validation_exports.nonZeroFiniteNumber
};
var Versions5 = createShapePropsMigrationIds("draw", {
  AddInPen: 1,
  AddScale: 2,
  Base64: 3,
  LegacyPointsConversion: 4,
  OmitNonPressureZ: 5
});
var drawShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: Versions5.AddInPen,
      up: (props) => {
        const { points } = props.segments[0];
        if (points.length === 0) {
          props.isPen = false;
          return;
        }
        let isPen = !(points[0].z === 0 || points[0].z === 0.5);
        if (points[1]) {
          isPen = isPen && !(points[1].z === 0 || points[1].z === 0.5);
        }
        props.isPen = isPen;
      },
      down: "retired"
    },
    {
      id: Versions5.AddScale,
      up: (props) => {
        props.scale = 1;
      },
      down: (props) => {
        delete props.scale;
      }
    },
    {
      id: Versions5.Base64,
      up: (props) => {
        props.segments = props.segments.map((segment) => {
          if (segment.path !== void 0) return segment;
          const { points, ...rest } = segment;
          const vecModels = Array.isArray(points) ? points : b64Vecs._legacyDecodePoints(points);
          return {
            ...rest,
            path: b64Vecs.encodePoints(vecModels)
          };
        });
        props.scaleX = props.scaleX ?? 1;
        props.scaleY = props.scaleY ?? 1;
      },
      down: (props) => {
        props.segments = props.segments.map((segment) => {
          const { path, ...rest } = segment;
          return {
            ...rest,
            points: b64Vecs.decodePoints(path)
          };
        });
        delete props.scaleX;
        delete props.scaleY;
      }
    },
    {
      id: Versions5.LegacyPointsConversion,
      up: (props) => {
        props.segments = props.segments.map((segment) => {
          if (segment.path !== void 0) return segment;
          const { points, ...rest } = segment;
          const vecModels = Array.isArray(points) ? points : b64Vecs._legacyDecodePoints(points);
          return {
            ...rest,
            path: b64Vecs.encodePoints(vecModels)
          };
        });
      },
      down: (_props) => {
      }
    },
    {
      id: Versions5.OmitNonPressureZ,
      up: (_props) => {
      },
      down: (props) => {
        props.segments = props.segments.map((segment) => {
          if (segment.dim === void 0) return segment;
          const { dim, ...rest } = segment;
          return dim === DIM_2D ? { ...rest, path: b64Vecs.encodePoints(b64Vecs.decodePoints(segment.path, DIM_2D)) } : rest;
        });
      }
    }
  ]
});
function compressLegacySegments(segments) {
  return segments.map((segment) => ({
    type: segment.type,
    path: b64Vecs.encodePoints(segment.points)
  }));
}

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLEmbedShape.mjs
var TLDRAW_APP_RE = /(^\/r\/[^/]+\/?$)/;
var EMBED_DEFINITIONS = [
  {
    hostnames: ["beta.tldraw.com", "tldraw.com", "localhost:3000"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      if (urlObj && urlObj.pathname.match(TLDRAW_APP_RE)) {
        return url;
      }
      return;
    }
  },
  {
    hostnames: ["figma.com"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      if (urlObj && urlObj.pathname.match(/^\/embed\/?$/)) {
        const outUrl = urlObj.searchParams.get("url");
        if (outUrl) {
          return outUrl;
        }
      }
      return;
    }
  },
  {
    hostnames: ["google.*"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      if (!urlObj) return;
      const matches = urlObj.pathname.match(/^\/maps\/embed\/v1\/view\/?$/);
      if (matches && urlObj.searchParams.has("center") && urlObj.searchParams.get("zoom")) {
        const zoom = urlObj.searchParams.get("zoom");
        const [lat, lon] = urlObj.searchParams.get("center").split(",");
        return `https://www.google.com/maps/@${lat},${lon},${zoom}z`;
      }
      return;
    }
  },
  {
    hostnames: ["val.town"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      const matches = urlObj && urlObj.pathname.match(/\/embed\/(.+)\/?/);
      if (matches) {
        return `https://www.val.town/v/${matches[1]}`;
      }
      return;
    }
  },
  {
    hostnames: ["codesandbox.io"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      const matches = urlObj && urlObj.pathname.match(/\/embed\/([^/]+)\/?/);
      if (matches) {
        return `https://codesandbox.io/s/${matches[1]}`;
      }
      return;
    }
  },
  {
    hostnames: ["codepen.io"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const CODEPEN_EMBED_REGEXP = /https:\/\/codepen.io\/([^/]+)\/embed\/([^/]+)/;
      const matches = url.match(CODEPEN_EMBED_REGEXP);
      if (matches) {
        const [_, user, id] = matches;
        return `https://codepen.io/${user}/pen/${id}`;
      }
      return;
    }
  },
  {
    hostnames: ["scratch.mit.edu"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const SCRATCH_EMBED_REGEXP = /https:\/\/scratch.mit.edu\/projects\/embed\/([^/]+)/;
      const matches = url.match(SCRATCH_EMBED_REGEXP);
      if (matches) {
        const [_, id] = matches;
        return `https://scratch.mit.edu/projects/${id}`;
      }
      return;
    }
  },
  {
    hostnames: ["*.youtube.com", "youtube.com", "youtu.be"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      if (!urlObj) return;
      const hostname = urlObj.hostname.replace(/^www./, "");
      if (hostname === "youtube.com") {
        const matches = urlObj.pathname.match(/^\/embed\/([^/]+)\/?/);
        if (matches) {
          return `https://www.youtube.com/watch?v=${matches[1]}`;
        }
      }
      return;
    }
  },
  {
    hostnames: ["calendar.google.*"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      const srcQs = urlObj?.searchParams.get("src");
      if (urlObj?.pathname.match(/\/calendar\/embed/) && srcQs) {
        urlObj.pathname = "/calendar/u/0";
        const keys = Array.from(urlObj.searchParams.keys());
        for (const key of keys) {
          urlObj.searchParams.delete(key);
        }
        urlObj.searchParams.set("cid", srcQs);
        return urlObj.href;
      }
      return;
    }
  },
  {
    hostnames: ["docs.google.*"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      if (urlObj?.pathname.match(/^\/presentation/) && urlObj?.pathname.match(/\/embed\/?$/)) {
        urlObj.pathname = urlObj.pathname.replace(/\/embed$/, "/pub");
        const keys = Array.from(urlObj.searchParams.keys());
        for (const key of keys) {
          urlObj.searchParams.delete(key);
        }
        return urlObj.href;
      }
      return;
    }
  },
  {
    hostnames: ["gist.github.com"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      if (urlObj && urlObj.pathname.match(/\/([^/]+)\/([^/]+)/)) {
        if (!url.split("/").pop()) return;
        return url;
      }
      return;
    }
  },
  {
    hostnames: ["replit.com"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      if (urlObj && urlObj.pathname.match(/\/@([^/]+)\/([^/]+)/) && urlObj.searchParams.has("embed")) {
        urlObj.searchParams.delete("embed");
        return urlObj.href;
      }
      return;
    }
  },
  {
    hostnames: ["felt.com"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      if (urlObj && urlObj.pathname.match(/^\/embed\/map\//)) {
        urlObj.pathname = urlObj.pathname.replace(/^\/embed/, "");
        return urlObj.href;
      }
      return;
    }
  },
  {
    hostnames: ["open.spotify.com"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      if (urlObj && urlObj.pathname.match(/^\/embed\/(artist|album)\//)) {
        return urlObj.origin + urlObj.pathname.replace(/^\/embed/, "");
      }
      return;
    }
  },
  {
    hostnames: ["vimeo.com", "player.vimeo.com"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      if (urlObj && urlObj.hostname === "player.vimeo.com") {
        const matches = urlObj.pathname.match(/^\/video\/([^/]+)\/?$/);
        if (matches) {
          return "https://vimeo.com/" + matches[1];
        }
      }
      return;
    }
  },
  {
    hostnames: ["observablehq.com"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      if (urlObj && urlObj.pathname.match(/^\/embed\/@([^/]+)\/([^/]+)\/?$/)) {
        return `${urlObj.origin}${urlObj.pathname.replace("/embed", "")}#cell-*`;
      }
      if (urlObj && urlObj.pathname.match(/^\/embed\/([^/]+)\/?$/)) {
        return `${urlObj.origin}${urlObj.pathname.replace("/embed", "/d")}#cell-*`;
      }
      return;
    }
  },
  {
    hostnames: ["desmos.com"],
    canEditWhileLocked: true,
    fromEmbedUrl: (url) => {
      const urlObj = safeParseUrl(url);
      if (urlObj && urlObj.hostname === "www.desmos.com" && urlObj.pathname.match(/^\/calculator\/([^/]+)\/?$/) && urlObj.search === "?embed" && urlObj.hash === "") {
        return url.replace("?embed", "");
      }
      return;
    }
  }
];
var embedShapeProps = {
  w: validation_exports.nonZeroNumber,
  h: validation_exports.nonZeroNumber,
  url: validation_exports.string
};
var Versions6 = createShapePropsMigrationIds("embed", {
  GenOriginalUrlInEmbed: 1,
  RemoveDoesResize: 2,
  RemoveTmpOldUrl: 3,
  RemovePermissionOverrides: 4
});
var embedShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: Versions6.GenOriginalUrlInEmbed,
      // add tmpOldUrl property
      up: (props) => {
        try {
          const url = props.url;
          const host = new URL(url).host.replace("www.", "");
          let originalUrl;
          for (const localEmbedDef of EMBED_DEFINITIONS) {
            if (localEmbedDef.hostnames.includes(host)) {
              try {
                originalUrl = localEmbedDef.fromEmbedUrl(url);
              } catch (err) {
                console.warn(err);
              }
            }
          }
          props.tmpOldUrl = props.url;
          props.url = originalUrl ?? "";
        } catch {
          props.url = "";
          props.tmpOldUrl = props.url;
        }
      },
      down: "retired"
    },
    {
      id: Versions6.RemoveDoesResize,
      up: (props) => {
        delete props.doesResize;
      },
      down: "retired"
    },
    {
      id: Versions6.RemoveTmpOldUrl,
      up: (props) => {
        delete props.tmpOldUrl;
      },
      down: "retired"
    },
    {
      id: Versions6.RemovePermissionOverrides,
      up: (props) => {
        delete props.overridePermissions;
      },
      down: "retired"
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLFrameShape.mjs
var frameShapeProps = {
  w: validation_exports.nonZeroNumber,
  h: validation_exports.nonZeroNumber,
  name: validation_exports.string,
  // because shape colors are an option, we don't want them to be picked up by the editor as a
  // style prop by default, so instead of a proper style we just supply an equivalent validator.
  // Check `FrameShapeUtil.configure` for how we replace this with the original
  // `DefaultColorStyle` style when the option is turned on.
  // We delegate to DefaultColorStyle.validate so custom colors from themes are
  // picked up automatically.
  color: { validate: (v) => DefaultColorStyle.validate(v) }
};
var Versions7 = createShapePropsMigrationIds("frame", {
  AddColorProp: 1
});
var frameShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: Versions7.AddColorProp,
      up: (props) => {
        props.color = "black";
      },
      down: (props) => {
        delete props.color;
      }
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/styles/TLHorizontalAlignStyle.mjs
var DefaultHorizontalAlignStyle = StyleProp.defineEnum("tldraw:horizontalAlign", {
  defaultValue: "middle",
  values: ["start", "middle", "end", "start-legacy", "end-legacy", "middle-legacy"]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/styles/TLVerticalAlignStyle.mjs
var DefaultVerticalAlignStyle = StyleProp.defineEnum("tldraw:verticalAlign", {
  defaultValue: "middle",
  values: ["start", "middle", "end"]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLGeoShape.mjs
var GeoShapeGeoStyle = StyleProp.defineEnum("tldraw:geo", {
  defaultValue: "rectangle",
  values: [
    "cloud",
    "rectangle",
    "ellipse",
    "triangle",
    "diamond",
    "pentagon",
    "hexagon",
    "octagon",
    "star",
    "rhombus",
    "rhombus-2",
    "oval",
    "trapezoid",
    "arrow-right",
    "arrow-left",
    "arrow-up",
    "arrow-down",
    "x-box",
    "check-box",
    "heart"
  ]
});
var geoShapeProps = {
  geo: GeoShapeGeoStyle,
  dash: DefaultDashStyle,
  url: validation_exports.linkUrl,
  w: validation_exports.nonZeroNumber,
  h: validation_exports.nonZeroNumber,
  growY: validation_exports.positiveNumber,
  scale: validation_exports.nonZeroNumber,
  flipX: validation_exports.boolean,
  flipY: validation_exports.boolean,
  // Text properties
  labelColor: DefaultLabelColorStyle,
  color: DefaultColorStyle,
  fill: DefaultFillStyle,
  size: DefaultSizeStyle,
  font: DefaultFontStyle,
  align: DefaultHorizontalAlignStyle,
  verticalAlign: DefaultVerticalAlignStyle,
  richText: richTextValidator
};
var geoShapeVersions = createShapePropsMigrationIds("geo", {
  AddUrlProp: 1,
  AddLabelColor: 2,
  RemoveJustify: 3,
  AddCheckBox: 4,
  AddVerticalAlign: 5,
  MigrateLegacyAlign: 6,
  AddCloud: 7,
  MakeUrlsValid: 8,
  AddScale: 9,
  AddRichText: 10,
  AddRichTextAttrs: 11,
  AddFlipProps: 12
});
var geoShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: geoShapeVersions.AddUrlProp,
      up: (props) => {
        props.url = "";
      },
      down: "retired"
    },
    {
      id: geoShapeVersions.AddLabelColor,
      up: (props) => {
        props.labelColor = "black";
      },
      down: "retired"
    },
    {
      id: geoShapeVersions.RemoveJustify,
      up: (props) => {
        if (props.align === "justify") {
          props.align = "start";
        }
      },
      down: "retired"
    },
    {
      id: geoShapeVersions.AddCheckBox,
      up: (_props) => {
      },
      down: "retired"
    },
    {
      id: geoShapeVersions.AddVerticalAlign,
      up: (props) => {
        props.verticalAlign = "middle";
      },
      down: "retired"
    },
    {
      id: geoShapeVersions.MigrateLegacyAlign,
      up: (props) => {
        let newAlign;
        switch (props.align) {
          case "start":
            newAlign = "start-legacy";
            break;
          case "end":
            newAlign = "end-legacy";
            break;
          default:
            newAlign = "middle-legacy";
            break;
        }
        props.align = newAlign;
      },
      down: "retired"
    },
    {
      id: geoShapeVersions.AddCloud,
      up: (_props) => {
      },
      down: "retired"
    },
    {
      id: geoShapeVersions.MakeUrlsValid,
      up: (props) => {
        if (!validation_exports.linkUrl.isValid(props.url)) {
          props.url = "";
        }
      },
      down: (_props) => {
      }
    },
    {
      id: geoShapeVersions.AddScale,
      up: (props) => {
        props.scale = 1;
      },
      down: (props) => {
        delete props.scale;
      }
    },
    {
      id: geoShapeVersions.AddRichText,
      up: (props) => {
        props.richText = toRichText(props.text);
        delete props.text;
      }
      // N.B. Explicitly no down state so that we force clients to update.
      // down: (props) => {
      // 	delete props.richText
      // },
    },
    {
      id: geoShapeVersions.AddRichTextAttrs,
      up: (_props) => {
      },
      down: (props) => {
        if (props.richText && "attrs" in props.richText) {
          delete props.richText.attrs;
        }
      }
    },
    {
      id: geoShapeVersions.AddFlipProps,
      up: (props) => {
        props.flipX = false;
        props.flipY = false;
      },
      down: (props) => {
        delete props.flipX;
        delete props.flipY;
      }
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLGroupShape.mjs
var groupShapeProps = {};
var groupShapeMigrations = createShapePropsMigrationSequence({ sequence: [] });

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLHighlightShape.mjs
var highlightShapeProps = {
  color: DefaultColorStyle,
  size: DefaultSizeStyle,
  segments: validation_exports.arrayOf(DrawShapeSegment),
  isComplete: validation_exports.boolean,
  isPen: validation_exports.boolean,
  scale: validation_exports.nonZeroNumber,
  scaleX: validation_exports.nonZeroFiniteNumber,
  scaleY: validation_exports.nonZeroFiniteNumber
};
var Versions8 = createShapePropsMigrationIds("highlight", {
  AddScale: 1,
  Base64: 2,
  LegacyPointsConversion: 3,
  OmitNonPressureZ: 4
});
var highlightShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: Versions8.AddScale,
      up: (props) => {
        props.scale = 1;
      },
      down: (props) => {
        delete props.scale;
      }
    },
    {
      id: Versions8.Base64,
      up: (props) => {
        props.segments = props.segments.map((segment) => {
          if (segment.path !== void 0) return segment;
          const { points, ...rest } = segment;
          const vecModels = Array.isArray(points) ? points : b64Vecs._legacyDecodePoints(points);
          return {
            ...rest,
            path: b64Vecs.encodePoints(vecModels)
          };
        });
        props.scaleX = props.scaleX ?? 1;
        props.scaleY = props.scaleY ?? 1;
      },
      down: (props) => {
        props.segments = props.segments.map((segment) => {
          const { path, ...rest } = segment;
          return {
            ...rest,
            points: b64Vecs.decodePoints(path)
          };
        });
        delete props.scaleX;
        delete props.scaleY;
      }
    },
    {
      id: Versions8.LegacyPointsConversion,
      up: (props) => {
        props.segments = props.segments.map((segment) => {
          if (segment.path !== void 0) return segment;
          const { points, ...rest } = segment;
          const vecModels = Array.isArray(points) ? points : b64Vecs._legacyDecodePoints(points);
          return {
            ...rest,
            path: b64Vecs.encodePoints(vecModels)
          };
        });
      },
      down: (_props) => {
      }
    },
    {
      id: Versions8.OmitNonPressureZ,
      up: (_props) => {
      },
      down: (props) => {
        props.segments = props.segments.map((segment) => {
          if (segment.dim === void 0) return segment;
          const { dim, ...rest } = segment;
          return dim === DIM_2D ? { ...rest, path: b64Vecs.encodePoints(b64Vecs.decodePoints(segment.path, DIM_2D)) } : rest;
        });
      }
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLImageShape.mjs
var ImageShapeCrop = validation_exports.object({
  topLeft: vecModelValidator,
  bottomRight: vecModelValidator,
  isCircle: validation_exports.boolean.optional()
});
var imageShapeProps = {
  w: validation_exports.nonZeroNumber,
  h: validation_exports.nonZeroNumber,
  playing: validation_exports.boolean,
  url: validation_exports.linkUrl,
  assetId: assetIdValidator.nullable(),
  crop: ImageShapeCrop.nullable(),
  flipX: validation_exports.boolean,
  flipY: validation_exports.boolean,
  altText: validation_exports.string
};
var Versions9 = createShapePropsMigrationIds("image", {
  AddUrlProp: 1,
  AddCropProp: 2,
  MakeUrlsValid: 3,
  AddFlipProps: 4,
  AddAltText: 5
});
var imageShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: Versions9.AddUrlProp,
      up: (props) => {
        props.url = "";
      },
      down: "retired"
    },
    {
      id: Versions9.AddCropProp,
      up: (props) => {
        props.crop = null;
      },
      down: (props) => {
        delete props.crop;
      }
    },
    {
      id: Versions9.MakeUrlsValid,
      up: (props) => {
        if (!validation_exports.linkUrl.isValid(props.url)) {
          props.url = "";
        }
      },
      down: (_props) => {
      }
    },
    {
      id: Versions9.AddFlipProps,
      up: (props) => {
        props.flipX = false;
        props.flipY = false;
      },
      down: (props) => {
        delete props.flipX;
        delete props.flipY;
      }
    },
    {
      id: Versions9.AddAltText,
      up: (props) => {
        props.altText = "";
      },
      down: (props) => {
        delete props.altText;
      }
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLLineShape.mjs
var LineShapeSplineStyle = StyleProp.defineEnum("tldraw:spline", {
  defaultValue: "line",
  values: ["cubic", "line"]
});
var lineShapePointValidator = validation_exports.object({
  id: validation_exports.string,
  index: validation_exports.indexKey,
  x: validation_exports.number,
  y: validation_exports.number
});
var lineShapeProps = {
  color: DefaultColorStyle,
  dash: DefaultDashStyle,
  size: DefaultSizeStyle,
  spline: LineShapeSplineStyle,
  points: validation_exports.dict(validation_exports.string, lineShapePointValidator),
  scale: validation_exports.nonZeroNumber
};
var lineShapeVersions = createShapePropsMigrationIds("line", {
  AddSnapHandles: 1,
  RemoveExtraHandleProps: 2,
  HandlesToPoints: 3,
  PointIndexIds: 4,
  AddScale: 5
});
var lineShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: lineShapeVersions.AddSnapHandles,
      up: (props) => {
        for (const handle of Object.values(props.handles)) {
          ;
          handle.canSnap = true;
        }
      },
      down: "retired"
    },
    {
      id: lineShapeVersions.RemoveExtraHandleProps,
      up: (props) => {
        props.handles = objectMapFromEntries(
          Object.values(props.handles).map((handle) => [
            handle.index,
            {
              x: handle.x,
              y: handle.y
            }
          ])
        );
      },
      down: (props) => {
        const handles = Object.entries(props.handles).map(([index, handle]) => ({ index, ...handle })).sort(sortByIndex);
        props.handles = Object.fromEntries(
          handles.map((handle, i) => {
            const id = i === 0 ? "start" : i === handles.length - 1 ? "end" : `handle:${handle.index}`;
            return [
              id,
              {
                id,
                type: "vertex",
                canBind: false,
                canSnap: true,
                index: handle.index,
                x: handle.x,
                y: handle.y
              }
            ];
          })
        );
      }
    },
    {
      id: lineShapeVersions.HandlesToPoints,
      up: (props) => {
        const sortedHandles = Object.entries(props.handles).map(([index, { x, y }]) => ({ x, y, index })).sort(sortByIndex);
        props.points = sortedHandles.map(({ x, y }) => ({ x, y }));
        delete props.handles;
      },
      down: (props) => {
        const indices = getIndices(props.points.length);
        props.handles = Object.fromEntries(
          props.points.map((handle, i) => {
            const index = indices[i];
            return [
              index,
              {
                x: handle.x,
                y: handle.y
              }
            ];
          })
        );
        delete props.points;
      }
    },
    {
      id: lineShapeVersions.PointIndexIds,
      up: (props) => {
        const indices = getIndices(props.points.length);
        props.points = Object.fromEntries(
          props.points.map((point, i) => {
            const id = indices[i];
            return [
              id,
              {
                id,
                index: id,
                x: point.x,
                y: point.y
              }
            ];
          })
        );
      },
      down: (props) => {
        const sortedHandles = Object.values(props.points).sort(sortByIndex);
        props.points = sortedHandles.map(({ x, y }) => ({ x, y }));
      }
    },
    {
      id: lineShapeVersions.AddScale,
      up: (props) => {
        props.scale = 1;
      },
      down: (props) => {
        delete props.scale;
      }
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLNoteShape.mjs
var noteShapeProps = {
  color: DefaultColorStyle,
  labelColor: DefaultLabelColorStyle,
  size: DefaultSizeStyle,
  font: DefaultFontStyle,
  fontSizeAdjustment: validation_exports.positiveNumber.nullable(),
  align: DefaultHorizontalAlignStyle,
  verticalAlign: DefaultVerticalAlignStyle,
  growY: validation_exports.positiveNumber,
  url: validation_exports.linkUrl,
  richText: richTextValidator,
  scale: validation_exports.nonZeroNumber,
  textLastEditedBy: validation_exports.string.nullable()
};
var Versions10 = createShapePropsMigrationIds("note", {
  AddUrlProp: 1,
  RemoveJustify: 2,
  MigrateLegacyAlign: 3,
  AddVerticalAlign: 4,
  MakeUrlsValid: 5,
  AddFontSizeAdjustment: 6,
  AddScale: 7,
  AddLabelColor: 8,
  AddRichText: 9,
  AddRichTextAttrs: 10,
  AddFirstEditedBy: 11,
  MakeFontSizeAdjustmentRatio: 12,
  RenameFirstEditedByToLast: 13
});
var noteShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: Versions10.AddUrlProp,
      up: (props) => {
        props.url = "";
      },
      down: "retired"
    },
    {
      id: Versions10.RemoveJustify,
      up: (props) => {
        if (props.align === "justify") {
          props.align = "start";
        }
      },
      down: "retired"
    },
    {
      id: Versions10.MigrateLegacyAlign,
      up: (props) => {
        switch (props.align) {
          case "start":
            props.align = "start-legacy";
            return;
          case "end":
            props.align = "end-legacy";
            return;
          default:
            props.align = "middle-legacy";
            return;
        }
      },
      down: "retired"
    },
    {
      id: Versions10.AddVerticalAlign,
      up: (props) => {
        props.verticalAlign = "middle";
      },
      down: "retired"
    },
    {
      id: Versions10.MakeUrlsValid,
      up: (props) => {
        if (!validation_exports.linkUrl.isValid(props.url)) {
          props.url = "";
        }
      },
      down: (_props) => {
      }
    },
    {
      id: Versions10.AddFontSizeAdjustment,
      up: (props) => {
        props.fontSizeAdjustment = 0;
      },
      down: (props) => {
        delete props.fontSizeAdjustment;
      }
    },
    {
      id: Versions10.AddScale,
      up: (props) => {
        props.scale = 1;
      },
      down: (props) => {
        delete props.scale;
      }
    },
    {
      id: Versions10.AddLabelColor,
      up: (props) => {
        props.labelColor = "black";
      },
      down: (props) => {
        delete props.labelColor;
      }
    },
    {
      id: Versions10.AddRichText,
      up: (props) => {
        props.richText = toRichText(props.text);
        delete props.text;
      }
      // N.B. Explicitly no down state so that we force clients to update.
      // down: (props) => {
      // 	delete props.richText
      // },
    },
    {
      id: Versions10.AddRichTextAttrs,
      up: (_props) => {
      },
      down: (props) => {
        if (props.richText && "attrs" in props.richText) {
          delete props.richText.attrs;
        }
      }
    },
    {
      id: Versions10.AddFirstEditedBy,
      up: (props) => {
        props.textFirstEditedBy = null;
      },
      down: (props) => {
        delete props.textFirstEditedBy;
      }
    },
    {
      id: Versions10.MakeFontSizeAdjustmentRatio,
      up: (props) => {
        props.fontSizeAdjustment = props.fontSizeAdjustment === 0 ? 1 : null;
      },
      down: (props) => {
        props.fontSizeAdjustment = 0;
      }
    },
    {
      id: Versions10.RenameFirstEditedByToLast,
      up: (props) => {
        props.textLastEditedBy = props.textFirstEditedBy ?? null;
        delete props.textFirstEditedBy;
      },
      down: (props) => {
        props.textFirstEditedBy = props.textLastEditedBy ?? null;
        delete props.textLastEditedBy;
      }
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/styles/TLTextAlignStyle.mjs
var DefaultTextAlignStyle = StyleProp.defineEnum("tldraw:textAlign", {
  defaultValue: "start",
  values: ["start", "middle", "end"]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLTextShape.mjs
var textShapeProps = {
  color: DefaultColorStyle,
  size: DefaultSizeStyle,
  font: DefaultFontStyle,
  textAlign: DefaultTextAlignStyle,
  w: validation_exports.nonZeroNumber,
  richText: richTextValidator,
  scale: validation_exports.nonZeroNumber,
  autoSize: validation_exports.boolean
};
var Versions11 = createShapePropsMigrationIds("text", {
  RemoveJustify: 1,
  AddTextAlign: 2,
  AddRichText: 3,
  AddRichTextAttrs: 4
});
var textShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: Versions11.RemoveJustify,
      up: (props) => {
        if (props.align === "justify") {
          props.align = "start";
        }
      },
      down: "retired"
    },
    {
      id: Versions11.AddTextAlign,
      up: (props) => {
        props.textAlign = props.align;
        delete props.align;
      },
      down: (props) => {
        props.align = props.textAlign;
        delete props.textAlign;
      }
    },
    {
      id: Versions11.AddRichText,
      up: (props) => {
        props.richText = toRichText(props.text);
        delete props.text;
      }
      // N.B. Explicitly no down state so that we force clients to update.
      // down: (props) => {
      // 	delete props.richText
      // },
    },
    {
      id: Versions11.AddRichTextAttrs,
      up: (_props) => {
      },
      down: (props) => {
        if (props.richText && "attrs" in props.richText) {
          delete props.richText.attrs;
        }
      }
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/shapes/TLVideoShape.mjs
var videoShapeProps = {
  w: validation_exports.nonZeroNumber,
  h: validation_exports.nonZeroNumber,
  time: validation_exports.number,
  playing: validation_exports.boolean,
  autoplay: validation_exports.boolean,
  url: validation_exports.linkUrl,
  assetId: assetIdValidator.nullable(),
  altText: validation_exports.string
};
var Versions12 = createShapePropsMigrationIds("video", {
  AddUrlProp: 1,
  MakeUrlsValid: 2,
  AddAltText: 3,
  AddAutoplay: 4
});
var videoShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: Versions12.AddUrlProp,
      up: (props) => {
        props.url = "";
      },
      down: "retired"
    },
    {
      id: Versions12.MakeUrlsValid,
      up: (props) => {
        if (!validation_exports.linkUrl.isValid(props.url)) {
          props.url = "";
        }
      },
      down: (_props) => {
      }
    },
    {
      id: Versions12.AddAltText,
      up: (props) => {
        props.altText = "";
      },
      down: (props) => {
        delete props.altText;
      }
    },
    {
      id: Versions12.AddAutoplay,
      up: (props) => {
        props.autoplay = true;
      },
      down: (props) => {
        delete props.autoplay;
      }
    }
  ]
});

// ../../node_modules/@tldraw/tlschema/dist-esm/store-migrations.mjs
var Versions13 = createMigrationIds("com.tldraw.store", {
  RemoveCodeAndIconShapeTypes: 1,
  AddInstancePresenceType: 2,
  RemoveTLUserAndPresenceAndAddPointer: 3,
  RemoveUserDocument: 4,
  FixIndexKeys: 5
});
var storeMigrations = createMigrationSequence({
  sequenceId: "com.tldraw.store",
  retroactive: false,
  sequence: [
    {
      id: Versions13.RemoveCodeAndIconShapeTypes,
      scope: "storage",
      up: (storage) => {
        for (const [id, record] of storage.entries()) {
          if (record.typeName === "shape" && "type" in record && (record.type === "icon" || record.type === "code")) {
            storage.delete(id);
          }
        }
      }
    },
    {
      id: Versions13.AddInstancePresenceType,
      scope: "storage",
      up(_storage) {
      }
    },
    {
      // remove user and presence records and add pointer records
      id: Versions13.RemoveTLUserAndPresenceAndAddPointer,
      scope: "storage",
      up: (storage) => {
        for (const [id, record] of storage.entries()) {
          if (record.typeName.match(/^(user|user_presence)$/)) {
            storage.delete(id);
          }
        }
      }
    },
    {
      // remove user document records
      id: Versions13.RemoveUserDocument,
      scope: "storage",
      up: (storage) => {
        for (const [id, record] of storage.entries()) {
          if (record.typeName.match("user_document")) {
            storage.delete(id);
          }
        }
      }
    },
    {
      id: Versions13.FixIndexKeys,
      scope: "record",
      up: (record) => {
        if (["shape", "page"].includes(record.typeName) && "index" in record) {
          const recordWithIndex = record;
          if (recordWithIndex.index.endsWith("0") && recordWithIndex.index !== "a0") {
            recordWithIndex.index = recordWithIndex.index.slice(0, -1) + getNRandomBase62Digits(3);
          }
          if (record.typeName === "shape" && recordWithIndex.type === "line") {
            const lineShape = recordWithIndex;
            for (const [_, point] of objectMapEntries(lineShape.props.points)) {
              if (point.index.endsWith("0") && point.index !== "a0") {
                point.index = point.index.slice(0, -1) + getNRandomBase62Digits(3);
              }
            }
          }
        }
      },
      down: () => {
      }
    }
  ]
});
var BASE_62_DIGITS_WITHOUT_ZERO = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
var getRandomBase62Digit = () => {
  return BASE_62_DIGITS_WITHOUT_ZERO.charAt(
    Math.floor(Math.random() * BASE_62_DIGITS_WITHOUT_ZERO.length)
  );
};
var getNRandomBase62Digits = (n) => {
  return Array.from({ length: n }, getRandomBase62Digit).join("");
};

// ../../node_modules/@tldraw/tlschema/dist-esm/TLStore.mjs
function redactRecordForErrorReporting(record) {
  if (record.typeName === "asset") {
    if ("src" in record) {
      record.src = "<redacted>";
    }
    if ("src" in record.props) {
      record.props.src = "<redacted>";
    }
  }
}
function createCachedUserResolve(resolveFn) {
  const cache = /* @__PURE__ */ new Map();
  return (userId) => {
    let signal = cache.get(userId);
    if (!signal) {
      signal = computed("resolve-user-" + userId, () => resolveFn(userId));
      cache.set(userId, signal);
    }
    return signal;
  };
}
function onValidationFailure({
  error,
  phase,
  record,
  recordBefore
}) {
  const isExistingValidationIssue = (
    // if we're initializing the store for the first time, we should
    // allow invalid records so people can load old buggy data:
    phase === "initialize"
  );
  annotateError(error, {
    tags: {
      origin: "store.validateRecord",
      storePhase: phase,
      isExistingValidationIssue
    },
    extras: {
      recordBefore: recordBefore ? redactRecordForErrorReporting(structuredClone(recordBefore)) : void 0,
      recordAfter: redactRecordForErrorReporting(structuredClone(record))
    }
  });
  throw error;
}
function getDefaultPages() {
  return [
    PageRecordType.create({
      id: "page:page",
      name: "Page 1",
      index: "a1",
      meta: {}
    })
  ];
}
function createIntegrityChecker(store) {
  const $pageIds = store.query.ids("page");
  const $pageStates = store.query.records("instance_page_state");
  const ensureStoreIsUsable = () => {
    if (!store.has(TLDOCUMENT_ID)) {
      store.put([DocumentRecordType.create({ id: TLDOCUMENT_ID, name: store.props.defaultName })]);
      return ensureStoreIsUsable();
    }
    if (!store.has(TLPOINTER_ID)) {
      store.put([PointerRecordType.create({ id: TLPOINTER_ID })]);
      return ensureStoreIsUsable();
    }
    const pageIds = $pageIds.get();
    if (pageIds.size === 0) {
      store.put(getDefaultPages());
      return ensureStoreIsUsable();
    }
    const getFirstPageId = () => [...pageIds].map((id) => store.get(id)).sort(sortByIndex)[0].id;
    const instanceState = store.get(TLINSTANCE_ID);
    if (!instanceState) {
      store.put([
        store.schema.types.instance.create({
          id: TLINSTANCE_ID,
          currentPageId: getFirstPageId(),
          exportBackground: true
        })
      ]);
      return ensureStoreIsUsable();
    } else if (!pageIds.has(instanceState.currentPageId)) {
      store.put([{ ...instanceState, currentPageId: getFirstPageId() }]);
      return ensureStoreIsUsable();
    }
    const missingPageStateIds = /* @__PURE__ */ new Set();
    const missingCameraIds = /* @__PURE__ */ new Set();
    for (const id of pageIds) {
      const pageStateId = InstancePageStateRecordType.createId(id);
      const pageState = store.get(pageStateId);
      if (!pageState) {
        missingPageStateIds.add(pageStateId);
      }
      const cameraId = CameraRecordType.createId(id);
      if (!store.has(cameraId)) {
        missingCameraIds.add(cameraId);
      }
    }
    if (missingPageStateIds.size > 0) {
      store.put(
        [...missingPageStateIds].map(
          (id) => InstancePageStateRecordType.create({
            id,
            pageId: InstancePageStateRecordType.parseId(id)
          })
        )
      );
    }
    if (missingCameraIds.size > 0) {
      store.put([...missingCameraIds].map((id) => CameraRecordType.create({ id })));
    }
    const pageStates = $pageStates.get();
    for (const pageState of pageStates) {
      if (!pageIds.has(pageState.pageId)) {
        store.remove([pageState.id]);
        continue;
      }
      if (pageState.croppingShapeId && !store.has(pageState.croppingShapeId)) {
        store.put([{ ...pageState, croppingShapeId: null }]);
        return ensureStoreIsUsable();
      }
      if (pageState.focusedGroupId && !store.has(pageState.focusedGroupId)) {
        store.put([{ ...pageState, focusedGroupId: null }]);
        return ensureStoreIsUsable();
      }
      if (pageState.hoveredShapeId && !store.has(pageState.hoveredShapeId)) {
        store.put([{ ...pageState, hoveredShapeId: null }]);
        return ensureStoreIsUsable();
      }
      const filteredSelectedIds = pageState.selectedShapeIds.filter((id) => store.has(id));
      if (filteredSelectedIds.length !== pageState.selectedShapeIds.length) {
        store.put([{ ...pageState, selectedShapeIds: filteredSelectedIds }]);
        return ensureStoreIsUsable();
      }
      const filteredHintingIds = pageState.hintingShapeIds.filter((id) => store.has(id));
      if (filteredHintingIds.length !== pageState.hintingShapeIds.length) {
        store.put([{ ...pageState, hintingShapeIds: filteredHintingIds }]);
        return ensureStoreIsUsable();
      }
      const filteredErasingIds = pageState.erasingShapeIds.filter((id) => store.has(id));
      if (filteredErasingIds.length !== pageState.erasingShapeIds.length) {
        store.put([{ ...pageState, erasingShapeIds: filteredErasingIds }]);
        return ensureStoreIsUsable();
      }
    }
  };
  return ensureStoreIsUsable;
}

// ../../node_modules/@tldraw/tlschema/dist-esm/createTLSchema.mjs
var defaultShapeSchemas = {
  arrow: { migrations: arrowShapeMigrations, props: arrowShapeProps },
  bookmark: { migrations: bookmarkShapeMigrations, props: bookmarkShapeProps },
  draw: { migrations: drawShapeMigrations, props: drawShapeProps },
  embed: { migrations: embedShapeMigrations, props: embedShapeProps },
  frame: { migrations: frameShapeMigrations, props: frameShapeProps },
  geo: { migrations: geoShapeMigrations, props: geoShapeProps },
  group: { migrations: groupShapeMigrations, props: groupShapeProps },
  highlight: { migrations: highlightShapeMigrations, props: highlightShapeProps },
  image: { migrations: imageShapeMigrations, props: imageShapeProps },
  line: { migrations: lineShapeMigrations, props: lineShapeProps },
  note: { migrations: noteShapeMigrations, props: noteShapeProps },
  text: { migrations: textShapeMigrations, props: textShapeProps },
  video: { migrations: videoShapeMigrations, props: videoShapeProps }
};
var defaultBindingSchemas = {
  arrow: { migrations: arrowBindingMigrations, props: arrowBindingProps }
};
var defaultAssetSchemas = {
  image: { migrations: imageAssetMigrations, props: imageAssetProps },
  video: { migrations: videoAssetMigrations, props: videoAssetProps },
  bookmark: { migrations: bookmarkAssetMigrations, props: bookmarkAssetProps }
};
function createTLSchema({
  shapes = defaultShapeSchemas,
  bindings = defaultBindingSchemas,
  assets = defaultAssetSchemas,
  user,
  records = {},
  migrations
} = {}) {
  const stylesById = /* @__PURE__ */ new Map();
  for (const shape of objectMapValues(shapes)) {
    for (const style of getShapePropKeysByStyle(shape.props ?? {}).keys()) {
      if (stylesById.has(style.id) && stylesById.get(style.id) !== style) {
        throw new Error(`Multiple StyleProp instances with the same id: ${style.id}`);
      }
      stylesById.set(style.id, style);
    }
  }
  const ShapeRecordType = createShapeRecordType(shapes);
  const BindingRecordType = createBindingRecordType(bindings);
  const _AssetRecordType = createAssetRecordType(assets);
  const InstanceRecordType = createInstanceRecordType(stylesById);
  const CustomUserRecordType = user ? createUserRecordType(user) : UserRecordType;
  const builtInTypeNames = /* @__PURE__ */ new Set([
    "asset",
    "binding",
    "camera",
    "document",
    "instance",
    "instance_page_state",
    "page",
    "instance_presence",
    "pointer",
    "shape",
    "store",
    "user"
  ]);
  const customRecordTypes = {};
  for (const [typeName, config] of Object.entries(records)) {
    if (builtInTypeNames.has(typeName)) {
      throw new Error(
        `Custom record type name '${typeName}' conflicts with tldraw's built-in record type of that name. Choose a different name instead.`
      );
    }
    customRecordTypes[typeName] = createCustomRecordType(typeName, config);
  }
  return StoreSchema.create(
    {
      asset: _AssetRecordType,
      binding: BindingRecordType,
      camera: CameraRecordType,
      document: DocumentRecordType,
      instance: InstanceRecordType,
      instance_page_state: InstancePageStateRecordType,
      page: PageRecordType,
      instance_presence: InstancePresenceRecordType,
      pointer: PointerRecordType,
      shape: ShapeRecordType,
      user: CustomUserRecordType,
      ...customRecordTypes
    },
    {
      migrations: [
        storeMigrations,
        assetMigrations,
        cameraMigrations,
        documentMigrations,
        instanceMigrations,
        instancePageStateMigrations,
        pageMigrations,
        instancePresenceMigrations,
        pointerMigrations,
        rootShapeMigrations,
        userMigrations,
        ...processPropsMigrations("asset", assets),
        ...processPropsMigrations("shape", shapes),
        ...processPropsMigrations("binding", bindings),
        ...processCustomRecordMigrations(records),
        ...user?.migrations ?? [],
        ...migrations ?? []
      ],
      onValidationFailure,
      createIntegrityChecker
    }
  );
}

// ../../node_modules/@tldraw/tlschema/dist-esm/misc/TLHandle.mjs
var TL_HANDLE_TYPES = /* @__PURE__ */ new Set(["vertex", "virtual", "create", "clone"]);

// ../../node_modules/@tldraw/tlschema/dist-esm/records/TLComment.mjs
var emojiValidator = validation_exports.string.check((value) => {
  if (value.length === 0 || value.length > 64) {
    throw new validation_exports.ValidationError(`Expected an emoji of 1-64 characters, got ${value.length}`);
  }
});
var commentAnchorValidator = validation_exports.union("type", {
  shape: validation_exports.object({
    type: validation_exports.literal("shape"),
    shapeId: idValidator("shape"),
    x: validation_exports.number,
    y: validation_exports.number,
    isPrecise: validation_exports.boolean
  }),
  point: validation_exports.object({
    type: validation_exports.literal("point"),
    x: validation_exports.number,
    y: validation_exports.number
  }),
  region: validation_exports.object({
    type: validation_exports.literal("region"),
    x: validation_exports.number,
    y: validation_exports.number,
    w: validation_exports.number,
    h: validation_exports.number,
    pinX: validation_exports.number.optional(),
    pinY: validation_exports.number.optional()
  }),
  page: validation_exports.object({
    type: validation_exports.literal("page")
  })
});
function createCommentGuardMigrations(typeName, extra = []) {
  return createRecordMigrationSequence({
    sequenceId: `com.tldraw.${typeName}`,
    recordType: typeName,
    retroactive: true,
    sequence: [
      {
        id: `com.tldraw.${typeName}/1`,
        up: (record) => record
      },
      ...extra
    ]
  });
}
var commentThreadRecordConfig = {
  scope: "document",
  migrations: createCommentGuardMigrations("comment-thread", [
    {
      // Shape anchors gained normalized x/y + isPrecise; existing ones were imprecise (top-right).
      id: "com.tldraw.comment-thread/2",
      up: (record) => {
        const anchor = record.anchor;
        if (anchor?.type === "shape" && anchor.x === void 0) {
          ;
          record.anchor = { ...anchor, x: 1, y: 0, isPrecise: false };
        }
        return record;
      },
      down: (record) => {
        const anchor = record.anchor;
        if (anchor?.type === "shape") {
          ;
          record.anchor = { type: "shape", shapeId: anchor.shapeId };
        }
        return record;
      }
    },
    {
      // Region anchors gained an optional pin corner (where the creating drag released).
      id: "com.tldraw.comment-thread/3",
      up: (record) => record,
      down: (record) => {
        const anchor = record.anchor;
        if (anchor?.type === "region") {
          const { pinX: _pinX, pinY: _pinY, ...rest } = anchor;
          record.anchor = rest;
        }
        return record;
      }
    }
  ]),
  validator: validation_exports.object({
    id: idValidator("comment-thread"),
    typeName: validation_exports.literal("comment-thread"),
    pageId: idValidator("page"),
    anchor: commentAnchorValidator,
    createdBy: validation_exports.string,
    createdAt: validation_exports.number,
    resolved: validation_exports.object({ at: validation_exports.number, by: validation_exports.string }).nullable(),
    isDeleted: validation_exports.boolean,
    meta: validation_exports.jsonValue
  })
};
var commentRecordConfig = {
  scope: "document",
  migrations: createCommentGuardMigrations("comment"),
  validator: validation_exports.object({
    id: idValidator("comment"),
    typeName: validation_exports.literal("comment"),
    threadId: idValidator("comment-thread"),
    pageId: idValidator("page"),
    authorId: validation_exports.string,
    createdAt: validation_exports.number,
    editedAt: validation_exports.number.nullable(),
    body: richTextValidator,
    isDeleted: validation_exports.boolean,
    meta: validation_exports.jsonValue
  })
};
var commentReactionRecordConfig = {
  scope: "document",
  migrations: createCommentGuardMigrations("comment-reaction"),
  validator: validation_exports.object({
    id: idValidator("comment-reaction"),
    typeName: validation_exports.literal("comment-reaction"),
    commentId: idValidator("comment"),
    threadId: idValidator("comment-thread"),
    pageId: idValidator("page"),
    userId: validation_exports.string,
    emoji: emojiValidator,
    createdAt: validation_exports.number,
    meta: validation_exports.jsonValue
  })
};
var commentSchemaRecords = {
  "comment-thread": commentThreadRecordConfig,
  comment: commentRecordConfig,
  "comment-reaction": commentReactionRecordConfig
};
function createCommentThreadId(id) {
  return createCustomRecordId("comment-thread", id);
}
function createCommentId(id) {
  return createCustomRecordId("comment", id);
}
function createCommentReactionId(commentId, userId, emoji) {
  return createCustomRecordId(
    "comment-reaction",
    `${encodeURIComponent(commentId)}:${encodeURIComponent(userId)}:${encodeURIComponent(emoji)}`
  );
}
function isCommentThreadId(id) {
  return isCustomRecordId("comment-thread", id);
}
function isCommentId(id) {
  return isCustomRecordId("comment", id);
}
function isCommentReactionId(id) {
  return isCustomRecordId("comment-reaction", id);
}
function createCommentThread(props) {
  return {
    id: createCommentThreadId(),
    typeName: "comment-thread",
    pageId: props.pageId,
    anchor: props.anchor,
    createdBy: props.createdBy,
    createdAt: props.now ?? Date.now(),
    resolved: null,
    isDeleted: false,
    meta: props.meta ?? {}
  };
}
function createComment(props) {
  return {
    id: createCommentId(),
    typeName: "comment",
    threadId: props.threadId,
    pageId: props.pageId,
    authorId: props.authorId,
    createdAt: props.now ?? Date.now(),
    editedAt: null,
    body: props.body,
    isDeleted: false,
    meta: props.meta ?? {}
  };
}
function createCommentReaction(props) {
  return {
    id: createCommentReactionId(props.commentId, props.userId, props.emoji),
    typeName: "comment-reaction",
    commentId: props.commentId,
    threadId: props.threadId,
    pageId: props.pageId,
    userId: props.userId,
    emoji: props.emoji,
    createdAt: props.now ?? Date.now(),
    meta: props.meta ?? {}
  };
}

// ../../node_modules/@tldraw/tlschema/dist-esm/translations/languages.mjs
var LANGUAGES = [
  { locale: "id", label: "Bahasa Indonesia" },
  { locale: "ms", label: "Bahasa Melayu" },
  { locale: "ca", label: "Català" },
  { locale: "cs", label: "Čeština" },
  { locale: "da", label: "Danish" },
  { locale: "de", label: "Deutsch" },
  { locale: "en", label: "English" },
  { locale: "es", label: "Español" },
  { locale: "tl", label: "Filipino" },
  { locale: "fr", label: "Français" },
  { locale: "gl", label: "Galego" },
  { locale: "hr", label: "Hrvatski" },
  { locale: "it", label: "Italiano" },
  { locale: "hu", label: "Magyar" },
  { locale: "nl", label: "Nederlands" },
  { locale: "no", label: "Norwegian" },
  { locale: "pl", label: "Polski" },
  { locale: "pt-br", label: "Português - Brasil" },
  { locale: "pt-pt", label: "Português - Europeu" },
  { locale: "ro", label: "Română" },
  { locale: "sl", label: "Slovenščina" },
  { locale: "so", label: "Somali" },
  { locale: "fi", label: "Suomi" },
  { locale: "sv", label: "Svenska" },
  { locale: "vi", label: "Tiếng Việt" },
  { locale: "tr", label: "Türkçe" },
  { locale: "el", label: "Ελληνικά" },
  { locale: "ru", label: "Русский" },
  { locale: "uk", label: "Українська" },
  { locale: "he", label: "עברית" },
  { locale: "ur", label: "اردو" },
  { locale: "ar", label: "عربي" },
  { locale: "fa", label: "فارسی" },
  { locale: "ne", label: "नेपाली" },
  { locale: "mr", label: "मराठी" },
  { locale: "hi-in", label: "हिन्दी" },
  { locale: "bn", label: "বাংলা" },
  { locale: "pa", label: "ਪੰਜਾਬੀ" },
  { locale: "gu-in", label: "ગુજરાતી" },
  { locale: "ta", label: "தமிழ்" },
  { locale: "te", label: "తెలుగు" },
  { locale: "kn", label: "ಕನ್ನಡ" },
  { locale: "ml", label: "മലയാളം" },
  { locale: "th", label: "ภาษาไทย" },
  { locale: "km-kh", label: "ភាសាខ្មែរ" },
  { locale: "ko-kr", label: "한국어" },
  { locale: "ja", label: "日本語" },
  { locale: "zh-cn", label: "简体中文" },
  { locale: "zh-tw", label: "繁體中文 (台灣)" }
];

// ../../node_modules/@tldraw/tlschema/dist-esm/translations/translations.mjs
function getDefaultTranslationLocale() {
  const locales = typeof window !== "undefined" && window.navigator ? window.navigator.languages ?? ["en"] : ["en"];
  return _getDefaultTranslationLocale(locales);
}
function _getDefaultTranslationLocale(locales) {
  for (const locale of locales) {
    const supportedLocale = getSupportedLocale(locale);
    if (supportedLocale) {
      return supportedLocale;
    }
  }
  return "en";
}
var DEFAULT_LOCALE_REGIONS = {
  zh: "zh-cn",
  pt: "pt-br",
  ko: "ko-kr",
  hi: "hi-in"
};
function getSupportedLocale(locale) {
  const exactMatch = LANGUAGES.find((t) => t.locale === locale.toLowerCase());
  if (exactMatch) {
    return exactMatch.locale;
  }
  const [language, region] = locale.split(/[-_]/).map((s) => s.toLowerCase());
  if (region) {
    const languageMatch = LANGUAGES.find((t) => t.locale === language);
    if (languageMatch) {
      return languageMatch.locale;
    }
  }
  if (language in DEFAULT_LOCALE_REGIONS) {
    return DEFAULT_LOCALE_REGIONS[language];
  }
  return null;
}

// ../../node_modules/@tldraw/tlschema/dist-esm/index.mjs
registerTldrawLibraryVersion(
  "@tldraw/tlschema",
  "5.3.2",
  "esm"
);

export {
  registerTldrawLibraryVersion,
  rotateArray,
  dedupe,
  compact,
  last,
  minBy,
  maxBy,
  partition,
  areArraysShallowEqual,
  mergeArraysAndReplaceDefaults,
  omitFromStackTrace,
  noop,
  Result,
  exhaustiveSwitchError,
  assert,
  assertExists,
  promiseWithResolve,
  sleep,
  bind,
  WeakCache,
  debounce,
  annotateError,
  getErrorAnnotations,
  ExecutionQueue,
  fetch,
  Image,
  FileHelpers,
  getHashForString,
  getHashForObject,
  getHashForBuffer,
  lns,
  mockUniqueId,
  restoreUniqueId,
  uniqueId,
  getFirstFromIterable,
  LruCache,
  PngHelpers,
  DEFAULT_SUPPORTED_IMAGE_TYPES,
  DEFAULT_SUPPORT_VIDEO_TYPES,
  DEFAULT_SUPPORTED_MEDIA_TYPES,
  DEFAULT_SUPPORTED_MEDIA_TYPE_LIST,
  MediaHelpers,
  lerp,
  invLerp,
  rng,
  modulate,
  hasOwnProperty,
  getOwnProperty,
  objectMapKeys,
  objectMapValues,
  objectMapEntries,
  objectMapEntriesIterable,
  objectMapFromEntries,
  filterEntries,
  mapObjectMapValues,
  areObjectsShallowEqual,
  groupBy,
  omit,
  getChangedKeys,
  isEqualAllowingForFloatingPointErrors,
  measureCbDuration,
  measureDuration,
  measureAverageDuration,
  PerformanceTracker,
  ZERO_INDEX_KEY,
  validateIndexKey,
  getIndicesBetween,
  getIndicesAbove,
  getIndicesBelow,
  getIndexBetween,
  getIndexAbove,
  getIndexBelow,
  getIndices,
  sortByIndex,
  sortByMaybeIndex,
  retry,
  sortById,
  getFromLocalStorage,
  setInLocalStorage,
  deleteFromLocalStorage,
  clearLocalStorage,
  getFromSessionStorage,
  setInSessionStorage,
  deleteFromSessionStorage,
  clearSessionStorage,
  getFirstCharacter,
  stringEnum,
  FpsScheduler,
  fpsThrottle,
  throttleToNextFrame,
  Timers,
  safeParseUrl,
  isDefined,
  isNonNull,
  isNonNullish,
  structuredClone,
  isNativeStructuredClone,
  STRUCTURED_CLONE_OBJECT_PROTOTYPE,
  warnDeprecatedGetter,
  warnOnce,
  import_lodash2 as import_lodash,
  import_lodash3 as import_lodash2,
  import_lodash4 as import_lodash3,
  import_lodash5 as import_lodash4,
  EMPTY_ARRAY,
  ArraySet,
  unsafe__withoutCapture,
  whyAmIRunning,
  RESET_VALUE,
  transaction,
  transact,
  deferAsyncEffects,
  atom,
  isAtom,
  UNINITIALIZED,
  isUninitialized,
  withDiff,
  getComputedInstance,
  computed,
  EffectScheduler,
  react,
  reactor,
  isSignal,
  localStorageAtom,
  AtomMap,
  AtomSet,
  devFreeze,
  IncrementalSetConstructor,
  createMigrationSequence,
  createMigrationIds,
  createRecordMigrationSequence,
  parseMigrationId,
  MigrationFailureReason,
  createEmptyRecordsDiff,
  reverseRecordsDiff,
  isRecordsDiffEmpty,
  squashRecordDiffs,
  squashRecordDiffsMutable,
  RecordType,
  createRecordType,
  assertIdType,
  StoreQueries,
  StoreSideEffects,
  Store,
  createComputedCache,
  StoreSchema,
  Validator,
  ArrayOfValidator,
  ObjectValidator,
  UnionValidator,
  DictValidator,
  validation_exports,
  idValidator,
  assetIdValidator,
  createAssetValidator,
  bookmarkAssetProps,
  bookmarkAssetMigrations,
  imageAssetProps,
  imageAssetMigrations,
  videoAssetProps,
  videoAssetMigrations,
  vecModelValidator,
  boxModelValidator,
  opacityValidator,
  parentIdValidator,
  shapeIdValidator,
  createShapeValidator,
  bindingIdValidator,
  createBindingValidator,
  rootBindingMigrations,
  isBinding,
  isBindingId,
  createBindingId,
  createBindingPropsMigrationSequence,
  createBindingPropsMigrationIds,
  richTextValidator,
  toRichText,
  StyleProp,
  EnumStyleProp,
  rootShapeMigrations,
  isShape,
  isShapeId,
  createShapeId,
  getShapePropKeysByStyle,
  createShapePropsMigrationSequence,
  createShapePropsMigrationIds,
  DefaultColorStyle,
  registerColorsFromThemes,
  DefaultDashStyle,
  DefaultFillStyle,
  DefaultFontStyle,
  DefaultFontFamilies,
  isFontEntry,
  registerFontsFromThemes,
  DefaultSizeStyle,
  ArrowShapeKindStyle,
  ArrowShapeArrowheadStartStyle,
  ArrowShapeArrowheadEndStyle,
  arrowShapeProps,
  arrowShapeVersions,
  arrowShapeMigrations,
  ElbowArrowSnap,
  arrowBindingProps,
  arrowBindingVersions,
  arrowBindingMigrations,
  CameraRecordType,
  TL_CURSOR_TYPES,
  TL_CANVAS_UI_COLOR_TYPES,
  canvasUiColorTypeValidator,
  TL_SCRIBBLE_STATES,
  scribbleValidator,
  pageIdValidator,
  PageRecordType,
  isPageId,
  userIdValidator,
  createUserRecordType,
  UserRecordType,
  isUserId,
  createUserId,
  pluckPreservingValues,
  TLINSTANCE_ID,
  InstancePageStateRecordType,
  PointerRecordType,
  TLPOINTER_ID,
  InstancePresenceRecordType,
  createPresenceStateDerivation,
  getDefaultUserPresence,
  assetMigrations,
  createAssetRecordType,
  AssetRecordType,
  createAssetPropsMigrationSequence,
  createAssetPropsMigrationIds,
  createCustomRecordMigrationIds,
  createCustomRecordMigrationSequence,
  createCustomRecordId,
  isCustomRecordId,
  isCustomRecord,
  isDocument,
  DocumentRecordType,
  TLDOCUMENT_ID,
  bookmarkShapeProps,
  bookmarkShapeMigrations,
  DIM_2D,
  DIM_3D,
  b64Vecs,
  drawShapeProps,
  drawShapeMigrations,
  compressLegacySegments,
  embedShapeProps,
  embedShapeMigrations,
  frameShapeProps,
  frameShapeMigrations,
  DefaultHorizontalAlignStyle,
  DefaultVerticalAlignStyle,
  GeoShapeGeoStyle,
  geoShapeProps,
  geoShapeMigrations,
  groupShapeProps,
  groupShapeMigrations,
  highlightShapeProps,
  highlightShapeMigrations,
  ImageShapeCrop,
  imageShapeProps,
  imageShapeMigrations,
  LineShapeSplineStyle,
  lineShapeProps,
  lineShapeMigrations,
  noteShapeProps,
  noteShapeMigrations,
  DefaultTextAlignStyle,
  textShapeProps,
  textShapeMigrations,
  videoShapeProps,
  videoShapeMigrations,
  createCachedUserResolve,
  defaultShapeSchemas,
  defaultBindingSchemas,
  defaultAssetSchemas,
  createTLSchema,
  TL_HANDLE_TYPES,
  commentThreadRecordConfig,
  commentRecordConfig,
  commentReactionRecordConfig,
  commentSchemaRecords,
  createCommentThreadId,
  createCommentId,
  createCommentReactionId,
  isCommentThreadId,
  isCommentId,
  isCommentReactionId,
  createCommentThread,
  createComment,
  createCommentReaction,
  LANGUAGES,
  getDefaultTranslationLocale
};
//# sourceMappingURL=chunk-SFEXDDGV.js.map
