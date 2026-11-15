import { eachDayOf } from "./month.mjs";

const year = Number(process.argv[2]);
const month = Number(process.argv[3]);
for (const day of eachDayOf(year, month)) console.log(day);
