/**
 * Which copy of a thread decides whether it is working: its detail or its
 * list shell.
 *
 * A detail that is not live yet can come from the disk cache, which a thread
 * view writes when it closes, even mid-turn. Until its stream catches up,
 * that copy can say a turn is running long after it ended. The shell stays
 * subscribed for the whole app session, so its run state is at least as
 * fresh. Once the detail is live it is the current copy again.
 */
export function selectThreadRunStateSource<Detail, Shell>(input: {
  readonly detail: Detail | null;
  readonly detailIsLive: boolean;
  readonly shell: Shell | null;
}): Detail | Shell | null {
  return input.detailIsLive ? (input.detail ?? input.shell) : (input.shell ?? input.detail);
}
