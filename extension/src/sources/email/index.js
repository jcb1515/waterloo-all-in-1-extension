// @ts-check
// Email adapter stub (Window 2 fills this in during Phase 3).
// Covers Outlook web and Gmail; the adapter id is "outlook".
/** @type {import("../../core/contract.js").Adapter} */
export default {
  id: "outlook",
  label: "Email (Outlook + Gmail)",
  origins: [
    "https://outlook.office.com",
    "https://outlook.cloud.microsoft",
    "https://outlook.live.com",
    "https://mail.google.com",
  ],
  intervalMinutes: 0,
  syncOnTabOpen: false,
  async sync() {
    return { items: [], complete: true };
  },
};
