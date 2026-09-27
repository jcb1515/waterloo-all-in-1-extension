// @ts-check
/*
  PDF -> plain text, via pdfjs-dist's legacy build (works in Node and in the
  extension's offscreen/options pages). Text items are rebuilt into lines by
  y-position and hasEOL; pages are joined with a blank line.
*/

/** @param {Uint8Array} bytes @returns {Promise<string>} */
export async function pdfText(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const init = /** @type {any} */ ({ data: bytes, isEvalSupported: false, useSystemFonts: true });
  const doc = await pdfjs.getDocument(init).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    /** @type {string[]} */
    const lines = [];
    let cur = "";
    /** @type {number|null} */
    let lastY = null;
    /** @type {number|null} */
    let lastX = null;
    for (const item of items) {
      if (!("str" in item)) continue; // TextMarkedContent
      if (!item.str) {
        if (item.hasEOL) {
          lines.push(cur);
          cur = "";
          lastY = null;
        }
        continue;
      }
      const y = item.transform[5];
      const x = item.transform[4];
      const newLine = lastY !== null && Math.abs(y - lastY) > 1;
      if (newLine) {
        lines.push(cur);
        cur = "";
      } else if (lastX !== null && cur && !cur.endsWith(" ")) {
        // A horizontal gap between items on one line is a space (or a column).
        const gap = x - lastX;
        if (gap > 0.5) cur += gap > 12 ? "\t" : " ";
      }
      cur += item.str;
      lastY = y;
      lastX = x + (item.width || 0);
      if (item.hasEOL) {
        lines.push(cur);
        cur = "";
        lastY = null;
        lastX = null;
      }
    }
    if (cur.trim()) lines.push(cur);
    pages.push(lines.join("\n"));
  }
  return pages.join("\n\n");
}
