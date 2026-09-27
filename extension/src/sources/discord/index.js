// @ts-check
// Discord adapter stub (Window 3 fills this in during Phase 2). Passive only.
/** @type {import("../../core/contract.js").Adapter} */
export default {
  id: "discord",
  label: "Discord",
  origins: ["https://discord.com"],
  intervalMinutes: 0,
  syncOnTabOpen: false,
  async sync() {
    return { items: [], complete: true };
  },
};
