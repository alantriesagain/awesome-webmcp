// widecode --version: the build's version and time, then exit. The host never starts.
import { BUILD } from "../build.ts";

export const main = async (_argv: readonly string[]): Promise<number> => {
  console.log(BUILD);
  return 0;
};
