// @ts-check
// Portal adapter stub (Window 2 fills this in during Phase 2).
/** @type {import("../../core/contract.js").Adapter} */
export default {
  id: "portal",
  label: "Portal",
  origins: ["https://portal.uwaterloo.ca"],
  intervalMinutes: 0,
  syncOnTabOpen: false,
  async sync() {
    return { items: [], complete: true };
  },
};
