import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link2 } from "lucide-react";
import { useState } from "react";
import { parseChangeRequestUrl } from "~/lib/openPullRequestLink";
import { useServerConfigs } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Adopts a branch discovery as a durable link, even after the thread changes branches. */
export function LinkBranchPullRequestButton({
  threadRef,
  url,
}: {
  threadRef: ScopedThreadRef;
  url: string;
}) {
  const configs = useServerConfigs();
  const link = useAtomCommand(threadEnvironment.linkPullRequest, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const reference = parseChangeRequestUrl(url);
  if (
    !reference ||
    configs.get(threadRef.environmentId)?.environment.capabilities.threadPullRequests !== true
  )
    return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-4 shrink-0 text-muted-foreground"
            aria-label="Link this PR"
            disabled={pending}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={async (event) => {
              event.preventDefault();
              event.stopPropagation();
              setPending(true);
              const result = await link({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, ...reference, url, source: "manual" },
              }).finally(() => setPending(false));
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                toastManager.add({
                  type: "error",
                  title: "Could not link pull request",
                  description: error instanceof Error ? error.message : String(error),
                });
              }
            }}
          >
            <Link2 className="size-3" />
          </Button>
        }
      />
      <TooltipPopup>Link this PR to keep it with this thread</TooltipPopup>
    </Tooltip>
  );
}
