import * as dotenv from "dotenv";
import * as graphql from "@octokit/graphql";
import * as Listr from "listr";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import * as csvStringify from "csv-stringify";
import { join } from "path";
import chalk from "chalk";

dotenv.config();

const BACKOFF_TIME_BASE = 20 * 1000; // 20s
const BACKOFF_TIME_VARIANCE = 3 * 1000; // 3s

function getBackoffTime(tries: number) {
  const coeff = tries * tries;
  const variance = Math.round(Math.random() * BACKOFF_TIME_VARIANCE);
  return (BACKOFF_TIME_BASE + variance) * coeff;
}

interface PageInfo {
  startCursor: string | null;
  endCursor: string | null;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

interface RecordPage<T extends object> {
  records: T[];
  totalCount: number;
  pageInfo: PageInfo;
}

interface RecordRetriever<T extends object> {
  (cursor: string | null): Promise<RecordPage<T>>;
}

namespace GQL {
  export interface RateLimitResponse {
    viewer: {
      login: string;
    };
    rateLimit: {
      limit: number;
      cost: number;
      remaining: number;
      resetAt: number;
    };
  }
  export interface Issue {
    url: string;
    title: string;
    createdAt: string;
    comments: {
      totalCount: number;
    };
    author: {
      login: string;
    };
    repository: {
      url: string;
      stargazers: {
        totalCount: number;
      };
      releases: {
        totalCount: number;
      };
      languages: {
        nodes: {
          name: string;
        }[];
      };
      name: string;
      owner: {
        login: string;
      };
    };
  }

  export interface RepoCreation {
    url: string;
    isFork: boolean;
    stargazers: {
      totalCount: number;
    };
    releases: {
      totalCount: number;
    };
    languages: {
      nodes: {
        name: string;
      }[];
    };
    name: string;
    owner: {
      login: string;
    };
  }

  export interface PullRequest extends Issue {
    additions: number;
    deletions: number;
    changedFiles: number;
    title: string;
    createdAt: string;
  }

  export interface PullRequestReview {
    createdAt: string;
    url: string;
    comments: {
      totalCount: number;
    };
    author: {
      login: string;
    };
    pullRequest: {
      title: string;
      url: string;
      additions: number;
      deletions: number;
      changedFiles: number;
      createdAt: string;
      author: {
        login: string;
      };
      repository: {
        url: string;
        stargazers: {
          totalCount: number;
        };
        releases: {
          totalCount: number;
        };
        languages: {
          nodes: {
            name: string;
          }[];
        };
        name: string;
        owner: {
          login: string;
        };
      };
    };
  }
}

async function gqlQuery(query: string, token: string): Promise<any> {
  return await graphql(query, {
    headers: {
      authorization: `token ${token}`
    }
  });
}

function timeout(n: number, tick?: number, tickFn?: (ms: number) => void) {
  const start = Date.now();
  let tickTask: ReturnType<typeof setInterval>;
  if (tick && tickFn) {
    tickTask = setInterval(() => {
      let elapsed = Date.now() - start;
      tickFn(elapsed);
    }, tick);
  }
  return new Promise(res => {
    setTimeout(() => {
      clearInterval(tickTask);
      res();
    }, n);
  });
}

async function getRateLimitInfo(
  token: string
): Promise<{ remaining: number; resetAt: Date }> {
  const resp: GQL.RateLimitResponse = await gqlQuery(
    `{
  viewer {
    login
  }
  rateLimit {
    limit
    cost
    remaining
    resetAt
  }
}`,
    token
  );
  const {
    rateLimit: { remaining, resetAt }
  } = resp;

  return {
    remaining,
    resetAt: new Date(resetAt)
  };
}

async function retrieveAll<T extends object>(
  recordRetriever: RecordRetriever<T>,
  recordName: string,
  task: Listr.ListrTaskWrapper,
  token: string,
  limitResetAt: Date
): Promise<T[]> {
  const allRecords: T[] = [];
  let result: RecordPage<T> = {
    records: [],
    totalCount: 0,
    pageInfo: {
      hasPreviousPage: false,
      startCursor: null,
      hasNextPage: true,
      endCursor: null
    }
  };
  function updateLog(specialMessage?: string) {
    task.title = [
      `${recordName}: ${allRecords.length}/${result.totalCount}`,
      specialMessage
    ]
      .filter(Boolean)
      .join(chalk.dim(" - "));
  }
  async function tryPull(limitResetTime: Date, tries = 1) {
    try {
      result = await recordRetriever(result.pageInfo.endCursor);
      const { records } = result;
      allRecords.push(...records);
      updateLog();
    } catch (err) {
      if (("" + err).indexOf("wait a few minutes")) {
        if (tries < 4) {
          // normal throttle
          const backoff = getBackoffTime(tries);
          await timeout(backoff, 100, n => {
            let elapsedStr = ((backoff - n) / 1000).toFixed(1).padStart(4, "0");

            updateLog(
              chalk.yellow(
                `triggered abuse detection; waiting ${chalk.bold.bgBlack.greenBright(
                  " " + elapsedStr + "s "
                )} before trying again ` + chalk.dim(`(try ${tries})`)
              )
            );
          });
          updateLog();
          await tryPull(limitResetTime, tries + 1);
        } else {
          // wait for full rate limit reset
          let waitTime =
            1000 + (limitResetTime.valueOf() - new Date().valueOf());
          await timeout(waitTime, 100, n => {
            let elapsedStr = ((waitTime - n) / 1000)
              .toFixed(1)
              .padStart(4, "0");

            updateLog(
              chalk.yellow(
                `waiting ${chalk.bold.bgBlack.greenBright(
                  " " + elapsedStr + "s "
                )} for full rate limit reset before trying again `
              )
            );
          });
          const newRateInfo = await getRateLimitInfo(token);
          tryPull(newRateInfo.resetAt, 1); // consider this a new "first try"
        }
      } else {
        throw err;
      }
    }
  }
  do {
    await tryPull(limitResetAt);
    if (result.pageInfo.hasNextPage) {
      await timeout(3000);
    }
  } while (result.pageInfo.hasNextPage);
  return allRecords;
}
const prRecordRetriever: (
  login: string,
  token: string,
  startDate: Date,
  endDate: Date
) => RecordRetriever<GQL.PullRequest> = (
  login: string,
  token: string,
  startDate: Date,
  endDate: Date
) =>
  async function getContributions(
    cursor = null
  ): Promise<RecordPage<GQL.PullRequest>> {
    const {
      user: {
        contributionsCollection: { pullRequestContributions }
      }
    } = await gqlQuery(
      `
      {
        user(login: "${login}") {
          contributionsCollection(from: "${startDate.toISOString()}", to: "${endDate.toISOString()}") {
            pullRequestContributions(first: 50${
              cursor ? ` after: "${cursor}"` : ""
            }) {
              totalCount
              pageInfo {
                startCursor
                endCursor
                hasNextPage
                hasPreviousPage
              }
              nodes {
                pullRequest {
                  comments {
                    totalCount
                  }
                  author { login }
                  url
                  additions
                  deletions
                  changedFiles
                  title
                  createdAt
                  repository {
                    url
                    stargazers {
                      totalCount
                    }
                    releases {
                      totalCount
                    }
                    languages(first:10) {
                      nodes {
                        name
                      }
                    }
                    name,
                    owner: owner {
                      login
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
      token
    );
    const { totalCount, nodes, pageInfo } = pullRequestContributions;
    let out = {
      totalCount,
      pageInfo,
      records: nodes.map((n: any) => n.pullRequest)
    };
    return out;
  };

const repoRecordRetriever: (
  login: string,
  token: string,
  startDate: Date,
  endDate: Date
) => RecordRetriever<GQL.RepoCreation> = (
  login: string,
  token: string,
  startDate: Date,
  endDate: Date
) =>
  async function getContributions(
    cursor = null
  ): Promise<RecordPage<GQL.RepoCreation>> {
    const {
      user: {
        contributionsCollection: { repositoryContributions }
      }
    } = await gqlQuery(
      `
      {
        user(login: "${login}") {
          contributionsCollection(from: "${startDate.toISOString()}", to: "${endDate.toISOString()}") {
            repositoryContributions(first: 50${
              cursor ? ` after: "${cursor}"` : ""
            }) {
              totalCount
              pageInfo {
                startCursor
                endCursor
                hasNextPage
                hasPreviousPage
              }
              nodes {
                repository {
                  url
                  isFork
                  stargazers {
                    totalCount
                  }
                  releases {
                    totalCount
                  }
                  languages(first:10) {
                    nodes {
                      name
                    }
                  }
                  name
                  owner: owner {
                    login
                  }
                }
              }
            }            
          }
        }
      }
    `,
      token
    );
    const { totalCount, nodes, pageInfo } = repositoryContributions;
    return {
      totalCount,
      pageInfo,
      records: nodes.map((n: any) => n.repository)
    };
  };

const issueRecordRetriever: (
  login: string,
  token: string,
  startDate: Date,
  endDate: Date
) => RecordRetriever<GQL.Issue> = (
  login: string,
  token: string,
  startDate: Date,
  endDate: Date
) =>
  async function getContributions(
    cursor = null
  ): Promise<RecordPage<GQL.Issue>> {
    const {
      user: {
        contributionsCollection: { issueContributions }
      }
    } = await gqlQuery(
      `
      {
        user(login: "${login}") {
          contributionsCollection(from: "${startDate.toISOString()}", to: "${endDate.toISOString()}") {
            issueContributions(first: 50${
              cursor ? ` after: "${cursor}"` : ""
            }) {
              totalCount
              pageInfo {
                startCursor
                endCursor
                hasNextPage
                hasPreviousPage
              }
              nodes {
                issue {
                  url
                  title
                  createdAt
                  comments {
                    totalCount
                  }
                  author { login }
                  repository {
                    url
                    stargazers {
                      totalCount
                    }
                    releases {
                      totalCount
                    }
                    languages(first:10) {
                      nodes {
                        name
                      }
                    }
                    name,
                    owner: owner {
                      login
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
      token
    );
    const { totalCount, nodes, pageInfo } = issueContributions;
    return {
      totalCount,
      pageInfo,
      records: nodes.map((n: any) => n.issue)
    };
  };
const codeReviewRecordRetriever: (
  login: string,
  token: string,
  startDate: Date,
  endDate: Date
) => RecordRetriever<GQL.PullRequestReview> = (
  login: string,
  token: string,
  startDate: Date,
  endDate: Date
) =>
  async function getContributions(
    cursor = null
  ): Promise<RecordPage<GQL.PullRequestReview>> {
    const {
      user: {
        contributionsCollection: { pullRequestReviewContributions }
      }
    } = await gqlQuery(
      `
      {
        user(login: "${login}") {
          contributionsCollection(from: "${startDate.toISOString()}", to: "${endDate.toISOString()}") {

            pullRequestReviewContributions(first: 50${
              cursor ? ` after: "${cursor}"` : ""
            }) {
              totalCount
              pageInfo {
                startCursor
                endCursor
                hasNextPage
                hasPreviousPage
              }
              nodes {          
                pullRequestReview {
                  createdAt
                  url
                  comments {
                    totalCount
                  }
                  author {
                    login
                  }
                  pullRequest {
                    title
                    url
                    additions
                    deletions
                    changedFiles
                    createdAt
                    author {
                      login
                    }
                    repository {
                      stargazers {
                        totalCount
                      }
                      releases {
                        totalCount
                      }
                      languages(first:10) {
                        nodes {
                          name
                        }
                      }
                      name,
                      url,
                      owner: owner {
                        login
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
      token
    );
    const { totalCount, nodes, pageInfo } = pullRequestReviewContributions;
    return {
      totalCount,
      pageInfo,
      records: nodes.map((n: any) => n.pullRequestReview)
    };
  };
async function getAllContributions(
  login: string,
  token: string,
  startDate: Date,
  endDate: Date
) {
  let pPullRequests!: Promise<GQL.PullRequest[]>;
  let pIssues!: Promise<GQL.Issue[]>;
  let pReviews!: Promise<GQL.PullRequestReview[]>;
  let pRepos!: Promise<GQL.RepoCreation[]>;

  let dataPromise!: Promise<any>;
  let limitResetTime: Date;
  const tasks = new Listr([
    {
      title: "Checking Rate Limit",
      task: async (_, task) => {
        async function attemptCheck() {
          try {
            await check();
          } catch (err) {
            await timeout(10000);
            await attemptCheck();
          }
        }
        async function check() {
          let isAlive = true;
          const rateLimitInfo = await getRateLimitInfo(token);
          if (!isAlive) return;
          task.title = `Checking rate limit: ${chalk.bold(
            "" + rateLimitInfo.remaining
          )} remaining, reset in ${chalk.bold(
            (
              (rateLimitInfo.resetAt.valueOf() - new Date().valueOf()) /
              (1000 * 60)
            ).toFixed(2) + " minutes"
          )}`;
          limitResetTime = rateLimitInfo.resetAt;
        }
        await attemptCheck();
      }
    },
    {
      title: "Retrieving data",
      task: async (context, retrieveTask) => {
        const p = new Listr(
          [
            {
              title: "Pull Requests 0/",
              task: (_, task) => {
                pPullRequests = retrieveAll(
                  prRecordRetriever(login, token, startDate, endDate),
                  "Pull Requests",
                  task,
                  token,
                  limitResetTime
                );
                return pPullRequests;
              }
            },
            {
              title: "Issues 0/",
              task: (_, task) => {
                pIssues = retrieveAll(
                  issueRecordRetriever(login, token, startDate, endDate),
                  "Issues",
                  task,
                  token,
                  limitResetTime
                );
                return pIssues;
              }
            },
            {
              title: "Code Reviews 0/",
              task: (_, task) => {
                pReviews = retrieveAll(
                  codeReviewRecordRetriever(login, token, startDate, endDate),
                  "Code Reviews",
                  task,
                  token,
                  limitResetTime
                );
                return pReviews;
              }
            },
            {
              title: "Repositories 0/",
              task: (_, task) => {
                pRepos = retrieveAll(
                  repoRecordRetriever(login, token, startDate, endDate),
                  "Repositories",
                  task,
                  token,
                  limitResetTime
                );
                return pRepos;
              }
            }
          ],
          { concurrent: true }
        );
        context.retrieveTask = retrieveTask;

        return p;
      }
    },
    {
      title: "Cleaning up",
      task: async context => {
        const [
          issues = [],
          repos = [],
          reviews = [],
          pullRequests = []
        ] = await dataPromise;

        context.retrieveTask.title = [
          `Retrieved data: `,
          [
            chalk.bold(`${chalk.cyanBright(pullRequests.length)} PRs`),
            chalk.bold(`${chalk.cyanBright(issues.length)} Issues`),
            chalk.bold(`${chalk.cyanBright(repos.length)} Repos created`),
            chalk.bold(`${chalk.cyanBright(reviews.length)} Code reviews`)
          ].join(", ")
        ].join("");
      }
    }
  ]);
  const run = tasks.run();
  await timeout(500);
  dataPromise = Promise.all([pIssues, pRepos, pReviews, pPullRequests]);
  await run;
  return {
    pullRequests: await pPullRequests,
    reviews: await pReviews,
    issues: await pIssues,
    repos: await pRepos
  };
}

interface NormalizedPullRequest extends NormalizedIssue {
  additions: number;
  deletions: number;
  changedFiles: number;
}
interface NormalizedRepoCreation {
  url: string;
  langs: string;
  name: string;
  owner: string;
  stars: number;
  isFork: boolean;
  releases: number;
}
interface NormalizedIssue {
  user: string;
  url: string;
  title: string;
  createdAt: string;
  commentCount: number;

  repoUrl: string;
  repoLangs: string;
  repoName: string;
  repoOwner: string;
  repoStars: number;
  repoReleases: number;
}
interface NormalizedPullRequestReview {
  user: string;
  createdAt: string;
  url: string;
  commentCount: number;
  prUrl: string;
  prAdditions: number;
  prTitle: string;
  prDeletions: number;
  prChangedFiles: number;
  prCreatedAt: string;
  prAuthor: string;
  prRepoStars: number;
  prRepoReleaseCount: number;
  prRepoLanguages: string;
  prRepoName: string;
  prRepoOwner: string;
  prRepoUrl: string;
}

function normalizePullRequest(pr: GQL.PullRequest): NormalizedPullRequest {
  const {
    url,
    author: { login: user } = { login: "unknown" },
    title,
    comments: { totalCount: commentCount },
    createdAt,
    additions,
    deletions,
    changedFiles,
    repository: {
      url: repoUrl,
      name: repoName,
      stargazers: { totalCount: repoStars },
      languages: langsArray,
      releases: { totalCount: repoReleases },
      owner: { login: repoOwner } = { login: "unknown" }
    }
  } = pr;
  return {
    user,
    url,
    title,
    commentCount,
    createdAt: new Date(createdAt).toDateString(),
    additions,
    deletions,
    changedFiles,
    repoStars,
    repoName,
    repoUrl,
    repoReleases,
    repoOwner,
    repoLangs: langsArray.nodes.map(l => l.name).join(", ")
  };
}
function normalizeRepoCreation(repo: GQL.RepoCreation): NormalizedRepoCreation {
  const {
    name,
    url,
    stargazers: { totalCount: stars },
    releases: { totalCount: releases },
    owner: { login: owner } = { login: "unknown" },
    languages: langsArray,
    isFork
  } = repo;
  return {
    name,
    url,
    stars,
    isFork,
    releases,
    owner,
    langs: langsArray.nodes.map(l => l.name).join(", ")
  };
}
function normalizeIssue(issue: GQL.Issue): NormalizedIssue {
  const {
    url,
    title,
    comments: { totalCount: commentCount },
    createdAt,
    author: { login: user } = { login: "unknown" },
    repository: {
      name: repoName,
      url: repoUrl,
      stargazers: { totalCount: repoStars },
      languages: langsArray,
      releases: { totalCount: repoReleases },
      owner: { login: repoOwner } = { login: "unknown" }
    }
  } = issue;
  return {
    user,
    url,
    title,
    commentCount,
    createdAt: new Date(createdAt).toDateString(),
    repoStars,
    repoName,
    repoReleases,
    repoOwner,
    repoUrl,
    repoLangs: langsArray.nodes.map(l => l.name).join(", ")
  };
}
function normalizePullRequestReview(
  review: GQL.PullRequestReview
): NormalizedPullRequestReview {
  const {
    url,
    createdAt: reviewCreatedAt,
    comments: { totalCount: commentCount },
    author: { login: user } = { login: "unknown" },
    pullRequest: {
      createdAt: prCreatedAt,
      url: prUrl,
      title: prTitle,
      author: { login: prAuthor } = { login: "unknown" },
      additions: prAdditions,
      deletions: prDeletions,
      changedFiles: prChangedFiles,
      repository: {
        url: prRepoUrl,
        name: prRepoName,
        owner: { login: prRepoOwner } = { login: "unknown" },
        releases: { totalCount: prRepoReleaseCount },
        stargazers: { totalCount: prRepoStars },
        languages: { nodes: prRepoLangsArr }
      }
    }
  } = review;

  return {
    url,
    user,
    prUrl: prUrl,
    prAuthor,
    prRepoStars,
    prRepoUrl,
    prTitle,
    prRepoLanguages: prRepoLangsArr.map(l => l.name).join(", "),
    prRepoReleaseCount,
    prRepoName,
    prRepoOwner,
    prAdditions,
    prDeletions,
    prChangedFiles,
    commentCount,
    createdAt: new Date(reviewCreatedAt).toDateString(),
    prCreatedAt: new Date(prCreatedAt).toDateString()
  };
}

export interface RunOptions {
  combine: boolean;
  outDir: string;
}

export async function run(
  logins: string | null,
  token: string,
  startDate: Date,
  endDate: Date,
  options: RunOptions
) {
  const { outDir, combine } = options;
  if (!logins) {
    const singleUserData = await runForUser(null, token, startDate, endDate);
    await writeData(singleUserData, outDir);
    return;
  }
  const loginList = logins.split(/\s*,\s*/g);
  const allData: {
    pullRequests: NormalizedPullRequest[];
    issues: NormalizedIssue[];
    repos: NormalizedRepoCreation[];
    reviews: NormalizedPullRequestReview[];
  } = {
    pullRequests: [],
    issues: [],
    repos: [],
    reviews: []
  };
  for (let i of loginList) {
    const userData = await runForUser(i, token, startDate, endDate);
    if (combine) {
      allData.issues = [...allData.issues, ...userData.issues];
      allData.pullRequests = [
        ...allData.pullRequests,
        ...userData.pullRequests
      ];
      allData.repos = [...allData.repos, ...userData.repos];
      allData.reviews = [...allData.reviews, ...userData.reviews];
    } else {
      await writeData(userData, join(outDir, i));
    }
  }
  if (combine) {
    console.log(chalk.red() + combine);

    await writeData(allData, outDir);
  }
}

async function writeData(
  data: {
    pullRequests: NormalizedPullRequest[];
    issues: NormalizedIssue[];
    repos: NormalizedRepoCreation[];
    reviews: NormalizedPullRequestReview[];
  },
  dirPath: string
) {
  const { pullRequests, issues, reviews, repos } = data;

  const tasks = new Listr([
    {
      title: `Writing data out to: ${chalk.bold.yellow(
        join(process.cwd(), dirPath)
      )}`,
      task: () => {
        if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
        csvStringify(pullRequests, { header: true }, function(err, output) {
          writeFileSync(join(dirPath, "pull-requests.csv"), output);
        });
        csvStringify(issues, { header: true }, function(err, output) {
          writeFileSync(join(dirPath, "issues.csv"), output);
        });
        csvStringify(repos, { header: true }, function(err, output) {
          writeFileSync(join(dirPath, "repos.csv"), output);
        });
        csvStringify(reviews, { header: true }, function(err, output) {
          writeFileSync(join(dirPath, "reviews.csv"), output);
        });
      }
    }
  ]);
  await tasks.run();
}

function isDefined<T>(arg: T | undefined | null): arg is T {
  return arg !== null && typeof arg !== "undefined";
}

async function runForUser(
  rawLogin: string | null,
  token: string,
  startDate: Date,
  endDate: Date
) {
  if (!rawLogin) {
    const {
      viewer: { login: foundLogin }
    } = await gqlQuery(
      `{
      viewer {
        login
      }
    }`,
      token
    );
    console.warn(
      chalk.yellow(
        `⚠️   No user specified. Falling back to auth token owner \"${foundLogin}\"`
      )
    );
    rawLogin = foundLogin as string;
  }
  if (!rawLogin) throw new Error("Could not determine login");
  const login = rawLogin;
  console.log(
    chalk.blue("Fetching data from GitHub for user ") +
      chalk.bold.greenBright(login)
  );
  const { pullRequests, issues, reviews, repos } = await getAllContributions(
    login,
    token,
    startDate,
    endDate
  );

  const normalizedPRs = pullRequests
    .map(x => {
      try {
        return normalizePullRequest(x);
      } catch (e) {
        console.error(
          `Encountered a problem normalizing the following entity ${JSON.stringify(
            x,
            null,
            "  "
          )}`
        );
        return null;
      }
    })
    .filter(isDefined);
  const normalizedIssues = issues
    .map(x => {
      try {
        return normalizeIssue(x);
      } catch (e) {
        console.error(
          `Encountered a problem normalizing the following entity ${JSON.stringify(
            x,
            null,
            "  "
          )}`
        );
        return null;
      }
    })
    .filter(isDefined);
  const normalizedRepos = repos
    .map(x => {
      try {
        return normalizeRepoCreation(x);
      } catch (e) {
        console.error(
          `Encountered a problem normalizing the following entity ${JSON.stringify(
            x,
            null,
            "  "
          )}`
        );
        return null;
      }
    })
    .filter(isDefined);
  const normalizedReviews = reviews
    .map(x => {
      try {
        return normalizePullRequestReview(x);
      } catch (e) {
        console.error(
          `Encountered a problem normalizing the following entity ${JSON.stringify(
            x,
            null,
            "  "
          )}`
        );
        return null;
      }
    })
    .filter(isDefined);

  return {
    pullRequests: normalizedPRs,
    issues: normalizedIssues,
    repos: normalizedRepos.map(r => ({ ...r, user: login })),
    reviews: normalizedReviews
  };
}
