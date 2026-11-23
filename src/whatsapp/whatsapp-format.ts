// The model writes Markdown, WhatsApp has its own marks: *bold*, _italic_,
// ~strike~. A Markdown **SANDWICH** shows on the phone as *SANDWICH* with the
// outer stars visible, so every reply is rewritten into WhatsApp's marks
// before it goes out.
export function toWhatsAppFormat(text: string): string {
  return (
    text
      // Headings: "## Menu" → "*Menu*".
      .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_, title: string) =>
        `*${stripStars(title)}*`,
      )
      // Bold, also when the model wraps an already-starred title: "***x***",
      // "**x**", "__x__" → "*x*".
      .replace(/\*{2,}([^*\n]+?)\*{2,}/g, '*$1*')
      .replace(/(^|[^\w])__([^_\n]+?)__(?!\w)/g, '$1*$2*')
      // Strikethrough: "~~x~~" → "~x~".
      .replace(/~~([^~\n]+?)~~/g, '~$1~')
      // Links: "[Menu](https://x)" → "Menu: https://x"; a bare repeated url
      // stays one url.
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) =>
        label === url ? url : `${label}: ${url}`,
      )
      // Horizontal rules show as a row of dashes or stars.
      .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
      // Bullets "* item" read as a stray bold mark: use "- item".
      .replace(/^([ \t]*)\*[ \t]+/gm, '$1- ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

const stripStars = (text: string) => text.replace(/^\*+|\*+$/g, '').trim();
