/**
 * Build-time patch for the bundled ai-gateway runtime.
 *
 * Why this exists
 * ---------------
 * `next-ai-gateway.js` (and its build input `node_modules/@the-next-ai/ai-gateway`)
 * is a **minified third-party bundle**, not part of this repo's TS sources. It ships:
 *
 *   1. No upstream status on the virtual-model buffered path → `request_logs.status_code`
 *      stays 0 for every recall/Fusion turn even though the client got HTTP 200.
 *   2. No report of internally-injected tool content → `compression_recall_tokens` is
 *      always 0 even when the model really recalled compressed history.
 *
 * `patches/ai-gateway/0003-*` and `patches/ai-gateway/0004-*` carry the *source* form of
 * these fixes for a gateway source build. This file is the **runtime** counterpart: it
 * applies the same two edits directly to the installed `dist/index.js` so that the
 * esbuild step (which bundles that input into `next-ai-gateway.js`) produces a patched
 * bundle on every rebuild — no manual re-patching after the dev watcher restarts.
 *
 * The anchors below are matched whitespace-insensitively because the two shipped
 * minifier variants (dist/index.js vs. the bundle) differ only in whitespace/spacing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);

/** Collapse every run of whitespace so anchors match regardless of minifier spacing. */
function squeeze(source) {
  return source.replace(/\s+/g, " ");
}

/**
 * Apply `edits` to `source`. Each edit is a [from, to] pair; both are whitespace-
 * normalized before matching. Throws if an anchor is missing so a gateway upgrade that
 * renames things fails loudly instead of silently no-op'ing.
 */
function applyEdits(source, edits, label) {
  return replaceAllNormalized(source, edits, label);
}

/**
 * Replace `from` → `to` in `source`, tolerating differing whitespace between the two
 * needles: normalize the anchor to a single space and build a regex that allows any
 * whitespace between tokens. The two shipped minifier variants differ only in spacing.
 */
function replaceAllNormalized(source, edits, label = "ai-gateway") {
  let out = source;
  for (const [from, to] of edits) {
    const tokens = squeeze(from).trim().split(" ");
    const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
    const re = new RegExp(pattern, "g");
    const before = out;
    out = out.replace(re, () => to);
    if (out === before) {
      throw new Error(`[patch-gateway] ${label}: replacement had no effect for: ${from.slice(0, 80)}`);
    }
  }
  return out;
}

const STATUS_AND_RECALL_EDITS = [
  // 1) sender gains two params: upstream status (yy) + per-call injected chars (zz)
  [
    "function _P(e,n,t,r,o,i,s,a,u,d,c,f,g,y){",
    "function _P(e,n,t,r,o,i,s,a,u,d,c,f,g,y,yy,zz){"
  ],
  // 2) declaration block gains the accumulator + helper (dR / Do)
  [
    "ce={},se=[],oe=[],Z=0,X,te,xe=0,mn=!0",
    "ce={},se=[],oe=[],Do={},Z=0,X,te,xe=0,mn=!0,dR=function(cs,rs){for(var a=0;a<cs.length;a++){var c=cs[a];for(var b=0;b<rs.length;b++){var r=rs[b];if(r&&r.is_error!==true&&typeof r.content===\"string\"&&r.tool_use_id===c.call_id){Do[c.name]=(Do[c.name]||0)+r.content.length}}}}"
  ],
  // 3) both send call sites pass (Se.status, Do)
  [
    "_P(n,e,t,r,i,A,O,R.length,xe,CP(d.profile,Dc(te,k.toolOwners,ce),se,oe),u,j,_,X)",
    "_P(n,e,t,r,i,A,O,R.length,xe,CP(d.profile,Dc(te,k.toolOwners,ce),se,oe),u,j,_,X,Se.status,Do)"
  ],
  // 4) heuristics: accumulate injected chars before pushing internal results
  [
    "se.push(...Ue.internal),oe.push(...de)",
    "dR(Ue.internal,de),se.push(...Ue.internal),oe.push(...de)"
  ],
  [
    "se.push(...Ue.internal),oe.push(...or),ce=Yi(ce,Lc(d.profile,Ue.internal)),E=rm(E,te,Ue.internal,or)",
    "dR(Ue.internal,or),se.push(...Ue.internal),oe.push(...or),ce=Yi(ce,Lc(d.profile,Ue.internal)),E=rm(E,te,Ue.internal,or)"
  ],
  // 5) attach status + injection chars to both raw-trace captures
  [
    "{upstreamRequest:y,upstreamResponseBody:k}",
    "{upstreamRequest:y,upstreamResponseBody:k,internalToolInjectionChars:zz,upstreamResponseStatus:yy}"
  ],
  [
    "{upstreamRequest:y,upstreamResponseBody:h}",
    "{upstreamRequest:y,upstreamResponseBody:h,internalToolInjectionChars:zz,upstreamResponseStatus:yy}"
  ],
  // 6) emit the internal_tool_stats raw-trace part right after upstream_response_metadata
  [
    'partType:"upstream_response_metadata",content:Wi(n.rawTrace.mode,{statusCode:i.upstreamResponseStatus,headers:i.upstreamResponseHeaders}),contentType:"application/json; charset=utf-8",redactionPolicy:s}',
    'partType:"upstream_response_metadata",content:Wi(n.rawTrace.mode,{statusCode:i.upstreamResponseStatus,headers:i.upstreamResponseHeaders}),contentType:"application/json; charset=utf-8",redactionPolicy:s},{partType:"internal_tool_stats",content:Wi(n.rawTrace.mode,{injectedChars:i.internalToolInjectionChars}),contentType:"application/json; charset=utf-8",redactionPolicy:s}'
  ]
];

/** Resolve the installed ai-gateway dist bundle, or undefined when not installed. */
export function resolveInstalledGatewayDist(projectRoot) {
  for (const pkg of ["@the-next-ai/ai-gateway", "gateway"]) {
    // The package's `exports` map only exposes ".", so resolve the package entry and
    // then read its sibling dist/main file directly.
    try {
      const entry = requireFromHere.resolve(pkg, { paths: [projectRoot] });
      // entry points at dist/index.js (package "main"); patch that file.
      return entry;
    } catch {
      // try next
    }
  }
  return undefined;
}

export function patchInstalledGateway(projectRoot, { log = console.log } = {}) {
  const distFile = resolveInstalledGatewayDist(projectRoot);
  if (!distFile) {
    log("[patch-gateway] ai-gateway dist not found; skipping (source build unaffected).");
    return { applied: false, file: undefined };
  }
  const original = readFileSync(distFile, "utf8");
  if (original.includes("internal_tool_stats")) {
    log(`[patch-gateway] already patched: ${distFile}`);
    return { applied: false, file: distFile };
  }
  const patched = applyEdits(original, STATUS_AND_RECALL_EDITS, "ai-gateway");
  writeFileSync(distFile, patched);
  log(`[patch-gateway] applied remote status + internal_tool_stats patch: ${distFile}`);
  return { applied: true, file: distFile };
}
