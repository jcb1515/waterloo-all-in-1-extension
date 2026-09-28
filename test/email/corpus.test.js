// @ts-check
// Email corpus: every case is invented for this file — no real mail. A case
// runs as an opened message; `list: true` cases also run as a list row
// (subject + preview only). Expected shape:
//   {type, category?, dateToronto "YYYY-MM-DD", time "HH:MM"|null, allDay}
// or "none". Events land at the hit's start, deadlines/tasks at dueAt.

import test from "node:test";
import assert from "node:assert/strict";
import { itemsFromMessage, taskItems } from "../../extension/src/sources/email/extract.js";
import { zonedParts } from "../../extension/src/lib/textdates/index.js";

const AT = "2026-09-28T14:00:00.000Z"; // Mon Sep 28 2026, 10:00 EDT
const pad = (n) => String(n).padStart(2, "0");
const dayOf = (iso) => {
  const p = zonedParts(new Date(iso));
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};
const timeOf = (iso) => {
  const p = zonedParts(new Date(iso));
  return `${pad(p.h)}:${pad(p.mi)}`;
};

/** `from` is "Display Name <email>" or a bare address; name missing → "". */
const senderOf = (from) => {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1], email: m[2] } : { name: "", email: from };
};

const ALL = [
  /* ================= hack ================= */
  {
    from: "Sam Peer <sam@example.org>",
    subject: "Hack the Valley",
    body: "Join us for the Hack the Valley hackathon on November 7-8. Bring a laptop.",
    receivedAt: AT,
    expect: { type: "event", category: "hack", dateToronto: "2026-11-07", time: null, allDay: true },
    list: true,
  },
  {
    from: "Kai Organizer <kai@example.org>",
    subject: "Datathon kickoff",
    body: "The datathon starts Saturday, Oct 3 from 10am-4pm in the main hall.",
    receivedAt: AT,
    expect: { type: "event", category: "hack", dateToronto: "2026-10-03", time: "10:00", allDay: false },
    list: true,
  },
  {
    from: "no-reply@codejam.example.com",
    subject: "Registration received",
    body: "You're registered for the code jam on Nov 14, 2026. See you there!",
    receivedAt: AT,
    expect: { type: "event", category: "hack", dateToronto: "2026-11-14", time: null, allDay: true },
    list: true,
  },
  {
    from: "Rin Club <rin@example.org>",
    subject: "Game jam",
    body: "Game Jam kickoff this Friday at 6 in the lab.",
    receivedAt: AT,
    expect: { type: "event", category: "hack", dateToronto: "2026-10-02", time: "18:00", allDay: false },
  },
  {
    from: "no-reply@ideathon.example.org",
    subject: "Thanks for registering",
    body: "Thanks for registering! The ideathon begins Nov 7-8, 2026 at the library.",
    receivedAt: AT,
    expect: { type: "event", category: "hack", dateToronto: "2026-11-07", time: null, allDay: true },
  },
  {
    from: "Morgan Dev <morgan@example.org>",
    subject: "Demo night moved",
    body: "Hackathon demo night moved to October 17, 6:30 PM.",
    receivedAt: AT,
    expect: { type: "event", category: "hack", dateToronto: "2026-10-17", time: "18:30", allDay: false },
    list: true,
  },
  /* ================= social ================= */
  {
    from: "Alumni Office <alumni@example.org>",
    subject: "Mixer",
    body: "Networking mixer on October 8 at 7pm on the terrace.",
    receivedAt: AT,
    expect: { type: "event", category: "social", dateToronto: "2026-10-08", time: "19:00", allDay: false },
    list: true,
  },
  {
    from: "Priya Mentors <priya@example.org>",
    subject: "Coffee chat",
    body: "Coffee chat with alumni on Oct 3, 6:30 PM at the downtown cafe.",
    receivedAt: AT,
    expect: { type: "event", category: "social", dateToronto: "2026-10-03", time: "18:30", allDay: false },
  },
  {
    from: "no-reply@tickets.example.com",
    subject: "Your RSVP",
    body: "You've RSVP'd — see you at the gala on November 20, 2026.",
    receivedAt: AT,
    expect: { type: "event", category: "social", dateToronto: "2026-11-20", time: null, allDay: true },
    list: true,
  },
  {
    from: "Quizmaster Q <q@example.org>",
    subject: "Trivia night",
    body: "Trivia night this Friday at 6, usual spot.",
    receivedAt: AT,
    expect: { type: "event", category: "social", dateToronto: "2026-10-02", time: "18:00", allDay: false },
  },
  {
    from: "no-reply@cinema.example.com",
    subject: "Your ticket",
    body: "Your ticket for the movie night on Oct 9 is attached.",
    receivedAt: AT,
    expect: { type: "event", category: "social", dateToronto: "2026-10-09", time: null, allDay: true },
    list: true,
  },
  {
    from: "Dept Social <social@example.org>",
    subject: "Happy hour",
    body: "Happy hour and reception on Friday, Oct 16 at 5:30pm.",
    receivedAt: AT,
    expect: { type: "event", category: "social", dateToronto: "2026-10-16", time: "17:30", allDay: false },
  },
  /* ================= career ================= */
  {
    from: "Careers Centre <careers@example.org>",
    subject: "Career fair",
    body: "Career fair on October 14 from 10am to 4pm at the field house.",
    receivedAt: AT,
    expect: { type: "event", category: "career", dateToronto: "2026-10-14", time: "10:00", allDay: false },
    list: true,
  },
  {
    from: "Co-op Advisor <coop@example.org>",
    subject: "Job fair",
    body: "The regional job fair is next Thursday, Oct 8.",
    receivedAt: AT,
    expect: { type: "event", category: "career", dateToronto: "2026-10-08", time: null, allDay: true },
  },
  {
    from: "no-reply@employer.example.com",
    subject: "Confirmed",
    body: "Registration confirmed for the employer info session on Nov 5 at 5pm.",
    receivedAt: AT,
    expect: { type: "event", category: "career", dateToronto: "2026-11-05", time: "17:00", allDay: false },
    list: true,
  },
  {
    from: "Eng Outreach <outreach@example.org>",
    subject: "Open house",
    body: "Open house at the engineering building Oct 3 from 10am-4pm.",
    receivedAt: AT,
    expect: { type: "event", category: "career", dateToronto: "2026-10-03", time: "10:00", allDay: false },
  },
  {
    from: "Talent Team <talent@acme.example.com>",
    subject: "Info session",
    body: "Info session with our engineers on October 6 at 6pm.",
    receivedAt: AT,
    expect: { type: "event", category: "career", dateToronto: "2026-10-06", time: "18:00", allDay: false },
    list: true,
  },
  {
    from: "Recruiting <recruiting@acme.example.com>",
    subject: "Site visit",
    body: "Your site visit is scheduled for November 12 at 9am.",
    receivedAt: AT,
    expect: { type: "event", category: "career", dateToronto: "2026-11-12", time: "09:00", allDay: false },
  },
  /* ================= learning ================= */
  {
    from: "Makerspace <make@example.org>",
    subject: "Workshop",
    body: "Soldering workshop on October 4 at 2pm — bring safety glasses.",
    receivedAt: AT,
    expect: { type: "event", category: "learning", dateToronto: "2026-10-04", time: "14:00", allDay: false },
    list: true,
  },
  {
    from: "no-reply@webinars.example.com",
    subject: "Webinar seat",
    body: "You are registered for the webinar on Nov 18 at noon.",
    receivedAt: AT,
    expect: { type: "event", category: "learning", dateToronto: "2026-11-18", time: "12:00", allDay: false },
    list: true,
  },
  {
    from: "Peer Tutors <tutors@example.org>",
    subject: "Bootcamp",
    body: "Resume bootcamp Oct 10, 6:30 PM in room 210.",
    receivedAt: AT,
    expect: { type: "event", category: "learning", dateToronto: "2026-10-10", time: "18:30", allDay: false },
  },
  {
    from: "Speaker Series <speakers@example.org>",
    subject: "Guest talk",
    body: "Guest speaker talk on October 21 at 7pm about embedded systems.",
    receivedAt: AT,
    expect: { type: "event", category: "learning", dateToronto: "2026-10-21", time: "19:00", allDay: false },
  },
  {
    from: "Grad Society <grad@example.org>",
    subject: "Panel",
    body: "Q&A panel on grad school Oct 15 at 5pm.",
    receivedAt: AT,
    expect: { type: "event", category: "learning", dateToronto: "2026-10-15", time: "17:00", allDay: false },
    list: true,
  },
  {
    from: "Course Staff <staff@example.org>",
    subject: "Office hours moved",
    body: "Office hours moved to Wednesday, Oct 7 at 3pm this week.",
    receivedAt: AT,
    expect: { type: "event", category: "learning", dateToronto: "2026-10-07", time: "15:00", allDay: false },
  },
  /* ================= conference ================= */
  {
    from: "Conf Committee <conf@example.org>",
    subject: "CUSEC",
    body: "The student conference runs Nov 7-8, 2026 downtown.",
    receivedAt: AT,
    expect: { type: "event", category: "conference", dateToronto: "2026-11-07", time: null, allDay: true },
    list: true,
  },
  {
    from: "Sec Club <sec@example.org>",
    subject: "Summit",
    body: "Security summit on October 22 at 9am, badges at the door.",
    receivedAt: AT,
    expect: { type: "event", category: "conference", dateToronto: "2026-10-22", time: "09:00", allDay: false },
  },
  {
    from: "Design Soc <design@example.org>",
    subject: "Symposium",
    body: "Design symposium Oct 30 from 1pm-5pm in the atrium.",
    receivedAt: AT,
    expect: { type: "event", category: "conference", dateToronto: "2026-10-30", time: "13:00", allDay: false },
  },
  {
    from: "Expo Org <expo@example.org>",
    subject: "Game expo",
    body: "Indie game expo on Nov 21 at 11am — demos welcome.",
    receivedAt: AT,
    expect: { type: "event", category: "conference", dateToronto: "2026-11-21", time: "11:00", allDay: false },
    list: true,
  },
  /* ================= competition ================= */
  {
    from: "Biz Club <biz@example.org>",
    subject: "Case comp",
    body: "Case competition on November 14 at 8:30am — teams of four.",
    receivedAt: AT,
    expect: { type: "event", category: "competition", dateToronto: "2026-11-14", time: "08:30", allDay: false },
    list: true,
  },
  {
    from: "Ent Soc <ent@example.org>",
    subject: "Pitch night",
    body: "Pitch night on Oct 23 at 7pm in the black box room.",
    receivedAt: AT,
    expect: { type: "event", category: "competition", dateToronto: "2026-10-23", time: "19:00", allDay: false },
  },
  {
    from: "Incubator <inc@example.org>",
    subject: "Demo day",
    body: "Cohort demo day on December 5.",
    receivedAt: AT,
    expect: { type: "event", category: "competition", dateToronto: "2026-12-05", time: null, allDay: true },
  },
  {
    from: "Chess Club <chess@example.org>",
    subject: "Tournament",
    body: "Chess tournament on Oct 18 from 10am-4pm in the great hall.",
    receivedAt: AT,
    expect: { type: "event", category: "competition", dateToronto: "2026-10-18", time: "10:00", allDay: false },
    list: true,
  },
  /* ================= community ================= */
  {
    from: "Feds <feds@example.org>",
    subject: "Orientation",
    body: "New member orientation on Oct 1 at 9am.",
    receivedAt: AT,
    expect: { type: "event", category: "community", dateToronto: "2026-10-01", time: "09:00", allDay: false },
  },
  {
    from: "Club Pres <pres@example.org>",
    subject: "AGM",
    body: "Our club AGM is October 20 at 6pm — agenda attached.",
    receivedAt: AT,
    expect: { type: "event", category: "community", dateToronto: "2026-10-20", time: "18:00", allDay: false },
    list: true,
  },
  {
    from: "Food Bank <help@example.org>",
    subject: "Volunteer shift",
    body: "Your volunteer shift is Saturday, Oct 3 from 10am-4pm.",
    receivedAt: AT,
    expect: { type: "event", category: "community", dateToronto: "2026-10-03", time: "10:00", allDay: false },
  },
  {
    from: "Charity Ball <ball@example.org>",
    subject: "Fundraiser",
    body: "Charity fundraiser on Nov 8 at 6pm, silent auction after.",
    receivedAt: AT,
    expect: { type: "event", category: "community", dateToronto: "2026-11-08", time: "18:00", allDay: false },
  },
  {
    from: "Registrar <reg@example.org>",
    subject: "Convocation",
    body: "Convocation ceremony on October 24 at 10am in the gym.",
    receivedAt: AT,
    expect: { type: "event", category: "community", dateToronto: "2026-10-24", time: "10:00", allDay: false },
    list: true,
  },
  /* ================= meetings / calls / interviews ================= */
  {
    from: "Study Group <sg@example.org>",
    subject: "Meet-up",
    body: "Can we meet on Oct 3 at 2pm to divide the work?",
    receivedAt: AT,
    expect: { type: "meeting", dateToronto: "2026-10-03", time: "14:00", allDay: false },
    list: true,
  },
  {
    from: "Team Lead <lead@example.org>",
    subject: "Sync call",
    body: "Project sync call on Tuesday, Oct 6 at 4pm.",
    receivedAt: AT,
    expect: { type: "meeting", dateToronto: "2026-10-06", time: "16:00", allDay: false },
  },
  {
    from: "Recruiter R <r@acme.example.com>",
    subject: "Phone screen",
    body: "Your phone screen is on October 7 at 10am.",
    receivedAt: AT,
    expect: { type: "interview", dateToronto: "2026-10-07", time: "10:00", allDay: false },
    list: true,
  },
  {
    from: "Hiring <hiring@acme.example.com>",
    subject: "Technical interview",
    body: "Technical interview on October 13 at 1pm — 60 minutes.",
    receivedAt: AT,
    expect: { type: "interview", dateToronto: "2026-10-13", time: "13:00", allDay: false },
  },
  {
    from: "Old Friend <friend@example.org>",
    subject: "Catch up",
    body: "Catch up over coffee Thursday at 3?",
    receivedAt: AT,
    expect: { type: "meeting", dateToronto: "2026-10-01", time: "15:00", allDay: false },
  },
  {
    from: "Design Team <dt@example.org>",
    subject: "Design review",
    body: "Design review on October 8 at 11am in the crit room.",
    receivedAt: AT,
    expect: { type: "meeting", dateToronto: "2026-10-08", time: "11:00", allDay: false },
  },
  {
    from: "Panel Prep <pp@example.org>",
    subject: "Debrief",
    body: "Interview debrief call on Oct 15 at 2pm.",
    receivedAt: AT,
    expect: { type: "interview", dateToronto: "2026-10-15", time: "14:00", allDay: false },
    list: true,
  },
  {
    from: "Mentor M <m@example.org>",
    subject: "1:1",
    body: "One-on-one meeting on Oct 20 at 9:30am.",
    receivedAt: AT,
    expect: { type: "meeting", dateToronto: "2026-10-20", time: "09:30", allDay: false },
  },
  {
    from: "Recruiter Two <r2@acme.example.com>",
    subject: "Quick call",
    body: "Recruiter call on Nov 3 at 11am about the role.",
    receivedAt: AT,
    expect: { type: "meeting", dateToronto: "2026-11-03", time: "11:00", allDay: false },
  },
  {
    from: "Lab Partner <lab@example.org>",
    subject: "Zoom",
    body: "Zoom catch-up on October 5 at 4pm — link in thread.",
    receivedAt: AT,
    expect: { type: "meeting", dateToronto: "2026-10-05", time: "16:00", allDay: false },
  },
  {
    from: "Screen Team <screen@acme.example.com>",
    subject: "Screening call",
    body: "Screening call with the hiring team on October 9 at 10:30am.",
    receivedAt: AT,
    expect: { type: "interview", dateToronto: "2026-10-09", time: "10:30", allDay: false },
  },
  {
    from: "Team T <t@example.org>",
    subject: "Standup",
    body: "Daily standup meeting on Oct 6 at 9am.",
    receivedAt: AT,
    expect: { type: "meeting", dateToronto: "2026-10-06", time: "09:00", allDay: false },
  },
  /* ================= deadlines ================= */
  {
    from: "Co-op Office <coop@example.org>",
    subject: "Apply soon",
    body: "Applications for the winter program close November 1.",
    receivedAt: AT,
    expect: { type: "deadline", dateToronto: "2026-11-01", time: null, allDay: true },
    list: true,
  },
  {
    from: "Ball Committee <bc@example.org>",
    subject: "RSVP",
    body: "Please RSVP for the banquet by October 20.",
    receivedAt: AT,
    expect: { type: "deadline", dateToronto: "2026-10-20", time: null, allDay: true },
  },
  {
    from: "no-reply@confreg.example.com",
    subject: "Last call",
    body: "Registration closes on October 30. Register today!",
    receivedAt: AT,
    expect: { type: "deadline", dateToronto: "2026-10-30", time: null, allDay: true },
    list: true,
  },
  {
    from: "Awards <awards@example.org>",
    subject: "Scholarship",
    body: "Apply for the entrance scholarship before Nov 15.",
    receivedAt: AT,
    expect: { type: "deadline", dateToronto: "2026-11-15", time: null, allDay: true },
  },
  {
    from: "Symposium <sym@example.org>",
    subject: "Abstracts",
    body: "Abstract submissions are due October 31.",
    receivedAt: AT,
    expect: { type: "deadline", dateToronto: "2026-10-31", time: null, allDay: true },
  },
  {
    from: "Tour Desk <tour@example.org>",
    subject: "Tour sign-up",
    body: "Sign up for the lab tour by Friday, Oct 9.",
    receivedAt: AT,
    expect: { type: "deadline", dateToronto: "2026-10-09", time: null, allDay: true },
  },
  {
    from: "Hack Org <hack@example.org>",
    subject: "Team entries",
    body: "Hackathon team entries close Oct 27.",
    receivedAt: AT,
    expect: { type: "deadline", dateToronto: "2026-10-27", time: null, allDay: true },
  },
  {
    from: "Survey Team <survey@example.org>",
    subject: "Survey",
    body: "Your response is due November 10 — it only takes a minute.",
    receivedAt: AT,
    expect: { type: "deadline", dateToronto: "2026-11-10", time: null, allDay: true },
  },
  /* ================= pick-a-slot tasks ================= */
  {
    from: "CECA Hub <ceca@uwaterloo.ca>",
    subject: "Selected for an interview",
    body: "Congratulations — you were selected for an interview. Please select an interview time slot in WaterlooWorks.",
    receivedAt: AT,
    expect: { type: "task", category: "book-call", dateToronto: "2026-09-30", time: "17:00", allDay: false },
  },
  {
    from: "Employer ATS <ats@acme.example.com>",
    subject: "Interview scheduling",
    body: "Next step: select your interview slot before Friday.",
    receivedAt: AT,
    expect: { type: "task", category: "book-call", dateToronto: "2026-09-30", time: "17:00", allDay: false },
  },
  {
    from: "Hiring Ops <ops@acme.example.com>",
    subject: "Interview",
    body: "Choose a time for your interview with the team.",
    receivedAt: AT,
    expect: { type: "task", category: "book-call", dateToronto: "2026-09-30", time: "17:00", allDay: false },
  },
  {
    from: "Scheduler <sched@acme.example.com>",
    subject: "Interview times",
    body: "Please sign up for a slot for your onsite interview.",
    receivedAt: AT,
    expect: { type: "task", category: "book-call", dateToronto: "2026-09-30", time: "17:00", allDay: false },
  },
  /* ================= negatives — promos ================= */
  {
    from: "no-reply@shop.example.com",
    subject: "Sale ends Friday",
    body: "Huge sale ends Friday — don't miss 40% off everything.",
    receivedAt: AT,
    expect: "none",
    list: true,
  },
  {
    from: "deals@mart.example.com",
    subject: "Expires soon",
    body: "This offer expires Oct 3. Shop now and save.",
    receivedAt: AT,
    expect: "none",
    list: true,
  },
  {
    from: "promo@store.example.com",
    subject: "Last chance",
    body: "Last chance — the deal ends Oct 5 at midnight.",
    receivedAt: AT,
    expect: "none",
  },
  {
    from: "Coupon Bot <coupons@example.com>",
    subject: "Coupon",
    body: "Your 20% off coupon is good through October 11.",
    receivedAt: AT,
    expect: "none",
  },
  {
    from: "A Friend <pal@example.org>",
    subject: "Sidewalk sale",
    body: "The sale ends October 3 if you want to check it out.",
    receivedAt: AT,
    expect: "none",
  },
  /* ================= negatives — shipping ================= */
  {
    from: "no-reply@ship.example.com",
    subject: "Arriving Tuesday",
    body: "Your order is arriving Tuesday. Track your package here.",
    receivedAt: AT,
    expect: "none",
    list: true,
  },
  {
    from: "no-reply@post.example.com",
    subject: "Delivered",
    body: "Delivered Oct 2 — your package was left at the door.",
    receivedAt: AT,
    expect: "none",
    list: true,
  },
  {
    from: "courier@ship.example.com",
    subject: "Delivery window",
    body: "Delivery scheduled for Oct 7 between 9am and 5pm.",
    receivedAt: AT,
    expect: "none",
  },
  {
    from: "orders@mart.example.com",
    subject: "Order confirmed",
    body: "Order confirmed — it ships October 6 and arrives within a week.",
    receivedAt: AT,
    expect: "none",
  },
  /* ================= negatives — billing ================= */
  {
    from: "no-reply@bank.example.com",
    subject: "Payment due",
    body: "Your payment is due October 5. Pay online to avoid fees.",
    receivedAt: AT,
    expect: "none",
    list: true,
  },
  {
    from: "billing@saas.example.com",
    subject: "Invoice",
    body: "Your invoice for September is attached — due Oct 10.",
    receivedAt: AT,
    expect: "none",
    list: true,
  },
  {
    from: "receipts@mart.example.com",
    subject: "Receipt",
    body: "Receipt for your order — card charged Oct 1.",
    receivedAt: AT,
    expect: "none",
  },
  {
    from: "Tuition <fees@example.org>",
    subject: "Balance",
    body: "A balance is posted to your account, due October 15.",
    receivedAt: AT,
    expect: "none",
  },
  /* ================= negatives — security ================= */
  {
    from: "no-reply@auth.example.com",
    subject: "Security code",
    body: "Your security code is 452931. It expires October 1 at noon.",
    receivedAt: AT,
    expect: "none",
    list: true,
  },
  {
    from: "no-reply@idp.example.com",
    subject: "Password reset",
    body: "A password reset was requested on October 1. Ignore if not you.",
    receivedAt: AT,
    expect: "none",
    list: true,
  },
  {
    from: "alerts@mail.example.com",
    subject: "Sign-in alert",
    body: "New sign-in attempt on October 2 — was this you?",
    receivedAt: AT,
    expect: "none",
  },
  /* ================= negatives — social notifications ================= */
  {
    from: "no-reply@network.example.com",
    subject: "Profile views",
    body: "3 people viewed your profile on October 2.",
    receivedAt: AT,
    expect: "none",
    list: true,
  },
  {
    from: "no-reply@social.example.com",
    subject: "New requests",
    body: "You have 3 new connection requests — respond by Oct 9.",
    receivedAt: AT,
    expect: "none",
  },
  /* ================= negatives — renewals/subscriptions ================= */
  {
    from: "no-reply@stream.example.com",
    subject: "Renews soon",
    body: "Your subscription renews October 15 — manage your plan.",
    receivedAt: AT,
    expect: "none",
    list: true,
  },
  {
    from: "no-reply@app.example.com",
    subject: "Trial ending",
    body: "Your free trial ends October 8 — keep your membership active.",
    receivedAt: AT,
    expect: "none",
  },
  /* ================= negatives — newsletters / past dates / loose dates ================= */
  {
    from: "news@digest.example.com",
    subject: "Weekly digest",
    body: "This week in tech: read the October 5 edition of our newsletter.",
    receivedAt: AT,
    expect: "none",
    list: true,
  },
  {
    from: "Club News <news@club.example.org>",
    subject: "September newsletter",
    body: "The workshop on September 20 was a blast — photos inside. Unsubscribe.",
    receivedAt: AT,
    expect: "none",
  },
  {
    from: "Old Pal <pal2@example.org>",
    subject: "Last week",
    body: "Great concert last Saturday, Sep 26 — thanks for coming!",
    receivedAt: AT,
    expect: "none",
  },
  {
    from: "no-reply@club.example.org",
    subject: "Reminder",
    body: "Reminder: the mixer is this Friday at 6. Unsubscribe from these emails.",
    receivedAt: AT,
    expect: "none", // bulk + relative date only — no explicit calendar date
    list: true,
  },
  {
    from: "no-reply@tickets.example.com",
    subject: "Your ticket",
    body: "Your ticket is ready — see you this Friday at 6. Unsubscribe.",
    receivedAt: AT,
    expect: "none", // confirm phrase but no explicit calendar date in the hit
    list: true,
  },
  {
    from: "Roommate <roomie@example.org>",
    subject: "Rent",
    body: "Rent payment due October 1 — e-transfer when you can.",
    receivedAt: AT,
    expect: "none",
  },
];

/** Every item a message can yield (mail items + tasks), as an opened message. */
const runCase = (c, { asList = false } = {}) => {
  const { name, email } = senderOf(c.from);
  /** @type {any} */
  const m = {
    key: `corpus-${ALL.indexOf(c)}`,
    url: "https://mail.google.com/mail/u/0/#inbox/corpus",
    from: name,
    fromEmail: email,
    subject: c.subject,
    preview: c.body.slice(0, 200),
    receivedAt: c.receivedAt,
    links: [],
  };
  if (!asList) m.body = c.body;
  const now = new Date(c.receivedAt);
  const opts = {
    provider: "gmail",
    now,
    courses: [],
    settings: {},
    applications: [],
    at: c.receivedAt,
  };
  const mailItems = itemsFromMessage(m, opts);
  // List rows run the important-mail extraction only — tasks need the body.
  const tasks = asList
    ? { items: /** @type {any[]} */ ([]) }
    : taskItems(
        [{ m, items: mailItems }],
        { view: "message", folder: "inbox", allowed: true },
        {},
        opts,
      );
  return [...mailItems, ...tasks.items];
};

const checkCase = (c, items, label) => {
  if (c.expect === "none") {
    assert.equal(items.length, 0, `${label}: expected no items, got ${JSON.stringify(items.map((i) => [i.type, i.title]))}`);
    return;
  }
  const e = c.expect;
  const hit = items.find(
    (i) =>
      i.type === e.type &&
      (e.category === undefined || i.category === e.category) &&
      dayOf(i.startAt || i.dueAt || "") === e.dateToronto,
  );
  assert.ok(hit, `${label}: no ${e.type}/${e.category || "*"} on ${e.dateToronto} in ${JSON.stringify(items.map((i) => [i.type, i.category, i.title]))}`);
  assert.equal(hit.allDay === true, e.allDay, `${label}: allDay`);
  if (e.time == null) return;
  assert.equal(timeOf(hit.startAt || hit.dueAt), e.time, `${label}: time`);
};

// ---- the corpus -----------------------------------------------------------

const counts = { total: ALL.length, event: 0, meetingish: 0, deadline: 0, task: 0, none: 0, list: 0 };
const groups = new Set();

test("email corpus: every case as an opened message", async (t) => {
  for (const c of ALL) {
    await t.test(`${c.subject} [${ALL.indexOf(c)}]`, () => {
      checkCase(c, runCase(c), c.subject);
    });
    if (c.expect === "none") counts.none++;
    else {
      if (c.expect.type === "event") {
        counts.event++;
        if (c.expect.category) groups.add(c.expect.category);
      }
      if (["meeting", "interview"].includes(c.expect.type)) counts.meetingish++;
      if (c.expect.type === "deadline") counts.deadline++;
      if (c.expect.type === "task") counts.task++;
    }
    if (c.list) counts.list++;
  }
});

test("email corpus: coverage floors", () => {
  console.log(
    `corpus counts: total=${counts.total} events=${counts.event} ` +
      `groups=[${[...groups].sort().join(",")}] meetings/interviews=${counts.meetingish} ` +
      `deadlines=${counts.deadline} tasks=${counts.task} none=${counts.none} listRows=${counts.list}`,
  );
  assert.ok(counts.event >= 30, `events ${counts.event} < 30`);
  for (const g of ["hack", "social", "career", "learning", "conference", "competition", "community"]) {
    assert.ok(groups.has(g), `group ${g} uncovered`);
  }
  assert.ok(counts.meetingish >= 10, `meetings/interviews ${counts.meetingish} < 10`);
  assert.ok(counts.deadline >= 6, `deadlines ${counts.deadline} < 6`);
  assert.ok(counts.none >= 25, `negatives ${counts.none} < 25`);
});

test("email corpus: list-row runs (subject + preview only)", async (t) => {
  const listCases = ALL.filter((c) => c.list);
  assert.ok(listCases.length >= 20, `list-row subset ${listCases.length} < 20`);
  for (const c of listCases) {
    await t.test(`list ${c.subject}`, () => {
      checkCase(c, runCase(c, { asList: true }), `list ${c.subject}`);
    });
  }
});
