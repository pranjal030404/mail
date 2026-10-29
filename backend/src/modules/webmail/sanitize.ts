import sanitizeHtml from 'sanitize-html';

export interface SanitizedBody {
  html: string | null;
  text: string;
  /** Remote images removed because the user has not opted in to loading them. */
  remoteImagesBlocked: number;
}

const ALLOWED_TAGS = [
  'a', 'abbr', 'address', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup',
  'dd', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol',
  'p', 'pre', 's', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'u', 'ul',
];

/**
 * Sanitises message HTML for rendering inside a sandboxed iframe.
 *
 * - scripts, styles, forms, frames, objects and event handlers are removed
 * - only http/https/mailto/tel links are allowed
 * - remote images are stripped unless the user explicitly asked to load them; `cid:` images are
 *   dropped too because the proxy does not expose inline parts as URLs
 * - links open in a new tab with no opener
 */
export function sanitizeMessageHtml(input: string, opts: { blockRemoteImages: boolean }): { html: string; remoteImagesBlocked: number } {
  let remoteImagesBlocked = 0;
  const html = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      td: ['colspan', 'rowspan', 'align', 'valign'],
      th: ['colspan', 'rowspan', 'align', 'valign'],
      table: ['border', 'cellpadding', 'cellspacing', 'width', 'align'],
      col: ['span', 'width'],
      colgroup: ['span', 'width'],
      ol: ['start', 'type'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
      img: (tagName, attribs) => {
        const src = attribs.src ?? '';
        const remote = /^https?:\/\//i.test(src);
        if (remote && opts.blockRemoteImages) {
          remoteImagesBlocked++;
          return { tagName, attribs: { alt: attribs.alt ?? 'Remote image blocked', ...(attribs.width ? { width: attribs.width } : {}), ...(attribs.height ? { height: attribs.height } : {}) } };
        }
        if (src.startsWith('cid:')) {
          return { tagName, attribs: { alt: attribs.alt ?? 'Inline image' } };
        }
        return { tagName, attribs };
      },
    },
  });
  return { html, remoteImagesBlocked };
}

/** Plain text from HTML for previews and text-only clients. No tags survive. */
export function htmlToText(input: string): string {
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} })
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeBody(html: string | null, text: string, opts: { blockRemoteImages: boolean }): SanitizedBody {
  if (!html) return { html: null, text, remoteImagesBlocked: 0 };
  const sanitized = sanitizeMessageHtml(html, opts);
  return { html: sanitized.html, text: text || htmlToText(html), remoteImagesBlocked: sanitized.remoteImagesBlocked };
}
