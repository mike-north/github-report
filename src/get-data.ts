import * as dotenv from "dotenv";
import * as graphql from "@octokit/graphql";
import * as Listr from "listr";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import * as csvStringify from "csv-stringify";
import { join } from "path";

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

async function gqlQuery(query: string): Promise<any> {
  return await graphql(query, {
    headers: {
      authorization: `token ${process.env.GH_TOKEN}`
    }
  });
}

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
  } while (result.pageInfo.hasNextPage);
  return allRecords;
}
const prRecordRetriever: (
  login: string,
  startDate: Date,
  endDate: Date
) => RecordRetriever<GQL.PullRequest> = (
  login: string,
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
    `
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
  startDate: Date,
  endDate: Date
) => RecordRetriever<GQL.RepoCreation> = (
  login: string,
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
    `
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
  startDate: Date,
  endDate: Date
) => RecordRetriever<GQL.Issue> = (
  login: string,
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
    `
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
  startDate: Date,
  endDate: Date
) => RecordRetriever<GQL.PullRequestReview> = (
  login: string,
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
    `
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
            prRecordRetriever(login, startDate, endDate),
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
            issueRecordRetriever(login, startDate, endDate),
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
            codeReviewRecordRetriever(login, startDate, endDate),
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
            repoRecordRetriever(login, startDate, endDate),
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

    repository: {
      name: repoName,
      stargazers: { totalCount: repoStars },
      languages: langsArray,
      releases: { totalCount: repoReleases },
      owner: { login: repoOwner }
    }
  } = issue;
  return {
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

export async function run(login: string, startDate: Date, endDate: Date) {
  const { pullRequests, issues, reviews, repos } = await getAllContributions(
    login,
    startDate,
    endDate
  );

  const normalizedPRs = pullRequests.map(normalizePullRequest);
  const normalizedIssues = issues.map(normalizeIssue);
  const normalizedRepos = repos.map(normalizeRepoCreation);
  const normalizedReviews = reviews.map(normalizePullRequestReview);

  if (!existsSync("out")) mkdirSync("out");
  csvStringify(normalizedPRs, { header: true }, function(err, output) {
    writeFileSync(join("out", "pull-requests.csv"), output);
  });
  csvStringify(normalizedIssues, { header: true }, function(err, output) {
    writeFileSync(join("out", "issues.csv"), output);
  });
  csvStringify(normalizedRepos, { header: true }, function(err, output) {
    writeFileSync(join("out", "repos.csv"), output);
  });
  csvStringify(normalizedReviews, { header: true }, function(err, output) {
    writeFileSync(join("out", "reviews.csv"), output);
  });
}
