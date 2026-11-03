import { describe, expect, it } from "vitest";
import {
  COMPUTER_PRESSURE_MEM_RATIO,
  COMPUTER_PRESSURE_THROTTLED_RATIO,
  pressuredRunLimit,
} from "./computer-pressure.js";

const calm = { memRatio: 0.1, throttledRatio: 0, oomKills: 0 };

describe("pressuredRunLimit", () => {
  it("stands at the static ceiling while the machine is calm", () => {
    expect(pressuredRunLimit({ staticLimit: 3, pressure: calm })).toBe(3);
    expect(
      pressuredRunLimit({
        staticLimit: 2,
        pressure: { memRatio: COMPUTER_PRESSURE_MEM_RATIO - 0.01, throttledRatio: 0, oomKills: 0 },
      }),
    ).toBe(2);
  });

  it("admits nothing new once memory is nearly exhausted", () => {
    expect(
      pressuredRunLimit({
        staticLimit: 3,
        pressure: { memRatio: COMPUTER_PRESSURE_MEM_RATIO, throttledRatio: 0, oomKills: 0 },
      }),
    ).toBe(0);
  });

  it("admits nothing new once the CPU is noticeably throttled", () => {
    expect(
      pressuredRunLimit({
        staticLimit: 3,
        pressure: { memRatio: 0, throttledRatio: COMPUTER_PRESSURE_THROTTLED_RATIO, oomKills: 0 },
      }),
    ).toBe(0);
  });

  it("admits nothing new after the machine has killed a process for memory", () => {
    expect(pressuredRunLimit({ staticLimit: 3, pressure: { ...calm, oomKills: 1 } })).toBe(0);
  });

  it("keeps the static ceiling when no reading is available, so a failed probe never blocks", () => {
    expect(pressuredRunLimit({ staticLimit: 1, pressure: null })).toBe(1);
    expect(pressuredRunLimit({ staticLimit: 5, pressure: null })).toBe(5);
  });
});
