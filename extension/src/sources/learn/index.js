// @ts-check
// Learn adapter stub (Window 2 fills this in during Phase 1).
/** @type {import("../../core/contract.js").Adapter} */
export default {
  id: "learn",
  label: "Learn",
  origins: ["https://learn.uwaterloo.ca"],
  intervalMinutes: 0,
  syncOnTabOpen: false,
  async sync() {
    return { items: [], complete: true };
  },
};
