# infra

A public R2 bucket for FLiAI Quick Call downloads, served at `https://cdn-quickcall.fliai.lk`.

- Bucket `fliai-quick-call-downloads` (APAC, `prevent_destroy`). Public reads go through the custom domain only.
- It holds only the latest release: `fliai-quick-call.dmg`, `fliai-quick-call-setup.exe`, `latest.json`, `install.sh`, `install.ps1`. The release workflow overwrites these fixed names, deletes anything else, and fails if the total goes over 50 MB.
- A lifecycle rule aborts unfinished uploads after 1 day.

Cost: within the R2 free tier (10 GB storage, 1M writes and 10M reads a month; egress is free).

## Apply

```sh
export CLOUDFLARE_API_TOKEN=...   # R2 edit + DNS edit on fliai.lk
terraform init
terraform plan -out=quickcall.tfplan
terraform apply quickcall.tfplan
```

State is local for now. Keep `terraform.tfstate` safe; it's git-ignored.

## CI credentials (once, by hand)

Cloudflare dashboard → R2 → Manage API tokens → Create token:
- Permission: **Object Read & Write**
- Scope: **only** `fliai-quick-call-downloads`

Put the result in the repo's Actions secrets:

```sh
gh secret set R2_ACCESS_KEY_ID -R fliai/fliai-quick-call
gh secret set R2_SECRET_ACCESS_KEY -R fliai/fliai-quick-call
```
