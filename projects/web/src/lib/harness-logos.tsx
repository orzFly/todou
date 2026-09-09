/*
 * Harness brand marks for the agent badge, re-exported from
 * @lobehub/icons-static-svg so upstream owns the artwork and its updates.
 *
 * That package is the plain-SVG sibling of @lobehub/icons: 903 `currentColor`
 * files on a 24×24 grid and nothing else — no dependencies, no peers, no React.
 * (It is @lobehub/icons, the component package, that peer-depends on antd and
 * @lobehub/ui.) Vite's svgr plugin compiles each `?react` import into a
 * component that spreads props onto its <svg>, which is what lets the badge
 * attach its own sizing class, test id, and aria-hidden.
 *
 * LICENCE NOTICE, and this is the only copy of it: the build inlines these
 * paths into the app bundle, and the published package ships no LICENSE file
 * of its own — only `"license": "MIT"` in its package.json — so MIT's
 * requirement that the notice travel with the copy lands here, on the module
 * that pulls the artwork in.
 *
 * MIT License, Copyright (c) 2023 LobeHub. Permission is hereby granted, free
 * of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software,
 * and to permit persons to whom the Software is furnished to do so, subject to
 * the following conditions: The above copyright notice and this permission
 * notice shall be included in all copies or substantial portions of the
 * Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
 * EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 * USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * A licence over a collection of brand icons is not a trademark grant from the
 * brands themselves, so these stay in their role as marks of provenance.
 */
import type { SVGProps } from "react";

export { default as ClaudeMark } from "@lobehub/icons-static-svg/icons/claude.svg?react";
export { default as CodexMark } from "@lobehub/icons-static-svg/icons/codex.svg?react";
export { default as HermesMark } from "@lobehub/icons-static-svg/icons/hermesagent.svg?react";
export { default as PiMark } from "@lobehub/icons-static-svg/icons/pi.svg?react";

/*
 * omp (can1357/oh-my-pi), the one mark the collection above does not carry.
 * Upstream publishes no vector either — only a raster banner — so the glyph
 * is reproduced here as the geometry it is: a bar and two legs forming a π,
 * whose proportions were measured off that banner (bar 44×9, legs 9 wide at
 * x-offsets 6 and 24, dropping 31 and 42 from the top edge). The banner's
 * magenta-to-blue gradient is dropped for `currentColor`, because the badge
 * owns the colour of every mark it shows.
 *
 * Same caveat as the collection above: oh-my-pi is MIT, and a code licence is
 * not a trademark grant from the brand owner. It stays in its role as a mark
 * of provenance.
 *
 * `title` behaves the way svgr's titleProp makes it behave on the marks
 * beside it — rendered when given, absent when empty — so the badge's
 * `title=""` drops it here too rather than being silently ignored.
 */
export function OmpMark({
  title,
  ...props
}: SVGProps<SVGSVGElement> & { title?: string }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: the title is a prop here, as it is on every mark beside this one, and the badge passes an empty one because it spells the harness out in text
    <svg viewBox="0 0 64 64" fill="currentColor" {...props}>
      {title ? <title>{title}</title> : null}
      <path d="M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z" />
    </svg>
  );
}
