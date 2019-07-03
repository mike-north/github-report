import * as dotenv from "dotenv";
import * as graphql from "@octokit/graphql";
import * as Listr from "listr";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import * as csvStringify from "csv-stringify";
import { join } from "path";
import chalk from "chalk";

dotenv.config();

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

const timeout = (n: number) => new Promise(res => setTimeout(res, n));

async function retrieveAll<T extends object>(
  recordRetriever: RecordRetriever<T>,
  recordName: string,
  task: Listr.ListrTaskWrapper
): Promise<T[]> {
  const allRecords = [];
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
  do {
    result = await recordRetriever(result.pageInfo.endCursor);
    const { records, totalCount } = result;
    allRecords.push(...records);
    task.title = `${recordName}: ${allRecords.length}/${totalCount}`;
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

  const tasks = new Listr(
    [
      {
        title: "Pull Requests 0/",
        task: (_, task) => {
          pPullRequests = retrieveAll(
            prRecordRetriever(login, token, startDate, endDate),
            "Pull Requests",
            task
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
            task
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
            task
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
            task
          );
          return pRepos;
        }
      }
    ],
    { concurrent: true }
  );
  await tasks.run();
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
  releases: number;
}
interface NormalizedIssue {
  user: string;
  url: string;
  title: string;
  createdAt: number;
  commentCount: number;

  repoLangs: string;
  repoName: string;
  repoOwner: string;
  repoStars: number;
  repoReleases: number;
}
interface NormalizedPullRequestReview {
  user: string;
  createdAt: number;
  url: string;
  commentCount: number;
  prUrl: string;
  prAdditions: number;
  prDeletions: number;
  prChangedFiles: number;
  prCreatedAt: number;
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
    author: { login: user },
    title,
    comments: { totalCount: commentCount },
    createdAt,
    additions,
    deletions,
    changedFiles,
    repository: {
      name: repoName,
      stargazers: { totalCount: repoStars },
      languages: langsArray,
      releases: { totalCount: repoReleases },
      owner: { login: repoOwner }
    }
  } = pr;
  return {
    user,
    url,
    title,
    commentCount,
    createdAt: new Date(createdAt).valueOf(),
    additions,
    deletions,
    changedFiles,
    repoStars,
    repoName,
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
    owner: { login: owner },
    languages: langsArray
  } = repo;
  return {
    name,
    url,
    stars,
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
    author: { login: user },
    repository: {
      name: repoName,
      stargazers: { totalCount: repoStars },
      languages: langsArray,
      releases: { totalCount: repoReleases },
      owner: { login: repoOwner }
    }
  } = issue;
  return {
    user,
    url,
    title,
    commentCount,
    createdAt: new Date(createdAt).valueOf(),
    repoStars,
    repoName,
    repoReleases,
    repoOwner,
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
    author: { login: user },
    pullRequest: {
      createdAt: prCreatedAt,
      url: prUrl,
      author: { login: prAuthor },
      additions: prAdditions,
      deletions: prDeletions,
      changedFiles: prChangedFiles,
      repository: {
        url: prRepoUrl,
        name: prRepoName,
        owner: { login: prRepoOwner },
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
    prRepoLanguages: prRepoLangsArr.map(l => l.name).join(", "),
    prRepoReleaseCount,
    prRepoName,
    prRepoOwner,
    prAdditions,
    prDeletions,
    prChangedFiles,
    commentCount,
    createdAt: new Date(reviewCreatedAt).valueOf(),
    prCreatedAt: new Date(prCreatedAt).valueOf()
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
      title: `Writing data out to: ${chalk.bold.yellow(dirPath)}`,
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
    chalk.yellow("[ ") +
      chalk.blue("Fetching data from GitHub for user ") +
      chalk.bold.greenBright(login) +
      " " +
      chalk.yellow(" ]")
  );
  const { pullRequests, issues, reviews, repos } = await getAllContributions(
    login,
    token,
    startDate,
    endDate
  );

  const normalizedPRs = pullRequests.map(normalizePullRequest);
  const normalizedIssues = issues.map(normalizeIssue);
  const normalizedRepos = repos.map(normalizeRepoCreation);
  const normalizedReviews = reviews.map(normalizePullRequestReview);

  return {
    pullRequests: normalizedPRs,
    issues: normalizedIssues,
    repos: normalizedRepos.map(r => ({ ...r, user: login })),
    reviews: normalizedReviews
  };
}
