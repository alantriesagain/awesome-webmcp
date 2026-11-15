// widecode's plugin API's JS side: the `widecode` global, built by @lightstart/plugins around the parts
// of the api (runtime/namespaces.ts: each namespace beside its answers), and the theme (theme.ts)
// as widecode.theme. widecode.d.ts types what it defines.
import { buildPrelude, namespacesOf } from "@lightstart/plugins/prelude.ts";
import { themeJson } from "../theme.ts";
import { PARTS } from "./namespaces.ts";

export const PRELUDE: string = buildPrelude("widecode", themeJson(), namespacesOf(PARTS));
