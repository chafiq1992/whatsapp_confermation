# WhatsApp Shopify Integration

This project contains a FastAPI backend and React frontend for integrating WhatsApp messaging with Shopify stores.

**Note:** File upload endpoints require the `python-multipart` package. Make sure this dependency is installed when deploying the backend.

**Note:** Audio messaging relies on `ffmpeg` for processing voice notes. The provided Dockerfile installs this package automatically.

## Shopify Credentials

The backend supports multiple environment variable prefixes to load Shopify credentials. It will use the first complete set it finds.

Supported variable sets:

1. **Default prefix**
   - `SHOPIFY_API_KEY`
   - `SHOPIFY_PASSWORD`
   - `SHOPIFY_STORE_URL`
2. **IRRAKIDS prefix**
   - `IRRAKIDS_API_KEY`
   - `IRRAKIDS_PASSWORD`
   - `IRRAKIDS_STORE_URL`
3. **Store domain variables** (if provided)
   - `IRRAKIDS_STORE_DOMAIN`
   - `IRRANOVA_STORE_DOMAIN`

Each set requires an API key, password, and store URL (or domain). Only one set
needs to be defined. You **must** provide one complete set of `SHOPIFY_*`,
`IRRAKIDS_*`, or `IRRANOVA_*` variables before starting the backend or it will
exit with the error `Missing Shopify environment variables`.

## Example: Setting variables on Cloud Run

When deploying to Cloud Run you can specify environment variables using the `--set-env-vars` flag:

```bash
gcloud run deploy whatsapp-backend \
  --image gcr.io/PROJECT/IMAGE \
  --set-env-vars "SHOPIFY_API_KEY=your-key,SHOPIFY_PASSWORD=your-pass,SHOPIFY_STORE_URL=https://example.myshopify.com"
```

Replace the values with the credentials for your Shopify store. Alternatively use the `IRRAKIDS_*` or `IRRANOVA_*` variable names if those are available.

## SQLite database

Messages are stored in a local SQLite file. By default the backend writes to
`data/whatsapp_messages.db`. The directory is created automatically if it does
not exist.

To use PostgreSQL instead of SQLite, set the `DATABASE_URL` environment variable
to a valid connection string. When this variable is present the backend will use
`asyncpg` to communicate with PostgreSQL.

Uploaded media files are sent to Google Drive instead of S3. Set
`GOOGLE_DRIVE_FOLDER_ID` to the target Drive folder and provide a service
account JSON key via `GOOGLE_DRIVE_CREDENTIALS_FILE`. The backend will upload
files using these credentials and share them publicly so anyone with the link
can view the file. The returned URLs use the standard
`https://drive.google.com/uc?id=<file_id>` format.

Create a service account in your Google Cloud project and enable the Drive API.
Download the JSON key for this account and set `GOOGLE_DRIVE_CREDENTIALS_FILE`
to its path. Share the destination folder with the service account's email so it
can upload files. The backend will set each uploaded file to be accessible by
anyone who has the link.

When deploying to providers with ephemeral filesystems, point the `DB_PATH`
environment variable at a location backed by a persistent volume so that chat
history is retained across restarts.

Recent versions add indexes on the `wa_message_id` and `temp_id` columns of the
`messages` table. Running the backend automatically applies these indexes if
they are missing. If upgrading an existing deployment manually, execute:

```sql
CREATE INDEX IF NOT EXISTS idx_msg_wa_id ON messages(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_msg_temp_id ON messages(temp_id);
```

Newer releases also store public URLs for uploaded media in a `url` column.
Starting the backend will automatically add this column when missing, so you do
not need to recreate an existing database.

## Frontend build

Before running the backend make sure the React frontend is compiled:

```bash
cd frontend
npm install
npm run build
```

All Node dependencies are defined in `frontend/package.json`.

When building the Docker image this step is handled automatically.


The FastAPI service serves the static files from the built directory at the root path (`/`).

### API and WebSocket URLs

The React build reads two optional variables:

* `REACT_APP_API_BASE` - base URL for all HTTP requests
* `REACT_APP_WS_URL` - WebSocket endpoint prefix

If these variables are not set, the frontend will default to relative paths and the current host.

Example build command:

```bash
REACT_APP_API_BASE=https://api.example.com \
REACT_APP_WS_URL=wss://api.example.com/ws/ \
npm run build
```

## Building the Docker image

The Dockerfile includes a dedicated Node build stage. When you run `docker build` the frontend dependencies are installed and `npm run build` is executed automatically. The resulting `frontend/build` directory is copied into the final Python image, so no manual build step is required.


## Catalog Setup

For catalog operations the environment variables `WHATSAPP_ACCESS_TOKEN` and `CATALOG_ID` must contain valid credentials for your WhatsApp Business catalog.

The backend stores a cached copy of the catalog in `backend/catalog_cache.json`. There are two ways to populate this file:

1. Use the **Refresh Catalog** button in the web UI.
2. Call the `/refresh-catalog-cache` endpoint manually.

The cache file must exist for the `catalog-sets` and `catalog-set-products` endpoints to return data.

## Running Tests

The unit tests in `tests/` rely on a few additional packages beyond the standard
backend requirements.
Install the backend dependencies and the following test packages:

- `pytest`
- `pytest-asyncio`
- `fastapi`
- `aiosqlite`

You can install everything with:

```bash
pip install -r backend/requirements.txt -r requirements-test.txt
```

Then run the suite with:

```bash
pytest
```
