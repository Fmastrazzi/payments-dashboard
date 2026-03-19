require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk').default;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* TODO: Google OAuth login — descomentar cuando se tenga URL pública
const session = require('express-session');
app.use(session({
  secret: process.env.SESSION_SECRET || 'cf-payments-secret-local',
  resave: false, saveUninitialized: false,
  cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 },
}));
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL             = process.env.BASE_URL || 'http://localhost:3000';
const ALLOWED_DOMAIN       = 'comunidadfeliz.cl';
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autorizado' });
  res.redirect('/login');
}
app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/auth/google', (req, res) => {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/google/callback`,
    response_type: 'code', scope: 'openid email profile', prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});
app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/login?error=cancelled');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/auth/google/callback`, grant_type: 'authorization_code' }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user = await userRes.json();
    if (user.email?.split('@')[1] !== ALLOWED_DOMAIN) return res.redirect('/login?error=domain');
    req.session.user = { email: user.email, name: user.name, picture: user.picture };
    res.redirect('/');
  } catch (e) { res.redirect('/login?error=auth_failed'); }
});
app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));
app.use(requireAuth);
*/

const JIRA_HOST = process.env.JIRA_HOST || 'comunidadfeliz.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = 'PAY';

if (!JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error('❌  Falta configurar JIRA_EMAIL y JIRA_API_TOKEN en el archivo .env');
  process.exit(1);
}

const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

async function jiraRequest(path, isAgile = false) {
  const base = isAgile
    ? `https://${JIRA_HOST}/rest/agile/1.0`
    : `https://${JIRA_HOST}/rest/api/3`;
  const url = `${base}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function jiraSearchJql(body) {
  const url = `https://${JIRA_HOST}/rest/api/3/search/jql`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jira API error ${res.status}: ${text}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CYCLE_START_STATUSES = new Set([
  'In Progress', 'in progress', 'En curso', 'en curso',
]);
const CYCLE_END_STATUSES = new Set([
  'Aprobado', 'Approved', 'Done', 'done', 'Cerrada', 'cerrada', 'Closed', 'closed',
]);
// Statuses that represent active work — exactly as defined by the team
const ACTIVE_STATUSES = new Set([
  'En curso', 'In Progress',
  'Validation', 'Waiting for PR',
  'Review', 'Revisar',
  'Testing', 'Pruebas',
  'Changes Required',
]);
// Statuses EXCLUDED from cycle time accumulation (not active work)
// RSpec and Blocked are excluded — not in the team's active-work definition
const CYCLE_EXCLUDE_STATUSES = new Set([
  'Abierta', 'Open', 'Selected for Development',
  'RSpec',
  'Blocked', 'Bloqueado',
  'Aprobado', 'Approved', 'Done', 'done', 'Cerrada', 'cerrada', 'Closed', 'closed',
]);
const STATUS_ORDER = [
  'Abierta', 'Open', 'Selected for Development',
  'En curso', 'In Progress',
  'Validation',
  'Waiting for PR',
  'RSpec',
  'Review', 'Revisar',
  'Testing', 'Pruebas',
  'Changes Required',
  'Blocked',
  'Aprobado', 'Cerrada',
];

// Convert calendar days to approximate business days (×5/7)
function toBusinessDays(calendarDays) {
  return Math.round(calendarDays * 5 / 7 * 10) / 10;
}

function computeCycleTime(changelog) {
  const statusChanges = (changelog?.histories || [])
    .flatMap(h => h.items
      .filter(i => i.field === 'status')
      .map(i => ({ date: new Date(h.created), from: i.fromString, to: i.toString }))
    )
    .sort((a, b) => a.date - b.date);

  const timePerStatus = {};
  let firstCycleStart  = null; // first time entering In Progress
  let lastCycleStart   = null; // most recent time entering In Progress
  let firstCycleEndDate = null; // first time entering a Done status (for activeTimeDays stop)
  let lastCycleEndDate  = null; // most recent Done date (for display)
  let activeTimeDays   = 0;

  for (let i = 0; i < statusChanges.length; i++) {
    const change = statusChanges[i];
    const nextDate = i + 1 < statusChanges.length ? statusChanges[i + 1].date : new Date();
    const daysInStatus = (nextDate - change.date) / 86400000;

    // Accumulate time per status for display (all statuses)
    if (!timePerStatus[change.to]) timePerStatus[change.to] = 0;
    timePerStatus[change.to] += daysInStatus;

    if (CYCLE_START_STATUSES.has(change.to)) {
      if (!firstCycleStart) firstCycleStart = change.date;
      lastCycleStart = change.date; // track the most recent start
    }
    if (CYCLE_END_STATUSES.has(change.to)) {
      if (!firstCycleEndDate) firstCycleEndDate = change.date;
      lastCycleEndDate = change.date;
    }

    // Active cycle time: sum non-excluded statuses between first start and FIRST end
    if (firstCycleStart && !firstCycleEndDate && !CYCLE_EXCLUDE_STATUSES.has(change.to)) {
      activeTimeDays += daysInStatus;
    }
  }

  // Method A: sum of active statuses (detailed, shows real work time per state)
  const cycleTimeDays = firstCycleStart && firstCycleEndDate
    ? Math.round(activeTimeDays * 10) / 10
    : null;

  // Method B (official Jira metric): calendar days from LAST In Progress entry to FIRST Done,
  // converted to approximate business days (×5/7). Matches Jira control chart methodology.
  // Validated: Oct 2025 Historia-only ≈ 3.44d reported
  const rawCalendarDays = lastCycleStart && firstCycleEndDate && firstCycleEndDate > lastCycleStart
    ? (firstCycleEndDate - lastCycleStart) / 86400000 : null;
  const officialCycleTimeDays = rawCalendarDays !== null ? toBusinessDays(rawCalendarDays) : null;

  // Days in current status — if no transitions, count from issue creation
  const lastChange = statusChanges[statusChanges.length - 1];
  const currentStatusDays = lastChange
    ? Math.round((new Date() - lastChange.date) / 86400000 * 10) / 10
    : null;
  const currentStatus = lastChange ? lastChange.to : null;

  return {
    cycleTimeDays,
    officialCycleTimeDays,
    cycleStartDate: firstCycleStart,
    cycleEndDate: firstCycleEndDate,
    timePerStatus,
    currentStatusDays,
    currentStatus,
  };
}

function parseIssue(issue) {
  const f = issue.fields;
  const { cycleTimeDays, officialCycleTimeDays, cycleStartDate, cycleEndDate, timePerStatus, currentStatusDays, currentStatus } =
    computeCycleTime(issue.changelog);

  const statusName = f.status?.name;
  const rawCategory = f.status?.statusCategory?.key;

  // Jira misconfigures some active statuses as 'new' — override based on name
  const isActive = ACTIVE_STATUSES.has(statusName);
  const isDone   = CYCLE_END_STATUSES.has(statusName) || rawCategory === 'done';
  const effectiveCategory = isDone ? 'done' : isActive ? 'indeterminate' : rawCategory;

  // If issue has never transitioned, compute days stuck from creation date
  const effectiveCurrentStatusDays = currentStatusDays !== null
    ? currentStatusDays
    : f.created
      ? Math.round((new Date() - new Date(f.created)) / 86400000 * 10) / 10
      : null;

  return {
    key: issue.key,
    summary: f.summary,
    status: statusName,
    statusCategory: effectiveCategory,
    issuetype: f.issuetype?.name,
    assignee: f.assignee?.displayName || 'Sin asignar',
    assigneeEmail: f.assignee?.emailAddress || '',
    storyPoints: f.customfield_10027 || null,
    created: f.created,
    resolutiondate: f.resolutiondate,
    sprint: (f.customfield_10018 || []).map(s => s.name).join(', '),
    cycleTimeDays,
    officialCycleTimeDays,
    cycleStartDate,
    cycleEndDate,
    timePerStatus,
    currentStatusDays: effectiveCurrentStatusDays,
    currentStatus: currentStatus || statusName,
    priority: f.priority?.name,
  };
}

// ─── Board & Sprints ──────────────────────────────────────────────────────────

async function getBoardId() {
  const data = await jiraRequest(`/board?projectKeyOrId=${PROJECT_KEY}&type=scrum`, true);
  if (!data.values?.length) {
    // try kanban
    const data2 = await jiraRequest(`/board?projectKeyOrId=${PROJECT_KEY}`, true);
    return data2.values?.[0]?.id;
  }
  return data.values[0].id;
}

app.get('/api/board', async (req, res) => {
  try {
    const data = await jiraRequest(`/board?projectKeyOrId=${PROJECT_KEY}`, true);
    res.json(data.values || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sprints', async (req, res) => {
  try {
    const boardId = await getBoardId();
    if (!boardId) return res.status(404).json({ error: 'Board not found' });

    // Get active sprint and total closed count in parallel
    const [active, closedMeta] = await Promise.all([
      jiraRequest(`/board/${boardId}/sprint?state=active`, true),
      jiraRequest(`/board/${boardId}/sprint?state=closed&maxResults=1`, true),
    ]);

    // Fetch only the 3 most recent closed sprints using startAt offset
    const totalClosed = closedMeta.total || 0;
    const startAt = Math.max(0, totalClosed - 3);
    const recentClosed = await jiraRequest(
      `/board/${boardId}/sprint?state=closed&maxResults=3&startAt=${startAt}`,
      true
    );

    const sprints = [
      ...(active.values || []),
      ...(recentClosed.values || []).reverse(), // most recent first
    ];
    res.json(sprints);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Sprint Issues ────────────────────────────────────────────────────────────

app.get('/api/sprint/:sprintId/issues', async (req, res) => {
  try {
    const { sprintId } = req.params;
    let startAt = 0;
    let allIssues = [];
    let total = 1;

    while (startAt < total) {
      const data = await jiraRequest(
        `/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=50&fields=summary,status,issuetype,assignee,customfield_10027,customfield_10018,created,resolutiondate,priority&expand=changelog`,
        true
      );
      total = data.total;
      allIssues = allIssues.concat(data.issues || []);
      startAt += 50;
    }

    const issues = allIssues.map(parseIssue);
    res.json(issues);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Backlog ──────────────────────────────────────────────────────────────────

app.get('/api/backlog', async (req, res) => {
  try {
    const boardId = await getBoardId();
    if (!boardId) return res.status(404).json({ error: 'Board not found' });

    let startAt = 0;
    let allIssues = [];
    let total = 1;

    while (startAt < total && allIssues.length < 100) {
      const data = await jiraRequest(
        `/board/${boardId}/backlog?startAt=${startAt}&maxResults=50&fields=summary,status,issuetype,assignee,customfield_10027,priority,created`,
        true
      );
      total = data.total;
      allIssues = allIssues.concat(data.issues || []);
      startAt += 50;
    }

    const issues = allIssues
      .filter(i => i.fields.status?.statusCategory?.key !== 'done')
      .map(i => {
        const f = i.fields;
        return {
          key: i.key,
          summary: f.summary,
          status: f.status?.name,
          issuetype: f.issuetype?.name,
          assignee: f.assignee?.displayName || 'Sin asignar',
          storyPoints: f.customfield_10027 || null,
          priority: f.priority?.name,
          created: f.created,
        };
      });

    res.json(issues);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Cycle Time Stats ─────────────────────────────────────────────────────────

app.get('/api/cycle-time', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');
    // Exclude Epics by default — they span weeks/months and inflate the average.
    // The official Payments cycle time metric tracks Historia + Tarea only.
    const excludeEpics = req.query.includeEpics !== 'true';
    const typeFilter = excludeEpics ? ' AND issuetype not in (Epic)' : '';
    const jql = `project = ${PROJECT_KEY} AND statusCategory = Done${typeFilter} AND updated >= -${days}d ORDER BY updated DESC`;

    let nextPageToken = undefined;
    let allIssues = [];

    do {
      const body = {
        jql,
        maxResults: 50,
        fields: ['summary', 'status', 'issuetype', 'assignee', 'customfield_10027', 'customfield_10018', 'created', 'resolutiondate'],
        expand: 'changelog',
        ...(nextPageToken ? { nextPageToken } : {}),
      };
      const data = await jiraSearchJql(body);
      allIssues = allIssues.concat(data.issues || []);
      nextPageToken = data.nextPageToken || null;
    } while (nextPageToken && allIssues.length < 200);

    const issues = allIssues.map(parseIssue).filter(i => i.cycleTimeDays !== null);

    // Split cycle time into Dev time and QA time per issue
    // Active statuses per team definition: In Progress, Changes Required, Validation, Waiting for PR, Review, Testing
    const QA_STATUSES  = new Set(['Testing', 'Pruebas']);
    const DEV_STATUSES = new Set(['En curso', 'In Progress', 'Validation', 'Waiting for PR', 'Review', 'Revisar', 'Changes Required']);
    issues.forEach(issue => {
      let devTime = 0, qaTime = 0;
      Object.entries(issue.timePerStatus || {}).forEach(([status, days]) => {
        if (QA_STATUSES.has(status)) qaTime += days;
        else if (DEV_STATUSES.has(status)) devTime += days;
      });
      issue.devTimeDays = Math.round(devTime * 10) / 10;
      issue.qaTimeDays  = Math.round(qaTime * 10) / 10;
    });

    // Aggregate stats
    const byDev = {};
    issues.forEach(issue => {
      const dev = issue.assignee;
      if (!byDev[dev]) byDev[dev] = { issues: [], totalPoints: 0, cycleTimes: [] };
      byDev[dev].issues.push(issue);
      byDev[dev].totalPoints += issue.storyPoints || 0;
      if (issue.cycleTimeDays !== null) byDev[dev].cycleTimes.push(issue.cycleTimeDays);
    });

    const devStats = Object.entries(byDev).map(([name, data]) => ({
      name,
      issueCount: data.issues.length,
      totalPoints: data.totalPoints,
      avgCycleTime: data.cycleTimes.length
        ? Math.round(data.cycleTimes.reduce((a, b) => a + b, 0) / data.cycleTimes.length * 10) / 10
        : null,
      minCycleTime: data.cycleTimes.length ? Math.min(...data.cycleTimes) : null,
      maxCycleTime: data.cycleTimes.length ? Math.max(...data.cycleTimes) : null,
    })).sort((a, b) => b.totalPoints - a.totalPoints);

    // Avg time per status
    const statusTotals = {};
    const statusCounts = {};
    issues.forEach(issue => {
      Object.entries(issue.timePerStatus || {}).forEach(([status, days]) => {
        if (!statusTotals[status]) { statusTotals[status] = 0; statusCounts[status] = 0; }
        statusTotals[status] += days;
        statusCounts[status]++;
      });
    });
    const avgTimePerStatus = Object.entries(statusTotals)
      .filter(([status]) => !CYCLE_EXCLUDE_STATUSES.has(status))
      .map(([status, total]) => ({
        status,
        avgDays: Math.round(total / statusCounts[status] * 10) / 10,
      }))
      .sort((a, b) => {
        const ai = STATUS_ORDER.indexOf(a.status);
        const bi = STATUS_ORDER.indexOf(b.status);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

    const allCycleTimes = issues.map(i => i.cycleTimeDays).filter(Boolean).sort((a, b) => a - b);
    const p50 = allCycleTimes[Math.floor(allCycleTimes.length * 0.5)] || null;
    const p85 = allCycleTimes[Math.floor(allCycleTimes.length * 0.85)] || null;
    const p95 = allCycleTimes[Math.floor(allCycleTimes.length * 0.95)] || null;

    // Breakdown by issue type
    const byType = {};
    issues.forEach(issue => {
      const t = issue.issuetype || 'Sin tipo';
      if (!byType[t]) byType[t] = { cycleTimes: [], count: 0, totalPoints: 0 };
      byType[t].count++;
      byType[t].totalPoints += issue.storyPoints || 0;
      if (issue.cycleTimeDays !== null) byType[t].cycleTimes.push(issue.cycleTimeDays);
    });
    const typeStats = Object.entries(byType).map(([type, data]) => {
      const sorted = [...data.cycleTimes].sort((a, b) => a - b);
      return {
        type,
        count: data.count,
        totalPoints: data.totalPoints,
        avgCycleTime: sorted.length ? Math.round(sorted.reduce((a,b) => a+b,0) / sorted.length * 10) / 10 : null,
        p50: sorted[Math.floor(sorted.length * 0.5)] || null,
        p85: sorted[Math.floor(sorted.length * 0.85)] || null,
      };
    }).sort((a, b) => b.count - a.count);

    const avgDevTime = issues.length
      ? Math.round(issues.reduce((s, i) => s + (i.devTimeDays || 0), 0) / issues.length * 10) / 10 : null;
    const avgQaTime  = issues.length
      ? Math.round(issues.reduce((s, i) => s + (i.qaTimeDays || 0), 0) / issues.length * 10) / 10 : null;

    // Find the status with highest average time (main bottleneck)
    const bottleneckStatus = avgTimePerStatus.length
      ? avgTimePerStatus.reduce((max, s) => s.avgDays > max.avgDays ? s : max, avgTimePerStatus[0])
      : null;

    // Official metric: business days from last In Progress to Done, Historia only
    const histIssues = issues.filter(i => i.issuetype === 'Historia' && i.officialCycleTimeDays !== null);
    const officialCTs = histIssues.map(i => i.officialCycleTimeDays).sort((a, b) => a - b);
    const avgOfficialCycleTime = officialCTs.length
      ? Math.round(officialCTs.reduce((a, b) => a + b, 0) / officialCTs.length * 10) / 10 : null;
    const officialP50 = officialCTs[Math.floor(officialCTs.length * 0.5)] || null;

    res.json({
      total: issues.length,
      avgCycleTime: allCycleTimes.length
        ? Math.round(allCycleTimes.reduce((a, b) => a + b, 0) / allCycleTimes.length * 10) / 10
        : null,
      avgOfficialCycleTime,
      officialP50,
      avgDevTime,
      avgQaTime,
      bottleneckStatus,
      p50, p85, p95,
      devStats,
      typeStats,
      avgTimePerStatus,
      issues,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Cycle Time History (monthly trend) ───────────────────────────────────────

app.get('/api/cycle-time/history', async (req, res) => {
  try {
    const months = parseInt(req.query.months || '6');

    const PAYMENTS_TEAM = new Set(['Emanuel Contigliani', 'Samuel Melgarejo', 'Andrés Machaca', 'Adrián Padilla', 'Francisco Aguilar']);
    const QA_STATUSES  = new Set(['Testing', 'Pruebas']);
    const DEV_STATUSES = new Set(['En curso', 'In Progress', 'Validation', 'Waiting for PR', 'Review', 'Revisar', 'Changes Required']);

    // Build the list of months to query (last N months)
    const now = new Date();
    const monthKeys = [];
    for (let m = months - 1; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
      monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    // Fetch each month separately using resolutiondate — avoids pagination cutoff
    const byMonth = {};
    await Promise.all(monthKeys.map(async (key) => {
      const [year, month] = key.split('-');
      const firstDay = `${year}-${month}-01`;
      const lastDay  = new Date(year, month, 0).toISOString().slice(0, 10); // last day of month
      const jql = `project = ${PROJECT_KEY} AND statusCategory = Done AND issuetype not in (Epic) AND resolutiondate >= "${firstDay}" AND resolutiondate <= "${lastDay}" ORDER BY resolutiondate DESC`;
      let allMonth = [], tok;
      do {
        const data = await jiraSearchJql({
          jql, maxResults: 50,
          fields: ['summary', 'status', 'issuetype', 'assignee', 'customfield_10027', 'resolutiondate', 'created'],
          expand: 'changelog',
          ...(tok ? { nextPageToken: tok } : {}),
        });
        allMonth = allMonth.concat(data.issues || []);
        tok = data.nextPageToken || null;
      } while (tok && allMonth.length < 300);
      byMonth[key] = allMonth.map(parseIssue).filter(i => i.cycleTimeDays !== null);
    }));

    const parsed = Object.values(byMonth).flat();

    // Add dev/qa split to all parsed issues
    parsed.forEach(issue => {
      let devTime = 0, qaTime = 0;
      Object.entries(issue.timePerStatus || {}).forEach(([status, d]) => {
        if (QA_STATUSES.has(status))       qaTime  += d;
        else if (DEV_STATUSES.has(status)) devTime += d;
      });
      issue.devTimeDays = Math.round(devTime * 10) / 10;
      issue.qaTimeDays  = Math.round(qaTime  * 10) / 10;
    });

    const history = monthKeys.map(key => {
      const issues = byMonth[key] || [];
      const cts = issues.map(i => i.cycleTimeDays).sort((a, b) => a - b);
      const avg = cts.length ? Math.round(cts.reduce((a, b) => a + b, 0) / cts.length * 10) / 10 : null;
      const p50 = cts.length ? cts[Math.floor(cts.length * 0.5)] : null;
      const avgDev = issues.length ? Math.round(issues.reduce((s, i) => s + (i.devTimeDays || 0), 0) / issues.length * 10) / 10 : null;
      const avgQa  = issues.length ? Math.round(issues.reduce((s, i) => s + (i.qaTimeDays  || 0), 0) / issues.length * 10) / 10 : null;

      // Official metric: business days from last InProgress→Done, Historia only, Payments team
      const histIssues = issues.filter(i =>
        i.issuetype === 'Historia' &&
        i.officialCycleTimeDays !== null &&
        PAYMENTS_TEAM.has(i.assignee)
      );
      const officialCTs = histIssues.map(i => i.officialCycleTimeDays).sort((a, b) => a - b);
      const avgOfficial = officialCTs.length
        ? Math.round(officialCTs.reduce((a, b) => a + b, 0) / officialCTs.length * 10) / 10 : null;

      const [year, month] = key.split('-');
      const label = new Date(year, month - 1, 1).toLocaleDateString('es-CL', { month: 'short', year: '2-digit' });
      return { key, label, count: issues.length, avg, p50, avgDev, avgQa, avgOfficial, officialCount: histIssues.length };
    });

    res.json({ history });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Bugs ─────────────────────────────────────────────────────────────────────

app.get('/api/bugs', async (req, res) => {
  try {
    // Use issue type IDs: 10050=Error, 10077=Hotfix (Spanish names break JQL in new endpoint)
    const openJql = `project = ${PROJECT_KEY} AND issuetype in (10050, 10077) AND statusCategory != Done ORDER BY priority ASC, created ASC`;
    const resolvedJql = `project = ${PROJECT_KEY} AND issuetype in (10050, 10077) AND statusCategory = Done AND updated >= -90d ORDER BY updated DESC`;

    const [openData, resolvedData] = await Promise.all([
      jiraSearchJql({
        jql: openJql, maxResults: 100,
        fields: ['summary', 'status', 'issuetype', 'assignee', 'customfield_10027',
                 'customfield_10018', 'created', 'priority', 'description'],
      }),
      jiraSearchJql({
        jql: resolvedJql, maxResults: 50,
        fields: ['summary', 'status', 'issuetype', 'assignee', 'customfield_10027',
                 'customfield_10018', 'created', 'resolutiondate', 'priority'],
        expand: 'changelog',
      }),
    ]);

    const PRIORITY_WEIGHT = { Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 };

    const openBugs = (openData.issues || []).map(issue => {
      const parsed = parseIssue(issue);
      const ageDays = parsed.created
        ? Math.round((new Date() - new Date(parsed.created)) / 86400000)
        : 0;
      const priorityWeight = PRIORITY_WEIGHT[parsed.priority] || 2;
      // Impact score: combines priority + age (older high-priority bugs = higher impact)
      const impactScore = priorityWeight * 10 + Math.min(ageDays / 7, 20);
      return { ...parsed, ageDays, impactScore };
    }).sort((a, b) => b.impactScore - a.impactScore);

    const resolvedBugs = (resolvedData.issues || []).map(parseIssue)
      .filter(i => i.cycleTimeDays !== null);

    const resolvedCycleTimes = resolvedBugs.map(i => i.cycleTimeDays).sort((a, b) => a - b);
    const avgResolutionTime = resolvedCycleTimes.length
      ? Math.round(resolvedCycleTimes.reduce((a, b) => a + b, 0) / resolvedCycleTimes.length * 10) / 10
      : null;

    // Group open bugs by status
    const byStatus = {};
    openBugs.forEach(b => { byStatus[b.status] = (byStatus[b.status] || 0) + 1; });

    // Group by assignee
    const byAssignee = {};
    openBugs.forEach(b => {
      const a = b.assignee;
      if (!byAssignee[a]) byAssignee[a] = { total: 0, highest: 0, high: 0 };
      byAssignee[a].total++;
      if (b.priority === 'Highest') byAssignee[a].highest++;
      if (b.priority === 'High') byAssignee[a].high++;
    });

    res.json({
      openCount: openBugs.length,
      resolvedCount: resolvedBugs.length,
      avgResolutionTime,
      p50: resolvedCycleTimes[Math.floor(resolvedCycleTimes.length * 0.5)] || null,
      criticalCount: openBugs.filter(b => b.priority === 'Highest' || b.priority === 'High').length,
      byStatus,
      byAssignee,
      openBugs,
      resolvedBugs,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Sprint Summary & Webhook Notify ─────────────────────────────────────────

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

function buildSprintSummaryBlocks(summary) {
  const { sprintName, total, done: doneCount, doneSP, totalSP, completionPct,
          inTestingCount, closedCount, avgQaTime, byDev, closeSoon } = summary;

  // Monospace table (code block) — avoid emoji in headers for alignment
  const namePad = Math.max(...byDev.map(d => d.shortName.length), 14);
  const header  = 'Desarrollador'.padEnd(namePad) + '  Hecho  SP ok  SP pend';
  const divider = '─'.repeat(header.length);
  const rows    = byDev.map(d =>
    d.shortName.padEnd(namePad) +
    String(d.done).padStart(7) +
    String(d.spDone).padStart(7) +
    String(d.spPending).padStart(8)
  ).join('\n');

  const filledBar = Math.round(completionPct / 10);
  const bar = '█'.repeat(filledBar) + '░'.repeat(10 - filledBar);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📊 ${sprintName} — Resumen de avance`, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`${bar}\` *${completionPct}%* completado` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Tareas completadas*\n${doneCount} / ${total}` },
        { type: 'mrkdwn', text: `*Story Points*\n${doneSP} / ${totalSP} SP` },
        { type: 'mrkdwn', text: `*En Testing ahora*\n${inTestingCount} tarea${inTestingCount !== 1 ? 's' : ''}` },
        { type: 'mrkdwn', text: `*Tiempo prom. en QA*\n${avgQaTime !== null ? avgQaTime + 'd' : 'N/D'}` },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*👥 Avance por desarrollador*\n\`\`\`${header}\n${divider}\n${rows}\`\`\``,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*✅ Issues cerradas en el sprint:* ${closedCount}` },
    },
  ];

  if (closeSoon.length > 0) {
    blocks.push({ type: 'divider' });
    const closeText = closeSoon.map(i =>
      `• *<https://comunidadfeliz.atlassian.net/browse/${i.key}|${i.key}>* — ${i.summary.slice(0, 55)}${i.summary.length > 55 ? '…' : ''}\n  _${i.status}_ · ${i.currentStatusDays}d · ${i.assignee}`
    ).join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🎯 Foco de cierre — próximas a terminar:*\n${closeText}` },
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `Payments Dashboard · ${new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' })}`,
    }],
  });

  return blocks;
}

async function fetchSprintSummary(sprintId) {
  const sprint = await jiraRequest(`/sprint/${sprintId}`, true);
  const sprintName = sprint?.name || `Sprint ${sprintId}`;

  let startAt = 0, allIssues = [], total = 1;
  while (startAt < total) {
    const data = await jiraRequest(
      `/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=50&fields=summary,status,issuetype,assignee,customfield_10027,customfield_10018,created,resolutiondate,priority&expand=changelog`,
      true
    );
    total = data.total;
    allIssues = allIssues.concat(data.issues || []);
    startAt += 50;
  }

  const QA_STATUSES   = new Set(['Testing', 'Pruebas']);
  const DEV_STATUSES  = new Set(['En curso', 'In Progress', 'Validation', 'Waiting for PR', 'Review', 'Revisar', 'Changes Required']);
  const CLOSE_STATUSES = new Set(['Testing', 'Pruebas', 'Review', 'Revisar', 'Changes Required', 'Validation']);

  const issues = allIssues.map(parseIssue);
  issues.forEach(issue => {
    let devTime = 0, qaTime = 0;
    Object.entries(issue.timePerStatus || {}).forEach(([status, d]) => {
      if (QA_STATUSES.has(status))       qaTime  += d;
      else if (DEV_STATUSES.has(status)) devTime += d;
    });
    issue.devTimeDays = Math.round(devTime * 10) / 10;
    issue.qaTimeDays  = Math.round(qaTime  * 10) / 10;
  });

  const done    = issues.filter(i => i.statusCategory === 'done');
  const pending = issues.filter(i => i.statusCategory !== 'done');
  const inTesting = issues.filter(i => QA_STATUSES.has(i.status));
  const closeSoon = pending
    .filter(i => CLOSE_STATUSES.has(i.status))
    .sort((a, b) => (b.currentStatusDays || 0) - (a.currentStatusDays || 0))
    .slice(0, 6)
    .map(i => ({ key: i.key, summary: i.summary, status: i.status, currentStatusDays: i.currentStatusDays, assignee: i.assignee }));

  const withQa = issues.filter(i => (i.qaTimeDays || 0) > 0);
  const avgQaTime = withQa.length
    ? Math.round(withQa.reduce((s, i) => s + i.qaTimeDays, 0) / withQa.length * 10) / 10
    : null;

  const byDevMap = {};
  issues.forEach(issue => {
    const dev = issue.assignee;
    if (dev === 'Sin asignar') return;
    if (!byDevMap[dev]) byDevMap[dev] = { done: 0, spDone: 0, spPending: 0 };
    if (issue.statusCategory === 'done') {
      byDevMap[dev].done++;
      byDevMap[dev].spDone += issue.storyPoints || 0;
    } else {
      byDevMap[dev].spPending += issue.storyPoints || 0;
    }
  });

  const byDev = Object.entries(byDevMap).map(([name, d]) => {
    const parts = name.split(' ');
    const shortName = parts.length >= 2 ? `${parts[0]} ${parts[1][0]}.` : parts[0];
    return { name, shortName, ...d };
  }).sort((a, b) => b.spDone - a.spDone);

  const totalSP = issues.reduce((s, i) => s + (i.storyPoints || 0), 0);
  const doneSP  = done.reduce((s, i) => s + (i.storyPoints || 0), 0);

  const summary = {
    sprintName,
    total: issues.length,
    done: done.length,
    doneSP,
    totalSP,
    completionPct: issues.length ? Math.round(done.length / issues.length * 100) : 0,
    inTestingCount: inTesting.length,
    closedCount: done.length,
    avgQaTime,
    byDev,
    closeSoon,
  };
  summary.blocks = buildSprintSummaryBlocks(summary);
  return summary;
}

app.get('/api/sprint/:sprintId/summary', async (req, res) => {
  try {
    const summary = await fetchSprintSummary(req.params.sprintId);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sprint/:sprintId/notify-webhook', async (req, res) => {
  if (!SLACK_WEBHOOK_URL) {
    return res.status(400).json({ error: 'Falta configurar SLACK_WEBHOOK_URL en el .env' });
  }
  try {
    const summary = await fetchSprintSummary(req.params.sprintId);
    const slackRes = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: summary.blocks, text: `${summary.sprintName} — Resumen de avance` }),
    });
    if (!slackRes.ok) {
      const text = await slackRes.text();
      throw new Error(`Slack webhook error: ${text}`);
    }
    res.json({ ok: true, sprintName: summary.sprintName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Slack (DM por bot token — legacy) ───────────────────────────────────────

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

async function slackApi(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack error [${method}]: ${data.error}`);
  return data;
}

async function getSlackUserId(email) {
  const data = await slackApi('users.lookupByEmail', { email });
  return data.user.id;
}

async function sendSlackDm(userId, blocks) {
  const { channel } = await slackApi('conversations.open', { users: userId });
  await slackApi('chat.postMessage', { channel: channel.id, blocks, text: 'Resumen de sprint' });
}

function priorityEmoji(p) {
  const map = { Highest: '🔴', High: '🟠', Medium: '🟡', Low: '🔵', Lowest: '⚪' };
  return map[p] || '⚪';
}

function statusEmoji(s) {
  const lower = (s || '').toLowerCase();
  if (['in progress', 'en curso'].includes(lower)) return '⚙️';
  if (['testing', 'pruebas'].includes(lower)) return '🧪';
  if (['review', 'revisar'].includes(lower)) return '👀';
  if (['blocked', 'bloqueado'].includes(lower)) return '🚫';
  if (['aprobado', 'approved', 'done', 'cerrada'].includes(lower)) return '✅';
  if (lower === 'waiting for pr') return '⏳';
  if (lower === 'rspec') return '🔬';
  if (lower === 'changes required') return '🔁';
  if (['abierta', 'open'].includes(lower)) return '📋';
  return '📌';
}

function buildSlackBlocks(dev, sprintName, issues, sprintTotals) {
  const done = issues.filter(i => i.statusCategory === 'done');
  const pending = issues.filter(i => i.statusCategory !== 'done');
  const completionPct = issues.length ? Math.round(done.length / issues.length * 100) : 0;
  const totalSP = issues.reduce((s, i) => s + (i.storyPoints || 0), 0);
  const doneSP  = done.reduce((s, i) => s + (i.storyPoints || 0), 0);

  // Stalled: pending issues with most days in current status, min 2 days
  const stalled = [...pending]
    .filter(i => (i.currentStatusDays || 0) >= 2 && i.statusCategory !== 'done')
    .sort((a, b) => (b.currentStatusDays || 0) - (a.currentStatusDays || 0))
    .slice(0, 3);

  // Priority order for pending: Highest > High > Medium > Low
  const priorityOrder = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
  const sortedPending = [...pending].sort(
    (a, b) => priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority)
  );

  // Progress bar
  const filled = Math.round(completionPct / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📊 Sprint Update — ${sprintName}`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Hola *${dev.split(' ')[0]}* 👋 Aquí está tu resumen del sprint actual.`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Tu completitud*\n\`${bar}\` ${completionPct}%` },
        { type: 'mrkdwn', text: `*Story Points*\n${doneSP} / ${totalSP} SP completados` },
        { type: 'mrkdwn', text: `*Issues*\n${done.length} / ${issues.length} terminados` },
        { type: 'mrkdwn', text: `*Sprint global*\n${sprintTotals.pct}% completado (${sprintTotals.doneSP}/${sprintTotals.totalSP} SP)` },
      ],
    },
    { type: 'divider' },
  ];

  // Pending tasks by priority
  if (sortedPending.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📋 Tus tareas pendientes (por prioridad):*` },
    });
    sortedPending.forEach((issue, idx) => {
      const stalledDays = (issue.currentStatusDays || 0) >= 2
        ? ` — ⚠️ ${issue.currentStatusDays}d en *${issue.currentStatus}*` : '';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${idx + 1}. ${priorityEmoji(issue.priority)} *<https://comunidadfeliz.atlassian.net/browse/${issue.key}|${issue.key}>* ${statusEmoji(issue.status)} _${issue.status}_${stalledDays}\n    ${issue.summary}${issue.storyPoints ? ` _(${issue.storyPoints} SP)_` : ''}`,
        },
      });
    });
    blocks.push({ type: 'divider' });
  }

  // Stalled recommendations
  if (stalled.length > 0) {
    const stalledText = stalled.map(i =>
      `• *<https://comunidadfeliz.atlassian.net/browse/${i.key}|${i.key}>* lleva *${i.currentStatusDays}d* en _${i.currentStatus}_ — considera desbloquearlo o pedir ayuda.`
    ).join('\n');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*⚠️ Recomendación — Tareas estancadas:*\n${stalledText}`,
      },
    });
    blocks.push({ type: 'divider' });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Payments Dashboard · ${new Date().toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' })}` }],
  });

  return blocks;
}

app.post('/api/sprint/:sprintId/notify', async (req, res) => {
  if (!SLACK_BOT_TOKEN) {
    return res.status(400).json({ error: 'Falta configurar SLACK_BOT_TOKEN en el .env' });
  }

  try {
    const { sprintId } = req.params;

    // Get sprint info
    const boardId = await getBoardId();
    const sprintsData = await jiraRequest(`/board/${boardId}/sprint?state=active,closed&maxResults=20`, true);
    const sprint = (sprintsData.values || []).find(s => String(s.id) === String(sprintId));
    const sprintName = sprint?.name || `Sprint ${sprintId}`;

    // Get sprint issues
    let startAt = 0, allIssues = [], total = 1;
    while (startAt < total) {
      const data = await jiraRequest(
        `/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=50&fields=summary,status,issuetype,assignee,customfield_10027,customfield_10018,created,resolutiondate,priority&expand=changelog`,
        true
      );
      total = data.total;
      allIssues = allIssues.concat(data.issues || []);
      startAt += 50;
    }
    const issues = allIssues.map(parseIssue);

    // Sprint-level totals
    const sprintTotals = {
      totalSP: issues.reduce((s, i) => s + (i.storyPoints || 0), 0),
      doneSP:  issues.filter(i => i.statusCategory === 'done').reduce((s, i) => s + (i.storyPoints || 0), 0),
      pct: issues.length ? Math.round(issues.filter(i => i.statusCategory === 'done').length / issues.length * 100) : 0,
    };

    // Group by developer (exclude unassigned)
    const byDev = {};
    issues.forEach(issue => {
      if (!issue.assigneeEmail || issue.assignee === 'Sin asignar') return;
      if (!byDev[issue.assignee]) byDev[issue.assignee] = { email: issue.assigneeEmail, issues: [] };
      byDev[issue.assignee].issues.push(issue);
    });

    const results = [];
    for (const [devName, devData] of Object.entries(byDev)) {
      try {
        const slackUserId = await getSlackUserId(devData.email);
        const blocks = buildSlackBlocks(devName, sprintName, devData.issues, sprintTotals);
        await sendSlackDm(slackUserId, blocks);
        results.push({ dev: devName, status: 'sent', issues: devData.issues.length });
        console.log(`✅ Slack DM sent to ${devName} (${devData.email})`);
      } catch (err) {
        results.push({ dev: devName, status: 'error', error: err.message });
        console.error(`❌ Failed for ${devName}: ${err.message}`);
      }
    }

    res.json({ sprintName, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PTL: Listar epics del proyecto ──────────────────────────────────────────
app.get('/api/ptl/epics', async (req, res) => {
  try {
    const data = await jiraSearchJql({
      jql: `project = ${PROJECT_KEY} AND issuetype = Epic ORDER BY updated DESC`,
      fields: ['summary', 'status', 'description', 'assignee', 'priority', 'customfield_10014'],
      maxResults: 50,
    });
    const epics = (data.issues || []).map(i => ({
      key: i.key,
      summary: i.fields.summary,
      status: i.fields.status?.name,
      assignee: i.fields.assignee?.displayName || null,
      priority: i.fields.priority?.name,
    }));
    res.json(epics);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PTL: Contexto completo de un epic (epic + todas sus historias) ───────────
app.get('/api/ptl/epic/:epicKey', async (req, res) => {
  try {
    const { epicKey } = req.params;

    // Epic principal
    const epic = await jiraRequest(`/issue/${epicKey}?fields=summary,description,status,assignee,priority,customfield_10014`);

    // Historias hijas del epic
    const children = await jiraSearchJql({
      jql: `"Epic Link" = ${epicKey} OR parentEpic = ${epicKey} OR parent = ${epicKey} ORDER BY status ASC`,
      fields: ['summary', 'status', 'issuetype', 'assignee', 'priority', 'description', 'customfield_10027', 'customfield_10014'],
      maxResults: 100,
    });

    // Extraer texto plano de descripción ADF
    function adfToText(doc) {
      if (!doc) return '';
      if (typeof doc === 'string') return doc;
      const texts = [];
      function walk(node) {
        if (!node) return;
        if (node.type === 'text') texts.push(node.text || '');
        if (node.content) node.content.forEach(walk);
      }
      walk(doc);
      return texts.join(' ').replace(/\s+/g, ' ').trim();
    }

    const issues = (children.issues || []).map(i => ({
      key: i.key,
      type: i.fields.issuetype?.name,
      summary: i.fields.summary,
      status: i.fields.status?.name,
      assignee: i.fields.assignee?.displayName || 'Sin asignar',
      priority: i.fields.priority?.name,
      points: i.fields.customfield_10027 || null,
      description: adfToText(i.fields.description),
    }));

    res.json({
      key: epic.key,
      summary: epic.fields.summary,
      status: epic.fields.status?.name,
      assignee: epic.fields.assignee?.displayName || null,
      description: adfToText(epic.fields.description),
      issues,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PTL Chat (Product Tech Lead Assistant) ───────────────────────────────────
const PTL_KNOWLEDGE_BASE = fs.existsSync(path.join(__dirname, 'ptl-knowledge-base.md'))
  ? fs.readFileSync(path.join(__dirname, 'ptl-knowledge-base.md'), 'utf-8')
  : '';

const PTL_SYSTEM_PROMPT = `Eres el Product Tech Lead (PTL) del equipo de Payments de ComunidadFeliz.
Tu rol es analizar requerimientos técnicos, diseñar soluciones de arquitectura y guiar al equipo de desarrollo.

## Tu expertise
- Arquitectura del Portal de Pagos 2.0 (Rails 6.1 / Ruby 3 / PostgreSQL)
- Integración Web ↔ Portal de Pagos (API REST, JWT, webhooks)
- Pasarelas de pago: Webpay Plus, OneClick (Transbank), Kushki, Toku, Etpay
- Patrón Processor (Enrollment, Transaction, Webhook, Refund)
- Portal de Operaciones y reconciliación bancaria (Fintoc)
- Portal de Devoluciones y dispersiones
- Pagos automáticos (Sidekiq, OneClick tokens)

## Cómo responder a un epic o requerimiento
Cuando te den un epic o requerimiento, estructura tu respuesta así:

### 1. Análisis del requerimiento
Qué se está pidiendo, contexto de negocio, impacto esperado.

### 2. Componentes afectados
Qué partes del sistema se tocan (Portal de Pagos, Web, Portal de Operaciones, etc.) y por qué.

### 3. Solución técnica propuesta
Diseño detallado: modelos, endpoints, lógica de negocio, flujo de datos. Incluye código Ruby/Rails cuando sea relevante.

### 4. Historias de usuario sugeridas
Si el epic no tiene historias o están incompletas, propón un desglose en tareas técnicas concretas con criterios de aceptación.

### 5. Riesgos y consideraciones
Edge cases, compatibilidad con pasarelas existentes, impacto en comunidades activas, rollback strategy.

## Reglas
- Responde SIEMPRE en español
- Sé específico: nombra archivos, modelos, controllers, métodos reales del sistema
- Si el epic tiene historias en Jira, analízalas una por una
- Si hay ambigüedad en el requerimiento, señálala explícitamente antes de proponer solución
- No trunces la respuesta — si es larga, complétala

## Base de conocimiento de arquitectura
---
${PTL_KNOWLEDGE_BASE}
---`;

// ── Provider detection (first match wins) ──────────────────────────────────
function getPtlProvider() {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GROQ_API_KEY)      return 'groq';
  if (process.env.OLLAMA_HOST || process.env.OLLAMA_MODEL) return 'ollama';
  return null;
}

const ptlAnthropicClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Conversation history per session (in-memory, keyed by sessionId)
const ptlSessions = {};

// ── Stream via OpenAI-compatible REST (Groq / Ollama) ─────────────────────
async function streamOpenAICompat({ baseUrl, apiKey, model, messages, res }) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: PTL_SYSTEM_PROMPT }, ...messages],
    stream: true,
    max_tokens: 8192,
  });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const upstream = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body });
  if (!upstream.ok) {
    const txt = await upstream.text();
    throw new Error(`${upstream.status}: ${txt}`);
  }

  let fullText = '';
  const decoder = new TextDecoder();
  let buf = '';

  for await (const chunk of upstream.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        const data = JSON.parse(line.slice(6));
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
      } catch {}
    }
  }
  return fullText;
}

app.get('/api/ptl/status', (req, res) => {
  const provider = getPtlProvider();
  res.json({
    provider,
    model: provider === 'anthropic' ? 'claude-opus-4-6'
         : provider === 'groq'      ? (process.env.GROQ_MODEL || 'llama-3.1-8b-instant')
         : provider === 'ollama'    ? (process.env.OLLAMA_MODEL || 'llama3.2')
         : null,
  });
});

app.post('/api/ptl/chat', async (req, res) => {
  const provider = getPtlProvider();
  if (!provider) {
    return res.status(503).json({
      error: 'Ningún proveedor de IA configurado. Agrega GROQ_API_KEY (gratis en console.groq.com) u OLLAMA_HOST al .env',
    });
  }
  const { message, sessionId } = req.body;
  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message y sessionId son requeridos' });
  }

  if (!ptlSessions[sessionId]) ptlSessions[sessionId] = [];
  ptlSessions[sessionId].push({ role: 'user', content: message });
  if (ptlSessions[sessionId].length > 40) {
    ptlSessions[sessionId] = ptlSessions[sessionId].slice(-40);
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    let fullText = '';

    if (provider === 'anthropic') {
      const stream = ptlAnthropicClient.messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 8192,
        system: PTL_SYSTEM_PROMPT,
        messages: ptlSessions[sessionId],
      });
      stream.on('text', (delta) => {
        fullText += delta;
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      });
      await stream.finalMessage();

    } else if (provider === 'groq') {
      fullText = await streamOpenAICompat({
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: process.env.GROQ_API_KEY,
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: ptlSessions[sessionId],
        res,
      });

    } else if (provider === 'ollama') {
      const ollamaHost = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
      fullText = await streamOpenAICompat({
        baseUrl: `${ollamaHost}/v1`,
        apiKey: null,
        model: process.env.OLLAMA_MODEL || 'llama3.2',
        messages: ptlSessions[sessionId],
        res,
      });
    }

    ptlSessions[sessionId].push({ role: 'assistant', content: fullText });
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

app.delete('/api/ptl/session/:sessionId', (req, res) => {
  delete ptlSessions[req.params.sessionId];
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  Payments Dashboard corriendo en http://0.0.0.0:${PORT}\n`);
});

// ─── Cron: resumen automático a #cfz-payments-chat (lunes y jueves, 9:00am) ──
// Cambia "0 9 * * 1,4" para ajustar horario. Formato: "min hora * * días"
// Días: 1=lunes, 2=martes, 3=miércoles, 4=jueves, 5=viernes
if (SLACK_WEBHOOK_URL) {
  cron.schedule('0 9 * * 1,4', async () => {
    console.log(`[cron] Enviando resumen de sprint a Slack...`);
    try {
      // Obtener sprint activo
      const boardId = await getBoardId();
      const active = await jiraRequest(`/board/${boardId}/sprint?state=active`, true);
      const sprintId = active.values?.[0]?.id;
      if (!sprintId) { console.warn('[cron] No hay sprint activo.'); return; }

      const summary = await fetchSprintSummary(sprintId);
      const slackRes = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: summary.blocks, text: `${summary.sprintName} — Resumen de avance` }),
      });
      if (!slackRes.ok) throw new Error(await slackRes.text());
      console.log(`[cron] ✅ Resumen enviado — ${summary.sprintName}`);
    } catch (e) {
      console.error(`[cron] ❌ Error al enviar resumen: ${e.message}`);
    }
  }, { timezone: 'America/Santiago' });

  console.log('📅  Cron activo: resumen Slack los lunes y jueves a las 9:00am (Santiago)\n');
}
