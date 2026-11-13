import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/load.mjs";
import { products } from "./products.mjs";
import { renderCatalog } from "./render.mjs";

const settings = loadConfig(fileURLToPath(new URL("../config.json", import.meta.url)));
for (const line of renderCatalog(products, settings)) console.log(line);
