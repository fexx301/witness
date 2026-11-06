# Hosting the desk

[setup.sh](setup.sh) puts the desk on one small Ubuntu 24.04 server (AWS Lightsail or EC2) behind Caddy, which gets
the HTTPS certificate for a domain such as a DuckDNS name.

1. Create the server with a static IP, open ports 80 and 443, and point the domain at the IP.
2. On the server: `curl -fsSLO https://raw.githubusercontent.com/fexx301/witness/main/deploy/setup.sh && bash setup.sh <name>.duckdns.org`.
   The first run installs Node 22 and Caddy, clones the repo to `/opt/witness`, and stops to ask for keys.
3. Copy your `.env` and your `data/` folder to `/opt/witness`, and `desk/.env` (the video link and the AG Studio
   licence key, read when the desk is built) to `/opt/witness/desk`, then run `bash setup.sh <name>.duckdns.org`
   again. Run it again later to update.

On a hosted desk, visitors can read the queue and investigations, chat (capped by `WITNESS_DESK_AI_DAILY_USD`),
and run `WITNESS_VISITOR_INVESTIGATIONS_PER_DAY` investigations a day (10 by default). Execute and mandate
acceptance work only from the server itself: requests through Caddy are visitors, even though Witness listens
on loopback. `WITNESS_ALLOW_EXECUTE=1` would open both to everyone, so don't set it on a public server.
Visitors see PayPal account IDs replaced, and browser POSTs from other sites are refused. A mistyped numeric
setting stops the server at startup rather than becoming no limit. The service may write only under `data/`.
