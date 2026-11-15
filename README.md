# messthon-git

Minimal messenger. GitHub repositories are the storage, Render is the compute.

- Accounts: GitHub username + device secret (no passwords).
- Storage: private repos `messthon-data-N` (registry `messthon-data-1`, shards for messages and files).
- Sharding: when the current data repository exceeds 3 GB, the server creates the next one automatically.
- Files: up to 1 GB, uploaded in 20 MB chunks, stored as git blobs.
- Client: `client/`, deployed to GitHub Pages.
- Server: `server/`, deployed to Render (Node).
