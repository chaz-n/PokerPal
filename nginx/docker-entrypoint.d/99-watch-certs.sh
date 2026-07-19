#!/bin/sh
# Reloads nginx when certbot writes a renewed cert into the shared volume.
set -e
(
  while inotifywait -q -r -e close_write,create,delete,move /etc/letsencrypt; do
    sleep 5
    nginx -s reload
  done
) &
