import * as yargs from "yargs";
import { run as getData } from "./get-data";
yargs
  .command("$0", "default command", yargs => {
    const { start, end, login } = yargs.argv as yargs.Arguments<{
      start: string;
      end: string;
      login: string;
    }>;
    const s = new Date(start);
    const e = new Date(end);
    console.log("args", login, new Date(start), new Date(end));
    getData(login, s, e);
    return yargs;
  })
  .option("start", {
    alias: "s"
  })
  .option("end", {
    alias: "e"
  })
  .option("login", {
    alias: "l"
  })
  .demandOption("l")
  .demandOption("s")
  .demandOption("e").argv;

console.log("starting");
