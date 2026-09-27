/**
 * Which copy of a thread decides whether it is working: its detail or its
 * thread-list shell.
 *
 * A detail can be a copy retained in memory or written to disk when a view
 * closed, even mid-turn, so it can say a turn is running long after it ended.
 * Both copies stamp `updatedAt` with the time of the latest event they hold,
 * so the newer one wins; on a tie the detail, which the open view streams.
 * Before the thread list has loaded there is no shell, and only a live
 * detail is trusted.
 */
export function selectThreadRunStateSource<
  Detail extends { readonly updatedAt: string },
  Shell extends { readonly updatedAt: string },
>(input: {
  readonly detail: Detail | null;
  readonly detailIsLive: boolean;
  /** The thread-list shell only, never one derived from the detail. */
  readonly shell: Shell | null;
}): Detail | Shell | null {
  const { detail, shell } = input;
  if (shell === null) return input.detailIsLive ? detail : null;
  if (detail === null) return shell;
  return Date.parse(detail.updatedAt) >= Date.parse(shell.updatedAt) ? detail : shell;
}
