import * as yargs from "yargs";
import { run as getData } from "./get-data";
import { join } from "path";

const pkg = require(join(__dirname, "..", "package.json"));

const now = new Date();
const nowString = `${now.getMonth()}-${now.getDate()}-${now.getFullYear()}`;

const oneMonthAgo = new Date();
oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
const oneMonthAgoString = `${oneMonthAgo.getMonth()}-${oneMonthAgo.getDate()}-${oneMonthAgo.getFullYear()}`;

console.log(`\nMike\'s GitHub Activity Report v${pkg.version}\n`);

yargs
  .command("$0", "default command", yargs => {
    let {
      start,
      end,
      login,
      out: outDir,
      combine,
      token
    } = yargs.argv as yargs.Arguments<{
      start: string;
      end: string;
      out: string;
      combine: boolean;
      login: string;
      token: string;
    }>;
    if (token === "$GH_TOKEN") token = process.env.GH_TOKEN || "";
    if (!token)
      throw new Error(
        "Invalid github token. Please use the `-t` argument or GH_TOKEN environment variable"
      );
    const s = new Date(start);
    const e = new Date(end);
    getData(login, token, s, e, { outDir, combine });
    return yargs;
  })
  .option("start", {
    alias: "s",
    description: "Start date",
    default: oneMonthAgoString
  })
  .option("end", {
    alias: "e",
    description: "End date",
    default: nowString
  })
  .option("login", {
    alias: "l",
    description: "GitHub usernames, comma separated"
  })
  .option("out", {
    alias: "o",
    description: "output path",
    default: "out"
  })
  .option("combine", {
    description: "combine data into a single set of CSV output files"
  })
  .option("token", {
    alias: "t",
    description: "GitHub personal access token",
    default: "$GH_TOKEN"
  }).argv;
