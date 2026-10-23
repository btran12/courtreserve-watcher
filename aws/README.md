# AWS setup

Flow: userscript → (POST + secret token) → Lambda Function URL → private S3 `courtreserve-watcher/state.json` → CloudFront → `viewer.html`.
The userscript never holds AWS credentials. The bucket stays private (only CloudFront can read it).

## Deploy with CloudFormation (recommended)

Prereqs: AWS CLI configured, any region (CloudFront is global).

```powershell
cd aws
# pick a long random secret and keep it (you need it for the userscript)
$token = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$token
aws cloudformation deploy --stack-name courtreserve-watcher --template-file template.yaml `
  --capabilities CAPABILITY_IAM --parameter-overrides UploadToken=$token
aws cloudformation describe-stacks --stack-name courtreserve-watcher --query "Stacks[0].Outputs"
```

Then:
1. Upload the viewer to the bucket root (`BucketName` from the outputs):
   `aws s3 cp ..\viewer.html s3://<BucketName>/viewer.html --content-type text/html`
2. In the userscript set `CONFIG.upload.url` = `UploadUrl` output and `CONFIG.upload.token` = your token. Re-install the script in Tampermonkey to accept the `GM_xmlhttpRequest` permission.
3. Visit the calendar page once. The panel should say "Uploaded <time>".
4. Open `ViewerUrl`. It reads `courtreserve-watcher/state.json` from the same origin (no CORS setup needed) and refreshes every minute and on tab focus.

Later: to update the viewer re-run the `s3 cp` (invalidate `/viewer.html` in CloudFront if you see a stale copy). To rotate the token re-run `deploy` with a new `UploadToken` and update the script. To remove everything: empty the bucket, then `aws cloudformation delete-stack --stack-name courtreserve-watcher`.

Created: private S3 bucket, CloudFront distribution (OAC, caching disabled), Lambda (inline code, `s3:PutObject` only on the one key) with a Function URL, and its invoke permissions.

## Notes
- Participant names are stored, so anyone with the `ViewerUrl` can read them. The URL is unguessable but not authenticated; add CloudFront signed URLs/Cognito or a WAF IP rule if you need more.
- The Function URL is public; the token is the only check, and it sits in the userscript. It can only overwrite that one JSON file (max 2 MB).
- `lambda.mjs` is the same handler as a standalone ESM file for manual deployment.

## Manual setup (without CloudFormation)
1. Private S3 bucket.
2. Lambda Node 20+: upload `lambda.mjs` as `index.mjs` (handler `index.handler`), env `BUCKET`, `TOKEN`, optional `KEY`; IAM `s3:PutObject` on the key; Function URL with auth `NONE`.
3. Serve `state.json` + `viewer.html` via CloudFront (OAC) or a bucket with a GET CORS rule, then set `DATA_URL` in `viewer.html` or open it with `?src=<url>`.
