/**
 * Lets the entry point release daemon-side resources without naming them.
 *
 * Paseo deletes `*.server` imports from the client bundle but keeps the surrounding
 * statements, so a server identifier in `contribute()`'s shared body becomes a
 * ReferenceError that aborts every registration. A shared module is safe in both
 * bundles: `recorder.server` fills this in on the daemon, and it stays null in the
 * client, where there is nothing to release.
 */
export type Teardown = () => void | Promise<void>;

/**
 * A list rather than a single slot: the recorder and the governor each start on
 * import and each own a timer, and both must be released or the subprocess never
 * exits and the plugin wedges at "Stopping" for the life of the daemon.
 */
export const lifecycle: { teardowns: Teardown[] } = { teardowns: [] };

/**
 * Runs every teardown even when one fails, then reports the first failure.
 *
 * One feature's cleanup throwing must not leave another's timer running: the
 * subprocess would never exit and Paseo's stop step would hang.
 */
export async function runTeardowns(teardowns: readonly Teardown[]): Promise<void> {
  let failure: unknown = null;
  for (const teardown of teardowns) {
    try {
      await teardown();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== null) throw failure;
}
