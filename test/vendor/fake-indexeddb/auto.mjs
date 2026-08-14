import fakeIndexedDB from "./esm/fakeIndexedDB.js";
import FDBCursor from "./esm/FDBCursor.js";
import FDBCursorWithValue from "./esm/FDBCursorWithValue.js";
import FDBDatabase from "./esm/FDBDatabase.js";
import FDBFactory from "./esm/FDBFactory.js";
import FDBIndex from "./esm/FDBIndex.js";
import FDBKeyRange from "./esm/FDBKeyRange.js";
import FDBObjectStore from "./esm/FDBObjectStore.js";
import FDBOpenDBRequest from "./esm/FDBOpenDBRequest.js";
import FDBRecord from "./esm/FDBRecord.js";
import FDBRequest from "./esm/FDBRequest.js";
import FDBTransaction from "./esm/FDBTransaction.js";
import FDBVersionChangeEvent from "./esm/FDBVersionChangeEvent.js";

// http://stackoverflow.com/a/33268326/786644 - works in browser, worker, and Node.js
var globalVar =
    typeof window !== "undefined"
        ? window
        : typeof WorkerGlobalScope !== "undefined"
          ? self
          : typeof global !== "undefined"
            ? global
            : Function("return this;")();

// Partly match the native behavior for `globalThis.indexedDB`, `globalThis.IDBCursor`, etc.
// Per the IDL, `indexedDB` is readonly but the others are readwrite. For us, though, we want it to still
// be overwritable with `globalThis.<global> = ...`, so we make them all readwrite.
// https://w3c.github.io/IndexedDB/#idl-index
const createPropertyDescriptor = (value) => {
    return {
        value,
        enumerable: false,
        configurable: true,
        writable: true,
    };
};

Object.defineProperties(globalVar, {
    indexedDB: createPropertyDescriptor(fakeIndexedDB),
    IDBCursor: createPropertyDescriptor(FDBCursor),
    IDBCursorWithValue: createPropertyDescriptor(FDBCursorWithValue),
    IDBDatabase: createPropertyDescriptor(FDBDatabase),
    IDBFactory: createPropertyDescriptor(FDBFactory),
    IDBIndex: createPropertyDescriptor(FDBIndex),
    IDBKeyRange: createPropertyDescriptor(FDBKeyRange),
    IDBObjectStore: createPropertyDescriptor(FDBObjectStore),
    IDBOpenDBRequest: createPropertyDescriptor(FDBOpenDBRequest),
    IDBRecord: createPropertyDescriptor(FDBRecord),
    IDBRequest: createPropertyDescriptor(FDBRequest),
    IDBTransaction: createPropertyDescriptor(FDBTransaction),
    IDBVersionChangeEvent: createPropertyDescriptor(FDBVersionChangeEvent),
});
