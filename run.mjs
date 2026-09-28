#!/usr/bin/env node
/**
 * Labelixa ZPL Lint — the script behind the composite action.
 *
 * A thin wrapper around the `labelixa` CLI (https://labelixa.com/docs/cli):
 * the CLI lints and renders, this script turns the result into what a CI
 * job needs — a job summary with rule links and before/after previews, a
 * JSON report and PNGs for the artifact, outputs and the exit code.
 *
 * Design decisions:
 * - No second HTTP layer for linting: the CLI is spawned (`npx labelixa@<v>`,
 *   or `LABELIXA_CLI_PATH` for local development and tests). Preview links
 *   are the only direct API calls (`POST /v1/snippets`) and they are
 *   opt-in (`previews: true`), because they store the label content on
 *   the API as a shareable snippet: when the feature is off or not
 *   available the summary still has the findings, only without images.
 * - No shell: every child process gets its arguments as an array.
 * - "Before" previews come from git: on a pull request the base commit's
 *   version of each changed label is rendered next to the new one. A label
 *   that did not exist before is marked as new; nothing is guessed.
 * - The API key comes from the environment only (LABELIXA_API_KEY) and is
 *   never printed.
 * - The repository badge (`badge: true`) is reported with GitHub's own OIDC
 *   token for the run — no Labelixa secret involved. The token is sent to
 *   the API once and never printed; public repositories only.
 * - Exit code = the CLI's: 0 clean, 1 findings at or above `fail-on`,
 *   2 usage error, 3 API or network error.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const env = process.env;
const input = (name, fallback = "") => (env[`INPUT_${name}`] ?? fallback).toString().trim();
const flag = (name, fallback) => {
  const v = input(name, fallback ? "true" : "false").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
};

const files = input("FILES", "**/*.zpl").split(/\s+/).filter(Boolean);
const failOn = input("FAIL_ON", "error") || "error";
const language = input("LANGUAGE", "");
const dpmm = input("DPMM", "8") || "8";
const width = input("WIDTH", "4") || "4";
const height = input("HEIGHT", "6") || "6";
const render = flag("RENDER", true);
// Off by default: a preview link uploads the label content to the API and
// stores it as a shareable snippet. That is a data flow a workflow author
// opts into, never one they inherit.
const previews = flag("PREVIEWS", false);
const badge = flag("BADGE", false);
const outDir = input("OUT_DIR", "labelixa-out") || "labelixa-out";
const cliVersion = input("CLI_VERSION", "0.3.0") || "0.3.0";
const apiUrl = (env.LABELIXA_API_URL || "https://api.labelixa.com").replace(/\/+$/, "");
const apiKey = env.LABELIXA_API_KEY || "";

const RULES_BASE = "https://labelixa.com/zpl/rules/";
// Badges live on the site host; an on-premise API serves them itself.
const SITE = apiUrl === "https://api.labelixa.com" ? "https://labelixa.com" : apiUrl;
const BADGE_AUD = "labelixa.com";   // must match the API's LABELIXA_ROZET_AUD
const EXIT = { OK: 0, FINDINGS: 1, USAGE: 2, API: 3 };

// ------------------------------------------------------------------ cli
// A version or range, never a URL, path or tarball spec: the value is
// handed to npx as `labelixa@<cli-version>`.
const CLI_VERSION_RE = /^[0-9A-Za-z.^~<>=*+-]{1,64}$/;

/**
 * How to run npx WITHOUT a shell.
 *
 * On Windows `npx` is a `.cmd` file and Node refuses to spawn one unless a
 * shell is used; with a shell every argument (file globs, the CLI version)
 * is parsed again by cmd.exe, so an input such as `a.zpl & calc` would run
 * a command. Instead npm's own JavaScript entry point is run with the
 * current Node binary: arguments travel as an array and nothing re-parses
 * them.
 */
function npxCommand() {
  if (process.platform !== "win32") return { file: "npx", pre: [] };
  const npxCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  return existsSync(npxCli) ? { file: process.execPath, pre: [npxCli] } : null;
}

function cli(args) {
  const common = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
                   env: { ...env, LABELIXA_API_URL: apiUrl } };
  if (env.LABELIXA_CLI_PATH) {
    return spawnSync(process.execPath, [env.LABELIXA_CLI_PATH, ...args], common);
  }
  if (!CLI_VERSION_RE.test(cliVersion)) {
    return { error: new Error(`cli-version must be a version or range, got '${cliVersion}'`) };
  }
  const npx = npxCommand();
  if (!npx) return { error: new Error("npx was not found next to the Node binary") };
  return spawnSync(npx.file, [...npx.pre, "--yes", `labelixa@${cliVersion}`, ...args], common);
}

function sizeArgs() {
  const a = ["--dpmm", dpmm, "--width", width, "--height", height];
  if (language) a.push("--lang", language);
  return a;
}

// ---------------------------------------------------------------- summary
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\|/g, "\\|");
}

function severityIcon(sev) {
  return sev === "error" ? "❌" : sev === "warning" ? "⚠️" : "ℹ️";
}

function ruleLink(d) {
  const url = d.url && /^https?:\/\//.test(d.url) ? d.url : `${RULES_BASE}${d.code}`;
  return `[${esc(d.code)}](${url})`;
}

// --------------------------------------------------------------- previews
async function snippet(zpl) {
  try {
    const res = await fetch(`${apiUrl}/v1/snippets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client": "action/1",
                 ...(apiKey ? { "X-API-Key": apiKey } : {}) },
      body: JSON.stringify({ zpl, dpmm: Number(dpmm), width: Number(width),
                             height: Number(height), unit: "in" }),
    });
    if (res.status === 201) {
      const j = await res.json();
      return { url: j.url, png: j.png };
    }
    return { unavailable: res.status };
  } catch {
    return { unavailable: "network" };
  }
}

// ------------------------------------------------------------ repo badge
function defaultBranch() {
  if (!env.GITHUB_EVENT_PATH) return "";
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")).repository?.default_branch || "";
  } catch {
    return "";
  }
}

async function reportBadge(status, files, totals) {
  if (!badge) return "";
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return "Badge not reported: the job needs `permissions: id-token: write`.";
  }
  let token = "";
  try {
    const res = await fetch(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(BADGE_AUD)}`,
                            { headers: { Authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
    token = (await res.json()).value || "";
  } catch {
    token = "";
  }
  if (!token) return "Badge not reported: GitHub did not issue an identity token for this run.";
  let res;
  try {
    res = await fetch(`${apiUrl}/v1/badges/ci`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client": "action/1",
                 Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status, files, errors: totals.error, warnings: totals.warning,
                             info: totals.info, cli_version: cliVersion,
                             default_branch: defaultBranch() }),
    });
  } catch {
    return "Badge not reported: the badge service could not be reached.";
  }
  if (res.status === 201) {
    const j = await res.json();
    return `Badge updated for \`${j.repository}\` (${j.branch}): `
      + `\`![ZPL lint](${j.badge})\``;
  }
  if (res.status === 404) return "Badge service is not enabled on this API.";
  let reason = "";
  try {
    reason = (await res.json()).reason || "";     // set on 200/403; other errors carry their own text
  } catch { /* no body */ }
  if (res.status === 200) return `Badge unchanged: ${reason || "not a branch run"}.`;
  if (res.status === 401) return "Badge not reported: the identity token was rejected by the API.";
  return `Badge not reported (HTTP ${res.status}${reason ? `: ${reason}` : ""}).`;
}

// ------------------------------------------------------------ git before
function baseSha() {
  if (env.GITHUB_EVENT_NAME !== "pull_request" || !env.GITHUB_EVENT_PATH) return null;
  try {
    const ev = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    return ev.pull_request?.base?.sha || null;
  } catch {
    return null;
  }
}

function beforeVersion(sha, file) {
  if (!sha) return null;
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
  } catch {
    try {
      execFileSync("git", ["fetch", "--quiet", "--depth=1", "origin", sha], { stdio: "ignore" });
    } catch {
      return null;
    }
  }
  try {
    return execFileSync("git", ["show", `${sha}:${file}`], { encoding: "utf8" });
  } catch {
    return null;                       // new file (or not in git)
  }
}

// ------------------------------------------------------------------- main
async function main() {
  mkdirSync(outDir, { recursive: true });

  const lint = cli(["validate", ...files, "--json", "--fail-on", failOn, ...sizeArgs()]);
  if (lint.error) {
    console.error(`labelixa-action: cannot run the CLI: ${lint.error.message}`);
    return EXIT.API;
  }
  let report;
  try {
    report = JSON.parse(lint.stdout);
  } catch {
    process.stderr.write(lint.stderr || "");
    console.error(`labelixa-action: the CLI did not return a report (exit ${lint.status}).`);
    return lint.status || EXIT.API;
  }
  const reportPath = join(outDir, "report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 1) + "\n");

  const results = report.results || [];
  const clean = results.filter((r) => r.ok !== false && !r.error);
  const withApiError = results.filter((r) => r.error);

  // Render PNGs (after) — one per file; failures are reported, not fatal.
  let renderNote = "";
  if (render && results.length) {
    const r = cli(["render", ...results.map((x) => x.file), "--out-dir", join(outDir, "after"),
                   ...sizeArgs()]);
    if (r.status !== 0) renderNote = `Rendering returned exit code ${r.status}.`;
  }

  // Before/after: base commit version on pull requests. Three states, all
  // measured from git: changed (base version differs), new (not in the
  // base commit), unchanged (identical — no "before" is shown).
  const sha = baseSha();
  const before = new Map();
  const fresh = new Set();
  if (sha) {
    for (const r of results) {
      const old = beforeVersion(sha, r.file);
      if (old === null) {
        fresh.add(r.file);
      } else if (old !== readFileSync(r.file, "utf8")) {
        const p = join(outDir, "before", r.file);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, old);
        before.set(r.file, old);
      }
    }
    if (render && before.size) {
      cli(["render", ...[...before.keys()].map((f) => join(outDir, "before", f)),
           "--out-dir", join(outDir, "before-png"), ...sizeArgs()]);
    }
  }

  // Shareable previews for the summary (optional feature).
  const links = new Map();
  let previewNote = "";
  if (previews) {
    for (const r of results) {
      if (r.error) continue;
      const after = await snippet(readFileSync(r.file, "utf8"));
      if (after.unavailable) {
        previewNote = after.unavailable === 404
          ? "Preview links are not enabled on this API; PNGs are in the artifact."
          : `Preview links unavailable (${after.unavailable}); PNGs are in the artifact.`;
        break;
      }
      const entry = { after };
      if (before.has(r.file)) {
        const b = await snippet(before.get(r.file));
        if (!b.unavailable) entry.before = b;
      }
      links.set(r.file, entry);
    }
  }

  // ---- job summary
  const failed = Number(report.failed || 0);
  const totals = { error: 0, warning: 0, info: 0 };
  for (const r of results) for (const k of Object.keys(totals)) totals[k] += r.summary?.[k] || 0;
  const status = failed ? "failing" : "passing";
  const badgeNote = await reportBadge(status, results.length, totals);
  const lines = [];
  lines.push(`## Labelixa ZPL Lint — ${failed ? "❌" : "✅"} ${results.length} file(s), `
             + `${totals.error} error(s), ${totals.warning} warning(s), ${totals.info} info`, "",
             `![ZPL lint: ${status}](${SITE}/badge/zpl-lint/${status}.svg)`);
  if (failed) lines.push(`${failed} file(s) at or above \`--fail-on ${failOn}\`.`);
  if (withApiError.length) lines.push(`${withApiError.length} file(s) could not be checked (API error).`);
  lines.push("");
  lines.push("| File | Status | Findings |");
  lines.push("|---|---|---|");
  for (const r of results) {
    const status = r.error ? `API error ${r.status ?? ""}`.trim()
      : r.ok === false ? "❌ failed" : (r.diagnostics?.length ? "⚠️ findings" : "✅ clean");
    const findings = r.error ? esc(r.error) : (r.diagnostics || []).map((d) =>
      `${severityIcon(d.severity)} ${ruleLink(d)} line ${d.line}: ${esc(d.mesaj || d.message_key || "")}`)
      .join("<br>");
    lines.push(`| \`${esc(r.file)}\` | ${status} | ${findings || "—"} |`);
  }
  if (links.size) {
    lines.push("", "### Previews", "");
    for (const [file, e] of links) {
      if (e.before) {
        lines.push(`**${esc(file)}** — before / after`, "",
                   `<a href="${e.before.url}"><img src="${e.before.png}" width="300"></a> `
                   + `<a href="${e.after.url}"><img src="${e.after.png}" width="300"></a>`, "");
      } else {
        lines.push(`**${esc(file)}**${fresh.has(file) ? " — new" : ""}`, "",
                   `<a href="${e.after.url}"><img src="${e.after.png}" width="300"></a>`, "");
      }
    }
  }
  for (const note of [previewNote, renderNote, badgeNote]) if (note) lines.push("", `_${note}_`);
  lines.push("", `Rule reference: ${RULES_BASE} · CLI: https://labelixa.com/docs/cli`, "");
  const summary = lines.join("\n");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);

  // ---- outputs + annotations
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT,
      `failed=${failed}\nfiles=${results.length}\nreport=${reportPath}\n`);
  }
  for (const r of results) {
    for (const d of r.diagnostics || []) {
      const kind = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "notice";
      const msg = `${d.code}: ${d.mesaj || d.message_key || ""} (${RULES_BASE}${d.code})`
        .replace(/[\r\n]/g, " ");
      console.log(`::${kind} file=${r.file},line=${d.line || 1},col=${d.col || 1},title=${d.code}::${msg}`);
    }
  }
  console.log(`labelixa-action: ${clean.length}/${results.length} file(s) clean at --fail-on ${failOn}`);
  return lint.status ?? EXIT.OK;
}

process.exitCode = await main();
