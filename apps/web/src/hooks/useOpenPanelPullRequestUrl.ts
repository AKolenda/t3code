import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, type ScopedThreadRef } from "@t3tools/contracts";

import { gitHubPullRequestBrowserUrl } from "../lib/openPullRequestLink";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { useProject } from "../state/entities";
import { usePullRequestDetail } from "../state/pullRequests";

export function useOpenPanelPullRequestUrl(threadRef: ScopedThreadRef | null) {
  const surface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, threadRef),
  );
  const reference = surface?.kind === "pull-request" ? surface : null;
  const environmentId = reference?.environmentId
    ? EnvironmentId.make(reference.environmentId)
    : threadRef?.environmentId;
  const project = useProject(
    reference && environmentId
      ? scopeProjectRef(environmentId, ProjectId.make(reference.projectId))
      : null,
  );
  const detail = usePullRequestDetail(
    reference && environmentId
      ? {
          environmentId,
          input: {
            projectId: ProjectId.make(reference.projectId),
            repository: reference.repository,
            number: reference.number,
          },
        }
      : null,
  ).data;
  return reference
    ? (detail?.url ??
        gitHubPullRequestBrowserUrl(
          project?.repositoryIdentity,
          reference.repository,
          reference.number,
        ))
    : undefined;
}
