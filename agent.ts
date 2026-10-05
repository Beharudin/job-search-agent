import "dotenv/config";
import { query, tool, createSdkMcpServer, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import nodemailer from "nodemailer";
import fs from "fs/promises";
import path from "path";

// ---- Config (from .env) ----
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID!;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY!;
const ADZUNA_COUNTRY = process.env.ADZUNA_COUNTRY || "us";
const GMAIL_USER = process.env.GMAIL_USER!;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD!;
const TO_EMAIL = process.env.TO_EMAIL || GMAIL_USER;
// Comma-separated; every run searches all of them
const SEARCH_KEYWORDS = (
  process.env.SEARCH_KEYWORDS ||
  "react developer,next.js developer,full stack developer,software engineer"
)
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

const CV_PATH = "./cv.pdf"; // change if your CV has a different name/extension
const SENT_JOBS_FILE = path.join(process.cwd(), "sent-jobs.json");
const MAX_AGE_HOURS = 100;
const HOME_COUNTRY = "Ethiopia";
// Optional search filter: set to e.g. "remote relocation sponsorship" to only fetch
// listings that mention at least one of these words. Empty = no filter.
const REQUIRED_ANY_TERMS = "";

// ---- Simple on-disk dedupe store, so we don't email the same job twice ----
async function loadSentJobIds(): Promise<Set<string>> {
  try {
    const data = await fs.readFile(SENT_JOBS_FILE, "utf-8");
    return new Set(JSON.parse(data));
  } catch {
    return new Set(); // file doesn't exist yet on first run
  }
}

async function saveSentJobIds(ids: Set<string>) {
  await fs.writeFile(SENT_JOBS_FILE, JSON.stringify([...ids], null, 2));
}

const sentJobIds = await loadSentJobIds();

// ---- Adzuna search for one keyword ----
async function searchAdzuna(keywords: string): Promise<any[]> {
  const url =
    `https://api.adzuna.com/v1/api/jobs/${ADZUNA_COUNTRY}/search/1` +
    `?app_id=${ADZUNA_APP_ID}&app_key=${ADZUNA_APP_KEY}` +
    `&results_per_page=50&max_days_old=${Math.ceil(MAX_AGE_HOURS / 24)}&sort_by=date` +
    `&what=${encodeURIComponent(keywords)}` +
    (REQUIRED_ANY_TERMS ? `&what_or=${encodeURIComponent(REQUIRED_ANY_TERMS)}` : "");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Adzuna API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.results || [];
}

// ---- Tool: search Adzuna for fresh jobs across all SEARCH_KEYWORDS ----
const searchJobsTool = tool(
  "search_jobs",
  `Search Adzuna for each of these keywords: ${SEARCH_KEYWORDS.join(", ")}. Only returns jobs posted within the last ${MAX_AGE_HOURS} hours that haven't already been emailed${REQUIRED_ANY_TERMS ? `, and whose listing mentions at least one of: ${REQUIRED_ANY_TERMS}` : ""}. Descriptions are truncated snippets. Duplicates across keywords are removed. Call it once.`,
  {},
  async () => {
    const now = Date.now();
    const maxAgeMs = MAX_AGE_HOURS * 60 * 60 * 1000;
    const seen = new Set<string>();
    const fresh: any[] = [];
    const errors: string[] = [];

    for (const keywords of SEARCH_KEYWORDS) {
      let results: any[];
      try {
        results = await searchAdzuna(keywords);
      } catch (err) {
        errors.push(`"${keywords}": ${(err as Error).message}`);
        continue;
      }

      for (const job of results) {
        const id = String(job.id);
        // Postings can be timestamped slightly in the future, so only check the upper bound
        const ageMs = now - new Date(job.created).getTime();
        if (ageMs > maxAgeMs || sentJobIds.has(id) || seen.has(id)) continue;
        seen.add(id);
        fresh.push({
          id,
          matchedKeyword: keywords,
          title: job.title,
          company: job.company?.display_name ?? "Unknown",
          location: job.location?.display_name ?? "Unknown",
          postedAt: job.created,
          url: job.redirect_url,
          description: job.description,
        });
      }
    }

    if (errors.length === SEARCH_KEYWORDS.length) {
      return {
        content: [{ type: "text" as const, text: errors.join("\n") }],
        isError: true,
      };
    }

    const text = JSON.stringify(fresh, null, 2) + (errors.length ? `\n\nFailed searches:\n${errors.join("\n")}` : "");
    return { content: [{ type: "text" as const, text }] };
  }
);

// ---- Tool: email a job + cover letter to the user ----
const sendJobEmailTool = tool(
  "send_job_email",
  "Send an email with a job link and a drafted cover letter. Call once per qualifying job, only after deciding it's a genuine match for the CV.",
  {
    jobId: z.string(),
    jobTitle: z.string(),
    company: z.string(),
    jobUrl: z.string(),
    locationNote: z
      .string()
      .describe("One line on where the job is and what the listing says about remote, relocation or sponsorship, e.g. 'On-site Berlin; sponsorship not mentioned'"),
    coverLetter: z.string().describe("Full cover letter text, ready to copy-paste"),
  },
  async ({ jobId, jobTitle, company, jobUrl, locationNote, coverLetter }) => {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });

    await transporter.sendMail({
      from: GMAIL_USER,
      to: TO_EMAIL,
      subject: `New match: ${jobTitle} at ${company}`,
      text:
        `Job: ${jobTitle} at ${company}\n` +
        `Location: ${locationNote}\n` +
        `Apply here: ${jobUrl}\n\n` +
        `--- Draft cover letter (edit before sending) ---\n\n${coverLetter}`,
    });

    sentJobIds.add(jobId);
    await saveSentJobIds(sentJobIds);

    return { content: [{ type: "text" as const, text: `Emailed job ${jobId} (${jobTitle}).` }] };
  }
);

const jobTools = createSdkMcpServer({
  name: "job-agent-tools",
  version: "1.0.0",
  tools: [searchJobsTool, sendJobEmailTool],
});

// ---- Streaming prompt (required for custom MCP tools) ----
async function* buildPrompt(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user" as const,
    parent_tool_use_id: null,
    message: {
      role: "user" as const,
      content: `
Read my CV at ${CV_PATH} to understand my skills, seniority, and target roles.

Then:
1. Call search_jobs once. It already searches my chosen keywords, so it takes no arguments.
2. Triage every returned job from its title and snippet. Drop the ones that are clearly a weak or irrelevant match for my CV.
3. For each remaining job, use WebFetch on its url to read the full listing, since the snippet is truncated. If the fetch fails, decide from the snippet alone. Don't fetch jobs you already dropped in step 2.
4. For each job that is still a genuinely strong match and passes the location rule below:
   a. Write a specific, honest 3-4 paragraph cover letter that references real details from my CV and from the job description. Never invent skills or experience I don't have.
   b. Call send_job_email with the job details, a location note and the cover letter.
5. Skip weak matches rather than forcing a cover letter.

Location rule: I live in ${HOME_COUNTRY} and am willing to relocate. Jobs anywhere (remote, hybrid or on-site) qualify unless the listing explicitly rules me out, for example:
- it requires an existing local work permit, citizenship or residency, or says no visa sponsorship
- it is remote but restricted to a country or region that excludes me (e.g. "remote, US only")
- it requires fluency in a language that isn't on my CV
- it requires a security clearance
If the listing doesn't mention remote work, relocation or sponsorship at all, still treat it as a candidate. For on-site and hybrid roles, the cover letter should briefly say I'm based in ${HOME_COUNTRY}, ready to relocate, and would need visa sponsorship.

Every cover letter should also mention, in one or two natural sentences, that I use premium AI coding agents (Claude) in my daily workflow to develop and ship faster, while still reviewing and owning the code myself. Tie it to something the role cares about (e.g. delivery speed, code quality, a small team) rather than bolting it on.

Work through every job search_jobs returns before finishing.
      `,
    },
  };
}

// ---- Run one pass ----
for await (const message of query({
  prompt: buildPrompt(),
  options: {
    allowedTools: [
      "Read",
      "WebFetch",
      "mcp__job-agent-tools__search_jobs",
      "mcp__job-agent-tools__send_job_email",
    ],
    mcpServers: { "job-agent-tools": jobTools },
    permissionMode: "acceptEdits",
  },
})) {
  const anyMsg = message as any;

  if (anyMsg.type === "assistant") {
    for (const block of anyMsg.message.content) {
      if (block.type === "text") console.log(block.text);
      if (block.type === "tool_use") console.log(`Tool: ${block.name}`);
    }
  } else if (anyMsg.type === "result") {
    console.log(`Done: ${anyMsg.subtype}`);
  }
}
