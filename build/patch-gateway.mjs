/**
 * Build-time patch for the bundled ai-gateway runtime.
 *
 * Why this exists
 * ---------------
 * `next-ai-gateway.js` is a **minified third-party bundle** (built from
 * `node_modules/@the-next-ai/ai-gateway/dist/index.js`), not part of this repo's
 * sources. Upstream it ships without:
 *
 *   1. the upstream HTTP status on the virtual-model buffered path → every recall /
 *      Fusion turn records `request_logs.status_code = 0` despite an HTTP 200; and
 *   2. any report of internally-injected tool content → `compression_recall_tokens`
 *      stays 0 even when the model actually recalled compressed history.
 *
 * `patches/ai-gateway/0003-*` / `0004-*` carry the *source* form for a gateway source
 * build. This file is the **runtime** counterpart: it edits the installed minified dist
 * so that esbuild (which bundles that dist into `next-ai-gateway.js`) emits a patched
 * bundle on every rebuild — the dev watcher can no longer silently revert the fixes.
 *
 * Anchors are matched whitespace-insensitively (the two shipped minifier variants differ
 * only in spacing). The recall accumulator runs inside the existing comma-sequence
 * statement at each internal-result push site, so esbuild's own minify pass keeps it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);

/** Collapse every run of whitespace so anchors match regardless of minifier spacing. */
function squeeze(source) {
  return source.replace(/\s+/g, " ");
}

/**
 * Replace each [from, to] in `source`, tolerating arbitrary whitespace inside `from`.
 * The anchor is normalized to single spaces and compiled to a regex allowing `\s*`
 * between tokens. Throws if an anchor is missing or matched nothing, so a gateway
 * upgrade that renames things fails loudly instead of silently no-op'ing.
 */
function applyEdits(source, edits, label) {
  let out = source;
  for (const [from, to] of edits) {
    const tokens = squeeze(from).trim().split(" ");
    const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
    const re = new RegExp(pattern, "g");
    const before = out;
    out = out.replace(re, () => to);
    if (out === before) {
      throw new Error(`[patch-gateway] ${label}: anchor not found / no effect: ${from.slice(0, 90)}`);
    }
  }
  return out;
}

const GATEWAY_EDITS = [
  // 1) sender gains two params: upstream status + injected-chars map
  [
    "function _P(e,n,t,r,o,i,s,a,u,d,c,f,g,y){",
    "function _P(e,n,t,r,o,i,s,a,u,d,c,f,g,y,yy,zz){"
  ],
  // 2) accumulator map declared alongside the other loop locals (valid inside the
  //    surrounding `let a=1, b=2, ...` list).
  [
    "ce={},se=[],oe=[],Z=0,X,te,xe=0,mn=!0",
    "ce={},se=[],oe=[],Do={},Z=0,X,te,xe=0,mn=!0"
  ],
  // 3) accumulator side effects attached to the internal-result push sites. Written as
  //    `dR(...)` on the existing comma sequence so it sits inside a statement.
  [
    "se.push(...Ue.internal),oe.push(...de)",
    `dR(Ue.internal,de),se.push(...Ue.internal),oe.push(...de)`
  ],
  [
    "se.push(...Ue.internal),oe.push(...or),ce=Yi(ce,Lc(d.profile,Ue.internal)),E=rm(E,te,Ue.internal,or)",
    `dR(Ue.internal,or),se.push(...Ue.internal),oe.push(...or),ce=Yi(ce,Lc(d.profile,Ue.internal)),E=rm(E,te,Ue.internal,or)`
  ],
  // 3b) the helper itself, declared as another loop local.
  [
    "ce={},se=[],oe=[],Do={},Z=0,X,te,xe=0,mn=!0",
    "ce={},se=[],oe=[],Do={},Z=0,X,te,xe=0,mn=!0,dR=function(cs,rs){for(var a=0;a<cs.length;a++){var c=cs[a];for(var b=0;b<rs.length;b++){var r=rs[b];if(r&&r.is_error!==true&&typeof r.content===\"string\"&&r.tool_use_id===c.call_id){Do[c.name]=(Do[c.name]||0)+r.content.length}}}}"
  ],
  // 3) both send call sites pass (last upstream status, current recall map)
  [
    "_P(n,e,t,r,i,A,O,R.length,xe,CP(d.profile,Dc(te,k.toolOwners,ce),se,oe),u,j,_,X)",
    "_P(n,e,t,r,i,A,O,R.length,xe,CP(d.profile,Dc(te,k.toolOwners,ce),se,oe),u,j,_,X,Se.status,Do)"
  ],
  // 4) attach status + injection map to both raw-trace captures
  [
    "{upstreamRequest:y,upstreamResponseBody:k}",
    "{upstreamRequest:y,upstreamResponseBody:k,internalToolInjectionChars:zz,upstreamResponseStatus:yy}"
  ],
  [
    "{upstreamRequest:y,upstreamResponseBody:h}",
    "{upstreamRequest:y,upstreamResponseBody:h,internalToolInjectionChars:zz,upstreamResponseStatus:yy}"
  ],
  // 5) emit the internal_tool_stats raw-trace part after upstream_response_metadata
  [
    'partType:"upstream_response_metadata",content:Wi(n.rawTrace.mode,{statusCode:i.upstreamResponseStatus,headers:i.upstreamResponseHeaders}),contentType:"application/json; charset=utf-8",redactionPolicy:s}',
    'partType:"upstream_response_metadata",content:Wi(n.rawTrace.mode,{statusCode:i.upstreamResponseStatus,headers:i.upstreamResponseHeaders}),contentType:"application/json; charset=utf-8",redactionPolicy:s},{partType:"internal_tool_stats",content:Wi(n.rawTrace.mode,{injectedChars:i.internalToolInjectionChars}),contentType:"application/json; charset=utf-8",redactionPolicy:s}'
  ]
];

/** Resolve the installed ai-gateway dist entry, or undefined when not installed. */
export function resolveInstalledGatewayDist(projectRoot) {
  for (const pkg of ["@the-next-ai/ai-gateway", "gateway"]) {
    try {
      // The package `exports` map exposes only ".", so resolve the package entry.
      return requireFromHere.resolve(pkg, { paths: [projectRoot] });
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
  const patched = applyEdits(original, GATEWAY_EDITS, "ai-gateway");
  writeFileSync(distFile, patched);
  log(`[patch-gateway] applied remote status + internal_tool_stats patch: ${distFile}`);
  return { applied: true, file: distFile };
}
