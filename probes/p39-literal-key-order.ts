// Object literals with the same set of keys share one layout natively, and JSON.stringify writes
// every one of them in the key order of the first: node writes each in its own order. Found when a
// test built two session records from literals with the same keys in different orders, and the
// second came out starting with "type" (which the session reader skips as bookkeeping).
const a = JSON.stringify({ type: "user", uuid: "u1", parentUuid: null });
const b = JSON.stringify({ parentUuid: null, type: "user", uuid: "v1" });
console.log(a);
console.log(b);
console.log(JSON.stringify({ k2: 2, k1: 1 }) + " " + JSON.stringify({ k1: 1, k2: 2 }));
