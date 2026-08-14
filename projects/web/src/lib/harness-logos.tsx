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
export { default as ClaudeMark } from "@lobehub/icons-static-svg/icons/claude.svg?react";
export { default as HermesMark } from "@lobehub/icons-static-svg/icons/hermesagent.svg?react";
