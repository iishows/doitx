/** Memory fraction of the container's limit above which a machine is treated as starved. */
export const COMPUTER_PRESSURE_MEM_RATIO = 0.9;
/** Share of CPU periods throttled above which a machine is treated as starved. */
export const COMPUTER_PRESSURE_THROTTLED_RATIO = 0.2;

/**
 * How many runs a computer may admit right now, given how loaded it already is.
 *
 * Static limits assume a healthy machine. When the container behind a shared computer is
 * already memory-starved or noticeably CPU-throttled, admitting another run makes every
 * run on it slower, so the ceiling collapses to zero and new runs wait for a release
 * instead. `liveLeases` is what the caller already counted; a resumed run's own lease is
 * not a new occupant and is handled by the caller.
 */
export function pressuredRunLimit(input: {
  staticLimit: number;
  pressure: { memRatio: number; throttledRatio: number; oomKills: number } | null;
}): number {
  const { pressure, staticLimit } = input;
  if (!pressure) return staticLimit;
  const starved =
    pressure.memRatio >= COMPUTER_PRESSURE_MEM_RATIO ||
    pressure.throttledRatio >= COMPUTER_PRESSURE_THROTTLED_RATIO ||
    pressure.oomKills > 0;
  return starved ? 0 : staticLimit;
}
