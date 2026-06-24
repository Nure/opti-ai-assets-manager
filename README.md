# AI DAM Migration Copilot v4.21

This version adds the Tag Assets Metadata workflow: upload an XLSX, perform a mandatory dry run against CMP fields/labels, map label option text to IDs, then execute safe per-field asset metadata updates with independent reporting.


Enterprise-grade Dockerized Node.js application for AI-assisted asset migration from **Optimizely CMS12** and **WordPress** into **Optimizely CMP DAM**.

The design follows a reliability-first principle:

> Deterministic asset discovery and validation first. AI enriches metadata and explains risk; it does not decide whether assets exist.


## v1.4 runtime fix

This version removes `import 'dotenv/config'` from the server entry point. Docker Compose already loads `.env` through `env_file`, and removing the `dotenv/config` ESM subpath prevents this runtime error:

```bash
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/server/node_modules/dotenv/config'
```

Run with:

```bash
cp .env.example .env
docker compose down --remove-orphans
docker compose build --no-cache
docker compose up
```

## What this app does

- Select CMS type from a dropdown: `Optimizely CMS12` or `WordPress`.
- Shows different input fields based on CMS type.
- Scans CMS page URLs, rendered HTML, CMS API / WordPress REST content.
- Extracts asset URLs from:
  - `img src`
  - `srcset`
  - `a href`
  - `video/audio/source`
  - CSS `url(...)`
  - inline styles
  - raw HTML fallbacks
- Resolves relative URLs using the configured Base URL.
- Tracks page title, page link, asset link, asset type, folder path, extraction location, and status.
- Imports additional assets using:
  - XLSX URL
  - Drag-and-drop folder upload
- Preserves folder path information for DAM mapping.
- Downloads assets.
- Calculates SHA-256 checksums.
- Detects exact duplicates by checksum.
- Reuses CMP URL for duplicate assets.
- Generates AI metadata when `OPENAI_API_KEY` is configured.
- Uploads assets to CMP if CMP API variables are configured.
- Runs in safe simulation mode when CMP credentials are not configured.
- Exports detailed XLSX reports.

## Tabs

### 1. Scan

Configure migration job and scan CMS content.

CMS12 fields:

- Base URL
- CMS12 Content API URL
- Bearer token / API key
- Language branches
- Manual page URLs

WordPress fields:

- Base URL
- WordPress REST API URL
- Username
- Application Password
- Bearer token
- Max WordPress API pages
- Manual page URLs

### 2. Import & Migrate

- Import asset list from XLSX link.
- Drag and drop a local folder.
- Track relative folder paths.
- Download assets.
- Calculate checksum.
- Remove/reuse duplicates.
- Upload to CMP or simulation mode.

### 3. Reports

Export XLSX report with these sheets:

- Pages
- Asset References
- Asset Status
- Duplicates

## XLSX import format

The first sheet can include these columns:

| Column | Required | Example |
|---|---:|---|
| Asset Link / Asset URL / URL | Yes | `/wp-content/uploads/banner.jpg` |
| Folder / Folder Path | No | `/campaigns/summer` |
| Page Title | No | `Home Page` |
| Page Link / Page URL | No | `https://example.com/home` |

Relative asset URLs are resolved using the configured Base URL.

## Duplicate detection logic

The app uses deterministic duplicate detection:

1. Downloads asset or reads local imported file.
2. Calculates SHA-256 checksum.
3. Compares checksum with previously processed assets.
4. If the checksum matches, the asset is marked as `DUPLICATE_DETECTED`.
5. The duplicate stores:
   - duplicate source asset ID
   - reason
   - reused CMP URL

Example duplicate reason:

```text
Same SHA-256 checksum as https://site.com/globalassets/banner.jpg. Exact binary duplicate; CMP URL will be reused.
```

## AI usage

AI is optional. Configure:

```env
OPENAI_API_KEY=your_api_key
OPENAI_MODEL=gpt-5-mini
```

AI is used for:

- Asset title suggestions
- Description
- Alt text
- DAM tags
- Classification
- Risk explanation

AI is not used for:

- Determining whether an asset URL exists
- URL replacement
- Checksum validation
- Migration success/failure decision

## CMP upload

Configure CMP variables in `.env`:

```env
CMP_API_BASE_URL=https://your-cmp-api.example.com
CMP_BEARER_TOKEN=your_token
CMP_ORG_ID=your_org_id
CMP_DEFAULT_FOLDER_ID=folder_id
```

If these values are not configured, the app runs in simulation mode and generates simulated CMP URLs. This keeps local development safe.

The CMP upload adapter is intentionally isolated in:

```text
server/src/migration.js
```

Update the `uploadToCmp()` function to match the exact CMP DAM import endpoint and payload for your customer/environment.

## Run with Docker

```bash
cp .env.example .env
docker compose up --build
```

Open:

```text
http://localhost:8080
```

## Run locally without Docker

Terminal 1:

```bash
cd server
npm install
npm run dev
```

Terminal 2:

```bash
cd frontend
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

## GitHub workflow

```bash
git init
git add .
git commit -m "Initial AI DAM Migration Copilot"
git branch -M main
git remote add origin <your-repository-url>
git push -u origin main
```

## Suggested production improvements

- Replace JSON file store with PostgreSQL.
- Add authenticated users and roles.
- Add encrypted credential storage.
- Add job queue with BullMQ or Temporal.
- Add CMS URL swap workflow.
- Add rendered-page validation after URL swap.
- Add rollback snapshots.
- Add screenshot comparison.
- Add near-duplicate detection using perceptual hashing and embeddings.
- Add full CMP taxonomy/folder mapping UI.
- Add approval workflow for risky assets.

## Current implementation status

This is a strong starter implementation for local demos, engineering review, and GitHub handoff. It includes the core workflow, UI, Dockerization, scanning, import, checksum duplicate detection, simulated CMP upload, optional AI metadata, and XLSX exports.

For production customer migrations, complete the CMP upload adapter, credential security, queueing, and CMS write-back/URL swap layer.

## v1.1 Scan Page Update

The Scan tab now works as a live-domain page-by-page scanner for both CMS types.

- User selects **Optimizely CMS12** or **WordPress** from the CMS dropdown.
- User provides a **Live Base URL**.
- The scanner starts from the Base URL or optional Start Page URLs.
- The scanner crawls same-domain internal links page by page.
- **Test Scan** limits the scan to exactly 5 pages for quick validation.
- Full scan uses the configured page limit.
- Gemini is now available directly on the Scan page as an optional AI review layer.

AI behavior:

- Deterministic extraction still identifies asset URLs.
- Gemini does not replace the parser and must not invent URLs.
- Gemini reviews each page and returns page purpose, completeness risk, possible missed asset patterns, recommended next checks, and confidence score.
- Set `GEMINI_API_KEY` in `.env`, or paste a key in the Scan UI for testing.

This keeps the migration safe: code extracts URLs; AI reviews scan quality and explains risk.

## v1.2 Optimizely branding and Docker build fix

This version adds the provided Optimizely logo to the UI header and hero area.

Docker build improvements:

- Added `.dockerignore` so local `node_modules`, build output, data, and `.env` are not copied into the image build context.
- Updated the frontend build stage to use `npm ci --include=dev --no-audit --no-fund`.
- Updated the build command to `npx vite build` so Vite is resolved from the installed local dependency.
- Updated `.env.example` to use `NODE_ENV=production` for Docker runtime.
- Added `init: true` and a healthcheck to `docker-compose.yml`.

If you already copied an older `.env`, update it before running Docker:

```env
NODE_ENV=production
```

Clean rebuild command:

```bash
docker compose down --remove-orphans
rm -rf frontend/node_modules server/node_modules node_modules frontend/dist server/public
cp .env.example .env
docker compose build --no-cache
docker compose up
```

If the container exits with code `137`, Docker killed it, usually because Docker Desktop ran out of memory. Increase Docker Desktop memory to at least 4 GB, then run the clean rebuild again.

## v1.3 Docker build fix

This version removes the separate React/Vite Docker build stage and serves a static enterprise UI directly from the Node.js server. This avoids the previous `vite: not found` / `Rolldown failed to resolve import "react"` Docker issue and makes the container build much faster and more reliable.


## v1.5 Docker dependency fix

This version updates the Dockerfile to install server dependencies from `server/package.json` inside `/app/server` and verifies Express during the image build. It avoids using a generated package-lock from another environment, which can occasionally produce runtime dependency resolution issues in Docker.

## v1.6 UI and reporting improvements

This version adds the requested enterprise visibility updates:

- Application shell uses 90% page width.
- Optimizely logo remains in the top-right header area.
- The second logo inside the hero circle was removed and replaced with the text: `Deterministic discovery + Gemini intelligence`.
- Reports now have a history list with title, date, time, operation type, clickable preview, and controlled deletion.
- Latest report per operation type is retained to keep dashboard stats and Reports visibility accurate.
- Scan stats and Import/Migrate stats are separated.
- Console tab added with near-realtime polling:
  - Every 2 seconds while scan/import/migration operations are running.
  - Every 5 seconds while idle.
- Server stores operation logs in `data/db.json` with each job.


## v1.7 updates

- Restored the hero design so the Optimizely mark stays with the product name on the left.
- Renamed the product label to **OptiDAM Copilot**.
- Rebuilt the center circle with the text **Deterministic discovery + AI intelligence**.
- Added three scan-mode checkboxes with radio-style behavior:
  - Test scan pages, with a dynamic page count.
  - Full scan, with no configured page limit.
  - Target page, which scans only a single page and hides Live Base URL, start-page, CMS12, and WordPress API fields.
- Added AI provider support for Gemini, Claude / Claude Code-style review, and OpenAI.
- Added provider-specific model dropdowns and a custom model override field.
- The scan continues safely even when an AI provider returns an API/model/key error; the AI analysis is stored as skipped/error instead of breaking deterministic asset discovery.



## Supported scanned asset/file types in v2.0

The live page scanner detects assets from standard HTML, lazy-loading attributes, meta tags, CSS `url(...)`, raw embedded JSON/script URLs, and relative paths. It now recognizes:

- Images: jpg, jpeg, png, gif, webp, avif, svg, ico, bmp, tif, tiff
- Documents: pdf, doc, docx, rtf, txt, csv, xls, xlsx, xlsm, ppt, pptx, pps, ppsx
- Video: mp4, mov, webm, avi, mkv, m4v, wmv, mpeg, mpg
- Audio: mp3, wav, aac, m4a, ogg
- Design/source files: ai, psd, eps, indd, sketch, fig, xd
- Archives: zip, rar, 7z, tar, gz

Creative/source files such as `.ai`, `.psd`, and `.eps` are classified as `design-source`. Office files and PDFs are classified as `document`; videos are classified as `video`.

## v2.3 — Download assets feature

A new **Download assets** section is available below **Scan**.

### Option A: Download from XLSX public link

Download the sample template from the app:

```text
http://localhost:8080/api/sample-assets-download.xlsx
```

Supported columns:

- `source_url`
- `asset_url`
- `download_url`
- `cmp_url`
- `url`
- `file_name`
- `folder_path`
- `title`

Files are downloaded to:

```text
./Downloaded on YYYY-MM-DD HH-mm-ss/<folder_path>
```

### Option B: Download from CMP DAM

The app supports CMP OAuth client credentials and calls the CMP Open API from the server side.

Required fields:

- CMP Client ID
- CMP Client Secret

Optional fields:

- API base URL, default `https://api.cmp.optimizely.com/v3`
- Token URL, default `https://accounts.cmp.optimizely.com/o/oauth2/v1/token`
- Folder ID
- Search text
- Max assets
- Explicit asset IDs

CMP downloads run with 10 parallel workers. Files are stored under:

```text
./Downloaded on YYYY-MM-DD HH-mm-ss/<cmp_folder_path>
```

The generated report history includes a separate `download` report type, with stats separate from scan/import/migration.


## v2.3 console polling fix

This version fixes the realtime console polling loop. The browser now:

- Uses one managed polling timer instead of overlapping intervals.
- Polls every 2 seconds only while an operation is running.
- Polls every 5 seconds only when the Console tab is open and the backend is available.
- Stops polling after repeated backend connection failures, such as when Docker is stopped.
- Shows a single warning instead of continuously flooding the in-app console with `Failed to fetch`.
- Stops idle polling when the browser tab is hidden.

If Docker is stopped while the browser is still open, the app pauses console polling. Restart Docker and refresh the browser to resume.

## v2.5 stability update

- Adds atomic `data/db.json` writes to prevent partial JSON writes during heavy scan/download jobs.
- Adds automatic corrupted database backup to `data/backups/`.
- If `data/db.json` becomes invalid, the app no longer crashes; it backs up the invalid file and recreates a clean database.


## v3.2 Download assets improvements

- Downloaded files are saved directly under `Downloaded on YYYY-MM-DD HH-mm-ss/` without extra `cmp-dam/cmp-dam` nesting.
- XLSX downloads preserve the `folder_path` column directly inside the timestamped root folder.
- CMP downloads now attempt folder-aware discovery: root/standalone assets, folder metadata, child folder traversal, and per-folder asset listing.
- If CMP folder endpoints are not available, the app falls back to paginated asset listing and uses folder metadata returned on the asset payload.
- Download reports, history, HTTP trace, and XLSX export now live inside the **Download assets** tab.
- The global Reports tab is kept for scan/import/migration overview instead of merging download reports there.
- All Assets uses `offset` + `page_size` pagination and downloads files with 10 parallel workers.
- Retry behavior: file downloads retry up to 3 times; CMP API calls refresh the bearer token and retry once on 401/403.

## v2.7 Download assets improvements

The Download assets screen now uses a single **Download Options** dropdown:

- Option A — Download from XLSX public link
- Option B — Download from CMP DAM

Only the selected option's input fields are shown.

Downloaded files are stored under a friendly local folder name:

```text
./Downloaded on YYYY-MM-DD HH-mm-ss/
```

Inside that folder, the app keeps nested source/folder paths such as:

```text
cmp-dam/<folder-path>/<file>
xlsx-link/<folder-path>/<file>
```

CMP download supports:

- Assets by Folder ID
- All Assets using iterative offset/page_size pagination
- Optional explicit Asset IDs
- 10 parallel asset downloads
- Per-file retry up to 3 attempts
- Bearer token refresh and retry once for CMP API 401/403 responses
- Detailed HTTP trace for token, list, get, and asset download requests
- XLSX report with Download Summary, Downloaded Assets, and Download HTTP Trace sheets

Report history stores download entries with titles like **Downloaded on Date and Time**. Click a history item to reopen the saved table, or delete old entries from the list.


## v3.2 Download output changes

- Downloaded asset folders are now created directly in the app directory as `Downloaded on YYYY-MM-DD HH-mm-ss/`, not inside `data/`.
- Download-specific XLSX reports are generated directly in the app directory.
- The Download assets XLSX export contains only download-related sheets: `Download Summary`, `Downloaded Assets`, and `Download HTTP Trace`.
- If CMP folder name is missing, reports use `Home`; if folder path is missing, reports use `/`.
- Docker Compose mounts the project folder to `/host-app` so the container can write these download folders and XLSX reports back to your local app directory.


## v3.2 CMP asset analysis modes

The Download assets page now supports three CMP DAM operations:

1. Downloads Assets Information Only - fetches asset metadata and writes an XLSX overview without downloading binaries.
2. Download CMP DAM Assets Info and Metadata - fetches asset metadata plus GET /assets/{asset_id}/fields labels/field values and writes an XLSX report.
3. Download Assets only - downloads asset binaries using available download URLs or POST /file-urls fallback when a file GUID is available.

Downloaded Assets XLSX uses these core columns first: source, assetTitle, assetId, assetGuid, cmpFolderId, cmpFolderName, folderPath, sourceUrl, requestEndpoint, fileName, assetType, contentType, sizeBytes. If CMP folder name/path are missing, folder name defaults to Home and folder path defaults to /.


## v3.2 update

For the CMP operation **Download CMP DAM Assets Info and Metadata**, the generated XLSX now contains one sheet only: **Assets Metadata**. This sheet includes every asset row, even when fields/labels are missing, and dynamically appends discovered field/label columns to the standard asset overview columns.

## v3.3 Download filename fix

This version improves CMP binary downloads so local file names are resolved from original CMP file metadata first, then the HTTP Content-Disposition header, then asset title plus the original MIME/extension, then asset ID. Signed URL fragments are no longer used as preferred file names. Thumbnail/preview URLs are deprioritized for actual downloads so PDFs, PPTX, DOCX, XLSX, AI and other raw files do not get saved with preview image extensions.

The Download XLSX includes `originalFileName`, `savedFileName`, and `fileNameSource` so the report shows exactly how the local filename was chosen.

## v3.4 Label value text restoration

This version preserves the v3.3 CMP download filename fix and restores the v3.1 metadata label resolution behavior for **Download CMP DAM Assets Info and Metadata**.

- Calls `GET /label-groups` before fetching asset fields.
- Builds a label value ID to option text lookup.
- Calls `GET /assets/{asset_id}/fields` with pagination.
- Exports readable label option text in the single **Assets Metadata** XLSX tab.
- Keeps all assets in the XLSX even when fields or labels are missing.
- Keeps raw IDs only when the label option cannot be resolved from CMP label groups.

## v3.5 notes

- CMP Asset Operation exports are isolated per selected operation.
- XLSX file names now match the selected operation: `Downloads Assets Information Only`, `Download CMP DAM Assets Info and Metadata`, or `Download Assets only`.
- Download CMP DAM Assets Info and Metadata exports only the `Assets Metadata` sheet.
- Downloads Assets Information Only exports only the operation-specific asset overview sheet.
- Download Assets only exports only download-specific sheets.


## v3.6 CMP article DOCX export

This version adds special handling for CMP DAM article assets during **Download Assets only**.

When an asset has `assetType=article` or `contentType=application/x-article`, the app exports the article as a `.docx` file instead of using a signed URL fragment or preview URL as the local filename. The DOCX filename is based on the CMP asset title, and the report marks `fileNameSource` as `cmp-article-docx-export`.

The export includes available article body/content fields when CMP exposes them in the asset payload. If the article payload does not expose body content, the DOCX still includes the asset title, ID, GUID, folder, and available description/metadata so the asset is represented in the download report.

The normal binary download behavior is unchanged for images, raw files, PDFs, videos, spreadsheets, presentations, and design-source assets.

## v3.8 Enterprise Import & Migrate updates

The Import & Migrate page now includes an enterprise CMP folder import workflow:

- Drag and drop/select a local folder with nested files.
- Optional parent CMP folder ID. When provided, the recreated folder tree is created under that parent. When omitted, folders/assets are created at CMP root level.
- Uses the same CMP OAuth client credentials flow as the download/export features.
- Creates CMP folders using `POST /folders` with `parent_folder_id`.
- Uploads assets using CMP upload URL flow: `GET /upload-url`, multipart upload to the pre-signed URL, then `POST /assets`.
- Uploads files with configurable parallelism, default 10 and max 25.
- Writes an `Import on YYYY-MM-DD HH-mm-ss/import-checkpoint.json` checkpoint in the app directory.
- Generates an import-only XLSX report in the app directory with: Import Summary, Imported Assets, Created Folders, Failed Items, and Import HTTP Trace.
- Supports Resume Previous Import and Retry Failed Only from the Import & Migrate page.


## v3.9 Import Reliability Improvements

The Enterprise CMP Folder Import pipeline now includes stronger retry and resume behavior:

- Retries each asset upload stage up to the configured retry count.
- Refreshes the CMP bearer token on 401/403 API responses and retries the failed request once.
- Requests a fresh upload URL on every retry, which helps when a pre-signed upload URL expires.
- Persists per-file status to `Import on .../import-checkpoint.json` after every major stage.
- Resume now reuses the original import folder and checkpoint instead of creating a new import folder.
- Retry Failed Only processes only failed assets from the checkpoint.
- Import XLSX now includes upload attempts, token refresh count, upload URL refresh count, and last upload stage.


## v4.4 notes
- Import drag-and-drop now updates a custom file counter next to the folder picker because browser file inputs cannot be programmatically populated from dropped folders.
- CMP pre-signed upload now uses streamed multipart/form-data via the Node `form-data` package, preserving meta fields and appending the file last as required by CMP upload documentation.


## v4.10 note

Import operations now preserve detailed console logs written during long-running jobs. The previous final save could overwrite mid-run CMP upload diagnostics. If an import fails, the console now prints an import diagnostic summary, first failed item, and last HTTP trace so the failing upload stage is visible without opening the XLSX.

## v4.11 update

- Import & Migrate now preserves nested browser folder paths using an explicit `relativePaths` manifest sent with the file upload request.
- The server enables Multer `preservePath` and also reads the explicit relative path manifest to avoid browser/multer filename flattening.
- CMP folder tree creation now logs the number of nested paths detected and creates folders depth-first before uploading assets.
- Assets are no longer silently uploaded to the parent/root folder when their nested target folder was not created. The file is marked failed with `TARGET_FOLDER_NOT_READY` so the report clearly shows the issue.

## v4.13 update

- Excludes OS hidden/system files from enterprise folder imports, including `.DS_Store`, Apple resource fork files (`._*`), `__MACOSX`, `Thumbs.db`, and `desktop.ini`.
- Exclusion happens both in the browser selection/drop step and again on the Node.js backend as a safety net.
- Import console now reports how many hidden/system files were excluded before CMP folder creation and asset upload.


## v4.15 parent folder validation update

Import & Migrate now treats Parent CMP Folder ID as the destination root folder ID. When provided, the app validates it once using `GET /v3/folders/{id}` before creating folders or uploading files. It does not use paginated child-folder listing to validate the parent folder.

Pagination with `GET /v3/folders?parent_folder_id=...&page_size=100&offset=...` is now used only when the optional **Reuse existing CMP folders** checkbox is enabled. This keeps large imports faster and avoids unnecessary folder listing when the user simply wants to create the imported folder tree under the provided parent.


## v4.17 Import authentication UI fix

- Restored and highlighted the **CMP Client Secret** field in Import & Migrate.
- Added required badges for CMP Client ID and CMP Client Secret.
- Added validation styling and auto-expands Import configuration if either credential is missing.
- Import & Migrate continues to use the same CMP OAuth client-credentials flow used by the Download Assets feature.


## v4.20 update

Tag Assets Metadata execution now uses a safe merge-bulk update strategy. It fetches current asset fields, merges XLSX validated fields/labels into the existing asset field list, and updates `PUT /v3/assets/{asset_id}/fields`. This fixes cases where `PUT /v3/assets/{asset_id}/fields/{field_id}` fails because the field is not already attached to the asset.


## v4.21 update

- Tag Assets Metadata now supports removing the currently selected XLSX from the UI before uploading a corrected spreadsheet.
- Dry Run and Execute explicitly support CMP text fields: text-like fields do not require options and the spreadsheet cell value is written as-is.
- Option-like fields and labels still validate values against CMP options/label groups before execution.
