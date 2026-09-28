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

// The signed-in account — read only to recognise the user's own messages
// (fromMe); the address is compared in memory and never emitted.
export const ACCOUNT = {
  // Gmail: aria-label "Google Account: <name> (<email>)".
  gmail: 'a[aria-label^="Google Account:"]',
  // OWA: the account's folder-tree root carries the address in
  // data-folder-name/title (the me-control only shows the display name).
  // Keep the older me-control selectors as fallbacks.
  outlook:
    '[role="treeitem"][data-folder-name*="@"], #mectrl_currentAccount_secondary, [data-testid="mectrl_currentAccount_secondary"], header button[aria-label*="@"]',
};

// Quoted-history containers stripped out of body text so old asks don't
// look new.
export const QUOTE_SEL = ".gmail_quote, blockquote, [id^='divRplyFwdMsg']";
