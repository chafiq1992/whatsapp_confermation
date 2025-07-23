# WhatsApp Shopify Integration

This project contains a FastAPI backend and React frontend for integrating WhatsApp messaging with Shopify stores.

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

