
* Move `docker-entrypoint.sh` into `src/apps/witmproxy/scripts/`, update any other files or workflows which reference it.
* `witm status` should be an alias for (or superset of) `witm service status`
* `witm logs` should be an alias for (or superset of) `witm service logs`