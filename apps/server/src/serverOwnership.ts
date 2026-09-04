// @effect-diagnostics nodeBuiltinImport:off - Publication must finish synchronously while the scope holds ownership.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { acquireServerOwnershipLock } from "./serverOwnershipLock.ts";

import {
  isProcessAlive,
  readPersistedServerRuntimeState,
  PersistedServerRuntimeState,
} from "./serverRuntimeState.ts";

export class ServerAlreadyRunningError extends Schema.TaggedErrorClass<ServerAlreadyRunningError>()(
  "ServerAlreadyRunningError",
  { stateDir: Schema.String },
) {
  override get message(): string {
    return `A T3 Code server already owns ${this.stateDir}. Finish active agent work, stop that server through the app or terminal that started it, then retry this command with the same home directory. No server was stopped.`;
  }
}

export class ServerOwnershipError extends Schema.TaggedErrorClass<ServerOwnershipError>()(
  "ServerOwnershipError",
  { statePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not acquire or update server ownership at ${this.statePath}.`;
  }
}

export class ServerOwnershipReleasedError extends Schema.TaggedErrorClass<ServerOwnershipReleasedError>()(
  "ServerOwnershipReleasedError",
  { statePath: Schema.String },
) {
  override get message(): string {
    return `Cannot publish server runtime state after ownership was released at ${this.statePath}.`;
  }
}

const encodeRuntimeState = Schema.encodeSync(Schema.fromJsonString(PersistedServerRuntimeState));

/**
 * Hold an OS file lock until the server and its finalizers stop. This separate
 * SQLite file never contains application data and must never be unlinked.
 * SQLite releases the lock on process exit, including SIGKILL. No PID is killed
 * and no heartbeat can expire while a live server is paused.
 */
export const acquireServerOwnership = Effect.fn("acquireServerOwnership")(function* (
  statePath: string,
) {
  const ownerId = NodeCrypto.randomUUID();
  const resource = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const lock = await acquireServerOwnershipLock(NodePath.dirname(statePath));
        return {
          lock,
          path: NodePath.join(lock.stateDir, NodePath.basename(statePath)),
          active: true,
        };
      },
      catch: (cause) =>
        cause instanceof Error &&
        (("errcode" in cause && cause.errcode === 5) ||
          ("code" in cause && cause.code === "SQLITE_BUSY"))
          ? new ServerAlreadyRunningError({ stateDir: NodePath.dirname(statePath) })
          : new ServerOwnershipError({ statePath, cause }),
    }),
    (resource) =>
      Effect.gen(function* () {
        const state = yield* readPersistedServerRuntimeState(resource.path);
        yield* Effect.try({
          try: () => {
            if (Option.isSome(state) && state.value.ownerId === ownerId) {
              NodeFS.rmSync(resource.path, { force: true });
            }
          },
          catch: (cause) => new ServerOwnershipError({ statePath, cause }),
        }).pipe(Effect.ignore({ log: true }));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            resource.active = false;
            resource.lock.close();
          }),
        ),
      ),
  );

  // Older releases have no lock. Do not replace their record while their PID
  // exists. New records with a free lock belong to a crashed or stopped owner.
  const previous = yield* readPersistedServerRuntimeState(resource.path);
  if (
    Option.isSome(previous) &&
    previous.value.ownerId === undefined &&
    isProcessAlive(previous.value.pid)
  ) {
    return yield* new ServerAlreadyRunningError({ stateDir: resource.lock.stateDir });
  }

  return {
    publish: (state: PersistedServerRuntimeState) =>
      Effect.suspend<void, ServerOwnershipError | ServerOwnershipReleasedError, never>(() => {
        if (!resource.active) return Effect.fail(new ServerOwnershipReleasedError({ statePath }));
        return Effect.try({
          try: () => {
            const temporaryPath = `${resource.path}.${ownerId}.tmp`;
            try {
              NodeFS.writeFileSync(
                temporaryPath,
                `${encodeRuntimeState({ ...state, ownerId })}\n`,
                {
                  mode: 0o600,
                },
              );
              NodeFS.renameSync(temporaryPath, resource.path);
            } finally {
              NodeFS.rmSync(temporaryPath, { force: true });
            }
          },
          catch: (cause) => new ServerOwnershipError({ statePath, cause }),
        });
      }),
  };
});

/** Check before service setup. The server still acquires its own lifetime lock. */
export const requireServerStopped = (statePath: string) =>
  Effect.scoped(acquireServerOwnership(statePath)).pipe(Effect.asVoid);

/** Publish a runtime record while retaining ownership in the caller's scope. */
export const persistServerRuntimeState = Effect.fn("persistServerRuntimeState")(function* (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) {
  const owner = yield* acquireServerOwnership(input.path);
  yield* owner.publish(input.state);
});
