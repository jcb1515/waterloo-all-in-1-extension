// @ts-check
// WaterlooWorks adapter stub (Window 3 fills this in during Phase 1).
/** @type {import("../../core/contract.js").Adapter} */
export default {
  id: "waterlooworks",
  label: "WaterlooWorks",
  origins: ["https://waterlooworks.uwaterloo.ca"],
  intervalMinutes: 0,
  syncOnTabOpen: false,
  async sync() {
    return { items: [], complete: true };
  },
};
