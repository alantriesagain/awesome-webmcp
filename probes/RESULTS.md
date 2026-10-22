# Probe results (2026-10-12T20:34Z, scriptc 0.2.10)

## p0-fn-union: FAIL
- coverage rc=1 dynamic=''
- build rc=1; node rc=0; native rc=1; outputs equal=no
```
scriptc coverage /home/alanleal/Projects/writting-harness/probes/p0-fn-union.ts

  statements analyzed   13
  compile statically    10  (76%)

  blockers:
      ×2  SC2020  '(() => V) | ((e: B) => void).length' is part of the standard library types but has no scriptc lowering yet
          at probes/p0-fn-union.ts:16:47, probes/p0-fn-union.ts:25:36
          hint: the type checker sees the full standard library, but only the supported surface compiles (https://scriptc.dev/limitations)
      ×1  SC2003  union conversion has no unambiguous layout mapping: expected '(...)[] | () => ... | (B) => void | A | string', got '() => string' (each source arm needs an identical destination arm, a unique compati…
          at probes/p0-fn-union.ts:21:33
          hint: narrow the value to a SINGLE arm first (a discriminant check, or '!== undefined'/'!== null' for unit arms); a plain arm value widens into any union that contains it, and a whole union widens into any union whose arms include the source's
--- build
  16 |   if (typeof v === "function") return "fn:" + v.length;
     |                                               ^~~~~~~~
  17 |   if (Array.isArray(v)) return "[" + v.map((x) => show(x)).join(",") + "]";

  hint: the type checker sees the full standard library, but only the supported surface compiles (https://scriptc.dev/limitations)

/home/alanleal/Projects/writting-harness/probes/p0-fn-union.ts:21:33 - error SC2003: union conversion has no unambiguous layout mapping: expected '(...)[] | () => ... | (B) => void | A | string', got '() => string' (each source arm needs an identical destination arm, a unique compatible record/array layout, or a shared literal discriminant selecting compatible layouts)

  20 | 
  21 | const vs: V[] = ["x", new A(1), () => "y", (e: B) => { void e; }, ["z", new A(2), () => "q"]];
     |                                 ^~~~~~~~~
  22 | console.log(vs.map((v) => show(v)).join(" | "));

  hint: narrow the value to a SINGLE arm first (a discriminant check, or '!== undefined'/'!== null' for unit arms); a plain arm value widens into any union that contains it, and a whole union widens into any union whose arms include the source's

/home/alanleal/Projects/writting-harness/probes/p0-fn-union.ts:25:36 - error SC2020: '(() => V) | ((e: B) => void).length' is part of the standard library types but has no scriptc lowering yet

  24 | const thunk: V = () => "called";
  25 | if (typeof thunk === "function" && thunk.length === 0) {
     |                                    ^~~~~~~~~~~~
  26 |   const r = (thunk as () => V)();

  hint: the type checker sees the full standard library, but only the supported surface compiles (https://scriptc.dev/limitations)

3 errors.
--- node
s:x | A:1 | fn:0 | fn:1 | [s:z,A:2,fn:0]
call: s:called
--- native
(build failed)
```

## p10-value-shape: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p11-recursive-isolate: FAIL
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=no
```
scriptc coverage /home/alanleal/Projects/writting-harness/probes/p11-recursive-isolate.ts

  statements analyzed   14
  compile statically    14  (100%)

  fully static — this program has no dynamic remainder.
--- build
/home/alanleal/Projects/writting-harness/probes/out/p11-recursive-isolate
--- node
flat: [a,#1]
built: [a,[b,#2]]
literal: [a,[b,#3]]
--- native
flat: [a,[]]
built: [a,[b,[,]]]
literal: [a,[b,[,,]]]
```

## p12-values-with-lists: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p13-template-trap: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p14-template-steps: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p15-dispatch: FAIL
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=no
```
scriptc coverage /home/alanleal/Projects/writting-harness/probes/p15-dispatch.ts

  statements analyzed   2465
  compile statically    2465  (100%)

  fully static — this program has no dynamic remainder.
--- build
/home/alanleal/Projects/writting-harness/probes/out/p15-dispatch
--- node
template(1) keyed(k) mount(box) handler(key) live items(2) nullish nullish string prim
template(2)
--- native
items(134933790064896) items(111357393556128) items(111357393550448) items(111357393554048) items(134933790065488) items(2) nullish nullish string prim
items(134933790065728)
```

## p16-union-factors: FAIL
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=no
```
scriptc coverage /home/alanleal/Projects/writting-harness/probes/p16-union-factors.ts

  statements analyzed   2532
  compile statically    2532  (100%)

  fully static — this program has no dynamic remainder.
--- build
/home/alanleal/Projects/writting-harness/probes/out/p16-union-factors
--- node
U1 same-file: A,B,s,arr2
U2 imported: T,K,s,arr1
U3 subclass: Base,Base,A,s,arr1
U4 mountable: M:box,A,s,arr1
U5 fn-field class: Boxed:f,A,s,arr1
U6 handler: H:key,A,s,arr1
U7 local handler: LH:key,A,s
U8 many arms: 1,3,6,s,p,n,arr2
--- native
U1 same-file: arr1,arr2,s,arr2
U2 imported: arr124586567926400,arr105461710396640,s,arr1
U3 subclass: arr105461710392352,arr105461710392320,arr1,s,arr1
U4 mountable: arr105461710392384,arr1,s,arr1
U5 fn-field class: arr124586567926160,arr1,s,arr1
U6 handler: arr105461710394496,arr1,s,arr1
U7 local handler: arr105461710394496,arr1,s
U8 many arms: arr1,arr3,arr6,s,p,n,arr2
```

## p17-instanceof-array-arm: FAIL
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=no
```
scriptc coverage /home/alanleal/Projects/writting-harness/probes/p17-instanceof-array-arm.ts

  statements analyzed   35
  compile statically    35  (100%)

  fully static — this program has no dynamic remainder.
--- build
/home/alanleal/Projects/writting-harness/probes/out/p17-instanceof-array-arm
--- node
direct: A,B,s,arr
inline: A,B,s,arr
call:   A,B,s,arr
ternary: A,arr
--- native
direct: arr,arr,s,arr
inline: ?,?,s,arr
call:   A,B,s,arr
ternary: other,arr
```

## p18-stdin: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p1-recursive-union: FAIL
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=139; outputs equal=no
```
scriptc coverage /home/alanleal/Projects/writting-harness/probes/p1-recursive-union.ts

  statements analyzed   24
  compile statically    24  (100%)

  fully static — this program has no dynamic remainder.
--- build
/home/alanleal/Projects/writting-harness/probes/out/p1-recursive-union
--- node
["a",n1,T,null,undef,tpl#7,key(k1,["nested",tpl#8,[key(k2,n2)]])]
identity: true 9
--- native

```

## p22-tinput: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p23-tinput-bisect: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p28-base-bisect: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p29-field-shapes: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p2-signals-generics: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p31-editor-reach: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p3-state-union: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p4-template-cache: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p6-nullable-fn-field: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p7-json-width: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p8-runtime-bits: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

## p9-abstract-dispatch: FAIL
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=1; outputs equal=no
```
scriptc coverage /home/alanleal/Projects/writting-harness/probes/p9-abstract-dispatch.ts

  statements analyzed   35
  compile statically    35  (100%)

  fully static — this program has no dynamic remainder.
--- build
/home/alanleal/Projects/writting-harness/probes/out/p9-abstract-dispatch
--- node
[str:a live:L key:k node:<text>hi</text>@1 [node:<box><text>hi</text></box>@0 str:b]]
26:0,15:1,2:2
--- native
Uncaught RangeError: Invalid array length
```

## p5: PASS
- coverage rc=0 dynamic=''
- build rc=0; node rc=0; native rc=0; outputs equal=yes

