import { describe, expect, it } from 'vitest';
import { htmlToText, sanitizeBody, sanitizeMessageHtml } from './sanitize.js';

describe('webmail HTML sanitisation', () => {
  it('removes scripts, event handlers, forms and frames', () => {
    const { html } = sanitizeMessageHtml(
      `<p onclick="steal()">Hello</p><script>alert(1)</script><iframe src="https://evil.test"></iframe><form action="https://evil.test"><input name="x"></form><object data="x"></object><img src="https://track.test/p.gif" onerror="x()">`,
      { blockRemoteImages: false },
    );
    expect(html).not.toMatch(/script/i);
    expect(html).not.toMatch(/onclick|onerror/i);
    expect(html).not.toMatch(/iframe|object|form/i);
    expect(html).toContain('Hello');
    expect(html).toContain('img');
  });

  it('blocks remote images by default and counts them', () => {
    const { html, remoteImagesBlocked } = sanitizeMessageHtml(
      `<p>x</p><img src="https://cdn.test/a.png" alt="logo"><img src="https://cdn.test/b.png">`,
      { blockRemoteImages: true },
    );
    expect(remoteImagesBlocked).toBe(2);
    expect(html).not.toContain('https://cdn.test');
    expect(html).toContain('logo');
  });

  it('allows remote images only when the user opted in', () => {
    const { html, remoteImagesBlocked } = sanitizeMessageHtml(`<img src="https://cdn.test/a.png" alt="logo">`, { blockRemoteImages: false });
    expect(remoteImagesBlocked).toBe(0);
    expect(html).toContain('https://cdn.test/a.png');
  });

  it('drops cid: images because inline parts are not proxied as URLs', () => {
    const { html } = sanitizeMessageHtml(`<img src="cid:logo@x" alt="inline">`, { blockRemoteImages: true });
    expect(html).not.toContain('cid:');
  });

  it('neutralises javascript: links and hardens normal links', () => {
    const { html } = sanitizeMessageHtml(`<a href="javascript:alert(1)">bad</a><a href="https://example.test">good</a>`, { blockRemoteImages: true });
    expect(html).not.toContain('javascript:');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
  });

  it('produces a text fallback', () => {
    expect(htmlToText('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
    const body = sanitizeBody('<p>Hi</p>', '', { blockRemoteImages: true });
    expect(body.text).toBe('Hi');
  });
});
