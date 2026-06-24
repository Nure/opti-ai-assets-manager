import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const dataDir = process.env.APP_DATA_DIR || path.resolve(process.cwd(), '../data');
const dbPath = path.join(dataDir, 'db.json');
const backupDir = path.join(dataDir, 'backups');
const emptyDb = { jobs: [] };

let writeChain = Promise.resolve();
let recoveryChain = Promise.resolve();

function cloneEmptyDb() {
  return { jobs: [] };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeDb(db) {
  if (!db || typeof db !== 'object') return cloneEmptyDb();
  if (!Array.isArray(db.jobs)) db.jobs = [];
  return db;
}

async function ensureDirs() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });
}

async function atomicWriteDirect(db) {
  await ensureDirs();
  const unique = `${process.pid}.${Date.now()}.${crypto.randomUUID()}`;
  const tmpPath = path.join(dataDir, `.db.json.${unique}.tmp`);
  const payload = JSON.stringify(normalizeDb(db), null, 2);

  try {
    await fs.writeFile(tmpPath, payload, 'utf8');
    await fs.rename(tmpPath, dbPath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function queuedWrite(db) {
  writeChain = writeChain.then(() => atomicWriteDirect(db));
  return writeChain;
}

async function ensureDb() {
  await ensureDirs();
  if (!(await pathExists(dbPath))) {
    await queuedWrite(cloneEmptyDb());
  }
}

async function backupCorruptDb(raw, reason = 'invalid-json') {
  await ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const unique = crypto.randomUUID().slice(0, 8);
  const backupPath = path.join(backupDir, `db-corrupt-${stamp}-${unique}.json`);
  const metaPath = path.join(backupDir, `db-corrupt-${stamp}-${unique}.txt`);
  await fs.writeFile(backupPath, raw || '', 'utf8');
  await fs.writeFile(metaPath, `Reason: ${reason}\nOriginal path: ${dbPath}\nBacked up at: ${new Date().toISOString()}\n`, 'utf8');
  return backupPath;
}

async function recoverCorruptDb(raw, reason) {
  recoveryChain = recoveryChain.then(async () => {
    const currentRaw = await fs.readFile(dbPath, 'utf8').catch(() => '');
    try {
      if (currentRaw.trim()) {
        JSON.parse(currentRaw);
        return null;
      }
    } catch {
      // still corrupt, continue recovery
    }
    const backupPath = await backupCorruptDb(currentRaw || raw, reason);
    await queuedWrite(cloneEmptyDb());
    return backupPath;
  });
  return recoveryChain;
}

export async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(dbPath, 'utf8').catch(() => '');
  if (!raw.trim()) {
    await queuedWrite(cloneEmptyDb());
    return cloneEmptyDb();
  }

  try {
    return normalizeDb(JSON.parse(raw));
  } catch (error) {
    const backupPath = await recoverCorruptDb(raw, error.message);
    if (backupPath) {
      console.warn(`[store] db.json was corrupted and has been backed up to ${backupPath}. A clean database was created.`);
    }
    return cloneEmptyDb();
  }
}

export async function writeDb(db) {
  await queuedWrite(db);
  return db;
}

async function mutateDb(mutator) {
  let result;
  writeChain = writeChain.then(async () => {
    const db = await readDb();
    result = await mutator(db);
    await atomicWriteDirect(db);
  });
  await writeChain;
  return result;
}

export async function upsertJob(job) {
  await mutateDb(async db => {
    const idx = db.jobs.findIndex(j => j.id === job.id);
    if (idx >= 0) db.jobs[idx] = job;
    else db.jobs.unshift(job);
    return job;
  });
  return job;
}

export async function getJob(id) {
  const db = await readDb();
  return db.jobs.find(j => j.id === id);
}

export async function updateJob(id, updater) {
  return mutateDb(async db => {
    const idx = db.jobs.findIndex(j => j.id === id);
    if (idx < 0) return null;
    const updated = await updater(db.jobs[idx]);
    if (!updated) return null;
    updated.updatedAt = new Date().toISOString();
    db.jobs[idx] = updated;
    return updated;
  });
}

export async function patchJob(id, patch) {
  return updateJob(id, async job => ({ ...job, ...patch, updatedAt: new Date().toISOString() }));
}

export async function appendJobLog(id, message, level = 'info') {
  return updateJob(id, async job => {
    const logs = job.logs || [];
    logs.push({ id: `${Date.now()}-${logs.length}`, at: new Date().toISOString(), level, message });
    return { ...job, logs: logs.slice(-1000) };
  });
}

export async function addReport(id, report) {
  return updateJob(id, async job => {
    const reports = job.reports || [];
    reports.unshift(report);
    return { ...job, reports };
  });
}

export async function getAllReports() {
  const db = await readDb();
  const reports = [];
  for (const job of db.jobs || []) {
    for (const report of job.reports || []) {
      reports.push({
        ...report,
        jobId: job.id,
        jobName: job.name,
        cmsType: job.cmsType,
        jobStatus: job.status
      });
    }
  }
  reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return reports;
}

export async function deleteReport(jobId, reportId) {
  return updateJob(jobId, async job => {
    const reports = job.reports || [];
    return { ...job, reports: reports.filter(r => r.id !== reportId) };
  });
}
