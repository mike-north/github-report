# github-report

Generates CSVs for contribution data for one or more github users over a period of time

## Usage

```sh
npx @mike-north/github-report \
  --start 06-01-2019 \
  --end 07-01-2019 \
  --login mike-north,stefanpenner
  --token <GITHUB_TOKEN>
```

<img src="https://mike-north.github.io/github-report/usage.svg" />

### Options

```
Options:
  --help       Show help                                               [boolean]
  --version    Show version number                                     [boolean]
  --start, -s  Start date                             [default: <one month ago>]
  --end, -e    End date                                       [default: <today>]
  --login, -l  GitHub usernames, comma separated
  --out, -o    output path                                      [default: "out"]
  --combine    combine data into a single set of CSV output files
  --token, -t  GitHub personal access token               [default: "$GH_TOKEN"]
```

## Legal

&copy; 2019 LinkedIn
