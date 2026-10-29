# Demo data source (staging golden path)

A deliberately small fixture for the product walkthrough: Data Integration reads it over real
HTTP, Data Catalog stores what it ingests, and the Governance page shows the result.

- `orders.json` — 24 synthetic orders. Clearly marked `"demo": true`; no customer data.
- `serve.py` — static HTTP server bound to the docker bridge gateway (`172.17.0.1:18099`), the
  same host the kernel allow-lists in `OPSWEAVE_PLUGIN_SOURCE_ALLOWED_HOSTS`. It is not
  reachable from the internet and is not a production endpoint.

Run it on the staging host:

```bash
sudo mkdir -p /srv/opsweave-staging/demo-source
sudo cp orders.json serve.py /srv/opsweave-staging/demo-source/
sudo setsid nohup python3 /srv/opsweave-staging/demo-source/serve.py \
  > /var/log/opsweave-staging/demo-source.log 2>&1 < /dev/null &
```

Then create an HTTP/JSON source with endpoint `http://172.17.0.1:18099/orders.json`.

Note: the connector discovers top-level keys only (`demo`, `generated_for`, `orders`) and treats
an array as a single string value, so the demo dataset mirrors that shape instead of pretending
to be row-oriented.
