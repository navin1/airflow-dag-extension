# Airflow DAG Viewer — Setup Guide (Windows & Linux)

A step-by-step guide to install, build, and configure the Chrome extension on Windows and Linux.

---

## Prerequisites

| Tool | Minimum version | How to verify |
|------|----------------|---------------|
| Google Chrome | 109+ (Manifest V3) | `chrome://version` |
| Node.js | 18 LTS or later | `node --version` |
| npm | 9+ (bundled with Node) | `npm --version` |
| Git | any recent version | `git --version` |

### Install Node.js

**Windows**
1. Go to https://nodejs.org and download the **LTS** installer (`.msi`).
2. Run the installer — accept defaults, make sure "Add to PATH" is checked.
3. Open **Command Prompt** or **PowerShell** and verify: `node --version`

**Linux (Ubuntu/Debian)**
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

**Linux (Fedora/RHEL)**
```bash
sudo dnf install nodejs
```

---

## Step 1 — Download the code

### Option A: Clone from Git
```bash
git clone https://github.com/navin1/airflow-dag-extension.git
cd airflow-dag-extension
```

### Option B: Download ZIP from GitHub
1. Go to the repository page on GitHub.
2. Click **Code → Download ZIP**.
3. Extract the ZIP.
4. Open a terminal inside the extracted folder (the one that contains `package.json`).

---

## Step 2 — Install dependencies

```bash
npm install
```

This downloads all required packages into `node_modules/`. Takes about 30–60 seconds on first run.

---

## Step 3 — Build the extension

```bash
npm run build
```

This compiles TypeScript, bundles everything with Vite, and outputs the production files into the `dist/` folder. Expected output:

```
✓ built in ~1s
dist/index.html
dist/sql-viewer.html
dist/assets/...
```

> **Tip:** If the build fails with a TypeScript error, make sure you are inside the correct folder (the one with `package.json`).

---

## Step 4 — Load the extension in Chrome

1. Open Chrome and navigate to: `chrome://extensions`
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click **Load unpacked**.
4. Browse to and select the **`dist/`** folder inside the project directory.
5. The extension icon (a puzzle piece) should now appear in the Chrome toolbar.

> **Windows path example:** `C:\Users\YourName\Downloads\airflow-dag-extension\dist`
> **Linux path example:** `/home/yourname/airflow-dag-extension/dist`

---

## Step 5 — Pin the extension

1. Click the **puzzle-piece icon** in the Chrome toolbar.
2. Find **Airflow DAG Viewer** and click the **pin icon** to keep it visible.

---

## Step 6 — Configure Airflow environments

1. Click the extension icon to open the popup.
2. Click the **Settings (gear) icon** in the top-right.
3. Under **Environments**, click **Add Environment**.
4. Enter a name (e.g. `Production`) and the full Airflow base URL:
   ```
   https://your-project-id.uc.r.appspot.com
   ```
   or for Cloud Composer:
   ```
   https://xxxxxxxxxxxxxxxxxxxxxxxx.composer.googleusercontent.com
   ```
5. Add up to 6 environments. Click **Save** after each.

---

## Step 7 — Configure authentication

### Option A: Manual bearer token (simplest)

1. In a browser tab, log in to your Airflow web UI.
2. Open **DevTools → Network**, trigger any Airflow API request, and copy the `Authorization: Bearer <token>` value.
3. In the extension Settings → **Auth** section, select **Manual Token**.
4. Paste the token and set an expiry date/time.
5. Click **Save**.

> Tokens from Cloud Composer typically last 1 hour. Re-paste when expired.

### Option B: OAuth (Google Identity)

1. In Settings → Auth, select **OAuth**.
2. Enter your **GCP OAuth Client ID** (Web application type, with `chrome-extension://YOUR_EXTENSION_ID` added as an authorized redirect URI).
3. Click **Authenticate** — a Google sign-in popup will open.
4. Sign in with the account that has access to the Airflow environment.

To find your extension ID: go to `chrome://extensions` and look below the extension name.

---

## Step 8 — Configure Vertex AI (optional — for SQL optimization)

The extension can send SQL queries to Google Vertex AI (Gemini) for optimization suggestions.

1. In Settings → **Vertex AI**, upload your **GCP Service Account JSON key file** or paste the JSON content directly.
   - The service account needs the `roles/aiplatform.user` IAM role.
2. Select the **Gemini model** (e.g. `gemini-2.0-flash-001`).
3. Select the **region** closest to your data (e.g. `us-central1`).
4. The **Project ID** is auto-filled from the service account JSON.
5. Click **Save Vertex AI Settings**.

### Creating a service account key (GCP Console)

1. Go to **IAM & Admin → Service Accounts** in your GCP project.
2. Click **Create Service Account** → give it a name → click **Create**.
3. Assign role: **Vertex AI User**.
4. Click the service account → **Keys tab → Add Key → Create new key → JSON**.
5. Download and save the `.json` file securely. Upload it in the extension settings.

---

## Step 9 — Load a DAG and explore

1. Click the extension icon.
2. Select your environment from the dropdown.
3. Enter a DAG ID (e.g. `my_etl_dag`) and click **Load DAG**.
4. The graph shows all tasks color-coded by state.
5. Use the **DAG Run selector** to switch between the last 5 runs — task states update automatically.
6. Click any task node to open its rendered SQL in a new tab.
7. In the SQL tab, click **Optimize with Vertex AI** to see a side-by-side diff of suggested optimizations.

---

## Rebuilding after updates

When you pull new code from Git, rebuild:

```bash
git pull
npm install        # only needed if package.json changed
npm run build
```

Then in Chrome → `chrome://extensions` → click the **refresh icon** on the Airflow DAG Viewer card to reload the updated extension.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `npm install` fails with permission error (Linux) | Use `sudo npm install` or fix npm permissions: `sudo chown -R $USER ~/.npm` |
| Build error: `Cannot find module` | Delete `node_modules/` and run `npm install` again |
| Extension not loading: "Could not load manifest" | Make sure you selected the `dist/` folder, not the project root |
| Blank popup / white screen | Open `chrome://extensions`, click **Errors** on the extension card to see the error |
| 401 Unauthorized from Airflow | Token expired — re-paste a fresh bearer token in Settings |
| Vertex AI: "Auth error" | Check the service account JSON is valid and has `roles/aiplatform.user` |
| SQL shows "No SQL found" | The task may not be a SQL operator, or it hasn't run successfully in any recent DAG run |

---

## Updating the extension (after code changes)

1. Edit source files in `src/`.
2. Run `npm run build`.
3. In `chrome://extensions`, click the **reload icon** on the extension card.

No need to re-enable Developer Mode or re-select the `dist/` folder after the initial setup.
