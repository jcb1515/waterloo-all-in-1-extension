// @ts-check
// Course-outline adapter stub (Window 2 fills this in during Phase 1).
/** @type {import("../../core/contract.js").Adapter} */
export default {
  id: "outline",
  label: "Course outlines",
  origins: ["https://outline.uwaterloo.ca"],
  intervalMinutes: 0,
  syncOnTabOpen: false,
  async sync() {
    return { items: [], complete: true };
  },
};
