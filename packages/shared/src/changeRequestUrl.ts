import type { SourceControlProviderKind } from "@t3tools/contracts";

/**
 * A change request named the way a thread link names one: the host below which the repository
 * is addressed, the repository path as that host writes it, and the number.
 *
 * The two strings are what `pullRequestHostOf` and the project's `repositoryIdentity` produce
 * from a git remote — lower case, no port, the full path below the host — because links are
 * matched against those. Anything else matches nothing.
 */
export interface ChangeRequestLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

/** The host itself, one of its subdomains, or an install named after the provider. */
function isHostOf(hostname: string, apex: string, label?: string): boolean {
  if (hostname === apex || hostname.endsWith(`.${apex}`)) return true;
  return label !== undefined && hostname.startsWith(`${label}.`);
}

/**
 * The repository and number behind a change request URL on a host this can read, or null for
 * anything else — an issue, a commit, a repository root, a host this cannot tell apart from an
 * ordinary link. A doubtful match is worse than no match, so nothing here guesses.
 *
 * Each host is recognised by the path shape it alone uses, guarded by a hostname it could
 * plausibly be served from, since self-hosted installs are named whatever their admin chose:
 * GitLab's `/-/` marker is unique enough to trust on any hostname, while `/pull/` is generic
 * enough that it is only believed from a GitHub-ish host.
 *
 * Nothing here tries to tell a lookalike hostname from a real one — `github.com.evil.test` and
 * the rest are an open set, and blocking spellings of it costs real hosts (`gitlab.com.br` is a
 * registrable domain). What a claim is worth is decided where it is used.
 */
export function parseChangeRequestUrl(targetUrl: string): ChangeRequestLink | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  // `javascript:`, `mailto:` and friends have no host to speak of and nothing to open.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();

  // GitHub, and any Enterprise install: /{owner}/{repo}/pull/{n}
  if (isHostOf(host, "github.com", "github")) {
    const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  // GitLab, self-hosted included: /{group}/[{subgroup}/...]{repo}/-/merge_requests/{n}. The `/-/`
  // separator is GitLab's own, so the hostname is not asked about.
  const gitlab = /^\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (gitlab) return claim(host, gitlab);
  // Bitbucket Cloud: /{workspace}/{repo}/pull-requests/{n}
  if (isHostOf(host, "bitbucket.org", "bitbucket")) {
    const match = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  // Azure DevOps, both the current host and the per-organisation one it replaced. `_git` is part
  // of the repository path there, as it is in the remote URL the identity is read from.
  if (isHostOf(host, "dev.azure.com") || host.endsWith(".visualstudio.com")) {
    const match = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim(host, match);
  }
  return null;
}

function claim(host: string, match: RegExpExecArray | null): ChangeRequestLink | null {
  const repository = match?.[1];
  const number = Number(match?.[2]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { host, repository: repository.toLowerCase(), number }
    : null;
}

/** The web URL a host writes for a change request; null when the host shape is unknown. */
export function changeRequestUrlFor(
  kind: SourceControlProviderKind | null,
  host: string,
  repository: string,
  number: number,
): string | null {
  switch (kind) {
    case "github":
      return `https://${host}/${repository}/pull/${number}`;
    case "gitlab":
      return `https://${host}/${repository}/-/merge_requests/${number}`;
    case "bitbucket":
      return `https://${host}/${repository}/pull-requests/${number}`;
    case "azure-devops":
      return `https://${host}/${repository}/pullrequest/${number}`;
    default:
      return null;
  }
}
