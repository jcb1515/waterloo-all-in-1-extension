// @ts-check
// Every Gmail/Outlook-web selector the DOM reader uses, in one place. All
// best guesses from the structural discovery captures — see README "needs
// tuning".

export const GMAIL = {
  listRow: "tr.zA",
  threadId: "[data-legacy-thread-id]",
  sender: ".yW [email]",
  subject: ".bog",
  preview: ".y2",
  date: ".xW span[title]",
  msgSubject: "h2.hP",
  msg: "div.adn, [data-legacy-message-id]",
  msgFrom: ".gD[email]",
  msgDate: ".g3[title]",
  msgBody: ".a3s",
};

export const OUTLOOK = {
  listRow: '[role="option"][data-convid]',
  listRowAny: "[data-convid]",
  main: '[role="main"]',
  heading: '[role="heading"]',
  body: '[aria-label="Message body"]',
  sender: 'span[title*="@"]',
  sentTime: '[data-testid="SentReceivedSavedTime"]',
  selected: '[data-convid][aria-selected="true"]',
};

// Invite cards have no stable classes — they are found by line shape
// (CARD_*_RE in rules.js) inside this scope; `.a3s` is excluded on Gmail.
export const CARD = {
  main: '[role="main"]',
};
